//! Рантайм методов протокола v2 для шардов (E1). Шард подписывается на
//! subject'ы своих методов из реестра (`parvane_protocol::schema::METHODS`,
//! shard == имя роли), получает `ShardRequest` от gateway, отвечает
//! `ShardResponse`. Текста ошибок клиенту нет — только `ErrorCode`
//! (инвариант 18); подробности — в `tracing` шарда.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{shard_response, Error, ErrorCode, ShardRequest, ShardResponse};
use parvane_protocol::schema::{self, MethodInfo};
use prost::Message;
use tracing::{error, warn};

/// Результат обработчика: байты ответа (тип — по реестру) или код ошибки.
pub type Reply = Result<Vec<u8>, ErrorCode>;
pub type BoxFut = Pin<Box<dyn Future<Output = Reply> + Send>>;
/// Обработчик: (метод, запрос) → ответ.
pub type Handler = Arc<dyn Fn(&'static MethodInfo, ShardRequest) -> BoxFut + Send + Sync>;

/// Методы роли `shard` из реестра.
pub fn methods_of(shard: &str) -> Vec<&'static MethodInfo> {
    schema::METHODS.iter().filter(|m| m.shard == shard).collect()
}

pub fn error_reply(code: ErrorCode) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Error(Error { code: code as i32, retry_after_ms: 0 })) }.encode_to_vec()
}

pub fn ok_reply(body: Vec<u8>) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Ok(body)) }.encode_to_vec()
}

/// Разобрать тело запроса типа `M` с проверкой лимитов схемы.
pub fn body<M: Message + prost::Name + Default>(req: &ShardRequest) -> Result<M, ErrorCode> {
    decode_checked::<M>(&req.body, Origin::Client).map_err(|e| e.code())
}

/// Подписаться на все методы роли и обслуживать их параллельно (≤ `concurrency`).
pub async fn serve(nc: async_nats::Client, shard: &'static str, concurrency: usize, handler: Handler) -> Result<(), async_nats::SubscribeError> {
    let mut streams = Vec::new();
    for m in methods_of(shard) {
        let sub = nc.subscribe(m.subject.to_string()).await?;
        streams.push(sub.map(move |msg| (m, msg)).boxed());
    }
    let mut all = futures::stream::select_all(streams);
    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
    tokio::spawn(async move {
        while let Some((m, msg)) = all.next().await {
            let Some(reply) = msg.reply.clone() else {
                warn!("v2 {}: запрос без reply", m.name);
                continue;
            };
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let nc = nc.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let out = match decode_checked::<ShardRequest>(&msg.payload, Origin::Server) {
                    Ok(req) if req.method == m.name => match handler(m, req).await {
                        Ok(b) => ok_reply(b),
                        Err(code) => error_reply(code),
                    },
                    Ok(_) => error_reply(ErrorCode::Invalid),
                    Err(e) => {
                        warn!("v2 {}: битый ShardRequest: {e}", m.name);
                        error_reply(ErrorCode::Invalid)
                    }
                };
                if let Err(e) = nc.publish(reply, out.into()).await {
                    error!("v2 {}: ответ не отправлен: {e}", m.name);
                }
            });
        }
    });
    Ok(())
}
