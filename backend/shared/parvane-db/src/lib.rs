//! Общий коннект к SQLite для всех шардов (P-38).
//!
//! Раньше каждый шард делал `SqlitePool::connect("sqlite://…?mode=rwc")`:
//! rollback-журнал, без `busy_timeout` — при пуле из 10 соединений под
//! нагрузкой это `database is locked`. Здесь: WAL (читатели не блокируют
//! писателя), `busy_timeout` 30 с, `synchronous=NORMAL` (безопасно с WAL),
//! `foreign_keys=ON`, создание файла при отсутствии.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

/// Таймаут ожидания блокировки (P-38).
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(30);
/// Размер пула по умолчанию (как у `SqlitePool::connect`).
pub const MAX_CONNECTIONS: u32 = 10;

/// Опции подключения к файлу БД шарда.
pub fn options(db_path: &str) -> Result<SqliteConnectOptions> {
    let opts = if db_path.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(db_path).context("разбор SQLite URL")?
    } else {
        SqliteConnectOptions::new().filename(db_path)
    };
    Ok(opts
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(BUSY_TIMEOUT)
        .foreign_keys(true))
}

/// Подключиться к БД шарда: WAL + busy_timeout 30 с.
pub async fn connect(db_path: &str) -> Result<SqlitePool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options(db_path)?)
        .await
        .with_context(|| format!("подключение к SQLite {db_path}"))?;
    tracing::debug!("SQLite {}: WAL, busy_timeout {:?}", db_path, BUSY_TIMEOUT);
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_enables_wal_and_busy_timeout() {
        let dir = std::env::temp_dir().join(format!("parvane-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let pool = connect(path.to_str().unwrap()).await.unwrap();
        let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode").fetch_one(&pool).await.unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let (timeout,): (i64,) = sqlx::query_as("PRAGMA busy_timeout").fetch_one(&pool).await.unwrap();
        assert_eq!(timeout, BUSY_TIMEOUT.as_millis() as i64);
        let (fk,): (i64,) = sqlx::query_as("PRAGMA foreign_keys").fetch_one(&pool).await.unwrap();
        assert_eq!(fk, 1);
        // URL-форма тоже принимается
        let pool2 = connect(&format!("sqlite://{}?mode=rwc", path.display())).await.unwrap();
        let (mode2,): (String,) = sqlx::query_as("PRAGMA journal_mode").fetch_one(&pool2).await.unwrap();
        assert_eq!(mode2.to_lowercase(), "wal");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 4.10: текст ошибки для клиента. Ошибки SQLite/IO/сериализации содержат имена
/// таблиц, констрейнтов и путей — наружу уходит только код, детали в лог.
/// Собственные `bail!("...")` обработчиков (квота, права, лимиты) — как есть.
pub trait PublicError {
    fn public_message(&self) -> String;
}

impl PublicError for anyhow::Error {
    fn public_message(&self) -> String {
        for cause in self.chain() {
            if cause.is::<sqlx::Error>() || cause.is::<sqlx::migrate::MigrateError>() {
                tracing::warn!("внутренняя ошибка БД скрыта от клиента: {self:#}");
                return "internal_error".to_string();
            }
            if cause.is::<std::io::Error>() {
                tracing::warn!("внутренняя ошибка IO скрыта от клиента: {self:#}");
                return "internal_error".to_string();
            }
            if cause.is::<serde_json::Error>() {
                return "bad_request".to_string();
            }
        }
        self.to_string()
    }
}

impl PublicError for serde_json::Error {
    fn public_message(&self) -> String {
        "bad_request".to_string()
    }
}

impl PublicError for sqlx::Error {
    fn public_message(&self) -> String {
        tracing::warn!("внутренняя ошибка БД скрыта от клиента: {self}");
        "internal_error".to_string()
    }
}

/// Сообщение об ошибке, безопасное для отправки клиенту (см. [`PublicError`]).
pub fn public_error<E: PublicError + ?Sized>(e: &E) -> String {
    e.public_message()
}

#[cfg(test)]
mod public_error_tests {
    use super::public_error;

    #[test]
    fn hides_db_io_and_serde_details() {
        let db = anyhow::Error::from(sqlx::Error::RowNotFound).context("SELECT FROM files");
        assert_eq!(public_error(&db), "internal_error");
        let io = anyhow::Error::from(std::io::Error::other("/data/cloud/blob"));
        assert_eq!(public_error(&io), "internal_error");
        let json = anyhow::Error::from(serde_json::from_str::<u8>("x").unwrap_err());
        assert_eq!(public_error(&json), "bad_request");
        assert_eq!(public_error(&serde_json::from_str::<u8>("x").unwrap_err()), "bad_request");
        assert_eq!(public_error(&sqlx::Error::RowNotFound), "internal_error");
        let own = anyhow::anyhow!("квота исчерпана");
        assert_eq!(public_error(&own), "квота исчерпана");
    }
}
