// Preview шард: отдаёт OG-метаданные ссылки по запросу отправителя. Наружу
// ходит шард (а не браузер клиента) — так скрывается IP отправителя и
// централизуется SSRF-защита. Модель приватности прежняя: превью генерирует
// отправитель и кладёт внутрь E2E-контента; шард лишь помогает добыть метаданные.

mod v2;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    ParvaneEvent, MapTileRequest, MapTileResponse, PreviewFetchRequest, PreviewFetchResponse, VerifyRequest, VerifyResponse,
    WebPagePreview,
    topics::{IDENTITY_VERIFY, PREVIEW_FETCH, PREVIEW_MAP_TILE},
};
use sqlx::SqlitePool;
use tracing::{debug, info, warn};

// Лимиты (согласованы с desktop-эталоном parvane_client.cpp); редиректы и
// фильтр адресов — общий parvane-netguard (T106)
use parvane_netguard::{UrlPolicy, MAX_REDIRECTS};
const MAX_BODY_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT_MS: u64 = 2000;
const TOTAL_TIMEOUT_MS: u64 = 5000;
const CACHE_TTL_SECS: i64 = 6 * 3600;
const NEG_CACHE_TTL_SECS: i64 = 15 * 60;
const TITLE_MAX: usize = 200;
const DESC_MAX: usize = 500;
// Тайлы карты: OSM (политика — обязателен идентифицирующий User-Agent, без
// массовой выкачки; мы отдаём только тайлы вокруг присланных точек и кэшируем)
const TILE_BASE_URL: &str = "https://tile.openstreetmap.org";
/// P-23: тайлы не крупнее zoom 15 (~1,2 км на тайл у экватора): серверу и OSM
/// уходит окрестность, а не точка; web клампит zoom так же (MAP_MAX_ZOOM).
const TILE_MAX_ZOOM: u32 = 15;
/// P-23: кап кэша тайлов (строк), старше выселяются; PARVANE_PREVIEW_TILE_CACHE_MAX.
fn tile_cache_max() -> i64 {
    std::env::var("PARVANE_PREVIEW_TILE_CACHE_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000)
}
const TILE_MAX_BYTES: usize = 512 * 1024;
const TILE_CACHE_TTL_SECS: i64 = 7 * 24 * 3600;
const SITE_MAX: usize = 64;
const USER_AGENT: &str = "ParvaneBot/1.0";

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
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./preview.db".to_string());

    // P-38: общий коннект (WAL, busy_timeout 30 с) — см. parvane-db
    let pool = parvane_db::connect(&db_path).await?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    // Протокол v2 (spec 007 T053): preview.link / preview.map_tile из реестра
    v2::run(nc.clone(), pool.clone()).await?;

    let mut fetch_sub = nc.subscribe(PREVIEW_FETCH).await?;
    let mut tile_sub = nc.subscribe(PREVIEW_MAP_TILE).await?;
    info!("Preview шард запущен. Слушаю: {}, {}", PREVIEW_FETCH, PREVIEW_MAP_TILE);

    // 4.5/P-30: обработчики в tokio::spawn под семафором + общий дедлайн на
    // запрос — медленный сайт с редиректами не блокирует превью остальных.
    let handlers = std::sync::Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    loop {
        let (nc2, pool2) = (nc.clone(), pool.clone());
        let permit = handlers.clone().acquire_owned().await;
        tokio::select! {
            Some(msg) = fetch_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_fetch(&nc2, &pool2, msg).await });
            }
            Some(msg) = tile_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_map_tile(&nc2, &pool2, msg).await });
            }
        }
    }
}

/// Параллелизм обработчиков (PARVANE_HANDLER_CONCURRENCY, по умолчанию 16).
fn handler_concurrency() -> usize {
    std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(16)
}

/// P-30: общий дедлайн на превью/тайл (все хопы вместе), мс.
const REQUEST_DEADLINE_MS: u64 = 12_000;

