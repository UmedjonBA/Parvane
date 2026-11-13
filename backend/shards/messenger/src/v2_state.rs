//! Журнал личного состояния пользователя (spec 007, US5: T096, R10; spec 035: журнал `state.v2`, T035).
//!
//! `state.ops.append` / `state.ops.sync`: журнал `user_state_log_v2` (миграция 0007) хранит ТОЛЬКО шифртекст записи и
//! её `op_id` — содержимое (папки, блок-лист, черновики, отложенные, …) зашифровано ключом личного состояния,
//! сведение делают устройства (`parvane_protocol::state2`). Журнал — на пользователя (общий для его устройств), `seq`
//! монотонный и не переиспользуется. Лимиты: размер записи (схема, ≤ 256 КиБ), число записей и суммарный объём на
//! пользователя (`PARVANE_STATE_MAX_RECORDS`, `PARVANE_STATE_MAX_BYTES`). Повтор `op_id` с тем же шифртекстом —
//! идемпотентен (тот же seq, повтор после обрыва связи), с другим — `DUPLICATE`. Страница синхронизации — байтовый
//! бюджет ≤ 716800, как `msg.inbox.sync`. Прежний журнал `state.v1` (`user_state_log`) и его методы удалены вместе с
//! разовым переносом (T149, миграция 0014).
//!
//! Здесь же — согласие на добавление в группы: настройка `identity.privacy.set` (запрос
//! `v2.internal.identity.privacy_of`).

use crate::*;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, PrivacyOfRequest, PrivacyOfResponse};
use parvane_protocol::pb::parvane::identity::v2::Audience;
use parvane_protocol::pb::parvane::state::v2 as s2pb;
use parvane_protocol::registry_gen::INTERNAL_PRIVACY_OF;
use parvane_protocol::state::{NONCE_LEN, TAG_LEN};
use parvane_protocol::sync::PAGE_BUDGET;
use prost::Message as _;
use std::time::Duration;

/// Записей на страницу (`max_items` у `SyncResponse.records`).
pub(crate) const PAGE_ITEMS: usize = 1024;

/// Лимиты журнала на пользователя.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StateLimits {
    pub max_records: i64,
    pub max_bytes: i64,
}

impl StateLimits {
    pub(crate) fn from_env() -> Self {
        let get = |k: &str, d: i64| std::env::var(k).ok().and_then(|v| v.parse::<i64>().ok()).filter(|&n| n > 0).unwrap_or(d);
        StateLimits {
            max_records: get("PARVANE_STATE_MAX_RECORDS", 100_000),
            max_bytes: get("PARVANE_STATE_MAX_BYTES", 64 * 1024 * 1024),
        }
    }
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("messenger v2 state: {}", e);
    ErrorCode::Unavailable
}

/// Таблицы журнала `state.v2`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Journal {
    log: &'static str,
    head: &'static str,
}

/// Журнал `state.v2` (spec 035, FR-063): `state.ops.append` / `state.ops.sync`.
pub(crate) const V2: Journal = Journal { log: "user_state_log_v2", head: "user_state_head_v2" };

/// Уже записанная операция с этим op_id: тот же шифртекст — её seq (повтор),
/// другой — `DUPLICATE`.
async fn existing(db: &SqlitePool, j: Journal, user: &str, op_id: &[u8], ct: &[u8]) -> Result<Option<u64>, ErrorCode> {
    let row: Option<(i64, Vec<u8>)> = sqlx::query_as(&format!("SELECT seq, record FROM {} WHERE user = ? AND op_id = ?", j.log))
        .bind(user)
        .bind(op_id)
        .fetch_optional(db)
        .await
        .map_err(db_err)?;
    match row {
        Some((seq, rec)) if rec == ct => Ok(Some(seq as u64)),
        Some(_) => Err(ErrorCode::Duplicate),
        None => Ok(None),
    }
}

/// `state.ops.append`: дописать запись в журнал v2 пользователя, вернуть её seq.
pub(crate) async fn append_v2(db: &SqlitePool, user: &str, r: &s2pb::AppendRequest, limits: StateLimits) -> Result<u64, ErrorCode> {
    append_in(db, V2, user, &r.op_id, &r.aead_ciphertext, limits).await
}

