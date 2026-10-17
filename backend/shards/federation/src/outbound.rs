//! Своё → чужой сервер (spec 028, R3, R10): запросы `v2.federation.out` от
//! gateway и шардов; доставка по очереди с повтором до суток.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    federation_out, s2s_request, shard_response, ErrorCode, FederationOut, KeyOwnerResponse, S2sForward, S2sRequest,
    ShardResponse,
};
use parvane_protocol::registry_gen::FEDERATION_OUT;
use prost::Message;
use tokio::sync::mpsc;
use tracing::{error, warn};

use crate::peers::{err, now_ms, Fed, StreamItem};
use crate::store;

/// Повтор доставки из очереди: до суток от постановки.
const OUTBOX_MAX_AGE_MS: i64 = 24 * 3600 * 1000;
const OUTBOX_MAX_BACKOFF_MS: i64 = 3600 * 1000;

fn reply_ok(b: Vec<u8>) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Ok(b)) }.encode_to_vec()
}

fn reply_err(e: parvane_protocol::pb::parvane::core::v2::Error) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Error(e)) }.encode_to_vec()
}

pub async fn run(fed: Arc<Fed>) -> anyhow::Result<()> {
    let mut sub = fed.nc.subscribe(FEDERATION_OUT.to_string()).await?;
    let f2 = fed.clone();
    tokio::spawn(async move {
        while let Some(m) = sub.next().await {
            let fed = f2.clone();
            tokio::spawn(async move {
                let Some(reply) = m.reply.clone() else { return };
                handle(&fed, reply.to_string(), &m.payload).await;
            });
        }
    });
    tokio::spawn(outbox_loop(fed));
    Ok(())
}

async fn publish(fed: &Fed, reply: &str, bytes: Vec<u8>) {
    if let Err(e) = fed.nc.publish(reply.to_string(), bytes.into()).await {
        error!("федерация: ответ в шину не отправлен: {}", e);
    }
}

async fn handle(fed: &Arc<Fed>, reply: String, payload: &[u8]) {
    let out: FederationOut = match decode_checked(payload, Origin::Server) {
        Ok(o) => o,
        Err(_) => return publish(fed, &reply, reply_err(err(ErrorCode::Invalid, 0))).await,
    };
    let dest = out.dest_domain.to_ascii_lowercase();
    let Some(kind) = out.kind else { return publish(fed, &reply, reply_err(err(ErrorCode::Invalid, 0))).await };
    // «Аккаунт удалён» без адресата — всем серверам, с которыми есть связь (identity их не знает).
    if let (federation_out::Kind::AccountGone(g), true) = (&kind, dest.is_empty()) {
        if !fed.cfg.enabled {
            return publish(fed, &reply, reply_ok(vec![])).await;
        }
        let req = S2sRequest { kind: Some(s2s_request::Kind::AccountGone(g.clone())) }.encode_to_vec();
        for d in store::active_domains(&fed.pool).await.unwrap_or_default() {
            let _ = store::outbox_put(&fed.pool, &d, &req, now_ms()).await;
        }
        return publish(fed, &reply, reply_ok(vec![])).await;
    }
    if let Some(code) = fed.refusal(&dest).await {
        return publish(fed, &reply, reply_err(err(code, 0))).await;
    }
    let req = match kind {
        federation_out::Kind::Forward(sr) => {
            // Только метод с `federated`; транзитной пересылки нет (запрос извне не уходит дальше).
            let Some(m) = parvane_protocol::schema::method(&sr.method).filter(|m| m.federated) else {
                return publish(fed, &reply, reply_err(err(ErrorCode::FederationUnavailable, 0))).await;
            };
            if !sr.origin_domain.is_empty() {
                return publish(fed, &reply, reply_err(err(ErrorCode::Forbidden, 0))).await;
            }
            let id = m.channel == 2;
            let req = S2sRequest {
                kind: Some(s2s_request::Kind::Forward(S2sForward {
                    method: sr.method.clone(),
                    body: sr.body,
                    user: if id { sr.user } else { String::new() },
                    device_id: if id { sr.device_id } else { String::new() },
                    padding: vec![],
                    timeout_ms: out.timeout_ms,
                })),
            };
            if m.kind == 3 {
                return forward_stream(fed, &reply, &dest, req, out.timeout_ms).await;
            }
            req
        }
        // Очередь: письма участникам групп и «аккаунт удалён» — доставка с повтором.
        federation_out::Kind::InboxPush(p) => {
            let req = S2sRequest { kind: Some(s2s_request::Kind::InboxPush(p)) };
            let r = store::outbox_put(&fed.pool, &dest, &req.encode_to_vec(), now_ms()).await;
            return publish(fed, &reply, if r.is_ok() { reply_ok(vec![]) } else { reply_err(err(ErrorCode::Unavailable, 1000)) }).await;
        }
        federation_out::Kind::AccountGone(g) => {
            let req = S2sRequest { kind: Some(s2s_request::Kind::AccountGone(g)) };
            let r = store::outbox_put(&fed.pool, &dest, &req.encode_to_vec(), now_ms()).await;
            return publish(fed, &reply, if r.is_ok() { reply_ok(vec![]) } else { reply_err(err(ErrorCode::Unavailable, 1000)) }).await;
        }
        federation_out::Kind::KeyOwner(k) => S2sRequest { kind: Some(s2s_request::Kind::KeyOwner(k)) },
        federation_out::Kind::PrivacyOf(p) => S2sRequest { kind: Some(s2s_request::Kind::PrivacyOf(p)) },
        federation_out::Kind::Ephemeral(e) => S2sRequest { kind: Some(s2s_request::Kind::Ephemeral(e)) },
    };
    let is_key_owner = matches!(req.kind, Some(s2s_request::Kind::KeyOwner(_)));
    let res = fed.call(&dest, &req, out.timeout_ms, None).await;
    if let Err(e) = &res {
        warn!("федерация: запрос на {} не выполнен (код {})", dest, e.code);
    }
    let res = match res {
        // Владелец ключа — только пользователь того сервера, у которого спрашивали (доверие по домену).
        Ok(b) if is_key_owner => Ok(scope_key_owner(&b, &dest)),
        r => r,
    };
    publish(fed, &reply, match res {
        Ok(b) => reply_ok(b),
        Err(e) => reply_err(e),
    })
    .await;
}

