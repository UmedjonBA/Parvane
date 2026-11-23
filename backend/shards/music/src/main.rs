//! Шард «Музыка» (spec 039): тонкая прослойка перед музыкальным сервером (Navidrome, API Subsonic).
//! Каталог и отметки — методами `music.*` через шину; байты трека и обложек — по HTTPS-ссылке с подписью и
//! сроком (`/_parvane/music/…`, за Caddy). Сервер видит треки и прослушивания: это общая библиотека, не E2E.
//!
//! Окружение: `PARVANE_MUSIC_NAVIDROME_URL` (нет — библиотека выключена, методы отвечают `UNAVAILABLE`),
//! `PARVANE_MUSIC_PUBLIC_BASE` (внешний адрес сервера для ссылок), `PARVANE_MUSIC_HTTP_BIND` (по умолчанию
//! `0.0.0.0:9340`), `PARVANE_MUSIC_URL_KEY_FILE` (ключ подписи ссылок, создаётся при первом старте).

mod fetch;
mod files;
mod http;
mod library;
mod mix;
mod shared;
mod subsonic;
mod token;
mod upload;
mod v2;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_spec041;
#[cfg(test)]
mod tests_mix;
#[cfg(test)]
mod tests_files;

use std::sync::Arc;

use anyhow::{Context, Result};
use tracing::{error, info, warn};

/// Сколько ждать музыкальный сервер при старте: 100 попыток раз в 3 с — 5 минут
const NAVIDROME_WAIT_ATTEMPTS: u32 = 100;
const BACKFILL_FIRST_DELAY: std::time::Duration = std::time::Duration::from_secs(60);
const BACKFILL_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
const NAVIDROME_WAIT_PAUSE: std::time::Duration = std::time::Duration::from_secs(3);

pub(crate) struct Ctx {
    /// Музыкальный сервер; `None` — библиотека выключена.
    pub sub: Option<Arc<subsonic::Subsonic>>,
    /// «Найти и скачать» (этап B); `None` — сервис скачивания не подключён.
    pub fetch: Option<Arc<fetch::jobs::Fetch>>,
    pub key: [u8; 32],
    /// Внешний адрес сервера без завершающей косой (`https://example.org:20443`).
    pub public_base: String,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Ключ подписи ссылок: 32 байта из файла; нет файла — создаётся (0600).
fn load_url_key(path: &str) -> Result<[u8; 32]> {
    if let Ok(bytes) = std::fs::read(path) {
        return <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| anyhow::anyhow!("{path}: ожидалось 32 байта"));
    }
    let mut key = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).with_context(|| format!("создать {path}"))?;
        f.write_all(&key)?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, key).with_context(|| format!("создать {path}"))?;
    Ok(key)
}

fn env_days(name: &str) -> Option<i64> {
    let text = env_nonempty(name)?;
    let day = fetch::service::parse_day(&text);
    if day.is_none() {
        warn!("{name}: ожидалась дата ГГГГ-ММ-ДД — значение пропущено");
    }
    day
}

