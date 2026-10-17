//! Федерация в messenger (spec 028, R10, R11): участники групп с других
//! серверов получают записи через шард federation (`inbox_push`, очередь с
//! повтором), владелец ключа подписи и приватность чужого участника — запросом
//! его серверу; записи и «аккаунт удалён» с других серверов — приём здесь.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    federation_out, shard_response, Error as PbError, ErrorCode, FederationOut, KeyOwnerRequest, KeyOwnerResponse, PrivacyOfRequest,
    PrivacyOfResponse, Ref, S2sAccountGone, S2sInboxPush, ShardRequest, ShardResponse, UserRef,
};
use parvane_protocol::pb::parvane::msg::v2::{inbox_record, InboxRecord};
use parvane_protocol::registry_gen::{FEDERATION_OUT, INTERNAL_ACCOUNT_GONE, INTERNAL_INBOX_PUSH};
use prost::Message;
use tracing::{error, info, warn};

use crate::v2::{server_domain, V2};

/// Получателей в одной записи межсерверной доставки.
const PUSH_CHUNK: usize = 200;

/// Домен адреса, если он не свой.
pub(crate) fn foreign_domain(addr: &str) -> Option<String> {
    let d = parvane_protocol::address::address_domain(addr)?;
    (!d.eq_ignore_ascii_case(&server_domain())).then(|| d.to_ascii_lowercase())
}

/// Участники по доменам: свои — `None` (обычная доставка), чужие — по домену.
pub(crate) fn split<'a>(members: impl IntoIterator<Item = &'a String>) -> (Vec<String>, BTreeMap<String, Vec<String>>) {
    let (mut local, mut remote) = (vec![], BTreeMap::<String, Vec<String>>::new());
    for m in members {
        match foreign_domain(m) {
            Some(d) => remote.entry(d).or_default().push(m.clone()),
            None => local.push(m.clone()),
        }
    }
    (local, remote)
}

async fn fed_call(ctx: &V2, out: FederationOut, timeout: Duration) -> Result<Vec<u8>, PbError> {
    let unavailable = PbError { code: ErrorCode::Unavailable as i32, retry_after_ms: 1000 };
    let r = tokio::time::timeout(timeout, ctx.nc.request(FEDERATION_OUT.to_string(), out.encode_to_vec().into()))
        .await
        .map_err(|_| unavailable.clone())?
        .map_err(|_| unavailable.clone())?;
    match decode_checked::<ShardResponse>(&r.payload, Origin::Server) {
        Ok(ShardResponse { result: Some(shard_response::Result::Ok(b)) }) => Ok(b),
        Ok(ShardResponse { result: Some(shard_response::Result::Error(e)) }) => Err(e),
        _ => Err(unavailable),
    }
}

/// Запись группы участникам на других серверах (очередь шарда federation).
pub(crate) async fn push_remote(ctx: &V2, group: &Ref, remote: BTreeMap<String, Vec<String>>, item: inbox_record::Item) {
    let record = InboxRecord { seq: 0, received_ms: 0, item: Some(item) }.encode_to_vec();
    for (domain, users) in remote {
        for chunk in users.chunks(PUSH_CHUNK) {
            let push = S2sInboxPush {
                group: Some(group.clone()),
                recipients: chunk.iter().map(|u| UserRef { address: u.clone() }).collect(),
                record: record.clone(),
            };
            let out = FederationOut { dest_domain: domain.clone(), timeout_ms: 0, kind: Some(federation_out::Kind::InboxPush(push)) };
            if let Err(e) = fed_call(ctx, out, Duration::from_secs(5)).await {
                warn!("messenger: запись группы на {} не поставлена в очередь (код {})", domain, e.code);
            }
        }
    }
}

/// Владелец ключа подписи у сервера заявленного автора (доверие — в пределах его домена,
/// ответ уже ограничен доменом в шарде federation).
pub(crate) async fn key_owner_remote(ctx: &V2, key: &[u8; 32], claimed: &str) -> Result<Option<KeyOwnerResponse>, ErrorCode> {
    let Some(domain) = foreign_domain(claimed) else { return Ok(None) };
    let out = FederationOut {
        dest_domain: domain,
        timeout_ms: 5000,
        kind: Some(federation_out::Kind::KeyOwner(KeyOwnerRequest { ed25519: key.to_vec() })),
    };
    let b = fed_call(ctx, out, Duration::from_secs(8)).await.map_err(|e| ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unavailable))?;
    let o = decode_checked::<KeyOwnerResponse>(&b, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
    if !o.found || (o.user != claimed && !o.aliases.iter().any(|a| a == claimed)) {
        return Ok(None);
    }
    Ok(Some(o))
}

