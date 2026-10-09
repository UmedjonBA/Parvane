use anyhow::{Context, Result};
use async_nats::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use parvane_types::{
    DeviceInfo,
    EmailConfirmRequest, EmailConfirmResponse,
    IssueRequest, IssueResponse, LinkGrantInfo, LinkGrantRequest, LinkGrantResponse,
    LinkOfferInfo, LinkOfferRequest, LinkOfferResponse, LinkPollRequest, LinkPollResponse, RegisterRequest, RegisterResponse,
    RegisterStatusRequest, RegisterStatusResponse, ResolveRequest, ResolveResponse,
    SearchUsersRequest, SearchUsersResponse, SetAvatarRequest,
    SetNameRequest, SetNameResponse, TelegramConfirmRequest, TelegramConfirmResponse,
    TwoFactorRequest, TwoFactorResponse, UserInfo, VerifyRequest, VerifyResponse,
    topics::IDENTITY_VERIFY,
    PasswordChangeRequest, PasswordChangeResponse, LinkChallengeRequest, LinkChallengeResponse,
};

mod auth;
mod ratelimit;
mod users;
mod prekeys;
#[allow(unused_imports)]
pub(crate) use prekeys::*;
mod devices;
mod link;
mod login;
mod recovery_tg;
mod register;
mod server_key;
mod v2;
pub(crate) use auth::*;
pub(crate) use ratelimit::*;
pub(crate) use users::*;
pub(crate) use devices::*;
pub(crate) use link::*;
pub(crate) use login::*;
pub(crate) use register::*;

#[cfg(test)]
mod tests;

fn opt(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}
use rand::RngCore;
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

// ── JWT claims ───────────────────────────────────────────────────────────────

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

    // P-38: общий коннект (WAL, busy_timeout 30 с) — см. parvane-db
    let pool = parvane_db::connect(&db_path).await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let (encoding, decoding) = load_or_create_jwt_keys(&pool, &db_path).await?;

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    // Протокол v2 (spec 007, E1): ключ сервера, описатель, методы реестра.
    let server_key = server_key::load_or_create_server_key(&db_path)?;
    server_key::write_well_known(&server_key);
    let v2_pool = v2::open_store(&db_path).await?;
    let token_dir = std::env::var("PARVANE_TOKEN_KEY_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(&db_path).parent().unwrap_or(std::path::Path::new(".")).join("token-keys"));
    v2::run(
        nc.clone(),
        std::sync::Arc::new(v2::V2Ctx {
            pool: pool.clone(),
            v2: v2_pool,
            server_key,
            encoding: encoding.clone(),
            decoding: decoding.clone(),
            nc: nc.clone(),
            token_dir,
            issuers: tokio::sync::RwLock::new(Vec::new()),
        }),
    )
    .await?;

    // T110: клиентские v1-subject'ы identity.* удалены — клиенты ходят методами v2
    // (identity.account.*, session.*, device.*, link.*, profile.*; те же
    // обработчики вызываются из v2.rs в процессе). Остаётся только внутренняя
    // проверка JWT для gateway и шардов.
    let mut verify_sub = nc.subscribe(IDENTITY_VERIFY).await?;

    info!(
        "Identity шард запущен (домен {}, подтверждение регистрации: {}; протокол v2 + identity.token.verify)",
        server_domain(),
        confirm_mode().as_str()
    );

    info!(
        "Копия корня для администратора: {}",
        if escrow_public_key().is_some() { "включена (PARVANE_ESCROW_PUBLIC_KEY)" } else { "выключена" }
    );

    // 4.5: обработчики в tokio::spawn под семафором — один медленный запрос
    // (argon2, SMTP, Telegram) больше не стопорит все остальные.
    let handlers = std::sync::Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    while let Some(msg) = verify_sub.next().await {
        let permit = handlers.clone().acquire_owned().await;
        let nc = nc.clone();
        let pool = pool.clone();
        let decoding = decoding.clone();
        tokio::spawn(async move {
            let _permit = permit;
            handle_verify(&nc, &decoding, &pool, msg).await;
        });
    }
    Ok(())
}

/// Параллелизм обработчиков (PARVANE_HANDLER_CONCURRENCY, по умолчанию 64).
fn handler_concurrency() -> usize {
    std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(64)
}

// ── адреса: домен сервера и правила ников ─────────────────────────────────────

/// Домен адресов этого сервера (`PARVANE_DOMAIN`, по умолчанию `local`).
/// Ник без `@` в запросах логина/регистрации дополняется до `ник@домен`.
fn server_domain() -> String {
    std::env::var("PARVANE_DOMAIN")
        .ok()
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

/// Как подтверждается новый аккаунт. Telegram (`PARVANE_TELEGRAM_BOT` +
/// `PARVANE_TELEGRAM_SECRET`) имеет приоритет над почтой
/// (`PARVANE_EMAIL_REQUIRED=1`); без обоих — аккаунт активен сразу.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmMode {
    None,
    Email,
    Telegram,
}

impl ConfirmMode {
    fn as_str(self) -> &'static str {
        match self {
            ConfirmMode::None => "none",
            ConfirmMode::Email => "email",
            ConfirmMode::Telegram => "telegram",
        }
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn telegram_bot() -> Option<String> {
    env_nonempty("PARVANE_TELEGRAM_BOT").map(|b| b.trim_start_matches('@').to_string())
}

/// Открытый ключ администратора для копий корня (`PARVANE_ESCROW_PUBLIC_KEY`,
/// base64url без дополнения, 32 байта; выдаёт `escrow_admin keygen`). Закрытого
/// ключа на сервере нет. Не задан или испорчен — страховка выключена.
fn escrow_public_key() -> Option<[u8; 32]> {
    use base64::Engine as _;
    let raw = env_nonempty("PARVANE_ESCROW_PUBLIC_KEY")?;
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw.trim_end_matches('=')) {
        Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
            Ok(key) => Some(key),
            Err(_) => {
                tracing::error!("PARVANE_ESCROW_PUBLIC_KEY: нужен ключ в 32 байта, страховка корня выключена");
                None
            }
        },
        Err(e) => {
            tracing::error!("PARVANE_ESCROW_PUBLIC_KEY: не base64url ({e}), страховка корня выключена");
            None
        }
    }
}

fn telegram_secret() -> Option<String> {
    env_nonempty("PARVANE_TELEGRAM_SECRET")
}

fn confirm_mode() -> ConfirmMode {
    if telegram_bot().is_some() && telegram_secret().is_some() {
        ConfirmMode::Telegram
    } else if std::env::var("PARVANE_EMAIL_REQUIRED").as_deref() == Ok("1") {
        ConfirmMode::Email
    } else {
        ConfirmMode::None
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
