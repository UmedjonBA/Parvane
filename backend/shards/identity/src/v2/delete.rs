//! Удаление аккаунта (spec 027): `identity.account.delete`, отсрочка 7 дней, стирание строк во всех шардах.
//!
//! Запрос (свежий пароль) ставит аккаунт в очередь: все токены сразу недействительны, сессии закрываются, для
//! других аккаунт исчезает (журнал устройств и бандлы пусты, профиля и поиска нет, доставка не принимается), синк
//! журнала отвечает `deleted`. Вход паролем с `cancel_deletion` до срока снимает удаление. По сроку identity стирает
//! свои строки и просит шарды стереть их (`v2.internal.rename.<шард>` с `purge`, повтор до ответа — как перенос
//! ника), ник свободен; признак `deleted` держится, пока ник не займёт новый аккаунт.

use super::*;
use rename::{V1_TABLES, V2_TABLES};

/// Срок до окончательного стирания.
pub(crate) const DELETE_DELAY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Срок до стирания; `PARVANE_ACCOUNT_DELETE_DELAY_MS` — только для живых тестов.
fn delete_delay_ms() -> i64 {
    env_u64("PARVANE_ACCOUNT_DELETE_DELAY_MS", DELETE_DELAY_MS as u64) as i64
}

fn now_ms() -> i64 {
    now_unix() * 1000
}

/// Когда будет стёрт аккаунт, ждущий удаления (`None` — не ждёт).
pub(crate) async fn pending_until(pool: &SqlitePool, address: &str) -> Option<i64> {
    sqlx::query_as::<_, (i64,)>("SELECT purge_at_ms FROM account_deletions WHERE address = ?")
        .bind(address)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(t,)| t)
}

/// Аккаунт ждёт удаления — для проверки токенов из v1-кода.
pub(crate) async fn deletion_pending(address: &str) -> bool {
    let Some(pool) = V2_POOL.get() else { return false };
    pending_until(pool, address).await.is_some()
}

/// Для собеседников аккаунта нет: ждёт удаления либо стёрт, а ник ещё никто не занял.
pub(crate) async fn shown_deleted(pool: &SqlitePool, address: &str) -> bool {
    if pending_until(pool, address).await.is_some() {
        return true;
    }
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM deleted_accounts d WHERE d.address = ? AND NOT EXISTS (SELECT 1 FROM device_log l WHERE l.user = d.address)",
    )
    .bind(address)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    row.is_some()
}

pub(crate) async fn account_delete(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_user(req)?;
    if !req.reauth_fresh {
        return Err(ErrorCode::ReauthRequired);
    }
    let address = req.user.clone();
    if let Some(at) = pending_until(&ctx.v2, &address).await {
        return Ok(pb::AccountDeleteResponse { deletion_at_ms: at }.encode_to_vec());
    }
    let log = load_log(ctx, &address).await?;
    let devices: Vec<String> = log.devices.keys().chain(log.revoked.iter()).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let at = now_ms() + delete_delay_ms();
    sqlx::query("INSERT OR IGNORE INTO account_deletions (address, requested_ms, purge_at_ms, device_ids) VALUES (?, ?, ?, ?)")
        .bind(&address)
        .bind(now_ms())
        .bind(at)
        .bind(devices.join(","))
        .execute(&ctx.v2)
        .await
        .map_err(db_err)?;
    info!("identity: аккаунт ждёт удаления ({} устройств)", devices.len());
    // Сессии закрываются после ответа (иначе ответ на этот запрос не дошёл бы); пустой `device_id` — адрес
    // выведен из обращения (gateway освобождает его каналы присутствия)
    let nc = ctx.nc.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        for d in devices.into_iter().chain(std::iter::once(String::new())) {
            let n = RevokedNotice { user: address.clone(), device_id: d };
            if let Err(e) = nc.publish(REVOKED_SUBJECT.to_string(), n.encode_to_vec().into()).await {
                warn!("identity: сессии удаляемого аккаунта не закрыты: {}", e);
            }
        }
    });
    Ok(pb::AccountDeleteResponse { deletion_at_ms: at }.encode_to_vec())
}