async fn append_in(db: &SqlitePool, j: Journal, user: &str, op_id: &[u8], ct: &[u8], limits: StateLimits) -> Result<u64, ErrorCode> {
    if !parvane_protocol::sign::is_valid_op_id(op_id) {
        return Err(ErrorCode::Invalid);
    }
    // nonce ‖ шифртекст ‖ тег; верхняя граница — лимит схемы (decode_checked).
    if ct.len() < NONCE_LEN + TAG_LEN {
        return Err(ErrorCode::Invalid);
    }
    if let Some(seq) = existing(db, j, user, op_id, ct).await? {
        return Ok(seq);
    }
    let len = ct.len() as i64;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    // Сначала запись (блокировка на запись берётся сразу — без гонки чтение→запись).
    let (seq, records, bytes): (i64, i64, i64) = sqlx::query_as(&format!(
        "INSERT INTO {} (user, next_seq, records, bytes) VALUES (?, 1, 1, ?)
         ON CONFLICT(user) DO UPDATE SET next_seq = next_seq + 1, records = records + 1, bytes = bytes + excluded.bytes
         RETURNING next_seq, records, bytes",
        j.head
    ))
    .bind(user)
    .bind(len)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    if records > limits.max_records || bytes > limits.max_bytes {
        let _ = tx.rollback().await;
        return Err(ErrorCode::Limit);
    }
    let ins = sqlx::query(&format!("INSERT INTO {} (user, seq, op_id, record, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", j.log))
        .bind(user)
        .bind(seq)
        .bind(op_id)
        .bind(ct)
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    if ins.rows_affected() == 0 {
        // Параллельный повтор того же op_id успел раньше: seq не расходуется.
        let _ = tx.rollback().await;
        return existing(db, j, user, op_id, ct).await?.ok_or(ErrorCode::Duplicate);
    }
    tx.commit().await.map_err(db_err)?;
    Ok(seq as u64)
}

/// Страница журнала: записи с seq > after_seq, ≤ бюджета (хотя бы одна запись) → (записи, есть ли ещё).
async fn page(db: &SqlitePool, j: Journal, user: &str, after_seq: u64, max_bytes: u32) -> Result<(Vec<(u64, Vec<u8>, Vec<u8>)>, bool), ErrorCode> {
    let after = i64::try_from(after_seq).map_err(|_| ErrorCode::Invalid)?;
    let budget = if max_bytes == 0 { PAGE_BUDGET } else { (max_bytes as usize).min(PAGE_BUDGET) };
    let rows: Vec<(i64, Vec<u8>, Vec<u8>)> =
        sqlx::query_as(&format!("SELECT seq, op_id, record FROM {} WHERE user = ? AND seq > ? ORDER BY seq LIMIT ?", j.log))
            .bind(user)
            .bind(after)
            .bind(PAGE_ITEMS as i64 + 1)
            .fetch_all(db)
            .await
            .map_err(db_err)?;
    let mut out = Vec::new();
    let mut used = 0usize;
    for (seq, op_id, rec) in rows {
        // Размер записи страницы в кодировке StateRecord.
        let len = s2pb::StateRecord { seq: seq as u64, op_id: op_id.clone(), aead_ciphertext: rec.clone() }.encoded_len() + 4;
        if out.len() >= PAGE_ITEMS || (!out.is_empty() && used + len > budget) {
            return Ok((out, true));
        }
        used += len;
        out.push((seq as u64, op_id, rec));
    }
    Ok((out, false))
}

/// `state.ops.sync`: журнал v2.
pub(crate) async fn sync_v2(db: &SqlitePool, user: &str, r: &s2pb::SyncRequest) -> Result<s2pb::SyncResponse, ErrorCode> {
    let (rows, more) = page(db, V2, user, r.after_seq, r.max_bytes).await?;
    let records = rows.into_iter().map(|(seq, op_id, aead_ciphertext)| s2pb::StateRecord { seq, op_id, aead_ciphertext }).collect();
    Ok(s2pb::SyncResponse { records, more })
}

// ---------------------------------------------------------------------------
// Согласие на добавление в группы.

/// Разрешает ли настройка v2 добавлять пользователя в группы. «Контакты» —
/// как «никто»: сервер не знает контактов (они внутри E2E), в группу такой
/// пользователь попадает только сам, по ссылке.
pub(crate) fn v2_allows_group_add(p: &PrivacyOfResponse) -> Option<bool> {
    if !p.found {
        return None;
    }
    let everybody = matches!(i32::try_from(p.group_add).ok().and_then(|v| Audience::try_from(v).ok()), Some(Audience::Everybody | Audience::Unspecified));
    Some(everybody)
}

