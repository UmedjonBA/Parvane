// Preview шард: отдаёт OG-метаданные ссылки по запросу отправителя. Наружу
// ходит шард (а не браузер клиента) — так скрывается IP отправителя и
// централизуется SSRF-защита. Модель приватности прежняя: превью генерирует
// отправитель и кладёт внутрь E2E-контента; шард лишь помогает добыть метаданные.

use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    ParvaneEvent, PreviewFetchRequest, PreviewFetchResponse, VerifyRequest, VerifyResponse,
    WebPagePreview,
    topics::{IDENTITY_VERIFY, PREVIEW_FETCH},
};
use sqlx::SqlitePool;
use tracing::{info, warn};

// Лимиты (согласованы с desktop-эталоном parvane_client.cpp)
const MAX_REDIRECTS: u8 = 3;
const MAX_BODY_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT_MS: u64 = 2000;
const TOTAL_TIMEOUT_MS: u64 = 5000;
const CACHE_TTL_SECS: i64 = 6 * 3600;
const NEG_CACHE_TTL_SECS: i64 = 15 * 60;
const TITLE_MAX: usize = 200;
const DESC_MAX: usize = 500;
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

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url).await.context("подключение к SQLite")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let mut fetch_sub = nc.subscribe(PREVIEW_FETCH).await?;
    info!("Preview шард запущен. Слушаю: {}", PREVIEW_FETCH);

    loop {
        tokio::select! {
            Some(msg) = fetch_sub.next() => handle_fetch(&nc, &pool, msg).await,
        }
    }
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
        let _user = verify_token(nc, &event.token).await?;
        info!("preview fetch: {}", event.payload.url);
        anyhow::Ok(resolve_preview(pool, &event.payload.url).await)
    }
    .await
    .unwrap_or_else(|e| PreviewFetchResponse {
        ok: false,
        webpage: None,
        error: Some(e.to_string()),
    });

    let json = serde_json::to_vec(&resp).unwrap_or_default();
    let _ = nc.publish(reply, json.into()).await;
}

/// Проверяет кэш, иначе фетчит и кэширует (в т.ч. отрицательный результат).
async fn resolve_preview(pool: &SqlitePool, url: &str) -> PreviewFetchResponse {
    if let Some(cached) = load_cache(pool, url).await {
        return cached;
    }
    let resp = match fetch_preview(url).await {
        Ok(webpage) => PreviewFetchResponse { ok: true, webpage: Some(webpage), error: None },
        Err(e) => PreviewFetchResponse { ok: false, webpage: None, error: Some(e.to_string()) },
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

/// Один resolved-IP безопасен для исходящего запроса (не приватный/зарезервированный).
fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // CGNAT 100.64.0.0/10
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
                // 0.0.0.0/8
                || v4.octets()[0] == 0)
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // ULA fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped ::ffff:0:0/96 — проверяем вложенный v4
                || v6.to_ipv4_mapped().map(|v4| !is_public_ip(&IpAddr::V4(v4))).unwrap_or(false))
        }
    }
}

/// Резолвит host и возвращает первый безопасный IP; ошибка, если любой resolved
/// адрес приватный (fail-closed против split-horizon и rebinding).
async fn safe_resolve(host: &str, port: u16) -> Result<std::net::SocketAddr> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .context("dns resolve failed")?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        anyhow::bail!("no dns records");
    }
    for addr in &addrs {
        if !is_public_ip(&addr.ip()) {
            anyhow::bail!("blocked_private_ip");
        }
    }
    Ok(addrs[0])
}

async fn fetch_preview(input_url: &str) -> Result<WebPagePreview> {
    let mut current = reqwest::Url::parse(input_url).context("invalid url")?;
    let mut seen: Vec<String> = Vec::new();

    for _ in 0..=MAX_REDIRECTS {
        if !matches!(current.scheme(), "http" | "https") {
            anyhow::bail!("unsupported_scheme");
        }
        let host = current.host_str().context("no host")?.to_string();
        let port = current.port_or_known_default().context("no port")?;
        if !matches!(port, 80 | 443) {
            anyhow::bail!("blocked_port");
        }
        // Пиним проверенный IP — reqwest не будет резолвить повторно (анти-rebinding)
        let pinned = safe_resolve(&host, port).await?;
        let normalized = current.as_str().to_string();
        if seen.contains(&normalized) {
            anyhow::bail!("too_many_redirects");
        }
        seen.push(normalized);

        let client = reqwest::Client::builder()
            .resolve(&host, pinned)
            .redirect(reqwest::redirect::Policy::none())
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
            current = current.join(location).context("bad redirect location")?;
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
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn private_ipv4_is_blocked() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
                   "169.254.169.254", "100.64.0.1", "0.0.0.0"] {
            assert!(!is_public_ip(&ip.parse().unwrap()), "{ip} должен блокироваться");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(is_public_ip(&ip.parse().unwrap()), "{ip} должен пропускаться");
        }
    }

    #[test]
    fn private_ipv6_is_blocked() {
        assert!(!is_public_ip(&IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!is_public_ip(&"fc00::1".parse::<IpAddr>().unwrap()));
        assert!(!is_public_ip(&"fe80::1".parse::<IpAddr>().unwrap()));
        // IPv4-mapped приватный
        assert!(!is_public_ip(&"::ffff:10.0.0.1".parse::<IpAddr>().unwrap()));
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

