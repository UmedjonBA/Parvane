//! Смена ника (spec 026): `v2.internal.rename.messenger` от identity — строки прежнего адреса переходят к новому.
//! Повторный запрос (identity повторяет до ответа) ничего не меняет.

use std::sync::Arc;

use futures::StreamExt as _;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{RenameAck, RenameNotice};
use parvane_protocol::registry_gen::INTERNAL_RENAME_MESSENGER;
use prost::Message as _;
use tracing::{error, info};

use crate::v2::{device_key, V2};

pub(crate) async fn serve(ctx: Arc<V2>) {
    let mut sub = match ctx.nc.subscribe(INTERNAL_RENAME_MESSENGER.to_string()).await {
        Ok(s) => s,
        Err(e) => {
            error!("messenger v2: подписка {} не удалась: {}", INTERNAL_RENAME_MESSENGER, e);
            return;
        }
    };
    while let Some(msg) = sub.next().await {
        let Some(reply) = msg.reply.clone() else { continue };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let ok = match decode_checked::<RenameNotice>(&msg.payload, Origin::Server) {
                Ok(n) => match rename(&ctx, &n).await {
                    Ok(()) => true,
                    Err(e) => {
                        error!("messenger v2: перенос ника: {}", e);
                        false
                    }
                },
                Err(_) => false,
            };
            let _ = ctx.nc.publish(reply, RenameAck { ok }.encode_to_vec().into()).await;
        });
    }
}

/// Журналы инбокса устройств (ключ — из адреса и устройства), личное состояние, журнал истории, членство и заявки.
pub(crate) async fn rename(ctx: &V2, n: &RenameNotice) -> Result<(), sqlx::Error> {
    if n.purge {
        return purge(ctx, n).await;
    }
    rename_db(&ctx.v2, n).await?;
    ctx.forget_devices(&n.old_address);
    ctx.forget_devices(&n.new_address);
    ctx.groups.forget_key_owners();
    info!("messenger v2: ник перенесён ({} устройств)", n.device_ids.len());
    Ok(())
}

