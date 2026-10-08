//! Методы протокола v2 в messenger (spec 007, US1/US2: T043–T046, T072,
//! T096). Хранилище — отдельный файл `<PARVANE_DB_PATH>-v2.db`.
//!
//! - Журнал инбокса устройства (`inbox_log`, курсор `seq`), синхронизация с
//!   байтовым бюджетом ≤ 716800 и подтверждение без отправителя (T044).
//! - Мост v1 → v2 (`LegacyV1`: догон истории v1 и живые v1-кадры, T045/T046) и
//!   `msg.deliver_legacy` удалены вместе с v1 (T110, 7 окт 2026); вид записи
//!   `LegacyV1` остаётся в схеме, сервер его больше не пишет.
//! - Sealed-доставка без отправителя: право — ключ доступа (сверка хэша в
//!   identity) или слепой жетон (одноразовость — здесь), один получатель на
//!   запрос (D-05), только v2-устройства получателя (T072).
//! - Журнал личного состояния (`state.append/sync`, шифртекст) — `v2_state`.

use crate::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    sealed_envelope::Access, DeliveryKeyCheckRequest, DeliveryKeyCheckResponse, DevicesOfRequest, DevicesOfResponse,
    ErrorCode, ShardRequest, TokenCheckRequest, TokenCheckResponse,
};
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, inbox_record, InboxRecord};
use parvane_protocol::pb::parvane::state::v1 as spb;
use parvane_protocol::registry_gen::{inbox_subject, INBOX_PREFIX, INTERNAL_DELIVERY_KEY_CHECK, INTERNAL_DEVICES_OF, INTERNAL_TOKEN_CHECK};
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message as _;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Срок жизни записей журнала (как очередь v1).
pub(crate) const INBOX_TTL_SECS: i64 = 30 * 86_400;
/// Подтверждённые записи держим ещё сутки (другие вкладки/переустановка).
pub(crate) const ACKED_KEEP_SECS: i64 = 86_400;
/// Кэш списка устройств пользователя.
const DEVICES_TTL: Duration = Duration::from_secs(30);
/// Строк, просматриваемых одной страницей синка (только длины; тела читаются
/// лишь для тех, что влезают в байтовый бюджет — C1-07).
const SYNC_SCAN: i64 = 4096;

/// C1-07 (D-17): квота журнала инбокса устройства на записи, которые задают
/// отправители (sealed/групповые). Сверх неё — `LIMIT`, журнал не растёт.
fn inbox_quota() -> (i64, i64) {
    let n = |k: &str, d: i64| std::env::var(k).ok().and_then(|v| v.parse().ok()).filter(|&v: &i64| v > 0).unwrap_or(d);
    (n("PARVANE_V2_INBOX_MAX_RECORDS", 20_000), n("PARVANE_V2_INBOX_MAX_BYTES", 256 * 1024 * 1024))
}

pub(crate) struct V2 {
    pub nc: Client,
    pub v2: SqlitePool,
    devices: Mutex<HashMap<String, (Instant, DevicesOfResponse)>>,
    pub groups: crate::v2_groups::GroupCache,
}

static CTX: OnceLock<Arc<V2>> = OnceLock::new();

pub(crate) fn ctx() -> Option<Arc<V2>> {
    CTX.get().cloned()
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("messenger v2: {}", e);
    ErrorCode::Unavailable
}

/// Открыть v2-хранилище рядом с v1-БД.
pub(crate) async fn open_store(db_path: &str) -> Result<SqlitePool> {
    let path = format!("{db_path}-v2.db");
    let pool = parvane_db::connect(&path).await?;
    sqlx::migrate!("./migrations_v2").run(&pool).await.context("миграции v2")?;
    info!("SQLite v2 готов: {}", path);
    Ok(pool)
}

