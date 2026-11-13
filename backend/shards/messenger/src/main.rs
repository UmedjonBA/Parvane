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
mod v2_fed;
mod v2_groups;
mod v2_history;
mod v2_public;
mod v2_rename;
mod v2_state;

#[tokio::main]
async fn main() -> Result<()> {
    // spec 035: `--engine-info` — состав выпуска; выход до логов, NATS и базы.
    parvane_v2rt::exit_if_engine_info();
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

    // Служебный режим без приёма запросов.
    let flag = std::env::args().nth(1).unwrap_or_default();
    match flag.as_str() {
        // spec 035 (T142): все плановые чистки шарда один раз — так, будто сейчас указанный момент (unix-секунды);
        // сценарий «устройство отсутствовало» («месяц спустя») без перевода часов стенда. Только на копии базы стенда.
        "--gc-as-of" => {
            let at = gc_as_of_arg(std::env::args().nth(2).as_deref())?;
            let n = v2::gc_store(&v2_pool, at).await?;
            info!("messenger: плановая чистка как на {at} выполнена, выход (--gc-as-of)");
            println!("{}", n.json());
            return Ok(());
        }
        _ => {}
    }

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    v2::run(nc, v2_pool).await?;
    info!("Messenger шард запущен (протокол v2)");

    std::future::pending::<()>().await;
    Ok(())
}

/// Аргумент `--gc-as-of`: момент в unix-секундах, не раньше «сейчас» (чистка в прошлое ничего не значит, а опечатка
/// в единицах — миллисекунды — стёрла бы всё).
fn gc_as_of_arg(arg: Option<&str>) -> Result<i64> {
    let at: i64 = arg.context("--gc-as-of <unix-секунды>")?.trim().parse().context("--gc-as-of: не число")?;
    anyhow::ensure!(at >= now_unix() - 60, "--gc-as-of: момент в прошлом");
    anyhow::ensure!(at < 100_000_000_000, "--gc-as-of: ждём секунды, не миллисекунды");
    Ok(at)
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod gc_as_of_tests {
    use super::*;

    #[test]
    fn gc_as_of_arg_checks_units_and_direction() {
        let month = now_unix() + 31 * 86_400;
        assert_eq!(gc_as_of_arg(Some(&month.to_string())).unwrap(), month);
        assert!(gc_as_of_arg(None).is_err());
        assert!(gc_as_of_arg(Some("завтра")).is_err());
        assert!(gc_as_of_arg(Some("1000")).is_err(), "момент в прошлом");
        assert!(gc_as_of_arg(Some(&(month * 1000).to_string())).is_err(), "миллисекунды");
    }
}
