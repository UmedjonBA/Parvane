//! Журнал истории аккаунта (spec 033; HIST-1, HIST-2, READ-2).
//!
//! `history.append` / `history.sync` / `history.head` / `history.get` / `history.checkpoint.commit`: журнал
//! `user_history_log` (миграции v2) хранит ТОЛЬКО шифртекст записи, её `op_id` и флаг `chunk` (сегмент или
//! сводка контрольной точки) — сообщения, удаления, правки, реакции, закрепы и маркеры прочтения зашифрованы
//! ключом истории (из ключа личного состояния), сведение делают устройства (`parvane_protocol::history`).
//! Журнал — на пользователя (общий для его устройств), `seq` монотонный и не переиспользуется.
//!
//! Повтор `op_id` с тем же шифртекстом и флагом — идемпотентен (тот же seq), с другим — `DUPLICATE`. Лимиты на
//! пользователя: `PARVANE_HISTORY_MAX_RECORDS` (500 000) и `PARVANE_HISTORY_MAX_BYTES` (512 МиБ), без записей,
//! удалённых точкой. Страница `sync`/`get` — байтовый бюджет ≤ 716 800, хотя бы одна запись.
//!
//! Контрольная точка (`history.checkpoint.commit`, CAS по id прежней точки): записи `seq ≤ upto_seq`, кроме
//! сегментов и сводки новой точки, удаляются в той же транзакции (сегменты прежней точки, не вошедшие в
//! новую, — тоже). `sync` с курсором до точки отдаёт точку (`compacted`) и записи только после неё.

use crate::*;
use parvane_protocol::history::{NONCE_LEN, TAG_LEN};
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::history::v1 as hpb;
use parvane_protocol::sync::PAGE_BUDGET;
use prost::Message as _;
use std::collections::BTreeSet;

/// Записей на страницу (`max_items` у `SyncResponse.records`).
const PAGE_ITEMS: usize = 1024;
/// Запрашиваемых записей в `history.get` (`max_items` у `GetRequest.seqs`).
const GET_ITEMS: usize = 256;
/// Сегментов точки (`max_items` у `CommitRequest.chunk_seqs`).
const MAX_CHUNKS: usize = 100_000;

/// Лимиты журнала истории на пользователя.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HistoryLimits {
    pub max_records: i64,
    pub max_bytes: i64,
}

impl HistoryLimits {
    pub(crate) fn from_env() -> Self {
        let get = |k: &str, d: i64| std::env::var(k).ok().and_then(|v| v.parse::<i64>().ok()).filter(|&n| n > 0).unwrap_or(d);
        HistoryLimits {
            max_records: get("PARVANE_HISTORY_MAX_RECORDS", 500_000),
            max_bytes: get("PARVANE_HISTORY_MAX_BYTES", 512 * 1024 * 1024),
        }
    }
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("messenger v2 history: {}", e);
    ErrorCode::Unavailable
}

fn to_i64(v: u64) -> Result<i64, ErrorCode> {
    i64::try_from(v).map_err(|_| ErrorCode::Invalid)
}

fn pack_seqs(seqs: &[u64]) -> Vec<u8> {
    seqs.iter().flat_map(|s| s.to_be_bytes()).collect()
}

fn unpack_seqs(b: &[u8]) -> Vec<u64> {
    let (chunks, _) = b.as_chunks::<8>();
    chunks.iter().map(|c| u64::from_be_bytes(*c)).collect()
}

/// Уже записанная операция с этим op_id: тот же шифртекст и флаг — её seq (повтор), другой — `DUPLICATE`.
async fn existing(db: &SqlitePool, user: &str, r: &hpb::AppendRequest) -> Result<Option<u64>, ErrorCode> {
    let row: Option<(i64, Vec<u8>, i64)> = sqlx::query_as("SELECT seq, record, chunk FROM user_history_log WHERE user = ? AND op_id = ?")
        .bind(user)
        .bind(&r.op_id)
        .fetch_optional(db)
        .await
        .map_err(db_err)?;
    match row {
        Some((seq, rec, chunk)) if rec == r.aead_ciphertext && (chunk != 0) == r.chunk => Ok(Some(seq as u64)),
        Some(_) => Err(ErrorCode::Duplicate),
        None => Ok(None),
    }
}

