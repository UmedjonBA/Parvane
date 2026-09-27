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
    RegisterStatusRequest, RegisterStatusResponse, ResolveRequest, ResolveResponse,
    SearchUsersRequest, SearchUsersResponse, ServerInfoResponse, SetAvatarRequest, SetKeyRequest,
    SetNameRequest, SetNameResponse, TelegramConfirmRequest, TelegramConfirmResponse,
    TwoFactorRequest, TwoFactorResponse, UserInfo, VerifyRequest, VerifyResponse,
    topics::{
        IDENTITY_DEVICE_LIST, IDENTITY_DEVICE_REVOKE, IDENTITY_EMAIL_CONFIRM, IDENTITY_ISSUE,
        IDENTITY_PASSWORD_CHANGE,
        IDENTITY_LINK_GRANT, IDENTITY_LINK_CHALLENGE, IDENTITY_LINK_OFFER, IDENTITY_LINK_POLL, IDENTITY_PREKEYS_FETCH,
        IDENTITY_PREKEYS_PUBLISH, IDENTITY_REGISTER, IDENTITY_REGISTER_STATUS, IDENTITY_RESOLVE,
        IDENTITY_SEARCH, IDENTITY_SERVER_INFO, IDENTITY_SETAVATAR, IDENTITY_SETKEY,
        IDENTITY_SETNAME, IDENTITY_TELEGRAM_CONFIRM, IDENTITY_TWOFA, IDENTITY_VERIFY,
    },
    PasswordChangeRequest, PasswordChangeResponse, LinkChallengeRequest, LinkChallengeResponse,
};

mod auth;
mod ratelimit;
mod users;
mod prekeys;
mod devices;
mod link;
mod login;
mod register;
pub(crate) use auth::*;
pub(crate) use ratelimit::*;
pub(crate) use users::*;
pub(crate) use prekeys::*;
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

    let mut issue_sub = nc.subscribe(IDENTITY_ISSUE).await?;
    let mut register_sub = nc.subscribe(IDENTITY_REGISTER).await?;
    let mut email_confirm_sub = nc.subscribe(IDENTITY_EMAIL_CONFIRM).await?;
    let mut server_info_sub = nc.subscribe(IDENTITY_SERVER_INFO).await?;
    let mut telegram_confirm_sub = nc.subscribe(IDENTITY_TELEGRAM_CONFIRM).await?;
    let mut register_status_sub = nc.subscribe(IDENTITY_REGISTER_STATUS).await?;
    let mut twofa_sub = nc.subscribe(IDENTITY_TWOFA).await?;
    let mut password_change_sub = nc.subscribe(IDENTITY_PASSWORD_CHANGE).await?;
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
    let mut linkchallenge_sub = nc.subscribe(IDENTITY_LINK_CHALLENGE).await?;

    info!(
        "Identity шард запущен (домен {}, подтверждение регистрации: {}). Слушаю: issue/register/email.confirm/telegram.confirm/register.status/server.info/verify/search/setname/setavatar/setkey/resolve/prekeys/devices",
        server_domain(),
        confirm_mode().as_str()
    );

    // 4.5: обработчики в tokio::spawn под семафором — один медленный запрос
    // (argon2, SMTP, Telegram) больше не стопорит все остальные.
    let handlers = std::sync::Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    loop {
        tokio::select! {
            Some(msg) = issue_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let encoding = encoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_issue(&nc, &pool, &encoding, msg).await; });
            }
            Some(msg) = register_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone();
                tokio::spawn(async move { let _permit = permit; handle_register(&nc, &pool, msg).await; });
            }
            Some(msg) = email_confirm_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone();
                tokio::spawn(async move { let _permit = permit; handle_email_confirm(&nc, &pool, msg).await; });
            }
            Some(msg) = server_info_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone();
                tokio::spawn(async move { let _permit = permit; handle_server_info(&nc, msg).await; });
            }
            Some(msg) = telegram_confirm_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone();
                tokio::spawn(async move { let _permit = permit; handle_telegram_confirm(&nc, &pool, msg).await; });
            }
            Some(msg) = register_status_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone();
                tokio::spawn(async move { let _permit = permit; handle_register_status(&nc, &pool, msg).await; });
            }
            Some(msg) = twofa_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_twofa(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = password_change_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_password_change(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = verify_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let decoding = decoding.clone(); let pool = pool.clone();
                tokio::spawn(async move { let _permit = permit; handle_verify(&nc, &decoding, &pool, msg).await; });
            }
            Some(msg) = search_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_search(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = setname_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_setname(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = setavatar_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_setavatar(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = setkey_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_setkey(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = resolve_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_resolve(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = pkpub_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_prekeys_publish(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = pkfetch_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_prekeys_fetch(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = devlist_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_device_list(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = devrevoke_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_device_revoke(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = linkoffer_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_link_offer(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = linkpoll_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_link_poll(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = linkgrant_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_link_grant(&nc, &pool, &decoding, msg).await; });
            }
            Some(msg) = linkchallenge_sub.next() => {
                let permit = handlers.clone().acquire_owned().await;
                let nc = nc.clone(); let pool = pool.clone(); let decoding = decoding.clone();
                tokio::spawn(async move { let _permit = permit; handle_link_challenge(&nc, &pool, &decoding, msg).await; });
            }
        }
    }
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
