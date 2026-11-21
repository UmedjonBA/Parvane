//! Ключ безопасности — второй фактор входа (правило SECKEY-1, spec 041). Методы `identity.seckey.*` и шаг входа
//! в `identity.session.issue`.
//!
//! Когда ключ спрашивается: у аккаунта есть хотя бы один ключ и включено «Требовать ключ при входе», а входит
//! устройство, НЕ доказавшее себя ключом устройства из журнала (ID-01, `device_proof`): новое устройство, вошедшее
//! одним паролем. Уже привязанные устройства (вход с доказательством) и продление сессии (`session.renew`) ключ не
//! спрашивают. Потерян ключ — вход ключом восстановления вместо него (`SessionIssueRequest.recovery_key`, сверка с
//! копией корня, как RECOVER-2) либо снять ключ с другого привязанного устройства. Поэтому ключ нельзя добавить, пока
//! у аккаунта нет копии корня на сервере (иначе единственный ключ без ключа восстановления запирал бы вход).

use super::{db_err, load_log, log_has_active_device_in, pb, require_user, verified_recovery_key, webauthn, V2Ctx};
use crate::*;

use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_v2rt::{body, Reply};
use prost::Message as _;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

/// Ключей на аккаунт.
pub(crate) const MAX_KEYS: usize = 10;
/// Срок вызова (регистрация и вход).
const CHALLENGE_TTL_MS: i64 = 5 * 60 * 1000;
/// Потолок ждущих вызовов в памяти процесса.
const CHALLENGES_MAX: usize = 20_000;
const NAME_MAX_CHARS: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Purpose {
    Register,
    Login,
}

type ChallengeKey = (String, String, Purpose);
type ChallengeMap = Mutex<HashMap<ChallengeKey, (Vec<u8>, i64)>>;
/// Строка `security_keys`: id, имя, алгоритм, ключ, счётчик, создан, использован.
type KeyTuple = (Vec<u8>, String, i64, Vec<u8>, i64, i64, i64);

/// Вызовы — только в памяти: перезапуск identity гасит их (клиент просто попросит новый).
fn challenges() -> &'static ChallengeMap {
    static C: std::sync::OnceLock<ChallengeMap> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    now_unix() * 1000
}

fn new_challenge(user: &str, device: &str, purpose: Purpose) -> Result<Vec<u8>, ErrorCode> {
    let mut ch = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut ch);
    let now = now_ms();
    let mut map = challenges().lock().map_err(|_| ErrorCode::Unavailable)?;
    map.retain(|_, (_, exp)| *exp > now);
    if map.len() >= CHALLENGES_MAX {
        return Err(ErrorCode::RateLimited);
    }
    map.insert((user.to_string(), device.to_string(), purpose), (ch.clone(), now + CHALLENGE_TTL_MS));
    Ok(ch)
}

/// Вызов расходуется при первой же попытке (удачной или нет).
fn take_challenge(user: &str, device: &str, purpose: Purpose) -> Option<Vec<u8>> {
    let mut map = challenges().lock().ok()?;
    let (ch, exp) = map.remove(&(user.to_string(), device.to_string(), purpose))?;
    (exp > now_ms()).then_some(ch)
}

struct KeyRow {
    credential_id: Vec<u8>,
    name: String,
    alg: i32,
    public_key: Vec<u8>,
    sign_count: u32,
    created_ms: i64,
    last_used_ms: i64,
}

impl KeyRow {
    fn info(&self) -> pb::SecKeyInfo {
        pb::SecKeyInfo {
            credential_id: self.credential_id.clone(),
            name: self.name.clone(),
            created_ms: self.created_ms,
            last_used_ms: self.last_used_ms,
            alg: self.alg,
        }
    }
}