/// `history.append`: дописать запись в журнал пользователя, вернуть её seq.
#[cfg(test)]
pub(crate) async fn append(db: &SqlitePool, user: &str, r: &hpb::AppendRequest, limits: HistoryLimits) -> Result<u64, ErrorCode> {
    append_new(db, user, r, limits).await.map(|(seq, _)| seq)
}

/// `history.append`: seq записи и `true`, если она записана сейчас (не повтор) — уведомлять устройства.
pub(crate) async fn append_new(db: &SqlitePool, user: &str, r: &hpb::AppendRequest, limits: HistoryLimits) -> Result<(u64, bool), ErrorCode> {
    if !parvane_protocol::sign::is_valid_op_id(&r.op_id) {
        return Err(ErrorCode::Invalid);
    }
    // nonce ‖ шифртекст ‖ тег; верхняя граница — лимит схемы (decode_checked).
    if r.aead_ciphertext.len() < NONCE_LEN + TAG_LEN {
        return Err(ErrorCode::Invalid);
    }
    if let Some(seq) = existing(db, user, r).await? {
        return Ok((seq, false));
    }
    let len = r.aead_ciphertext.len() as i64;
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    let (seq, records, bytes): (i64, i64, i64) = sqlx::query_as(
        "INSERT INTO user_history_head (user, next_seq, records, bytes) VALUES (?, 1, 1, ?)
         ON CONFLICT(user) DO UPDATE SET next_seq = next_seq + 1, records = records + 1, bytes = bytes + excluded.bytes
         RETURNING next_seq, records, bytes",
    )
    .bind(user)
    .bind(len)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    if records > limits.max_records || bytes > limits.max_bytes {
        let _ = tx.rollback().await;
        return Err(ErrorCode::Limit);
    }
    let ins = sqlx::query("INSERT INTO user_history_log (user, seq, op_id, record, chunk, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(user)
        .bind(seq)
        .bind(&r.op_id)
        .bind(&r.aead_ciphertext)
        .bind(i64::from(r.chunk))
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    if ins.rows_affected() == 0 {
        // Параллельный повтор того же op_id успел раньше: seq не расходуется.
        let _ = tx.rollback().await;
        return existing(db, user, r).await?.map(|s| (s, false)).ok_or(ErrorCode::Duplicate);
    }
    tx.commit().await.map_err(db_err)?;
    Ok((seq as u64, true))
}

async fn head_seq(db: &SqlitePool, user: &str) -> Result<u64, ErrorCode> {
    let r: Option<(i64,)> = sqlx::query_as("SELECT next_seq FROM user_history_head WHERE user = ?").bind(user).fetch_optional(db).await.map_err(db_err)?;
    Ok(r.map_or(0, |(s,)| s.max(0) as u64))
}

async fn checkpoint(db: &SqlitePool, user: &str) -> Result<Option<hpb::Checkpoint>, ErrorCode> {
    let r: Option<(i64, i64, i64, Vec<u8>, i64)> =
        sqlx::query_as("SELECT id, upto_seq, summary_seq, chunk_seqs, created_ms FROM user_history_checkpoint WHERE user = ?")
            .bind(user)
            .fetch_optional(db)
            .await
            .map_err(db_err)?;
    Ok(r.map(|(id, upto, summary, chunks, created)| hpb::Checkpoint {
        id: id as u64,
        upto_seq: upto as u64,
        summary_seq: summary as u64,
        chunk_seqs: unpack_seqs(&chunks),
        created_ms: created,
    }))
}

/// `history.sync`: записи с seq > after_seq (без сегментов при `skip_chunks`), страница ≤ бюджета. Курсор до
/// текущей точки — точка в `compacted` и записи только после `upto_seq`.
pub(crate) async fn sync(db: &SqlitePool, user: &str, r: &hpb::SyncRequest) -> Result<hpb::SyncResponse, ErrorCode> {
    let mut after = to_i64(r.after_seq)?;
    let budget = if r.max_bytes == 0 { PAGE_BUDGET } else { (r.max_bytes as usize).min(PAGE_BUDGET) };
    let head = head_seq(db, user).await?;
    let mut compacted = None;
    if let Some(cp) = checkpoint(db, user).await? {
        if r.after_seq < cp.upto_seq {
            after = to_i64(cp.upto_seq)?;
            compacted = Some(cp);
        }
    }
    let sql = if r.skip_chunks {
        "SELECT seq, op_id, record, chunk FROM user_history_log WHERE user = ? AND seq > ? AND chunk = 0 ORDER BY seq LIMIT ?"
    } else {
        "SELECT seq, op_id, record, chunk FROM user_history_log WHERE user = ? AND seq > ? ORDER BY seq LIMIT ?"
    };
    let rows: Vec<(i64, Vec<u8>, Vec<u8>, i64)> =
        sqlx::query_as(sql).bind(user).bind(after).bind(PAGE_ITEMS as i64 + 1).fetch_all(db).await.map_err(db_err)?;
    let mut records = Vec::new();
    let mut used = 0usize;
    let mut more = false;
    for (seq, op_id, rec, chunk) in rows {
        let r = hpb::HistoryRecord { seq: seq as u64, op_id, aead_ciphertext: rec, chunk: chunk != 0 };
        let len = r.encoded_len() + 4;
        if records.len() >= PAGE_ITEMS || (!records.is_empty() && used + len > budget) {
            more = true;
            break;
        }
        used += len;
        records.push(r);
    }
    Ok(hpb::SyncResponse { records, more, head_seq: head, compacted })
}

/// `history.head`: номер последней записи и текущая точка.
pub(crate) async fn head(db: &SqlitePool, user: &str) -> Result<hpb::HeadResponse, ErrorCode> {
    Ok(hpb::HeadResponse { head_seq: head_seq(db, user).await?, checkpoint: checkpoint(db, user).await? })
}

/// `history.get`: записи по номерам (только свои; нет — пропускаются), в порядке запроса, страница ≤ бюджета
/// (хотя бы одна запись; не поместившиеся клиент запрашивает снова).
pub(crate) async fn get(db: &SqlitePool, user: &str, r: &hpb::GetRequest) -> Result<hpb::GetResponse, ErrorCode> {
    if r.seqs.len() > GET_ITEMS {
        return Err(ErrorCode::Invalid);
    }
    let mut seen = BTreeSet::new();
    let mut records = Vec::new();
    let mut used = 0usize;
    for &seq in &r.seqs {
        if !seen.insert(seq) {
            continue;
        }
        let row: Option<(Vec<u8>, Vec<u8>, i64)> = sqlx::query_as("SELECT op_id, record, chunk FROM user_history_log WHERE user = ? AND seq = ?")
            .bind(user)
            .bind(to_i64(seq)?)
            .fetch_optional(db)
            .await
            .map_err(db_err)?;
        let Some((op_id, rec, chunk)) = row else { continue };
        let x = hpb::HistoryRecord { seq, op_id, aead_ciphertext: rec, chunk: chunk != 0 };
        let len = x.encoded_len() + 4;
        if !records.is_empty() && used + len > PAGE_BUDGET {
            break;
        }
        used += len;
        records.push(x);
    }
    Ok(hpb::GetResponse { records })
}

/// `history.checkpoint.commit`: CAS по id текущей точки (0 — точки нет); `summary_seq` и `chunk_seqs` —
/// записи-сегменты этого пользователя не дальше `upto_seq`; `upto_seq` — не дальше головы и не раньше прежней
/// точки. Отказ CAS — `DUPLICATE` (точку уже сменило другое устройство).
pub(crate) async fn commit(db: &SqlitePool, user: &str, r: &hpb::CommitRequest) -> Result<hpb::CommitResponse, ErrorCode> {
    if r.chunk_seqs.len() > MAX_CHUNKS || r.summary_seq == 0 || r.summary_seq > r.upto_seq {
        return Err(ErrorCode::Invalid);
    }
    let upto = to_i64(r.upto_seq)?;
    let mut keep: BTreeSet<u64> = r.chunk_seqs.iter().copied().collect();
    keep.insert(r.summary_seq);
    if keep.iter().any(|&s| s == 0 || s > r.upto_seq) {
        return Err(ErrorCode::Invalid);
    }
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    let cur: Option<(i64, i64)> =
        sqlx::query_as("SELECT id, upto_seq FROM user_history_checkpoint WHERE user = ?").bind(user).fetch_optional(&mut *tx).await.map_err(db_err)?;
    let (cur_id, cur_upto) = cur.map_or((0, 0), |(i, u)| (i as u64, u as u64));
    if cur_id != r.expected_checkpoint_id {
        let _ = tx.rollback().await;
        return Err(ErrorCode::Duplicate);
    }
    let head: Option<(i64,)> = sqlx::query_as("SELECT next_seq FROM user_history_head WHERE user = ?").bind(user).fetch_optional(&mut *tx).await.map_err(db_err)?;
    let head = head.map_or(0, |(h,)| h.max(0) as u64);
    if r.upto_seq > head || r.upto_seq < cur_upto {
        let _ = tx.rollback().await;
        return Err(ErrorCode::Invalid);
    }
    // Сегменты и сводка — существующие записи-сегменты пользователя.
    let chunks: Vec<(i64,)> = sqlx::query_as("SELECT seq FROM user_history_log WHERE user = ? AND chunk = 1 AND seq <= ?")
        .bind(user)
        .bind(upto)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
    let have: BTreeSet<u64> = chunks.into_iter().map(|(s,)| s as u64).collect();
    if !keep.iter().all(|s| have.contains(s)) {
        let _ = tx.rollback().await;
        return Err(ErrorCode::Invalid);
    }
    // Удалить всё ≤ upto, кроме сохраняемых: диапазонами между ними.
    let mut prev = 0u64;
    for &k in keep.iter().chain(std::iter::once(&(r.upto_seq + 1))) {
        if k > prev + 1 {
            sqlx::query("DELETE FROM user_history_log WHERE user = ? AND seq > ? AND seq < ?")
                .bind(user)
                .bind(to_i64(prev)?)
                .bind(to_i64(k)?)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
        prev = k;
    }
    let id = cur_id + 1;
    let chunk_seqs: Vec<u64> = keep.iter().copied().filter(|s| *s != r.summary_seq || r.chunk_seqs.contains(s)).collect();
    sqlx::query(
        "INSERT INTO user_history_checkpoint (user, id, upto_seq, summary_seq, chunk_seqs, created_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user) DO UPDATE SET id = excluded.id, upto_seq = excluded.upto_seq, summary_seq = excluded.summary_seq,
         chunk_seqs = excluded.chunk_seqs, created_ms = excluded.created_ms",
    )
    .bind(user)
    .bind(to_i64(id)?)
    .bind(upto)
    .bind(to_i64(r.summary_seq)?)
    .bind(pack_seqs(&chunk_seqs))
    .bind(now_unix().saturating_mul(1000))
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    // Учёт объёма — по оставшимся записям.
    let (records, bytes): (i64, i64) = sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM user_history_log WHERE user = ?")
        .bind(user)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("UPDATE user_history_head SET records = ?, bytes = ? WHERE user = ?")
        .bind(records)
        .bind(bytes)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    info!("messenger v2 history: точка {} (до seq {}, сегментов {})", id, r.upto_seq, chunk_seqs.len());
    Ok(hpb::CommitResponse { checkpoint_id: id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&pool).await.unwrap();
        pool
    }

    fn req(ct_len: usize, fill: u8, chunk: bool) -> hpb::AppendRequest {
        hpb::AppendRequest { op_id: Uuid::now_v7().as_bytes().to_vec(), aead_ciphertext: vec![fill; ct_len], chunk }
    }

    const BIG: HistoryLimits = HistoryLimits { max_records: 1000, max_bytes: 1 << 30 };

    fn seqs(r: &hpb::SyncResponse) -> Vec<u64> {
        r.records.iter().map(|x| x.seq).collect()
    }

    async fn s(db: &SqlitePool, user: &str, after: u64, skip: bool) -> hpb::SyncResponse {
        sync(db, user, &hpb::SyncRequest { after_seq: after, max_bytes: 0, skip_chunks: skip }).await.unwrap()
    }

    #[tokio::test]
    async fn append_idempotent_per_user() {
        let db = pool().await;
        let a1 = req(40, 1, false);
        assert_eq!(append(&db, "a@x", &a1, BIG).await.unwrap(), 1);
        assert_eq!(append(&db, "a@x", &req(40, 2, true), BIG).await.unwrap(), 2);
        assert_eq!(append(&db, "b@x", &req(40, 3, false), BIG).await.unwrap(), 1, "seq — на пользователя");
        assert_eq!(append(&db, "a@x", &a1, BIG).await.unwrap(), 1, "повтор — тот же seq");
        let mut flipped = a1.clone();
        flipped.chunk = true;
        assert_eq!(append(&db, "a@x", &flipped, BIG).await, Err(ErrorCode::Duplicate), "тот же op_id с другим chunk");
        let mut forged = a1.clone();
        forged.aead_ciphertext = vec![9; 40];
        assert_eq!(append(&db, "a@x", &forged, BIG).await, Err(ErrorCode::Duplicate));
        let mut bad = req(40, 1, false);
        bad.op_id = vec![1; 16];
        assert_eq!(append(&db, "a@x", &bad, BIG).await, Err(ErrorCode::Invalid));
        assert_eq!(append(&db, "a@x", &req(10, 1, false), BIG).await, Err(ErrorCode::Invalid), "короче nonce+тег");
        let r = s(&db, "a@x", 0, false).await;
        assert_eq!((seqs(&r), r.head_seq, r.more), (vec![1, 2], 2, false));
        assert!(r.records[1].chunk && !r.records[0].chunk);
        assert_eq!(seqs(&s(&db, "a@x", 0, true).await), vec![1], "без сегментов");
        assert_eq!(seqs(&s(&db, "b@x", 0, false).await), vec![1]);
        let h = head(&db, "nobody@x").await.unwrap();
        assert_eq!((h.head_seq, h.checkpoint), (0, None));
    }

    #[tokio::test]
    async fn limits_and_budget() {
        let db = pool().await;
        let lim = HistoryLimits { max_records: 2, max_bytes: 1 << 20 };
        append(&db, "a@x", &req(40, 1, false), lim).await.unwrap();
        append(&db, "a@x", &req(40, 1, false), lim).await.unwrap();
        assert_eq!(append(&db, "a@x", &req(40, 1, false), lim).await, Err(ErrorCode::Limit));
        let lim = HistoryLimits { max_records: 100, max_bytes: 100 };
        append(&db, "c@x", &req(60, 1, false), lim).await.unwrap();
        assert_eq!(append(&db, "c@x", &req(60, 1, false), lim).await, Err(ErrorCode::Limit), "объём");
        assert_eq!(append(&db, "c@x", &req(40, 1, false), lim).await.unwrap(), 2, "откат не сдвинул счётчики");
        for _ in 0..5 {
            append(&db, "d@x", &req(1000, 7, false), BIG).await.unwrap();
        }
        let r = sync(&db, "d@x", &hpb::SyncRequest { after_seq: 0, max_bytes: 2100, skip_chunks: false }).await.unwrap();
        assert!(r.records.len() == 2 && r.more && r.head_seq == 5);
        let r = sync(&db, "d@x", &hpb::SyncRequest { after_seq: 0, max_bytes: 10, skip_chunks: false }).await.unwrap();
        assert_eq!((r.records.len(), r.more), (1, true), "хотя бы одна запись");
        assert_eq!(sync(&db, "d@x", &hpb::SyncRequest { after_seq: u64::MAX, max_bytes: 0, skip_chunks: false }).await.err(), Some(ErrorCode::Invalid));
        // get: только свои, в порядке запроса, без повторов
        let g = get(&db, "d@x", &hpb::GetRequest { seqs: vec![3, 1, 3, 99] }).await.unwrap();
        assert_eq!(g.records.iter().map(|x| x.seq).collect::<Vec<_>>(), vec![3, 1]);
        assert!(get(&db, "a@x", &hpb::GetRequest { seqs: vec![5] }).await.unwrap().records.is_empty(), "чужие записи не отдаются");
        assert_eq!(get(&db, "d@x", &hpb::GetRequest { seqs: (0..257).collect() }).await.err(), Some(ErrorCode::Invalid));
    }

    #[tokio::test]
    async fn checkpoint_cas_trim_and_compacted() {
        let db = pool().await;
        let u = "a@x";
        // 1..3 — события, 4,5 — сегменты, 6 — сводка, 7 — событие после точки
        for chunk in [false, false, false, true, true, true, false] {
            append(&db, u, &req(40, 1, chunk), BIG).await.unwrap();
        }
        let c = |expected, upto, summary, chunks: Vec<u64>| hpb::CommitRequest { expected_checkpoint_id: expected, upto_seq: upto, summary_seq: summary, chunk_seqs: chunks };
        assert_eq!(commit(&db, u, &c(0, 6, 3, vec![4, 5])).await.err(), Some(ErrorCode::Invalid), "сводка — не сегмент");
        assert_eq!(commit(&db, u, &c(0, 6, 6, vec![2])).await.err(), Some(ErrorCode::Invalid), "сегмент — не сегмент");
        assert_eq!(commit(&db, u, &c(0, 9, 6, vec![4, 5])).await.err(), Some(ErrorCode::Invalid), "дальше головы");
        assert_eq!(commit(&db, u, &c(0, 6, 6, vec![4, 5, 7])).await.err(), Some(ErrorCode::Invalid), "сегмент после точки");
        assert_eq!(commit(&db, u, &c(1, 6, 6, vec![4, 5])).await.err(), Some(ErrorCode::Duplicate), "CAS");
        assert_eq!(commit(&db, u, &c(0, 6, 6, vec![4, 5])).await.unwrap().checkpoint_id, 1);
        assert_eq!(commit(&db, u, &c(0, 6, 6, vec![4, 5])).await.err(), Some(ErrorCode::Duplicate), "повтор CAS");
        // Обрезка: 1..3 удалены
        let all = s(&db, u, 6, false).await;
        assert_eq!(seqs(&all), vec![7]);
        let r = s(&db, u, 0, false).await;
        let cp = r.compacted.clone().unwrap();
        assert_eq!((cp.id, cp.upto_seq, cp.summary_seq, cp.chunk_seqs.clone()), (1, 6, 6, vec![4, 5]));
        assert_eq!(seqs(&r), vec![7], "курсор до точки — только после неё");
        let r = s(&db, u, 6, false).await;
        assert!(r.compacted.is_none());
        let g = get(&db, u, &hpb::GetRequest { seqs: vec![1, 4, 5, 6] }).await.unwrap();
        assert_eq!(g.records.iter().map(|x| x.seq).collect::<Vec<_>>(), vec![4, 5, 6]);
        let h = head(&db, u).await.unwrap();
        assert_eq!((h.head_seq, h.checkpoint.map(|c| c.id)), (7, Some(1)));
        // Новая точка: сегмент 5 переходит, 4 выпадает, новый сегмент 8, сводка 9
        append(&db, u, &req(40, 1, true), BIG).await.unwrap();
        append(&db, u, &req(40, 1, true), BIG).await.unwrap();
        assert_eq!(commit(&db, u, &c(1, 5, 6, vec![5])).await.err(), Some(ErrorCode::Invalid), "точка не отступает");
        assert_eq!(commit(&db, u, &c(1, 9, 9, vec![5, 8])).await.unwrap().checkpoint_id, 2);
        let g = get(&db, u, &hpb::GetRequest { seqs: vec![4, 5, 6, 7, 8, 9] }).await.unwrap();
        assert_eq!(g.records.iter().map(|x| x.seq).collect::<Vec<_>>(), vec![5, 8, 9]);
        // Счётчики объёма — по оставшимся; seq не переиспользуется
        let (records,): (i64,) = sqlx::query_as("SELECT records FROM user_history_head WHERE user = ?").bind(u).fetch_one(&db).await.unwrap();
        assert_eq!(records, 3);
        assert_eq!(append(&db, u, &req(40, 1, false), BIG).await.unwrap(), 10);
        assert_eq!(unpack_seqs(&pack_seqs(&[1, u64::MAX])), vec![1, u64::MAX]);
    }
}
