//! JWT (EdDSA + kid, приём legacy HS256), пароли/argon2, verify и отзыв устройств.

use crate::*;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    pub(crate) sub: String,
    pub(crate) exp: usize,
    pub(crate) iat: usize,
    /// device_id устройства (если клиент его сообщил при issue)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) dev: Option<String>,
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
pub(crate) const LEGACY_HS256_WINDOW_SECS: i64 = 86_400;

/// kid текущего Ed25519-ключа (в заголовке JWT) — задаётся при старте.
pub(crate) static JWT_KID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
/// Legacy HS256-ключ и момент, до которого он принимается.
pub(crate) static LEGACY_HS256: std::sync::LazyLock<std::sync::RwLock<Option<(DecodingKey, i64)>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

pub(crate) fn jwt_key_path(db_path: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PARVANE_JWT_KEY_FILE") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let dir = std::path::Path::new(db_path).parent().unwrap_or(std::path::Path::new("."));
    dir.join("identity-jwt-ed25519.pem")
}

/// Запись секретного файла с правами 0600 (unix); на других ОС — обычная запись.
pub(crate) fn write_secret_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
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

pub(crate) fn kid_for(verifying: &ed25519_dalek::VerifyingKey) -> String {
    verifying.as_bytes().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn keys_from_signing(signing: &ed25519_dalek::SigningKey) -> Result<(EncodingKey, DecodingKey, String)> {
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
pub(crate) async fn load_or_create_jwt_keys(pool: &SqlitePool, db_path: &str) -> Result<(EncodingKey, DecodingKey)> {
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

pub(crate) fn set_legacy_hs256(value: Option<(DecodingKey, i64)>) {
    if let Ok(mut g) = LEGACY_HS256.write() {
        *g = value;
    }
}

/// Подпись JWT: EdDSA с kid текущего ключа.
pub(crate) fn jwt_encode(encoding: &EncodingKey, claims: &Claims) -> Result<String> {
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = JWT_KID.get().cloned();
    encode(&header, claims, encoding).context("подпись JWT")
}

/// Проверка JWT: EdDSA основным ключом; HS256 — только legacy-секретом и только
/// в окне миграции. Любой другой алгоритм отклоняется.
pub(crate) fn jwt_decode(decoding: &DecodingKey, token: &str) -> Result<jsonwebtoken::TokenData<Claims>> {
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
pub(crate) fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))
}

/// Проверка пароля против хранимого PHC-хэша (константное время внутри argon2).
pub(crate) fn verify_password(password: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// P-43: политика пароля — не короче 8 и не длиннее 1024 символов.
pub(crate) fn password_policy_ok(password: &str) -> Result<()> {
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
/// ID-05: та же корзина попыток, что у входа, — иначе украденный JWT давал
/// онлайн-перебор пароля через `twofa`/`device.revoke` без лок-аута.
pub(crate) async fn require_password(pool: &SqlitePool, username: &str, password: Option<&str>) -> Result<()> {
    let Some(password) = password.filter(|p| !p.is_empty()) else {
        anyhow::bail!("требуется пароль");
    };
    login_gate_check(username)?;
    let row: Option<(String,)> =
        sqlx::query_as("SELECT password_hash FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(pool)
            .await?;
    let Some((hash,)) = row else {
        let _ = verify_password(password, dummy_password_hash());
        login_record_failure(username);
        anyhow::bail!("неверный пароль");
    };
    if !verify_password(password, &hash) {
        login_record_failure(username);
        anyhow::bail!("неверный пароль");
    }
    login_record_success(username);
    Ok(())
}

// ── main ─────────────────────────────────────────────────────────────────────

/// Хэш секрета доверия для trusted_devices.secret_hash.
pub(crate) fn trust_secret_hash(secret: &str) -> String {
    B64.encode(Sha256::digest(secret.as_bytes()))
}

/// Новый секрет доверия (32 случайных байта, base64) + его хэш.
pub(crate) fn new_trust_secret() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = B64.encode(bytes);
    let hash = trust_secret_hash(&secret);
    (secret, hash)
}

/// Исход логина: JWT или ожидание подтверждения двухфакторного входа.
#[derive(Debug)]
pub(crate) enum IssueOutcome {
    Token { token: String, trust_secret: Option<String> },
    TwoFactor { login_token: String },
}

impl IssueOutcome {
    #[cfg(test)]
    pub(crate) fn token(&self) -> Option<&str> {
        match self {
            IssueOutcome::Token { token, .. } => Some(token),
            IssueOutcome::TwoFactor { .. } => None,
        }
    }
    #[cfg(test)]
    pub(crate) fn trust_secret(&self) -> Option<&str> {
        match self {
            IssueOutcome::Token { trust_secret, .. } => trust_secret.as_deref(),
            IssueOutcome::TwoFactor { .. } => None,
        }
    }
}

/// Dummy argon2-хэш постоянного времени: verify по нему для несуществующего
/// пользователя тратит то же время, что и реальная проверка (анти-timing).
pub(crate) fn dummy_password_hash() -> &'static str {
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

pub(crate) async fn handle_verify(
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
        Ok(claims) => match token_rejection(pool, &claims).await {
            Ok(None) => VerifyResponse { ok: true, user: Some(claims.sub), error: None, device: claims.dev },
            Ok(Some(reason)) => VerifyResponse {
                ok: false,
                user: None,
                error: Some(reason.to_string()),
                device: None,
            },
            Err(e) => VerifyResponse { ok: false, user: None, error: Some(parvane_db::public_error(&e)), device: None },
        },
        Err(e) => VerifyResponse { ok: false, user: None, error: Some(parvane_db::public_error(&e)), device: None },
    };

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    if let Err(e) = nc.publish(reply, json.into()).await {
        error!("verify: ошибка отправки ответа: {}", e);
    }
}

pub(crate) fn do_verify(decoding: &DecodingKey, payload: &[u8]) -> Result<Claims> {
    let req: VerifyRequest = serde_json::from_slice(payload)
        .context("неверный JSON в VerifyRequest")?;

    let data = jwt_decode(decoding, &req.token)?;

    Ok(data.claims)
}

/// Единая проверка JWT (P-06): декодирует токен И отклоняет его, если устройство
/// (claim `dev`) отозвано. Раньше отзыв проверялся только в handle_verify, а все
/// остальные обработчики identity верили любому неистёкшему токену — отозванное
/// устройство до 24 ч продолжало менять профиль/ключи/отзывать другие.
pub(crate) async fn verify_active(pool: &SqlitePool, decoding: &DecodingKey, token: &str) -> Result<Claims> {
    let data = jwt_decode(decoding, token)?;
    if let Some(reason) = token_rejection(pool, &data.claims).await? {
        anyhow::bail!("{reason}");
    }
    Ok(data.claims)
}

/// Почему живой (по подписи и сроку) токен всё же недействителен: устройство
/// отозвано (P-06) либо пароль сменён после выдачи токена (ID-06) — кроме
/// токенов устройства, с которого пароль сменили.
pub(crate) async fn token_rejection(pool: &SqlitePool, claims: &Claims) -> Result<Option<&'static str>> {
    if is_device_revoked(pool, &claims.sub, claims.dev.as_deref()).await? {
        return Ok(Some("устройство отозвано"));
    }
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT password_changed_at, password_changed_dev FROM users WHERE username = ?")
            .bind(&claims.sub)
            .fetch_optional(pool)
            .await
            .context("проверка смены пароля")?;
    if let Some((changed_at, keep_dev)) = row {
        let issued_before = (claims.iat as i64) < changed_at;
        let is_keeper = !keep_dev.is_empty() && claims.dev.as_deref() == Some(keep_dev.as_str());
        if issued_before && !is_keeper {
            return Ok(Some("пароль сменён — войдите заново"));
        }
    }
    Ok(None)
}

/// verify_active → username (для обработчиков, не пишущих данные устройства).
pub(crate) async fn verify_active_user(pool: &SqlitePool, decoding: &DecodingKey, token: &str) -> Result<String> {
    Ok(verify_active(pool, decoding, token).await?.sub)
}

/// verify_active + привязка к устройству (P-06): токен с claim `dev` может писать
/// данные ТОЛЬКО своего устройства (`device_id == dev`); токен без `dev` —
/// только для пустого `device_id`. Иначе одна сессия аккаунта перезаписывала бы
/// бандл/линковку любого устройства.
pub(crate) async fn verify_active_device(
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
pub(crate) async fn is_device_revoked(pool: &SqlitePool, username: &str, device_id: Option<&str>) -> Result<bool> {
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
