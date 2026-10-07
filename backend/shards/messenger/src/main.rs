//! Messenger: журналы инбоксов устройств, sealed- и групповая доставка, журнал
//! личного состояния и журналы групп — протокол v2 (`v2.rs`, `v2_groups.rs`,
//! `v2_state.rs`). Путь v1 (`msg.chat.*`, `msg.sync.request`, `group.*`,
//! SQLite `messenger.db`) удалён 7 окт 2026 (T110); файл `messenger.db` на
//! сервере не открывается и может быть заархивирован.

use anyhow::{Context, Result};
use async_nats::Client;
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

mod v2;
mod v2_groups;
mod v2_state;

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
    // Путь задаёт ИМЯ хранилища: v2-БД лежит рядом как `<PARVANE_DB_PATH>-v2.db`.
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./messenger.db".to_string());

    let v2_pool = v2::open_store(&db_path).await?;

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    v2::run(nc, v2_pool).await?;
    info!("Messenger шард запущен (протокол v2)");

    std::future::pending::<()>().await;
    Ok(())
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
