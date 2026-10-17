//! Смена ника (spec 026): `identity.account.rename`, переадресация прежнего ника, перенос строк в шардах.
//!
//! Личность — корень; адрес — её имя. Клиент присылает запись `Rename` журнала прежнего адреса (подпись корнем)
//! и журнал нового адреса (генезис с тем же корнем и `renamed_from`, сертификат своего устройства). Сервер
//! проверяет обе цепочки тем же движком, переносит строки аккаунта на новый адрес и 30 дней ведёт прежний ник на
//! новый: вход, доставка и сведения о прежнем адресе. Выданные прежнему адресу токены недействительны.

use super::*;
use parvane_protocol::pb::parvane::core::v2::{RenameAck, RenameNotice};
use parvane_protocol::registry_gen::{INTERNAL_RENAME_CLOUD, INTERNAL_RENAME_DOMAINS, INTERNAL_RENAME_MESSENGER, INTERNAL_RENAME_PUSH};

/// Сколько прежний ник ведёт на новый (и занят).
pub(crate) const ALIAS_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Шарды со строками по адресу: subject переноса.
pub(crate) const FANOUT: &[(&str, &str)] = &[
    ("messenger", INTERNAL_RENAME_MESSENGER),
    ("domains", INTERNAL_RENAME_DOMAINS),
    ("cloud", INTERNAL_RENAME_CLOUD),
    ("push", INTERNAL_RENAME_PUSH),
];
/// Таблицы v1-хранилища со столбцом `username`.
pub(crate) const V1_TABLES: &[&str] = &[
    "device_keys",
    "one_time_prekeys",
    "email_codes",
    "link_offers",
    "link_grants",
    "revoked_devices",
    "telegram_links",
    "login_links",
    "trusted_devices",
    "device_labels",
];
/// Таблицы v2-хранилища со столбцом `user`, переходящие к новому адресу целиком.
pub(crate) const V2_TABLES: &[&str] = &["one_time_keys", "fallback_keys", "delivery_keys", "privacy", "token_issuance", "device_key_claims"];

fn now_ms() -> i64 {
    now_unix() * 1000
}

/// Куда ведёт прежний ник (действующая переадресация), `None` — не прежний ник.
pub(crate) async fn alias_target(pool: &SqlitePool, address: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>("SELECT new_address FROM account_aliases WHERE old_address = ? AND until_ms > ?")
        .bind(address)
        .bind(now_ms())
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|(n,)| n)
}

/// Адрес аккаунта: прежний ник (действующая переадресация) → новый, иначе как есть.
pub(crate) async fn canonical_address(pool: &SqlitePool, address: &str) -> String {
    alias_target(pool, address).await.unwrap_or_else(|| address.to_string())
}

/// Прежние адреса аккаунта (действующие переадресации на него).
pub(crate) async fn former_addresses(pool: &SqlitePool, address: &str) -> Vec<String> {
    sqlx::query_as::<_, (String,)>("SELECT old_address FROM account_aliases WHERE new_address = ? AND until_ms > ? LIMIT 16")
        .bind(address)
        .bind(now_ms())
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(a,)| a)
        .collect()
}

/// Ник занят переадресацией (прежний ник чужого аккаунта) — регистрация и смена ника его не получают.
pub(crate) async fn alias_held(address: &str) -> bool {
    let Some(pool) = V2_POOL.get() else { return false };
    alias_target(pool, address).await.is_some()
}

