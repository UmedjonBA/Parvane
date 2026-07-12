use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use parvane_types::{
    FetchBundleRequest, FetchBundleResponse, IssueRequest, IssueResponse, PublishPrekeysRequest,
    PublishPrekeysResponse, RegisterRequest, RegisterResponse, ResolveRequest, ResolveResponse,
    SearchUsersRequest, SearchUsersResponse, SetAvatarRequest, SetKeyRequest, SetNameRequest,
    SetNameResponse, UserInfo, VerifyRequest, VerifyResponse,
    topics::{
        IDENTITY_ISSUE, IDENTITY_PREKEYS_FETCH, IDENTITY_PREKEYS_PUBLISH, IDENTITY_REGISTER,
        IDENTITY_RESOLVE, IDENTITY_SEARCH, IDENTITY_SETAVATAR, IDENTITY_SETKEY, IDENTITY_SETNAME,
        IDENTITY_VERIFY,
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
    let mut verify_sub = nc.subscribe(IDENTITY_VERIFY).await?;
    let mut search_sub = nc.subscribe(IDENTITY_SEARCH).await?;
    let mut setname_sub = nc.subscribe(IDENTITY_SETNAME).await?;
    let mut setavatar_sub = nc.subscribe(IDENTITY_SETAVATAR).await?;
    let mut setkey_sub = nc.subscribe(IDENTITY_SETKEY).await?;
    let mut resolve_sub = nc.subscribe(IDENTITY_RESOLVE).await?;
    let mut pkpub_sub = nc.subscribe(IDENTITY_PREKEYS_PUBLISH).await?;
    let mut pkfetch_sub = nc.subscribe(IDENTITY_PREKEYS_FETCH).await?;

    info!("Identity шард запущен. Слушаю: issue/register/verify/search/setname/setavatar/setkey/resolve/prekeys");

    loop {
        tokio::select! {
            Some(msg) = issue_sub.next() => {
                handle_issue(&nc, &pool, &encoding, msg).await;
            }
            Some(msg) = register_sub.next() => {
                handle_register(&nc, &pool, msg).await;
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

/// Сохранить/обновить бандл пользователя: долгоживущие ключи (UPSERT) + пачка
/// одноразовых (INSERT OR IGNORE — key_id уникален на пользователя).
///
/// Смена identity_key = пере-инициализация устройства (новый Olm-аккаунт):
/// все прежние one-time принадлежат СТАРОМУ устройству и для X3DH с новым
/// невалидны (а из-за коллизий key_id новые бы игнорировались) — вычищаем.
async fn store_prekeys(pool: &SqlitePool, username: &str, req: &PublishPrekeysRequest) -> Result<()> {
    let prev: Option<(String,)> =
        sqlx::query_as("SELECT identity_key FROM device_keys WHERE username = ?")
            .bind(username)
            .fetch_optional(pool)
            .await
            .context("чтение прежнего identity_key")?;
    let device_changed = prev.map(|(k,)| k != req.identity_key).unwrap_or(false);
    if device_changed {
        sqlx::query("DELETE FROM one_time_prekeys WHERE username = ?")
            .bind(username)
            .execute(pool)
            .await
            .context("очистка one_time старого устройства")?;
    }
    sqlx::query(
        "INSERT INTO device_keys
           (username, registration_id, identity_key, signed_prekey_id,
            signed_prekey, signed_prekey_sig, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
            registration_id = excluded.registration_id,
            identity_key = excluded.identity_key,
            signed_prekey_id = excluded.signed_prekey_id,
            signed_prekey = excluded.signed_prekey,
            signed_prekey_sig = excluded.signed_prekey_sig,
            updated_at = excluded.updated_at",
    )
    .bind(username)
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
            "INSERT OR IGNORE INTO one_time_prekeys (username, key_id, public_key)
             VALUES (?, ?, ?)",
        )
        .bind(username)
        .bind(otp.key_id)
        .bind(&otp.public_key)
        .execute(pool)
        .await
        .context("сохранение one_time")?;
    }
    Ok(())
}

/// Бандл собеседника для X3DH. Атомарно снимает одну доступную one-time
/// (UPDATE … RETURNING — без гонки). Если ключей нет — ok=false; если нет
/// одноразовых — бандл без них (валидный X3DH-фолбэк).
async fn fetch_bundle(pool: &SqlitePool, username: &str) -> Result<FetchBundleResponse> {
    let dk: Option<(i64, String, i64, String, String)> = sqlx::query_as(
        "SELECT registration_id, identity_key, signed_prekey_id, signed_prekey, signed_prekey_sig
         FROM device_keys WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    let Some((reg, ik, spid, sp, sig)) = dk else {
        return Ok(FetchBundleResponse {
            ok: false,
            registration_id: None,
            identity_key: None,
            signed_prekey_id: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            one_time_id: None,
            one_time: None,
            error: Some("нет ключей пользователя".into()),
        });
    };
    // Атомарно взять и пометить одну доступную one-time.
    let otp: Option<(i64, String)> = sqlx::query_as(
        "UPDATE one_time_prekeys SET consumed = 1
         WHERE rowid = (SELECT rowid FROM one_time_prekeys
                        WHERE username = ? AND consumed = 0 ORDER BY key_id LIMIT 1)
         RETURNING key_id, public_key",
    )
    .bind(username)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);
    Ok(FetchBundleResponse {
        ok: true,
        registration_id: Some(reg),
        identity_key: Some(ik),
        signed_prekey_id: Some(spid),
        signed_prekey: Some(sp),
        signed_prekey_sig: Some(sig),
        one_time_id: otp.as_ref().map(|(k, _)| *k),
        one_time: otp.map(|(_, p)| p),
        error: None,
    })
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
                    info!("{} опубликовал prekeys ({} one-time)", username, req.one_time.len());
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
            Ok(_requester) => fetch_bundle(pool, &req.user).await.unwrap_or_else(|e| {
                FetchBundleResponse {
                    ok: false,
                    registration_id: None,
                    identity_key: None,
                    signed_prekey_id: None,
                    signed_prekey: None,
                    signed_prekey_sig: None,
                    one_time_id: None,
                    one_time: None,
                    error: Some(e.to_string()),
                }
            }),
            Err(e) => FetchBundleResponse {
                ok: false,
                registration_id: None,
                identity_key: None,
                signed_prekey_id: None,
                signed_prekey: None,
                signed_prekey_sig: None,
                one_time_id: None,
                one_time: None,
                error: Some(e.to_string()),
            },
        },
        Err(e) => FetchBundleResponse {
            ok: false,
            registration_id: None,
            identity_key: None,
            signed_prekey_id: None,
            signed_prekey: None,
            signed_prekey_sig: None,
            one_time_id: None,
            one_time: None,
            error: Some(e.to_string()),
        },
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

    // Логин: пользователь ОБЯЗАН существовать. Создание аккаунтов — только через
    // identity.user.register (раньше issue молча создавал юзера с любым паролем —
    // это позволяло занять любой адрес первым запросом).
    let row: Option<(String,)> =
        sqlx::query_as("SELECT password_hash FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_optional(pool)
            .await?;
    let Some((hash,)) = row else {
        anyhow::bail!("нет такого пользователя");
    };
    if !verify_password(&req.password, &hash) {
        anyhow::bail!("неверный пароль");
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
    let resp = match do_register(pool, &msg.payload).await {
        Ok(()) => RegisterResponse { ok: true, error: None },
        Err(e) => RegisterResponse { ok: false, error: Some(e.to_string()) },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("register: ошибка отправки ответа: {}", e);
    }
}

/// Создать аккаунт. Отвергает занятый логин, пустые поля, превышение лимита
/// попыток и (при PARVANE_INVITE_REQUIRED=1) отсутствие валидного инвайта.
async fn do_register(pool: &SqlitePool, payload: &[u8]) -> Result<()> {
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

    // Инвайт-режим за флагом окружения (закрытый пузырь).
    if std::env::var("PARVANE_INVITE_REQUIRED").as_deref() == Ok("1")
        && !consume_invite(pool, &req.invite).await?
    {
        anyhow::bail!("нужен валидный инвайт-код");
    }

    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE username = ?")
            .bind(&user)
            .fetch_optional(pool)
            .await?;
    if existing.is_some() {
        anyhow::bail!("логин занят");
    }

    let hash = hash_password(&req.password)?;
    let id = Uuid::now_v7().to_string();
    let now = now_unix();
    // Отображаемое имя по умолчанию — локальная часть адреса (до '@').
    let default_name = user.split('@').next().unwrap_or(&user).to_string();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, created_at, display_name)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user)
    .bind(&hash)
    .bind(now)
    .bind(&default_name)
    .execute(pool)
    .await?;
    info!("Пользователь зарегистрирован: {} (имя: {})", user, default_name);
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
    let limit: usize = std::env::var("PARVANE_REGISTER_RATE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let now = now_unix();
    let map = LIMITER.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    let hits = guard.entry(user.to_string()).or_default();
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
        store_pubkey(&pool, "alice@local", "BASE64KEY==").await.unwrap();
        // Читаем тем же SELECT, что использует resolve (display_name, avatar, pubkey).
        let row: (String, String, String) = sqlx::query_as(
            "SELECT display_name, avatar_file_id, pubkey FROM users WHERE username = ?",
        )
        .bind("alice@local")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.2, "BASE64KEY==", "resolve-путь отдаёт зарегистрированный ключ");
    }

    #[tokio::test]
    async fn pubkey_overwrite_replaces() {
        // Смена устройства/ключа — новый заменяет старый.
        let pool = test_pool().await;
        insert_user(&pool, "bob@local").await;
        store_pubkey(&pool, "bob@local", "KEY1").await.unwrap();
        store_pubkey(&pool, "bob@local", "KEY2").await.unwrap();
        let (k,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("bob@local")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(k, "KEY2");
    }

    // ── регистрация отделена от логина ──

    fn issue_bytes(user: &str, password: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest { user: user.into(), password: password.into() }).unwrap()
    }
    fn register_bytes(user: &str, password: &str) -> Vec<u8> {
        serde_json::to_vec(&RegisterRequest {
            user: user.into(),
            password: password.into(),
            invite: String::new(),
        })
        .unwrap()
    }

    #[tokio::test]
    async fn issue_does_not_create_user() {
        // Регрессия безопасности: логин несуществующего юзера НЕ создаёт аккаунт.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        let err = do_issue(&pool, &enc, &issue_bytes("ghost@local", "pw")).await.unwrap_err();
        assert!(err.to_string().contains("нет такого пользователя"));
        let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE username = ?")
            .bind("ghost@local").fetch_one(&pool).await.unwrap();
        assert_eq!(cnt.0, 0, "аккаунт не должен быть создан логином");
    }

    #[tokio::test]
    async fn register_then_login() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        // регистрация создаёт аккаунт
        do_register(&pool, &register_bytes("newbie@local", "pw")).await.unwrap();
        // теперь логин проходит и выдаёт валидный JWT
        let token = do_issue(&pool, &enc, &issue_bytes("newbie@local", "pw")).await.unwrap();
        let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap();
        assert_eq!(user, "newbie@local");
        // неверный пароль — отказ
        assert!(do_issue(&pool, &enc, &issue_bytes("newbie@local", "wrong")).await.is_err());
    }

    #[tokio::test]
    async fn register_rejects_duplicate() {
        let pool = test_pool().await;
        do_register(&pool, &register_bytes("dup@local", "pw")).await.unwrap();
        let err = do_register(&pool, &register_bytes("dup@local", "other")).await.unwrap_err();
        assert!(err.to_string().contains("занят"));
    }

    // ── E2E prekey-каталог (Фаза 2) ──

    fn sample_publish(reg: i64, otps: &[(i64, &str)]) -> PublishPrekeysRequest {
        PublishPrekeysRequest {
            token: String::new(),
            registration_id: reg,
            identity_key: "IK==".into(),
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
        let b1 = fetch_bundle(&pool, "alice@local").await.unwrap();
        assert!(b1.ok);
        assert_eq!(b1.registration_id, Some(111));
        assert_eq!(b1.identity_key.as_deref(), Some("IK=="));
        assert!(b1.one_time_id.is_some() && b1.one_time.is_some(), "первая one-time выдана");

        // Второй fetch — другая one-time.
        let b2 = fetch_bundle(&pool, "alice@local").await.unwrap();
        assert!(b2.one_time_id.is_some());
        assert_ne!(b1.one_time_id, b2.one_time_id, "разные one-time");

        // Третий — one-time кончились, бандл без них (валидный фолбэк).
        let b3 = fetch_bundle(&pool, "alice@local").await.unwrap();
        assert!(b3.ok);
        assert!(b3.one_time_id.is_none(), "one-time исчерпаны");
        assert!(b3.identity_key.is_some(), "долгоживущие ключи всё равно есть");
    }

    #[tokio::test]
    async fn fetch_bundle_unknown_user() {
        let pool = test_pool().await;
        let b = fetch_bundle(&pool, "ghost@local").await.unwrap();
        assert!(!b.ok);
        assert!(b.identity_key.is_none());
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
        let b = fetch_bundle(&pool, "bob@local").await.unwrap();
        assert_eq!(b.registration_id, Some(999));
        assert_eq!(b.signed_prekey_id, Some(42));
    }

    #[tokio::test]
    async fn pubkey_isolated_per_user() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        insert_user(&pool, "bob@local").await;
        store_pubkey(&pool, "alice@local", "ALICEKEY").await.unwrap();
        // ключ bob не задан — остаётся пустым, ключ alice не протёк
        let (ka,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("alice@local").fetch_one(&pool).await.unwrap();
        let (kb,): (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("bob@local").fetch_one(&pool).await.unwrap();
        assert_eq!(ka, "ALICEKEY");
        assert_eq!(kb, "", "ключ bob не задан → пусто");
    }
}
