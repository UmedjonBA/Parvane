//! Шард `domains` — каркас доменов протокола v2 (spec 007, US4, T091, R11).
//!
//! Хранит журналы операций контейнеров (`container_log`), журнал грантов и
//! действующие гранты, снимки. Проверяет право записи по грантам (read —
//! только синхронизация и снимок, write — операции и снимки, admin — гранты),
//! подписи авторов и дайджесты шифртекста движком `parvane_protocol::domain`;
//! содержимое не читает (AEAD на ключе эпохи, ключ у участников по E2E).
//! Методы — из реестра (`shard: "domains"`), обслуживает `parvane-v2rt`.
//!
//! Порядок старта: tracing → NATS → SQLite → миграции → подписки.

mod store;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use anyhow::{Context, Result};
use tracing::info;

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

    let nats_url = std::env::var("PARVANE_NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./domains.db".to_string());

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    // Хранилище v2: `<PARVANE_DB_PATH>-v2.db` + migrations_v2/.
    let pool = store::open_store(&db_path).await?;

    let domains = Arc::new(store::Domains::new(pool, Some(nc.clone()), store::server_domain()));
    let concurrency = std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(32);
    store::run(nc, domains, concurrency).await?;

    let methods: Vec<&str> = parvane_v2rt::methods_of("domains").iter().map(|m| m.name).collect();
    info!("Domains шард запущен. Методы v2: {}", methods.join(", "));

    // Обработчики работают в фоне (parvane-v2rt); ждём сигнала остановки.
    if let Err(e) = tokio::signal::ctrl_c().await {
        tracing::error!("ожидание сигнала: {}", e);
        std::future::pending::<()>().await;
    }
    info!("Domains шард остановлен");
    Ok(())
}
