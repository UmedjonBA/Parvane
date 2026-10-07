// Push шард: web-push (VAPID) для офлайн-устройств. Подписан на инбоксы
// msg.user.> — по факту доставки будит зарегистрированные подписки браузеров.
// Контента он не видит и не разбирает (sealed sender): payload пуша —
// генерический «New message». SW клиента сам гасит пуш, если приложение открыто.
// Протокол v2 (push.wake.*, пустые пробуждения по журналу v2.inbox.>) — в v2.rs
// и библиотеке (src/wake.rs); v1-путь от него не зависит.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use parvane_types::{
    GroupActionResponse, PushRegisterRequest, PushSubscriptionInfo, PushUnregisterRequest,
    PushVapidResponse, VerifyRequest, VerifyResponse,
    topics::{IDENTITY_VERIFY, MSG_USER_PREFIX, MSG_USER_WILDCARD, PUSH_REGISTER, PUSH_UNREGISTER, PUSH_VAPID_GET},
};
use sqlx::{Row, SqlitePool};
use push::vapid::*;
use tracing::{info, warn};
use web_push_native::{Auth, WebPushBuilder};

mod v2;

/// Не дребезжим: не чаще одного пуша на пользователя за интервал.
const PUSH_COOLDOWN_SECS: u64 = 30;
// Формат tt-SW (pushNotification.ts): custom обязателен, текст — description
const PUSH_PAYLOAD: &str = r#"{"title":"Parvane","description":"New message","custom":{}}"#;

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

    let mut vapid_sub = nc.subscribe(PUSH_VAPID_GET).await?;
    let mut register_sub = nc.subscribe(PUSH_REGISTER).await?;
    let mut unregister_sub = nc.subscribe(PUSH_UNREGISTER).await?;
    let mut inbox_sub = nc.subscribe(MSG_USER_WILDCARD).await?;
    info!("Push шард запущен. Слушаю: {}/{}/{} + {}", PUSH_VAPID_GET, PUSH_REGISTER, PUSH_UNREGISTER, MSG_USER_WILDCARD);

    let vapid = Arc::new(vapid);
    // Протокол v2 (spec 007 US6): push.wake.* и пробуждения по v2.inbox.>.
    let v2_pool = v2::open_store(&db_path).await?;
    v2::run(nc.clone(), v2_pool, vapid.clone()).await?;
    let last_push_at: Arc<Mutex<HashMap<String, Instant>>> = Arc::new(Mutex::new(HashMap::new()));

    // 4.5/P-17: отправка web-push (внешние POST) — в tokio::spawn под семафором,
    // отдельно от register/unregister: медленный push-сервис не стопорит шард.
    let handlers = Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    loop {
        let permit = handlers.clone().acquire_owned().await;
        tokio::select! {
            Some(msg) = vapid_sub.next() => {
                let (nc2, vapid2) = (nc.clone(), vapid.clone());
                tokio::spawn(async move { let _p = permit; handle_vapid_get(&nc2, &vapid2, msg).await });
            }
            Some(msg) = register_sub.next() => {
                let (nc2, pool2) = (nc.clone(), pool.clone());
                tokio::spawn(async move { let _p = permit; handle_register(&nc2, &pool2, msg).await });
            }
            Some(msg) = unregister_sub.next() => {
                let (nc2, pool2) = (nc.clone(), pool.clone());
                tokio::spawn(async move { let _p = permit; handle_unregister(&nc2, &pool2, msg).await });
            }
            Some(msg) = inbox_sub.next() => {
                let (pool2, vapid2, last2) = (pool.clone(), vapid.clone(), last_push_at.clone());
                tokio::spawn(async move { let _p = permit; handle_inbox(&pool2, &vapid2, &last2, msg).await });
            }
        }
    }
}

/// Параллелизм обработчиков (PARVANE_HANDLER_CONCURRENCY, по умолчанию 32).
fn handler_concurrency() -> usize {
    std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(32)
}

/// P-17: максимум подписок на пользователя (PARVANE_PUSH_MAX_SUBSCRIPTIONS,
/// по умолчанию 8) — иначе тысячи endpoint'ов на аккаунт превращали бы каждое
/// входящее в N внешних POST'ов (амплификация).
fn max_subscriptions_per_user() -> i64 {
    std::env::var("PARVANE_PUSH_MAX_SUBSCRIPTIONS").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(8)
}

