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
    /// SHA-256 своего файла (hex) — дедупликация загрузок; у скачанного пусто.
    pub sha256: String,
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
    sqlx::query("INSERT OR REPLACE INTO added_tracks (path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&row.path)
        .bind(&row.adder)
        .bind(row.bytes)
        .bind(row.added_ms)
        .bind(&row.track_id)
        .bind(&row.artist)
        .bind(&row.title)
        .bind(row.duration_secs)
        .bind(&row.sha256)
        .execute(pool)
        .await
        .map(|_| ())
}

pub async fn set_track_id(pool: &SqlitePool, path: &str, track_id: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE added_tracks SET track_id = ? WHERE path = ?").bind(track_id).bind(path).execute(pool).await.map(|_| ())
}

/// Добавленное: свои либо всех, новые первыми.
pub async fn list(pool: &SqlitePool, adder: Option<&str>, offset: u32, limit: u32) -> sqlx::Result<Vec<Added>> {
    let base = "SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256 FROM added_tracks";
    match adder {
        Some(a) => sqlx::query_as(&format!("{base} WHERE adder = ? AND deleted_ms = 0 ORDER BY added_ms DESC, path LIMIT ? OFFSET ?")).bind(a).bind(limit).bind(offset).fetch_all(pool).await,
        None => sqlx::query_as(&format!("{base} WHERE track_id != '' AND deleted_ms = 0 ORDER BY added_ms DESC, path LIMIT ? OFFSET ?")).bind(limit).bind(offset).fetch_all(pool).await,
    }
}

pub async fn by_track(pool: &SqlitePool, track_id: &str) -> sqlx::Result<Option<Added>> {
    sqlx::query_as("SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256 FROM added_tracks WHERE track_id = ? AND deleted_ms = 0").bind(track_id).fetch_optional(pool).await
}

/// Скачанное, чьи теги ещё не переписаны по каталогу (свои загруженные файлы не в счёт).
pub async fn untagged(pool: &SqlitePool, limit: u32) -> sqlx::Result<Vec<Added>> {
    sqlx::query_as("SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256 FROM added_tracks WHERE tagged = 0 AND sha256 = '' AND deleted_ms = 0 ORDER BY added_ms LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await
}

/// Свои загруженные файлы, у которых ещё не проверена кодировка тегов (`tagged` 0; 3 — проверена).
pub async fn unchecked_uploads(pool: &SqlitePool, limit: u32) -> sqlx::Result<Vec<Added>> {
    sqlx::query_as("SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256 FROM added_tracks WHERE tagged = 0 AND sha256 != '' AND deleted_ms = 0 ORDER BY added_ms LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await
}

/// Кодировка тегов своего файла проверена; исполнитель и название — уже прочитанные правильно.
pub async fn mark_upload_checked(pool: &SqlitePool, path: &str, artist: &str, title: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE added_tracks SET tagged = 3, artist = ?, title = ? WHERE path = ?").bind(artist).bind(title).bind(path).execute(pool).await.map(|_| ())
}

/// Отметить, что теги переписаны (`tagged`: 1 — да, 2 — в каталоге не нашёлся). Файл переехал (Opus из WebM) —
/// новый путь, номер трека узнается заново.
pub async fn mark_tagged(pool: &SqlitePool, path: &str, new_path: &str, tagged: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE added_tracks SET tagged = ?, track_id = CASE WHEN path = ? THEN track_id ELSE '' END, path = ? WHERE path = ?")
        .bind(tagged)
        .bind(new_path)
        .bind(new_path)
        .bind(path)
        .execute(pool)
        .await
        .map(|_| ())
}

pub async fn delete(pool: &SqlitePool, path: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM added_tracks WHERE path = ?").bind(path).execute(pool).await.map(|_| ())
}

/// Свой файл с такой же SHA-256 уже в библиотеке (дедупликация загрузок).
pub async fn by_sha256(pool: &SqlitePool, sha256: &str) -> sqlx::Result<Option<Added>> {
    sqlx::query_as("SELECT path, adder, bytes, added_ms, track_id, artist, title, duration_secs, sha256 FROM added_tracks WHERE sha256 = ? AND sha256 != '' AND deleted_ms = 0 LIMIT 1").bind(sha256).fetch_optional(pool).await
}

/// Ключ «тот же трек»: исполнитель и название в нижнем регистре.
pub fn name_key(artist: &str, title: &str) -> String {
    format!("{}\n{}", artist.trim().to_lowercase(), title.trim().to_lowercase())
}

/// Откуда файл и какая это версия трека (после записи строки).
pub async fn set_origin(pool: &SqlitePool, path: &str, source: &str, source_ref: &str, version: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE added_tracks SET source = ?, source_ref = ?, version = ?, name_key = ? WHERE path = ?")
        .bind(source)
        .bind(source_ref)
        .bind(version)
        .bind(name_key_of(pool, path).await?)
        .bind(path)
        .execute(pool)
        .await
        .map(|_| ())
}

async fn name_key_of(pool: &SqlitePool, path: &str) -> sqlx::Result<String> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT artist, title FROM added_tracks WHERE path = ?").bind(path).fetch_optional(pool).await?;
    Ok(row.map(|(a, t)| name_key(&a, &t)).unwrap_or_default())
}

/// Строки, записанные до ключа «тот же трек», — получают ключ (раз при старте).
pub async fn fill_name_keys(pool: &SqlitePool) -> sqlx::Result<()> {
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT path, artist, title FROM added_tracks WHERE name_key = ''").fetch_all(pool).await?;
    for (path, artist, title) in rows {
        sqlx::query("UPDATE added_tracks SET name_key = ? WHERE path = ?").bind(name_key(&artist, &title)).bind(&path).execute(pool).await?;
    }
    Ok(())
}

/// Следующий номер версии трека с этими исполнителем и названием.
pub async fn next_version(pool: &SqlitePool, artist: &str, title: &str) -> sqlx::Result<i64> {
    let (v,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM added_tracks WHERE name_key = ? AND deleted_ms = 0")
        .bind(name_key(artist, title))
        .fetch_one(pool)
        .await?;
    Ok(v + 1)
}
