// Preview шард: отдаёт OG-метаданные ссылки и картинку превью по запросу
// отправителя (картинка — с той же SSRF-защитой, что и страница). Наружу
// ходит шард (а не браузер клиента) — так скрывается IP отправителя и
// централизуется SSRF-защита. Модель приватности прежняя: превью генерирует
// отправитель и кладёт внутрь E2E-контента; шард лишь помогает добыть метаданные.

mod v2;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures::StreamExt;
use parvane_types::{
    PreviewFetchResponse,
    WebPagePreview,
};
use sqlx::SqlitePool;
use tracing::{debug, info, warn};

// Лимиты (согласованы с desktop-эталоном parvane_client.cpp); редиректы и
// фильтр адресов — общий parvane-netguard (T106)
use parvane_netguard::{GuardError, Url, UrlPolicy, MAX_REDIRECTS};
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
/// Картинка превью: потолок размера = `max_len` поля `LinkResponse.image` схемы
/// (preview.proto, 1 МиБ; клиент уменьшает её перед отправкой в чат); больше — картинки нет, тело не обрезается.
pub(crate) const IMAGE_MAX_BYTES: usize = 1_048_576;
/// Разрешённые типы картинки превью (SVG и прочее — отказ).
const IMAGE_MIMES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/// Мета-теги с адресом картинки, по убыванию приоритета.
const IMAGE_META_KEYS: [&str; 5] =
    ["og:image", "og:image:secure_url", "og:image:url", "twitter:image", "twitter:image:src"];
const IMAGE_URL_MAX: usize = 2048;
/// Потолок времени на картинку (все хопы и тело), мс; фактически — не больше
/// остатка общего дедлайна запроса.
const IMAGE_BUDGET_MS: u64 = 4000;
/// Меньше этого остатка картинку не начинаем, мс.
const IMAGE_BUDGET_MIN_MS: u64 = 300;
/// Запас общего дедлайна на запись в кэш и ответ, мс.
const DEADLINE_RESERVE_MS: u64 = 1000;
/// CLD-01: сумма байт картинок в кэше превью по умолчанию — 256 МиБ.
const IMAGE_CACHE_MAX_BYTES_DEFAULT: i64 = 256 * 1024 * 1024;
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

    info!("Preview шард запущен (протокол v2: preview.link, preview.map_tile)");
    std::future::pending::<()>().await;
    Ok(())
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


fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}


// ── preview.map.tile ──────────────────────────────────────────────────────────


/// Координаты тайла допустимы: зум ≤ TILE_MAX_ZOOM, x/y внутри сетки зума.
fn tile_in_range(z: u32, x: u32, y: u32) -> bool {
    z <= TILE_MAX_ZOOM && x < (1u32 << z) && y < (1u32 << z)
}

/// Сигнатура PNG: в кэш тайлов попадает только картинка.
fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
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
        // редиректы не идём: тайловый сервер не должен отправить нас на внутренний адрес (A0019-1)
        .redirect(reqwest::redirect::Policy::none())
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
    if !is_png(&bytes) {
        anyhow::bail!("тайл: не PNG");
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

/// Картинка превью страницы: байты как пришли с сайта (без перекодирования)
/// и их тип — один из [`IMAGE_MIMES`], сверенный с сигнатурой файла.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewImage {
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
}

/// Итог превью: текстовая часть и, если добылась, картинка.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedPreview {
    pub(crate) resp: PreviewFetchResponse,
    pub(crate) image: Option<PreviewImage>,
}

#[cfg(test)]
impl PartialEq for ResolvedPreview {
    fn eq(&self, other: &Self) -> bool {
        self.resp.ok == other.resp.ok
            && self.resp.webpage == other.resp.webpage
            && self.resp.error == other.resp.error
            && self.image == other.image
    }
}

/// Как хоп исходящего запроса превращается в соединение.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Net {
    /// Боевой путь: политика LINK, резолв с проверкой всех адресов, фиксация IP.
    Guarded,
    /// Только тесты: любое имя ведёт на локальный сервер с этим портом. Проверки
    /// URL (схема, userinfo, IP-литералы, служебные имена) те же, порт любой.
    #[cfg(test)]
    Local(u16),
}

impl Net {
    fn policy(self) -> UrlPolicy {
        match self {
            Net::Guarded => UrlPolicy::LINK,
            #[cfg(test)]
            Net::Local(_) => UrlPolicy { schemes: &["http", "https"], ports: &[] },
        }
    }

    /// Клиент на один хоп. Боевой: все адреса имени публичные (fail-closed) и
    /// зафиксированы — reqwest не резолвит повторно (анти-rebinding). P-49: без
    /// прокси из окружения и без авто-редиректов — в netguard.
    async fn client(self, url: &Url) -> Result<reqwest::Client, HopError> {
        let builder = match self {
            Net::Guarded => {
                let (host, pinned) = parvane_netguard::resolve_url(url).await.map_err(HopError::Guard)?;
                parvane_netguard::pinned_client_builder(&host, &pinned)
            }
            #[cfg(test)]
            Net::Local(port) => {
                let host = url.host_str().ok_or(HopError::Guard(GuardError::NoHost))?;
                parvane_netguard::client_builder()
                    .resolve_to_addrs(host, &[std::net::SocketAddr::from(([127, 0, 0, 1], port))])
            }
        };
        builder
            .connect_timeout(Duration::from_millis(CONNECT_TIMEOUT_MS))
            .timeout(Duration::from_millis(TOTAL_TIMEOUT_MS))
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| HopError::Net("client build"))
    }
}

