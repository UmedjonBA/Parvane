//! Шард «Музыка» (spec 039): тонкая прослойка перед музыкальным сервером (Navidrome, API Subsonic).
//! Каталог и отметки — методами `music.*` через шину; байты трека и обложек — по HTTPS-ссылке с подписью и
//! сроком (`/_parvane/music/…`, за Caddy). Сервер видит треки и прослушивания: это общая библиотека, не E2E.
//!
//! Окружение: `PARVANE_MUSIC_NAVIDROME_URL` (нет — библиотека выключена, методы отвечают `UNAVAILABLE`),
//! `PARVANE_MUSIC_PUBLIC_BASE` (внешний адрес сервера для ссылок), `PARVANE_MUSIC_HTTP_BIND` (по умолчанию
//! `0.0.0.0:9340`), `PARVANE_MUSIC_URL_KEY_FILE` (ключ подписи ссылок, создаётся при первом старте).

mod http;
mod subsonic;
mod token;
mod v2;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use anyhow::{Context, Result};
use tracing::{error, info, warn};

pub(crate) struct Ctx {
    /// Музыкальный сервер; `None` — библиотека выключена.
    pub sub: Option<subsonic::Subsonic>,
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
        Some(url) => Some(subsonic::Subsonic::new(&url).context("клиент музыкального сервера")?),
        None => {
            warn!("PARVANE_MUSIC_NAVIDROME_URL не задан — библиотека выключена, методы music.* отвечают UNAVAILABLE");
            None
        }
    };
    if sub.is_some() && public_base.is_empty() {
        error!("PARVANE_MUSIC_PUBLIC_BASE не задан — ссылки на поток будут относительными и вне браузера не откроются");
    }
    let ctx = Arc::new(Ctx { sub, key, public_base });

    // Свежий музыкальный сервер делает администратором первого пришедшего — пусть это будет служебный пользователь
    if let Some(s) = &ctx.sub {
        match s.call(subsonic::SERVICE_USER, "ping", &[]).await {
            Ok(_) => info!("музыкальный сервер отвечает"),
            Err(_) => warn!("музыкальный сервер пока не отвечает — запросы будут получать UNAVAILABLE до его готовности"),
        }
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