pub(crate) async fn run(nc: Client, v2: SqlitePool) -> Result<()> {
    let ctx = Arc::new(V2 { nc: nc.clone(), v2, devices: Mutex::new(HashMap::new()), groups: Default::default() });
    let _ = CTX.set(ctx.clone());
    let c2 = ctx.clone();
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let ctx = c2.clone();
        Box::pin(async move { dispatch(&ctx, m, req).await })
    });
    let concurrency = std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(64);
    parvane_v2rt::serve(nc, "messenger", concurrency, handler).await?;
    tokio::spawn(crate::v2_groups::serve_group_epoch(ctx.clone()));
    let c4 = ctx.clone();
    tokio::spawn(async move { crate::v2_groups::rebuild_link_index(&c4).await });
    let c3 = ctx.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(3600));
        loop {
            t.tick().await;
            if let Err(e) = c3.gc().await {
                error!("v2 gc: {}", e);
            }
        }
    });
    info!("messenger: методы v2 подключены");
    Ok(())
}

async fn dispatch(ctx: &V2, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    match m.name {
        "msg.inbox.sync" => {
            let (user, device) = me(&req)?;
            let r: mpb::InboxSyncRequest = body(&req)?;
            ctx.sync(&user, &device, r.after_seq, r.max_bytes).await
        }
        "msg.inbox.ack" => {
            let (user, device) = me(&req)?;
            let r: mpb::InboxAckRequest = body(&req)?;
            let dev = device_key(&user, &device)?;
            sqlx::query("INSERT INTO inbox_device (device, acked_seq) VALUES (?, ?) ON CONFLICT(device) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)")
                .bind(&dev)
                .bind(r.up_to_seq as i64)
                .execute(&ctx.v2)
                .await
                .map_err(db_err)?;
            Ok(mpb::InboxAckResponse {}.encode_to_vec())
        }
        "msg.inbox.hide" => {
            let (user, device) = me(&req)?;
            let r: mpb::InboxHideRequest = body(&req)?;
            let dev = device_key(&user, &device)?;
            let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
            for seq in r.seqs {
                let gone: Option<(i64,)> = sqlx::query_as("DELETE FROM inbox_log WHERE device = ? AND seq = ? RETURNING LENGTH(item)")
                    .bind(&dev)
                    .bind(seq as i64)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(db_err)?;
                if let Some((len,)) = gone {
                    sqlx::query("UPDATE inbox_device SET records = MAX(records - 1, 0), bytes = MAX(bytes - ?, 0) WHERE device = ?")
                        .bind(len)
                        .bind(&dev)
                        .execute(&mut *tx)
                        .await
                        .map_err(db_err)?;
                }
            }
            tx.commit().await.map_err(db_err)?;
            Ok(mpb::InboxHideResponse {}.encode_to_vec())
        }
        "msg.deliver_sealed" => {
            let r: mpb::DeliverSealedRequest = body(&req)?;
            ctx.deliver_sealed(r).await
        }
        // T110: легаси-копий v1 больше нет (v1-устройств у аккаунтов не бывает).
        "msg.deliver_legacy" => Err(ErrorCode::Unavailable),
        "msg.deliver_group" => {
            let r: mpb::DeliverGroupRequest = body(&req)?;
            crate::v2_groups::deliver_group(ctx, r).await
        }
        "state.append" => {
            let (user, _) = me(&req)?;
            let r: spb::AppendRequest = body(&req)?;
            let seq = crate::v2_state::append(&ctx.v2, &user, &r, crate::v2_state::StateLimits::from_env()).await?;
            Ok(spb::AppendResponse { seq }.encode_to_vec())
        }
        "state.sync" => {
            let (user, _) = me(&req)?;
            let r: spb::SyncRequest = body(&req)?;
            Ok(crate::v2_state::sync(&ctx.v2, &user, &r).await?.encode_to_vec())
        }
        name if name.starts_with("group.") => crate::v2_groups::dispatch(ctx, m, req).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Пользователь и устройство идентифицированной сессии.
fn me(req: &ShardRequest) -> Result<(String, String), ErrorCode> {
    if req.user.is_empty() || req.device_id.is_empty() {
        Err(ErrorCode::Forbidden)
    } else {
        Ok((req.user.clone(), req.device_id.clone()))
    }
}

/// Ключ журнала устройства = токен его subject'а.
pub(crate) fn device_key(user: &str, device: &str) -> Result<String, ErrorCode> {
    inbox_subject(user, device).map(|s| s[INBOX_PREFIX.len()..].to_string()).map_err(|_| ErrorCode::Invalid)
}

impl V2 {
    /// Сбросить кэш устройств пользователя.
    pub(crate) fn forget_devices(&self, user: &str) {
        if let Ok(mut g) = self.devices.lock() {
            g.remove(user);
        }
    }

    /// Устройства пользователя (кэш 30 с).
    pub(crate) async fn devices_of(&self, user: &str) -> Result<DevicesOfResponse, ErrorCode> {
        if let Ok(g) = self.devices.lock() {
            if let Some((at, d)) = g.get(user) {
                if at.elapsed() < DEVICES_TTL {
                    return Ok(d.clone());
                }
            }
        }
        let req = DevicesOfRequest { user: user.to_string() }.encode_to_vec();
        let r = tokio::time::timeout(Duration::from_secs(3), self.nc.request(INTERNAL_DEVICES_OF.to_string(), req.into()))
            .await
            .map_err(|_| ErrorCode::Unavailable)?
            .map_err(db_err)?;
        let d = decode_checked::<DevicesOfResponse>(&r.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
        if let Ok(mut g) = self.devices.lock() {
            if g.len() > 10_000 {
                g.clear();
            }
            g.insert(user.to_string(), (Instant::now(), d.clone()));
        }
        Ok(d)
    }

    /// Добавить запись в журнал устройства и отправить её живым событием.
    pub(crate) async fn append(&self, user: &str, device: &str, item: inbox_record::Item) -> Result<u64, ErrorCode> {
        let mut tx = self.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
        let a = append_in(&mut tx, user, device, &item).await?;
        tx.commit().await.map_err(db_err)?;
        let seq = a.seq;
        self.publish_live(a, item).await;
        Ok(seq)
    }

    /// Живое событие записи журнала (после фиксации транзакции).
    async fn publish_live(&self, a: Appended, item: inbox_record::Item) {
        let live = InboxRecord { seq: a.seq, received_ms: a.received_ms, item: Some(item) }.encode_to_vec();
        if let Err(e) = self.nc.publish(format!("{INBOX_PREFIX}{}", a.dev), live.into()).await {
            warn!("v2: живое событие инбокса не отправлено: {}", e);
        }
    }

    async fn sync(&self, user: &str, device: &str, after: u64, max_bytes: u32) -> Reply {
        let dev = device_key(user, device)?;
        let (records, more) = sync_page(&self.v2, &dev, after, max_bytes).await?;
        Ok(mpb::InboxSyncResponse { records, more }.encode_to_vec())
    }

    /// Проверить право доставки. Для жетона возвращает `(spent_id, key_id)` —
    /// трата выполняется в транзакции записи в журнал получателя (D-06).
    async fn check_access(&self, user: &str, access: &Access) -> Result<Option<([u8; 32], Vec<u8>)>, ErrorCode> {
        match access {
            Access::DeliveryKey(k) => {
                if k.len() != 32 {
                    return Err(ErrorCode::Invalid);
                }
                let hash: [u8; 32] = Sha256::digest(k).into();
                let r = self.dk_check(user, hash.to_vec()).await?;
                if r.key_ok {
                    Ok(None)
                } else {
                    Err(ErrorCode::Forbidden)
                }
            }
            Access::AnonToken(t) => {
                let r = self.dk_check(user, vec![]).await?;
                if !r.strangers_allowed {
                    return Err(ErrorCode::Forbidden);
                }
                let req = TokenCheckRequest { token: Some(t.clone()) }.encode_to_vec();
                let resp = tokio::time::timeout(Duration::from_secs(3), self.nc.request(INTERNAL_TOKEN_CHECK.to_string(), req.into()))
                    .await
                    .map_err(|_| ErrorCode::Unavailable)?
                    .map_err(db_err)?;
                let tc = decode_checked::<TokenCheckResponse>(&resp.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
                if tc.code != ErrorCode::Unspecified as i32 {
                    return Err(ErrorCode::try_from(tc.code).unwrap_or(ErrorCode::Forbidden));
                }
                // Уже потраченный — отказ до записи (окончательно — в транзакции).
                let spent = parvane_protocol::tokens::spent_id(t);
                let seen: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM spent_tokens WHERE spent_id = ?")
                    .bind(spent.to_vec())
                    .fetch_optional(&self.v2)
                    .await
                    .map_err(db_err)?;
                if seen.is_some() {
                    return Err(ErrorCode::Duplicate);
                }
                Ok(Some((spent, t.key_id.clone())))
            }
        }
    }

    async fn dk_check(&self, user: &str, key_hash: Vec<u8>) -> Result<DeliveryKeyCheckResponse, ErrorCode> {
        let req = DeliveryKeyCheckRequest { user: user.to_string(), key_hash }.encode_to_vec();
        let r = tokio::time::timeout(Duration::from_secs(3), self.nc.request(INTERNAL_DELIVERY_KEY_CHECK.to_string(), req.into()))
            .await
            .map_err(|_| ErrorCode::Unavailable)?
            .map_err(db_err)?;
        decode_checked::<DeliveryKeyCheckResponse>(&r.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)
    }

    async fn deliver_sealed(&self, r: mpb::DeliverSealedRequest) -> Reply {
        let first = r.envelopes.first().ok_or(ErrorCode::Invalid)?;
        let recipient = first.recipient.as_ref().ok_or(ErrorCode::Invalid)?;
        let user = recipient.address.clone();
        let access = first.access.clone().ok_or(ErrorCode::Forbidden)?;
        // D-05: один пользователь-получатель и одно доказательство права на запрос.
        for e in &r.envelopes {
            let rc = e.recipient.as_ref().ok_or(ErrorCode::Invalid)?;
            parvane_protocol::address::check_device(rc).map_err(|_| ErrorCode::Invalid)?;
            if rc.address != user || e.access.as_ref() != Some(&access) {
                return Err(ErrorCode::Invalid);
            }
            if e.hpke_enc.len() != 32 || e.ciphertext.is_empty() {
                return Err(ErrorCode::Invalid);
            }
        }
        // Адресат на чужом домене — федерации нет.
        let domain = parvane_protocol::address::address_domain(&user).ok_or(ErrorCode::Invalid)?;
        if domain != server_domain() {
            return Err(ErrorCode::FederationUnavailable);
        }
        let spend = self.check_access(&user, &access).await?;
        let mut devs = self.devices_of(&user).await?;
        // Новое устройство могло появиться после кэширования списка (≤ 30 с):
        // незнакомый адресат конверта → перечитать список один раз в обход кэша,
        // иначе доставка новому устройству молча терялась
        let is_unknown = r
            .envelopes
            .iter()
            .filter_map(|e| e.recipient.as_ref())
            .any(|rc| !devs.v2_device_ids.contains(&rc.device_id));
        if is_unknown {
            self.forget_devices(&user);
            devs = self.devices_of(&user).await?;
        }
        // D-06: трата жетона атомарна с записью в журналы получателя — отказ
        // (нет v2-устройств, ошибка записи) оставляет жетон неистраченным.
        let mut tx = self.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
        if let Some((spent, key_id)) = &spend {
            spend_token(&mut tx, spent, key_id, now_unix()).await?;
        }
        let mut done = Vec::with_capacity(r.envelopes.len());
        for mut e in r.envelopes {
            let Some(rc) = e.recipient.clone() else { continue };
            if !devs.v2_device_ids.contains(&rc.device_id) {
                continue;
            }
            // C2-03 (R7): доказательство права нужно только для проверки выше —
            // в журнал и живое событие конверт уходит без ключа доставки/жетона.
            e.access = None;
            let item = inbox_record::Item::Sealed(e);
            match append_in(&mut tx, &user, &rc.device_id, &item).await {
                Ok(a) => done.push((a, item)),
                // Журнал устройства переполнен (C1-07) — другим устройствам доставить.
                Err(ErrorCode::Limit) => continue,
                Err(e) => return Err(e),
            }
        }
        if done.is_empty() {
            // Откат: жетон не списан.
            return Ok(mpb::DeliverSealedResponse { accepted: 0 }.encode_to_vec());
        }
        tx.commit().await.map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => ErrorCode::Duplicate,
            _ => db_err(e),
        })?;
        let accepted = done.len() as u32;
        for (a, item) in done {
            self.publish_live(a, item).await;
        }
        Ok(mpb::DeliverSealedResponse { accepted }.encode_to_vec())
    }

    async fn gc(&self) -> Result<()> {
        let now = now_unix();
        sqlx::query("DELETE FROM inbox_log WHERE received_at < ?").bind(now - INBOX_TTL_SECS).execute(&self.v2).await?;
        sqlx::query(
            "DELETE FROM inbox_log WHERE received_at < ? AND seq <= (SELECT acked_seq FROM inbox_device d WHERE d.device = inbox_log.device)",
        )
        .bind(now - ACKED_KEEP_SECS)
        .execute(&self.v2)
        .await?;
        sqlx::query("DELETE FROM legacy_origin WHERE created_at < ?").bind(now - INBOX_TTL_SECS).execute(&self.v2).await?;
        sqlx::query("DELETE FROM group_envelope_nonce WHERE at < ?").bind(now - INBOX_TTL_SECS).execute(&self.v2).await?;
        // C1-07: учёт объёма после очистки.
        sqlx::query(
            "UPDATE inbox_device SET records = (SELECT COUNT(*) FROM inbox_log l WHERE l.device = inbox_device.device), bytes = (SELECT COALESCE(SUM(LENGTH(item)), 0) FROM inbox_log l WHERE l.device = inbox_device.device)",
        )
        .execute(&self.v2)
        .await?;
        gc_spent(&self.v2, now).await?;
        Ok(())
    }
}

/// Страница журнала инбокса устройства `dev` после `after` (C1-07: память —
/// порядка байтового бюджета страницы).
pub(crate) async fn sync_page(pool: &SqlitePool, dev: &str, after: u64, max_bytes: u32) -> Result<(Vec<InboxRecord>, bool), ErrorCode> {
    // C1-07: сначала только номера и длины, затем тела тех записей, что
    // влезают в бюджет страницы (память — порядка бюджета, не 4096 × 320 КиБ).
    let budget = if max_bytes == 0 { parvane_protocol::sync::PAGE_BUDGET } else { (max_bytes as usize).min(parvane_protocol::sync::PAGE_BUDGET) };
    let sizes: Vec<(i64, i64)> = sqlx::query_as("SELECT seq, LENGTH(item) FROM inbox_log WHERE device = ? AND seq > ? ORDER BY seq LIMIT ?")
        .bind(dev)
        .bind(after as i64)
        .bind(SYNC_SCAN)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    let full = sizes.len() as i64 == SYNC_SCAN;
    let mut used = 0usize;
    let mut last = None;
    for (seq, len) in &sizes {
        // Запас на поля seq/received_ms и обрамление записи.
        let l = usize::try_from(*len).unwrap_or(usize::MAX).saturating_add(32);
        if last.is_some() && used.saturating_add(l) > budget {
            break;
        }
        used = used.saturating_add(l);
        last = Some(*seq);
    }
    let Some(last) = last else {
        return Ok((vec![], false));
    };
    let cut = sizes.last().is_some_and(|(s, _)| *s != last);
    let rows: Vec<(i64, Vec<u8>, i64)> = sqlx::query_as("SELECT seq, item, received_at FROM inbox_log WHERE device = ? AND seq > ? AND seq <= ? ORDER BY seq")
        .bind(dev)
        .bind(after as i64)
        .bind(last)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    let full = full || cut;
    let records = rows.into_iter().filter_map(|(seq, item, at)| {
        let mut r = InboxRecord::decode(item.as_slice()).ok()?;
        r.seq = seq as u64;
        r.received_ms = at * 1000;
        Some(r)
    });
    let (page, more) = parvane_protocol::sync::paginate(records, max_bytes);
    Ok((page, more || full))
}

/// Сколько хранить потраченные жетоны: дольше срока приёма ключа выпуска
/// (ключ суток `d` принимается до конца суток `d+1`, то есть ≤ 2 суток с
/// выдачи) плюс сутки запаса на расхождение часов identity/messenger (D-06:
/// ключ выводится из приёма раньше, чем его множество трат).
pub(crate) const SPENT_KEEP_SECS: i64 = 3 * 86_400;

/// Результат записи в журнал (живое событие — после фиксации).
pub(crate) struct Appended {
    dev: String,
    seq: u64,
    received_ms: i64,
}

/// Запись в журнал устройства внутри транзакции вызывающего.
pub(crate) async fn append_in(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, user: &str, device: &str, item: &inbox_record::Item) -> Result<Appended, ErrorCode> {
    let dev = device_key(user, device)?;
    // Время приёма sealed/групповых записей — с точностью до минуты
    // (T076): сервер не знает режим чата, округляет всегда.
    let now_ms = match item {
        inbox_record::Item::Sealed(_) | inbox_record::Item::Group(_) => parvane_protocol::l2::round_received_ms(now_unix() * 1000),
        _ => now_unix() * 1000,
    };
    let bytes = InboxRecord { seq: 0, received_ms: 0, item: Some(item.clone()) }.encode_to_vec();
    // C1-07 (D-17): квота на записи, которые задают отправители.
    if matches!(item, inbox_record::Item::Sealed(_) | inbox_record::Item::Group(_)) {
        let (max_records, max_bytes) = inbox_quota();
        let used: Option<(i64, i64)> = sqlx::query_as("SELECT records, bytes FROM inbox_device WHERE device = ?").bind(&dev).fetch_optional(&mut **tx).await.map_err(db_err)?;
        if let Some((n, b)) = used {
            if n >= max_records || b.saturating_add(bytes.len() as i64) > max_bytes {
                // MSG-09: счётчики учитывают и подтверждённые записи (они живут ещё
                // сутки до GC) — один собеседник серией конвертов закрывал устройству
                // входящие на сутки, хотя оно всё уже прочитало. Квота — по
                // НЕподтверждённым записям; счётчики остаются быстрым путём.
                let (un, ub): (i64, i64) = sqlx::query_as(
                    "SELECT COUNT(*), COALESCE(SUM(LENGTH(item)), 0) FROM inbox_log
                      WHERE device = ? AND seq > (SELECT acked_seq FROM inbox_device WHERE device = ?)",
                )
                .bind(&dev)
                .bind(&dev)
                .fetch_one(&mut **tx)
                .await
                .map_err(db_err)?;
                if un >= max_records || ub.saturating_add(bytes.len() as i64) > max_bytes {
                    return Err(ErrorCode::Limit);
                }
            }
        }
    }
    let (seq,): (i64,) = sqlx::query_as(
        "INSERT INTO inbox_device (device, next_seq, records, bytes) VALUES (?, 1, 1, ?) ON CONFLICT(device) DO UPDATE SET next_seq = next_seq + 1, records = records + 1, bytes = bytes + excluded.bytes RETURNING next_seq",
    )
    .bind(&dev)
    .bind(bytes.len() as i64)
    .fetch_one(&mut **tx)
    .await
    .map_err(db_err)?;
    sqlx::query("INSERT INTO inbox_log (device, seq, item, received_at) VALUES (?, ?, ?, ?)")
        .bind(&dev)
        .bind(seq)
        .bind(&bytes)
        .bind(now_ms / 1000)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    Ok(Appended { dev, seq: seq as u64, received_ms: now_ms })
}

/// Потратить жетон в транзакции (повтор → DUPLICATE).
pub(crate) async fn spend_token(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, spent: &[u8; 32], key_id: &[u8], now: i64) -> Result<(), ErrorCode> {
    sqlx::query("INSERT INTO spent_tokens (spent_id, key_id, at) VALUES (?, ?, ?)")
        .bind(spent.to_vec())
        .bind(key_id)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => ErrorCode::Duplicate,
            _ => db_err(e),
        })?;
    Ok(())
}

