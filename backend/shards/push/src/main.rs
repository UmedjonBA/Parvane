// Push шард: web-push (VAPID) для офлайн-устройств. Подписан на инбоксы
// msg.user.> — по факту доставки будит зарегистрированные подписки браузеров.
// Контента он не видит и не разбирает (sealed sender): payload пуша —
// генерический «New message». SW клиента сам гасит пуш, если приложение открыто.
// Протокол v2 (push.wake.*, пустые пробуждения по журналу v2.inbox.>) — в v2.rs
// и библиотеке (src/wake.rs); v1-путь от него не зависит.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use sqlx::{Row, SqlitePool};
use push::vapid::*;
use tracing::{info, warn};

mod v2;



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
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./push.db".to_string());

    // P-38: общий коннект (WAL, busy_timeout 30 с) — см. parvane-db
    let pool = parvane_db::connect(&db_path).await?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let vapid = ensure_vapid_keys(&pool, &db_path).await?;
    info!("VAPID готов, public key: {}…", &vapid.public_b64url[..16.min(vapid.public_b64url.len())]);

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let vapid = Arc::new(vapid);
    // Протокол v2 (spec 007 US6): push.wake.* и пробуждения по v2.inbox.>.
    let v2_pool = v2::open_store(&db_path).await?;
    v2::run(nc.clone(), v2_pool, vapid.clone()).await?;
    info!("Push шард запущен (протокол v2: push.wake.*, пробуждения по v2.inbox.>)");
    std::future::pending::<()>().await;
    Ok(())
}

/// Параллелизм обработчиков (PARVANE_HANDLER_CONCURRENCY, по умолчанию 32).
fn handler_concurrency() -> usize {
    std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(32)
}





/// Клиент для одного POST на push-сервис: endpoint перепроверяется общим
/// фильтром, адреса хоста резолвятся заново и фиксируются (анти-rebinding
/// между регистрацией и отправкой).
async fn pinned_push_client(endpoint: &str) -> Result<reqwest::Client> {
    let parsed = parvane_netguard::check_url(endpoint, &parvane_netguard::UrlPolicy::HTTPS)?;
    let (host, addrs) = parvane_netguard::resolve_url(&parsed).await?;
    build_http_client(parvane_netguard::pinned_client_builder(&host, &addrs))
}

/// P-11: приватный VAPID-ключ живёт в файле PARVANE_VAPID_KEY_FILE (PKCS#8 PEM,
/// права 0600; по умолчанию рядом с БД), а не в SQLite — иначе утечка push.db
/// или незашифрованного бэкапа давала возможность слать web-push от имени
/// сервера. Старый ключ из таблицы vapid_keys при первом старте переносится в
/// файл и удаляется из БД.
fn vapid_key_path(db_path: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PARVANE_VAPID_KEY_FILE") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let dir = std::path::Path::new(db_path).parent().unwrap_or(std::path::Path::new("."));
    dir.join("push-vapid-p256.pem")
}

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

async fn ensure_vapid_keys(pool: &SqlitePool, db_path: &str) -> Result<VapidKeys> {
    let path = vapid_key_path(db_path);
    match std::fs::read_to_string(&path) {
        Ok(pem) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.permissions().mode() & 0o077 != 0 {
                        warn!("{}: права шире 0600 — VAPID-ключ доступен другим пользователям", path.display());
                    }
                }
            }
            // Ключ из файла имеет приоритет; строку в БД (если осталась) удаляем.
            let _ = sqlx::query("DELETE FROM vapid_keys WHERE id = 1").execute(pool).await;
            return vapid_from_pem(&pem);
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(e).with_context(|| format!("чтение {}", path.display()));
        }
        Err(_) => {}
    }
    // Миграция: ключ ещё в SQLite → переносим в файл и удаляем из БД.
    if let Some(row) = sqlx::query("SELECT private_pem FROM vapid_keys WHERE id = 1")
        .fetch_optional(pool)
        .await?
    {
        let private_pem: String = row.get("private_pem");
        let keys = vapid_from_pem(&private_pem)?;
        write_secret_file(&path, private_pem.as_bytes())?;
        sqlx::query("DELETE FROM vapid_keys WHERE id = 1").execute(pool).await?;
        warn!("VAPID-ключ вынесен из SQLite в {} — сохраните файл в бэкап отдельно от БД", path.display());
        return Ok(keys);
    }
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let private_pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .context("экспорт VAPID-ключа в PEM")?
        .to_string();
    write_secret_file(&path, private_pem.as_bytes())?;
    warn!("сгенерирована новая пара VAPID-ключей: {} (подписки браузеров привязаны к публичному ключу)", path.display());
    vapid_from_pem(&private_pem)
}