pub(crate) async fn account_rename(ctx: &V2Ctx, req: &ShardRequest, r: pb::AccountRenameRequest) -> Reply {
    require_user(req)?;
    if !req.reauth_fresh {
        return Err(ErrorCode::ReauthRequired);
    }
    let old = req.user.clone();
    let domain = server_domain();
    let nick = r.new_login.trim();
    if !valid_nick(nick) {
        return Err(ErrorCode::Invalid);
    }
    let new = format!("{nick}@{domain}");
    if new == old || validate_new_user(&new, &domain).is_err() {
        return Err(ErrorCode::Invalid);
    }
    // Ник свободен: не чужой аккаунт, не публичная группа, не прежний ник другого аккаунта (свой прежний — можно
    // вернуть: переадресация на себя снимается)
    let taken: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM users WHERE username = ?").bind(&new).fetch_optional(&ctx.pool).await.map_err(db_err)?;
    if taken.is_some() || public_name_taken(nick).await {
        return Err(ErrorCode::Duplicate);
    }
    let held = alias_target(&ctx.v2, &new).await;
    if held.as_deref().is_some_and(|to| to != old) {
        return Err(ErrorCode::Duplicate);
    }
    let rows: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM device_log WHERE user = ? LIMIT 1").bind(&new).fetch_optional(&ctx.v2).await.map_err(db_err)?;
    if rows.is_some() && held.is_none() {
        return Err(ErrorCode::Duplicate);
    }
    // Обе цепочки — тем же движком, что у клиентов
    let rename = r.rename.ok_or(ErrorCode::Invalid)?;
    let mut old_log = load_log(ctx, &old).await?;
    let old_devices: Vec<String> = old_log.devices.keys().cloned().collect();
    old_log.apply(&rename).map_err(|e| e.code())?;
    if old_log.renamed_to.as_deref() != Some(new.as_str()) {
        return Err(ErrorCode::Invalid);
    }
    let first = r.new_log.first().ok_or(ErrorCode::Invalid)?;
    if old_log.rename_genesis != Some(parvane_protocol::identity::device_log_hash(first)) {
        return Err(ErrorCode::Invalid);
    }
    let mut new_log = DeviceLog::new(&new).map_err(|_| ErrorCode::Invalid)?;
    for op in &r.new_log {
        new_log.apply(op).map_err(|e| e.code())?;
    }
    if new_log.root_key != old_log.root_key || new_log.renamed_from.as_deref() != Some(old.as_str()) || new_log.active(&req.device_id).is_none() {
        return Err(ErrorCode::Invalid);
    }
    if !r.root_backup.is_empty() {
        // Копия корня под новым адресом — проверяемая форма (открыть её сервер не может)
        if r.root_backup.len() > 1024 {
            return Err(ErrorCode::Invalid);
        }
    }

    // v1: ник аккаунта и строки по нику. Отзыв токенов прежнего адреса — отметкой смены «пароля»: токены нового
    // адреса выпускаются заново, у устройства, сменившего ник, — сразу
    let now = now_unix();
    let v1: Result<(), sqlx::Error> = async {
        let mut tx = ctx.pool.begin().await?;
        sqlx::query("UPDATE users SET username = ?, password_changed_at = ?, password_changed_dev = ? WHERE username = ?")
            .bind(&new)
            .bind(now)
            .bind(&req.device_id)
            .bind(&old)
            .execute(&mut *tx)
            .await?;
        for t in V1_TABLES {
            sqlx::query(&format!("UPDATE OR IGNORE {t} SET username = ? WHERE username = ?")).bind(&new).bind(&old).execute(&mut *tx).await?;
        }
        tx.commit().await
    }
    .await;
    if let Err(e) = v1 {
        // Гонка за ник (UNIQUE) либо сбой БД — ничего не изменено
        warn!("identity: смена ника {} → {}: {}", old, new, e);
        return Err(ErrorCode::Duplicate);
    }
    if let Err(e) = rename_v2(ctx, &old, &new, &rename, &r.new_log, &old_log, &new_log, &r.root_backup, &old_devices).await {
        error!("identity: смена ника {} → {} (v2): {:?} — возврат прежнего ника", old, new, e);
        let back: Result<(), sqlx::Error> = async {
            let mut tx = ctx.pool.begin().await?;
            sqlx::query("UPDATE users SET username = ? WHERE username = ?").bind(&old).bind(&new).execute(&mut *tx).await?;
            for t in V1_TABLES {
                sqlx::query(&format!("UPDATE OR IGNORE {t} SET username = ? WHERE username = ?")).bind(&old).bind(&new).execute(&mut *tx).await?;
            }
            tx.commit().await
        }
        .await;
        if let Err(e) = back {
            error!("identity: возврат ника {} не удался: {}", old, e);
        }
        return Err(e);
    }

    let claims = Claims { sub: new.clone(), iat: now as usize, exp: now as usize + 86400, dev: Some(req.device_id.clone()) };
    let token = jwt_encode(&ctx.encoding, &claims).map_err(db_err)?;
    info!("identity: ник сменён ({} устройств)", old_devices.len());
    // Шарды переносят строки до ответа: клиент нового адреса сразу читает свои журналы инбокса
    fanout_pending(&ctx.nc, &ctx.v2).await;
    // Сессии прежнего адреса закрываются после ответа (иначе ответ на этот запрос не дошёл бы)
    let nc = ctx.nc.clone();
    let closing = old.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let retired = std::iter::once(String::new());
        for d in old_devices.into_iter().chain(retired) {
            let n = RevokedNotice { user: closing.clone(), device_id: d };
            if let Err(e) = nc.publish(REVOKED_SUBJECT.to_string(), n.encode_to_vec().into()).await {
                warn!("identity: сессии прежнего ника не закрыты: {}", e);
            }
        }
    });
    Ok(pb::AccountRenameResponse { token, address: new }.encode_to_vec())
}