/// Приватность «кто может добавлять меня в группы» участника с другого сервера; ошибка связи —
/// отказ (fail-closed).
pub(crate) async fn privacy_remote(ctx: &V2, user: &str, domain: &str) -> anyhow::Result<PrivacyOfResponse> {
    let out = FederationOut {
        dest_domain: domain.to_string(),
        timeout_ms: 5000,
        kind: Some(federation_out::Kind::PrivacyOf(PrivacyOfRequest { user: user.to_string() })),
    };
    let b = fed_call(ctx, out, Duration::from_secs(8)).await.map_err(|e| anyhow::anyhow!("privacy_of удалённо: код {}", e.code))?;
    decode_checked::<PrivacyOfResponse>(&b, Origin::Server).map_err(|e| anyhow::anyhow!("privacy_of: {e:?}"))
}

fn ok_reply() -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Ok(vec![])) }.encode_to_vec()
}

fn err_reply(code: ErrorCode) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Error(PbError { code: code as i32, retry_after_ms: 0 })) }.encode_to_vec()
}

/// Запись группы с другого сервера своим участникам (шард federation проверил кадр;
/// здесь — повторно: группа домена-отправителя, получатели — свои).
async fn inbox_push(ctx: &V2, req: ShardRequest) -> Result<(), ErrorCode> {
    let origin = req.origin_domain.to_ascii_lowercase();
    if origin.is_empty() || origin == server_domain() {
        return Err(ErrorCode::Forbidden);
    }
    let p: S2sInboxPush = decode_checked(&req.body, Origin::Client).map_err(|_| ErrorCode::Invalid)?;
    let group = p.group.ok_or(ErrorCode::Invalid)?;
    if !group.domain.eq_ignore_ascii_case(&origin) {
        return Err(ErrorCode::Forbidden);
    }
    let rec = parvane_protocol::federation::push_record(&p.record, &group).map_err(|_| ErrorCode::Forbidden)?;
    let item = rec.item.ok_or(ErrorCode::Invalid)?;
    for r in p.recipients {
        if foreign_domain(&r.address).is_some() {
            return Err(ErrorCode::Forbidden);
        }
        let Ok(devs) = ctx.devices_of(&r.address).await else { continue };
        let owner = crate::v2::inbox_owner(&r.address, &devs).to_string();
        for d in &devs.v2_device_ids {
            let _ = ctx.append(&owner, d, item.clone()).await;
        }
    }
    Ok(())
}

/// Адрес другого сервера удалён (spec 027): забыть кэш владельцев ключей. Членство в группах —
/// подписанный журнал группы; собеседники видят удаление по журналу устройств адреса.
async fn account_gone(ctx: &V2, req: ShardRequest) -> Result<(), ErrorCode> {
    let origin = req.origin_domain.to_ascii_lowercase();
    let g: S2sAccountGone = decode_checked(&req.body, Origin::Client).map_err(|_| ErrorCode::Invalid)?;
    let user = g.user.ok_or(ErrorCode::Invalid)?.address;
    if foreign_domain(&user).as_deref() != Some(origin.as_str()) {
        return Err(ErrorCode::Forbidden);
    }
    if let Ok(mut o) = ctx.groups.owners.lock() {
        o.retain(|_, (_, s, _)| s.user != user);
    }
    info!("messenger: адрес другого сервера удалён — кэш владельцев ключей очищен");
    Ok(())
}

/// Подписки на записи и уведомления с других серверов (публикует только роль federation).
pub(crate) async fn serve(ctx: Arc<V2>) {
    let (mut push, mut gone) = match (ctx.nc.subscribe(INTERNAL_INBOX_PUSH.to_string()).await, ctx.nc.subscribe(INTERNAL_ACCOUNT_GONE.to_string()).await) {
        (Ok(a), Ok(b)) => (a, b),
        _ => {
            error!("messenger: подписки федерации не удались");
            return;
        }
    };
    loop {
        let (m, is_push) = tokio::select! {
            Some(m) = push.next() => (m, true),
            Some(m) = gone.next() => (m, false),
            else => return,
        };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let Some(reply) = m.reply.clone() else { return };
            let r = match decode_checked::<ShardRequest>(&m.payload, Origin::Server) {
                Ok(req) if is_push => inbox_push(&ctx, req).await,
                Ok(req) => account_gone(&ctx, req).await,
                Err(_) => Err(ErrorCode::Invalid),
            };
            let bytes = match r {
                Ok(()) => ok_reply(),
                Err(c) => err_reply(c),
            };
            let _ = ctx.nc.publish(reply, bytes.into()).await;
        });
    }
}