/// P-30: per-user лимит запросов превью/тайлов (PARVANE_PREVIEW_RATE, по
/// умолчанию 60 за 60 с). Ключи длиннее 128 символов сворачиваются, пустые
/// корзины выселяются.
fn preview_rate_ok(user: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static L: OnceLock<Mutex<HashMap<String, Vec<i64>>>> = OnceLock::new();
    let limit = std::env::var("PARVANE_PREVIEW_RATE").ok().and_then(|v| v.parse().ok()).unwrap_or(60usize);
    let now = now_unix();
    let map = L.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    if guard.len() >= 50_000 {
        guard.retain(|_, hits| {
            hits.retain(|&t| now - t < 60);
            !hits.is_empty()
        });
    }
    let key = if user.len() > 128 { user[..128].to_string() } else { user.to_string() };
    let hits = guard.entry(key).or_default();
    hits.retain(|&t| now - t < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
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

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

async fn handle_fetch(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("preview: нет reply-топика");
        return;
    };

    let resp = async {
        // Токен — в конверте (его подставляет gateway), url — в payload
        let event: ParvaneEvent<PreviewFetchRequest> =
            serde_json::from_slice(&msg.payload).context("неверный JSON preview.link.fetch")?;
        let user = verify_token(nc, &event.token).await?;
        if !preview_rate_ok(&user) {
            anyhow::bail!("слишком много запросов превью");
        }
        // P-42: URL в лог не пишем (это содержимое переписки)
        debug!("preview fetch для {}", user);
        let preview = tokio::time::timeout(
            Duration::from_millis(REQUEST_DEADLINE_MS),
            resolve_preview(pool, &event.payload.url),
        )
        .await
        .context("превью не уложилось в дедлайн")?;
        anyhow::Ok(preview)
    }
    .await
    .unwrap_or_else(|e| PreviewFetchResponse {
        ok: false,
        webpage: None,
        error: Some(parvane_db::public_error(&e)),
    });

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    let _ = nc.publish(reply, json.into()).await;
}

// ── preview.map.tile ──────────────────────────────────────────────────────────

async fn handle_map_tile(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("map tile: нет reply-топика");
        return;
    };
    let resp = async {
        let event: ParvaneEvent<MapTileRequest> =
            serde_json::from_slice(&msg.payload).context("неверный JSON preview.map.tile")?;
        let user = verify_token(nc, &event.token).await?;
        let MapTileRequest { z, x, y, .. } = event.payload;
        if !tile_in_range(z, x, y) {
            anyhow::bail!("тайл вне диапазона");
        }
        // P-23: per-user темп (общая корзина с превью), координаты в лог не пишем
        if !preview_rate_ok(&user) {
            anyhow::bail!("слишком много запросов тайлов");
        }
        let png = resolve_tile(pool, z, x, y).await?;
        anyhow::Ok(MapTileResponse { ok: true, png_base64: Some(B64.encode(png)), error: None })
    }
    .await
    .unwrap_or_else(|e| {
        warn!("map tile: {}", e);
        MapTileResponse { ok: false, png_base64: None, error: Some(parvane_db::public_error(&e)) }
    });
    let json = serde_json::to_vec(&resp).unwrap_or_default();
    let _ = nc.publish(reply, json.into()).await;
}

/// Координаты тайла допустимы: зум ≤ TILE_MAX_ZOOM, x/y внутри сетки зума.
fn tile_in_range(z: u32, x: u32, y: u32) -> bool {
    z <= TILE_MAX_ZOOM && x < (1u32 << z) && y < (1u32 << z)
}

async fn resolve_tile(pool: &SqlitePool, z: u32, x: u32, y: u32) -> Result<Vec<u8>> {
    let key = format!("{z}/{x}/{y}");
    let cached: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT png, fetched_at FROM map_tiles WHERE tile_key = ?")
            .bind(&key)
            .fetch_optional(pool)
            .await
            .context("чтение кэша тайлов")?;
    if let Some((png, fetched_at)) = cached {
        if now_unix() - fetched_at < TILE_CACHE_TTL_SECS {
            return Ok(png);
        }
    }
    let client = reqwest::Client::builder()
        // P-49: без HTTPS_PROXY из окружения — иначе резолв/пиннинг обходились бы через прокси
        .no_proxy()
        .connect_timeout(std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
        .timeout(std::time::Duration::from_millis(TOTAL_TIMEOUT_MS))
        .user_agent(USER_AGENT)
        .build()
        .context("http client")?;
    let response = client
        .get(format!("{TILE_BASE_URL}/{key}.png"))
        .send()
        .await
        .context("запрос тайла")?;
    if !response.status().is_success() {
        anyhow::bail!("тайл: HTTP {}", response.status());
    }
    let bytes = response.bytes().await.context("тело тайла")?;
    if bytes.is_empty() || bytes.len() > TILE_MAX_BYTES {
        anyhow::bail!("тайл: неверный размер {}", bytes.len());
    }
    let png = bytes.to_vec();
    sqlx::query("INSERT OR REPLACE INTO map_tiles (tile_key, png, fetched_at) VALUES (?, ?, ?)")
        .bind(&key)
        .bind(&png)
        .bind(now_unix())
        .execute(pool)
        .await
        .context("кэш тайла")?;
    trim_tile_cache(pool, tile_cache_max()).await?;
    Ok(png)
}

/// P-23: держим в кэше не больше `max` тайлов — самые старые выселяются.
async fn trim_tile_cache(pool: &SqlitePool, max: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM map_tiles WHERE tile_key IN (
            SELECT tile_key FROM map_tiles ORDER BY fetched_at DESC, tile_key LIMIT -1 OFFSET ?)",
    )
    .bind(max.max(1))
    .execute(pool)
    .await
    .context("выселение тайлов")?;
    Ok(())
}