/// Перенос в базе (одна транзакция; без кэшей и шины — для тестов).
pub(crate) async fn rename_db(db: &sqlx::SqlitePool, n: &RenameNotice) -> Result<(), sqlx::Error> {
    let (old, new) = (n.old_address.as_str(), n.new_address.as_str());
    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
    for d in &n.device_ids {
        let (Ok(from), Ok(to)) = (device_key(old, d), device_key(new, d)) else { continue };
        merge_queue(&mut tx, "inbox_log", "device", "seq", "inbox_device", "device", &from, &to).await?;
    }
    // Журналы с UNIQUE(user, op_id) (S7-9): запись, повторённая после обрыва во время смены ника, могла лечь и под
    // прежним, и под новым адресом — копия под новым убирается, иначе перенос нарушал уникальность и откатывался
    // целиком (identity повторял его без успеха, строки оставались под прежним ником)
    drop_op_dups(&mut tx, "user_state_log", "user_state_head", old, new).await?;
    merge_queue(&mut tx, "user_state_log", "user", "seq", "user_state_head", "user", old, new).await?;
    // spec 035: журнал state.v2 — так же
    drop_op_dups(&mut tx, "user_state_log_v2", "user_state_head_v2", old, new).await?;
    merge_queue(&mut tx, "user_state_log_v2", "user", "seq", "user_state_head_v2", "user", old, new).await?;
    // Журнал истории (spec 033): записи прежнего адреса сохраняют seq — контрольная точка переходит вместе с ними
    drop_op_dups(&mut tx, "user_history_log", "user_history_head", old, new).await?;
    let old_next: Option<(i64,)> = sqlx::query_as("SELECT next_seq FROM user_history_head WHERE user = ?").bind(old).fetch_optional(&mut *tx).await?;
    merge_queue(&mut tx, "user_history_log", "user", "seq", "user_history_head", "user", old, new).await?;
    if sqlx::query("SELECT 1 FROM user_history_checkpoint WHERE user = ?").bind(old).fetch_optional(&mut *tx).await?.is_some() {
        sqlx::query("DELETE FROM user_history_checkpoint WHERE user = ?").bind(new).execute(&mut *tx).await?;
        sqlx::query("UPDATE user_history_checkpoint SET user = ? WHERE user = ?").bind(new).bind(old).execute(&mut *tx).await?;
    } else if let Some((shift,)) = old_next {
        // Точка была только у нового адреса: его записи сдвинулись на `shift` — точка вместе с ними (S7-9)
        shift_checkpoint(&mut tx, new, shift).await?;
    }
    for (table, column) in [("group_members_v2", "member"), ("group_join_requests_v2", "user"), ("public_join_points", "user")] {
        sqlx::query(&format!("UPDATE OR IGNORE {table} SET {column} = ? WHERE {column} = ?")).bind(new).bind(old).execute(&mut *tx).await?;
        sqlx::query(&format!("DELETE FROM {table} WHERE {column} = ?")).bind(old).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Убрать из журнала `to` записи с op_id, которые есть у `from` (та же операция), и поправить учёт объёма `to`.
async fn drop_op_dups(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, log: &str, head: &str, from: &str, to: &str) -> Result<(), sqlx::Error> {
    let (n, bytes): (i64, i64) = sqlx::query_as(&format!(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(record)), 0) FROM {log} WHERE user = ? AND op_id IN (SELECT op_id FROM {log} WHERE user = ?)"
    ))
    .bind(to)
    .bind(from)
    .fetch_one(&mut **tx)
    .await?;
    if n == 0 {
        return Ok(());
    }
    sqlx::query(&format!("DELETE FROM {log} WHERE user = ? AND op_id IN (SELECT op_id FROM {log} WHERE user = ?)")).bind(to).bind(from).execute(&mut **tx).await?;
    sqlx::query(&format!("UPDATE {head} SET records = MAX(records - ?, 0), bytes = MAX(bytes - ?, 0) WHERE user = ?"))
        .bind(n)
        .bind(bytes)
        .bind(to)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Сдвинуть номера контрольной точки `user` на `shift` (записи журнала сдвинуты [`merge_queue`]).
async fn shift_checkpoint(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, user: &str, shift: i64) -> Result<(), sqlx::Error> {
    let cp: Option<(i64, i64, Vec<u8>)> =
        sqlx::query_as("SELECT upto_seq, summary_seq, chunk_seqs FROM user_history_checkpoint WHERE user = ?").bind(user).fetch_optional(&mut **tx).await?;
    let Some((upto, summary, chunks)) = cp else { return Ok(()) };
    let (parts, _) = chunks.as_chunks::<8>();
    let shifted: Vec<u8> = parts.iter().flat_map(|c| (u64::from_be_bytes(*c).saturating_add(shift as u64)).to_be_bytes()).collect();
    sqlx::query("UPDATE user_history_checkpoint SET upto_seq = ?, summary_seq = ?, chunk_seqs = ? WHERE user = ?")
        .bind(upto + shift)
        .bind(summary + shift)
        .bind(shifted)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Очередь `from` переходит под ключ `to`. Если под `to` уже есть записи (доставка успела раньше переноса), они
/// встают после записей `from` — нумерация продолжается, ничего не теряется.
#[allow(clippy::too_many_arguments)]
async fn merge_queue(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    log: &str,
    log_key: &str,
    seq: &str,
    head: &str,
    head_key: &str,
    from: &str,
    to: &str,
) -> Result<(), sqlx::Error> {
    let old_next: Option<(i64,)> = sqlx::query_as(&format!("SELECT next_seq FROM {head} WHERE {head_key} = ?")).bind(from).fetch_optional(&mut **tx).await?;
    let Some((old_next,)) = old_next else { return Ok(()) };
    let new_head: Option<(i64, i64, i64)> =
        sqlx::query_as(&format!("SELECT next_seq, records, bytes FROM {head} WHERE {head_key} = ?")).bind(to).fetch_optional(&mut **tx).await?;
    // Записи нового ключа — к прежнему со сдвигом (ключи (from, seq + old_next) свободны)
    sqlx::query(&format!("UPDATE {log} SET {log_key} = ?, {seq} = {seq} + ? WHERE {log_key} = ?")).bind(from).bind(old_next).bind(to).execute(&mut **tx).await?;
    if let Some((next, records, bytes)) = new_head {
        sqlx::query(&format!("UPDATE {head} SET next_seq = next_seq + ?, records = records + ?, bytes = bytes + ? WHERE {head_key} = ?"))
            .bind(next)
            .bind(records)
            .bind(bytes)
            .bind(from)
            .execute(&mut **tx)
            .await?;
        sqlx::query(&format!("DELETE FROM {head} WHERE {head_key} = ?")).bind(to).execute(&mut **tx).await?;
    }
    sqlx::query(&format!("UPDATE {log} SET {log_key} = ? WHERE {log_key} = ?")).bind(to).bind(from).execute(&mut **tx).await?;
    sqlx::query(&format!("UPDATE {head} SET {head_key} = ? WHERE {head_key} = ?")).bind(to).bind(from).execute(&mut **tx).await?;
    Ok(())
}

/// Удаление аккаунта (spec 027): журналы инбокса устройств, личное состояние, журнал истории, заявки и точки публичных групп.
/// Членство в группах — запись их журналов (подписана), индекс участников не трогается: доставка удалённому
/// аккаунту уже не принимается (устройств у него нет).
async fn purge(ctx: &V2, n: &RenameNotice) -> Result<(), sqlx::Error> {
    let address = n.old_address.as_str();
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await?;
    for d in &n.device_ids {
        let Ok(key) = device_key(address, d) else { continue };
        sqlx::query("DELETE FROM inbox_log WHERE device = ?").bind(&key).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM inbox_device WHERE device = ?").bind(&key).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM user_state_log WHERE user = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM user_state_head WHERE user = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM user_state_log_v2 WHERE user = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM user_state_head_v2 WHERE user = ?").bind(address).execute(&mut *tx).await?;
    for table in ["user_history_log", "user_history_head", "user_history_checkpoint"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user = ?")).bind(address).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM group_join_requests_v2 WHERE user = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM public_join_points WHERE user = ?").bind(address).execute(&mut *tx).await?;
    tx.commit().await?;
    ctx.forget_devices(address);
    info!("messenger v2: аккаунт стёрт ({} устройств)", n.device_ids.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations_v2").run(&pool).await.unwrap();
        pool
    }

    async fn put(db: &sqlx::SqlitePool, user: &str, seq: i64, op: u8, chunk: bool) {
        sqlx::query("INSERT INTO user_history_log (user, seq, op_id, record, chunk, at) VALUES (?, ?, ?, ?, ?, 0)")
            .bind(user)
            .bind(seq)
            .bind(vec![op; 16])
            .bind(vec![op; 40])
            .bind(i64::from(chunk))
            .execute(db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO user_history_head (user, next_seq, records, bytes) VALUES (?, ?, 1, 40)
             ON CONFLICT(user) DO UPDATE SET next_seq = MAX(next_seq, excluded.next_seq), records = records + 1, bytes = bytes + 40",
        )
        .bind(user)
        .bind(seq)
        .execute(db)
        .await
        .unwrap();
    }

    fn notice() -> RenameNotice {
        RenameNotice { old_address: "al@x".into(), new_address: "alice@x".into(), device_ids: vec!["d1".into()], ..Default::default() }
    }

    /// S7-9: запись с тем же op_id под обоими адресами (повтор append во время смены ника) — перенос проходит.
    #[tokio::test]
    async fn rename_with_same_op_id_under_both_addresses() {
        let db = pool().await;
        put(&db, "al@x", 1, 1, false).await;
        put(&db, "al@x", 2, 2, false).await;
        put(&db, "alice@x", 1, 2, false).await; // тот же op_id 2 — повтор под новым адресом
        put(&db, "alice@x", 2, 3, false).await;
        // То же в журнале личного состояния
        for user in ["al@x", "alice@x"] {
            sqlx::query("INSERT INTO user_state_log (user, seq, op_id, record, at) VALUES (?, 1, ?, x'00', 0)").bind(user).bind(vec![7u8; 16]).execute(&db).await.unwrap();
            sqlx::query("INSERT INTO user_state_head (user, next_seq) VALUES (?, 1)").bind(user).execute(&db).await.unwrap();
        }
        rename_db(&db, &notice()).await.expect("перенос не откатывается");
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT seq, op_id FROM user_history_log WHERE user = 'alice@x' ORDER BY seq").fetch_all(&db).await.unwrap();
        assert_eq!(rows.iter().map(|(_, o)| o[0]).collect::<Vec<_>>(), vec![1, 2, 3], "копия op_id 2 убрана, остальное по порядку");
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM user_history_log WHERE user = 'al@x'").fetch_one(&db).await.unwrap();
        assert_eq!(n, 0);
        let (records,): (i64,) = sqlx::query_as("SELECT records FROM user_history_head WHERE user = 'alice@x'").fetch_one(&db).await.unwrap();
        assert_eq!(records, 3);
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM user_state_log WHERE user = 'alice@x'").fetch_one(&db).await.unwrap();
        assert_eq!(n, 1, "журнал состояния: копия убрана, перенос прошёл");
    }

    /// S7-9: точка была только у нового адреса — её номера сдвигаются вместе с его записями.
    #[tokio::test]
    async fn rename_shifts_checkpoint_of_new_address() {
        let db = pool().await;
        put(&db, "al@x", 1, 1, false).await;
        put(&db, "al@x", 2, 2, false).await;
        put(&db, "alice@x", 1, 3, true).await;
        put(&db, "alice@x", 2, 4, true).await;
        let chunks: Vec<u8> = [1u64].iter().flat_map(|s| s.to_be_bytes()).collect();
        sqlx::query("INSERT INTO user_history_checkpoint (user, id, upto_seq, summary_seq, chunk_seqs, created_ms) VALUES ('alice@x', 1, 2, 2, ?, 0)")
            .bind(chunks)
            .execute(&db)
            .await
            .unwrap();
        rename_db(&db, &notice()).await.unwrap();
        let (upto, summary, chunks): (i64, i64, Vec<u8>) =
            sqlx::query_as("SELECT upto_seq, summary_seq, chunk_seqs FROM user_history_checkpoint WHERE user = 'alice@x'").fetch_one(&db).await.unwrap();
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT seq, op_id FROM user_history_log WHERE user = 'alice@x' ORDER BY seq").fetch_all(&db).await.unwrap();
        let seq_of = |op: u8| rows.iter().find(|(_, o)| o[0] == op).map(|(s, _)| *s).unwrap();
        assert_eq!((upto, summary), (seq_of(4), seq_of(4)), "точка указывает на ту же сводку");
        assert_eq!(u64::from_be_bytes(chunks[..8].try_into().unwrap()) as i64, seq_of(3), "и на тот же сегмент");
    }
}