#[allow(clippy::too_many_arguments)]
async fn rename_v2(
    ctx: &V2Ctx,
    old: &str,
    new: &str,
    rename: &SignedOp,
    new_entries: &[SignedOp],
    old_log: &DeviceLog,
    new_log: &DeviceLog,
    root_backup: &[u8],
    devices: &[String],
) -> Result<(), ErrorCode> {
    let now = now_unix();
    let mut tx = ctx.v2.begin_with("BEGIN IMMEDIATE").await.map_err(db_err)?;
    // Журнал нового адреса начинается заново (мог остаться архив давно освобождённого ника — он в архиве)
    sqlx::query("INSERT INTO device_log_archive (user, version, entry, archived_at) SELECT user, version, entry, ? FROM device_log WHERE user = ?")
        .bind(now)
        .bind(new)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM device_log WHERE user = ?").bind(new).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("INSERT INTO device_log (user, version, entry, hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(old)
        .bind(old_log.version as i64)
        .bind(rename.encode_to_vec())
        .bind(parvane_protocol::identity::device_log_hash(rename).to_vec())
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ErrorCode::Duplicate)?;
    for (i, op) in new_entries.iter().enumerate() {
        sqlx::query("INSERT INTO device_log (user, version, entry, hash, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(new)
            .bind(i as i64 + 1)
            .bind(op.encode_to_vec())
            .bind(parvane_protocol::identity::device_log_hash(op).to_vec())
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    for t in V2_TABLES {
        // Строк нового адреса быть не должно (ник свободен); остатки давно освобождённого ника — не его
        sqlx::query(&format!("DELETE FROM {t} WHERE user = ?")).bind(new).execute(&mut *tx).await.map_err(db_err)?;
        sqlx::query(&format!("UPDATE {t} SET user = ? WHERE user = ?")).bind(new).bind(old).execute(&mut *tx).await.map_err(db_err)?;
    }
    store_state(&mut tx, old, old_log).await?;
    store_state(&mut tx, new, new_log).await?;
    // Копии корня и ключей привязаны к адресу: прежние бесполезны, новая копия корня — из запроса
    sqlx::query("DELETE FROM root_backup WHERE user IN (?, ?)").bind(old).bind(new).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("DELETE FROM root_escrow WHERE user IN (?, ?)").bind(old).bind(new).execute(&mut *tx).await.map_err(db_err)?;
    if !root_backup.is_empty() {
        sqlx::query("INSERT INTO root_backup (user, backup, updated_at) VALUES (?, ?, ?)")
            .bind(new)
            .bind(root_backup)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    // Переадресация: цепочка «прежний → прежний → новый» ведёт сразу на новый; вернувшийся свой ник — без переадресации
    let until = now * 1000 + ALIAS_TTL_MS;
    sqlx::query("DELETE FROM account_aliases WHERE old_address = ?").bind(new).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("UPDATE account_aliases SET new_address = ? WHERE new_address = ?").bind(new).bind(old).execute(&mut *tx).await.map_err(db_err)?;
    sqlx::query("INSERT OR REPLACE INTO account_aliases (old_address, new_address, until_ms) VALUES (?, ?, ?)")
        .bind(old)
        .bind(new)
        .bind(until)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let ids = devices.join(",");
    for (shard, _) in FANOUT {
        sqlx::query("INSERT OR REPLACE INTO rename_fanout (old_address, new_address, shard, device_ids, created_ms) VALUES (?, ?, ?, ?, ?)")
            .bind(old)
            .bind(new)
            .bind(shard)
            .bind(&ids)
            .bind(now * 1000)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)
}

/// Неподтверждённые переносы — повторить (идемпотентно у шардов).
pub(crate) async fn fanout_pending(nc: &Client, pool: &SqlitePool) {
    let rows: Vec<(String, String, String, String)> =
        match sqlx::query_as("SELECT old_address, new_address, shard, device_ids FROM rename_fanout ORDER BY created_ms LIMIT 64").fetch_all(pool).await {
            Ok(r) => r,
            Err(e) => {
                error!("identity: перенос ника шардам: {}", e);
                return;
            }
        };
    for (old, new, shard, ids) in rows {
        let Some((_, subject)) = FANOUT.iter().find(|(s, _)| *s == shard) else { continue };
        let notice = RenameNotice {
            old_address: old.clone(),
            new_address: new.clone(),
            device_ids: ids.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect(),
            // Удаление аккаунта (spec 027): нового адреса нет — шард стирает строки
            purge: new.is_empty(),
        };
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), nc.request(subject.to_string(), notice.encode_to_vec().into())).await;
        let ok = matches!(&reply, Ok(Ok(m)) if decode_checked::<RenameAck>(&m.payload, Origin::Server).is_ok_and(|a| a.ok));
        if ok {
            let _ = sqlx::query("DELETE FROM rename_fanout WHERE old_address = ? AND shard = ?").bind(&old).bind(&shard).execute(pool).await;
            info!("identity: {} принят шардом {}", if new.is_empty() { "стирание аккаунта" } else { "перенос ника" }, shard);
        } else {
            warn!("identity: шард {} не подтвердил {} — повтор позже", shard, if new.is_empty() { "стирание аккаунта" } else { "перенос ника" });
        }
    }
}

/// Раз в минуту: стирание аккаунтов, чей срок вышел (spec 027); повтор переносов и стираний в шардах; истёкшие
/// переадресации — журнал прежнего адреса в архив, ник свободен.
pub(crate) fn spawn_upkeep(nc: Client, pool: SqlitePool, v1: SqlitePool) {
    tokio::spawn(async move {
        // `PARVANE_IDENTITY_UPKEEP_SECS` — только для живых тестов
        let mut t = tokio::time::interval(std::time::Duration::from_secs(env_u64("PARVANE_IDENTITY_UPKEEP_SECS", 60).max(1)));
        loop {
            t.tick().await;
            super::delete::purge_due(&pool, &v1).await;
            fanout_pending(&nc, &pool).await;
            expire_aliases(&pool).await;
        }
    });
}

async fn expire_aliases(pool: &SqlitePool) {
    let expired: Vec<(String,)> = match sqlx::query_as("SELECT old_address FROM account_aliases WHERE until_ms <= ?").bind(now_ms()).fetch_all(pool).await {
        Ok(r) => r,
        Err(e) => {
            error!("identity: истёкшие переадресации: {}", e);
            return;
        }
    };
    for (old,) in expired {
        let done: Result<(), sqlx::Error> = async {
            let mut tx = pool.begin().await?;
            sqlx::query("INSERT INTO device_log_archive (user, version, entry, archived_at) SELECT user, version, entry, ? FROM device_log WHERE user = ?")
                .bind(now_unix())
                .bind(&old)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM device_log WHERE user = ?").bind(&old).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM device_state WHERE user = ?").bind(&old).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM account_aliases WHERE old_address = ?").bind(&old).execute(&mut *tx).await?;
            tx.commit().await
        }
        .await;
        match done {
            Ok(()) => info!("identity: прежний ник освобождён"),
            Err(e) => error!("identity: освобождение прежнего ника: {}", e),
        }
    }
}

