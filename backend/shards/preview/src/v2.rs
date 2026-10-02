//! Методы протокола v2 в preview (spec 007 T053): `preview.link` и
//! `preview.map_tile`. Логика — та же, что у v1 (`preview.link.fetch`,
//! `preview.map.tile`): общий SSRF-фильтр parvane-netguard (≤ 3 редиректов,
//! тело ≤ 256 КиБ, только html, фиксация IP, без прокси), кэш превью и тайлов,
//! зум ≤ 15, общий per-user лимит частоты. Пользователь — `req.user` (JWT уже
//! проверил gateway); пустой `req.user` — отказ `FORBIDDEN`. Текста ошибок
//! клиенту нет — только `ErrorCode`, подробности в лог.

use std::sync::Arc;
use std::time::Duration;

use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_protocol::pb::parvane::preview::v2::{LinkRequest, LinkResponse, MapTileRequest, MapTileResponse};
use parvane_protocol::schema::MethodInfo;
use parvane_types::PreviewFetchResponse;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message;
use sqlx::SqlitePool;
use tracing::{debug, info, warn};

use crate::{handler_concurrency, preview_rate_ok, resolve_preview, resolve_tile, tile_in_range, UrlPolicy, REQUEST_DEADLINE_MS};

// Лимиты полей ответа по схеме (preview.proto, `max_len` в байтах)
const URL_MAX_BYTES: usize = 2048;
const SITE_MAX_BYTES: usize = 256;
const TITLE_MAX_BYTES: usize = 512;
const DESC_MAX_BYTES: usize = 2048;
const PNG_MAX_BYTES: usize = 262_144;

pub(crate) async fn run(nc: async_nats::Client, pool: SqlitePool) -> anyhow::Result<()> {
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let pool = pool.clone();
        Box::pin(async move { dispatch(&pool, m, req).await })
    });
    parvane_v2rt::serve(nc, "preview", handler_concurrency(), handler).await?;
    info!("preview: методы v2 подключены");
    Ok(())
}

