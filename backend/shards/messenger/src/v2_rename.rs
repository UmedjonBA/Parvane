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

/// Журналы инбокса устройств (ключ — из адреса и устройства), личное состояние, членство и заявки.
pub(crate) async fn rename(ctx: &V2, n: &RenameNotice) -> Result<(), sqlx::Error> {
    let (old, new) = (n.old_address.as_str(), n.new_address.as_str());
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await?;
    for d in &n.device_ids {
        let (Ok(from), Ok(to)) = (device_key(old, d), device_key(new, d)) else { continue };
        merge_queue(&mut tx, "inbox_log", "device", "seq", "inbox_device", "device", &from, &to).await?;
    }
    merge_queue(&mut tx, "user_state_log", "user", "seq", "user_state_head", "user", old, new).await?;
    for (table, column) in [("group_members_v2", "member"), ("group_join_requests_v2", "user"), ("public_join_points", "user")] {
        sqlx::query(&format!("UPDATE OR IGNORE {table} SET {column} = ? WHERE {column} = ?")).bind(new).bind(old).execute(&mut *tx).await?;
        sqlx::query(&format!("DELETE FROM {table} WHERE {column} = ?")).bind(old).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    ctx.forget_devices(old);
    ctx.forget_devices(new);
    ctx.groups.forget_key_owners();
    info!("messenger v2: ник перенесён ({} устройств)", n.device_ids.len());
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