/// Проверяет кэш, иначе фетчит и кэширует (в т.ч. отрицательный результат).
async fn resolve_preview(pool: &SqlitePool, url: &str) -> PreviewFetchResponse {
    if let Some(cached) = load_cache(pool, url).await {
        return cached;
    }
    let resp = match fetch_preview(url).await {
        Ok(webpage) => PreviewFetchResponse { ok: true, webpage: Some(webpage), error: None },
        Err(e) => PreviewFetchResponse { ok: false, webpage: None, error: Some(parvane_db::public_error(&e)) },
    };
    store_cache(pool, url, &resp).await;
    resp
}

async fn load_cache(pool: &SqlitePool, url: &str) -> Option<PreviewFetchResponse> {
    let row: Option<(i64, Option<String>, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT ok, site_name, title, description, fetched_at FROM previews WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let (ok, site_name, title, description, fetched_at) = row?;
    let ttl = if ok == 1 { CACHE_TTL_SECS } else { NEG_CACHE_TTL_SECS };
    if now_unix() - fetched_at > ttl {
        return None;
    }
    if ok == 1 {
        Some(PreviewFetchResponse {
            ok: true,
            webpage: Some(WebPagePreview {
                url: url.to_string(), site_name, title, description,
            }),
            error: None,
        })
    } else {
        Some(PreviewFetchResponse { ok: false, webpage: None, error: Some("cached".into()) })
    }
}

async fn store_cache(pool: &SqlitePool, url: &str, resp: &PreviewFetchResponse) {
    let wp = resp.webpage.as_ref();
    let _ = sqlx::query(
        "INSERT INTO previews (url, ok, site_name, title, description, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           ok = excluded.ok, site_name = excluded.site_name, title = excluded.title,
           description = excluded.description, fetched_at = excluded.fetched_at",
    )
    .bind(url)
    .bind(if resp.ok { 1 } else { 0 })
    .bind(wp.and_then(|w| w.site_name.clone()))
    .bind(wp.and_then(|w| w.title.clone()))
    .bind(wp.and_then(|w| w.description.clone()))
    .bind(now_unix())
    .execute(pool)
    .await;
}

async fn fetch_preview(input_url: &str) -> Result<WebPagePreview> {
    // Схема/порт/хост — общим фильтром (http/https на 80/443, без userinfo)
    let mut current = parvane_netguard::check_url(input_url, &UrlPolicy::LINK)?;
    let mut seen: Vec<String> = Vec::new();

    for _ in 0..=MAX_REDIRECTS {
        // Все адреса имени публичные (fail-closed), фиксируем их в клиенте —
        // reqwest не будет резолвить повторно (анти-rebinding)
        let (host, pinned) = parvane_netguard::resolve_url(&current).await?;
        let normalized = current.as_str().to_string();
        if seen.contains(&normalized) {
            anyhow::bail!("too_many_redirects");
        }
        seen.push(normalized);

        // P-49: без прокси из окружения и без авто-редиректов — в netguard
        let client = parvane_netguard::pinned_client_builder(&host, &pinned)
            .connect_timeout(Duration::from_millis(CONNECT_TIMEOUT_MS))
            .timeout(Duration::from_millis(TOTAL_TIMEOUT_MS))
            .user_agent(USER_AGENT)
            .build()
            .context("client build")?;

        let resp = client.get(current.clone()).send().await.context("request failed")?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .context("redirect without location")?;
            // Каждый хоп — снова через фильтр (схема/порт/хост), резолв — на следующем круге
            current = parvane_netguard::follow_redirect(&current, location, &UrlPolicy::LINK)?;
            continue;
        }
        if !status.is_success() {
            anyhow::bail!("http_status_{}", status.as_u16());
        }
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !(ctype.contains("text/html") || ctype.contains("application/xhtml")) {
            anyhow::bail!("not_html");
        }

        let mut body = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("body stream error")?;
            body.extend_from_slice(&chunk);
            if body.len() >= MAX_BODY_BYTES {
                body.truncate(MAX_BODY_BYTES);
                break;
            }
        }
        let html = String::from_utf8_lossy(&body);
        return Ok(parse_webpage(current.as_str(), &html));
    }
    anyhow::bail!("too_many_redirects")
}