async fn dispatch(pool: &SqlitePool, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    match m.name {
        "preview.link" => link(pool, &req).await,
        "preview.map_tile" => map_tile(pool, &req).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

/// Кто спрашивает: только идентифицированная сессия.
fn caller(req: &ShardRequest) -> Result<&str, ErrorCode> {
    if req.user.is_empty() {
        Err(ErrorCode::Forbidden)
    } else {
        Ok(&req.user)
    }
}

/// Разбор `preview.link` без сети: пользователь, тело, URL через общий фильтр.
fn parse_link(req: &ShardRequest) -> Result<(&str, String), ErrorCode> {
    let user = caller(req)?;
    let r: LinkRequest = body(req)?;
    parvane_netguard::check_url(&r.url, &UrlPolicy::LINK).map_err(|_| ErrorCode::Invalid)?;
    Ok((user, r.url))
}

async fn link(pool: &SqlitePool, req: &ShardRequest) -> Reply {
    let (user, url) = parse_link(req)?;
    if !preview_rate_ok(user) {
        return Err(ErrorCode::RateLimited);
    }
    // P-42: URL в лог не пишем (это содержимое переписки)
    debug!("v2 preview.link для {}", user);
    let resp = tokio::time::timeout(Duration::from_millis(REQUEST_DEADLINE_MS), resolve_preview(pool, &url))
        .await
        .map_err(|_| {
            warn!("v2 preview.link: превью не уложилось в дедлайн");
            ErrorCode::Unavailable
        })?;
    Ok(link_response(&url, resp)?.encode_to_vec())
}

/// Ответ v1 → `LinkResponse`. Картинку v1 не добывает — `image` пуст.
fn link_response(request_url: &str, resp: PreviewFetchResponse) -> Result<LinkResponse, ErrorCode> {
    let Some(wp) = resp.webpage.filter(|_| resp.ok) else {
        // Превью нет (не html, HTTP-ошибка, заблокированный адрес по пути, кэш отказа)
        debug!("v2 preview.link: превью нет: {}", resp.error.as_deref().unwrap_or(""));
        return Err(ErrorCode::NotFound);
    };
    // Итоговый URL после редиректов; если он длиннее схемы — исходный
    let url = if wp.url.len() <= URL_MAX_BYTES { wp.url } else { request_url.to_string() };
    Ok(LinkResponse {
        url,
        site_name: clip_bytes(wp.site_name.unwrap_or_default(), SITE_MAX_BYTES),
        title: clip_bytes(wp.title.unwrap_or_default(), TITLE_MAX_BYTES),
        description: clip_bytes(wp.description.unwrap_or_default(), DESC_MAX_BYTES),
        image: Vec::new(),
        image_mime: String::new(),
    })
}

/// Обрезать строку до `max` байт по границе символа (лимиты схемы — в байтах).
fn clip_bytes(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// Разбор `preview.map_tile` без сети: пользователь, тело, координаты.
fn parse_tile(req: &ShardRequest) -> Result<(&str, u32, u32, u32), ErrorCode> {
    let user = caller(req)?;
    let r: MapTileRequest = body(req)?;
    if !tile_in_range(r.zoom, r.x, r.y) {
        return Err(ErrorCode::Invalid);
    }
    Ok((user, r.zoom, r.x, r.y))
}

async fn map_tile(pool: &SqlitePool, req: &ShardRequest) -> Reply {
    let (user, z, x, y) = parse_tile(req)?;
    // P-23: per-user темп (общая корзина с превью), координаты в лог не пишем
    if !preview_rate_ok(user) {
        return Err(ErrorCode::RateLimited);
    }
    let png = resolve_tile(pool, z, x, y).await.map_err(|e| {
        warn!("v2 preview.map_tile: {:#}", e);
        ErrorCode::Unavailable
    })?;
    if png.len() > PNG_MAX_BYTES {
        warn!("v2 preview.map_tile: тайл {} байт больше лимита схемы", png.len());
        return Err(ErrorCode::Unavailable);
    }
    Ok(MapTileResponse { png }.encode_to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_types::WebPagePreview;

    fn req(method: &str, user: &str, body: Vec<u8>) -> ShardRequest {
        ShardRequest { method: method.into(), user: user.into(), body, ..Default::default() }
    }

    fn link_req(user: &str, url: &str) -> ShardRequest {
        req("preview.link", user, LinkRequest { url: url.into() }.encode_to_vec())
    }

    fn tile_req(user: &str, zoom: u32, x: u32, y: u32) -> ShardRequest {
        req("preview.map_tile", user, MapTileRequest { zoom, x, y }.encode_to_vec())
    }

    #[test]
    fn link_request_needs_session_and_public_url() {
        assert_eq!(parse_link(&link_req("", "https://example.com/")).err(), Some(ErrorCode::Forbidden));
        let ok = link_req("alice@local", "https://example.com/a");
        let (user, url) = parse_link(&ok).unwrap();
        assert_eq!((user, url.as_str()), ("alice@local", "https://example.com/a"));
        for bad in [
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data",
            "http://[64:ff9b::a00:1]/",
            "http://[2002:a00:1::1]/",
            "http://localhost/",
            "http://gateway/",
            "https://example.com:8443/",
            "file:///etc/passwd",
            "https://u:p@example.com/",
            "не url",
        ] {
            assert_eq!(parse_link(&link_req("alice@local", bad)).err(), Some(ErrorCode::Invalid), "{bad}");
        }
        // URL длиннее лимита схемы — отказ кодека
        let long = format!("https://example.com/{}", "a".repeat(2100));
        assert_eq!(parse_link(&link_req("alice@local", &long)).err(), Some(ErrorCode::Invalid));
        // Битое тело
        assert!(parse_link(&req("preview.link", "alice@local", vec![0xff, 0xff])).is_err());
    }

    #[test]
    fn tile_request_zoom_and_range() {
        assert_eq!(parse_tile(&tile_req("", 1, 0, 0)).err(), Some(ErrorCode::Forbidden));
        assert_eq!(parse_tile(&tile_req("bob@local", 15, 32767, 1)).unwrap(), ("bob@local", 15, 32767, 1));
        assert_eq!(parse_tile(&tile_req("bob@local", 16, 0, 0)).err(), Some(ErrorCode::Invalid));
        assert_eq!(parse_tile(&tile_req("bob@local", 3, 8, 0)).err(), Some(ErrorCode::Invalid));
        assert_eq!(parse_tile(&tile_req("bob@local", 3, 0, 8)).err(), Some(ErrorCode::Invalid));
    }

    #[test]
    fn rate_limit_is_per_user_and_shared_with_v1() {
        // Лимит по умолчанию — 60 за 60 с (PARVANE_PREVIEW_RATE); уникальный ключ теста
        let user = "v2-rate-test@local";
        let passed = (0..100).filter(|_| preview_rate_ok(user)).count();
        assert_eq!(passed, std::env::var("PARVANE_PREVIEW_RATE").ok().and_then(|v| v.parse().ok()).unwrap_or(60));
        assert!(!preview_rate_ok(user));
        assert!(preview_rate_ok("v2-rate-other@local"));
    }

    #[test]
    fn link_response_maps_v1_and_respects_schema_limits() {
        let ok = PreviewFetchResponse {
            ok: true,
            webpage: Some(WebPagePreview {
                url: "https://example.com/final".into(),
                site_name: Some("Пример".into()),
                title: Some("Ж".repeat(300)),
                description: None,
            }),
            error: None,
        };
        let r = link_response("https://example.com/", ok).unwrap();
        assert_eq!(r.url, "https://example.com/final");
        assert_eq!(r.site_name, "Пример");
        assert_eq!(r.title.len(), 512);
        assert!(r.title.chars().all(|c| c == 'Ж'));
        assert!(r.description.is_empty() && r.image.is_empty() && r.image_mime.is_empty());

        let fail = PreviewFetchResponse { ok: false, webpage: None, error: Some("not_html".into()) };
        assert_eq!(link_response("https://example.com/", fail).err(), Some(ErrorCode::NotFound));

        let long = PreviewFetchResponse {
            ok: true,
            webpage: Some(WebPagePreview { url: format!("https://e.com/{}", "a".repeat(3000)), site_name: None, title: None, description: None }),
            error: None,
        };
        assert_eq!(link_response("https://e.com/", long).unwrap().url, "https://e.com/");
    }

    #[test]
    fn clip_bytes_keeps_char_boundary() {
        assert_eq!(clip_bytes("абв".into(), 3), "а");
        assert_eq!(clip_bytes("abc".into(), 10), "abc");
    }

    #[test]
    fn preview_methods_are_in_registry() {
        let names: Vec<&str> = parvane_v2rt::methods_of("preview").iter().map(|m| m.name).collect();
        assert!(names.contains(&"preview.link") && names.contains(&"preview.map_tile"), "{names:?}");
    }
}