/// Почему цепочка хопов не дошла до ответа 2xx. Текст — короткий код без
/// адресов и имён хостов.
#[derive(Debug)]
enum HopError {
    Guard(GuardError),
    Redirects,
    Status(u16),
    Net(&'static str),
}

impl HopError {
    /// Повтор позже может дать другой итог (сеть, DNS, 5xx, 408, 429).
    fn transient(&self) -> bool {
        match self {
            HopError::Guard(e) => matches!(e, GuardError::Dns | GuardError::NoRecords),
            HopError::Redirects => false,
            HopError::Status(s) => !(400..500).contains(s) || *s == 408 || *s == 429,
            HopError::Net(_) => true,
        }
    }
}

impl std::fmt::Display for HopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HopError::Guard(e) => write!(f, "{e}"),
            HopError::Redirects => f.write_str("too_many_redirects"),
            HopError::Status(s) => write!(f, "http_status_{s}"),
            HopError::Net(what) => f.write_str(what),
        }
    }
}

impl std::error::Error for HopError {}

/// GET с ручным проходом редиректов: КАЖДЫЙ хоп — через фильтр URL и резолв с
/// фиксацией адресов; не больше `MAX_REDIRECTS` переходов. Возвращает итоговый
/// URL и ответ 2xx (тело ещё не прочитано).
async fn get_following(net: Net, start: Url) -> Result<(Url, reqwest::Response), HopError> {
    let policy = net.policy();
    let mut current = start;
    let mut seen: Vec<String> = Vec::new();

    for _ in 0..=MAX_REDIRECTS {
        parvane_netguard::check_parsed(&current, &policy).map_err(HopError::Guard)?;
        let normalized = current.as_str().to_string();
        if seen.contains(&normalized) {
            return Err(HopError::Redirects);
        }
        seen.push(normalized);

        let client = net.client(&current).await?;
        let resp = client.get(current.clone()).send().await.map_err(|_| HopError::Net("request failed"))?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(HopError::Net("redirect without location"))?;
            // Следующий хоп — снова через фильтр (схема/порт/хост), резолв — на следующем круге
            current = parvane_netguard::follow_redirect(&current, location, &policy).map_err(HopError::Guard)?;
            continue;
        }
        if !status.is_success() {
            return Err(HopError::Status(status.as_u16()));
        }
        return Ok((current, resp));
    }
    Err(HopError::Redirects)
}

/// Проверяет кэш, иначе фетчит и кэширует (в т.ч. отрицательный результат).
pub(crate) async fn resolve_preview(pool: &SqlitePool, url: &str) -> ResolvedPreview {
    resolve_preview_with(pool, url, Net::Guarded, Duration::from_millis(IMAGE_BUDGET_MS)).await
}

/// То же с явным способом соединения и потолком времени на картинку.
async fn resolve_preview_with(pool: &SqlitePool, url: &str, net: Net, image_cap: Duration) -> ResolvedPreview {
    let started = Instant::now();
    if let Some(cached) = load_cache(pool, url).await {
        return cached;
    }
    let mut image = None;
    let mut image_retry = false;
    let resp = match fetch_preview(net, url).await {
        Ok(page) => {
            // Картинка — в остаток общего дедлайна запроса; её отказ превью не роняет
            if let Some(image_url) = page.image_url.as_deref() {
                match fetch_image_within(net, image_url, image_budget(started.elapsed(), image_cap)).await {
                    Ok(found) => image = Some(found),
                    Err(fail) => {
                        // P-42: URL в лог не пишем
                        debug!("картинка превью не получена: {}", fail.why);
                        image_retry = fail.retry;
                    }
                }
            }
            PreviewFetchResponse { ok: true, webpage: Some(page.webpage), error: None }
        }
        Err(e) => PreviewFetchResponse { ok: false, webpage: None, error: Some(parvane_db::public_error(&e)) },
    };
    let resolved = ResolvedPreview { resp, image };
    store_cache(pool, url, &resolved, image_retry).await;
    resolved
}

/// Сколько времени можно отдать картинке: остаток общего дедлайна запроса за
/// вычетом запаса на запись в кэш и ответ, но не больше `cap`. `None` — времени
/// не осталось, картинку не запрашиваем.
fn image_budget(elapsed: Duration, cap: Duration) -> Option<Duration> {
    let left = Duration::from_millis(REQUEST_DEADLINE_MS)
        .checked_sub(Duration::from_millis(DEADLINE_RESERVE_MS))?
        .checked_sub(elapsed)?;
    let budget = left.min(cap);
    (budget >= Duration::from_millis(IMAGE_BUDGET_MIN_MS)).then_some(budget)
}

