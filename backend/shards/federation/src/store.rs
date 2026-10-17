//! SQLite шарда федерации: закрепления ключей чужих серверов, очередь доставки, виденные nonce.

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use tracing::info;

/// Сколько хранить виденные nonce: окно свежести кадра ±5 мин с запасом.
pub const NONCE_TTL_MS: i64 = 15 * 60 * 1000;

pub async fn open(db_path: &str) -> Result<SqlitePool> {
    let pool = parvane_db::connect(db_path).await?;
    info!("SQLite готов: {}", db_path);
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции federation")?;
    Ok(pool)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pinned {
    pub key: [u8; 32],
    pub state: String,
}

pub async fn pinned(pool: &SqlitePool, domain: &str) -> sqlx::Result<Option<Pinned>> {
    let row: Option<(Vec<u8>, String)> = sqlx::query_as("SELECT server_key, state FROM servers WHERE domain = ?")
        .bind(domain)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|(k, state)| Some(Pinned { key: k.as_slice().try_into().ok()?, state })))
}

/// Закрепить ключ при первом контакте (повтор — без изменений).
pub async fn pin(pool: &SqlitePool, domain: &str, key: &[u8; 32], now_ms: i64) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO servers (domain, server_key, first_seen_ms, state) VALUES (?, ?, ?, 'active')")
        .bind(domain)
        .bind(key.as_slice())
        .bind(now_ms)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_state(pool: &SqlitePool, domain: &str, state: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE servers SET state = ? WHERE domain = ?").bind(state).bind(domain).execute(pool).await?;
    Ok(())
}

/// Заблокировать домен (строка заводится и без закрепления).
#[allow(dead_code)] // federation_admin
pub async fn block(pool: &SqlitePool, domain: &str, now_ms: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO servers (domain, server_key, first_seen_ms, state) VALUES (?, X'', ?, 'blocked')
         ON CONFLICT(domain) DO UPDATE SET state = 'blocked'",
    )
    .bind(domain)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Снять блокировку: строка без ключа удаляется, с ключом — снова активна.
#[allow(dead_code)] // federation_admin
pub async fn unblock(pool: &SqlitePool, domain: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM servers WHERE domain = ? AND length(server_key) = 0").bind(domain).execute(pool).await?;
    set_state(pool, domain, "active").await
}

/// Сбросить закрепление (смена ключа чужого сервера признана администратором).
#[allow(dead_code)] // federation_admin
pub async fn unpin(pool: &SqlitePool, domain: &str) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM servers WHERE domain = ? AND state != 'blocked'").bind(domain).execute(pool).await?.rows_affected())
}

pub async fn is_blocked(pool: &SqlitePool, domain: &str) -> sqlx::Result<bool> {
    let row: Option<(String,)> = sqlx::query_as("SELECT state FROM servers WHERE domain = ?").bind(domain).fetch_optional(pool).await?;
    Ok(row.is_some_and(|(s,)| s == "blocked"))
}

#[allow(dead_code)] // federation_admin
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<(String, Vec<u8>, i64, String)>> {
    sqlx::query_as("SELECT domain, server_key, first_seen_ms, state FROM servers ORDER BY domain").fetch_all(pool).await
}

/// Домены, с которыми есть действующая связь (рассылка «аккаунт удалён»).
pub async fn active_domains(pool: &SqlitePool) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT domain FROM servers WHERE state = 'active'").fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(d,)| d).collect())
}

/// Nonce ещё не встречался от этого сервера — запомнить (true); повтор — false.
pub async fn nonce_fresh(pool: &SqlitePool, origin: &str, nonce: &[u8], now_ms: i64) -> sqlx::Result<bool> {
    let r = sqlx::query("INSERT OR IGNORE INTO seen_nonces (origin_domain, nonce, seen_ms) VALUES (?, ?, ?)")
        .bind(origin)
        .bind(nonce)
        .bind(now_ms)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() == 1)
}

pub async fn prune_nonces(pool: &SqlitePool, now_ms: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM seen_nonces WHERE seen_ms < ?").bind(now_ms - NONCE_TTL_MS).execute(pool).await?;
    Ok(())
}

pub async fn outbox_put(pool: &SqlitePool, dest: &str, payload: &[u8], now_ms: i64) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO outbox (dest_domain, payload, attempts, next_ms, created_ms) VALUES (?, ?, 0, ?, ?)")
        .bind(dest)
        .bind(payload)
        .bind(now_ms)
        .bind(now_ms)
        .execute(pool)
        .await?;
    Ok(())
}

pub type OutboxRow = (i64, String, Vec<u8>, i64, i64);

pub async fn outbox_due(pool: &SqlitePool, now_ms: i64, limit: i64) -> sqlx::Result<Vec<OutboxRow>> {
    sqlx::query_as("SELECT id, dest_domain, payload, attempts, created_ms FROM outbox WHERE next_ms <= ? ORDER BY next_ms LIMIT ?")
        .bind(now_ms)
        .bind(limit)
        .fetch_all(pool)
        .await
}

pub async fn outbox_done(pool: &SqlitePool, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM outbox WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}

pub async fn outbox_retry(pool: &SqlitePool, id: i64, attempts: i64, next_ms: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE outbox SET attempts = ?, next_ms = ? WHERE id = ?").bind(attempts).bind(next_ms).bind(id).execute(pool).await?;
    Ok(())
}