async fn keys_of(v2: &SqlitePool, user: &str) -> Result<Vec<KeyRow>, ErrorCode> {
    let rows: Vec<KeyTuple> = sqlx::query_as(
        "SELECT credential_id, name, alg, public_key, sign_count, created_ms, last_used_ms FROM security_keys \
         WHERE user = ? ORDER BY created_ms, credential_id",
    )
    .bind(user)
    .fetch_all(v2)
    .await
    .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|(credential_id, name, alg, public_key, sign_count, created_ms, last_used_ms)| KeyRow {
            credential_id,
            name,
            alg: alg as i32,
            public_key,
            sign_count: u32::try_from(sign_count).unwrap_or(0),
            created_ms,
            last_used_ms,
        })
        .collect())
}

async fn required_flag(v2: &SqlitePool, user: &str) -> Result<bool, ErrorCode> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT required FROM seckey_settings WHERE user = ?").bind(user).fetch_optional(v2).await.map_err(db_err)?;
    Ok(row.is_some_and(|(r,)| r != 0))
}

async fn has_root_backup(v2: &SqlitePool, user: &str) -> Result<bool, ErrorCode> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM root_backup WHERE user = ?").bind(user).fetch_optional(v2).await.map_err(db_err)?;
    Ok(row.is_some())
}

/// Ключи заводит и снимает только действующее устройство журнала (не сессия, вошедшая одним паролем).
async fn require_log_device(ctx: &V2Ctx, req: &ShardRequest) -> Result<(), ErrorCode> {
    require_user(req)?;
    if !log_has_active_device_in(&ctx.v2, &req.user, &req.device_id).await? {
        return Err(ErrorCode::Forbidden);
    }
    Ok(())
}

/// `user.id` WebAuthn: непрозрачный, из адреса аккаунта.
fn user_handle(user: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"parvane/seckey/user\0");
    h.update(user.as_bytes());
    h.finalize()[..16].to_vec()
}

pub(crate) async fn challenge(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_log_device(ctx, req).await?;
    let keys = keys_of(&ctx.v2, &req.user).await?;
    let challenge = new_challenge(&req.user, &req.device_id, Purpose::Register)?;
    Ok(pb::SecKeyChallengeResponse {
        challenge,
        rp_id: webauthn::rp_id(),
        user_handle: user_handle(&req.user),
        exclude_ids: keys.into_iter().map(|k| k.credential_id).collect(),
    }
    .encode_to_vec())
}