/// Вход паролем с `cancel_deletion`: удаление снято.
pub(crate) async fn cancel(pool: &SqlitePool, address: &str) -> Result<(), ErrorCode> {
    sqlx::query("DELETE FROM account_deletions WHERE address = ?").bind(address).execute(pool).await.map_err(db_err)?;
    info!("identity: удаление аккаунта отменено входом");
    Ok(())
}

/// Раз в минуту (из `rename::spawn_upkeep`): аккаунты, чей срок вышел, — стереть.
pub(crate) async fn purge_due(nc: &async_nats::Client, pool: &SqlitePool, v1: &SqlitePool) {
    let due: Vec<(String, String)> = match sqlx::query_as("SELECT address, device_ids FROM account_deletions WHERE purge_at_ms <= ? LIMIT 32")
        .bind(now_ms())
        .fetch_all(pool)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!("identity: аккаунты к удалению: {}", e);
            return;
        }
    };
    for (address, ids) in due {
        match purge(pool, v1, &address, &ids).await {
            Ok(()) => {
                info!("identity: аккаунт стёрт");
                announce_gone(nc, &address);
            }
            Err(e) => error!("identity: стирание аккаунта: {} — повтор позже", e),
        }
    }
}

/// Федерация (spec 028): серверам, с которыми есть связь, — «адрес удалён» (рассылает шард federation по
/// своей очереди; федерация выключена или шарда нет — ничего).
fn announce_gone(nc: &async_nats::Client, address: &str) {
    use parvane_protocol::pb::parvane::core::v2::{federation_out, FederationOut, S2sAccountGone, UserRef};
    use prost::Message as _;
    let out = FederationOut {
        dest_domain: String::new(),
        timeout_ms: 0,
        kind: Some(federation_out::Kind::AccountGone(S2sAccountGone { user: Some(UserRef { address: address.to_string() }) })),
    };
    let nc = nc.clone();
    tokio::spawn(async move {
        let fut = nc.request(parvane_protocol::registry_gen::FEDERATION_OUT.to_string(), out.encode_to_vec().into());
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), fut).await;
    });
}

/// Стереть строки аккаунта в identity и поставить в очередь стирание в шардах. Повторяемо: v1 стирается первым,
/// очередь удаления снимается последней транзакцией v2.
pub(crate) async fn purge(pool: &SqlitePool, v1: &SqlitePool, address: &str, device_ids: &str) -> Result<(), sqlx::Error> {
    let mut tx = v1.begin().await?;
    for t in V1_TABLES {
        sqlx::query(&format!("DELETE FROM {t} WHERE username = ?")).bind(address).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM users WHERE username = ?").bind(address).execute(&mut *tx).await?;
    tx.commit().await?;

    let now = now_ms();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    for t in ["device_log", "device_log_archive", "device_state", "root_backup", "root_escrow"].iter().chain(V2_TABLES) {
        sqlx::query(&format!("DELETE FROM {t} WHERE user = ?")).bind(address).execute(&mut *tx).await?;
    }
    // Прежние ники аккаунта освобождаются вместе с ним
    sqlx::query("DELETE FROM account_aliases WHERE new_address = ?").bind(address).execute(&mut *tx).await?;
    for (shard, _) in rename::FANOUT {
        sqlx::query("INSERT OR REPLACE INTO rename_fanout (old_address, new_address, shard, device_ids, created_ms) VALUES (?, '', ?, ?, ?)")
            .bind(address)
            .bind(shard)
            .bind(device_ids)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT OR REPLACE INTO deleted_accounts (address, deleted_ms) VALUES (?, ?)").bind(address).bind(now).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM account_deletions WHERE address = ?").bind(address).execute(&mut *tx).await?;
    tx.commit().await
}