async fn load_cache(pool: &SqlitePool, url: &str) -> Option<ResolvedPreview> {
    type Row = (i64, Option<String>, Option<String>, Option<String>, i64, Option<Vec<u8>>, Option<String>, i64);
    let row: Option<Row> = sqlx::query_as(
        "SELECT ok, site_name, title, description, fetched_at, image, image_mime, image_retry
         FROM previews WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let (ok, site_name, title, description, fetched_at, image, image_mime, image_retry) = row?;
    // Отказ и превью с временным сбоем картинки живут недолго — потом новая попытка
    let ttl = if ok == 1 && image_retry == 0 { CACHE_TTL_SECS } else { NEG_CACHE_TTL_SECS };
    if now_unix() - fetched_at > ttl {
        return None;
    }
    if ok != 1 {
        return Some(ResolvedPreview {
            resp: PreviewFetchResponse { ok: false, webpage: None, error: Some("cached".into()) },
            image: None,
        });
    }
    let image = match (image, image_mime) {
        (Some(bytes), Some(mime))
            if !bytes.is_empty() && bytes.len() <= IMAGE_MAX_BYTES && IMAGE_MIMES.contains(&mime.as_str()) =>
        {
            Some(PreviewImage { mime, bytes })
        }
        _ => None,
    };
    Some(ResolvedPreview {
        resp: PreviewFetchResponse {
            ok: true,
            webpage: Some(WebPagePreview { url: url.to_string(), site_name, title, description }),
            error: None,
        },
        image,
    })
}

async fn store_cache(pool: &SqlitePool, url: &str, resolved: &ResolvedPreview, image_retry: bool) {
    let resp = &resolved.resp;
    let wp = resp.webpage.as_ref();
    let image = resolved.image.as_ref();
    let stored = sqlx::query(
        "INSERT INTO previews (url, ok, site_name, title, description, fetched_at,
                               image, image_mime, image_bytes, image_retry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           ok = excluded.ok, site_name = excluded.site_name, title = excluded.title,
           description = excluded.description, fetched_at = excluded.fetched_at,
           image = excluded.image, image_mime = excluded.image_mime,
           image_bytes = excluded.image_bytes, image_retry = excluded.image_retry",
    )
    .bind(url)
    .bind(if resp.ok { 1 } else { 0 })
    .bind(wp.and_then(|w| w.site_name.clone()))
    .bind(wp.and_then(|w| w.title.clone()))
    .bind(wp.and_then(|w| w.description.clone()))
    .bind(now_unix())
    .bind(image.map(|i| i.bytes.as_slice()))
    .bind(image.map(|i| i.mime.as_str()))
    .bind(image.map_or(0, |i| i.bytes.len() as i64))
    .bind(i64::from(image_retry))
    .execute(pool)
    .await;
    if let Err(e) = stored {
        warn!("кэш превью: запись не удалась: {e}");
    }
    // Просроченные строки не копятся: по времени ответа не видно давнего запроса чужого URL (A0019-2)
    let _ = sqlx::query("DELETE FROM previews WHERE fetched_at < ?").bind(now_unix() - CACHE_TTL_SECS.max(NEG_CACHE_TTL_SECS)).execute(pool).await;
    if let Err(e) = trim_preview_cache(pool, preview_cache_max()).await {
        warn!("кэш превью: {e:#}");
    }
    if let Err(e) = trim_preview_images(pool, preview_image_cache_max_bytes()).await {
        warn!("кэш превью: {e:#}");
    }
}

/// CLD-01: кэш превью рос без предела — держим не больше `max` строк,
/// самые старые выселяются (как у тайлов).
async fn trim_preview_cache(pool: &SqlitePool, max: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM previews WHERE url IN (
            SELECT url FROM previews ORDER BY fetched_at DESC, url LIMIT -1 OFFSET ?)",
    )
    .bind(max.max(1))
    .execute(pool)
    .await
    .context("выселение превью")?;
    Ok(())
}

/// CLD-01: картинки превью занимают в сумме не больше `max_bytes`. Идём от
/// свежих строк к старым и выселяем целиком те, на которых сумма перевалила
/// потолок (строка без картинки места не занимает и остаётся): следующий
/// запрос такой ссылки добудет превью заново.
async fn trim_preview_images(pool: &SqlitePool, max_bytes: i64) -> Result<()> {
    sqlx::query(
        "DELETE FROM previews WHERE url IN (
            SELECT url FROM (
                SELECT url, SUM(image_bytes) OVER (
                    ORDER BY fetched_at DESC, url
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
                FROM previews WHERE image_bytes > 0)
            WHERE running > ?)",
    )
    .bind(max_bytes.max(IMAGE_MAX_BYTES as i64))
    .execute(pool)
    .await
    .context("выселение картинок превью")?;
    Ok(())
}