fn env_list(name: &str) -> Option<Vec<String>> {
    env_nonempty(name).map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// Добавление треков: нужна папка библиотеки (`PARVANE_MUSIC_LIBRARY_DIR`) — тогда работают «Загрузить свои файлы» и
/// учёт добавленного; «Найти и скачать» — ещё и адрес сервиса скачивания (`PARVANE_MUSIC_FETCH_URL`). Правила
/// сверки — значения по умолчанию из `matching::Rules`, даты и порядок источников переопределяются окружением.
async fn open_fetch() -> Result<Option<Arc<fetch::jobs::Fetch>>> {
    let Some(library_dir) = env_nonempty("PARVANE_MUSIC_LIBRARY_DIR") else {
        info!("PARVANE_MUSIC_LIBRARY_DIR не задан — добавлять треки на сервер нельзя («Найти и скачать» и свои файлы выключены)");
        return Ok(None);
    };
    let service = match env_nonempty("PARVANE_MUSIC_FETCH_URL") {
        Some(url) => {
            let service = fetch::service::FetchService::new(&url).context("клиент сервиса скачивания")?;
            if !service.health().await {
                warn!("сервис скачивания пока не отвечает — запросы будут получать UNAVAILABLE до его готовности");
            }
            Some(service)
        }
        None => {
            info!("PARVANE_MUSIC_FETCH_URL не задан — «Найти и скачать» выключено, свои файлы загружать можно");
            None
        }
    };
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./music.db".to_string());
    let pool = fetch::store::open(&db_path).await.context("база шарда music")?;
    let mut rules = fetch::matching::Rules::default();
    if let Some(day) = env_days("PARVANE_MUSIC_ORIGINAL_BEFORE") {
        rules.original_before_day = day;
    }
    if let Some(day) = env_days("PARVANE_MUSIC_SOUNDCLOUD_BEFORE") {
        rules.uploaded_before_day.insert("soundcloud".to_string(), day);
    }
    if let Some(order) = env_list("PARVANE_MUSIC_SOURCES_RU") {
        rules.sources_ru = order;
    }
    if let Some(order) = env_list("PARVANE_MUSIC_SOURCES") {
        rules.sources_default = order;
    }
    let env_num = |name: &str, default: u64| std::env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(default);
    let add_per_day = env_num("PARVANE_MUSIC_ADD_PER_DAY", 30).min(u64::from(u32::MAX)) as u32;
    let quota_bytes = env_num("PARVANE_MUSIC_QUOTA_BYTES", 5 * 1024 * 1024 * 1024);
    let upload_max = env_num("PARVANE_MUSIC_UPLOAD_MAX_BYTES", 300 * 1024 * 1024);
    // Сколько задач «Найти и скачать» сервер ведёт разом; остальные ждут в очереди
    let parallel = env_num("PARVANE_MUSIC_FETCH_PARALLEL", 2).clamp(1, 16) as usize;
    let admins = env_list("PARVANE_MUSIC_ADMINS").unwrap_or_default();
    info!("добавление треков включено: {add_per_day} треков в сутки, {quota_bytes} байт на человека, файл до {upload_max} байт, {parallel} загрузки разом");
    Ok(Some(Arc::new(fetch::jobs::Fetch::new(service, pool, rules, library_dir.into(), add_per_day, quota_bytes, upload_max, admins, parallel))))
}

#[tokio::main]
async fn main() -> Result<()> {
    parvane_v2rt::exit_if_engine_info();
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();
    dotenvy::dotenv().ok();

    let nats_url = std::env::var("PARVANE_NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let key = load_url_key(&std::env::var("PARVANE_MUSIC_URL_KEY_FILE").unwrap_or_else(|_| "./music-url.key".to_string()))?;
    let public_base = env_nonempty("PARVANE_MUSIC_PUBLIC_BASE").unwrap_or_default().trim_end_matches('/').to_string();
    let sub = match env_nonempty("PARVANE_MUSIC_NAVIDROME_URL") {
        Some(url) => Some(Arc::new(subsonic::Subsonic::new(&url).context("клиент музыкального сервера")?)),
        None => {
            warn!("PARVANE_MUSIC_NAVIDROME_URL не задан — библиотека выключена, методы music.* отвечают UNAVAILABLE");
            None
        }
    };
    if sub.is_some() && public_base.is_empty() {
        error!("PARVANE_MUSIC_PUBLIC_BASE не задан — ссылки на поток будут относительными и вне браузера не откроются");
    }
    let fetch = if sub.is_some() { open_fetch().await? } else { None };
    // «Популярное на сервере» (spec 041): прослушивания — в базе шарда
    if sub.is_some() {
        library::open_plays(&std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./music.db".to_string())).await;
        // Общие плейлисты (spec 041, MUSIC-3) — в той же базе
        shared::open(&std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./music.db".to_string())).await;
    }
    let ctx = Arc::new(Ctx { sub, fetch, key, public_base });

    // Дозаполнение тегов и обложек у скачанного раньше: через минуту после старта (музыкальный сервер и сервис
    // скачивания поднимаются следом) и потом раз в шесть часов — на случай, если сервис был недоступен
    if let (Some(sub), Some(fetch)) = (ctx.sub.clone(), ctx.fetch.clone()) {
        tokio::spawn(async move {
            tokio::time::sleep(BACKFILL_FIRST_DELAY).await;
            if let Err(e) = fetch::store::fill_name_keys(&fetch.pool).await {
                tracing::warn!("музыка: ключи треков не заполнены: {e}");
            }
            loop {
                fetch.backfill_tags(&sub).await;
                // Корзина старше 30 дней — стирается
                fetch.purge_expired().await;
                tokio::time::sleep(BACKFILL_EVERY).await;
            }
        });
    }

    // Свежий музыкальный сервер делает администратором первого пришедшего — пусть это будет служебный пользователь
    // (иначе `startScan` после «Найти и скачать» отклоняется). Шард обычно стартует раньше музыкального сервера:
    // стучаться, пока не ответит, а не один раз — иначе первым приходил человек и администратором становился он
    if let Some(s) = ctx.sub.clone() {
        tokio::spawn(async move {
            for attempt in 0..NAVIDROME_WAIT_ATTEMPTS {
                if s.call(subsonic::SERVICE_USER, "ping", &[]).await.is_ok() {
                    info!("музыкальный сервер отвечает");
                    return;
                }
                if attempt == 0 {
                    warn!("музыкальный сервер пока не отвечает — запросы будут получать UNAVAILABLE до его готовности");
                }
                tokio::time::sleep(NAVIDROME_WAIT_PAUSE).await;
            }
            error!("музыкальный сервер не ответил за {} с", NAVIDROME_WAIT_ATTEMPTS as u64 * NAVIDROME_WAIT_PAUSE.as_secs());
        });
    }

    let bind = std::env::var("PARVANE_MUSIC_HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:9340".to_string());
    let listener = tokio::net::TcpListener::bind(&bind).await.with_context(|| format!("слушать {bind}"))?;
    info!("музыка: ссылки потока и обложек на {bind}");
    tokio::spawn(http::serve_listener(ctx.clone(), listener));

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);
    v2::run(nc, ctx).await?;
    info!("Music шард запущен (протокол v2: music.*)");
    std::future::pending::<()>().await;
    Ok(())
}
