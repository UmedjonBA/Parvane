//! Рантайм методов протокола v2 для шардов (E1). Шард подписывается на
//! subject'ы своих методов из реестра (`parvane_protocol::schema::METHODS`,
//! shard == имя роли), получает `ShardRequest` от gateway, отвечает
//! `ShardResponse`. Текста ошибок клиенту нет — только `ErrorCode`
//! (инвариант 18); подробности — в `tracing` шарда.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

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

/// Отказ по частоте с подсказкой, когда повторить.
pub fn rate_limited_reply(retry_after_ms: u32) -> Vec<u8> {
    ShardResponse {
        result: Some(shard_response::Result::Error(Error { code: ErrorCode::RateLimited as i32, retry_after_ms })),
    }
    .encode_to_vec()
}

/// Через сколько повторить запрос сверх доли владельца.
pub const OWNER_BUSY_RETRY_MS: u32 = 300;

/// CLD-05: справедливая доля обработчиков шарда — не больше `per_owner` запросов одного пользователя разом.
/// Без неё один-два аккаунта занимали все слоты (`concurrency`), и остальные ждали. Запрос сверх доли сразу
/// получает `RATE_LIMITED` (клиент повторяет), а не стоит в очереди. Анонимные запросы (пустой `user`)
/// долей не считаются — у них свои пределы (gateway по IP, слоты потоков ссылок).
pub struct OwnerSlots {
    per_owner: usize,
    busy: Mutex<HashMap<String, usize>>,
}

/// Занятый слот владельца; освобождается при удалении.
pub struct OwnerSlot {
    slots: Arc<OwnerSlots>,
    owner: String,
}

impl OwnerSlots {
    pub fn new(per_owner: usize) -> Arc<Self> {
        Arc::new(Self { per_owner: per_owner.max(1), busy: Mutex::new(HashMap::new()) })
    }

    /// Занять слот; `None` — доля владельца исчерпана. Для анонимного запроса — всегда `Some`.
    pub fn try_acquire(self: &Arc<Self>, owner: &str) -> Option<Option<OwnerSlot>> {
        if owner.is_empty() {
            return Some(None);
        }
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let n = busy.entry(owner.to_string()).or_insert(0);
        if *n >= self.per_owner {
            return None;
        }
        *n += 1;
        Some(Some(OwnerSlot { slots: self.clone(), owner: owner.to_string() }))
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.busy.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for OwnerSlot {
    fn drop(&mut self) {
        let mut busy = self.slots.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = busy.get_mut(&self.owner) {
            *n -= 1;
            if *n == 0 {
                busy.remove(&self.owner);
            }
        }
    }
}

/// Подписаться на все методы роли и обслуживать их параллельно (≤ `concurrency`).
pub async fn serve(nc: async_nats::Client, shard: &'static str, concurrency: usize, handler: Handler) -> Result<(), async_nats::SubscribeError> {
    serve_with(nc, shard, concurrency, None, handler).await
}

/// То же с долей владельца (`OwnerSlots`, CLD-05).
pub async fn serve_with(
    nc: async_nats::Client,
    shard: &'static str,
    concurrency: usize,
    owner_slots: Option<Arc<OwnerSlots>>,
    handler: Handler,
) -> Result<(), async_nats::SubscribeError> {
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
            let owner_slots = owner_slots.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let out = match decode_checked::<ShardRequest>(&msg.payload, Origin::Server) {
                    Ok(req) if req.method == m.name => {
                        let slot = match &owner_slots {
                            Some(slots) => slots.try_acquire(&req.user),
                            None => Some(None),
                        };
                        match slot {
                            None => rate_limited_reply(OWNER_BUSY_RETRY_MS),
                            Some(_slot) => match handler(m, req).await {
                                Ok(b) => ok_reply(b),
                                Err(code) => error_reply(code),
                            },
                        }
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_slots_cap_each_owner_and_free_on_drop() {
        let slots = OwnerSlots::new(2);
        let a1 = slots.try_acquire("a@x").expect("первый слот");
        let a2 = slots.try_acquire("a@x").expect("второй слот");
        assert!(slots.try_acquire("a@x").is_none(), "третий запрос того же владельца — отказ");
        assert!(slots.try_acquire("b@x").is_some(), "у другого владельца своя доля");
        assert!(matches!(slots.try_acquire(""), Some(None)), "анонимный запрос долей не считается");
        drop(a1);
        assert!(slots.try_acquire("a@x").is_some(), "освобождённый слот снова доступен");
        drop(a2);
        assert_eq!(slots.tracked(), 0, "свободные владельцы не копятся в памяти");
    }
}