fn preview_cache_max() -> i64 {
    std::env::var("PARVANE_PREVIEW_CACHE_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000)
}

/// CLD-01: потолок суммы байт картинок в кэше превью
/// (PARVANE_PREVIEW_IMAGE_CACHE_MAX_BYTES, по умолчанию 256 МиБ; меньше одной
/// картинки не бывает).
fn preview_image_cache_max_bytes() -> i64 {
    std::env::var("PARVANE_PREVIEW_IMAGE_CACHE_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(IMAGE_CACHE_MAX_BYTES_DEFAULT)
}

/// Разобранная страница: текстовое превью и адрес картинки (если объявлен).
struct ParsedPage {
    webpage: WebPagePreview,
    image_url: Option<String>,
}

async fn fetch_preview(net: Net, input_url: &str) -> Result<ParsedPage> {
    // Схема/порт/хост — общим фильтром (http/https на 80/443, без userinfo)
    let start = parvane_netguard::check_url(input_url, &net.policy())?;
    let (final_url, resp) = get_following(net, start).await?;
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
    Ok(parse_webpage(final_url.as_str(), &html))
}

/// Почему картинки нет. `retry` — сбой временный (сеть, таймаут, 5xx): превью
/// кэшируется ненадолго, чтобы следующая попытка была скоро.
#[derive(Debug)]
struct ImageFail {
    retry: bool,
    why: String,
}

impl ImageFail {
    fn permanent(why: &str) -> Self {
        ImageFail { retry: false, why: why.to_string() }
    }
    fn transient(why: &str) -> Self {
        ImageFail { retry: true, why: why.to_string() }
    }
}

impl From<HopError> for ImageFail {
    fn from(e: HopError) -> Self {
        ImageFail { retry: e.transient(), why: e.to_string() }
    }
}

/// [`fetch_image`] в пределах `budget`; без бюджета запроса нет вовсе.
async fn fetch_image_within(net: Net, url: &str, budget: Option<Duration>) -> Result<PreviewImage, ImageFail> {
    let Some(budget) = budget else {
        return Err(ImageFail::transient("image_no_time"));
    };
    match tokio::time::timeout(budget, fetch_image(net, url)).await {
        Ok(result) => result,
        Err(_) => Err(ImageFail::transient("image_timeout")),
    }
}

/// Картинка превью — с той же защитой, что и страница: фильтр URL и фиксация
/// адресов на каждом хопе, предел редиректов, таймауты. Тип — только из
/// [`IMAGE_MIMES`], и сигнатура файла обязана ему соответствовать (SVG и всё
/// прочее — отказ). Больше `IMAGE_MAX_BYTES` — отказ, тело не обрезается.
async fn fetch_image(net: Net, url: &str) -> Result<PreviewImage, ImageFail> {
    let start = parvane_netguard::check_url(url, &net.policy()).map_err(HopError::Guard)?;
    let (_, resp) = get_following(net, start).await?;
    let declared = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(image_mime_of)
        .ok_or_else(|| ImageFail::permanent("image_type"))?;
    if resp.content_length().is_some_and(|len| len > IMAGE_MAX_BYTES as u64) {
        return Err(ImageFail::permanent("image_too_large"));
    }

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ImageFail::transient("image body stream error"))?;
        if body.len() + chunk.len() > IMAGE_MAX_BYTES {
            return Err(ImageFail::permanent("image_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    if sniff_image(&body) != Some(declared) {
        return Err(ImageFail::permanent("image_signature"));
    }
    Ok(PreviewImage { mime: declared.to_string(), bytes: body })
}

/// Тип из `Content-Type` (без параметров, без учёта регистра), если он разрешён.
fn image_mime_of(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    IMAGE_MIMES.iter().copied().find(|m| *m == essence)
}

/// Тип картинки по сигнатуре файла (первые байты); незнакомое — `None`.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Достаёт og:title/og:site_name/og:description с фолбэком на <title> и адрес
/// картинки превью (og:image…, затем twitter:image…).
fn parse_webpage(url: &str, html: &str) -> ParsedPage {
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

    // Картинка: ключ бывает и в property, и в name; берём первый адрес, который
    // после разрешения относительно итогового URL страницы оказался http/https
    let base = Url::parse(url).ok();
    let image_url = IMAGE_META_KEYS.iter().find_map(|key| {
        let sel = scraper::Selector::parse(&format!("meta[property=\"{key}\"], meta[name=\"{key}\"]")).ok()?;
        doc.select(&sel)
            .filter_map(|el| el.value().attr("content"))
            .find_map(|raw| resolve_image_url(base.as_ref(), raw))
    });

    ParsedPage {
        webpage: WebPagePreview {
            url: url.to_string(),
            site_name: site_name.map(|s| clip(&s, SITE_MAX)),
            title: title.map(|s| clip(&s, TITLE_MAX)),
            description: description.map(|s| clip(&s, DESC_MAX)),
        },
        image_url,
    }
}

/// Адрес картинки из мета-тега: относительный — от URL страницы; годится
/// только http/https с хостом и не длиннее `IMAGE_URL_MAX`.
fn resolve_image_url(base: Option<&Url>, raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let url = match base {
        Some(base) => base.join(raw).ok()?,
        None => Url::parse(raw).ok()?,
    };
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    (url.as_str().len() <= IMAGE_URL_MAX).then(|| url.into())
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
        let wp = parse_webpage("https://example.com", html).webpage;
        assert_eq!(wp.title.as_deref(), Some("Hello World"));
        assert_eq!(wp.site_name.as_deref(), Some("Example"));
        assert_eq!(wp.description.as_deref(), Some("A test page"));
    }

    #[test]
    fn parse_falls_back_to_title_tag() {
        let html = "<html><head><title>Just Title</title></head></html>";
        let wp = parse_webpage("https://example.com", html).webpage;
        assert_eq!(wp.title.as_deref(), Some("Just Title"));
        assert!(wp.site_name.is_none());
    }

    #[test]
    fn clip_truncates_and_normalizes() {
        assert_eq!(clip("a\n\tb   c", 100), "a b c");
        assert_eq!(clip(&"x".repeat(300), 200).len(), 200);
    }

    // ── Картинка превью ───────────────────────────────────────────────────────

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0];

    #[test]
    fn parse_extracts_image_url() {
        let image_of = |page: &str, head: &str| parse_webpage(page, &format!("<html><head>{head}</head></html>")).image_url;
        let page = "https://example.com/blog/post/";
        assert_eq!(
            image_of(page, r#"<meta property="og:image" content="https://cdn.example.com/a.png">"#).as_deref(),
            Some("https://cdn.example.com/a.png")
        );
        // Относительные адреса — от итогового URL страницы
        assert_eq!(
            image_of(page, r#"<meta property="og:image" content="/img/a.png">"#).as_deref(),
            Some("https://example.com/img/a.png")
        );
        assert_eq!(
            image_of(page, r#"<meta property="og:image" content="../cover.jpg">"#).as_deref(),
            Some("https://example.com/blog/cover.jpg")
        );
        assert_eq!(
            image_of(page, r#"<meta property="og:image" content="//cdn.example.com/b.webp">"#).as_deref(),
            Some("https://cdn.example.com/b.webp")
        );
        assert_eq!(
            image_of(page, r#"<meta property="og:image:secure_url" content="https://s.example.com/c.png">"#).as_deref(),
            Some("https://s.example.com/c.png")
        );
        assert_eq!(
            image_of(page, r#"<meta property="og:image:url" content="https://u.example.com/d.png">"#).as_deref(),
            Some("https://u.example.com/d.png")
        );
        // Фолбэк на twitter:image (обычно в name), og:image важнее
        assert_eq!(
            image_of(page, r#"<meta name="twitter:image" content="tw.gif">"#).as_deref(),
            Some("https://example.com/blog/post/tw.gif")
        );
        assert_eq!(
            image_of(page, r#"<meta name="twitter:image:src" content="https://t.example.com/e.jpg">"#).as_deref(),
            Some("https://t.example.com/e.jpg")
        );
        assert_eq!(
            image_of(
                page,
                r#"<meta name="twitter:image" content="https://t.example.com/tw.png">
                   <meta property="og:image" content="https://o.example.com/og.png">"#
            )
            .as_deref(),
            Some("https://o.example.com/og.png")
        );
        // Только http/https: непригодный адрес пропускается, берётся следующий
        assert_eq!(
            image_of(
                page,
                r#"<meta property="og:image" content="data:image/png;base64,AAAA">
                   <meta name="twitter:image" content="https://t.example.com/ok.png">"#
            )
            .as_deref(),
            Some("https://t.example.com/ok.png")
        );
        for bad in ["javascript:alert(1)", "ftp://example.com/a.png", "file:///etc/passwd", "   ", "data:image/png;base64,AA"] {
            assert_eq!(image_of(page, &format!(r#"<meta property="og:image" content="{bad}">"#)), None, "{bad}");
        }
        let long = format!("https://example.com/{}.png", "a".repeat(IMAGE_URL_MAX));
        assert_eq!(image_of(page, &format!(r#"<meta property="og:image" content="{long}">"#)), None);
        assert_eq!(image_of(page, "<title>Без картинки</title>"), None);
    }

    #[test]
    fn image_type_is_allowlisted_and_sniffed() {
        assert_eq!(image_mime_of("image/png"), Some("image/png"));
        assert_eq!(image_mime_of("Image/JPEG; charset=binary"), Some("image/jpeg"));
        assert_eq!(image_mime_of(" image/webp "), Some("image/webp"));
        assert_eq!(image_mime_of("image/gif"), Some("image/gif"));
        for bad in ["image/svg+xml", "image/avif", "image/x-icon", "text/html", "application/octet-stream", "", "image/pngx"] {
            assert_eq!(image_mime_of(bad), None, "{bad}");
        }
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert!(is_png(PNG) && !is_png(b"<html>not a tile</html>"));
        assert_eq!(sniff_image(JPEG), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff_image(b"GIF87a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\x10\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"RIFF\x10\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff_image(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(sniff_image(b""), None);
        assert_eq!(sniff_image(&PNG[..4]), None);
    }

    /// Потолок картинки в коде равен `max_len` поля `image` схемы.
    #[test]
    fn image_cap_matches_schema() {
        let msg = parvane_protocol::schema::message("parvane.preview.v2.LinkResponse").expect("LinkResponse в схеме");
        assert_eq!(msg.field(5).expect("поле image").max_len as usize, IMAGE_MAX_BYTES);
    }

    #[test]
    fn image_budget_fits_request_deadline() {
        let cap = Duration::from_millis(IMAGE_BUDGET_MS);
        assert_eq!(image_budget(Duration::ZERO, cap), Some(cap));
        // Страница съела почти всё — картинке достаётся остаток без запаса
        let late = Duration::from_millis(REQUEST_DEADLINE_MS - DEADLINE_RESERVE_MS - 1500);
        assert_eq!(image_budget(late, cap), Some(Duration::from_millis(1500)));
        // Остатка нет или он слишком мал — картинку не запрашиваем
        assert_eq!(image_budget(Duration::from_millis(REQUEST_DEADLINE_MS - DEADLINE_RESERVE_MS - 100), cap), None);
        assert_eq!(image_budget(Duration::from_millis(REQUEST_DEADLINE_MS * 2), cap), None);
        // Худший случай укладывается в дедлайн запроса
        for elapsed_ms in (0..REQUEST_DEADLINE_MS).step_by(250) {
            let elapsed = Duration::from_millis(elapsed_ms);
            if let Some(b) = image_budget(elapsed, cap) {
                assert!(elapsed + b + Duration::from_millis(DEADLINE_RESERVE_MS) <= Duration::from_millis(REQUEST_DEADLINE_MS));
            }
        }
    }

    // ── Локальный HTTP-сервер для сценариев с сетью ───────────────────────────

    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Route {
        status: u16,
        ctype: &'static str,
        body: Vec<u8>,
        location: Option<String>,
        /// Не слать Content-Length: тело до закрытия соединения.
        no_len: bool,
        /// Принять запрос и молчать.
        stall: bool,
    }

    fn html(head: &str) -> Route {
        Route {
            status: 200,
            ctype: "text/html; charset=utf-8",
            body: format!("<html><head><meta property=\"og:title\" content=\"Страница\">{head}</head></html>").into_bytes(),
            ..Default::default()
        }
    }

    fn file(ctype: &'static str, body: &[u8]) -> Route {
        Route { status: 200, ctype, body: body.to_vec(), ..Default::default() }
    }

    fn redirect(location: impl Into<String>) -> Route {
        Route { status: 302, location: Some(location.into()), ..Default::default() }
    }

    type Hits = Arc<Mutex<HashMap<String, usize>>>;

    fn hits_of(hits: &Hits, path: &str) -> usize {
        hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    /// Сервер на 127.0.0.1: `routes(port)` → путь → ответ. Считает обращения.
    async fn serve(routes: impl FnOnce(u16) -> Vec<(&'static str, Route)>) -> (u16, Hits) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: Arc<HashMap<&'static str, Route>> = Arc::new(routes(port).into_iter().collect());
        let hits: Hits = Arc::default();
        let counted = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let routes = routes.clone();
                let hits = counted.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut buf).await {
                            Ok(n) if n > 0 => head.extend_from_slice(&buf[..n]),
                            _ => return,
                        }
                    }
                    let head = String::from_utf8_lossy(&head).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    *hits.lock().unwrap().entry(path.clone()).or_default() += 1;
                    let Some(route) = routes.get(path.as_str()).cloned() else {
                        let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return;
                    };
                    if route.stall {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let mut out = format!("HTTP/1.1 {} X\r\nConnection: close\r\n", route.status);
                    if !route.ctype.is_empty() {
                        out.push_str(&format!("Content-Type: {}\r\n", route.ctype));
                    }
                    if let Some(location) = &route.location {
                        out.push_str(&format!("Location: {location}\r\n"));
                    }
                    if !route.no_len {
                        out.push_str(&format!("Content-Length: {}\r\n", route.body.len()));
                    }
                    out.push_str("\r\n");
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.write_all(&route.body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (port, hits)
    }

    async fn cache_pool() -> SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn cached_urls(pool: &SqlitePool) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT url FROM previews ORDER BY url").fetch_all(pool).await.unwrap();
        rows.into_iter().map(|r| r.0).collect()
    }

    const CAP: Duration = Duration::from_millis(IMAGE_BUDGET_MS);

    async fn resolve_local(pool: &SqlitePool, port: u16, path: &str) -> ResolvedPreview {
        resolve_preview_with(pool, &format!("http://site.example.com:{port}{path}"), Net::Local(port), CAP).await
    }

    fn title_of(r: &ResolvedPreview) -> Option<&str> {
        r.resp.webpage.as_ref().and_then(|w| w.title.as_deref())
    }

    #[tokio::test]
    async fn preview_carries_image_and_cache_keeps_it() {
        let (port, hits) = serve(|port| {
            vec![
                ("/page", html(r#"<meta property="og:image" content="/img/cover.png">"#)),
                ("/img/cover.png", file("image/png", PNG)),
                // Картинка на другом хосте за редиректом; тип с параметром
                ("/tw", html(&format!(r#"<meta name="twitter:image" content="http://cdn.example.com:{port}/moved">"#))),
                ("/moved", redirect("/real.jpg")),
                ("/real.jpg", file("IMAGE/JPEG; q=1", JPEG)),
            ]
        })
        .await;
        let pool = cache_pool().await;

        let first = resolve_local(&pool, port, "/page").await;
        assert_eq!(title_of(&first), Some("Страница"));
        assert_eq!(first.image, Some(PreviewImage { mime: "image/png".into(), bytes: PNG.to_vec() }));

        // Второй раз — из кэша, с той же картинкой и без запросов наружу
        let second = resolve_local(&pool, port, "/page").await;
        assert_eq!(second, first);
        assert_eq!((hits_of(&hits, "/page"), hits_of(&hits, "/img/cover.png")), (1, 1));
        let (bytes, retry): (i64, i64) =
            sqlx::query_as("SELECT image_bytes, image_retry FROM previews").fetch_one(&pool).await.unwrap();
        assert_eq!((bytes, retry), (PNG.len() as i64, 0));

        let tw = resolve_local(&pool, port, "/tw").await;
        assert_eq!(tw.image, Some(PreviewImage { mime: "image/jpeg".into(), bytes: JPEG.to_vec() }));
        assert_eq!(hits_of(&hits, "/real.jpg"), 1);
    }

    #[tokio::test]
    async fn bad_image_is_dropped_but_preview_stays_and_is_cached() {
        let sized = |len: usize| {
            let mut v = PNG.to_vec();
            v.resize(len, 0);
            v
        };
        let big = sized(IMAGE_MAX_BYTES + 1);
        let exact = sized(IMAGE_MAX_BYTES);
        let (port, hits) = serve(|_| {
            vec![
                // Заявлен png, внутри jpeg
                ("/mismatch", html(r#"<meta property="og:image" content="/jpeg-as-png">"#)),
                ("/jpeg-as-png", file("image/png", JPEG)),
                // SVG: ни типом, ни под видом png
                ("/svg", html(r#"<meta property="og:image" content="/a.svg">"#)),
                ("/a.svg", file("image/svg+xml", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>")),
                ("/svg-as-png", html(r#"<meta property="og:image" content="/b.png">"#)),
                ("/b.png", file("image/png", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>")),
                // Правильные байты, но тип не картинка
                ("/untyped", html(r#"<meta property="og:image" content="/c.bin">"#)),
                ("/c.bin", file("application/octet-stream", PNG)),
                // Больше потолка: с Content-Length и потоком без него
                ("/big", html(r#"<meta property="og:image" content="/big.png">"#)),
                ("/big.png", file("image/png", &big)),
                ("/big-stream", html(r#"<meta property="og:image" content="/big-stream.png">"#)),
                ("/big-stream.png", Route { no_len: true, ..file("image/png", &big) }),
                // Ровно потолок — проходит
                ("/exact", html(r#"<meta property="og:image" content="/exact.png">"#)),
                ("/exact.png", Route { no_len: true, ..file("image/png", &exact) }),
                // Картинки по адресу нет; пустое тело
                ("/gone", html(r#"<meta property="og:image" content="/missing.png">"#)),
                ("/empty", html(r#"<meta property="og:image" content="/empty.png">"#)),
                ("/empty.png", file("image/png", b"")),
            ]
        })
        .await;
        let pool = cache_pool().await;

        for (page, image) in [
            ("/mismatch", "/jpeg-as-png"),
            ("/svg", "/a.svg"),
            ("/svg-as-png", "/b.png"),
            ("/untyped", "/c.bin"),
            ("/big", "/big.png"),
            ("/big-stream", "/big-stream.png"),
            ("/gone", "/missing.png"),
            ("/empty", "/empty.png"),
        ] {
            let r = resolve_local(&pool, port, page).await;
            assert!(r.resp.ok, "{page}: превью должно остаться");
            assert_eq!(title_of(&r), Some("Страница"), "{page}");
            assert_eq!(r.image, None, "{page}: картинка должна быть отброшена целиком");
            // Отказ постоянный и закэширован: повтор не ходит ни за страницей, ни за картинкой
            let again = resolve_local(&pool, port, page).await;
            assert_eq!(again, r, "{page}");
            assert_eq!((hits_of(&hits, page), hits_of(&hits, image)), (1, 1), "{page}");
            let (bytes, retry): (i64, i64) =
                sqlx::query_as("SELECT image_bytes, image_retry FROM previews WHERE url LIKE ?")
                    .bind(format!("%{page}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((bytes, retry), (0, 0), "{page}");
        }

        let ok = resolve_local(&pool, port, "/exact").await;
        assert_eq!(ok.image.map(|i| i.bytes.len()), Some(IMAGE_MAX_BYTES));
    }

    #[tokio::test]
    async fn image_on_private_address_is_never_requested() {
        let (port, hits) = serve(|port| {
            vec![
                // Сервер действительно отдал бы эти картинки — запрос не должен случиться
                ("/literal", html(&format!(r#"<meta property="og:image" content="http://127.0.0.1:{port}/secret.png">"#))),
                ("/v6", html(&format!(r#"<meta property="og:image" content="http://[::1]:{port}/secret.png">"#))),
                ("/meta", html(r#"<meta property="og:image" content="http://169.254.169.254/latest/meta-data/x.png">"#)),
                ("/name", html(&format!(r#"<meta property="og:image" content="http://localhost:{port}/secret.png">"#))),
                ("/service", html(&format!(r#"<meta property="og:image" content="http://gateway:{port}/secret.png">"#))),
                ("/userinfo", html(&format!(r#"<meta property="og:image" content="http://u:p@cdn.example.com:{port}/secret.png">"#))),
                // Публичное имя, редирект на внутренний адрес
                ("/hop", html(r#"<meta property="og:image" content="/jump">"#)),
                ("/jump", redirect(format!("http://127.0.0.1:{port}/secret.png"))),
                ("/secret.png", file("image/png", PNG)),
                // Петля редиректов
                ("/loop", html(r#"<meta property="og:image" content="/loop-a">"#)),
                ("/loop-a", redirect("/loop-b")),
                ("/loop-b", redirect("/loop-a")),
                // Цепочка длиннее предела
                ("/chain", html(r#"<meta property="og:image" content="/c1">"#)),
                ("/c1", redirect("/c2")),
                ("/c2", redirect("/c3")),
                ("/c3", redirect("/c4")),
                ("/c4", redirect("/c5")),
                ("/c5", redirect("/secret.png")),
            ]
        })
        .await;
        let pool = cache_pool().await;
        for page in ["/literal", "/v6", "/meta", "/name", "/service", "/userinfo", "/hop", "/loop", "/chain"] {
            let r = resolve_local(&pool, port, page).await;
            assert_eq!(title_of(&r), Some("Страница"), "{page}");
            assert_eq!(r.image, None, "{page}");
        }
        assert_eq!(hits_of(&hits, "/secret.png"), 0);
        assert_eq!(hits_of(&hits, "/jump"), 1);
        assert_eq!((hits_of(&hits, "/c4"), hits_of(&hits, "/c5")), (1, 0), "хопов не больше MAX_REDIRECTS + 1");

        // Боевой путь: тот же отказ до любого соединения, и он постоянный
        for bad in [
            "http://127.0.0.1/a.png",
            "http://[::1]/a.png",
            "http://10.0.0.1/a.png",
            "http://192.168.1.1/a.png",
            "http://169.254.169.254/latest/meta-data/a.png",
            "http://[64:ff9b::a00:1]/a.png",
            "http://localhost/a.png",
            "http://gateway/a.png",
            "https://example.com:8443/a.png",
            "ftp://example.com/a.png",
        ] {
            let fail = fetch_image(Net::Guarded, bad).await.expect_err(bad);
            assert!(!fail.retry, "{bad}: {}", fail.why);
        }
    }

    #[tokio::test]
    async fn slow_or_failing_image_does_not_fail_preview() {
        let (port, hits) = serve(|_| {
            vec![
                ("/slow", html(r#"<meta property="og:image" content="/stall.png">"#)),
                ("/stall.png", Route { stall: true, ..Default::default() }),
                ("/down", html(r#"<meta property="og:image" content="/503.png">"#)),
                ("/503.png", Route { status: 503, ..Default::default() }),
            ]
        })
        .await;
        let pool = cache_pool().await;

        let started = Instant::now();
        let url = format!("http://site.example.com:{port}/slow");
        let r = resolve_preview_with(&pool, &url, Net::Local(port), Duration::from_millis(400)).await;
        assert!(started.elapsed() < Duration::from_millis(2500), "картинка ждётся не дольше своего бюджета");
        assert_eq!(title_of(&r), Some("Страница"));
        assert_eq!(r.image, None);

        let down = resolve_local(&pool, port, "/down").await;
        assert_eq!((title_of(&down), down.image.is_none()), (Some("Страница"), true));

        // Сбой временный: строка помечена и живёт как отрицательная — 15 минут, не 6 часов
        let retry: Vec<(i64,)> = sqlx::query_as("SELECT image_retry FROM previews").fetch_all(&pool).await.unwrap();
        assert_eq!(retry, [(1,), (1,)]);
        assert!(load_cache(&pool, &url).await.is_some());
        sqlx::query("UPDATE previews SET fetched_at = ?")
            .bind(now_unix() - NEG_CACHE_TTL_SECS - 60)
            .execute(&pool)
            .await
            .unwrap();
        assert!(load_cache(&pool, &url).await.is_none());
        assert_eq!(hits_of(&hits, "/slow"), 1);

        // Без бюджета запроса нет вовсе
        let none = fetch_image_within(Net::Local(port), &format!("http://site.example.com:{port}/stall.png"), None).await;
        assert!(none.is_err_and(|f| f.retry));
        assert_eq!(hits_of(&hits, "/stall.png"), 1);
    }

    #[tokio::test]
    async fn cached_image_follows_ttl_and_sanity_checks() {
        let pool = cache_pool().await;
        let url = "https://example.com/a";
        let image = PreviewImage { mime: "image/webp".into(), bytes: b"RIFF\x04\x00\x00\x00WEBPVP8 ".to_vec() };
        let resolved = ResolvedPreview {
            resp: PreviewFetchResponse {
                ok: true,
                webpage: Some(WebPagePreview { url: url.into(), site_name: Some("S".into()), title: Some("T".into()), description: None }),
                error: None,
            },
            image: Some(image.clone()),
        };
        store_cache(&pool, url, &resolved, false).await;
        assert_eq!(load_cache(&pool, url).await, Some(resolved.clone()));

        // Превью с картинкой живёт полный срок, а не срок отрицательного
        sqlx::query("UPDATE previews SET fetched_at = ?").bind(now_unix() - NEG_CACHE_TTL_SECS - 60).execute(&pool).await.unwrap();
        assert_eq!(load_cache(&pool, url).await.and_then(|r| r.image), Some(image));
        sqlx::query("UPDATE previews SET fetched_at = ?").bind(now_unix() - CACHE_TTL_SECS - 60).execute(&pool).await.unwrap();
        assert!(load_cache(&pool, url).await.is_none());

        // Перезапись без картинки убирает байты
        store_cache(&pool, url, &ResolvedPreview { image: None, ..resolved.clone() }, false).await;
        let row: (Option<Vec<u8>>, Option<String>, i64) =
            sqlx::query_as("SELECT image, image_mime, image_bytes FROM previews").fetch_one(&pool).await.unwrap();
        assert_eq!(row, (None, None, 0));

        // Строка с посторонним типом картинку не отдаёт
        store_cache(&pool, url, &resolved, false).await;
        sqlx::query("UPDATE previews SET image_mime = 'image/svg+xml'").execute(&pool).await.unwrap();
        let odd = load_cache(&pool, url).await.unwrap();
        assert!(odd.resp.ok && odd.image.is_none());

        // Отказ превью кэшируется без картинки
        let fail = ResolvedPreview { resp: PreviewFetchResponse { ok: false, webpage: None, error: Some("not_html".into()) }, image: None };
        store_cache(&pool, "https://example.com/b", &fail, false).await;
        let cached = load_cache(&pool, "https://example.com/b").await.unwrap();
        assert!(!cached.resp.ok && cached.image.is_none());
    }

    // CLD-01: картинки ограничены суммой байт
    #[tokio::test]
    async fn preview_images_are_capped_by_total_bytes() {
        let pool = cache_pool().await;
        let size = IMAGE_MAX_BYTES as i64;
        // u0 — самая старая … u5 — самая свежая; u2 и t-* — без картинки
        for i in 0..6i64 {
            let bytes = if i == 2 { 0 } else { size };
            sqlx::query(
                "INSERT INTO previews (url, ok, fetched_at, image, image_mime, image_bytes)
                 VALUES (?, 1, ?, CASE WHEN ? > 0 THEN zeroblob(?) END, 'image/png', ?)",
            )
            .bind(format!("u{i}"))
            .bind(1000 + i)
            .bind(bytes)
            .bind(bytes)
            .bind(bytes)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO previews (url, ok, fetched_at) VALUES ('t-old', 1, 1), ('t-fail', 0, 2)")
            .execute(&pool)
            .await
            .unwrap();

        // Потолок в три картинки: остаются три самые свежие с картинкой и все без неё
        trim_preview_images(&pool, size * 3 + 10).await.unwrap();
        assert_eq!(cached_urls(&pool).await, ["t-fail", "t-old", "u2", "u3", "u4", "u5"]);
        let total: (i64,) = sqlx::query_as("SELECT SUM(length(image)) FROM previews").fetch_one(&pool).await.unwrap();
        assert_eq!(total.0, size * 3);

        // Потолок ниже одной картинки поднимается до неё: свежая строка остаётся
        trim_preview_images(&pool, 0).await.unwrap();
        assert_eq!(cached_urls(&pool).await, ["t-fail", "t-old", "u2", "u5"]);

        // Потолок по числу строк работает как прежде
        trim_preview_cache(&pool, 2).await.unwrap();
        assert_eq!(cached_urls(&pool).await, ["u2", "u5"]);
        assert_eq!(IMAGE_CACHE_MAX_BYTES_DEFAULT, 256 * 1024 * 1024);
    }

    /// Запись в кэш сама держит потолок суммы байт (переменная окружения).
    #[tokio::test]
    async fn store_trims_images_by_env_cap() {
        let pool = cache_pool().await;
        assert_eq!(preview_image_cache_max_bytes(), IMAGE_CACHE_MAX_BYTES_DEFAULT);
        let entry = |url: &str| ResolvedPreview {
            resp: PreviewFetchResponse {
                ok: true,
                webpage: Some(WebPagePreview { url: url.into(), site_name: None, title: None, description: None }),
                error: None,
            },
            image: Some(PreviewImage { mime: "image/png".into(), bytes: vec![0u8; IMAGE_MAX_BYTES] }),
        };
        for (i, url) in ["a", "b", "c"].into_iter().enumerate() {
            store_cache(&pool, url, &entry(url), false).await;
            sqlx::query("UPDATE previews SET fetched_at = ? WHERE url = ?").bind(now_unix() - 100 + i as i64).bind(url).execute(&pool).await.unwrap();
        }
        assert_eq!(cached_urls(&pool).await, ["a", "b", "c"]);
        // Единственный тест, который трогает эту переменную
        std::env::set_var("PARVANE_PREVIEW_IMAGE_CACHE_MAX_BYTES", (IMAGE_MAX_BYTES * 2).to_string());
        store_cache(&pool, "d", &entry("d"), false).await;
        std::env::remove_var("PARVANE_PREVIEW_IMAGE_CACHE_MAX_BYTES");
        assert_eq!(cached_urls(&pool).await, ["c", "d"]);
    }

    /// Миграция 0003 на существующей базе: прежние строки (без картинки) убраны.
    #[tokio::test]
    async fn image_migration_clears_old_cache_rows() {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/0001_init.sql")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO previews (url, ok, title, fetched_at) VALUES ('https://example.com/', 1, 'T', 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/0003_preview_image.sql")).execute(&pool).await.unwrap();
        assert!(cached_urls(&pool).await.is_empty());
        assert!(load_cache(&pool, "https://example.com/").await.is_none());
    }
}