pub(crate) async fn add(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_log_device(ctx, req).await?;
    let r: pb::SecKeyAddRequest = body(req)?;
    let keys = keys_of(&ctx.v2, &req.user).await?;
    if keys.len() >= MAX_KEYS {
        return Err(ErrorCode::Limit);
    }
    // Без копии корня потеря единственного ключа закрыла бы вход новых устройств — сначала ключ восстановления
    if !has_root_backup(&ctx.v2, &req.user).await? {
        return Err(ErrorCode::NotFound);
    }
    let ch = take_challenge(&req.user, &req.device_id, Purpose::Register).ok_or(ErrorCode::Expired)?;
    let key = webauthn::verify_registration(&r.client_data_json, &r.authenticator_data, &ch, &webauthn::rp_id()).map_err(|why| {
        warn!("identity: ключ безопасности не принят при регистрации: {why}");
        ErrorCode::Invalid
    })?;
    if keys.iter().any(|k| k.credential_id == key.credential_id) {
        return Err(ErrorCode::Duplicate);
    }
    let name: String = r.name.trim().chars().take(NAME_MAX_CHARS).collect();
    let now = now_ms();
    let mut tx = parvane_db::begin_write(&ctx.v2).await.map_err(db_err)?;
    sqlx::query("INSERT INTO security_keys (user, credential_id, name, alg, public_key, sign_count, created_ms, last_used_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
        .bind(&req.user)
        .bind(&key.credential_id)
        .bind(&name)
        .bind(key.alg as i64)
        .bind(&key.public_key)
        .bind(key.sign_count as i64)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| if e.to_string().contains("UNIQUE") { ErrorCode::Duplicate } else { db_err(e) })?;
    // Первый ключ включает требование (как на доске: «Требовать ключ при входе» включён)
    if keys.is_empty() {
        sqlx::query("INSERT INTO seckey_settings (user, required) VALUES (?, 1) ON CONFLICT(user) DO UPDATE SET required = 1")
            .bind(&req.user)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    info!("identity: ключ безопасности добавлен ({} ключей)", keys.len() + 1);
    let row = KeyRow { credential_id: key.credential_id, name, alg: key.alg, public_key: vec![], sign_count: 0, created_ms: now, last_used_ms: 0 };
    Ok(pb::SecKeyAddResponse { key: Some(row.info()) }.encode_to_vec())
}

pub(crate) async fn list(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_user(req)?;
    let keys = keys_of(&ctx.v2, &req.user).await?;
    Ok(pb::SecKeyListResponse {
        required: !keys.is_empty() && required_flag(&ctx.v2, &req.user).await?,
        keys: keys.iter().map(KeyRow::info).collect(),
        recovery_ready: has_root_backup(&ctx.v2, &req.user).await?,
    }
    .encode_to_vec())
}

pub(crate) async fn remove(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_log_device(ctx, req).await?;
    let r: pb::SecKeyRemoveRequest = body(req)?;
    let done = sqlx::query("DELETE FROM security_keys WHERE user = ? AND credential_id = ?")
        .bind(&req.user)
        .bind(&r.credential_id)
        .execute(&ctx.v2)
        .await
        .map_err(db_err)?;
    if done.rows_affected() == 0 {
        return Err(ErrorCode::NotFound);
    }
    info!("identity: ключ безопасности снят");
    Ok(pb::SecKeyRemoveResponse {}.encode_to_vec())
}

pub(crate) async fn set_required(ctx: &V2Ctx, req: &ShardRequest) -> Reply {
    require_log_device(ctx, req).await?;
    let r: pb::SecKeySetRequiredRequest = body(req)?;
    if keys_of(&ctx.v2, &req.user).await?.is_empty() {
        return Err(ErrorCode::NotFound);
    }
    sqlx::query("INSERT INTO seckey_settings (user, required) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET required = excluded.required")
        .bind(&req.user)
        .bind(r.required as i64)
        .execute(&ctx.v2)
        .await
        .map_err(db_err)?;
    Ok(pb::SecKeySetRequiredResponse {}.encode_to_vec())
}

/// Шаг входа после верного пароля: `None` — ключ не нужен либо принят (выдавать токен), `Some` — ответ-шаг
/// без токена (вызов ключа). `proven` — устройство доказало ключ устройства из журнала (ID-01).
pub(crate) async fn login_step(
    ctx: &V2Ctx,
    login: &str,
    device_id: &str,
    proven: bool,
    r: &pb::SessionIssueRequest,
    trust_secret: String,
) -> Result<Option<pb::SessionIssueResponse>, ErrorCode> {
    if proven {
        return Ok(None);
    }
    let keys = keys_of(&ctx.v2, login).await?;
    if keys.is_empty() || !required_flag(&ctx.v2, login).await? {
        return Ok(None);
    }
    if !window_rate_ok("seckey-login", login, env_u64("PARVANE_SECKEY_LOGIN_RATE", 20) as usize) {
        return Err(ErrorCode::RateLimited);
    }
    let (mut rejected, mut recovery_wrong) = (false, false);
    if !r.recovery_key.is_empty() {
        if !window_rate_ok("seckey-recovery", login, env_u64("PARVANE_SECKEY_RECOVERY_RATE", 5) as usize) {
            return Err(ErrorCode::RateLimited);
        }
        let log = load_log(ctx, login).await?;
        match verified_recovery_key(ctx, login, &r.recovery_key, &log).await {
            Ok(Some(_)) => {
                info!("identity: вход нового устройства ключом восстановления вместо ключа безопасности");
                return Ok(None);
            }
            Ok(None) | Err(ErrorCode::NotFound) => recovery_wrong = true,
            Err(e) => return Err(e),
        }
    } else if let Some(a) = &r.seckey {
        let ch = take_challenge(login, device_id, Purpose::Login);
        let verdict = match (ch, keys.iter().find(|k| k.credential_id == a.credential_id)) {
            (None, _) => Err("вызов просрочен или не выдавался"),
            (_, None) => Err("ключ не заведён у аккаунта"),
            (Some(ch), Some(k)) => webauthn::verify_assertion(
                &a.client_data_json,
                &a.authenticator_data,
                &a.signature,
                &ch,
                &webauthn::rp_id(),
                k.alg,
                &k.public_key,
                k.sign_count,
            )
            .map(|n| (k.credential_id.clone(), n)),
        };
        match verdict {
            Ok((id, count)) => {
                sqlx::query("UPDATE security_keys SET sign_count = ?, last_used_ms = ? WHERE user = ? AND credential_id = ?")
                    .bind(count as i64)
                    .bind(now_ms())
                    .bind(login)
                    .bind(&id)
                    .execute(&ctx.v2)
                    .await
                    .map_err(db_err)?;
                return Ok(None);
            }
            Err(why) => {
                warn!("identity: ответ ключа безопасности при входе не принят: {why}");
                rejected = true;
            }
        }
    }
    let challenge = new_challenge(login, device_id, Purpose::Login)?;
    Ok(Some(pb::SessionIssueResponse {
        seckey_required: true,
        seckey_challenge: challenge,
        seckey_ids: keys.into_iter().map(|k| k.credential_id).collect(),
        seckey_rp_id: webauthn::rp_id(),
        seckey_rejected: rejected,
        recovery_key_wrong: recovery_wrong,
        seckey_recovery: has_root_backup(&ctx.v2, login).await?,
        trust_secret,
        address: login.to_string(),
        ..Default::default()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Вызов одноразовый и привязан к пользователю, устройству и назначению; хранилище ключей и выключатель.
    #[tokio::test]
    async fn challenges_are_single_use_and_keys_are_stored() {
        let ch = new_challenge("ana@local", "d1", Purpose::Login).unwrap();
        assert!(take_challenge("ana@local", "d2", Purpose::Login).is_none(), "чужое устройство");
        assert!(take_challenge("ana@local", "d1", Purpose::Register).is_none(), "другое назначение");
        assert_eq!(take_challenge("ana@local", "d1", Purpose::Login), Some(ch));
        assert!(take_challenge("ana@local", "d1", Purpose::Login).is_none(), "второй раз");

        let base = std::env::temp_dir().join(format!("pv-id-seckey-{}-{}", std::process::id(), now_unix()));
        let pool = super::super::open_store_at(base.to_str().unwrap()).await.unwrap();
        assert!(keys_of(&pool, "ana@local").await.unwrap().is_empty());
        assert!(!required_flag(&pool, "ana@local").await.unwrap());
        sqlx::query("INSERT INTO security_keys (user, credential_id, name, alg, public_key, sign_count, created_ms) VALUES ('ana@local', x'01', 'USB', -7, x'04', 3, 5)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO seckey_settings (user, required) VALUES ('ana@local', 1)").execute(&pool).await.unwrap();
        let keys = keys_of(&pool, "ana@local").await.unwrap();
        assert_eq!((keys.len(), keys[0].alg, keys[0].sign_count, keys[0].name.as_str()), (1, -7, 3, "USB"));
        assert!(required_flag(&pool, "ana@local").await.unwrap());
        assert!(!has_root_backup(&pool, "ana@local").await.unwrap());
        assert_eq!(user_handle("ana@local").len(), 16);
        assert_ne!(user_handle("ana@local"), user_handle("bob@local"));
        pool.close().await;
    }
}