/// P-51: HTTP-клиент для push-сервисов: rustls, без редиректов и без прокси
/// (база — parvane-netguard; редирект не должен увести на внутренний адрес),
/// короткий таймаут, чтобы медленный push-сервис не держал воркер.
fn build_http_client(builder: reqwest::ClientBuilder) -> Result<reqwest::Client> {
    builder
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .user_agent("parvane-push/0.1")
        .build()
        .context("HTTP-клиент push")
}




#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sqlx::sqlite::SqlitePoolOptions;

    // P-17: endpoint — только публичный https без userinfo и приватных IP

    /// Класс 14: единый набор адресов netguard через проверку endpoint'а push.

    #[tokio::test]
    async fn send_path_rechecks_endpoint() {
        assert!(pinned_push_client("https://127.0.0.1/push").await.is_err());
        assert!(pinned_push_client("https://[::1]/push").await.is_err());
        assert!(pinned_push_client("http://8.8.8.8/push").await.is_err());
        assert!(pinned_push_client("https://8.8.8.8/push").await.is_ok());
    }

    fn test_vapid() -> VapidKeys {
        let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
        vapid_from_pem(&secret.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap()
    }


    // P-51: собственный VAPID-JWT (ES256) вместо web-push/jwt-simple/rsa
    #[test]
    fn vapid_authorization_is_rfc8292_es256() {
        use p256::ecdsa::signature::Verifier;
        let vapid = test_vapid();
        let endpoint = url::Url::parse("https://updates.push.services.mozilla.com/wpush/v2/x").unwrap();
        let now = 1_700_000_000u64;
        let header = vapid_authorization(&vapid, &endpoint, now).unwrap();
        let rest = header.strip_prefix("vapid t=").expect("схема vapid");
        let (jwt, key) = rest.split_once(", k=").expect("t и k");
        assert_eq!(key, vapid.public_b64url);

        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let hdr: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[0]).unwrap()).unwrap();
        assert_eq!(hdr["alg"], "ES256");
        assert_eq!(hdr["typ"], "JWT");
        let claims: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://updates.push.services.mozilla.com", "aud — только origin");
        assert_eq!(claims["exp"], now + VAPID_JWT_TTL_SECS);
        assert!(claims["sub"].as_str().unwrap().starts_with("mailto:"));

        let sig_bytes = b64url_decode(parts[2]).unwrap();
        assert_eq!(sig_bytes.len(), 64, "r||s без DER");
        let signature = p256::ecdsa::Signature::from_slice(&sig_bytes).unwrap();
        let pub_bytes = b64url_decode(key).unwrap();
        let verifying = p256::ecdsa::VerifyingKey::from_sec1_bytes(&pub_bytes).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .expect("подпись проверяется публичным ключом из k=");
    }

    #[test]
    fn vapid_audience_keeps_explicit_port_only() {
        assert_eq!(
            vapid_audience(&url::Url::parse("https://push.example.com/a/b").unwrap()).unwrap(),
            "https://push.example.com"
        );
        assert_eq!(
            vapid_audience(&url::Url::parse("https://push.example.com:8443/a").unwrap()).unwrap(),
            "https://push.example.com:8443"
        );
    }

    // Тело — aes128gcm (RFC 8291), заголовки по RFC 8030/8292, ключи с паддингом и без

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn vapid_key_lives_in_0600_file_and_migrates_out_of_db() {
        let dir = std::env::temp_dir().join(format!("parvane-vapid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("push.db");
        std::env::remove_var("PARVANE_VAPID_KEY_FILE");
        let pool = test_pool().await;
        // legacy: ключ в БД
        let legacy = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let legacy_pem = legacy.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        sqlx::query("INSERT INTO vapid_keys (id, private_pem, public_b64url) VALUES (1, ?, 'x')")
            .bind(&legacy_pem).execute(&pool).await.unwrap();
        let k1 = ensure_vapid_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
        assert_eq!(k1.private_pem, legacy_pem, "мигрирован тот же ключ (подписки не теряются)");
        let path = dir.join("push-vapid-p256.pem");
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM vapid_keys").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "ключ удалён из SQLite");
        // повторная загрузка — из файла, тот же публичный ключ
        let k2 = ensure_vapid_keys(&pool, db_path.to_str().unwrap()).await.unwrap();
        assert_eq!(k1.public_b64url, k2.public_b64url);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
