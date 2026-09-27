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

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
    /// device_id устройства (если клиент его сообщил при issue)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dev: Option<String>,
}

// ── JWT-ключи (P-11) ──────────────────────────────────────────────────────────
// Раньше HS256-секрет лежал в той же SQLite, что и хэши паролей: утечка
// identity.db или её незашифрованного бэкапа = подпись JWT за любого. Теперь
// подпись — Ed25519 (EdDSA, как заявляет README) ключом из файла
// PARVANE_JWT_KEY_FILE (PKCS#8 PEM, права 0600; по умолчанию рядом с БД).
// Старый HS256-секрет при первом старте выносится из БД в
// `<key>.legacy-hs256` и принимается ТОЛЬКО для проверки уже выданных токенов
// в течение их срока жизни (24 ч), затем игнорируется и удаляется.

/// Срок, в течение которого после миграции ещё принимаются HS256-токены.
const LEGACY_HS256_WINDOW_SECS: i64 = 86_400;

/// kid текущего Ed25519-ключа (в заголовке JWT) — задаётся при старте.
static JWT_KID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// Legacy HS256-ключ и момент, до которого он принимается.
static LEGACY_HS256: std::sync::LazyLock<std::sync::RwLock<Option<(DecodingKey, i64)>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

fn jwt_key_path(db_path: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PARVANE_JWT_KEY_FILE") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let dir = std::path::Path::new(db_path).parent().unwrap_or(std::path::Path::new("."));
    dir.join("identity-jwt-ed25519.pem")
}

/// Запись секретного файла с правами 0600 (unix); на других ОС — обычная запись.
fn write_secret_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).with_context(|| format!("создание {}", path.display()))?;
    f.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn kid_for(verifying: &ed25519_dalek::VerifyingKey) -> String {
    verifying.as_bytes().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn keys_from_signing(signing: &ed25519_dalek::SigningKey) -> Result<(EncodingKey, DecodingKey, String)> {
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
    let private_pem = signing
        .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .map_err(|e| anyhow::anyhow!("PKCS#8 экспорт: {e}"))?;
    let public_pem = signing
        .verifying_key()
        .to_public_key_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
        .map_err(|e| anyhow::anyhow!("SPKI экспорт: {e}"))?;
    let encoding = EncodingKey::from_ed_pem(private_pem.as_bytes()).context("EncodingKey Ed25519")?;
    let decoding = DecodingKey::from_ed_pem(public_pem.as_bytes()).context("DecodingKey Ed25519")?;
    Ok((encoding, decoding, kid_for(&signing.verifying_key())))
}

/// Загрузить Ed25519-ключ подписи из файла или сгенерировать новый; вынести
/// legacy HS256-секрет из SQLite в файл на срок жизни старых токенов.
async fn load_or_create_jwt_keys(pool: &SqlitePool, db_path: &str) -> Result<(EncodingKey, DecodingKey)> {
    use ed25519_dalek::pkcs8::DecodePrivateKey;
    let path = jwt_key_path(db_path);
    let signing = match std::fs::read_to_string(&path) {
        Ok(pem) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.permissions().mode() & 0o077 != 0 {
                        warn!("{}: права шире 0600 — ключ подписи JWT доступен другим пользователям", path.display());
                    }
                }
            }
            ed25519_dalek::SigningKey::from_pkcs8_pem(&pem)
                .map_err(|e| anyhow::anyhow!("{}: не Ed25519 PKCS#8 PEM: {e}", path.display()))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use ed25519_dalek::pkcs8::EncodePrivateKey;
            let signing = ed25519_dalek::SigningKey::generate(&mut OsRng);
            let pem = signing
                .to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF)
                .map_err(|e| anyhow::anyhow!("PKCS#8 экспорт: {e}"))?;
            write_secret_file(&path, pem.as_bytes())?;
            warn!("сгенерирован новый ключ подписи JWT (Ed25519): {} — сохраните его в бэкап отдельно от БД", path.display());
            signing
        }
        Err(e) => return Err(e).with_context(|| format!("чтение {}", path.display())),
    };
    let (encoding, decoding, kid) = keys_from_signing(&signing)?;
    let _ = JWT_KID.set(kid.clone());
    info!("JWT: EdDSA kid={} ({})", kid, path.display());

    // Миграция legacy HS256-секрета из SQLite → файл рядом с ключом.
    let legacy_path = path.with_extension("legacy-hs256");
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT bytes FROM secret WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    if let Some((bytes,)) = row {
        write_secret_file(&legacy_path, &bytes)?;
        sqlx::query("DELETE FROM secret WHERE id = 1").execute(pool).await?;
        warn!(
            "legacy HS256-секрет вынесен из SQLite в {} — старые токены принимаются ещё {} ч, затем файл удаляется",
            legacy_path.display(),
            LEGACY_HS256_WINDOW_SECS / 3600
        );
    }
    if let Ok(meta) = std::fs::metadata(&legacy_path) {
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let until = modified + LEGACY_HS256_WINDOW_SECS;
        if now_unix() < until {
            if let Ok(bytes) = std::fs::read(&legacy_path) {
                set_legacy_hs256(Some((DecodingKey::from_secret(&bytes), until)));
                info!("JWT: legacy HS256 принимается до {}", until);
            }
        } else {
            let _ = std::fs::remove_file(&legacy_path);
            info!("JWT: окно legacy HS256 истекло, {} удалён", legacy_path.display());
        }
    }
    Ok((encoding, decoding))
}

fn set_legacy_hs256(value: Option<(DecodingKey, i64)>) {
    if let Ok(mut g) = LEGACY_HS256.write() {
        *g = value;
    }
}

/// Подпись JWT: EdDSA с kid текущего ключа.
fn jwt_encode(encoding: &EncodingKey, claims: &Claims) -> Result<String> {
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = JWT_KID.get().cloned();
    encode(&header, claims, encoding).context("подпись JWT")
}