/// Журнал из архива по SHA-256 его первой записи (прежний журнал адреса, spec 026), с версии `after`.
pub(crate) async fn archived_log(pool: &SqlitePool, user: &str, genesis_hash: &[u8], after: u64) -> Result<Vec<SignedOp>, ErrorCode> {
    let rows: Vec<(i64, i64, Vec<u8>)> =
        sqlx::query_as("SELECT archived_at, version, entry FROM device_log_archive WHERE user = ? ORDER BY archived_at, version")
            .bind(user)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
    let mut groups: Vec<(i64, Vec<(i64, SignedOp)>)> = vec![];
    for (at, v, e) in rows {
        let Ok(op) = SignedOp::decode(e.as_slice()) else { continue };
        match groups.last_mut() {
            Some((a, g)) if *a == at => g.push((v, op)),
            _ => groups.push((at, vec![(v, op)])),
        }
    }
    let found = groups.into_iter().map(|(_, g)| g).find(|g| {
        g.iter().find(|(v, _)| *v == 1).is_some_and(|(_, op)| parvane_protocol::identity::device_log_hash(op).as_slice() == genesis_hash)
    });
    Ok(found.unwrap_or_default().into_iter().filter(|(v, _)| *v as u64 > after).take(256).map(|(_, op)| op).collect())
}
