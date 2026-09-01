use anyhow::{Context, Result};
use async_nats::Client;
use base64::{engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NO_PAD}, Engine};
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use parvane_types::{
    DeviceInfo, DeviceListRequest, DeviceListResponse, DeviceRevokeRequest, DeviceRevokeResponse,
    EmailConfirmRequest, EmailConfirmResponse, FetchBundleRequest, FetchBundleResponse,
    IssueRequest, IssueResponse, LinkGrantInfo, LinkGrantRequest, LinkGrantResponse,
    LinkOfferInfo, LinkOfferRequest, LinkOfferResponse, LinkPollRequest, LinkPollResponse,
    PublishPrekeysRequest, PublishPrekeysResponse, RegisterRequest, RegisterResponse,
    ResolveRequest, ResolveResponse, SearchUsersRequest, SearchUsersResponse, SetAvatarRequest,
    SetKeyRequest, SetNameRequest, SetNameResponse, UserInfo, VerifyRequest, VerifyResponse,
    topics::{
        IDENTITY_DEVICE_LIST, IDENTITY_DEVICE_REVOKE, IDENTITY_EMAIL_CONFIRM, IDENTITY_ISSUE,
        IDENTITY_LINK_GRANT, IDENTITY_LINK_OFFER, IDENTITY_LINK_POLL, IDENTITY_PREKEYS_FETCH,
        IDENTITY_PREKEYS_PUBLISH, IDENTITY_REGISTER, IDENTITY_RESOLVE, IDENTITY_SEARCH,
        IDENTITY_SETAVATAR, IDENTITY_SETKEY, IDENTITY_SETNAME, IDENTITY_VERIFY,
    },
};

fn opt(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};
use uuid::Uuid;

// ── JWT claims ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
}

// ── password hashing (argon2id, соль на пароль) ───────────────────────────────

use argon2::password_hash::{rand_core::OsRng, PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};

/// Хэш пароля в PHC-формате (argon2id + случайная соль). Для регистрации.
fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))
}