/// Достаёт og:title/og:site_name/og:description с фолбэком на <title>.
fn parse_webpage(url: &str, html: &str) -> WebPagePreview {
    let doc = scraper::Html::parse_document(html);

    let meta = |property: &str| -> Option<String> {
        let sel = scraper::Selector::parse(&format!("meta[property=\"{property}\"]")).ok()?;
        doc.select(&sel)
            .find_map(|el| el.value().attr("content").map(str::to_string))
            .filter(|s| !s.trim().is_empty())
    };

    let title = meta("og:title").or_else(|| {
        let sel = scraper::Selector::parse("title").ok()?;
        doc.select(&sel).next().map(|el| el.text().collect::<String>())
    });
    let site_name = meta("og:site_name");
    let description = meta("og:description");

    WebPagePreview {
        url: url.to_string(),
        site_name: site_name.map(|s| clip(&s, SITE_MAX)),
        title: title.map(|s| clip(&s, TITLE_MAX)),
        description: description.map(|s| clip(&s, DESC_MAX)),
    }
}

fn clip(text: &str, max: usize) -> String {
    // Управляющие символы → пробел, затем схлопываем пробелы
    let spaced: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    // P-23: кап кэша тайлов и zoom
    #[tokio::test]
    async fn tile_cache_is_capped_and_zoom_limited() {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for i in 0..10 {
            sqlx::query("INSERT INTO map_tiles (tile_key, png, fetched_at) VALUES (?, X'00', ?)")
                .bind(format!("15/{i}/1")).bind(1000 + i).execute(&pool).await.unwrap();
        }
        super::trim_tile_cache(&pool, 4).await.unwrap();
        let keys: Vec<(String,)> = sqlx::query_as("SELECT tile_key FROM map_tiles ORDER BY fetched_at").fetch_all(&pool).await.unwrap();
        assert_eq!(keys.iter().map(|k| k.0.as_str()).collect::<Vec<_>>(), ["15/6/1", "15/7/1", "15/8/1", "15/9/1"]);
        assert_eq!(super::TILE_MAX_ZOOM, 15);
    }
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    /// Фильтр адресов — общий parvane-netguard; старые проверки preview
    /// прогоняются через него же.
    fn is_public_ip(ip: &IpAddr) -> bool {
        parvane_netguard::is_public_ip(*ip)
    }

    /// Класс 14: единый набор адресов через URL-путь превью (литералы в URL).
    #[test]
    fn netguard_address_set_blocks_preview_urls() {
        use parvane_netguard::test_addrs::{ALLOWED, BLOCKED};
        let url_of = |a: &str| match a.parse::<IpAddr>() {
            Ok(IpAddr::V6(_)) => format!("https://[{a}]/"),
            _ => format!("https://{a}/"),
        };
        for a in BLOCKED {
            assert!(parvane_netguard::check_url(&url_of(a), &UrlPolicy::LINK).is_err(), "{a}");
        }
        for a in ALLOWED {
            assert!(parvane_netguard::check_url(&url_of(a), &UrlPolicy::LINK).is_ok(), "{a}");
        }
        assert!(parvane_netguard::check_url("https://example.com:8080/", &UrlPolicy::LINK).is_err());
        assert!(parvane_netguard::check_url("ftp://example.com/", &UrlPolicy::LINK).is_err());
    }

    #[test]
    fn tile_range_is_checked() {
        assert!(tile_in_range(0, 0, 0));
        assert!(tile_in_range(15, 32767, 32767));
        assert!(!tile_in_range(16, 0, 0));
        assert!(!tile_in_range(15, 32768, 0));
        assert!(!tile_in_range(2, 0, 4));
        assert!(!tile_in_range(u32::MAX, 0, 0));
    }

    #[test]
    fn private_ipv4_is_blocked() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
                   "169.254.169.254", "100.64.0.1", "0.0.0.0",
                   "198.18.0.1", "198.19.255.255", "240.0.0.1", "250.1.2.3"] {
            assert!(!is_public_ip(&ip.parse().unwrap()), "{ip} должен блокироваться");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(is_public_ip(&ip.parse().unwrap()), "{ip} должен пропускаться");
        }
    }

    // P-49: пробелы deny-листа закрыты
    #[test]
    fn deny_list_gaps_are_closed() {
        use std::net::{Ipv4Addr, Ipv6Addr};
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(192, 0, 0, 8))), "192.0.0.0/24");
        assert!(!is_public_ip(&IpAddr::V6("fec0::1".parse::<Ipv6Addr>().unwrap())), "site-local");
        // 6to4 с приватным 10.0.0.1 внутри: 2002:0a00:0001::
        assert!(!is_public_ip(&IpAddr::V6("2002:a00:1::1".parse::<Ipv6Addr>().unwrap())), "6to4 private");
        // 6to4 с публичным 8.8.8.8: 2002:0808:0808::
        assert!(is_public_ip(&IpAddr::V6("2002:808:808::1".parse::<Ipv6Addr>().unwrap())), "6to4 public");
        // Teredo: сервер 8.8.8.8, клиент 10.0.0.1 (инвертирован: f5ff:fffe)
        assert!(!is_public_ip(&IpAddr::V6("2001:0:808:808::f5ff:fffe".parse::<Ipv6Addr>().unwrap())), "teredo private client");
        assert!(!is_public_ip(&IpAddr::V6("100::1".parse::<Ipv6Addr>().unwrap())), "discard-only");
        assert!(is_public_ip(&IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
    }

    #[test]
    fn private_ipv6_is_blocked() {
        assert!(!is_public_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_public_ip(&"fc00::1".parse::<IpAddr>().unwrap()));
        assert!(!is_public_ip(&"fe80::1".parse::<IpAddr>().unwrap()));
        // IPv4-mapped приватный
        assert!(!is_public_ip(&"::ffff:10.0.0.1".parse::<IpAddr>().unwrap()));
        // documentation 2001:db8::/32 и NAT64 64:ff9b::/96
        assert!(!is_public_ip(&"2001:db8::1".parse::<IpAddr>().unwrap()));
        assert!(!is_public_ip(&"64:ff9b::8.8.8.8".parse::<IpAddr>().unwrap()));
        assert!(is_public_ip(&"2606:4700:4700::1111".parse::<IpAddr>().unwrap()));
    }

    #[test]
    fn ipv4_broadcast_and_multicast_blocked() {
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::BROADCAST)));
        assert!(!is_public_ip(&"224.0.0.1".parse().unwrap()));
    }

    #[test]
    fn parse_extracts_og_tags() {
        let html = r#"<html><head>
            <meta property="og:title" content="Hello World">
            <meta property="og:site_name" content="Example">
            <meta property="og:description" content="A   test   page">
            <title>Fallback</title></head><body></body></html>"#;
        let wp = parse_webpage("https://example.com", html);
        assert_eq!(wp.title.as_deref(), Some("Hello World"));
        assert_eq!(wp.site_name.as_deref(), Some("Example"));
        assert_eq!(wp.description.as_deref(), Some("A test page"));
    }

    #[test]
    fn parse_falls_back_to_title_tag() {
        let html = "<html><head><title>Just Title</title></head></html>";
        let wp = parse_webpage("https://example.com", html);
        assert_eq!(wp.title.as_deref(), Some("Just Title"));
        assert!(wp.site_name.is_none());
    }

    #[test]
    fn clip_truncates_and_normalizes() {
        assert_eq!(clip("a\n\tb   c", 100), "a b c");
        assert_eq!(clip(&"x".repeat(300), 200).len(), 200);
    }
}