/// Настройка приватности из identity. Ok(None) — не выставлена через v2 или
/// v2-рантайм не поднят (юнит-тесты); ошибка связи — Err (отказ, не «разрешено»).
pub(crate) async fn privacy_group_add(user: &str) -> Result<Option<bool>> {
    let Some(ctx) = crate::v2::ctx() else { return Ok(None) };
    // Участник с другого сервера — настройка у его сервера (spec 028; связи нет — отказ)
    if let Some(domain) = crate::v2_fed::foreign_domain(user) {
        return Ok(v2_allows_group_add(&crate::v2_fed::privacy_remote(&ctx, user, &domain).await?));
    }
    let req = PrivacyOfRequest { user: user.to_string() }.encode_to_vec();
    let r = tokio::time::timeout(Duration::from_secs(3), ctx.nc.request(INTERNAL_PRIVACY_OF.to_string(), req.into()))
        .await
        .context("privacy_of: таймаут")?
        .context("privacy_of")?;
    let p = decode_checked::<PrivacyOfResponse>(&r.payload, Origin::Server).map_err(|e| anyhow::anyhow!("privacy_of: {e:?}"))?;
    Ok(v2_allows_group_add(&p))
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&pool).await.unwrap();
        pool
    }

    fn req(ct_len: usize, fill: u8) -> s2pb::AppendRequest {
        s2pb::AppendRequest { op_id: Uuid::now_v7().as_bytes().to_vec(), aead_ciphertext: vec![fill; ct_len] }
    }

    const BIG: StateLimits = StateLimits { max_records: 1000, max_bytes: 1 << 30 };

    #[tokio::test]
    async fn append_sync_per_user_and_idempotent() {
        let db = pool().await;
        let a1 = req(40, 1);
        assert_eq!(append_v2(&db, "a@local", &a1, BIG).await.unwrap(), 1);
        assert_eq!(append_v2(&db, "a@local", &req(40, 2), BIG).await.unwrap(), 2);
        assert_eq!(append_v2(&db, "b@local", &req(40, 3), BIG).await.unwrap(), 1, "seq — на пользователя");
        // повтор той же записи — тот же seq; тот же op_id с другим шифртекстом — DUPLICATE
        assert_eq!(append_v2(&db, "a@local", &a1, BIG).await.unwrap(), 1);
        let mut forged = a1.clone();
        forged.aead_ciphertext = vec![9; 40];
        assert_eq!(append_v2(&db, "a@local", &forged, BIG).await, Err(ErrorCode::Duplicate));
        assert_eq!(append_v2(&db, "a@local", &req(40, 4), BIG).await.unwrap(), 3, "seq не расходуется на отказы");
        let s = sync_v2(&db, "a@local", &s2pb::SyncRequest { after_seq: 1, max_bytes: 0 }).await.unwrap();
        assert_eq!(s.records.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert!(!s.more);
        let b = sync_v2(&db, "b@local", &s2pb::SyncRequest { after_seq: 0, max_bytes: 0 }).await.unwrap();
        assert_eq!(b.records.len(), 1);
        assert_eq!(b.records[0].aead_ciphertext, vec![3; 40]);
    }

    #[tokio::test]
    async fn append_rejects_bad_input_and_limits() {
        let db = pool().await;
        let mut bad = req(40, 1);
        bad.op_id = vec![1; 16];
        assert_eq!(append_v2(&db, "a@local", &bad, BIG).await, Err(ErrorCode::Invalid), "op_id не UUIDv7");
        assert_eq!(append_v2(&db, "a@local", &req(10, 1), BIG).await, Err(ErrorCode::Invalid), "короче nonce+тег");
        let lim = StateLimits { max_records: 2, max_bytes: 1 << 20 };
        append_v2(&db, "a@local", &req(40, 1), lim).await.unwrap();
        append_v2(&db, "a@local", &req(40, 1), lim).await.unwrap();
        assert_eq!(append_v2(&db, "a@local", &req(40, 1), lim).await, Err(ErrorCode::Limit));
        let lim = StateLimits { max_records: 100, max_bytes: 100 };
        append_v2(&db, "c@local", &req(60, 1), lim).await.unwrap();
        assert_eq!(append_v2(&db, "c@local", &req(60, 1), lim).await, Err(ErrorCode::Limit), "объём");
        assert_eq!(append_v2(&db, "c@local", &req(40, 1), lim).await.unwrap(), 2, "откат не сдвинул счётчики");
    }

    #[tokio::test]
    async fn sync_pages_by_budget() {
        let db = pool().await;
        for _ in 0..5 {
            append_v2(&db, "a@local", &req(1000, 7), BIG).await.unwrap();
        }
        let mut after = 0;
        let mut seen = vec![];
        loop {
            let s = sync_v2(&db, "a@local", &s2pb::SyncRequest { after_seq: after, max_bytes: 2100 }).await.unwrap();
            assert!(!s.records.is_empty());
            assert!(s.records.len() <= 2);
            after = s.records.last().unwrap().seq;
            seen.extend(s.records.iter().map(|r| r.seq));
            if !s.more {
                break;
            }
        }
        assert_eq!(seen, vec![1, 2, 3, 4, 5]);
        // Бюджет меньше записи — всё равно одна запись (клиент продвигается).
        let s = sync_v2(&db, "a@local", &s2pb::SyncRequest { after_seq: 0, max_bytes: 10 }).await.unwrap();
        assert_eq!(s.records.len(), 1);
        assert!(s.more);
        assert_eq!(sync_v2(&db, "a@local", &s2pb::SyncRequest { after_seq: u64::MAX, max_bytes: 0 }).await.err(), Some(ErrorCode::Invalid));
    }

    #[test]
    fn privacy_mapping() {
        let p = |found, g| PrivacyOfResponse { found, group_add: g, ..Default::default() };
        assert_eq!(v2_allows_group_add(&p(false, 3)), None, "не выставлено — решает блоб v1");
        assert_eq!(v2_allows_group_add(&p(true, 1)), Some(true));
        assert_eq!(v2_allows_group_add(&p(true, 2)), Some(false));
        assert_eq!(v2_allows_group_add(&p(true, 3)), Some(false));
        assert_eq!(v2_allows_group_add(&p(true, 0)), Some(true));
    }
}