/// Проверка пароля против хранимого PHC-хэша (константное время внутри argon2).
fn verify_password(password: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    dotenvy::dotenv().ok();

    let nats_url = std::env::var("PARVANE_NATS_URL")
        .unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./identity.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url)
        .await
        .context("подключение к SQLite")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let secret = load_or_generate_secret(&pool).await?;
    let encoding = EncodingKey::from_secret(&secret);
    let decoding = DecodingKey::from_secret(&secret);

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    let mut issue_sub = nc.subscribe(IDENTITY_ISSUE).await?;
    let mut register_sub = nc.subscribe(IDENTITY_REGISTER).await?;
    let mut email_confirm_sub = nc.subscribe(IDENTITY_EMAIL_CONFIRM).await?;
    let mut verify_sub = nc.subscribe(IDENTITY_VERIFY).await?;
    let mut search_sub = nc.subscribe(IDENTITY_SEARCH).await?;
    let mut setname_sub = nc.subscribe(IDENTITY_SETNAME).await?;
    let mut setavatar_sub = nc.subscribe(IDENTITY_SETAVATAR).await?;
    let mut setkey_sub = nc.subscribe(IDENTITY_SETKEY).await?;
    let mut resolve_sub = nc.subscribe(IDENTITY_RESOLVE).await?;
    let mut pkpub_sub = nc.subscribe(IDENTITY_PREKEYS_PUBLISH).await?;
    let mut pkfetch_sub = nc.subscribe(IDENTITY_PREKEYS_FETCH).await?;
    let mut devlist_sub = nc.subscribe(IDENTITY_DEVICE_LIST).await?;
    let mut devrevoke_sub = nc.subscribe(IDENTITY_DEVICE_REVOKE).await?;
    let mut linkoffer_sub = nc.subscribe(IDENTITY_LINK_OFFER).await?;
    let mut linkpoll_sub = nc.subscribe(IDENTITY_LINK_POLL).await?;
    let mut linkgrant_sub = nc.subscribe(IDENTITY_LINK_GRANT).await?;

    info!("Identity шард запущен. Слушаю: issue/register/email.confirm/verify/search/setname/setavatar/setkey/resolve/prekeys/devices");

    loop {
        tokio::select! {
            Some(msg) = issue_sub.next() => {
                handle_issue(&nc, &pool, &encoding, msg).await;
            }
            Some(msg) = register_sub.next() => {
                handle_register(&nc, &pool, msg).await;
            }
            Some(msg) = email_confirm_sub.next() => {
                handle_email_confirm(&nc, &pool, msg).await;
            }
            Some(msg) = verify_sub.next() => {
                handle_verify(&nc, &decoding, msg).await;
            }
            Some(msg) = search_sub.next() => {
                handle_search(&nc, &pool, msg).await;
            }
            Some(msg) = setname_sub.next() => {
                handle_setname(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = setavatar_sub.next() => {
                handle_setavatar(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = setkey_sub.next() => {
                handle_setkey(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = resolve_sub.next() => {
                handle_resolve(&nc, &pool, msg).await;
            }
            Some(msg) = pkpub_sub.next() => {
                handle_prekeys_publish(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = pkfetch_sub.next() => {
                handle_prekeys_fetch(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = devlist_sub.next() => {
                handle_device_list(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = devrevoke_sub.next() => {
                handle_device_revoke(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = linkoffer_sub.next() => {
                handle_link_offer(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = linkpoll_sub.next() => {
                handle_link_poll(&nc, &pool, &decoding, msg).await;
            }
            Some(msg) = linkgrant_sub.next() => {
                handle_link_grant(&nc, &pool, &decoding, msg).await;
            }
        }
    }
}

// display_name с фолбэком на локальную часть адреса (для старых записей с '').
fn name_or_default(username: &str, display_name: &str) -> String {
    if display_name.is_empty() {
        username.split('@').next().unwrap_or(username).to_string()
    } else {
        display_name.to_string()
    }
}

// Поиск пользователей по подстроке имени/адреса. Возвращает username+display_name.
async fn handle_search(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("search: нет reply-топика, игнорирую");
        return;
    };
    let q = serde_json::from_slice::<SearchUsersRequest>(&msg.payload)
        .map(|r| r.query.trim().to_string())
        .unwrap_or_default();
    let users: Vec<UserInfo> = if q.is_empty() {
        vec![]
    } else {
        let like = format!("%{}%", q);
        sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT username, display_name, avatar_file_id, pubkey FROM users
             WHERE username LIKE ? OR display_name LIKE ?
             ORDER BY username LIMIT 20",
        )
        .bind(&like)
        .bind(&like)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(u, d, a, k)| UserInfo {
            display_name: name_or_default(&u, &d),
            username: u,
            avatar: opt(a),
            pubkey: opt(k),
        })
        .collect()
    };
    info!("search '{}' → {} результатов", q, users.len());
    let _ = nc
        .publish(reply, serde_json::to_vec(&SearchUsersResponse { users }).unwrap_or_default().into())
        .await;
}

// Смена своего display_name (username берём из проверенного токена).
async fn handle_setname(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<SetNameRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => {
                let name = req.display_name.trim();
                if name.is_empty() || name.len() > 64 {
                    SetNameResponse { ok: false, error: Some("имя пустое/длинное".into()) }
                } else {
                    let _ = sqlx::query("UPDATE users SET display_name = ? WHERE username = ?")
                        .bind(name)
                        .bind(&username)
                        .execute(pool)
                        .await;
                    info!("{} сменил имя на '{}'", username, name);
                    SetNameResponse { ok: true, error: None }
                }
            }
            Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Установка своего avatar_file_id (username из проверенного токена).
async fn handle_setavatar(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<SetAvatarRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => {
                let _ = sqlx::query("UPDATE users SET avatar_file_id = ? WHERE username = ?")
                    .bind(&req.file_id)
                    .bind(&username)
                    .execute(pool)
                    .await;
                info!("{} обновил аватар ({})", username, req.file_id);
                SetNameResponse { ok: true, error: None }
            }
            Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Записать публичный ключ пользователя (чистая функция — для тестов).
async fn store_pubkey(pool: &SqlitePool, username: &str, pubkey: &str) -> Result<()> {
    let decoded = B64.decode(pubkey).or_else(|_| B64_NO_PAD.decode(pubkey))
        .context("pubkey должен быть base64")?;
    if decoded.len() != 32 {
        anyhow::bail!("pubkey должен быть Ed25519-ключом длиной 32 байта");
    }
    sqlx::query("UPDATE users SET pubkey = ? WHERE username = ?")
        .bind(pubkey)
        .bind(username)
        .execute(pool)
        .await
        .context("запись pubkey")?;
    Ok(())
}

// Регистрация своего публичного Ed25519-ключа (username из проверенного токена).
async fn handle_setkey(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<SetKeyRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match store_pubkey(pool, &username, &req.pubkey).await {
                Ok(()) => {
                    info!("{} зарегистрировал pubkey ({}…)", username, &req.pubkey.chars().take(12).collect::<String>());
                    SetNameResponse { ok: true, error: None }
                }
                Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
            },
            Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => SetNameResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// Резолв display_name по списку адресов (для пиров из sync).
async fn handle_resolve(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let req: ResolveRequest = serde_json::from_slice(&msg.payload).unwrap_or(ResolveRequest {
        usernames: vec![],
    });
    let mut users = Vec::new();
    for u in req.usernames.iter().take(50) {
        let row: Option<(String, String, String)> = sqlx::query_as(
            "SELECT display_name, avatar_file_id, pubkey FROM users WHERE username = ?",
        )
        .bind(u)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some((d, a, k)) = row {
            users.push(UserInfo {
                display_name: name_or_default(u, &d),
                username: u.clone(),
                avatar: opt(a),
                pubkey: opt(k),
            });
        }
    }
    let _ = nc
        .publish(reply, serde_json::to_vec(&ResolveResponse { users }).unwrap_or_default().into())
        .await;
}

// ── E2E prekeys (Фаза 2) ──────────────────────────────────────────────────────

/// Сохранить/обновить бандл УСТРОЙСТВА пользователя (мультидевайс): долгоживущие
/// ключи (UPSERT по (username, device_id)) + пачка одноразовых (INSERT OR IGNORE).
///
/// Смена identity_key = пере-инициализация ЭТОГО устройства (новый Olm-аккаунт):
/// его прежние one-time невалидны для X3DH с новым ключом (а из-за коллизий
/// key_id новые бы игнорировались) — вычищаем. Другие устройства не трогаем.
async fn store_prekeys(pool: &SqlitePool, username: &str, req: &PublishPrekeysRequest) -> Result<()> {
    let prev: Option<(String,)> =
        sqlx::query_as("SELECT identity_key FROM device_keys WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(&req.device_id)
            .fetch_optional(pool)
            .await
            .context("чтение прежнего identity_key")?;
    let device_changed = prev.map(|(k,)| k != req.identity_key).unwrap_or(false);
    if device_changed {
        sqlx::query("DELETE FROM one_time_prekeys WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(&req.device_id)
            .execute(pool)
            .await
            .context("очистка one_time старого устройства")?;
    }
    sqlx::query(
        "INSERT INTO device_keys
           (username, device_id, signing_key, registration_id, identity_key, signed_prekey_id,
            signed_prekey, signed_prekey_sig, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, device_id) DO UPDATE SET
            signing_key = excluded.signing_key,
            registration_id = excluded.registration_id,
            identity_key = excluded.identity_key,
            signed_prekey_id = excluded.signed_prekey_id,
            signed_prekey = excluded.signed_prekey,
            signed_prekey_sig = excluded.signed_prekey_sig,
            updated_at = excluded.updated_at",
    )
    .bind(username)
    .bind(&req.device_id)
    .bind(&req.signing_key)
    .bind(req.registration_id)
    .bind(&req.identity_key)
    .bind(req.signed_prekey_id)
    .bind(&req.signed_prekey)
    .bind(&req.signed_prekey_sig)
    .bind(now_unix())
    .execute(pool)
    .await
    .context("сохранение device_keys")?;
    for otp in &req.one_time {
        sqlx::query(
            "INSERT OR IGNORE INTO one_time_prekeys (username, device_id, key_id, public_key)
             VALUES (?, ?, ?, ?)",
        )
        .bind(username)
        .bind(&req.device_id)
        .bind(otp.key_id)
        .bind(&otp.public_key)
        .execute(pool)
        .await
        .context("сохранение one_time")?;
    }
    Ok(())
}

fn empty_bundle_response(error: Option<String>) -> FetchBundleResponse {
    FetchBundleResponse {
        ok: error.is_none(),
        registration_id: None,
        identity_key: None,
        signed_prekey_id: None,
        signed_prekey: None,
        signed_prekey_sig: None,
        one_time_id: None,
        one_time: None,
        devices: vec![],
        error,
    }
}

/// Бандлы ВСЕХ устройств собеседника для X3DH (мультидевайс). Для устройств не
/// из `known_devices` атомарно снимает по одной one-time (UPDATE … RETURNING —
/// без гонки); для известных (сессия уже есть) one-time не расходуется.
/// Верхнеуровневые legacy-поля — бандл «primary»-устройства ('' приоритетно,
/// иначе самое свежее) для одно-девайсных клиентов. Если ключей нет — ok=false.
async fn fetch_bundle(
    pool: &SqlitePool,
    username: &str,
    known_devices: &[String],
) -> Result<FetchBundleResponse> {
    let rows: Vec<(String, String, i64, String, i64, String, String)> = sqlx::query_as(
        "SELECT device_id, signing_key, registration_id, identity_key, signed_prekey_id,
                signed_prekey, signed_prekey_sig
         FROM device_keys WHERE username = ?
         ORDER BY CASE WHEN device_id = '' THEN 0 ELSE 1 END, updated_at DESC",
    )
    .bind(username)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(empty_bundle_response(Some("нет ключей пользователя".into())));
    }

    let mut devices = Vec::with_capacity(rows.len());
    for (device_id, signing_key, reg, ik, spid, sp, sig) in rows {
        let otp: Option<(i64, String)> = if known_devices.contains(&device_id) {
            None
        } else {
            sqlx::query_as(
                "UPDATE one_time_prekeys SET consumed = 1
                 WHERE rowid = (SELECT rowid FROM one_time_prekeys
                                WHERE username = ? AND device_id = ? AND consumed = 0
                                ORDER BY key_id LIMIT 1)
                 RETURNING key_id, public_key",
            )
            .bind(username)
            .bind(&device_id)
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
        };
        devices.push(parvane_types::DeviceBundle {
            device_id,
            signing_key,
            registration_id: reg,
            identity_key: ik,
            signed_prekey_id: spid,
            signed_prekey: sp,
            signed_prekey_sig: sig,
            one_time_id: otp.as_ref().map(|(k, _)| *k),
            one_time: otp.map(|(_, p)| p),
        });
    }

    let primary = devices[0].clone();
    Ok(FetchBundleResponse {
        ok: true,
        registration_id: Some(primary.registration_id),
        identity_key: Some(primary.identity_key),
        signed_prekey_id: Some(primary.signed_prekey_id),
        signed_prekey: Some(primary.signed_prekey),
        signed_prekey_sig: Some(primary.signed_prekey_sig),
        one_time_id: primary.one_time_id,
        one_time: primary.one_time,
        devices,
        error: None,
    })
}

/// Устройства аккаунта БЕЗ расхода one-time (в отличие от fetch_bundle):
/// каталог + остаток несожжённых one-time на устройство (для пополнения).
async fn list_devices(pool: &SqlitePool, username: &str) -> Result<Vec<DeviceInfo>> {
    let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT d.device_id, d.signing_key, d.identity_key, d.updated_at,
                (SELECT COUNT(*) FROM one_time_prekeys o
                  WHERE o.username = d.username AND o.device_id = d.device_id
                    AND o.consumed = 0)
         FROM device_keys d WHERE d.username = ?
         ORDER BY CASE WHEN d.device_id = '' THEN 0 ELSE 1 END, d.updated_at DESC",
    )
    .bind(username)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, signing_key, identity_key, updated_at, one_time_available)| DeviceInfo {
            device_id,
            signing_key,
            identity_key,
            updated_at,
            one_time_available,
        })
        .collect())
}

/// Отзыв устройства: бандл и one-time удаляются, fan-out его больше не увидит.
/// Ok(false) — такого устройства нет. Уже выданные JWT отзыв не гасит (24ч);
/// чтение НОВЫХ сообщений закрывает исчезновение из fan-out + клиентская
/// ротация групповых ключей.
async fn revoke_device(pool: &SqlitePool, username: &str, device_id: &str) -> Result<bool> {
    let deleted = sqlx::query("DELETE FROM device_keys WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM one_time_prekeys WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(deleted > 0)
}

async fn handle_device_list(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<DeviceListRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match list_devices(pool, &username).await {
                Ok(devices) => DeviceListResponse { ok: true, devices, error: None },
                Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(e.to_string()) },
            },
            Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(e.to_string()) },
        },
        Err(e) => DeviceListResponse { ok: false, devices: vec![], error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_device_revoke(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<DeviceRevokeRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match revoke_device(pool, &username, &req.device_id).await {
                Ok(true) => {
                    info!("{} отозвал устройство '{}'", username, req.device_id);
                    DeviceRevokeResponse { ok: true, error: None }
                }
                Ok(false) => DeviceRevokeResponse {
                    ok: false,
                    error: Some("устройство не найдено".into()),
                },
                Err(e) => DeviceRevokeResponse { ok: false, error: Some(e.to_string()) },
            },
            Err(e) => DeviceRevokeResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => DeviceRevokeResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── линковка: передача E2E-состояния на новое устройство ────────────────────
// Сервер — слепой релей: видит эфемерные ПУБЛИЧНЫЕ ключи и ECDH-бокс
// (внутри — координаты шифртекста экспорта в cloud), прочитать не может.

/// Время жизни оффера/гранта; просроченные чистятся при каждом обращении.
const LINK_TTL_SECS: i64 = 900;
/// Кап полей против злоупотребления хранилищем (base64-строки).
const LINK_EPH_PUB_MAX: usize = 512;
const LINK_BOX_MAX: usize = 8192;

async fn purge_stale_links(pool: &SqlitePool) -> Result<()> {
    let cutoff = now_unix() - LINK_TTL_SECS;
    sqlx::query("DELETE FROM link_offers WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM link_grants WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

async fn store_link_offer(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
    eph_pub: &str,
) -> Result<()> {
    // Пустой eph_pub — ОТЗЫВ собственного оффера (устройство получило историю
    // или накопило свою): чужие устройства перестают видеть запрос
    if eph_pub.is_empty() {
        sqlx::query("DELETE FROM link_offers WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(device_id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM link_grants WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(device_id)
            .execute(pool)
            .await?;
        return Ok(());
    }
    if eph_pub.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    // Повторный оффер того же устройства заменяет прежний (и гасит старый
    // грант — он зашифрован на уже потерянный эфемерный ключ)
    sqlx::query("INSERT OR REPLACE INTO link_offers (username, device_id, eph_pub, created_at) VALUES (?, ?, ?, ?)")
        .bind(username)
        .bind(device_id)
        .bind(eph_pub)
        .bind(now_unix())
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM link_grants WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Офферы ДРУГИХ устройств аккаунта + одноразовый грант для запрашивающего
/// (удаляется при выдаче: клиент, упавший до импорта, просто переофферит).
async fn poll_link(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
) -> Result<(Vec<LinkOfferInfo>, Option<LinkGrantInfo>)> {
    purge_stale_links(pool).await?;
    let offers: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT device_id, eph_pub, created_at FROM link_offers
          WHERE username = ? AND device_id != ? ORDER BY created_at",
    )
    .bind(username)
    .bind(device_id)
    .fetch_all(pool)
    .await?;
    let grant: Option<(String, String)> = sqlx::query_as(
        "DELETE FROM link_grants WHERE username = ? AND device_id = ?
         RETURNING box, eph_pub",
    )
    .bind(username)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    Ok((
        offers
            .into_iter()
            .map(|(device_id, eph_pub, created_at)| LinkOfferInfo { device_id, eph_pub, created_at })
            .collect(),
        grant.map(|(box_payload, eph_pub)| LinkGrantInfo { box_payload, eph_pub }),
    ))
}

/// Грант принимается только под живой оффер целевого устройства (иначе это
/// мусор в пустоту); оффер при этом гасится — линковка одноразовая.
async fn store_link_grant(
    pool: &SqlitePool,
    username: &str,
    target_device: &str,
    box_payload: &str,
    eph_pub: &str,
) -> Result<()> {
    if box_payload.is_empty() || box_payload.len() > LINK_BOX_MAX {
        anyhow::bail!("некорректный бокс");
    }
    if eph_pub.is_empty() || eph_pub.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    let removed = sqlx::query("DELETE FROM link_offers WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(target_device)
        .execute(pool)
        .await?
        .rows_affected();
    if removed == 0 {
        anyhow::bail!("оффер линковки не найден или истёк");
    }
    sqlx::query("INSERT OR REPLACE INTO link_grants (username, device_id, box, eph_pub, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(username)
        .bind(target_device)
        .bind(box_payload)
        .bind(eph_pub)
        .bind(now_unix())
        .execute(pool)
        .await?;
    Ok(())
}

async fn handle_link_offer(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<LinkOfferRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match store_link_offer(pool, &username, &req.device_id, &req.eph_pub).await {
                Ok(()) => {
                    info!("{} опубликовал оффер линковки (устройство '{}')", username, req.device_id);
                    LinkOfferResponse { ok: true, error: None }
                }
                Err(e) => LinkOfferResponse { ok: false, error: Some(e.to_string()) },
            },
            Err(e) => LinkOfferResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => LinkOfferResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_link_poll(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<LinkPollRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match poll_link(pool, &username, &req.device_id).await {
                Ok((offers, grant)) => LinkPollResponse { ok: true, offers, grant, error: None },
                Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, error: Some(e.to_string()) },
            },
            Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, error: Some(e.to_string()) },
        },
        Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_link_grant(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<LinkGrantRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => {
                match store_link_grant(pool, &username, &req.device_id, &req.box_payload, &req.eph_pub).await {
                    Ok(()) => {
                        info!("{} выдал грант линковки устройству '{}'", username, req.device_id);
                        LinkGrantResponse { ok: true, error: None }
                    }
                    Err(e) => LinkGrantResponse { ok: false, error: Some(e.to_string()) },
                }
            }
            Err(e) => LinkGrantResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => LinkGrantResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_prekeys_publish(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<PublishPrekeysRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(username) => match store_prekeys(pool, &username, &req).await {
                Ok(()) => {
                    info!(
                        "{} опубликовал prekeys (устройство '{}', {} one-time)",
                        username, req.device_id, req.one_time.len(),
                    );
                    PublishPrekeysResponse { ok: true, error: None }
                }
                Err(e) => PublishPrekeysResponse { ok: false, error: Some(e.to_string()) },
            },
            Err(e) => PublishPrekeysResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => PublishPrekeysResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn handle_prekeys_fetch(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
    let resp = match serde_json::from_slice::<FetchBundleRequest>(&msg.payload) {
        Ok(req) => match verify(&req.token) {
            Ok(requester) => {
                if !prekey_fetch_rate_ok(&requester, &req.user) {
                    empty_bundle_response(Some(
                        "слишком много запросов ключей, попробуйте позже".into(),
                    ))
                } else {
                    fetch_bundle(pool, &req.user, &req.known_devices)
                        .await
                        .unwrap_or_else(|e| empty_bundle_response(Some(e.to_string())))
                }
            }
            Err(e) => empty_bundle_response(Some(e.to_string())),
        },
        Err(e) => empty_bundle_response(Some(e.to_string())),
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

// ── secret management ─────────────────────────────────────────────────────────

async fn load_or_generate_secret(pool: &SqlitePool) -> Result<Vec<u8>> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT bytes FROM secret WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    if let Some((bytes,)) = row {
        info!("JWT-секрет загружен из БД");
        Ok(bytes)
    } else {
        let mut secret = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);

        sqlx::query("INSERT INTO secret (id, bytes) VALUES (1, ?)")
            .bind(&secret)
            .execute(pool)
            .await?;

        info!("JWT-секрет сгенерирован и сохранён");
        Ok(secret)
    }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn handle_issue(
    nc: &Client,
    pool: &SqlitePool,
    encoding: &EncodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else {
        error!("issue: нет reply-топика, игнорирую");
        return;
    };

    let resp = match do_issue(pool, encoding, &msg.payload).await {
        Ok(token) => IssueResponse { ok: true, token: Some(token), error: None },
        Err(e) => {
            error!("issue error: {}", e);
            IssueResponse { ok: false, token: None, error: Some(e.to_string()) }
        }
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("issue: ошибка отправки ответа: {}", e);
    }
}

async fn do_issue(pool: &SqlitePool, encoding: &EncodingKey, payload: &[u8]) -> Result<String> {
    let req: IssueRequest = serde_json::from_slice(payload)
        .context("неверный JSON в IssueRequest")?;

    // Брутфорс-защита: частотный лимит + экспоненциальный лок-аут по логину
    // (источник соединения gateway'ем в payload не прокидывается, поэтому ключ —
    // логин). Проверяем ДО обращения к БД, чтобы отклонённая попытка была дёшева.
    login_gate_check(&req.user)?;

    // Логин: пользователь ОБЯЗАН существовать. Создание аккаунтов — только через
    // identity.user.register (раньше issue молча создавал юзера с любым паролем —
    // это позволяло занять любой адрес первым запросом).
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT password_hash, email_verified FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_optional(pool)
            .await?;
    // Анти-энумерация + анти-timing: несуществующий юзер и неверный пароль дают
    // ОДНУ ошибку, а argon2-verify выполняется всегда (по dummy-хэшу постоянного
    // времени, когда юзера нет), чтобы по задержке нельзя было отличить случаи.
    let Some((hash, email_verified)) = row else {
        let _ = verify_password(&req.password, dummy_password_hash());
        login_record_failure(&req.user);
        anyhow::bail!("неверный логин или пароль");
    };
    if !verify_password(&req.password, &hash) {
        login_record_failure(&req.user);
        anyhow::bail!("неверный логин или пароль");
    }
    // Пароль верен — сбрасываем счётчик неудач (в т.ч. до проверки почты, чтобы
    // неподтверждённый аккаунт с верным паролем не копил лок-аут и мог получать
    // перевысылку кода).
    login_record_success(&req.user);
    // Сообщаем о неподтверждённой почте только после проверки пароля, чтобы
    // посторонний не мог зондировать статус чужого аккаунта.
    if email_verified == 0 {
        anyhow::bail!("почта не подтверждена");
    }

    let now = now_unix() as usize;
    let claims = Claims { sub: req.user.clone(), iat: now, exp: now + 86400 };
    let token = encode(&Header::new(Algorithm::HS256), &claims, encoding)
        .context("подпись JWT")?;

    info!("JWT выдан для: {}", req.user);
    Ok(token)
}

// ── регистрация (отдельно от логина) ──────────────────────────────────────────

async fn handle_register(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("register: нет reply-топика, игнорирую");
        return;
    };
    let email_required = std::env::var("PARVANE_EMAIL_REQUIRED").as_deref() == Ok("1");
    let resp = match do_register(pool, &msg.payload, email_required).await {
        Ok(out) => {
            if let Some((email, code)) = out.send {
                send_confirmation_email(email, code);
            }
            RegisterResponse { ok: true, error: None, confirm_required: out.confirm_required }
        }
        Err(e) => RegisterResponse { ok: false, error: Some(e.to_string()), confirm_required: false },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("register: ошибка отправки ответа: {}", e);
    }
}

/// Итог регистрации: ждать ли код и какое письмо отправить.
#[derive(Debug)]
struct RegisterOutcome {
    confirm_required: bool,
    /// (email, код) для письма. None — подтверждение не требуется.
    send: Option<(String, String)>,
}

/// Сколько живёт неподтверждённый аккаунт: после — логин можно занять заново
/// (иначе регистрация без подтверждения сквотила бы адреса навсегда).
const PENDING_TTL_SECS: i64 = 86_400;
/// Срок действия кода подтверждения.
const CODE_TTL_SECS: i64 = 900;
/// Попыток ввода кода до принудительного перезапроса.
const CODE_MAX_ATTEMPTS: i64 = 5;

/// Создать аккаунт. Отвергает занятый логин, пустые поля, превышение лимита
/// попыток и (при PARVANE_INVITE_REQUIRED=1) отсутствие валидного инвайта.
/// При `email_required` аккаунт создаётся неподтверждённым и ждёт кода с почты;
/// повторный register с тем же паролем до подтверждения — перевысылка кода.
async fn do_register(
    pool: &SqlitePool,
    payload: &[u8],
    email_required: bool,
) -> Result<RegisterOutcome> {
    let req: RegisterRequest = serde_json::from_slice(payload)
        .context("неверный JSON в RegisterRequest")?;

    let user = req.user.trim().to_string();
    if user.is_empty() || req.password.is_empty() {
        anyhow::bail!("пустой логин или пароль");
    }
    if user.len() > 128 {
        anyhow::bail!("слишком длинный логин");
    }
    if !rate_ok(&user) {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }

    // Пустой email валиден только для перевысылки кода pending-аккаунту
    // (ниже), для новой регистрации проверяется перед INSERT.
    let email = req.email.trim().to_lowercase();

    // Неподтверждённый аккаунт: тот же пароль — перевысылаем код (пустой email
    // = на сохранённую почту, непустой — обновляем, вдруг была опечатка);
    // чужой просроченный — освобождаем логин.
    let existing: Option<(String, i64, i64, String)> = sqlx::query_as(
        "SELECT password_hash, email_verified, created_at, email FROM users WHERE username = ?",
    )
    .bind(&user)
    .fetch_optional(pool)
    .await?;
    if let Some((hash, verified, created_at, stored_email)) = existing {
        if verified != 0 {
            anyhow::bail!("логин занят");
        }
        if verify_password(&req.password, &hash) {
            let email = if email.is_empty() { stored_email } else { email };
            if !valid_email(&email) {
                anyhow::bail!("нужен корректный email");
            }
            sqlx::query("UPDATE users SET email = ? WHERE username = ?")
                .bind(&email)
                .bind(&user)
                .execute(pool)
                .await?;
            let code = issue_email_code(pool, &user).await?;
            info!("Перевысылка кода подтверждения: {}", user);
            return Ok(RegisterOutcome { confirm_required: true, send: Some((email, code)) });
        }
        if now_unix() - created_at <= PENDING_TTL_SECS {
            anyhow::bail!("логин занят");
        }
        sqlx::query("DELETE FROM users WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM email_codes WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
    }

    if email_required && !valid_email(&email) {
        anyhow::bail!("нужен корректный email");
    }

    // Инвайт-режим за флагом окружения (закрытый пузырь).
    if std::env::var("PARVANE_INVITE_REQUIRED").as_deref() == Ok("1")
        && !consume_invite(pool, &req.invite).await?
    {
        anyhow::bail!("нужен валидный инвайт-код");
    }

    let hash = hash_password(&req.password)?;
    let id = Uuid::now_v7().to_string();
    let now = now_unix();
    // Отображаемое имя по умолчанию — локальная часть адреса (до '@').
    let default_name = user.split('@').next().unwrap_or(&user).to_string();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, created_at, display_name, email, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user)
    .bind(&hash)
    .bind(now)
    .bind(&default_name)
    .bind(&email)
    .bind(if email_required { 0 } else { 1 })
    .execute(pool)
    .await?;

    if email_required {
        let code = issue_email_code(pool, &user).await?;
        info!("Пользователь зарегистрирован, ждёт подтверждения почты: {}", user);
        return Ok(RegisterOutcome { confirm_required: true, send: Some((email, code)) });
    }
    info!("Пользователь зарегистрирован: {} (имя: {})", user, default_name);
    Ok(RegisterOutcome { confirm_required: false, send: None })
}

/// Минимальная проверка адреса почты (полная валидация — задача SMTP-сервера).
fn valid_email(email: &str) -> bool {
    if email.len() < 5 || email.len() > 254 || email.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
}

/// Сгенерировать 6-значный код, сохранить его argon2-хэш (upsert) и вернуть
/// открытый код для письма. Прежний код перестаёт действовать.
async fn issue_email_code(pool: &SqlitePool, user: &str) -> Result<String> {
    use rand::Rng;
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
    let hash = hash_password(&code)?;
    let now = now_unix();
    sqlx::query(
        "INSERT INTO email_codes (username, code_hash, expires_at, attempts, sent_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(username) DO UPDATE SET
            code_hash = excluded.code_hash,
            expires_at = excluded.expires_at,
            attempts = 0,
            sent_at = excluded.sent_at",
    )
    .bind(user)
    .bind(&hash)
    .bind(now + CODE_TTL_SECS)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(code)
}

/// Отправить письмо с кодом. Без PARVANE_SMTP_HOST — dev-режим: код в лог
/// (локальная разработка и e2e). Отправка — в отдельной таске, чтобы медленный
/// SMTP не блокировал цикл обработки шины.
fn send_confirmation_email(email: String, code: String) {
    let Some(host) = std::env::var("PARVANE_SMTP_HOST").ok().filter(|h| !h.is_empty()) else {
        info!("dev-режим SMTP: код подтверждения для {}: {}", email, code);
        return;
    };
    tokio::spawn(async move {
        match smtp_send(&host, &email, &code).await {
            Ok(()) => info!("Код подтверждения отправлен на {}", email),
            Err(e) => error!("не удалось отправить письмо на {}: {}", email, e),
        }
    });
}

async fn smtp_send(host: &str, email: &str, code: &str) -> Result<()> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let port: u16 = std::env::var("PARVANE_SMTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(587);
    let smtp_user = std::env::var("PARVANE_SMTP_USER").unwrap_or_default();
    let smtp_pass = std::env::var("PARVANE_SMTP_PASS").unwrap_or_default();
    let from = std::env::var("PARVANE_SMTP_FROM").unwrap_or_else(|_| smtp_user.clone());

    let message = Message::builder()
        .from(from.parse().context("PARVANE_SMTP_FROM: неверный адрес")?)
        .to(email.parse().context("неверный адрес получателя")?)
        .subject("Parvane: код подтверждения")
        .body(format!(
            "Ваш код подтверждения: {code}\n\nКод действует {} минут. Если вы не \
             регистрировались в Parvane — просто проигнорируйте это письмо.",
            CODE_TTL_SECS / 60
        ))
        .context("сборка письма")?;

    // 465 — implicit TLS, иначе STARTTLS (587 и т.п.).
    let mut builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host).context("SMTP relay")?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host).context("SMTP starttls")?
    };
    builder = builder.port(port);
    if !smtp_user.is_empty() {
        builder = builder.credentials(Credentials::new(smtp_user, smtp_pass));
    }
    builder.build().send(message).await.context("отправка SMTP")?;
    Ok(())
}

// ── подтверждение почты ───────────────────────────────────────────────────────

async fn handle_email_confirm(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("email.confirm: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_email_confirm(pool, &msg.payload).await {
        Ok(()) => EmailConfirmResponse { ok: true, error: None },
        Err(e) => EmailConfirmResponse { ok: false, error: Some(e.to_string()) },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("email.confirm: ошибка отправки ответа: {}", e);
    }
}

/// Проверить код из письма и подтвердить аккаунт. Код одноразовый, живёт
/// CODE_TTL_SECS, до CODE_MAX_ATTEMPTS попыток; счётчик атомарный (UPDATE …
/// RETURNING), поэтому перебор параллельными запросами не обходит лимит.
async fn do_email_confirm(pool: &SqlitePool, payload: &[u8]) -> Result<()> {
    let req: EmailConfirmRequest = serde_json::from_slice(payload)
        .context("неверный JSON в EmailConfirmRequest")?;
    let user = req.user.trim().to_string();
    let code = req.code.trim().to_string();
    if user.is_empty() || code.is_empty() {
        anyhow::bail!("пустой логин или код");
    }

    let row: Option<(String, i64, i64)> = sqlx::query_as(
        "UPDATE email_codes SET attempts = attempts + 1 WHERE username = ?
         RETURNING code_hash, expires_at, attempts",
    )
    .bind(&user)
    .fetch_optional(pool)
    .await?;
    let Some((hash, expires_at, attempts)) = row else {
        anyhow::bail!("код не запрошен или уже использован");
    };
    if now_unix() > expires_at {
        anyhow::bail!("код истёк, запросите новый");
    }
    if attempts > CODE_MAX_ATTEMPTS {
        anyhow::bail!("слишком много попыток, запросите новый код");
    }
    if !verify_password(&code, &hash) {
        anyhow::bail!("неверный код");
    }

    sqlx::query("UPDATE users SET email_verified = 1 WHERE username = ?")
        .bind(&user)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM email_codes WHERE username = ?")
        .bind(&user)
        .execute(pool)
        .await?;
    info!("Почта подтверждена: {}", user);
    Ok(())
}

/// Использовать инвайт-код (одноразовый). true — код существовал и не был
/// использован (пометили использованным). Только при инвайт-режиме.
async fn consume_invite(pool: &SqlitePool, code: &str) -> Result<bool> {
    if code.is_empty() {
        return Ok(false);
    }
    let res = sqlx::query(
        "UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL",
    )
    .bind(now_unix())
    .bind(code)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Простой лимит попыток регистрации в памяти: не более `PARVANE_REGISTER_RATE`
/// (по умолчанию 5) на логин за 60 секунд. Защита от массовой саморегистрации.
fn rate_ok(user: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static LIMITER: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    // Глобальный кэп поверх пер-логин: пер-логин лимит НЕ мешает спаму РАЗНЫМИ
    // логинами (каждый — свой bucket). Глобальный ловит массовую саморегистрацию
    // (в закрытом режиме за basic-auth это ещё и защита при утечке пароля сайта).
    static GLOBAL: OnceLock<Mutex<Vec<i64>>> = OnceLock::new();
    let limit: usize = std::env::var("PARVANE_REGISTER_RATE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let global_limit: usize = std::env::var("PARVANE_REGISTER_RATE_GLOBAL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let now = now_unix();

    let gmap = GLOBAL.get_or_init(|| Mutex::new(Vec::new()));
    {
        let mut g = gmap.lock().unwrap();
        g.retain(|&t| now - t < 60);
        if g.len() >= global_limit {
            return false;
        }
    }

    let map = LIMITER.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    let hits = guard.entry(user.to_string()).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    // Успешную попытку учитываем и в глобальном счётчике
    gmap.lock().unwrap().push(now);
    true
}

/// Dummy argon2-хэш постоянного времени: verify по нему для несуществующего
/// пользователя тратит то же время, что и реальная проверка (анти-timing).
fn dummy_password_hash() -> &'static str {
    use std::sync::OnceLock;
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| {
        // Валидный PHC-хэш случайного пароля; если генерация вдруг не удалась —
        // фиксированный корректный argon2id-хэш строки "parvane" (fallback).
        hash_password("parvane-timing-guard").unwrap_or_else(|_| {
            "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$\
             J6m5o0m0Zq0m0Zq0m0Zq0m0Zq0m0Zq0m0Zq0m0Zq0m0"
                .to_string()
        })
    })
}

// ── брутфорс-гейт логина (identity.token.issue) ───────────────────────────────

#[derive(Default)]
struct LoginBucket {
    /// Метки времени попыток в текущем частотном окне (60 c).
    attempts: Vec<i64>,
    /// Серия подряд идущих неудач (сбрасывается при верном пароле).
    fails: u32,
    /// Unix-время, до которого логин по этому ключу заблокирован.
    locked_until: i64,
}

fn login_limiter() -> &'static std::sync::Mutex<std::collections::HashMap<String, LoginBucket>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static L: OnceLock<Mutex<HashMap<String, LoginBucket>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// Пропускает попытку логина или отвергает её: частотный лимит на 60 c
/// (PARVANE_LOGIN_RATE, по умолчанию 10) и активный лок-аут после серии неудач.
fn login_gate_check(user: &str) -> Result<()> {
    let rate = env_u64("PARVANE_LOGIN_RATE", 10) as usize;
    let now = now_unix();
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    let bucket = guard.entry(user.to_string()).or_default();
    if bucket.locked_until > now {
        anyhow::bail!("слишком много неудачных попыток, попробуйте позже");
    }
    bucket.attempts.retain(|&t| now - t < 60);
    if bucket.attempts.len() >= rate {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    bucket.attempts.push(now);
    Ok(())
}

/// Учесть неудачную попытку и, при достижении порога, включить экспоненциальный
/// лок-аут: base * 2^(fails-threshold), но не дольше max.
fn login_record_failure(user: &str) {
    let threshold = env_u64("PARVANE_LOGIN_LOCK_THRESHOLD", 5) as u32;
    let base = env_u64("PARVANE_LOGIN_LOCK_BASE_SECS", 2);
    let max = env_u64("PARVANE_LOGIN_LOCK_MAX_SECS", 900);
    let now = now_unix();
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    let bucket = guard.entry(user.to_string()).or_default();
    bucket.fails = bucket.fails.saturating_add(1);
    if bucket.fails >= threshold {
        let over = (bucket.fails - threshold).min(20);
        let backoff = base.saturating_mul(1u64 << over).min(max);
        bucket.locked_until = now + backoff as i64;
    }
}

/// Верный пароль: снимаем лок-аут и счётчик неудач для этого логина.
fn login_record_success(user: &str) {
    let map = login_limiter();
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard.remove(user);
}

/// Частотный лимит фетча prekey-бандла по паре (запросивший → цель): не даёт
/// вычерпать one-time prekeys жертвы циклом фетчей. PARVANE_PREKEY_FETCH_RATE
/// (по умолчанию 20) запросов на пару за 60 c.
fn prekey_fetch_rate_ok(requester: &str, target: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static L: OnceLock<Mutex<HashMap<(String, String), Vec<i64>>>> = OnceLock::new();
    let limit = env_u64("PARVANE_PREKEY_FETCH_RATE", 20) as usize;
    let now = now_unix();
    let map = L.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    let hits = guard.entry((requester.to_string(), target.to_string())).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
}

async fn handle_verify(nc: &Client, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("verify: нет reply-топика, игнорирую");
        return;
    };

    let resp = match do_verify(decoding, &msg.payload) {
        Ok(user) => VerifyResponse { ok: true, user: Some(user), error: None },
        Err(e) => VerifyResponse { ok: false, user: None, error: Some(e.to_string()) },
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("verify: ошибка отправки ответа: {}", e);
    }
}

fn do_verify(decoding: &DecodingKey, payload: &[u8]) -> Result<String> {
    let req: VerifyRequest = serde_json::from_slice(payload)
        .context("неверный JSON в VerifyRequest")?;

    let validation = Validation::new(Algorithm::HS256);
    let data = decode::<Claims>(&req.token, decoding, &validation)
        .context("неверный или просроченный JWT")?;

    Ok(data.claims.sub)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_keys() -> (EncodingKey, DecodingKey) {
        let secret = b"test-secret-32-bytes-exactly!!!";
        (EncodingKey::from_secret(secret), DecodingKey::from_secret(secret))
    }

    #[test]
    fn jwt_roundtrip() {
        let (enc, dec) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600 };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &enc).unwrap();

        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        let user = do_verify(&dec, &req).unwrap();
        assert_eq!(user, "alice@local");
    }

    #[test]
    fn jwt_wrong_secret_rejected() {
        let (enc, _) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600 };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &enc).unwrap();

        let other_dec = DecodingKey::from_secret(b"different-secret-32-bytes-exactly");
        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        assert!(do_verify(&other_dec, &req).is_err());
    }

    #[test]
    fn password_verifies_correct_and_rejects_wrong() {
        let h = hash_password("secret").unwrap();
        assert!(verify_password("secret", &h));
        assert!(!verify_password("other", &h));
    }

    #[test]
    fn password_salted_each_hash_differs() {
        // argon2 со случайной солью: один пароль → разные хэши (но оба проходят).
        let a = hash_password("secret").unwrap();
        let b = hash_password("secret").unwrap();
        assert_ne!(a, b);
        assert!(verify_password("secret", &a) && verify_password("secret", &b));
    }

    // ── публичные ключи (для аутентификации сигналинга звонков) ──

    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn insert_user(pool: &SqlitePool, username: &str) {
        sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, '', 0)")
            .bind(username)
            .bind(username)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pubkey_defaults_empty_then_stores() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        // По умолчанию ключа нет.
        let (k0,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("alice@local")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(k0, "", "новый пользователь — без pubkey");
        // Регистрируем ключ.
        let key = B64.encode([1_u8; 32]);
        store_pubkey(&pool, "alice@local", &key).await.unwrap();
        // Читаем тем же SELECT, что использует resolve (display_name, avatar, pubkey).
        let row: (String, String, String) = sqlx::query_as(
            "SELECT display_name, avatar_file_id, pubkey FROM users WHERE username = ?",
        )
        .bind("alice@local")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.2, key, "resolve-путь отдаёт зарегистрированный ключ");
    }

    #[tokio::test]
    async fn pubkey_overwrite_replaces() {
        // Смена устройства/ключа — новый заменяет старый.
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;
        let key1 = B64.encode([1_u8; 32]);
        let key2 = B64_NO_PAD.encode([2_u8; 32]);
        store_pubkey(&pool, "bob@local", &key1).await.unwrap();
        store_pubkey(&pool, "bob@local", &key2).await.unwrap();
        let (k,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("bob@local")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(k, key2);
    }

    // ── регистрация отделена от логина ──

    fn issue_bytes(user: &str, password: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest { user: user.into(), password: password.into() }).unwrap()
    }
    fn register_bytes(user: &str, password: &str) -> Vec<u8> {
        register_bytes_email(user, password, "")
    }
    fn register_bytes_email(user: &str, password: &str, email: &str) -> Vec<u8> {
        serde_json::to_vec(&RegisterRequest {
            user: user.into(),
            password: password.into(),
            invite: String::new(),
            email: email.into(),
        })
        .unwrap()
    }
    fn confirm_bytes(user: &str, code: &str) -> Vec<u8> {
        serde_json::to_vec(&EmailConfirmRequest { user: user.into(), code: code.into() }).unwrap()
    }

    #[tokio::test]
    async fn issue_does_not_create_user() {
        // Регрессия безопасности: логин несуществующего юзера НЕ создаёт аккаунт.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        let err = do_issue(&pool, &enc, &issue_bytes("ghost@local", "pw")).await.unwrap_err();
        // Единая ошибка (анти-энумерация): не раскрываем, существует ли логин.
        assert!(err.to_string().contains("неверный логин или пароль"));
        let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE username = ?")
            .bind("ghost@local").fetch_one(&pool).await.unwrap();
        assert_eq!(cnt.0, 0, "аккаунт не должен быть создан логином");
    }

    #[tokio::test]
    async fn register_then_login() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        // регистрация создаёт аккаунт
        do_register(&pool, &register_bytes("newbie@local", "pw"), false).await.unwrap();
        // теперь логин проходит и выдаёт валидный JWT
        let token = do_issue(&pool, &enc, &issue_bytes("newbie@local", "pw")).await.unwrap();
        let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap();
        assert_eq!(user, "newbie@local");
        // неверный пароль — отказ
        assert!(do_issue(&pool, &enc, &issue_bytes("newbie@local", "wrong")).await.is_err());
    }

    #[tokio::test]
    async fn issue_indistinguishable_unknown_vs_wrong_password() {
        // Анти-энумерация: несуществующий юзер и неверный пароль — одна ошибка.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        do_register(&pool, &register_bytes("real@local", "pw"), false).await.unwrap();
        let e_unknown = do_issue(&pool, &enc, &issue_bytes("nouser@local", "pw"))
            .await
            .unwrap_err()
            .to_string();
        let e_wrong = do_issue(&pool, &enc, &issue_bytes("real@local", "bad"))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(e_unknown, e_wrong, "ошибки должны быть неотличимы");
        assert!(e_unknown.contains("неверный логин или пароль"));
    }

    #[tokio::test]
    async fn issue_locks_out_after_repeated_failures() {
        // После порога подряд идущих неудач логин временно блокируется даже с
        // верным паролем; PARVANE_LOGIN_LOCK_THRESHOLD берётся из env (по умолч. 5).
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        do_register(&pool, &register_bytes("lock@local", "pw"), false).await.unwrap();
        for _ in 0..5 {
            assert!(do_issue(&pool, &enc, &issue_bytes("lock@local", "bad")).await.is_err());
        }
        // теперь даже верный пароль отклонён (лок-аут активен)
        let err = do_issue(&pool, &enc, &issue_bytes("lock@local", "pw"))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("много"), "ожидался лок-аут: {err}");
    }

    #[test]
    fn prekey_fetch_rate_limits_per_pair() {
        // Пара (requester → target) ограничена; другая цель не затронута.
        let (a, victim, other) = ("rl_a@local", "rl_victim@local", "rl_other@local");
        let mut ok = 0;
        for _ in 0..25 {
            if prekey_fetch_rate_ok(a, victim) {
                ok += 1;
            }
        }
        assert!(ok <= 20, "лимит пары не превышен: {ok}");
        assert!(prekey_fetch_rate_ok(a, other), "другая цель — свой лимит");
    }

    // ── регистрация через почту (PARVANE_EMAIL_REQUIRED) ──

    #[tokio::test]
    async fn email_flow_register_confirm_login() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        let out = do_register(
            &pool,
            &register_bytes_email("mail@local", "pw", "user@example.com"),
            true,
        )
        .await
        .unwrap();
        assert!(out.confirm_required);
        let (email, code) = out.send.unwrap();
        assert_eq!(email, "user@example.com");
        assert_eq!(code.len(), 6);

        // логин до подтверждения — отказ с различимой ошибкой
        let err = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw")).await.unwrap_err();
        assert!(err.to_string().contains("почта не подтверждена"));

        // неверный код — отказ
        let wrong = if code == "000000" { "000001" } else { "000000" };
        assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", wrong)).await.is_err());

        // верный код подтверждает, повторно не работает (одноразовый)
        do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.unwrap();
        assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.is_err());

        let token = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw")).await.unwrap();
        let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap();
        assert_eq!(user, "mail@local");
    }

    #[tokio::test]
    async fn email_flow_requires_valid_email() {
        let pool = test_pool().await;
        for bad in ["", "no-at", "a@b", "a @b.com", "@x.com"] {
            let err = do_register(
                &pool,
                &register_bytes_email(&format!("u{}@local", bad.len()), "pw", bad),
                true,
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("email"), "'{bad}': {err}");
        }
    }

    #[tokio::test]
    async fn email_flow_reregister_resends_and_fixes_email() {
        let pool = test_pool().await;
        let out1 = do_register(
            &pool,
            &register_bytes_email("re@local", "pw", "typo@example.com"),
            true,
        )
        .await
        .unwrap();
        let (_, code1) = out1.send.unwrap();
        // повтор с тем же паролем — новый код и исправленный email
        let out2 = do_register(
            &pool,
            &register_bytes_email("re@local", "pw", "fixed@example.com"),
            true,
        )
        .await
        .unwrap();
        assert!(out2.confirm_required);
        let (email2, code2) = out2.send.unwrap();
        assert_eq!(email2, "fixed@example.com");
        if code1 != code2 {
            assert!(
                do_email_confirm(&pool, &confirm_bytes("re@local", &code1)).await.is_err(),
                "старый код должен быть отозван"
            );
        }
        // пустой email при повторе — перевысылка на сохранённую почту
        let out3 = do_register(&pool, &register_bytes_email("re@local", "pw", ""), true)
            .await
            .unwrap();
        let (email3, code3) = out3.send.unwrap();
        assert_eq!(email3, "fixed@example.com");
        do_email_confirm(&pool, &confirm_bytes("re@local", &code3)).await.unwrap();
        // подтверждённый логин чужим register больше не перехватить
        let err = do_register(
            &pool,
            &register_bytes_email("re@local", "other", "x@example.com"),
            true,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("занят"));
    }

    #[tokio::test]
    async fn email_flow_pending_login_protected_until_ttl() {
        let pool = test_pool().await;
        do_register(&pool, &register_bytes_email("pend@local", "pw", "p@example.com"), true)
            .await
            .unwrap();
        // чужой пароль на свежем pending — занят
        let err = do_register(
            &pool,
            &register_bytes_email("pend@local", "other", "x@example.com"),
            true,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("занят"));
        // просроченный pending освобождает логин
        sqlx::query("UPDATE users SET created_at = created_at - 200000 WHERE username = 'pend@local'")
            .execute(&pool)
            .await
            .unwrap();
        let out = do_register(
            &pool,
            &register_bytes_email("pend@local", "other", "x@example.com"),
            true,
        )
        .await
        .unwrap();
        assert!(out.confirm_required);
    }

    #[tokio::test]
    async fn email_code_attempts_limited() {
        let pool = test_pool().await;
        let out = do_register(
            &pool,
            &register_bytes_email("brute@local", "pw", "b@example.com"),
            true,
        )
        .await
        .unwrap();
        let (_, code) = out.send.unwrap();
        let wrong = if code == "999999" { "999998" } else { "999999" };
        for _ in 0..CODE_MAX_ATTEMPTS {
            assert!(do_email_confirm(&pool, &confirm_bytes("brute@local", wrong)).await.is_err());
        }
        // лимит исчерпан — даже верный код отклонён
        let err = do_email_confirm(&pool, &confirm_bytes("brute@local", &code)).await.unwrap_err();
        assert!(err.to_string().contains("много попыток"));
    }

    #[tokio::test]
    async fn register_without_email_flag_stays_verified() {
        // Флаг выключен (desktop и существующие e2e): аккаунт сразу активен.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        let out = do_register(&pool, &register_bytes("plain@local", "pw"), false).await.unwrap();
        assert!(!out.confirm_required);
        assert!(out.send.is_none());
        do_issue(&pool, &enc, &issue_bytes("plain@local", "pw")).await.unwrap();
    }

    #[tokio::test]
    async fn register_rejects_duplicate() {
        let pool = test_pool().await;
        do_register(&pool, &register_bytes("dup@local", "pw"), false).await.unwrap();
        let err = do_register(&pool, &register_bytes("dup@local", "other"), false).await.unwrap_err();
        assert!(err.to_string().contains("занят"));
    }

    // ── E2E prekey-каталог (Фаза 2) ──

    fn sample_publish(reg: i64, otps: &[(i64, &str)]) -> PublishPrekeysRequest {
        sample_publish_device("", reg, otps)
    }

    fn sample_publish_device(device_id: &str, reg: i64, otps: &[(i64, &str)]) -> PublishPrekeysRequest {
        PublishPrekeysRequest {
            token: String::new(),
            device_id: device_id.into(),
            signing_key: format!("SK-{device_id}=="),
            registration_id: reg,
            identity_key: format!("IK-{reg}=="),
            signed_prekey_id: 7,
            signed_prekey: "SPK==".into(),
            signed_prekey_sig: "SIG==".into(),
            one_time: otps
                .iter()
                .map(|(id, k)| parvane_types::OneTimePrekey { key_id: *id, public_key: (*k).into() })
                .collect(),
        }
    }

    #[tokio::test]
    async fn prekeys_publish_then_fetch_consumes_one_time() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        store_prekeys(&pool, "alice@local", &sample_publish(111, &[(1, "OTP1"), (2, "OTP2")]))
            .await
            .unwrap();

        // Первый fetch отдаёт бандл + одну one-time, помечает consumed.
        let b1 = fetch_bundle(&pool, "alice@local", &[]).await.unwrap();
        assert!(b1.ok);
        assert_eq!(b1.registration_id, Some(111));
        assert_eq!(b1.identity_key.as_deref(), Some("IK-111=="));
        assert!(b1.one_time_id.is_some() && b1.one_time.is_some(), "первая one-time выдана");

        // Второй fetch — другая one-time.
        let b2 = fetch_bundle(&pool, "alice@local", &[]).await.unwrap();
        assert!(b2.one_time_id.is_some());
        assert_ne!(b1.one_time_id, b2.one_time_id, "разные one-time");

        // Третий — one-time кончились, бандл без них (валидный фолбэк).
        let b3 = fetch_bundle(&pool, "alice@local", &[]).await.unwrap();
        assert!(b3.ok);
        assert!(b3.one_time_id.is_none(), "one-time исчерпаны");
        assert!(b3.identity_key.is_some(), "долгоживущие ключи всё равно есть");
    }

    #[tokio::test]
    async fn fetch_bundle_unknown_user() {
        let pool = test_pool().await;
        let b = fetch_bundle(&pool, "ghost@local", &[]).await.unwrap();
        assert!(!b.ok);
        assert!(b.identity_key.is_none());
        assert!(b.devices.is_empty());
    }

    #[tokio::test]
    async fn publish_prekeys_upsert_replaces_signed() {
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;
        store_prekeys(&pool, "bob@local", &sample_publish(1, &[])).await.unwrap();
        // повторная публикация с другим registration_id заменяет долгоживущие
        let mut req = sample_publish(999, &[(5, "NEW")]);
        req.signed_prekey_id = 42;
        store_prekeys(&pool, "bob@local", &req).await.unwrap();
        let b = fetch_bundle(&pool, "bob@local", &[]).await.unwrap();
        assert_eq!(b.registration_id, Some(999));
        assert_eq!(b.signed_prekey_id, Some(42));
    }

    // ── мультидевайс: бандлы на устройство ──

    #[tokio::test]
    async fn multidevice_bundles_coexist_and_fetch_returns_all() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        // desktop/legacy — устройство '', web — свой uuid: не перетирают друг друга
        store_prekeys(&pool, "alice@local", &sample_publish_device("", 1, &[(1, "L1")]))
            .await
            .unwrap();
        store_prekeys(&pool, "alice@local", &sample_publish_device("dev-web", 2, &[(1, "W1")]))
            .await
            .unwrap();

        let b = fetch_bundle(&pool, "alice@local", &[]).await.unwrap();
        assert!(b.ok);
        assert_eq!(b.devices.len(), 2, "оба устройства в списке");
        // legacy-поля — «primary» ('' приоритетно)
        assert_eq!(b.registration_id, Some(1));
        let web = b.devices.iter().find(|d| d.device_id == "dev-web").unwrap();
        assert_eq!(web.registration_id, 2);
        assert_eq!(web.one_time.as_deref(), Some("W1"), "one-time нового устройства выдана");
        assert_eq!(web.signing_key, "SK-dev-web==", "signing-ключ устройства едет в бандле");
    }

    #[tokio::test]
    async fn multidevice_known_devices_skip_one_time_consumption() {
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;
        store_prekeys(&pool, "bob@local", &sample_publish_device("dev-a", 1, &[(1, "A1")]))
            .await
            .unwrap();

        // known: one-time НЕ расходуется
        let b1 = fetch_bundle(&pool, "bob@local", &["dev-a".to_string()]).await.unwrap();
        let a1 = b1.devices.iter().find(|d| d.device_id == "dev-a").unwrap();
        assert!(a1.one_time.is_none(), "известное устройство — без one-time");

        // не known: расходуется та самая одна
        let b2 = fetch_bundle(&pool, "bob@local", &[]).await.unwrap();
        let a2 = b2.devices.iter().find(|d| d.device_id == "dev-a").unwrap();
        assert_eq!(a2.one_time.as_deref(), Some("A1"));
        let b3 = fetch_bundle(&pool, "bob@local", &[]).await.unwrap();
        assert!(b3.devices[0].one_time.is_none(), "one-time исчерпана");
    }

    #[tokio::test]
    async fn multidevice_identity_change_wipes_only_own_one_time() {
        let pool = test_pool().await;
        insert_user(&pool, "carol@local").await;
        store_prekeys(&pool, "carol@local", &sample_publish_device("dev-a", 1, &[(1, "A1")]))
            .await
            .unwrap();
        store_prekeys(&pool, "carol@local", &sample_publish_device("dev-b", 2, &[(1, "B1")]))
            .await
            .unwrap();
        // dev-a пере-инициализирован (новый identity_key) — его one-time вычищены
        store_prekeys(&pool, "carol@local", &sample_publish_device("dev-a", 3, &[(9, "A9")]))
            .await
            .unwrap();

        let b = fetch_bundle(&pool, "carol@local", &[]).await.unwrap();
        let a = b.devices.iter().find(|d| d.device_id == "dev-a").unwrap();
        let bb = b.devices.iter().find(|d| d.device_id == "dev-b").unwrap();
        assert_eq!(a.one_time.as_deref(), Some("A9"), "у dev-a только новая пачка");
        assert_eq!(bb.one_time.as_deref(), Some("B1"), "dev-b не пострадал");
    }

    // ── мультидевайс: листинг и отзыв устройств ──

    #[tokio::test]
    async fn device_list_counts_one_time_without_consuming() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        store_prekeys(&pool, "alice@local", &sample_publish_device("", 1, &[(1, "L1")]))
            .await
            .unwrap();
        store_prekeys(
            &pool,
            "alice@local",
            &sample_publish_device("dev-web", 2, &[(1, "W1"), (2, "W2")]),
        )
        .await
        .unwrap();

        let devices = list_devices(&pool, "alice@local").await.unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].device_id, "", "primary первым");
        assert_eq!(devices[0].one_time_available, 1);
        let web = devices.iter().find(|d| d.device_id == "dev-web").unwrap();
        assert_eq!(web.one_time_available, 2);
        assert_eq!(web.signing_key, "SK-dev-web==");

        // листинг ничего не сжёг: fetch по-прежнему выдаёт one-time обоим
        let b = fetch_bundle(&pool, "alice@local", &[]).await.unwrap();
        assert!(b.devices.iter().all(|d| d.one_time.is_some()), "one-time целы");
        // и остаток в листинге падает только после fetch
        let after = list_devices(&pool, "alice@local").await.unwrap();
        let web_after = after.iter().find(|d| d.device_id == "dev-web").unwrap();
        assert_eq!(web_after.one_time_available, 1);
    }

    #[tokio::test]
    async fn device_revoke_removes_bundle_and_one_time() {
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;
        store_prekeys(&pool, "bob@local", &sample_publish_device("", 1, &[(1, "L1")]))
            .await
            .unwrap();
        store_prekeys(&pool, "bob@local", &sample_publish_device("dev-old", 2, &[(1, "O1")]))
            .await
            .unwrap();

        assert!(revoke_device(&pool, "bob@local", "dev-old").await.unwrap());
        // повторный отзыв — «не найдено»
        assert!(!revoke_device(&pool, "bob@local", "dev-old").await.unwrap());

        // из каталога и fan-out-выдачи устройство исчезло, one-time вычищены
        let devices = list_devices(&pool, "bob@local").await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, "");
        let b = fetch_bundle(&pool, "bob@local", &[]).await.unwrap();
        assert!(b.devices.iter().all(|d| d.device_id != "dev-old"));
        let (orphans,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM one_time_prekeys WHERE username = ? AND device_id = ?",
        )
        .bind("bob@local")
        .bind("dev-old")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(orphans, 0, "one-time отозванного устройства удалены");
    }

    #[tokio::test]
    async fn device_revoke_is_scoped_to_owner() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        insert_user(&pool, "eve@local").await;
        store_prekeys(&pool, "alice@local", &sample_publish_device("dev-a", 1, &[(1, "A1")]))
            .await
            .unwrap();

        // eve «отзывает» устройство alice — по своему username ничего не найдено
        assert!(!revoke_device(&pool, "eve@local", "dev-a").await.unwrap());
        let devices = list_devices(&pool, "alice@local").await.unwrap();
        assert_eq!(devices.len(), 1, "устройство alice на месте");
    }

    // ── линковка: офферы и одноразовые гранты ──

    #[tokio::test]
    async fn link_offer_poll_grant_roundtrip() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;

        // Новое устройство публикует оффер; старое видит его в poll
        store_link_offer(&pool, "alice@local", "dev-new", "EPH-NEW==").await.unwrap();
        let (offers, grant) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].device_id, "dev-new");
        assert_eq!(offers[0].eph_pub, "EPH-NEW==");
        assert!(grant.is_none());
        // Своего оффера устройство в poll не видит
        let (own_offers, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
        assert!(own_offers.is_empty());

        // Старое выдаёт грант — оффер гасится, целевое устройство получает
        // грант РОВНО один раз
        store_link_grant(&pool, "alice@local", "dev-new", "BOX==", "EPH-OLD==").await.unwrap();
        let (offers_after, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
        assert!(offers_after.is_empty(), "оффер погашен грантом");
        let (_, g1) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
        let g1 = g1.expect("грант выдан");
        assert_eq!(g1.box_payload, "BOX==");
        assert_eq!(g1.eph_pub, "EPH-OLD==");
        let (_, g2) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
        assert!(g2.is_none(), "грант одноразовый");
    }

    #[tokio::test]
    async fn link_grant_requires_live_offer_and_reoffer_voids_grant() {
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;

        // Грант без оффера — отказ
        let err = store_link_grant(&pool, "bob@local", "dev-x", "BOX==", "EPH==")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("оффер"));

        // Повторный оффер заменяет прежний и гасит уже выданный грант
        // (он зашифрован на потерянный эфемерный ключ)
        store_link_offer(&pool, "bob@local", "dev-x", "EPH-1==").await.unwrap();
        store_link_grant(&pool, "bob@local", "dev-x", "BOX-1==", "EPH-OLD==").await.unwrap();
        store_link_offer(&pool, "bob@local", "dev-x", "EPH-2==").await.unwrap();
        let (_, grant) = poll_link(&pool, "bob@local", "dev-x").await.unwrap();
        assert!(grant.is_none(), "грант под старый эфемерный ключ погашен");
    }

    #[tokio::test]
    async fn link_offer_retraction_clears_offer_and_grant() {
        let pool = test_pool().await;
        insert_user(&pool, "carol@local").await;
        store_link_offer(&pool, "carol@local", "dev-n", "EPH==").await.unwrap();
        // Отзыв (пустой eph) гасит оффер
        store_link_offer(&pool, "carol@local", "dev-n", "").await.unwrap();
        let (offers, _) = poll_link(&pool, "carol@local", "dev-other").await.unwrap();
        assert!(offers.is_empty(), "отозванный оффер не виден");

        // Отзыв гасит и уже выданный грант
        store_link_offer(&pool, "carol@local", "dev-n", "EPH-2==").await.unwrap();
        store_link_grant(&pool, "carol@local", "dev-n", "BOX==", "EPH-O==").await.unwrap();
        store_link_offer(&pool, "carol@local", "dev-n", "").await.unwrap();
        let (_, grant) = poll_link(&pool, "carol@local", "dev-n").await.unwrap();
        assert!(grant.is_none(), "отзыв гасит невостребованный грант");
    }

    #[tokio::test]
    async fn link_is_scoped_per_user_and_expires() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        insert_user(&pool, "eve@local").await;

        store_link_offer(&pool, "alice@local", "dev-new", "EPH==").await.unwrap();
        // Чужой аккаунт офферов не видит и грант выдать не может
        let (offers, _) = poll_link(&pool, "eve@local", "dev-eve").await.unwrap();
        assert!(offers.is_empty());
        assert!(store_link_grant(&pool, "eve@local", "dev-new", "BOX==", "EPH==").await.is_err());

        // Просроченный оффер исчезает
        sqlx::query("UPDATE link_offers SET created_at = created_at - 100000")
            .execute(&pool)
            .await
            .unwrap();
        let (stale, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
        assert!(stale.is_empty(), "просроченный оффер вычищен");
    }

    #[tokio::test]
    async fn pubkey_isolated_per_user() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        insert_user(&pool, "bob@local").await;
        let alice_key = B64.encode([7_u8; 32]);
        store_pubkey(&pool, "alice@local", &alice_key).await.unwrap();
        // ключ bob не задан — остаётся пустым, ключ alice не протёк
        let (ka,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("alice@local").fetch_one(&pool).await.unwrap();
        let (kb,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("bob@local").fetch_one(&pool).await.unwrap();
        assert_eq!(ka, alice_key);
        assert_eq!(kb, "", "ключ bob не задан → пусто");
    }

    #[tokio::test]
    async fn pubkey_rejects_non_ed25519_values() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;

        assert!(store_pubkey(&pool, "alice@local", "not-a-key").await.is_err());
        let (stored,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("alice@local").fetch_one(&pool).await.unwrap();
        assert!(stored.is_empty());
    }
}