/// Очистка трат старше срока приёма ключа (+ запас).
pub(crate) async fn gc_spent(pool: &SqlitePool, now: i64) -> Result<()> {
    sqlx::query("DELETE FROM spent_tokens WHERE at < ?").bind(now - SPENT_KEEP_SECS).execute(pool).await?;
    Ok(())
}


/// Домен этого сервера (`PARVANE_DOMAIN`, как в identity; по умолчанию `local`).
pub(crate) fn server_domain() -> String {
    std::env::var("PARVANE_DOMAIN")
        .ok()
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

#[cfg(test)]
mod spent_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&p).await.unwrap();
        p
    }

    async fn spend(p: &SqlitePool, id: [u8; 32], now: i64, commit: bool) -> Result<(), ErrorCode> {
        let mut tx = p.begin().await.unwrap();
        spend_token(&mut tx, &id, b"key", now).await?;
        if commit {
            tx.commit().await.unwrap();
        }
        Ok(())
    }

    /// Повтор жетона после смены суток (ключ вчерашних суток ещё принимается) → DUPLICATE.
    #[tokio::test]
    async fn replay_after_day_change_is_duplicate() {
        let p = pool().await;
        let day = 20_000 * 86_400;
        let t0 = day + 86_000; // конец суток выдачи
        spend(&p, [1; 32], t0, true).await.unwrap();
        // Сутки сменились, прошла очистка — трата помнится весь срок приёма ключа.
        let t1 = day + 2 * 86_400 - 1;
        gc_spent(&p, t1).await.unwrap();
        assert_eq!(spend(&p, [1; 32], t1, true).await, Err(ErrorCode::Duplicate));
        // После вывода ключа из приёма множество трат можно чистить.
        gc_spent(&p, t0 + SPENT_KEEP_SECS + 1).await.unwrap();
        spend(&p, [1; 32], t0 + SPENT_KEEP_SECS + 1, true).await.unwrap();
    }

    /// Отказ записи (транзакция не зафиксирована) — жетон не списан.
    #[tokio::test]
    async fn rollback_keeps_token_unspent() {
        let p = pool().await;
        spend(&p, [2; 32], 1, false).await.unwrap();
        spend(&p, [2; 32], 2, true).await.unwrap();
        assert_eq!(spend(&p, [2; 32], 3, true).await, Err(ErrorCode::Duplicate));
    }

    fn big_group_item(n: usize) -> inbox_record::Item {
        inbox_record::Item::Group(parvane_protocol::pb::parvane::core::v2::GroupEnvelope { epoch_aead_ciphertext: vec![7; n], ..Default::default() })
    }

    /// C1-07: страница синка — в пределах байтового бюджета; тела сверх
    /// бюджета не читаются; дочитывается следующей страницей.
    #[tokio::test]
    async fn sync_page_respects_byte_budget() {
        // Десять записей не влезают в квоту «3», которую ставят тесты ниже
        let _env = QUOTA_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let p = pool().await;
        let mut tx = p.begin().await.unwrap();
        for _ in 0..10 {
            append_in(&mut tx, "alice@local", "d1", &big_group_item(300_000)).await.unwrap();
        }
        tx.commit().await.unwrap();
        let dev = device_key("alice@local", "d1").unwrap();
        let (page, more) = sync_page(&p, &dev, 0, 0).await.unwrap();
        assert_eq!(page.len(), 2, "716800 / 300000");
        assert!(more);
        let (page2, _) = sync_page(&p, &dev, page[1].seq, 0).await.unwrap();
        assert_eq!(page2[0].seq, 3);
        // Одна запись больше бюджета клиента — всё равно отдаётся одна.
        let (one, more) = sync_page(&p, &dev, 0, 1000).await.unwrap();
        assert_eq!(one.len(), 1);
        assert!(more);
        let (none, more) = sync_page(&p, &dev, 10, 0).await.unwrap();
        assert!(none.is_empty() && !more);
    }

    /// C1-07 (D-17): квота журнала устройства на записи отправителей.
    // Оба теста квоты правят одну переменную окружения, а тесты идут параллельно:
    // без замка один снимал переменную посреди другого (плавало в `cargo test --workspace`)
    static QUOTA_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn inbox_quota_counts_only_unacked_records() {
        // MSG-09: подтверждённые записи (acked_seq) квоту не занимают
        let _env = QUOTA_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let p = pool().await;
        std::env::set_var("PARVANE_V2_INBOX_MAX_RECORDS", "3");
        let mut tx = p.begin().await.unwrap();
        for _ in 0..3 {
            append_in(&mut tx, "carol@local", "d1", &big_group_item(10)).await.unwrap();
        }
        assert!(matches!(append_in(&mut tx, "carol@local", "d1", &big_group_item(10)).await, Err(ErrorCode::Limit)));
        // устройство подтвердило всё прочитанное — место освобождается без GC
        let dev = device_key("carol@local", "d1").unwrap();
        sqlx::query("UPDATE inbox_device SET acked_seq = 3 WHERE device = ?").bind(&dev).execute(&mut *tx).await.unwrap();
        append_in(&mut tx, "carol@local", "d1", &big_group_item(10)).await.unwrap();
        std::env::remove_var("PARVANE_V2_INBOX_MAX_RECORDS");
    }

    #[tokio::test]
    async fn inbox_quota_limits_sender_records() {
        let _env = QUOTA_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let p = pool().await;
        std::env::set_var("PARVANE_V2_INBOX_MAX_RECORDS", "3");
        let mut tx = p.begin().await.unwrap();
        for _ in 0..3 {
            append_in(&mut tx, "bob@local", "d1", &big_group_item(10)).await.unwrap();
        }
        let over = append_in(&mut tx, "bob@local", "d1", &big_group_item(10)).await;
        // Служебные записи квотой не режутся.
        let notice = inbox_record::Item::DeviceRevoked(mpb::DeviceRevokedNotice { device_id: "x".into() });
        append_in(&mut tx, "bob@local", "d1", &notice).await.unwrap();
        // Другое устройство — своя квота.
        append_in(&mut tx, "bob@local", "d2", &big_group_item(10)).await.unwrap();
        tx.commit().await.unwrap();
        std::env::remove_var("PARVANE_V2_INBOX_MAX_RECORDS");
        assert_eq!(over.err(), Some(ErrorCode::Limit));
        let (n,): (i64,) = sqlx::query_as("SELECT records FROM inbox_device WHERE device = ?").bind(device_key("bob@local", "d1").unwrap()).fetch_one(&p).await.unwrap();
        assert_eq!(n, 4);
    }
}
