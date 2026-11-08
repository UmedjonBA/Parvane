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

/// Записей в минуту от одного чужого домена одному нашему получателю: сервер без членства получателя в его
/// группе не заполняет журнал инбокса чужого пользователя (A0018-2). Число записей настоящей группы за минуту
/// заведомо меньше.
const PUSH_PER_MIN: u32 = 240;

/// S7-16: общий потолок поддоменов одного регистрируемого домена одному получателю (wildcard-DNS иначе
/// умножал лимит на число поддоменов). Во столько раз больше лимита одного домена.
const PUSH_SITE_FACTOR: u32 = 4;

/// Регистрируемый домен по простой эвристике (последние две метки): списка публичных суффиксов в сборке нет.
/// Для `*.co.uk`, `*.duckdns.org` это общий потолок всех серверов такого суффикса одному получателю —
/// с запасом `PUSH_SITE_FACTOR` настоящих групп не задевает.
pub(crate) fn site_of(domain: &str) -> String {
    let d = domain.trim_end_matches('.').to_ascii_lowercase();
    if d.parse::<std::net::IpAddr>().is_ok() {
        return d;
    }
    let labels: Vec<&str> = d.rsplit('.').take(2).collect();
    labels.into_iter().rev().collect::<Vec<_>>().join(".")
}

/// Лимит записи по домену и по регистрируемому домену (S7-16).
fn push_allowed(origin: &str, recipient: &str, per_min: u32) -> bool {
    let site = format!("~{}", site_of(origin));
    push_rate_ok(origin, recipient, per_min) && push_rate_ok(&site, recipient, per_min.saturating_mul(PUSH_SITE_FACTOR))
}

fn push_rate_ok(origin: &str, recipient: &str, per_min: u32) -> bool {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Instant;
    static RATES: Mutex<Option<HashMap<(String, String), (Instant, u32)>>> = Mutex::new(None);
    let Ok(mut guard) = RATES.lock() else { return false };
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() > 50_000 {
        map.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    }
    let slot = map.entry((origin.to_string(), recipient.to_string())).or_insert((Instant::now(), 0));
    if slot.0.elapsed() >= Duration::from_secs(60) {
        *slot = (Instant::now(), 0);
    }
    slot.1 += 1;
    slot.1 <= per_min
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
        if !push_allowed(&origin, &r.address, PUSH_PER_MIN) {
            warn!("messenger: чужой домен {} превысил частоту записей получателю", origin);
            continue;
        }
        let Ok(devs) = ctx.devices_of(&r.address).await else { continue };
        let owner = crate::v2::inbox_owner(&r.address, &devs).to_string();
        match store_pushed(&ctx.v2, &r.address, &owner, &devs.v2_device_ids, &group, &item).await {
            Ok(done) => {
                for (a, it) in done {
                    ctx.publish_live(a, it).await;
                }
            }
            Err(e) => warn!("messenger: запись группы с {} не сохранена: {:?}", origin, e),
        }
    }
    Ok(())
}

/// Потолок подписок одного пользователя на группы других серверов.
pub(crate) const MAX_REMOTE_SUBSCRIPTIONS: i64 = 5000;

fn sub_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("messenger: подписки на удалённые группы: {}", e);
    ErrorCode::Unavailable
}