/// P-17: endpoint web-push — только https:// на публичный хост: без userinfo,
/// не IP-литерал непубличного диапазона, не localhost/однословное имя.
/// Фильтр — общий parvane-netguard (T106), порт любой.
fn endpoint_is_public_https(endpoint: &str) -> bool {
    parvane_netguard::check_url(endpoint, &parvane_netguard::UrlPolicy::HTTPS).is_ok()
}

/// P-17: резолв хоста endpoint'а при регистрации — все адреса обязаны быть
/// публичными (SSRF во внутреннюю сеть через подписку).
async fn endpoint_resolves_public(endpoint: &str) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint) else { return false };
    parvane_netguard::resolve_url(&parsed).await.is_ok()
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

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc.request(IDENTITY_VERIFY, req.into()).await.context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

async fn handle_vapid_get(nc: &Client, vapid: &VapidKeys, msg: async_nats::Message) {
    let Some(reply) = msg.reply else { return };
    let resp = PushVapidResponse {
        ok: true,
        public_key: Some(vapid.public_b64url.clone()),
        error: None,
    };
    if let Ok(body) = serde_json::to_vec(&resp) {
        let _ = nc.publish(reply, body.into()).await;
    }
}

async fn reply_action(nc: &Client, reply: async_nats::Subject, ok: bool, error: Option<String>) {
    let resp = GroupActionResponse { ok, error, error_code: None };
    if let Ok(body) = serde_json::to_vec(&resp) {
        let _ = nc.publish(reply, body.into()).await;
    }
}

async fn handle_register(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let result: Result<()> = async {
        let req: PushRegisterRequest =
            serde_json::from_slice(&msg.payload).context("JSON push.device.register")?;
        let user = verify_token(nc, &req.token).await?;
        // P-17: endpoint — только публичный https, число подписок ограничено
        if !endpoint_is_public_https(&req.subscription.endpoint) {
            anyhow::bail!("endpoint должен быть публичным https-адресом");
        }
        if !endpoint_resolves_public(&req.subscription.endpoint).await {
            anyhow::bail!("хост endpoint не резолвится в публичный адрес");
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let subscription_json = serde_json::to_string(&req.subscription)?;
        // Кап подписок: при переполнении удаляем самые старые
        let max = max_subscriptions_per_user();
        sqlx::query(
            "DELETE FROM push_subscriptions WHERE user = ? AND endpoint <> ? AND rowid NOT IN (
                SELECT rowid FROM push_subscriptions WHERE user = ? AND endpoint <> ?
                ORDER BY created_at DESC LIMIT ?)",
        )
        .bind(&user)
        .bind(&req.subscription.endpoint)
        .bind(&user)
        .bind(&req.subscription.endpoint)
        .bind(max - 1)
        .execute(pool)
        .await?;
        // MSG-16: endpoint, уже записанный за ДРУГИМ пользователем, не
        // перерегистрируется — иначе зная чужой URL подписки, его отбирали.
        let res = sqlx::query(
            "INSERT INTO push_subscriptions (endpoint, user, subscription_json, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
                 subscription_json = excluded.subscription_json, created_at = excluded.created_at
             WHERE push_subscriptions.user = excluded.user",
        )
        .bind(&req.subscription.endpoint)
        .bind(&user)
        .bind(&subscription_json)
        .bind(now)
        .execute(pool)
        .await?;
        if res.rows_affected() == 0 {
            anyhow::bail!("endpoint уже зарегистрирован другим пользователем");
        }
        info!("подписка зарегистрирована для {}", user);
        Ok(())
    }
    .await;

    match result {
        Ok(()) => reply_action(nc, reply, true, None).await,
        Err(e) => {
            warn!("register отклонён: {}", e);
            reply_action(nc, reply, false, Some(parvane_db::public_error(&e))).await;
        }
    }
}

