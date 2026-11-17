//! Учёт добавленных треков (таблица `added_tracks`): лимиты, «кто добавил», право удалить.

use sqlx::SqlitePool;

#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Added {
    pub path: String,
    pub adder: String,
    pub bytes: i64,
    pub added_ms: i64,
    pub track_id: String,
    pub artist: String,
    pub title: String,
    pub duration_secs: i64,
}

pub async fn open(db_path: &str) -> anyhow::Result<SqlitePool> {
    let pool = parvane_db::connect(db_path).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Сколько пользователь добавил с момента `since_ms` и сколько байт занимает всего.
pub async fn usage(pool: &SqlitePool, adder: &str, since_ms: i64) -> sqlx::Result<(u32, u64)> {
    let (recent, bytes): (i64, i64) = sqlx::query_as("SELECT COALESCE(SUM(added_ms >= ?), 0), COALESCE(SUM(bytes), 0) FROM added_tracks WHERE adder = ?")
        .bind(since_ms)
        .bind(adder)
        .fetch_one(pool)
        .await?;
    Ok((recent.max(0) as u32, bytes.max(0) as u64))
}

pub async fn insert(pool: &SqlitePool, row: &Added) -> sqlx::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO added_tracks (path, adder, bytes, added_ms, track_id, artist, title, duration_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&row.path)
        .bind(&row.adder)
        .bind(row.bytes)
        .bind(row.added_ms)
        .bind(&row.track_id)
        .bind(&row.artist)
        .bind(&row.title)
        .bind(row.duration_secs)
        .execute(pool)
        .await
        .map(|_| ())
}

pub async fn set_track_id(pool: &SqlitePool, path: &str, track_id: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE added_tracks SET track_id = ? WHERE path = ?").bind(track_id).bind(path).execute(pool).await.map(|_| ())
}

/// Добавленное: свои либо всех, новые первыми.
pub async fn list(pool: &SqlitePool, adder: Option<&str>, offset: u32, limit: u32) -> sqlx::Result<Vec<Added>> {
    let base = "SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs FROM added_tracks";
    match adder {
        Some(a) => sqlx::query_as(&format!("{base} WHERE adder = ? ORDER BY added_ms DESC, path LIMIT ? OFFSET ?")).bind(a).bind(limit).bind(offset).fetch_all(pool).await,
        None => sqlx::query_as(&format!("{base} WHERE track_id != '' ORDER BY added_ms DESC, path LIMIT ? OFFSET ?")).bind(limit).bind(offset).fetch_all(pool).await,
    }
}

pub async fn by_track(pool: &SqlitePool, track_id: &str) -> sqlx::Result<Option<Added>> {
    sqlx::query_as("SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs FROM added_tracks WHERE track_id = ?").bind(track_id).fetch_optional(pool).await
}

pub async fn delete(pool: &SqlitePool, path: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM added_tracks WHERE path = ?").bind(path).execute(pool).await.map(|_| ())
}