/// `group.remote.subscribe` (PV-014): своему пользователю — записи группы другого сервера. Группа своего сервера —
/// `INVALID` (её записи и так кладёт свой журнал группы).
pub(crate) async fn subscribe(pool: &sqlx::SqlitePool, user: &str, group: &Ref) -> Result<(), ErrorCode> {
    parvane_protocol::address::check_ref(group).map_err(|_| ErrorCode::Invalid)?;
    let domain = group.domain.to_ascii_lowercase();
    if domain == server_domain() {
        return Err(ErrorCode::Invalid);
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(sub_err)?;
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM remote_group_subscriptions WHERE user = ?").bind(user).fetch_one(&mut *tx).await.map_err(sub_err)?;
    let r = sqlx::query("INSERT OR IGNORE INTO remote_group_subscriptions (user, group_domain, group_id, created_ms) SELECT ?, ?, ?, ? WHERE ? < ?")
        .bind(user)
        .bind(&domain)
        .bind(&group.id)
        .bind(crate::now_unix() * 1000)
        .bind(n)
        .bind(MAX_REMOTE_SUBSCRIPTIONS)
        .execute(&mut *tx)
        .await
        .map_err(sub_err)?;
    if r.rows_affected() == 0 && n >= MAX_REMOTE_SUBSCRIPTIONS {
        let (had,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM remote_group_subscriptions WHERE user = ? AND group_domain = ? AND group_id = ?")
            .bind(user)
            .bind(&domain)
            .bind(&group.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(sub_err)?;
        if had == 0 {
            return Err(ErrorCode::Limit);
        }
    }
    tx.commit().await.map_err(sub_err)?;
    Ok(())
}

/// `group.remote.unsubscribe`: выход из группы другого сервера (повтор — без ошибки).
pub(crate) async fn unsubscribe(pool: &sqlx::SqlitePool, user: &str, group: &Ref) -> Result<(), ErrorCode> {
    parvane_protocol::address::check_ref(group).map_err(|_| ErrorCode::Invalid)?;
    sqlx::query("DELETE FROM remote_group_subscriptions WHERE user = ? AND group_domain = ? AND group_id = ?")
        .bind(user)
        .bind(group.domain.to_ascii_lowercase())
        .bind(&group.id)
        .execute(pool)
        .await
        .map_err(sub_err)?;
    Ok(())
}

async fn subscribed(pool: &sqlx::SqlitePool, user: &str, group: &Ref) -> Result<bool, ErrorCode> {
    let r: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM remote_group_subscriptions WHERE user = ? AND group_domain = ? AND group_id = ?")
        .bind(user)
        .bind(group.domain.to_ascii_lowercase())
        .bind(&group.id)
        .fetch_optional(pool)
        .await
        .map_err(sub_err)?;
    Ok(r.is_some())
}

/// Запись группы с другого сервера в журналы устройств получателя `recipient` (журналы — на адресе `owner`).
pub(crate) async fn store_pushed(
    pool: &sqlx::SqlitePool,
    recipient: &str,
    owner: &str,
    devices: &[String],
    group: &Ref,
    item: &inbox_record::Item,
) -> Result<Vec<(crate::v2::Appended, inbox_record::Item)>, ErrorCode> {
    // PV-014: только группы, на которые получатель подписан; иначе запись отбрасывается молча — ответ об
    // ошибке выдал бы чужому серверу, состоит ли наш пользователь в группе
    if !subscribed(pool, recipient, group).await? {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for d in devices {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(|_| ErrorCode::Unavailable)?;
        match crate::v2::append_in(&mut tx, owner, d, item).await {
            Ok(a) => {
                tx.commit().await.map_err(|_| ErrorCode::Unavailable)?;
                out.push((a, item.clone()));
            }
            Err(ErrorCode::Limit) => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_rate_limits_per_origin_and_recipient() {
        for _ in 0..3 {
            assert!(push_rate_ok("far.example", "ann@near.example", 3));
        }
        assert!(!push_rate_ok("far.example", "ann@near.example", 3), "сверх потолка — отказ");
        assert!(push_rate_ok("far.example", "bob@near.example", 3), "другой получатель не затронут");
        assert!(push_rate_ok("other.example", "ann@near.example", 3), "другой домен не затронут");
    }

    /// S7-16: поддомены одного домена делят общий потолок получателю.
    #[test]
    fn push_rate_is_shared_by_subdomains() {
        assert_eq!(site_of("a.b.Evil.Example."), "evil.example");
        assert_eq!(site_of("evil.example"), "evil.example");
        let mut ok = 0;
        for i in 0..20 {
            if push_allowed(&format!("s{i}.wild.example"), "zoe@near.example", 2) {
                ok += 1;
            }
        }
        assert_eq!(ok, 2 * PUSH_SITE_FACTOR, "20 поддоменов — не больше общего потолка сайта");
        assert!(push_allowed("calm.example", "zoe@near.example", 2), "другой сайт не затронут");
    }

    async fn pool() -> sqlx::SqlitePool {
        let p = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&p).await.unwrap();
        p
    }

    fn group(id: u8) -> Ref {
        Ref { domain: "far.example".into(), id: vec![id; parvane_protocol::address::REF_ID_LEN] }
    }

    fn rows(n: usize) -> inbox_record::Item {
        inbox_record::Item::Group(parvane_protocol::pb::parvane::core::v2::GroupEnvelope { epoch_aead_ciphertext: vec![1; n], group: Some(group(9)), ..Default::default() })
    }

    /// PV-014 (spec 035, FR-072): чужой сервер не кладёт записи группы, на которую получатель не подписан; 1000
    /// таких пушей не занимают журнал, законная запись проходит. Подписанная группа доставляется, после отписки — нет.
    #[tokio::test]
    async fn push_of_unsubscribed_group_is_dropped() {
        let p = pool().await;
        let devs = vec!["d1".to_string()];
        for _ in 0..1000 {
            store_pushed(&p, "alice@local", "alice@local", &devs, &group(9), &rows(64)).await.unwrap();
        }
        let dev = crate::v2::device_key("alice@local", "d1").unwrap();
        let count = |p: sqlx::SqlitePool, dev: String| async move {
            let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM inbox_log WHERE device = ?").bind(&dev).fetch_one(&p).await.unwrap();
            n
        };
        assert_eq!(count(p.clone(), dev.clone()).await, 0, "неизвестная группа не попадает в инбокс");
        let mut tx = p.begin().await.unwrap();
        let sealed = inbox_record::Item::Sealed(Default::default());
        crate::v2::append_in(&mut tx, "alice@local", "d1", &sealed).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(count(p.clone(), dev.clone()).await, 1);
        // Подписка — запись доставляется; отписка — снова нет
        subscribe(&p, "alice@local", &group(9)).await.unwrap();
        assert_eq!(store_pushed(&p, "alice@local", "alice@local", &devs, &group(9), &rows(64)).await.unwrap().len(), 1);
        unsubscribe(&p, "alice@local", &group(9)).await.unwrap();
        assert!(store_pushed(&p, "alice@local", "alice@local", &devs, &group(9), &rows(64)).await.unwrap().is_empty());
        assert_eq!(count(p, dev).await, 2);
    }
}