/// Ответ «владелец ключа» с чужого сервера: адрес и прежние адреса — только его домена.
pub(crate) fn scope_key_owner(bytes: &[u8], dest: &str) -> Vec<u8> {
    let Ok(mut r) = decode_checked::<KeyOwnerResponse>(bytes, Origin::Server) else {
        return KeyOwnerResponse::default().encode_to_vec();
    };
    let own = |a: &str| parvane_protocol::address::address_domain(a).is_some_and(|d| d.eq_ignore_ascii_case(dest));
    if r.found && !own(&r.user) {
        warn!("федерация: {} назвал владельцем ключа пользователя чужого домена — отвергнуто", dest);
        return KeyOwnerResponse::default().encode_to_vec();
    }
    r.aliases.retain(|a| own(a));
    r.encode_to_vec()
}

/// Поток ответа (скачивание блоба): заголовок, затем чанки — в reply-inbox.
async fn forward_stream(fed: &Arc<Fed>, reply: &str, dest: &str, req: S2sRequest, timeout_ms: u32) {
    let (tx, mut rx) = mpsc::channel::<StreamItem>(8);
    let (f2, dest2) = (fed.clone(), dest.to_string());
    let call = tokio::spawn(async move { f2.call(&dest2, &req, timeout_ms, Some(tx)).await });
    let mut headed = false;
    while let Some(item) = rx.recv().await {
        match item {
            StreamItem::Head(Ok(b)) => {
                headed = true;
                publish(fed, reply, reply_ok(b)).await;
            }
            StreamItem::Head(Err(e)) => return publish(fed, reply, reply_err(e)).await,
            StreamItem::Chunk(c) => publish(fed, reply, c.encode_to_vec()).await,
        }
    }
    if !headed {
        let e = match call.await {
            Ok(Err(e)) => e,
            _ => err(ErrorCode::DomainUnreachable, 10_000),
        };
        publish(fed, reply, reply_err(e)).await;
    }
}

/// Доставка из очереди: повтор 1, 2, 4 … ≤ 3600 с, до суток от постановки.
async fn outbox_loop(fed: Arc<Fed>) {
    let mut t = tokio::time::interval(Duration::from_secs(1));
    loop {
        t.tick().await;
        let now = now_ms();
        let _ = store::prune_nonces(&fed.pool, now).await;
        let rows = match store::outbox_due(&fed.pool, now, 32).await {
            Ok(r) => r,
            Err(e) => {
                error!("федерация: очередь не прочитана: {}", e);
                continue;
            }
        };
        for (id, dest, payload, attempts, created_ms) in rows {
            let Ok(req) = S2sRequest::decode(payload.as_slice()) else {
                let _ = store::outbox_done(&fed.pool, id).await;
                continue;
            };
            match fed.call(&dest, &req, 0, None).await {
                Ok(_) => {
                    let _ = store::outbox_done(&fed.pool, id).await;
                }
                Err(e) if now - created_ms > OUTBOX_MAX_AGE_MS => {
                    warn!("федерация: доставка на {} не удалась за сутки (код {}), снята", dest, e.code);
                    let _ = store::outbox_done(&fed.pool, id).await;
                }
                Err(e) => {
                    let backoff = (1000i64 << attempts.clamp(0, 12)).min(OUTBOX_MAX_BACKOFF_MS);
                    let next = now + backoff.max(i64::from(e.retry_after_ms));
                    let _ = store::outbox_retry(&fed.pool, id, attempts + 1, next).await;
                }
            }
        }
    }
}