async fn handle_unregister(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else { return };
    let result: Result<()> = async {
        let req: PushUnregisterRequest =
            serde_json::from_slice(&msg.payload).context("JSON push.device.unregister")?;
        let user = verify_token(nc, &req.token).await?;
        match req.endpoint {
            Some(endpoint) => {
                sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user = ?")
                    .bind(&endpoint)
                    .bind(&user)
                    .execute(pool)
                    .await?;
            }
            None => {
                sqlx::query("DELETE FROM push_subscriptions WHERE user = ?")
                    .bind(&user)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => reply_action(nc, reply, true, None).await,
        Err(e) => {
            warn!("unregister отклонён: {}", e);
            reply_action(nc, reply, false, Some(parvane_db::public_error(&e))).await;
        }
    }
}

async fn handle_inbox(
    pool: &SqlitePool,
    vapid: &VapidKeys,
    last_push_at: &Mutex<HashMap<String, Instant>>,
    msg: async_nats::Message,
) {
    // Субъект вида msg.user.<адрес>; сам payload — sealed, не разбираем
    let Some(user) = msg.subject.strip_prefix(MSG_USER_PREFIX) else { return };
    let user = user.to_string();

    {
        let mut guard = last_push_at.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() > 50_000 {
            guard.retain(|_, t| t.elapsed() < Duration::from_secs(PUSH_COOLDOWN_SECS));
        }
        if let Some(last) = guard.get(&user) {
            if last.elapsed() < Duration::from_secs(PUSH_COOLDOWN_SECS) {
                return;
            }
        }
    }

    let rows = match sqlx::query(
        "SELECT endpoint, subscription_json FROM push_subscriptions WHERE user = ?",
    )
    .bind(&user)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!("чтение подписок {} не удалось: {}", user, e);
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    last_push_at.lock().unwrap_or_else(|e| e.into_inner()).insert(user.clone(), Instant::now());

    for row in rows {
        let endpoint: String = row.get("endpoint");
        let subscription_json: String = row.get("subscription_json");
        let Ok(info) = serde_json::from_str::<PushSubscriptionInfo>(&subscription_json) else {
            continue;
        };

        let request = match build_push_request(vapid, &info, unix_now()) {
            Ok(request) => request,
            Err(e) => {
                warn!("сборка пуша для {} не удалась: {}", user, e);
                continue;
            }
        };
        let request = match reqwest::Request::try_from(request) {
            Ok(r) => r,
            Err(e) => {
                warn!("сборка HTTP-запроса для {} не удалась: {}", user, e);
                continue;
            }
        };

        let push_client = match pinned_push_client(&endpoint).await {
            Ok(c) => c,
            Err(e) => {
                warn!("endpoint подписки {} отклонён фильтром: {}", user, e);
                continue;
            }
        };
        match push_client.execute(request).await {
            Ok(resp) if resp.status().is_success() => info!("push отправлен: {}", user),
            Ok(resp)
                if resp.status() == reqwest::StatusCode::NOT_FOUND
                    || resp.status() == reqwest::StatusCode::GONE =>
            {
                // Подписка мертва (браузер отписался) — вычищаем
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
                    .bind(&endpoint)
                    .execute(pool)
                    .await;
                info!("мёртвая подписка удалена: {}", user);
            }
            Ok(resp) => warn!("push для {} не доставлен: HTTP {}", user, resp.status()),
            Err(e) => warn!("push для {} не доставлен: {}", user, e),
        }
    }
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

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Ключи подписки браузера: `p256dh` — несжатая точка P-256 (65 байт), `auth` — 16 байт.
fn subscription_keys(info: &PushSubscriptionInfo) -> Result<(p256::PublicKey, Auth)> {
    let p256dh = b64url_decode(&info.keys.p256dh).context("p256dh")?;
    let ua_public = p256::PublicKey::from_sec1_bytes(&p256dh)
        .map_err(|e| anyhow::anyhow!("p256dh не точка P-256: {e}"))?;
    let auth = b64url_decode(&info.keys.auth).context("auth")?;
    if auth.len() != 16 {
        anyhow::bail!("auth должен быть 16 байт, получено {}", auth.len());
    }
    Ok((ua_public, Auth::clone_from_slice(&auth)))
}

/// Собирает POST на push-сервис: тело зашифровано aes128gcm (RFC 8291) через
/// web-push-native, VAPID-заголовок добавляем сами.
fn build_push_request(
    vapid: &VapidKeys,
    info: &PushSubscriptionInfo,
    now: u64,
) -> Result<http::Request<Vec<u8>>> {
    let endpoint_url = url::Url::parse(&info.endpoint).context("endpoint")?;
    let uri: http::Uri = info.endpoint.parse().context("endpoint как URI")?;
    let (ua_public, ua_auth) = subscription_keys(info)?;
    let mut request = WebPushBuilder::new(uri, ua_public, ua_auth)
        .with_valid_duration(Duration::from_secs(VAPID_JWT_TTL_SECS))
        .build(PUSH_PAYLOAD.as_bytes())
        .map_err(|e| anyhow::anyhow!("шифрование пуша: {e}"))?;
    let authorization = vapid_authorization(vapid, &endpoint_url, now)?;
    request.headers_mut().insert(
        http::header::AUTHORIZATION,
        http::HeaderValue::from_str(&authorization).context("заголовок VAPID")?,
    );
    request
        .headers_mut()
        .insert("Urgency", http::HeaderValue::from_static("normal"));
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use sqlx::sqlite::SqlitePoolOptions;

    // P-17: endpoint — только публичный https без userinfo и приватных IP
    #[test]
    fn endpoint_validation_rejects_ssrf_targets() {
        assert!(endpoint_is_public_https("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(endpoint_is_public_https("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(endpoint_is_public_https("https://8.8.8.8/push"));
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://user:pw@fcm.googleapis.com/x",
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://10.0.0.5/x",
            "https://192.168.1.1/x",
            "https://172.16.0.1/x",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/x",
            "https://[fd00::1]/x",
            "https://[::ffff:10.0.0.1]/x",
            "https://push.local/x",
            "https://gateway/x",
            "ftp://x.example/x",
            "not a url",
        ] {
            assert!(!endpoint_is_public_https(bad), "{bad}");
        }
        assert!(max_subscriptions_per_user() >= 1);
    }

    /// Класс 14: единый набор адресов netguard через проверку endpoint'а push.
    #[test]
    fn netguard_address_set_blocks_push_endpoints() {
        use parvane_netguard::test_addrs::{ALLOWED, BLOCKED};
        let url_of = |a: &str| match a.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(_)) => format!("https://[{a}]/push"),
            _ => format!("https://{a}/push"),
        };
        for a in BLOCKED {
            assert!(!endpoint_is_public_https(&url_of(a)), "{a}");
        }
        for a in ALLOWED {
            assert!(endpoint_is_public_https(&url_of(a)), "{a}");
        }
    }

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

    fn test_subscription() -> PushSubscriptionInfo {
        let ua = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let point = ua.public_key().to_sec1_bytes();
        PushSubscriptionInfo {
            endpoint: "https://fcm.googleapis.com:443/fcm/send/abc".to_string(),
            keys: parvane_types::PushSubscriptionKeys {
                p256dh: b64url(&point),
                auth: base64::engine::general_purpose::URL_SAFE.encode([7u8; 16]),
            },
        }
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
    #[test]
    fn push_request_has_encrypted_body_and_vapid_headers() {
        let vapid = test_vapid();
        let info = test_subscription();
        let req = build_push_request(&vapid, &info, 1_700_000_000).unwrap();
        assert_eq!(req.method(), http::Method::POST);
        assert_eq!(req.uri().host(), Some("fcm.googleapis.com"));
        let h = req.headers();
        assert_eq!(h.get("content-encoding").unwrap(), "aes128gcm");
        assert_eq!(h.get("ttl").unwrap(), VAPID_JWT_TTL_SECS.to_string().as_str());
        assert!(h.get("authorization").unwrap().to_str().unwrap().starts_with("vapid t="));
        // aes128gcm: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext(payload+1+16)
        assert!(req.body().len() >= 86 + PUSH_PAYLOAD.len() + 17);
        assert!(!req.body().windows(7).any(|w| w == b"Parvane"), "тело зашифровано");

        let mut bad = test_subscription();
        bad.keys.auth = b64url(&[1u8; 15]);
        assert!(build_push_request(&vapid, &bad, 0).is_err(), "auth не 16 байт");
        let mut bad = test_subscription();
        bad.keys.p256dh = b64url(&[4u8; 65]);
        assert!(build_push_request(&vapid, &bad, 0).is_err(), "p256dh не на кривой");
    }

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