/// Проверка JWT: EdDSA основным ключом; HS256 — только legacy-секретом и только
/// в окне миграции. Любой другой алгоритм отклоняется.
fn jwt_decode(decoding: &DecodingKey, token: &str) -> Result<jsonwebtoken::TokenData<Claims>> {
    let header = jsonwebtoken::decode_header(token).context("неверный или просроченный JWT")?;
    match header.alg {
        Algorithm::EdDSA => decode::<Claims>(token, decoding, &Validation::new(Algorithm::EdDSA))
            .context("неверный или просроченный JWT"),
        Algorithm::HS256 => {
            let guard = LEGACY_HS256.read().map_err(|_| anyhow::anyhow!("legacy lock"))?;
            let Some((legacy, until)) = guard.as_ref() else {
                anyhow::bail!("неверный или просроченный JWT");
            };
            if now_unix() >= *until {
                anyhow::bail!("неверный или просроченный JWT");
            }
            decode::<Claims>(token, legacy, &Validation::new(Algorithm::HS256))
                .context("неверный или просроченный JWT")
        }
        _ => anyhow::bail!("неверный или просроченный JWT"),
    }
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

/// P-43: политика пароля — не короче 8 и не длиннее 1024 символов.
fn password_policy_ok(password: &str) -> Result<()> {
    let n = password.chars().count();
    if n < 8 {
        anyhow::bail!("пароль короче 8 символов");
    }
    if n > 1024 {
        anyhow::bail!("пароль слишком длинный");
    }
    Ok(())
}

/// P-07: опасные операции (выключение 2FA, отзыв устройства, смена ключа,
/// смена пароля) требуют ТЕКУЩИЙ пароль, а не только JWT — украденный
/// 24-часовой токен не должен снимать второй фактор или выкидывать владельца.
async fn require_password(pool: &SqlitePool, username: &str, password: Option<&str>) -> Result<()> {
    let Some(password) = password.filter(|p| !p.is_empty()) else {
        anyhow::bail!("требуется пароль");
    };
    let row: Option<(String,)> =
        sqlx::query_as("SELECT password_hash FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(pool)
            .await?;
    let Some((hash,)) = row else {
        let _ = verify_password(password, dummy_password_hash());
        anyhow::bail!("неверный пароль");
    };
    if !verify_password(password, &hash) {
        anyhow::bail!("неверный пароль");
    }
    Ok(())
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

/// Полный адрес по вводу пользователя: `ник` → `ник@домен`, `ник@сервер`
/// остаётся как есть (десктоп и старые аккаунты вводят адрес целиком).
fn canonical_user(raw: &str, domain: &str) -> String {
    let raw = raw.trim();
    if raw.contains('@') {
        raw.to_string()
    } else {
        format!("{}@{}", raw, domain)
    }
}

const NICK_MIN_LEN: usize = 2;
const NICK_MAX_LEN: usize = 64;

/// Ник нового аккаунта: строчные латинские буквы, цифры, `_ . -`; первый
/// символ — буква или цифра; 2..=64 символа. Регистр приводится клиентом;
/// здесь только проверка, чтобы адрес был однозначным.
fn valid_nick(nick: &str) -> bool {
    let len = nick.chars().count();
    if !(NICK_MIN_LEN..=NICK_MAX_LEN).contains(&len) {
        return false;
    }
    let first = nick.chars().next().unwrap_or(' ');
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && nick
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'))
}

/// Адрес нового аккаунта: ник проверен, домен — только свой (чужие домены
/// регистрировать нельзя, иначе любой мог бы занять адрес чужого сервера).
fn validate_new_user(user: &str, domain: &str) -> Result<()> {
    let Some((nick, user_domain)) = user.split_once('@') else {
        anyhow::bail!("некорректный адрес");
    };
    if !valid_nick(nick) {
        anyhow::bail!("некорректный ник: 2–64 символа, латиница в нижнем регистре, цифры, _ . -");
    }
    if user_domain != domain {
        anyhow::bail!("чужой домен: на этом сервере адреса @{}", domain);
    }
    Ok(())
}

// Публичные параметры сервера для экрана входа (pre-auth).
async fn handle_server_info(nc: &Client, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("server.info: нет reply-топика, игнорирую");
        return;
    };
    let mode = confirm_mode();
    let resp = ServerInfoResponse {
        domain: server_domain(),
        email_required: mode == ConfirmMode::Email,
        confirm: mode.as_str().to_string(),
        telegram_bot: if mode == ConfirmMode::Telegram { telegram_bot().unwrap_or_default() } else { String::new() },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("server.info: ошибка отправки ответа: {}", e);
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
/// P-19: экранирование `%`/`_`/`\` в шаблоне LIKE (ESCAPE '\').
fn like_escape(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Минимальная длина запроса поиска: одиночный символ (или пустой/`%`)
/// отдавал бы весь каталог.
const SEARCH_MIN_CHARS: usize = 2;

/// Публичная карточка для поиска/резолва: без телефона, даты рождения и bio —
/// их видит только владелец (P-19).
fn public_card(u: &str, d: &str, a: String, k: String, color: i64, chan: String) -> UserInfo {
    UserInfo {
        display_name: name_or_default(u, d),
        username: u.to_string(),
        avatar: opt(a),
        pubkey: opt(k),
        bio: None,
        birthday: None,
        name_color: if color != 0 { Some(color) } else { None },
        personal_channel: opt(chan),
        phone: None,
    }
}

/// Адрес запрашивающего по токену (если gateway подставил валидный).
fn requester_of(decoding: &DecodingKey, token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    jwt_decode(decoding, token).ok().map(|data| data.claims.sub)
}

async fn handle_search(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("search: нет reply-топика, игнорирую");
        return;
    };
    let req = serde_json::from_slice::<SearchUsersRequest>(&msg.payload).ok();
    let q = req.as_ref().map(|r| r.query.trim().to_string()).unwrap_or_default();
    let _requester = req.as_ref().and_then(|r| requester_of(decoding, &r.token));
    let users: Vec<UserInfo> = if q.chars().count() < SEARCH_MIN_CHARS {
        vec![]
    } else {
        // P-19: `%`/`_` в запросе — литералы, а не wildcard'ы
        let like = format!("%{}%", like_escape(&q));
        // Ограничиваем выдачу доменом этого сервера: аккаунты чужих доменов
        // (в т.ч. e2e-тестовые `@local` на проде) в директорию не попадают.
        let domain_suffix = format!("%@{}", like_escape(&server_domain()));
        sqlx::query_as::<_, (String, String, String, String, i64, String)>(
            "SELECT username, display_name, avatar_file_id, pubkey, name_color, personal_channel FROM users
             WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
               AND username LIKE ? ESCAPE '\\'
             ORDER BY username LIMIT 20",
        )
        .bind(&like)
        .bind(&like)
        .bind(&domain_suffix)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(u, d, a, k, color, chan)| public_card(&u, &d, a, k, color, chan))
        .collect()
    };
    // P-42: сам запрос в лог не пишем
    debug!("search: {} результатов", users.len());
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
    let resp = match serde_json::from_slice::<SetNameRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
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
                    // Профильные поля (опциональны): задаём только присланные.
                    if let Some(v) = req.bio.as_ref() {
                        let _ = sqlx::query("UPDATE users SET bio = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.birthday.as_ref() {
                        let _ = sqlx::query("UPDATE users SET birthday = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.name_color {
                        let _ = sqlx::query("UPDATE users SET name_color = ? WHERE username = ?")
                            .bind(v).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.personal_channel.as_ref() {
                        let _ = sqlx::query("UPDATE users SET personal_channel = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    if let Some(v) = req.phone.as_ref() {
                        let _ = sqlx::query("UPDATE users SET phone = ? WHERE username = ?")
                            .bind(v.trim()).bind(&username).execute(pool).await;
                    }
                    info!("{} обновил профиль (имя '{}')", username, name);
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
    let resp = match serde_json::from_slice::<SetAvatarRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
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
    let resp = match serde_json::from_slice::<SetKeyRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match async {
                // P-07: ЗАМЕНА уже зарегистрированного публичного ключа — только с
                // паролем (украденный JWT не должен подменять ключ подписи
                // сигналинга звонков). Первая регистрация и повторная публикация
                // того же ключа (клиенты делают её при каждом входе) — по JWT.
                let current: Option<(String,)> =
                    sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
                        .bind(&username)
                        .fetch_optional(pool)
                        .await?;
                let current = current.map(|(k,)| k).unwrap_or_default();
                if !current.is_empty() && current != req.pubkey {
                    require_password(pool, &username, req.password.as_deref()).await?;
                }
                store_pubkey(pool, &username, &req.pubkey).await
            }
            .await
            {
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
async fn handle_resolve(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let req: ResolveRequest = serde_json::from_slice(&msg.payload).unwrap_or(ResolveRequest {
        usernames: vec![],
        token: String::new(),
    });
    let requester = requester_of(decoding, &req.token);
    let mut users = Vec::new();
    for u in req.usernames.iter().take(50) {
        let row: Option<(String, String, String, String, String, i64, String, String)> = sqlx::query_as(
            "SELECT display_name, avatar_file_id, pubkey, bio, birthday, name_color,              personal_channel, phone FROM users WHERE username = ?",
        )
        .bind(u)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some((d, a, k, bio, bday, color, chan, phone)) = row {
            // P-19: телефон — только владельцу; bio/дата рождения — публичная
            // часть профиля, заданная самим пользователем.
            let is_self = requester.as_deref() == Some(u.as_str());
            users.push(UserInfo {
                display_name: name_or_default(u, &d),
                username: u.clone(),
                avatar: opt(a),
                pubkey: opt(k),
                bio: opt(bio),
                birthday: opt(bday),
                name_color: if color != 0 { Some(color) } else { None },
                personal_channel: opt(chan),
                phone: if is_self { opt(phone) } else { None },
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
#[cfg(test)]
async fn fetch_bundle(
    pool: &SqlitePool,
    username: &str,
    known_devices: &[String],
) -> Result<FetchBundleResponse> {
    fetch_bundle_for(pool, "", username, known_devices).await
}

/// `requester` — кто запрашивает (для кэша повторной выдачи one-time, P-21);
/// пустой — без кэша (тесты/внутренние вызовы).
async fn fetch_bundle_for(
    pool: &SqlitePool,
    requester: &str,
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
        } else if let Some(cached) = (!requester.is_empty())
            .then(|| cached_otk(requester, username, &device_id))
            .flatten()
        {
            // P-21: та же пара в окне — та же one-time, новую не сжигаем
            Some(cached)
        } else {
            let fresh: Option<(i64, String)> = sqlx::query_as(
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
            .unwrap_or(None);
            if let Some((key_id, public_key)) = fresh.as_ref() {
                if !requester.is_empty() {
                    remember_otk(requester, username, &device_id, *key_id, public_key);
                }
                // P-21: алерт об исчерпании — иначе деградация до signed-prekey-only
                // происходила бы молча
                let left: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM one_time_prekeys WHERE username = ? AND device_id = ? AND consumed = 0",
                )
                .bind(username)
                .bind(&device_id)
                .fetch_one(pool)
                .await
                .unwrap_or(0);
                if left <= OTK_LOW_WATERMARK {
                    warn!("one-time prekeys устройства '{}' пользователя {} на исходе: {}", device_id, username, left);
                }
            }
            fresh
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
    // Отозванное устройство перестаёт быть доверенным для двухфакторного входа
    let _ = sqlx::query("DELETE FROM trusted_devices WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await;
    // Тумбстоун: JWT этого устройства перестают проходить verify сразу
    sqlx::query("INSERT OR REPLACE INTO revoked_devices (username, device_id, revoked_at) VALUES (?, ?, ?)")
        .bind(username)
        .bind(device_id)
        .bind(now_unix())
        .execute(pool)
        .await
        .context("тумбстоун отозванного устройства")?;
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
    let resp = match serde_json::from_slice::<DeviceListRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
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
    let resp = match serde_json::from_slice::<DeviceRevokeRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match async {
                // P-07: отзыв устройства — только с паролем.
                require_password(pool, &username, req.password.as_deref()).await?;
                revoke_device(pool, &username, &req.device_id).await
            }
            .await
            {
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

/// Оффер линковки. v2 (P-03): сначала публикуется ТОЛЬКО commitment
/// (SHA-256 эфемерного ключа), ключ раскрывается тем же обработчиком после
/// challenge старого устройства; сервер сверяет раскрытие с обязательством.
/// Legacy-клиент шлёт eph_pub без commitment — принимаем как раньше.
async fn store_link_offer(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
    eph_pub: &str,
    commitment: &str,
    signing_key: &str,
    revoke: bool,
) -> Result<()> {
    // Отзыв собственного оффера (история получена другим путём): чужие
    // устройства перестают видеть запрос. Legacy: пустой eph_pub без commitment.
    if revoke || (eph_pub.is_empty() && commitment.is_empty()) {
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
    if eph_pub.len() > LINK_EPH_PUB_MAX || commitment.len() > LINK_EPH_PUB_MAX || signing_key.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    if !commitment.is_empty() {
        // Раскрытие: ключ обязан соответствовать обязательству.
        if !eph_pub.is_empty() && !link_commitment_matches(eph_pub, commitment) {
            anyhow::bail!("раскрытый ключ не соответствует обязательству");
        }
        // Тот же оффер (то же обязательство) — обновляем ключ, сохраняя challenge.
        let updated = sqlx::query(
            "UPDATE link_offers SET eph_pub = ?, signing_key = CASE WHEN ? = '' THEN signing_key ELSE ? END
              WHERE username = ? AND device_id = ? AND commitment = ?",
        )
        .bind(eph_pub)
        .bind(signing_key)
        .bind(signing_key)
        .bind(username)
        .bind(device_id)
        .bind(commitment)
        .execute(pool)
        .await?
        .rows_affected();
        if updated > 0 {
            return Ok(());
        }
    }
    // Новый оффер устройства заменяет прежний (и гасит старый грант — он
    // зашифрован на уже потерянный эфемерный ключ).
    sqlx::query(
        "INSERT OR REPLACE INTO link_offers (username, device_id, eph_pub, created_at, commitment, challenge_pub, signing_key)
         VALUES (?, ?, ?, ?, ?, '', ?)",
    )
    .bind(username)
    .bind(device_id)
    .bind(eph_pub)
    .bind(now_unix())
    .bind(commitment)
    .bind(signing_key)
    .execute(pool)
    .await?;
    sqlx::query("DELETE FROM link_grants WHERE username = ? AND device_id = ?")
        .bind(username)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// SHA-256(raw eph_pub) == commitment (обе строки base64).
fn link_commitment_matches(eph_pub_b64: &str, commitment_b64: &str) -> bool {
    let Some(raw) = B64.decode(eph_pub_b64).ok() else { return false };
    let Some(want) = B64.decode(commitment_b64).ok() else { return false };
    Sha256::digest(&raw).as_slice() == want.as_slice()
}

/// v2: challenge старого устройства к офферу целевого. Первый challenge
/// фиксируется; замена другим ключом невозможна (иначе сервер/третий подменил
/// бы сторону, с которой считается SAS).
async fn store_link_challenge(
    pool: &SqlitePool,
    username: &str,
    target_device: &str,
    eph_pub: &str,
) -> Result<()> {
    if eph_pub.is_empty() || eph_pub.len() > LINK_EPH_PUB_MAX {
        anyhow::bail!("некорректный эфемерный ключ");
    }
    purge_stale_links(pool).await?;
    let updated = sqlx::query(
        "UPDATE link_offers SET challenge_pub = ?
          WHERE username = ? AND device_id = ? AND (challenge_pub = '' OR challenge_pub = ?)",
    )
    .bind(eph_pub)
    .bind(username)
    .bind(target_device)
    .bind(eph_pub)
    .execute(pool)
    .await?
    .rows_affected();
    if updated == 0 {
        anyhow::bail!("оффер линковки не найден, истёк или уже имеет challenge");
    }
    Ok(())
}

/// Офферы ДРУГИХ устройств аккаунта + одноразовый грант для запрашивающего
/// (удаляется при выдаче: клиент, упавший до импорта, просто переофферит).
async fn poll_link(
    pool: &SqlitePool,
    username: &str,
    device_id: &str,
) -> Result<(Vec<LinkOfferInfo>, Option<LinkGrantInfo>, Option<String>)> {
    purge_stale_links(pool).await?;
    let offers: Vec<(String, String, i64, String, String, String)> = sqlx::query_as(
        "SELECT device_id, eph_pub, created_at, commitment, signing_key, challenge_pub FROM link_offers
          WHERE username = ? AND device_id != ? ORDER BY created_at",
    )
    .bind(username)
    .bind(device_id)
    .fetch_all(pool)
    .await?;
    // v2: challenge к СОБСТВЕННОМУ офферу запрашивающего (сигнал раскрыть ключ).
    let challenge: Option<(String,)> = sqlx::query_as(
        "SELECT challenge_pub FROM link_offers WHERE username = ? AND device_id = ? AND challenge_pub != ''",
    )
    .bind(username)
    .bind(device_id)
    .fetch_optional(pool)
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
            .map(|(device_id, eph_pub, created_at, commitment, signing_key, challenge_pub)| LinkOfferInfo {
                device_id, eph_pub, created_at, commitment, signing_key, challenge_pub,
            })
            .collect(),
        grant.map(|(box_payload, eph_pub)| LinkGrantInfo { box_payload, eph_pub }),
        challenge.map(|(c,)| c),
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
    let resp = match serde_json::from_slice::<LinkOfferRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
            Ok(username) => match store_link_offer(pool, &username, &req.device_id, &req.eph_pub, &req.commitment, &req.signing_key, req.revoke).await {
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
    let resp = match serde_json::from_slice::<LinkPollRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
            Ok(username) => match poll_link(pool, &username, &req.device_id).await {
                Ok((offers, grant, challenge)) => LinkPollResponse { ok: true, offers, grant, challenge, error: None },
                Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(e.to_string()) },
            },
            Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(e.to_string()) },
        },
        Err(e) => LinkPollResponse { ok: false, offers: vec![], grant: None, challenge: None, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// v2: старое устройство прикладывает свой эфемерный ключ к офферу целевого.
/// Владелец — из JWT; device_id здесь ЦЕЛЕВОЕ устройство.
async fn handle_link_challenge(
    nc: &Client,
    pool: &SqlitePool,
    decoding: &DecodingKey,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match serde_json::from_slice::<LinkChallengeRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(username) => match store_link_challenge(pool, &username, &req.device_id, &req.eph_pub).await {
                Ok(()) => LinkChallengeResponse { ok: true, error: None },
                Err(e) => LinkChallengeResponse { ok: false, error: Some(e.to_string()) },
            },
            Err(e) => LinkChallengeResponse { ok: false, error: Some(e.to_string()) },
        },
        Err(e) => LinkChallengeResponse { ok: false, error: Some(e.to_string()) },
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
    let resp = match serde_json::from_slice::<LinkGrantRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
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
    let resp = match serde_json::from_slice::<PublishPrekeysRequest>(&msg.payload) {
        Ok(req) => match verify_active_device(pool, decoding, &req.token, &req.device_id).await {
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
    let resp = match serde_json::from_slice::<FetchBundleRequest>(&msg.payload) {
        Ok(req) => match verify_active_user(pool, decoding, &req.token).await {
            Ok(requester) => {
                if !prekey_fetch_rate_ok(&requester, &req.user) {
                    empty_bundle_response(Some(
                        "слишком много запросов ключей, попробуйте позже".into(),
                    ))
                } else {
                    fetch_bundle_for(pool, &requester, &req.user, &req.known_devices)
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
        Ok(IssueOutcome::Token { token, trust_secret }) => IssueResponse {
            ok: true, token: Some(token), error: None, twofa_required: false, login_token: None, telegram_bot: None,
            trust_secret,
        },
        Ok(IssueOutcome::TwoFactor { login_token }) => IssueResponse {
            ok: false,
            token: None,
            error: Some("нужно подтверждение входа в Telegram".into()),
            twofa_required: true,
            login_token: Some(login_token),
            telegram_bot: telegram_bot(),
            trust_secret: None,
        },
        Err(e) => {
            error!("issue error: {}", e);
            IssueResponse {
                ok: false, token: None, error: Some(e.to_string()), twofa_required: false, login_token: None, telegram_bot: None,
                trust_secret: None,
            }
        }
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("issue: ошибка отправки ответа: {}", e);
    }
}

/// Хэш секрета доверия для trusted_devices.secret_hash.
fn trust_secret_hash(secret: &str) -> String {
    B64.encode(Sha256::digest(secret.as_bytes()))
}

/// Новый секрет доверия (32 случайных байта, base64) + его хэш.
fn new_trust_secret() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = B64.encode(bytes);
    let hash = trust_secret_hash(&secret);
    (secret, hash)
}

/// Исход логина: JWT или ожидание подтверждения двухфакторного входа.
#[derive(Debug)]
enum IssueOutcome {
    Token { token: String, trust_secret: Option<String> },
    TwoFactor { login_token: String },
}

impl IssueOutcome {
    #[cfg(test)]
    fn token(&self) -> Option<&str> {
        match self {
            IssueOutcome::Token { token, .. } => Some(token),
            IssueOutcome::TwoFactor { .. } => None,
        }
    }
    #[cfg(test)]
    fn trust_secret(&self) -> Option<&str> {
        match self {
            IssueOutcome::Token { trust_secret, .. } => trust_secret.as_deref(),
            IssueOutcome::TwoFactor { .. } => None,
        }
    }
}

/// Срок действия токена подтверждения входа (deep link боту).
const LOGIN_LINK_TTL_SECS: i64 = 600;

async fn do_issue(pool: &SqlitePool, encoding: &EncodingKey, payload: &[u8]) -> Result<IssueOutcome> {
    let mut req: IssueRequest = serde_json::from_slice(payload)
        .context("неверный JSON в IssueRequest")?;
    req.user = canonical_user(&req.user, &server_domain());

    // Брутфорс-защита: частотный лимит + экспоненциальный лок-аут по логину,
    // плюс частотный лимит по IP (gateway подмешивает client_ip; пусто при
    // прямом NATS в dev). Проверяем ДО обращения к БД, чтобы отклонённая
    // попытка была дёшева.
    login_gate_check(&req.user)?;
    if !req.client_ip.is_empty()
        && !window_rate_ok("login-ip", &req.client_ip, env_u64("PARVANE_LOGIN_RATE_IP", 120) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }

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

    // Двухфакторный вход: пароль верен, но нужен Start в привязанном Telegram.
    // С подтверждённым login_token выдаём JWT (токен одноразовый).
    let (tg_2fa, telegram_id): (i64, Option<i64>) =
        sqlx::query_as("SELECT tg_2fa, telegram_id FROM users WHERE username = ?")
            .bind(&req.user)
            .fetch_one(pool)
            .await?;
    let device_id = req.device_id.as_deref().map(str::trim).unwrap_or("");
    // Доверие — по СЕКРЕТУ, а не по device_id: device_id публичен (каталог
    // прекеев отдаёт его любому), и раньше второй фактор обходился при
    // известном пароле. Строки без хэша (до миграции 0014) не доверяем.
    let presented_secret = req.trust_secret.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let trusted = if tg_2fa != 0 && telegram_id.is_some() && !device_id.is_empty() {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT secret_hash FROM trusted_devices WHERE username = ? AND device_id = ?")
                .bind(&req.user)
                .bind(device_id)
                .fetch_optional(pool)
                .await?;
        match (row, presented_secret) {
            (Some((hash,)), Some(secret)) if !hash.is_empty() => trust_secret_hash(secret) == hash,
            _ => false,
        }
    } else {
        false
    };
    let mut issued_trust_secret: Option<String> = None;
    // P-14: секрет доверия одноразовый — при каждом доверенном входе выдаём
    // новый (украденный из хранилища секрет протухает после первого же входа
    // владельца, а повторное использование старого — сигнал компрометации).
    if trusted {
        let (secret, hash) = new_trust_secret();
        sqlx::query("UPDATE trusted_devices SET secret_hash = ?, confirmed_at = ? WHERE username = ? AND device_id = ?")
            .bind(&hash)
            .bind(now_unix())
            .bind(&req.user)
            .bind(device_id)
            .execute(pool)
            .await?;
        issued_trust_secret = Some(secret);
    }
    if tg_2fa != 0 && telegram_id.is_some() && !trusted {
        let now = now_unix();
        let _ = sqlx::query("DELETE FROM login_links WHERE expires_at < ?").bind(now).execute(pool).await;
        let presented = req.login_token.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let confirmed = match presented {
            Some(token) => {
                let row: Option<(i64,)> = sqlx::query_as(
                    "SELECT confirmed FROM login_links WHERE token = ? AND username = ? AND expires_at >= ?",
                )
                .bind(token)
                .bind(&req.user)
                .bind(now)
                .fetch_optional(pool)
                .await?;
                match row {
                    Some((1,)) => {
                        sqlx::query("DELETE FROM login_links WHERE token = ?").bind(token).execute(pool).await?;
                        if !device_id.is_empty() {
                            let (secret, hash) = new_trust_secret();
                            sqlx::query(
                                "INSERT OR REPLACE INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, ?, ?)",
                            )
                            .bind(&req.user)
                            .bind(device_id)
                            .bind(now)
                            .bind(&hash)
                            .execute(pool)
                            .await?;
                            issued_trust_secret = Some(secret);
                        }
                        true
                    }
                    _ => false,
                }
            }
            None => false,
        };
        if !confirmed {
            let login_token = issue_login_token(pool, &req.user, device_id).await?;
            info!("Двухфакторный вход: {} ждёт подтверждения в Telegram", req.user);
            return Ok(IssueOutcome::TwoFactor { login_token });
        }
    }

    let now = now_unix() as usize;
    let claims = Claims {
        sub: req.user.clone(),
        iat: now,
        exp: now + 86400,
        dev: req.device_id.clone().filter(|d| !d.is_empty()),
    };
    let token = jwt_encode(encoding, &claims)?;

    info!("JWT выдан для: {}", req.user);
    Ok(IssueOutcome::Token { token, trust_secret: issued_trust_secret })
}

/// Новый токен подтверждения входа (deep link боту). Прежние токены этого
/// пользователя гасятся — действует только последний.
async fn issue_login_token(pool: &SqlitePool, user: &str, device_id: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query("DELETE FROM login_links WHERE username = ?").bind(user).execute(pool).await?;
    sqlx::query("INSERT INTO login_links (token, username, device_id, expires_at, confirmed) VALUES (?, ?, ?, ?, 0)")
        .bind(&token)
        .bind(user)
        .bind(device_id)
        .bind(now_unix() + LOGIN_LINK_TTL_SECS)
        .execute(pool)
        .await?;
    Ok(token)
}

// ── двухфакторный вход: чтение/переключение ──────────────────────────────────

/// P-07: смена пароля (identity.password.change). Требует JWT живой сессии И
/// старый пароль; новый — по политике. Сбрасывает доверие устройств 2FA и
/// незавершённые входы: после компрометации владелец возвращает контроль.
async fn handle_password_change(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match do_password_change(pool, decoding, &msg.payload).await {
        Ok(user) => {
            info!("{} сменил пароль", user);
            PasswordChangeResponse { ok: true, error: None }
        }
        Err(e) => PasswordChangeResponse { ok: false, error: Some(e.to_string()) },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

async fn do_password_change(pool: &SqlitePool, decoding: &DecodingKey, payload: &[u8]) -> Result<String> {
    let req: PasswordChangeRequest =
        serde_json::from_slice(payload).context("неверный JSON в PasswordChangeRequest")?;
    let username = verify_active_user(pool, decoding, &req.token).await?;
    login_gate_check(&username)?;
    if let Err(e) = require_password(pool, &username, Some(&req.old_password)).await {
        login_record_failure(&username);
        return Err(e);
    }
    password_policy_ok(&req.new_password)?;
    if req.new_password == req.old_password {
        anyhow::bail!("новый пароль совпадает со старым");
    }
    let hash = hash_password(&req.new_password)?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE username = ?")
        .bind(&hash)
        .bind(&username)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM trusted_devices WHERE username = ?").bind(&username).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM login_links WHERE username = ?").bind(&username).execute(&mut *tx).await?;
    tx.commit().await?;
    login_record_success(&username);
    Ok(username)
}

async fn handle_twofa(nc: &Client, pool: &SqlitePool, decoding: &DecodingKey, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let resp = match do_twofa(pool, decoding, &msg.payload).await {
        Ok((enabled, telegram_linked, trust_secret)) => TwoFactorResponse { ok: true, error: None, enabled, telegram_linked, trust_secret },
        Err(e) => TwoFactorResponse { ok: false, error: Some(e.to_string()), enabled: false, telegram_linked: false, trust_secret: None },
    };
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

/// (enabled, telegram_linked, trust_secret). Включить можно только при
/// привязанном Telegram; устройство, включившее 2FA, получает секрет доверия.
async fn do_twofa(pool: &SqlitePool, decoding: &DecodingKey, payload: &[u8]) -> Result<(bool, bool, Option<String>)> {
    let req: TwoFactorRequest = serde_json::from_slice(payload).context("неверный JSON в TwoFactorRequest")?;
    let data = jwt_decode(decoding, &req.token)?;
    let username = data.claims.sub;
    let row: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT tg_2fa, telegram_id FROM users WHERE username = ?")
            .bind(&username)
            .fetch_optional(pool)
            .await?;
    let Some((current, telegram_id)) = row else {
        anyhow::bail!("аккаунт не найден");
    };
    let telegram_linked = telegram_id.is_some();
    let Some(enabled) = req.enabled else {
        return Ok((current != 0, telegram_linked, None));
    };
    if enabled && !telegram_linked {
        anyhow::bail!("сначала привяжите Telegram (подтверждение через бота)");
    }
    if !enabled {
        // P-07: выключить 2FA можно только с паролем.
        require_password(pool, &username, req.password.as_deref()).await?;
    }
    sqlx::query("UPDATE users SET tg_2fa = ? WHERE username = ?")
        .bind(enabled as i64)
        .bind(&username)
        .execute(pool)
        .await?;
    if !enabled {
        let _ = sqlx::query("DELETE FROM login_links WHERE username = ?").bind(&username).execute(pool).await;
        // При повторном включении все устройства подтверждают вход заново
        let _ = sqlx::query("DELETE FROM trusted_devices WHERE username = ?").bind(&username).execute(pool).await;
    }
    let mut trust_secret = None;
    if enabled {
        if let Some(dev) = data.claims.dev.as_deref().filter(|d| !d.is_empty()) {
            // Устройство, с которого включили 2FA, уже вошло по паролю — даём ему
            // секрет доверия сразу (иначе десктоп, который переизвлекает JWT при
            // каждом старте, тут же попросил бы подтверждение на том же устройстве)
            let (secret, hash) = new_trust_secret();
            let _ = sqlx::query(
                "INSERT OR REPLACE INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, ?, ?)",
            )
            .bind(&username)
            .bind(dev)
            .bind(now_unix())
            .bind(&hash)
            .execute(pool)
            .await;
            trust_secret = Some(secret);
        }
    }
    info!("Двухфакторный вход {} для {}", if enabled { "включён" } else { "выключен" }, username);
    Ok((enabled, telegram_linked, trust_secret))
}

// ── регистрация (отдельно от логина) ──────────────────────────────────────────

async fn handle_register(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("register: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_register(pool, &msg.payload, confirm_mode()).await {
        Ok(out) => {
            if let Some((email, code)) = out.send {
                send_confirmation_email(email, code);
            }
            RegisterResponse {
                ok: true,
                error: None,
                confirm_required: out.confirm_required,
                telegram_token: out.telegram_token,
            }
        }
        Err(e) => RegisterResponse {
            ok: false,
            error: Some(e.to_string()),
            confirm_required: false,
            telegram_token: None,
        },
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
    /// Режим Telegram: токен deep link для бота.
    telegram_token: Option<String>,
}

/// Сколько живёт неподтверждённый аккаунт: после — логин можно занять заново
/// (иначе регистрация без подтверждения сквотила бы адреса навсегда).
const PENDING_TTL_SECS: i64 = 86_400;
/// Срок действия кода подтверждения.
const CODE_TTL_SECS: i64 = 900;
/// Срок действия токена Telegram deep link.
const TELEGRAM_LINK_TTL_SECS: i64 = 900;
/// Попыток ввода кода до принудительного перезапроса.
const CODE_MAX_ATTEMPTS: i64 = 5;

/// Создать аккаунт. Отвергает занятый логин, пустые поля, превышение лимита
/// попыток и (при PARVANE_INVITE_REQUIRED=1) отсутствие валидного инвайта.
/// В режимах Email/Telegram аккаунт создаётся неподтверждённым и ждёт кода с
/// почты либо Start в боте; повторный register с тем же паролем до
/// подтверждения — перевысылка кода / новый токен deep link.
async fn do_register(
    pool: &SqlitePool,
    payload: &[u8],
    mode: ConfirmMode,
) -> Result<RegisterOutcome> {
    let req: RegisterRequest = serde_json::from_slice(payload)
        .context("неверный JSON в RegisterRequest")?;

    let domain = server_domain();
    let user = canonical_user(&req.user, &domain);
    if req.user.trim().is_empty() || req.password.is_empty() {
        anyhow::bail!("пустой логин или пароль");
    }
    password_policy_ok(&req.password)?;
    if user.len() > 128 {
        anyhow::bail!("слишком длинный логин");
    }
    validate_new_user(&user, &domain)?;
    if !rate_ok(&user) {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    // По источнику (IP от gateway): пер-логин лимит не мешает спаму разными
    // логинами с одного адреса. Пусто — прямой NATS (dev), лимита по IP нет.
    // Дефолты с запасом на NAT (много людей за одним адресом).
    if !req.client_ip.is_empty()
        && !window_rate_ok("register-ip", &req.client_ip, env_u64("PARVANE_REGISTER_RATE_IP", 30) as usize)
    {
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
            if mode == ConfirmMode::Telegram {
                let token = issue_telegram_token(pool, &user).await?;
                info!("Новый Telegram-токен для pending-аккаунта: {}", user);
                return Ok(RegisterOutcome {
                    confirm_required: true,
                    send: None,
                    telegram_token: Some(token),
                });
            }
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
            return Ok(RegisterOutcome {
                confirm_required: true,
                send: Some((email, code)),
                telegram_token: None,
            });
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
        sqlx::query("DELETE FROM telegram_links WHERE username = ?")
            .bind(&user)
            .execute(pool)
            .await?;
    }

    if mode == ConfirmMode::Email && !valid_email(&email) {
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
    .bind(if mode == ConfirmMode::None { 1 } else { 0 })
    .execute(pool)
    .await?;

    match mode {
        ConfirmMode::Email => {
            let code = issue_email_code(pool, &user).await?;
            info!("Пользователь зарегистрирован, ждёт подтверждения почты: {}", user);
            Ok(RegisterOutcome { confirm_required: true, send: Some((email, code)), telegram_token: None })
        }
        ConfirmMode::Telegram => {
            let token = issue_telegram_token(pool, &user).await?;
            info!("Пользователь зарегистрирован, ждёт подтверждения в Telegram: {}", user);
            Ok(RegisterOutcome { confirm_required: true, send: None, telegram_token: Some(token) })
        }
        ConfirmMode::None => {
            info!("Пользователь зарегистрирован: {} (имя: {})", user, default_name);
            Ok(RegisterOutcome { confirm_required: false, send: None, telegram_token: None })
        }
    }
}

// ── подтверждение через Telegram-бота ────────────────────────────────────────

/// Новый токен deep link для pending-аккаунта (прежний перестаёт действовать).
async fn issue_telegram_token(pool: &SqlitePool, user: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query(
        "INSERT INTO telegram_links (username, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
    )
    .bind(user)
    .bind(&token)
    .bind(now_unix() + TELEGRAM_LINK_TTL_SECS)
    .execute(pool)
    .await?;
    Ok(token)
}

/// Сравнение секретов без ранней остановки (по длине и по байтам).
fn secret_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

async fn handle_telegram_confirm(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("telegram.confirm: нет reply-топика, игнорирую");
        return;
    };
    let resp = match do_telegram_confirm(pool, &msg.payload, telegram_secret().as_deref()).await {
        Ok((user, kind)) => TelegramConfirmResponse {
            ok: true, error: None, user: Some(user), kind: Some(kind.to_string()),
        },
        Err(e) => TelegramConfirmResponse { ok: false, error: Some(e.to_string()), user: None, kind: None },
    };
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("telegram.confirm: ошибка отправки ответа: {}", e);
    }
}

/// Бот прислал `/start <token>`: привязать Telegram к pending-аккаунту и
/// подтвердить его. Один Telegram — один аккаунт; повторный Start тем же
/// Telegram по своей же ссылке идемпотентен.
async fn do_telegram_confirm(pool: &SqlitePool, payload: &[u8], secret: Option<&str>) -> Result<(String, &'static str)> {
    let req: TelegramConfirmRequest = serde_json::from_slice(payload)
        .context("неверный JSON в TelegramConfirmRequest")?;
    let Some(secret) = secret else {
        anyhow::bail!("подтверждение через Telegram не включено");
    };
    // P-43: pre-auth subject без лимита позволял онлайн-перебор секрета бота.
    if !req.client_ip.is_empty()
        && !window_rate_ok("tg-confirm-ip", &req.client_ip, env_u64("PARVANE_TG_CONFIRM_RATE_IP", 10) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
    }
    if !secret_matches(&req.secret, secret) {
        anyhow::bail!("неверный секрет бота");
    }
    let token = req.token.trim();
    if token.is_empty() || req.telegram_id <= 0 {
        anyhow::bail!("пустой токен или telegram_id");
    }
    let link: Option<(String, i64)> =
        sqlx::query_as("SELECT username, expires_at FROM telegram_links WHERE token = ?")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    let Some((user, expires_at)) = link else {
        // Не регистрация — может быть токен двухфакторного входа
        return confirm_login_link(pool, token, req.telegram_id).await.map(|user| (user, "login"));
    };
    if now_unix() > expires_at {
        anyhow::bail!("ссылка устарела, начните регистрацию заново");
    }
    let bound: Option<(String,)> =
        sqlx::query_as("SELECT username FROM users WHERE telegram_id = ? AND username != ?")
            .bind(req.telegram_id)
            .bind(&user)
            .fetch_optional(pool)
            .await?;
    if bound.is_some() {
        anyhow::bail!("этот Telegram уже привязан к другому аккаунту");
    }
    let current: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT email_verified, telegram_id FROM users WHERE username = ?")
            .bind(&user)
            .fetch_optional(pool)
            .await?;
    let Some((verified, telegram_id)) = current else {
        anyhow::bail!("аккаунт не найден");
    };
    if verified != 0 && telegram_id.is_some_and(|id| id != req.telegram_id) {
        anyhow::bail!("аккаунт уже подтверждён другим Telegram");
    }
    sqlx::query("UPDATE users SET email_verified = 1, telegram_id = ? WHERE username = ?")
        .bind(req.telegram_id)
        .bind(&user)
        .execute(pool)
        .await?;
    info!("Аккаунт {} подтверждён через Telegram ({} {})", user, req.telegram_id, req.telegram_name);
    Ok((user, "register"))
}

/// Токен двухфакторного входа: подтвердить может ТОЛЬКО привязанный Telegram
/// (иначе пароль + любой Telegram обходили бы второй фактор).
async fn confirm_login_link(pool: &SqlitePool, token: &str, telegram_id: i64) -> Result<String> {
    let row: Option<(String, i64, i64)> =
        sqlx::query_as("SELECT username, expires_at, confirmed FROM login_links WHERE token = ?")
            .bind(token)
            .fetch_optional(pool)
            .await?;
    let Some((user, expires_at, confirmed)) = row else {
        anyhow::bail!("ссылка не найдена или уже использована");
    };
    if now_unix() > expires_at {
        anyhow::bail!("ссылка входа устарела, войдите заново");
    }
    let linked: Option<(Option<i64>,)> = sqlx::query_as("SELECT telegram_id FROM users WHERE username = ?")
        .bind(&user)
        .fetch_optional(pool)
        .await?;
    let Some((Some(linked_id),)) = linked else {
        anyhow::bail!("к аккаунту не привязан Telegram");
    };
    if linked_id != telegram_id {
        anyhow::bail!("подтвердить вход может только Telegram, привязанный к аккаунту");
    }
    if confirmed == 0 {
        sqlx::query("UPDATE login_links SET confirmed = 1 WHERE token = ?").bind(token).execute(pool).await?;
        info!("Вход {} подтверждён в Telegram ({})", user, telegram_id);
    }
    Ok(user)
}

async fn handle_register_status(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        error!("register.status: нет reply-топика, игнорирую");
        return;
    };
    let confirmed = do_register_status(pool, &msg.payload).await.unwrap_or(false);
    let json = serde_json::to_vec(&RegisterStatusResponse { confirmed }).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("register.status: ошибка отправки ответа: {}", e);
    }
}

/// Подтверждён ли pending-аккаунт. Токен обязателен: без него любой мог бы
/// зондировать статус чужого ника.
async fn do_register_status(pool: &SqlitePool, payload: &[u8]) -> Result<bool> {
    let req: RegisterStatusRequest = serde_json::from_slice(payload)
        .context("неверный JSON в RegisterStatusRequest")?;
    let user = canonical_user(&req.user, &server_domain());
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT u.email_verified FROM users u
         JOIN telegram_links l ON l.username = u.username
         WHERE u.username = ? AND l.token = ?",
    )
    .bind(&user)
    .bind(req.token.trim())
    .fetch_optional(pool)
    .await?;
    if let Some((verified,)) = row {
        return Ok(verified != 0);
    }
    // Токен двухфакторного входа: подтверждён ли Start в привязанном Telegram
    let login: Option<(i64,)> = sqlx::query_as(
        "SELECT confirmed FROM login_links WHERE username = ? AND token = ? AND expires_at >= ?",
    )
    .bind(&user)
    .bind(req.token.trim())
    .bind(now_unix())
    .fetch_optional(pool)
    .await?;
    Ok(login.is_some_and(|(confirmed,)| confirmed != 0))
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
        // P-42: код в лог — только в dev-режиме (PARVANE_DEV=1, локальный стенд/e2e)
        if std::env::var("PARVANE_DEV").ok().as_deref() == Some("1") {
            info!("dev-режим SMTP: код подтверждения для {}: {}", email, code);
        } else {
            warn!("SMTP не настроен (PARVANE_SMTP_HOST): код подтверждения для {} не отправлен", email);
        }
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
    let user = canonical_user(&req.user, &server_domain());
    let code = req.code.trim().to_string();
    if req.user.trim().is_empty() || code.is_empty() {
        anyhow::bail!("пустой логин или код");
    }
    // P-43: аноним мог 6 запросами по чужому нику сжечь попытки кода жертвы.
    if !req.client_ip.is_empty()
        && !window_rate_ok("email-confirm-ip", &req.client_ip, env_u64("PARVANE_EMAIL_CONFIRM_RATE_IP", 20) as usize)
    {
        anyhow::bail!("слишком много попыток, попробуйте позже");
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
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_stale_buckets(&mut guard, now);
    let hits = guard.entry(limiter_key(user)).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    // Успешную попытку учитываем и в глобальном счётчике
    gmap.lock().unwrap().push(now);
    true
}

/// Общий частотный лимит «не более `limit` за 60 с» по произвольному ключу в
/// пространстве `scope` (в памяти процесса). Используется для лимитов по IP.
fn window_rate_ok(scope: &str, key: &str, limit: usize) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static MAP: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    let now = now_unix();
    let map = MAP.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    evict_stale_buckets(&mut guard, now);
    let hits = guard.entry(format!("{scope}:{}", limiter_key(key))).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
}

/// P-37: ключи лимитеров приходят от клиента (логин до 4 МиБ, IP) — ограничиваем
/// длину: длинные заменяем SHA-256-хэшем, чтобы карта не росла на байты атакующего.
const LIMITER_KEY_MAX: usize = 128;
fn limiter_key(key: &str) -> String {
    if key.len() <= LIMITER_KEY_MAX {
        return key.to_string();
    }
    let digest = Sha256::digest(key.as_bytes());
    format!("h:{}", B64.encode(digest))
}

/// P-37: выселение пустых/устаревших корзин, чтобы память лимитеров не росла
/// на уникальных ключах. Зовётся при каждом обращении, но чистит не чаще
/// чем при превышении порога записей.
const LIMITER_MAX_ENTRIES: usize = 50_000;
fn evict_stale_buckets<K: std::hash::Hash + Eq>(map: &mut std::collections::HashMap<K, Vec<i64>>, now: i64) {
    if map.len() < LIMITER_MAX_ENTRIES {
        return;
    }
    map.retain(|_, hits| {
        hits.retain(|&t| now - t < 60);
        !hits.is_empty()
    });
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
    // P-21: суточный кап на пару (PARVANE_PREKEY_FETCH_DAILY, по умолчанию 200):
    // 20/мин без него вычерпывали бы one-time жертвы за минуты.
    let daily = env_u64("PARVANE_PREKEY_FETCH_DAILY", 200) as usize;
    let now = now_unix();
    let map = L.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= LIMITER_MAX_ENTRIES {
        guard.retain(|_, hits| {
            hits.retain(|&t| now - t < 86_400);
            !hits.is_empty()
        });
    }
    let hits = guard.entry((limiter_key(requester), limiter_key(target))).or_default();
    hits.retain(|&t| now - t < 86_400);
    if hits.len() >= daily || hits.iter().filter(|&&t| now - t < 60).count() >= limit {
        return false;
    }
    hits.push(now);
    true
}

/// P-21: повторный фетч той же парой (requester → устройство цели) в течение
/// окна возвращает УЖЕ выданную one-time — иначе каждый повтор сжигал бы новую.
/// Окно PARVANE_PREKEY_REUSE_SECS (по умолчанию 600 с).
/// (requester, target, device_id) → (key_id, public_key, ts)
type OtkReuseMap = std::collections::HashMap<(String, String, String), (i64, String, i64)>;
fn otk_reuse_cache() -> &'static std::sync::Mutex<OtkReuseMap> {
    use std::sync::{Mutex, OnceLock};
    static C: OnceLock<Mutex<OtkReuseMap>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(OtkReuseMap::new()))
}

fn otk_reuse_window() -> i64 {
    env_u64("PARVANE_PREKEY_REUSE_SECS", 600) as i64
}

fn cached_otk(requester: &str, target: &str, device_id: &str) -> Option<(i64, String)> {
    let now = now_unix();
    let mut guard = otk_reuse_cache().lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= LIMITER_MAX_ENTRIES {
        let window = otk_reuse_window();
        guard.retain(|_, (_, _, ts)| now - *ts < window);
    }
    guard
        .get(&(requester.to_string(), target.to_string(), device_id.to_string()))
        .filter(|(_, _, ts)| now - ts < otk_reuse_window())
        .map(|(id, key, _)| (*id, key.clone()))
}

fn remember_otk(requester: &str, target: &str, device_id: &str, key_id: i64, public_key: &str) {
    let mut guard = otk_reuse_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(
        (requester.to_string(), target.to_string(), device_id.to_string()),
        (key_id, public_key.to_string(), now_unix()),
    );
}

/// P-21: предупреждение об исчерпании one-time у устройства (алерт оператору).
const OTK_LOW_WATERMARK: i64 = 5;

async fn handle_verify(
    nc: &Client,
    decoding: &DecodingKey,
    pool: &SqlitePool,
    msg: async_nats::Message,
) {
    let Some(reply) = msg.reply.clone() else {
        error!("verify: нет reply-топика, игнорирую");
        return;
    };

    let resp = match do_verify(decoding, &msg.payload) {
        Ok(claims) => match is_device_revoked(pool, &claims.sub, claims.dev.as_deref()).await {
            Ok(false) => VerifyResponse { ok: true, user: Some(claims.sub), error: None },
            Ok(true) => VerifyResponse {
                ok: false,
                user: None,
                error: Some("устройство отозвано".to_string()),
            },
            Err(e) => VerifyResponse { ok: false, user: None, error: Some(e.to_string()) },
        },
        Err(e) => VerifyResponse { ok: false, user: None, error: Some(e.to_string()) },
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("verify: ошибка отправки ответа: {}", e);
    }
}

fn do_verify(decoding: &DecodingKey, payload: &[u8]) -> Result<Claims> {
    let req: VerifyRequest = serde_json::from_slice(payload)
        .context("неверный JSON в VerifyRequest")?;

    let data = jwt_decode(decoding, &req.token)?;

    Ok(data.claims)
}

/// Единая проверка JWT (P-06): декодирует токен И отклоняет его, если устройство
/// (claim `dev`) отозвано. Раньше отзыв проверялся только в handle_verify, а все
/// остальные обработчики identity верили любому неистёкшему токену — отозванное
/// устройство до 24 ч продолжало менять профиль/ключи/отзывать другие.
async fn verify_active(pool: &SqlitePool, decoding: &DecodingKey, token: &str) -> Result<Claims> {
    let data = jwt_decode(decoding, token)?;
    if is_device_revoked(pool, &data.claims.sub, data.claims.dev.as_deref()).await? {
        anyhow::bail!("устройство отозвано");
    }
    Ok(data.claims)
}

/// verify_active → username (для обработчиков, не пишущих данные устройства).
async fn verify_active_user(pool: &SqlitePool, decoding: &DecodingKey, token: &str) -> Result<String> {
    Ok(verify_active(pool, decoding, token).await?.sub)
}

/// verify_active + привязка к устройству (P-06): токен с claim `dev` может писать
/// данные ТОЛЬКО своего устройства (`device_id == dev`); токен без `dev` —
/// только для пустого `device_id`. Иначе одна сессия аккаунта перезаписывала бы
/// бандл/линковку любого устройства.
async fn verify_active_device(
    pool: &SqlitePool,
    decoding: &DecodingKey,
    token: &str,
    device_id: &str,
) -> Result<String> {
    let claims = verify_active(pool, decoding, token).await?;
    match claims.dev.as_deref() {
        Some(dev) if !dev.is_empty() => {
            if dev != device_id {
                anyhow::bail!("device_id не совпадает с устройством токена");
            }
        }
        _ => {
            if !device_id.is_empty() {
                anyhow::bail!("токен без устройства не может писать за именованное устройство");
            }
        }
    }
    Ok(claims.sub)
}

/// Токен с claim dev отозванного устройства недействителен (Settings → Devices).
async fn is_device_revoked(pool: &SqlitePool, username: &str, device_id: Option<&str>) -> Result<bool> {
    let Some(device_id) = device_id else { return Ok(false) };
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM revoked_devices WHERE username = ? AND device_id = ?")
            .bind(username)
            .bind(device_id)
            .fetch_optional(pool)
            .await
            .context("проверка отзыва устройства")?;
    Ok(found.is_some())
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
        let signing = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (enc, dec, _kid) = keys_from_signing(&signing).unwrap();
        (enc, dec)
    }

    #[test]
    fn jwt_roundtrip() {
        let (enc, dec) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
        let token = jwt_encode(&enc, &claims).unwrap();

        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        let user = do_verify(&dec, &req).unwrap().sub;
        assert_eq!(user, "alice@local");
    }

    #[test]
    fn window_rate_limits_per_scope_and_key() {
        assert!(window_rate_ok("t-scope", "1.2.3.4", 2));
        assert!(window_rate_ok("t-scope", "1.2.3.4", 2));
        assert!(!window_rate_ok("t-scope", "1.2.3.4", 2), "третья за минуту — отказ");
        assert!(window_rate_ok("t-scope", "5.6.7.8", 2), "другой ключ — свой бюджет");
        assert!(window_rate_ok("t-other", "1.2.3.4", 2), "другой scope — свой бюджет");
    }

    #[test]
    fn jwt_wrong_secret_rejected() {
        let (enc, _) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
        let token = jwt_encode(&enc, &claims).unwrap();

        let (_other_enc, other_dec) = make_keys(); // другой Ed25519-ключ
        let req = serde_json::to_vec(&VerifyRequest { token }).unwrap();
        assert!(do_verify(&other_dec, &req).is_err());
    }

    #[test]
    fn legacy_hs256_accepted_only_inside_migration_window() {
        let (_enc, dec) = make_keys();
        let now = now_unix() as usize;
        let claims = Claims { sub: "alice@local".to_string(), iat: now, exp: now + 3600, dev: None };
        let secret = b"legacy-hs256-secret-32-bytes!!!!";
        let hs = encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret)).unwrap();
        // Без legacy-ключа HS256 отклоняется (P-11: alg-confusion невозможен).
        set_legacy_hs256(None);
        assert!(jwt_decode(&dec, &hs).is_err());
        // В окне миграции — принимается.
        set_legacy_hs256(Some((DecodingKey::from_secret(secret), now_unix() + 60)));
        assert_eq!(jwt_decode(&dec, &hs).unwrap().claims.sub, "alice@local");
        // После окна — снова отказ.
        set_legacy_hs256(Some((DecodingKey::from_secret(secret), now_unix() - 1)));
        assert!(jwt_decode(&dec, &hs).is_err());
        set_legacy_hs256(None);
        // EdDSA-токен с kid проходит основным ключом.
        let (enc2, dec2) = make_keys();
        let ed = jwt_encode(&enc2, &claims).unwrap();
        assert_eq!(jwt_decode(&dec2, &ed).unwrap().claims.sub, "alice@local");
        assert!(jwt_decode(&dec, &ed).is_err(), "чужой ключ не проходит");
    }

    #[tokio::test]
    async fn jwt_key_file_is_created_0600_and_legacy_secret_moved_out_of_db() {
        let dir = std::env::temp_dir().join(format!("parvane-jwt-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("identity.db");
        let pool = test_pool().await;
        // legacy-секрет в БД, как на старых инсталляциях
        sqlx::query("INSERT INTO secret (id, bytes) VALUES (1, ?)").bind(&b"old-secret"[..]).execute(&pool).await.unwrap();
        std::env::remove_var("PARVANE_JWT_KEY_FILE");
        let (enc, dec) = load_or_create_jwt_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
        let key_path = dir.join("identity-jwt-ed25519.pem");
        assert!(key_path.exists(), "ключ создан рядом с БД");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM secret").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "legacy-секрет вынесен из SQLite");
        assert!(dir.join("identity-jwt-ed25519.legacy-hs256").exists());
        // повторная загрузка читает тот же ключ (roundtrip подписи)
        let (enc2, dec2) = load_or_create_jwt_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
        let now = now_unix() as usize;
        let claims = Claims { sub: "k@local".into(), iat: now, exp: now + 60, dev: None };
        let t = jwt_encode(&enc, &claims).unwrap();
        assert!(jwt_decode(&dec2, &t).is_ok());
        let t2 = jwt_encode(&enc2, &claims).unwrap();
        assert!(jwt_decode(&dec, &t2).is_ok());
        set_legacy_hs256(None);
        let _ = std::fs::remove_dir_all(&dir);
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

    fn issue_bytes_with_device(user: &str, password: &str, device: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest {
            user: user.into(), password: password.into(), device_id: Some(device.into()), login_token: None, trust_secret: None,
            client_ip: String::new(),
        })
        .unwrap()
    }

    fn issue_bytes_with_device_secret(user: &str, password: &str, device: &str, secret: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest {
            user: user.into(), password: password.into(), device_id: Some(device.into()), login_token: None,
            trust_secret: Some(secret.into()), client_ip: String::new(),
        })
        .unwrap()
    }

    fn issue_bytes(user: &str, password: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest {
            user: user.into(), password: password.into(), device_id: None, login_token: None, trust_secret: None,
            client_ip: String::new(),
        })
        .unwrap()
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
            client_ip: String::new(),
        })
        .unwrap()
    }
    fn confirm_bytes(user: &str, code: &str) -> Vec<u8> {
        serde_json::to_vec(&EmailConfirmRequest { user: user.into(), code: code.into(), client_ip: String::new(), }).unwrap()
    }

    #[tokio::test]
    async fn issue_does_not_create_user() {
        // Регрессия безопасности: логин несуществующего юзера НЕ создаёт аккаунт.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        let err = do_issue(&pool, &enc, &issue_bytes("ghost@local", "pw-secret-1")).await.unwrap_err();
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
        do_register(&pool, &register_bytes("newbie@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        // теперь логин проходит и выдаёт валидный JWT
        let token = do_issue(&pool, &enc, &issue_bytes("newbie@local", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
        let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
        assert_eq!(user, "newbie@local");
        // неверный пароль — отказ
        assert!(do_issue(&pool, &enc, &issue_bytes("newbie@local", "wrong")).await.is_err());
    }

    #[tokio::test]
    async fn issue_indistinguishable_unknown_vs_wrong_password() {
        // Анти-энумерация: несуществующий юзер и неверный пароль — одна ошибка.
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        do_register(&pool, &register_bytes("real@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        let e_unknown = do_issue(&pool, &enc, &issue_bytes("nouser@local", "pw-secret-1"))
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
        do_register(&pool, &register_bytes("lock@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        for _ in 0..5 {
            assert!(do_issue(&pool, &enc, &issue_bytes("lock@local", "bad")).await.is_err());
        }
        // теперь даже верный пароль отклонён (лок-аут активен)
        let err = do_issue(&pool, &enc, &issue_bytes("lock@local", "pw-secret-1"))
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

    // ── адреса: ник без домена, правила ников, чужой домен ──

    #[test]
    fn canonical_user_appends_domain_only_without_at() {
        assert_eq!(canonical_user("alice", "local"), "alice@local");
        assert_eq!(canonical_user("  alice  ", "example.org"), "alice@example.org");
        assert_eq!(canonical_user("bob@other", "local"), "bob@other");
    }

    #[test]
    fn nick_rules() {
        for ok in ["ab", "alice", "a1", "1a", "rl_victim", "content-alice-1725000000000-123", "u.v"] {
            assert!(valid_nick(ok), "{ok} должен быть валидным");
        }
        for bad in ["", "a", "Alice", "al ice", "_alice", "-a", "тест", "a@b", &"x".repeat(65)] {
            assert!(!valid_nick(bad), "{bad:?} должен быть отклонён");
        }
    }

    #[test]
    fn new_user_must_be_on_own_domain() {
        assert!(validate_new_user("alice@local", "local").is_ok());
        assert!(validate_new_user("alice@other", "local").is_err());
        assert!(validate_new_user("Alice@local", "local").is_err());
        assert!(validate_new_user("alice", "local").is_err());
    }

    #[tokio::test]
    async fn register_and_issue_accept_bare_nick() {
        // Клиент шлёт голый ник — сервер сам дополняет до nick@PARVANE_DOMAIN
        // (в тестах домен по умолчанию — local).
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        do_register(&pool, &register_bytes("barenick", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        let (stored,): (String,) = sqlx::query_as("SELECT username FROM users WHERE username = ?")
            .bind("barenick@local").fetch_one(&pool).await.unwrap();
        assert_eq!(stored, "barenick@local");
        let token = do_issue(&pool, &enc, &issue_bytes("barenick", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
        let sub = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
        assert_eq!(sub, "barenick@local");
        // и полный адрес по-прежнему работает
        assert!(do_issue(&pool, &enc, &issue_bytes("barenick@local", "pw-secret-1")).await.is_ok());
    }

    #[tokio::test]
    async fn register_rejects_foreign_domain_and_bad_nick() {
        let pool = test_pool().await;
        let err = do_register(&pool, &register_bytes("alice@evil.example", "pw-secret-1"), ConfirmMode::None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("чужой домен"), "{err}");
        let err = do_register(&pool, &register_bytes("Alice", "pw-secret-1"), ConfirmMode::None).await.unwrap_err();
        assert!(err.to_string().contains("некорректный ник"), "{err}");
        let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap();
        assert_eq!(cnt.0, 0);
    }

    // ── подтверждение через Telegram-бота ──

    fn tg_confirm_bytes(secret: &str, token: &str, telegram_id: i64) -> Vec<u8> {
        serde_json::to_vec(&TelegramConfirmRequest {
            secret: secret.into(),
            token: token.into(),
            telegram_id,
            telegram_name: "tester".into(), client_ip: String::new(), })
        .unwrap()
    }

    fn status_bytes(user: &str, token: &str) -> Vec<u8> {
        serde_json::to_vec(&RegisterStatusRequest { user: user.into(), token: token.into() }).unwrap()
    }

    #[tokio::test]
    async fn telegram_flow_register_confirm_login() {
        let pool = test_pool().await;
        let (enc, _) = make_keys();
        let out = do_register(&pool, &register_bytes("tg", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
        assert!(out.confirm_required);
        let token = out.telegram_token.clone().expect("токен deep link");
        assert!(token.len() >= 20);
        // до Start в боте: не подтверждён, логин отклонён, статус false
        assert!(!do_register_status(&pool, &status_bytes("tg", &token)).await.unwrap());
        let err = do_issue(&pool, &enc, &issue_bytes("tg", "pw-secret-1")).await.unwrap_err();
        assert!(err.to_string().contains("не подтверждена"), "{err}");
        // чужой секрет / чужой токен — отказ
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("wrong", &token, 42), Some("s3cret")).await.is_err());
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", "nope", 42), Some("s3cret")).await.is_err());
        // без включённого режима — отказ даже с верным токеном
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), None).await.is_err());
        // Start в боте подтверждает
        let (user, kind) = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), Some("s3cret")).await.unwrap();
        assert_eq!(user, "tg@local");
        assert_eq!(kind, "register");
        assert!(do_register_status(&pool, &status_bytes("tg", &token)).await.unwrap());
        // статус без верного токена — false (не зондируется)
        assert!(!do_register_status(&pool, &status_bytes("tg", "other")).await.unwrap());
        assert!(do_issue(&pool, &enc, &issue_bytes("tg", "pw-secret-1")).await.is_ok());
        // повторный Start тем же Telegram — идемпотентен
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &token, 42), Some("s3cret")).await.is_ok());
    }

    #[tokio::test]
    async fn telegram_one_account_per_telegram_and_token_refresh() {
        let pool = test_pool().await;
        let out_a = do_register(&pool, &register_bytes("tga", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
        do_telegram_confirm(&pool, &tg_confirm_bytes("s", &out_a.telegram_token.unwrap(), 7), Some("s"))
            .await
            .unwrap();
        // второй аккаунт тем же Telegram — отказ
        let out_b = do_register(&pool, &register_bytes("tgb", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
        let token_b = out_b.telegram_token.unwrap();
        let err = do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b, 7), Some("s")).await.unwrap_err();
        assert!(err.to_string().contains("уже привязан"), "{err}");
        // повторный register pending-аккаунта с тем же паролем — новый токен, старый гаснет
        let out_b2 = do_register(&pool, &register_bytes("tgb", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
        let token_b2 = out_b2.telegram_token.unwrap();
        assert_ne!(token_b, token_b2);
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b, 8), Some("s")).await.is_err());
        assert!(do_telegram_confirm(&pool, &tg_confirm_bytes("s", &token_b2, 8), Some("s")).await.is_ok());
        // чужой пароль на pending — «логин занят»
        let err = do_register(&pool, &register_bytes("tgb", "other-secret-1"), ConfirmMode::Telegram).await.unwrap_err();
        assert!(err.to_string().contains("логин занят"), "{err}");
    }

    // ── регистрация через почту (PARVANE_EMAIL_REQUIRED) ──

    #[tokio::test]
    async fn email_flow_register_confirm_login() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        let out = do_register(
            &pool,
            &register_bytes_email("mail@local", "pw-secret-1", "user@example.com"),
            ConfirmMode::Email,
        )
        .await
        .unwrap();
        assert!(out.confirm_required);
        let (email, code) = out.send.unwrap();
        assert_eq!(email, "user@example.com");
        assert_eq!(code.len(), 6);

        // логин до подтверждения — отказ с различимой ошибкой
        let err = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw-secret-1")).await.unwrap_err();
        assert!(err.to_string().contains("почта не подтверждена"));

        // неверный код — отказ
        let wrong = if code == "000000" { "000001" } else { "000000" };
        assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", wrong)).await.is_err());

        // верный код подтверждает, повторно не работает (одноразовый)
        do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.unwrap();
        assert!(do_email_confirm(&pool, &confirm_bytes("mail@local", &code)).await.is_err());

        let token = do_issue(&pool, &enc, &issue_bytes("mail@local", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
        let user = do_verify(&dec, &serde_json::to_vec(&VerifyRequest { token }).unwrap()).unwrap().sub;
        assert_eq!(user, "mail@local");
    }

    #[tokio::test]
    async fn email_flow_requires_valid_email() {
        let pool = test_pool().await;
        for bad in ["", "no-at", "a@b", "a @b.com", "@x.com"] {
            let err = do_register(
                &pool,
                &register_bytes_email(&format!("u{}@local", bad.len()), "pw-secret-1", bad),
                ConfirmMode::Email,
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
            &register_bytes_email("re@local", "pw-secret-1", "typo@example.com"),
            ConfirmMode::Email,
        )
        .await
        .unwrap();
        let (_, code1) = out1.send.unwrap();
        // повтор с тем же паролем — новый код и исправленный email
        let out2 = do_register(
            &pool,
            &register_bytes_email("re@local", "pw-secret-1", "fixed@example.com"),
            ConfirmMode::Email,
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
        let out3 = do_register(&pool, &register_bytes_email("re@local", "pw-secret-1", ""), ConfirmMode::Email)
            .await
            .unwrap();
        let (email3, code3) = out3.send.unwrap();
        assert_eq!(email3, "fixed@example.com");
        do_email_confirm(&pool, &confirm_bytes("re@local", &code3)).await.unwrap();
        // подтверждённый логин чужим register больше не перехватить
        let err = do_register(
            &pool,
            &register_bytes_email("re@local", "other-secret-1", "x@example.com"),
            ConfirmMode::Email,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("занят"));
    }

    #[tokio::test]
    async fn email_flow_pending_login_protected_until_ttl() {
        let pool = test_pool().await;
        do_register(&pool, &register_bytes_email("pend@local", "pw-secret-1", "p@example.com"), ConfirmMode::Email)
            .await
            .unwrap();
        // чужой пароль на свежем pending — занят
        let err = do_register(
            &pool,
            &register_bytes_email("pend@local", "other-secret-1", "x@example.com"),
            ConfirmMode::Email,
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
            &register_bytes_email("pend@local", "other-secret-1", "x@example.com"),
            ConfirmMode::Email,
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
            &register_bytes_email("brute@local", "pw-secret-1", "b@example.com"),
            ConfirmMode::Email,
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
        let out = do_register(&pool, &register_bytes("plain@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        assert!(!out.confirm_required);
        assert!(out.send.is_none());
        do_issue(&pool, &enc, &issue_bytes("plain@local", "pw-secret-1")).await.unwrap();
    }

    #[tokio::test]
    async fn register_rejects_duplicate() {
        let pool = test_pool().await;
        do_register(&pool, &register_bytes("dup@local", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        let err = do_register(&pool, &register_bytes("dup@local", "other-secret-1"), ConfirmMode::None).await.unwrap_err();
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
    async fn revoked_device_token_fails_verify() {
        let pool = test_pool().await;
        assert!(!is_device_revoked(&pool, "bob@local", Some("dev-x")).await.unwrap());
        assert!(!is_device_revoked(&pool, "bob@local", None).await.unwrap());
        // Отзыв несуществующего бандла тоже оставляет тумбстоун
        let _ = revoke_device(&pool, "bob@local", "dev-x").await.unwrap();
        assert!(is_device_revoked(&pool, "bob@local", Some("dev-x")).await.unwrap());
        assert!(!is_device_revoked(&pool, "bob@local", Some("dev-y")).await.unwrap());
        assert!(!is_device_revoked(&pool, "alice@local", Some("dev-x")).await.unwrap());
    }

    #[test]
    fn password_policy_enforces_length() {
        assert!(password_policy_ok("1").is_err(), "короткий пароль отклонён (P-43)");
        assert!(password_policy_ok("1234567").is_err());
        assert!(password_policy_ok("12345678").is_ok());
        assert!(password_policy_ok(&"x".repeat(1025)).is_err(), "слишком длинный отклонён");
    }

    #[tokio::test]
    async fn require_password_checks_current_hash() {
        let pool = test_pool().await;
        let hash = hash_password("correct-horse").unwrap();
        sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
            .bind("pw@local").bind("pw@local").bind(&hash).execute(&pool).await.unwrap();
        assert!(require_password(&pool, "pw@local", Some("correct-horse")).await.is_ok());
        assert!(require_password(&pool, "pw@local", Some("wrong")).await.is_err());
        assert!(require_password(&pool, "pw@local", None).await.is_err(), "без пароля — отказ (P-07)");
        assert!(require_password(&pool, "pw@local", Some("")).await.is_err());
        assert!(require_password(&pool, "ghost@local", Some("x")).await.is_err(), "нет юзера — отказ без утечки");
    }

    #[tokio::test]
    async fn password_change_requires_old_password_and_resets_trust() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        let hash = hash_password("old-password-1").unwrap();
        sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
            .bind("chg@local").bind("chg@local").bind(&hash).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, ?, 0, ?)")
            .bind("chg@local").bind("dev-1").bind("h").execute(&pool).await.unwrap();
        let now = now_unix() as usize;
        let claims = Claims { sub: "chg@local".into(), iat: now, exp: now + 3600, dev: Some("dev-1".into()) };
        let token = jwt_encode(&enc, &claims).unwrap();
        let body = |old: &str, new: &str| serde_json::to_vec(&PasswordChangeRequest {
            token: token.clone(), old_password: old.into(), new_password: new.into(),
        }).unwrap();
        // Неверный старый пароль — отказ; слабый новый — отказ.
        assert!(do_password_change(&pool, &dec, &body("nope", "new-password-9")).await.is_err());
        assert!(do_password_change(&pool, &dec, &body("old-password-1", "short")).await.is_err());
        // Верная смена: новый хэш действует, доверие 2FA сброшено.
        do_password_change(&pool, &dec, &body("old-password-1", "new-password-9")).await.unwrap();
        assert!(require_password(&pool, "chg@local", Some("new-password-9")).await.is_ok());
        assert!(require_password(&pool, "chg@local", Some("old-password-1")).await.is_err());
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM trusted_devices WHERE username = ?")
            .bind("chg@local").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "смена пароля сбрасывает доверенные устройства");
    }

    #[tokio::test]
    async fn setkey_change_requires_password_republish_does_not() {
        let pool = test_pool().await;
        let hash = hash_password("pass-word-1").unwrap();
        sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, 0)")
            .bind("sk@local").bind("sk@local").bind(&hash).execute(&pool).await.unwrap();
        let k1 = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
        let k2 = base64::engine::general_purpose::STANDARD.encode([2u8; 32]);
        // первая регистрация — без пароля
        store_pubkey(&pool, "sk@local", &k1).await.unwrap();
        let current: (String,) = sqlx::query_as("SELECT pubkey FROM users WHERE username = ?")
            .bind("sk@local").fetch_one(&pool).await.unwrap();
        assert_eq!(current.0, k1);
        // логика обработчика: замена ключа требует пароль
        let need_pw = !current.0.is_empty() && current.0 != k2;
        assert!(need_pw);
        assert!(require_password(&pool, "sk@local", None).await.is_err());
        assert!(require_password(&pool, "sk@local", Some("pass-word-1")).await.is_ok());
        // повторная публикация того же ключа — пароль не нужен
        assert!(!(current.0 != k1));
    }

    #[tokio::test]
    async fn verify_active_rejects_revoked_and_binds_device() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        let now = now_unix() as usize;
        let tok = |dev: Option<&str>| {
            let claims = Claims {
                sub: "bob@local".into(),
                iat: now,
                exp: now + 3600,
                dev: dev.map(str::to_string),
            };
            jwt_encode(&enc, &claims).unwrap()
        };

        // Активный токен устройства dev-1 проходит и привязан к своему device_id.
        let t1 = tok(Some("dev-1"));
        assert_eq!(verify_active_user(&pool, &dec, &t1).await.unwrap(), "bob@local");
        assert!(verify_active_device(&pool, &dec, &t1, "dev-1").await.is_ok());
        // P-06: тем же токеном нельзя писать за ЧУЖОЕ устройство.
        assert!(verify_active_device(&pool, &dec, &t1, "dev-2").await.is_err());
        // Токен без dev — только для пустого device_id.
        let t0 = tok(None);
        assert!(verify_active_device(&pool, &dec, &t0, "").await.is_ok());
        assert!(verify_active_device(&pool, &dec, &t0, "dev-1").await.is_err());
        // После отзыва dev-1 любой его токен отклоняется во всех обработчиках.
        let _ = revoke_device(&pool, "bob@local", "dev-1").await.unwrap();
        assert!(verify_active_user(&pool, &dec, &t1).await.is_err());
        assert!(verify_active_device(&pool, &dec, &t1, "dev-1").await.is_err());
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
        store_link_offer(&pool, "alice@local", "dev-new", "EPH-NEW==", "", "", false).await.unwrap();
        let (offers, grant, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].device_id, "dev-new");
        assert_eq!(offers[0].eph_pub, "EPH-NEW==");
        assert!(grant.is_none());
        // Своего оффера устройство в poll не видит
        let (own_offers, _, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
        assert!(own_offers.is_empty());

        // Старое выдаёт грант — оффер гасится, целевое устройство получает
        // грант РОВНО один раз
        store_link_grant(&pool, "alice@local", "dev-new", "BOX==", "EPH-OLD==").await.unwrap();
        let (offers_after, _, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
        assert!(offers_after.is_empty(), "оффер погашен грантом");
        let (_, g1, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
        let g1 = g1.expect("грант выдан");
        assert_eq!(g1.box_payload, "BOX==");
        assert_eq!(g1.eph_pub, "EPH-OLD==");
        let (_, g2, _) = poll_link(&pool, "alice@local", "dev-new").await.unwrap();
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
        store_link_offer(&pool, "bob@local", "dev-x", "EPH-1==", "", "", false).await.unwrap();
        store_link_grant(&pool, "bob@local", "dev-x", "BOX-1==", "EPH-OLD==").await.unwrap();
        store_link_offer(&pool, "bob@local", "dev-x", "EPH-2==", "", "", false).await.unwrap();
        let (_, grant, _) = poll_link(&pool, "bob@local", "dev-x").await.unwrap();
        assert!(grant.is_none(), "грант под старый эфемерный ключ погашен");
    }

    #[tokio::test]
    async fn link_v2_commitment_challenge_reveal() {
        let pool = test_pool().await;
        insert_user(&pool, "dave@local").await;
        let n_pub_raw = [7u8; 65];
        let n_pub = B64.encode(n_pub_raw);
        let commitment = B64.encode(Sha256::digest(n_pub_raw));
        // 1. Новое устройство публикует ТОЛЬКО обязательство (ключ скрыт).
        store_link_offer(&pool, "dave@local", "dev-new", "", &commitment, "SIGN-NEW==", false).await.unwrap();
        let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].eph_pub, "", "ключ не раскрыт до challenge");
        assert_eq!(offers[0].commitment, commitment);
        assert_eq!(offers[0].signing_key, "SIGN-NEW==");
        // Новое устройство ещё не видит challenge.
        let (_, _, ch) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
        assert!(ch.is_none());
        // 2. Старое прикладывает свой эфемерный ключ; второй challenge другим
        //    ключом (подмена стороны) — отказ.
        store_link_challenge(&pool, "dave@local", "dev-new", "O-PUB==").await.unwrap();
        assert!(store_link_challenge(&pool, "dave@local", "dev-new", "MALLORY==").await.is_err());
        assert!(store_link_challenge(&pool, "dave@local", "dev-new", "O-PUB==").await.is_ok(), "повтор того же — идемпотентен");
        let (_, _, ch) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
        assert_eq!(ch.as_deref(), Some("O-PUB=="));
        // 3. Раскрытие: ключ, не соответствующий обязательству, — отказ.
        let wrong = B64.encode([8u8; 65]);
        assert!(store_link_offer(&pool, "dave@local", "dev-new", &wrong, &commitment, "", false).await.is_err());
        store_link_offer(&pool, "dave@local", "dev-new", &n_pub, &commitment, "", false).await.unwrap();
        let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
        assert_eq!(offers[0].eph_pub, n_pub, "ключ раскрыт");
        assert_eq!(offers[0].challenge_pub, "O-PUB==", "challenge сохранён при раскрытии");
        assert_eq!(offers[0].signing_key, "SIGN-NEW==", "signing_key не затёрт пустым");
        // 4. Грант как раньше — одноразовый.
        store_link_grant(&pool, "dave@local", "dev-new", "BOX==", "O-PUB==").await.unwrap();
        let (_, g, _) = poll_link(&pool, "dave@local", "dev-new").await.unwrap();
        assert!(g.is_some());
        // 5. Отзыв явным флагом.
        store_link_offer(&pool, "dave@local", "dev-new", "", "", "", true).await.unwrap();
        let (offers, _, _) = poll_link(&pool, "dave@local", "dev-old").await.unwrap();
        assert!(offers.is_empty());
    }

    #[tokio::test]
    async fn link_offer_retraction_clears_offer_and_grant() {
        let pool = test_pool().await;
        insert_user(&pool, "carol@local").await;
        store_link_offer(&pool, "carol@local", "dev-n", "EPH==", "", "", false).await.unwrap();
        // Отзыв (пустой eph) гасит оффер
        store_link_offer(&pool, "carol@local", "dev-n", "", "", "", false).await.unwrap();
        let (offers, _, _) = poll_link(&pool, "carol@local", "dev-other").await.unwrap();
        assert!(offers.is_empty(), "отозванный оффер не виден");

        // Отзыв гасит и уже выданный грант
        store_link_offer(&pool, "carol@local", "dev-n", "EPH-2==", "", "", false).await.unwrap();
        store_link_grant(&pool, "carol@local", "dev-n", "BOX==", "EPH-O==").await.unwrap();
        store_link_offer(&pool, "carol@local", "dev-n", "", "", "", false).await.unwrap();
        let (_, grant, _) = poll_link(&pool, "carol@local", "dev-n").await.unwrap();
        assert!(grant.is_none(), "отзыв гасит невостребованный грант");
    }

    #[tokio::test]
    async fn link_is_scoped_per_user_and_expires() {
        let pool = test_pool().await;
        insert_user(&pool, "alice@local").await;
        insert_user(&pool, "eve@local").await;

        store_link_offer(&pool, "alice@local", "dev-new", "EPH==", "", "", false).await.unwrap();
        // Чужой аккаунт офферов не видит и грант выдать не может
        let (offers, _, _) = poll_link(&pool, "eve@local", "dev-eve").await.unwrap();
        assert!(offers.is_empty());
        assert!(store_link_grant(&pool, "eve@local", "dev-new", "BOX==", "EPH==").await.is_err());

        // Просроченный оффер исчезает
        sqlx::query("UPDATE link_offers SET created_at = created_at - 100000")
            .execute(&pool)
            .await
            .unwrap();
        let (stale, _, _) = poll_link(&pool, "alice@local", "dev-old").await.unwrap();
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

    // P-37: длинные ключи лимитеров сворачиваются в хэш, выселение работает
    #[test]
    fn limiter_keys_are_bounded_and_buckets_evicted() {
        let long = "x".repeat(10_000);
        let k = limiter_key(&long);
        assert!(k.len() < 80 && k.starts_with("h:"));
        assert_eq!(limiter_key("short"), "short");
        let mut map: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
        for i in 0..LIMITER_MAX_ENTRIES + 10 {
            map.insert(format!("k{i}"), vec![0]);
        }
        evict_stale_buckets(&mut map, 1_000_000);
        assert!(map.is_empty(), "устаревшие корзины выселены");
        // Уникальные длинные логины не растят карту на их размер
        for i in 0..5 {
            assert!(window_rate_ok("p37", &format!("{}{}", "y".repeat(5_000), i), 3));
        }
    }

    // P-21: повторный фетч той же парой в окне отдаёт ту же one-time
    #[tokio::test]
    async fn repeated_prekey_fetch_reuses_one_time_key() {
        let pool = test_pool().await;
        let (_enc, _dec) = make_keys();
        insert_user(&pool, "reuse@local").await;
        store_prekeys(&pool, "reuse@local", &sample_publish_device("dev-r", 1, &[(1, "o1"), (2, "o2"), (3, "o3")])).await.unwrap();
        let a = fetch_bundle_for(&pool, "asker@local", "reuse@local", &[]).await.unwrap();
        let b = fetch_bundle_for(&pool, "asker@local", "reuse@local", &[]).await.unwrap();
        assert_eq!(a.one_time_id, b.one_time_id, "тот же requester → та же one-time");
        let (left,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM one_time_prekeys WHERE username = 'reuse@local' AND consumed = 0",
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 2, "сожжена одна, не две");
        let c = fetch_bundle_for(&pool, "other@local", "reuse@local", &[]).await.unwrap();
        assert_ne!(c.one_time_id, a.one_time_id, "другой requester — другая one-time");
    }

    // P-19: LIKE-экранирование и минимальная длина запроса
    #[test]
    fn like_escape_neutralizes_wildcards() {
        assert_eq!(like_escape("a%b_c\\d"), "a\\%b\\_c\\\\d");
        assert_eq!(like_escape("plain"), "plain");
        assert!(SEARCH_MIN_CHARS >= 2);
    }

    // P-19: телефон — только владельцу, публичная карточка без PII
    #[test]
    fn public_card_has_no_pii() {
        let card = public_card("u@local", "U", "a".into(), "k".into(), 3, "".into());
        assert!(card.phone.is_none() && card.bio.is_none() && card.birthday.is_none());
        assert_eq!(card.username, "u@local");
        assert_eq!(card.avatar.as_deref(), Some("a"));
    }

    // P-14: секрет доверия ротируется при каждом доверенном входе; старый
    // после этого не принимается (вход снова требует Telegram)
    #[tokio::test]
    async fn trust_secret_rotates_on_each_trusted_login() {
        let pool = test_pool().await;
        let (enc, _dec) = make_keys();
        do_register(&pool, &register_bytes("rot", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        let user = format!("rot@{}", server_domain());
        sqlx::query("UPDATE users SET tg_2fa = 1, telegram_id = 42 WHERE username = ?").bind(&user).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO trusted_devices (username, device_id, confirmed_at, secret_hash) VALUES (?, 'dev-1', 1, ?)")
            .bind(&user).bind(trust_secret_hash("s1")).execute(&pool).await.unwrap();
        let out = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", "s1")).await.unwrap();
        let s2 = out.trust_secret().expect("доверенный вход выдаёт новый секрет").to_string();
        assert!(out.token().is_some() && s2 != "s1");
        let (hash,): (String,) = sqlx::query_as("SELECT secret_hash FROM trusted_devices WHERE username = ? AND device_id = 'dev-1'")
            .bind(&user).fetch_one(&pool).await.unwrap();
        assert_eq!(hash, trust_secret_hash(&s2));
        // Старый секрет больше не доверен → второй фактор
        let again = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", "s1")).await.unwrap();
        assert!(again.token().is_none(), "старый секрет не должен давать вход");
        // Новый — работает и ротируется дальше
        let out3 = do_issue(&pool, &enc, &issue_bytes_with_device_secret("rot", "pw-secret-1", "dev-1", &s2)).await.unwrap();
        assert!(out3.token().is_some() && out3.trust_secret().is_some_and(|s| s != s2));
    }

    fn issue_bytes_with_login_token(user: &str, password: &str, login_token: &str) -> Vec<u8> {
        serde_json::to_vec(&IssueRequest {
            user: user.into(),
            password: password.into(),
            device_id: Some("dev-1".into()),
            login_token: Some(login_token.into()), trust_secret: None,
            client_ip: String::new(),
        })
        .unwrap()
    }

    fn twofa_bytes(token: &str, enabled: Option<bool>) -> Vec<u8> {
        serde_json::to_vec(&TwoFactorRequest { token: token.into(), enabled, password: None, }).unwrap()
    }

    fn twofa_bytes_pw(token: &str, enabled: Option<bool>, password: &str) -> Vec<u8> {
        serde_json::to_vec(&TwoFactorRequest { token: token.into(), enabled, password: Some(password.into()) }).unwrap()
    }

    #[tokio::test]
    async fn twofa_login_requires_linked_telegram_confirmation() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        // Регистрация с подтверждением в Telegram (привязка tg 42)
        let out = do_register(&pool, &register_bytes("two", "pw-secret-1"), ConfirmMode::Telegram).await.unwrap();
        let reg_token = out.telegram_token.unwrap();
        do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &reg_token, 42), Some("s3cret")).await.unwrap();
        let jwt = do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().unwrap().to_string();

        // По умолчанию выключено; включаем по JWT
        assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes(&jwt, None)).await.unwrap(); (e, l) }, (false, true));
        assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes(&jwt, Some(true))).await.unwrap(); (e, l) }, (true, true));
        // Устройство, включившее 2FA (JWT с dev), — доверенное: входит без Telegram
        let dev_jwt = do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await;
        assert!(dev_jwt.is_ok(), "пока 2FA включено JWT без dev-устройства: {:?}", dev_jwt.as_ref().err());
        // P-07: выключить 2FA одним JWT нельзя — нужен пароль (и верный).
        assert!(do_twofa(&pool, &dec, &twofa_bytes(&jwt, Some(false))).await.is_err(), "без пароля 2FA не выключается");
        assert!(do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "wrong-pass-1")).await.is_err(), "с неверным паролем — отказ");
        assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "pw-secret-1")).await.unwrap(); (e, l) }, (false, true));
        let dev_jwt = do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await.unwrap().token().unwrap().to_string();
        let (e, l, secret) = do_twofa(&pool, &dec, &twofa_bytes(&dev_jwt, Some(true))).await.unwrap();
        assert_eq!((e, l), (true, true));
        let secret = secret.expect("устройство, включившее 2FA, получает секрет доверия");
        // device_id публичен (identity.prekeys.fetch отдаёт его любому): без
        // секрета доверия НЕТ — иначе второй фактор обходился при известном пароле
        assert!(do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-enabler")).await.unwrap().token().is_none(),
            "голый device_id больше не доверенный");
        assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-enabler", &secret)).await.unwrap().token().is_some(),
            "устройство, включившее 2FA, входит с секретом без Telegram");
        assert!(do_issue(&pool, &enc, &issue_bytes_with_device("two", "pw-secret-1", "dev-other")).await.unwrap().token().is_none(),
            "другое устройство подтверждает вход");
        assert!(do_twofa(&pool, &dec, &twofa_bytes("bad.jwt", Some(false))).await.is_err());

        // Логин: пароль верен → не JWT, а токен входа
        let outcome = do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap();
        let IssueOutcome::TwoFactor { login_token } = outcome else { panic!("ожидался двухфакторный вход") };
        assert!(!do_register_status(&pool, &status_bytes("two", &login_token)).await.unwrap());
        // Неподтверждённый токен JWT не даёт (выдаётся новый токен)
        let again = do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", &login_token)).await.unwrap();
        let IssueOutcome::TwoFactor { login_token: login_token2 } = again else { panic!("токен без подтверждения") };
        assert!(!do_register_status(&pool, &status_bytes("two", &login_token)).await.unwrap(), "старый токен погашен");
        // Чужой Telegram — отказ; неверный пароль по-прежнему отказ
        let wrong = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &login_token2, 43), Some("s3cret")).await;
        assert!(wrong.unwrap_err().to_string().contains("привязанный"));
        assert!(do_issue(&pool, &enc, &issue_bytes("two", "nope")).await.is_err());
        // Привязанный Telegram подтверждает → статус true → JWT с login_token
        let (user, kind) = do_telegram_confirm(&pool, &tg_confirm_bytes("s3cret", &login_token2, 42), Some("s3cret")).await.unwrap();
        assert_eq!((user.as_str(), kind), ("two@local", "login"));
        assert!(do_register_status(&pool, &status_bytes("two", &login_token2)).await.unwrap());
        let jwt2 = do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", &login_token2)).await.unwrap();
        assert!(jwt2.token().is_some());
        let secret2 = jwt2.trust_secret().expect("после подтверждения в Telegram выдан секрет доверия").to_string();
        // dev-1 доверенное: по паролю + секрету без Telegram; без секрета — подтверждение
        assert!(do_issue(&pool, &enc, &issue_bytes_with_login_token("two", "pw-secret-1", "")).await.unwrap().token().is_none(),
            "dev-1 без секрета — снова подтверждение");
        assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-1", &secret2)).await.unwrap().token().is_some());
        // Другое устройство — снова подтверждение (токен одноразовый и погашен)
        assert!(do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().is_none());
        // Отзыв устройства снимает доверие
        revoke_device(&pool, "two@local", "dev-1").await.unwrap();
        assert!(do_issue(&pool, &enc, &issue_bytes_with_device_secret("two", "pw-secret-1", "dev-1", &secret2)).await.unwrap().token().is_none(),
            "отзыв снимает доверие даже с секретом");
        // Выключение (с паролем, P-07) — обычный логин без Telegram
        assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes_pw(&jwt, Some(false), "pw-secret-1")).await.unwrap(); (e, l) }, (false, true));
        assert!(do_issue(&pool, &enc, &issue_bytes("two", "pw-secret-1")).await.unwrap().token().is_some());
    }

    #[tokio::test]
    async fn twofa_cannot_be_enabled_without_telegram() {
        let pool = test_pool().await;
        let (enc, dec) = make_keys();
        do_register(&pool, &register_bytes("plain", "pw-secret-1"), ConfirmMode::None).await.unwrap();
        let jwt = do_issue(&pool, &enc, &issue_bytes("plain", "pw-secret-1")).await.unwrap().token().unwrap().to_string();
        let err = do_twofa(&pool, &dec, &twofa_bytes(&jwt, Some(true))).await.unwrap_err();
        assert!(err.to_string().contains("привяжите Telegram"), "{err}");
        assert_eq!({ let (e, l, _) = do_twofa(&pool, &dec, &twofa_bytes(&jwt, None)).await.unwrap(); (e, l) }, (false, false));
    }
}
