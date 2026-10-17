//! Шард `federation` (spec 028) — единственный, кто ходит к чужим серверам и
//! принимает их запросы. Своё → чужое: `v2.federation.out` (gateway — запросы
//! клиентов к объектам чужих доменов; messenger, domains, identity — действия
//! самого сервера), подписанный кадр HTTPS-запросом на `/_parvane/s2s` чужого
//! сервера. Чужое → своё: тот же путь в обратную сторону, публикация в свою
//! шину только методов с `federated`. Ключ сервера — у identity (подпись по
//! `v2.internal.s2s_sign`). Содержимое писем не читает: тела — шифртекст.
//!
//! Порядок старта: tracing → NATS → SQLite → миграции → подписки → HTTP.

mod config;
mod inbound;
mod outbound;
mod peers;
mod store;
#[cfg(test)]
mod tests;

use anyhow::{Context, Result};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL").unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    dotenvy::dotenv().ok();

    let cfg = config::Config::from_env();
    let nats_url = std::env::var("PARVANE_NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./federation.db".to_string());

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);
    let pool = store::open(&db_path).await?;

    if cfg.insecure_http {
        warn!("федерация: ТЕСТОВЫЙ транспорт без TLS (только loopback из PARVANE_FEDERATION_ENDPOINTS)");
    }
    let enabled = cfg.enabled;
    let domain = cfg.domain.clone();
    let fed = peers::Fed::new(cfg, pool, nc);
    outbound::run(fed.clone()).await?;
    inbound::run(fed).await?;
    info!("Federation шард запущен (домен {}, федерация {})", domain, if enabled { "включена" } else { "выключена" });

    if let Err(e) = tokio::signal::ctrl_c().await {
        tracing::error!("ожидание сигнала: {}", e);
        std::future::pending::<()>().await;
    }
    info!("Federation шард остановлен");
    Ok(())
}
