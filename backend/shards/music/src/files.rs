//! Файлы библиотеки (макет «Музыки» 23 ноя, доски `RpMusicA`, `ZpMusicX`, `ZdMusicX`): «Откуда файл», правка тегов
//! человеком (один трек, несколько, «Объединить исполнителей», «Перенести треки»), «Вернуть исходные теги»,
//! корзина на 30 дней, пометки «[v2]» и «копия» у треков.
//!
//! Права: своё правит и удаляет добавивший, чужое — администратор сервера; файл, лежавший в библиотеке до учёта
//! (строки в `added_tracks` нет), — только администратор. Теги пишет сервис скачивания (`/tags`), звук не трогается.
//! Удалённое переезжает в `<библиотека>/.trash/<номер>/` (музыкальный сервер скрытые папки не читает) и через 30 дней
//! стирается само; восстановление возвращает файл на место.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message as _;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tracing::{error, info, warn};

use crate::fetch::jobs::Fetch;
use crate::fetch::store;
use crate::subsonic::{nd_user, track_of, Subsonic, SERVICE_USER};

type Reply = Result<Vec<u8>, ErrorCode>;

pub(crate) const TRASH_DIR: &str = ".trash";
const TRASH_KEEP_MS: i64 = 30 * 86_400_000;
const DAY_MS: i64 = 86_400_000;
const TAG_FIELDS: [&str; 8] = ["title", "artist", "album", "album_artist", "year", "genre", "track_no", "release_type"];
const RELEASE_TYPES: [&str; 4] = ["album", "single", "ep", "compilation"];
const VERSIONS_MAX: usize = 20;

#[derive(Clone, Debug, sqlx::FromRow)]
pub(crate) struct FileRow {
    pub path: String,
    pub adder: String,
    pub added_ms: i64,
    pub track_id: String,
    pub artist: String,
    pub title: String,
    pub source: String,
    pub source_ref: String,
    pub deleted_ms: i64,
    pub deleted_by: String,
    pub trash_path: String,
    pub edited_ms: i64,
    pub edited_by: String,
    pub original_tags: String,
    pub version: i64,
    pub name_key: String,
}

const COLUMNS: &str = "path, adder, added_ms, track_id, artist, title, source, source_ref, deleted_ms, deleted_by, trash_path, edited_ms, edited_by, original_tags, version, name_key";

fn nick(address: &str) -> String {
    address.split('@').next().unwrap_or("").chars().take(64).collect()
}

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: файлы библиотеки: {e}");
    ErrorCode::Unavailable
}

async fn row_by_track(pool: &SqlitePool, track_id: &str) -> Result<Option<FileRow>, ErrorCode> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE track_id = ? AND deleted_ms = 0"))
        .bind(track_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// Пометки у треков ответов библиотеки — по базе шарда (та же, что у прослушиваний); базы нет — без пометок.
pub(crate) async fn annotate_tracks(tracks: &mut [pb::Track]) {
    if let Some(pool) = crate::library::plays_pool() {
        annotate(pool, tracks).await;
    }
}

/// Список треков для экрана: без треков из корзины (музыкальный сервер отдаёт их до пересканирования) и с пометками.
pub(crate) async fn clean_tracks(tracks: &mut Vec<pb::Track>) {
    let Some(pool) = crate::library::plays_pool() else { return };
    drop_trashed(pool, tracks).await;
    annotate(pool, tracks).await;
}

/// Убрать из списка треки, файлы которых лежат в корзине.
pub(crate) async fn drop_trashed(pool: &SqlitePool, tracks: &mut Vec<pb::Track>) {
    let gone = trashed_ids(pool, &tracks.iter().map(|t| t.id.as_str()).filter(|id| !id.is_empty()).collect::<Vec<_>>()).await;
    if !gone.is_empty() {
        tracks.retain(|t| !gone.contains(&t.id));
    }
}

/// Треки из корзины среди `ids`: файл переехал в `.trash`, а музыкальный сервер может ещё отдавать его до пересканирования
/// («Популярное на сервере» по таблице прослушиваний показывало удалённую копию).
pub(crate) async fn trashed_ids(pool: &SqlitePool, ids: &[&str]) -> HashSet<String> {
    if ids.is_empty() {
        return HashSet::new();
    }
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT track_id FROM added_tracks WHERE deleted_ms > 0 AND track_id IN ({marks}) \
         AND track_id NOT IN (SELECT track_id FROM added_tracks WHERE deleted_ms = 0)"
    );
    let mut q = sqlx::query_as::<_, (String,)>(&sql);
    for id in ids {
        q = q.bind(*id);
    }
    match q.fetch_all(pool).await {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(e) => {
            warn!("музыка: корзина не прочитана: {e}");
            HashSet::new()
        }
    }
}

/// Пометки у треков из списков: кто добавил, «[v2]», «копия» (тот же трек той же версии скачан раньше).
pub(crate) async fn annotate(pool: &SqlitePool, tracks: &mut [pb::Track]) {
    let ids: Vec<&str> = tracks.iter().map(|t| t.id.as_str()).filter(|id| !id.is_empty()).collect();
    if ids.is_empty() {
        return;
    }
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms = 0 AND track_id IN ({marks})");
    let mut q = sqlx::query_as::<_, FileRow>(&sql);
    for id in &ids {
        q = q.bind(*id);
    }
    let rows = match q.fetch_all(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!("музыка: пометки треков не прочитаны: {e}");
            return;
        }
    };
    // Копии: та же версия того же трека, добавленная раньше
    let keys: HashSet<&str> = rows.iter().map(|r| r.name_key.as_str()).filter(|k| !k.is_empty()).collect();
    let mut earlier: HashMap<(String, i64), i64> = HashMap::new();
    if !keys.is_empty() {
        let marks = vec!["?"; keys.len()].join(",");
        let sql = format!("SELECT name_key, version, MIN(added_ms) FROM added_tracks WHERE deleted_ms = 0 AND name_key IN ({marks}) GROUP BY name_key, version");
        let mut q = sqlx::query_as::<_, (String, i64, i64)>(&sql);
        for k in &keys {
            q = q.bind(*k);
        }
        if let Ok(found) = q.fetch_all(pool).await {
            earlier = found.into_iter().map(|(k, v, first)| ((k, v), first)).collect();
        }
    }
    let by_id: HashMap<&str, &FileRow> = rows.iter().map(|r| (r.track_id.as_str(), r)).collect();
    for t in tracks.iter_mut() {
        if let Some(r) = by_id.get(t.id.as_str()) {
            t.adder = nick(&r.adder);
            t.version = u32::try_from(r.version.max(1)).unwrap_or(1);
            t.copy = !r.name_key.is_empty() && earlier.get(&(r.name_key.clone(), r.version)).is_some_and(|first| *first < r.added_ms);
            t.own_file = r.source == "upload" || r.source_ref.starts_with("https://");
        }
    }
}

fn tags_pb(v: &Value) -> pb::TagSet {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").chars().take(512).collect::<String>();
    // «2023-05-01», «3/12» — число в начале
    let n = |k: &str| s(k).chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u32>().unwrap_or(0);
    pb::TagSet { title: s("title"), artist: s("artist"), album: s("album"), album_artist: s("album_artist"), year: n("year"), genre: s("genre"), track_no: n("track"), release_type: s("release_type") }
}

impl Fetch {
    pub(crate) fn is_admin(&self, address: &str) -> bool {
        self.admins.iter().any(|a| a == address)
    }

    /// Путь файла трека в библиотеке и его строка учёта (если есть).
    async fn file_of(&self, sub: &Subsonic, track_id: &str) -> Result<(String, Option<FileRow>), ErrorCode> {
        if let Some(row) = row_by_track(&self.pool, track_id).await? {
            return Ok((row.path.clone(), Some(row)));
        }
        let v = sub.call(SERVICE_USER, "getSong", &[("id", track_id.to_string())]).await.map_err(|_| ErrorCode::NotFound)?;
        let path = v.get("song").and_then(|s| s.get("path")).and_then(Value::as_str).unwrap_or("").to_string();
        if path.is_empty() || self.library_path(&path).is_none() {
            return Err(ErrorCode::NotFound);
        }
        Ok((path, None))
    }

    fn can_edit(&self, address: &str, row: Option<&FileRow>) -> bool {
        self.is_admin(address) || row.is_some_and(|r| r.adder == address)
    }

    pub async fn file_info(&self, sub: &Subsonic, address: &str, r: pb::FileInfoRequest) -> Reply {
        let (path, row) = self.file_of(sub, &r.track_id).await?;
        let read = self.service()?.read_tags(&path).await.map_err(|_| ErrorCode::Unavailable)?;
        let file = read.get("file").cloned().unwrap_or(Value::Null);
        let num = |k: &str| file.get(k).and_then(Value::as_u64).unwrap_or(0);
        let mut versions = Vec::new();
        if let Some(row) = row.as_ref().filter(|r| !r.name_key.is_empty()) {
            let others: Vec<(String,)> = sqlx::query_as("SELECT track_id FROM added_tracks WHERE name_key = ? AND deleted_ms = 0 AND track_id != '' AND track_id != ? ORDER BY version, added_ms LIMIT ?")
                .bind(&row.name_key)
                .bind(&row.track_id)
                .bind(VERSIONS_MAX as i64)
                .fetch_all(&self.pool)
                .await
                .map_err(db_err)?;
            for (id,) in others {
                if let Ok(v) = sub.call(&nd_user(address), "getSong", &[("id", id)]).await {
                    if let Some(t) = v.get("song").and_then(track_of) {
                        versions.push(t);
                    }
                }
            }
            annotate(&self.pool, &mut versions).await;
        }
        let row_ref = row.as_ref();
        Ok(pb::FileInfoResponse {
            source: row_ref.map(|r| r.source.clone()).unwrap_or_default(),
            source_ref: row_ref.map(|r| r.source_ref.clone()).unwrap_or_default(),
            adder: row_ref.map(|r| nick(&r.adder)).unwrap_or_default(),
            added_ms: row_ref.map_or(0, |r| r.added_ms),
            codec: file.get("codec").and_then(Value::as_str).unwrap_or("").to_string(),
            bitrate_kbps: u32::try_from(num("bitrate") / 1000).unwrap_or(0),
            sample_rate: u32::try_from(num("sample_rate")).unwrap_or(0),
            bits: u32::try_from(num("bits")).unwrap_or(0),
            bytes: num("bytes"),
            path,
            tags: Some(tags_pb(read.get("tags").unwrap_or(&Value::Null))),
            edited_ms: row_ref.map_or(0, |r| r.edited_ms),
            edited_by: row_ref.map(|r| nick(&r.edited_by)).unwrap_or_default(),
            has_original_tags: row_ref.is_some_and(|r| !r.original_tags.is_empty()),
            versions,
            can_edit: self.can_edit(address, row_ref),
            has_cover: read.get("has_cover").and_then(Value::as_bool).unwrap_or(false),
        }
        .encode_to_vec())
    }

    /// Правка тегов у одного либо нескольких треков: меняются только поля из `fields`. Чужой трек — отказ всем
    /// (ничего не меняется). Исходные теги запоминаются при первой правке.
    pub async fn file_tags(&self, sub: &Subsonic, address: &str, r: pb::FileTagsRequest) -> Reply {
        let fields: Vec<&str> = r.fields.iter().map(String::as_str).filter(|f| TAG_FIELDS.contains(f)).collect();
        let cover_url = r.cover_url.trim();
        if r.track_ids.is_empty() || (fields.is_empty() && cover_url.is_empty() && r.cover.is_empty()) {
            return Err(ErrorCode::Invalid);
        }
        if !cover_url.is_empty() && !cover_url.starts_with("https://") {
            return Err(ErrorCode::Invalid);
        }
        let service = self.service()?;
        let mut files = Vec::with_capacity(r.track_ids.len());
        for id in &r.track_ids {
            let (path, row) = self.file_of(sub, id).await?;
            if !self.can_edit(address, row.as_ref()) {
                return Err(ErrorCode::Forbidden);
            }
            files.push((path, row));
        }
        let t = r.tags.unwrap_or_default();
        let mut tags = serde_json::Map::new();
        for f in &fields {
            let value = match *f {
                "title" => json!(t.title.trim()),
                "artist" => json!(t.artist.trim()),
                "album" => json!(t.album.trim()),
                "album_artist" => json!(t.album_artist.trim()),
                "year" => json!(if t.year == 0 { String::new() } else { t.year.to_string() }),
                "genre" => json!(t.genre.trim()),
                "release_type" => {
                    let kind = t.release_type.trim().to_lowercase();
                    if !kind.is_empty() && !RELEASE_TYPES.contains(&kind.as_str()) {
                        return Err(ErrorCode::Invalid);
                    }
                    json!(kind)
                }
                _ => json!(if t.track_no == 0 { String::new() } else { t.track_no.to_string() }),
            };
            tags.insert(if *f == "track_no" { "track".to_string() } else { (*f).to_string() }, value);
        }
        let cover_b64 = if r.cover.is_empty() { String::new() } else { base64_encode(&r.cover) };
        let (mut changed, mut failed) = (0u32, 0u32);
        for (path, row) in files {
            // Исходные теги — до первой правки
            if let Some(row) = row.as_ref().filter(|row| row.original_tags.is_empty()) {
                if let Ok(before) = service.read_tags(&path).await {
                    let original = before.get("tags").cloned().unwrap_or(Value::Null).to_string();
                    let _ = sqlx::query("UPDATE added_tracks SET original_tags = ? WHERE path = ?").bind(original).bind(&row.path).execute(&self.pool).await;
                }
            }
            match service.write_tags(&path, &Value::Object(tags.clone()), cover_url, &cover_b64).await {
                Ok(after) => {
                    changed += 1;
                    let new_tags = after.get("tags").cloned().unwrap_or(Value::Null);
                    let artist = new_tags.get("artist").and_then(Value::as_str).unwrap_or("").to_string();
                    let title = new_tags.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                    let _ = sqlx::query("UPDATE added_tracks SET edited_ms = ?, edited_by = ?, artist = ?, title = ?, name_key = ? WHERE path = ?")
                        .bind(crate::now_ms())
                        .bind(address)
                        .bind(&artist)
                        .bind(&title)
                        .bind(store::name_key(&artist, &title))
                        .bind(&path)
                        .execute(&self.pool)
                        .await;
                }
                Err(e) => {
                    warn!("музыка: теги не переписаны: {e:?}");
                    failed += 1;
                }
            }
        }
        if changed > 0 {
            let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
            info!("музыка: теги переписаны у {changed} файлов");
        }
        Ok(pb::FileTagsResponse { changed, failed }.encode_to_vec())
    }

    /// «Вернуть исходные теги»: теги до первой правки человеком.
    pub async fn restore_tags(&self, sub: &Subsonic, address: &str, r: pb::FileRestoreTagsRequest) -> Reply {
        let row = row_by_track(&self.pool, &r.track_id).await?.ok_or(ErrorCode::NotFound)?;
        if !self.can_edit(address, Some(&row)) {
            return Err(ErrorCode::Forbidden);
        }
        let original: Value = serde_json::from_str(&row.original_tags).map_err(|_| ErrorCode::NotFound)?;
        // Поля, которых в исходных не было, — убрать
        let mut tags = serde_json::Map::new();
        for f in ["title", "artist", "album", "album_artist", "year", "genre", "track", "release_type"] {
            tags.insert(f.to_string(), original.get(f).cloned().unwrap_or(json!("")));
        }
        let after = self.service()?.write_tags(&row.path, &Value::Object(tags), "", "").await.map_err(|_| ErrorCode::Unavailable)?;
        let new_tags = after.get("tags").cloned().unwrap_or(Value::Null);
        let artist = new_tags.get("artist").and_then(Value::as_str).unwrap_or("").to_string();
        let title = new_tags.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        sqlx::query("UPDATE added_tracks SET edited_ms = 0, edited_by = '', original_tags = '', artist = ?, title = ?, name_key = ? WHERE path = ?")
            .bind(&artist)
            .bind(&title)
            .bind(store::name_key(&artist, &title))
            .bind(&row.path)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        Ok(pb::FileRestoreTagsResponse {}.encode_to_vec())
    }

    /// В корзину: файл (и текст песни рядом) переезжает в `.trash/<номер>/`, запись помечается удалённой.
    pub(crate) async fn trash(&self, sub: &Subsonic, address: &str, row: &store::Added) -> Result<(), ErrorCode> {
        let src = self.library_path(&row.path).ok_or(ErrorCode::NotFound)?;
        let slot = format!("{TRASH_DIR}/{}", crate::fetch::jobs::new_id());
        let name = Path::new(&row.path).file_name().and_then(|n| n.to_str()).unwrap_or("track").to_string();
        let dest_rel = format!("{slot}/{name}");
        let dest = self.library_path(&dest_rel).ok_or(ErrorCode::Unavailable)?;
        if let Some(dir) = dest.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| {
                error!("музыка: корзина не создана: {e}");
                ErrorCode::Unavailable
            })?;
        }
        tokio::fs::rename(&src, &dest).await.map_err(|e| {
            error!("музыка: файл не перенесён в корзину: {e}");
            ErrorCode::Unavailable
        })?;
        let _ = tokio::fs::rename(src.with_extension("lrc"), dest.with_extension("lrc")).await;
        sqlx::query("UPDATE added_tracks SET deleted_ms = ?, deleted_by = ?, trash_path = ? WHERE path = ?")
            .bind(crate::now_ms())
            .bind(address)
            .bind(&dest_rel)
            .bind(&row.path)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        Ok(())
    }

    async fn trash_row(&self, id: &str) -> Result<FileRow, ErrorCode> {
        // Номер строки корзины — папка в `.trash`
        let like = format!("{TRASH_DIR}/{id}/%");
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms > 0 AND trash_path LIKE ?"))
            .bind(like)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .ok_or(ErrorCode::NotFound)
    }

    pub async fn trash_list(&self, address: &str) -> Reply {
        let admin = self.is_admin(address);
        let rows: Vec<FileRow> = if admin {
            sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms > 0 ORDER BY deleted_ms DESC LIMIT 500")).fetch_all(&self.pool).await
        } else {
            sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms > 0 AND (adder = ? OR deleted_by = ?) ORDER BY deleted_ms DESC LIMIT 500"))
                .bind(address)
                .bind(address)
                .fetch_all(&self.pool)
                .await
        }
        .map_err(db_err)?;
        let now = crate::now_ms();
        let items = rows
            .into_iter()
            .map(|r| pb::TrashItem {
                id: trash_id(&r.trash_path),
                title: r.title.clone(),
                artist: r.artist.clone(),
                adder: nick(&r.adder),
                deleted_by: nick(&r.deleted_by),
                deleted_ms: r.deleted_ms,
                days_left: u32::try_from(((r.deleted_ms + TRASH_KEEP_MS - now).max(0) + DAY_MS - 1) / DAY_MS).unwrap_or(0),
                version: u32::try_from(r.version.max(1)).unwrap_or(1),
            })
            .collect();
        Ok(pb::TrashListResponse { items, admin }.encode_to_vec())
    }

    pub async fn trash_restore(&self, sub: &Subsonic, address: &str, r: pb::TrashRestoreRequest) -> Reply {
        let row = self.trash_row(&r.id).await?;
        if !self.is_admin(address) && row.adder != address && row.deleted_by != address {
            return Err(ErrorCode::Forbidden);
        }
        let (Some(from), Some(to)) = (self.library_path(&row.trash_path), self.library_path(&row.path)) else { return Err(ErrorCode::NotFound) };
        if let Some(dir) = to.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        tokio::fs::rename(&from, &to).await.map_err(|e| {
            error!("музыка: файл не возвращён из корзины: {e}");
            ErrorCode::Unavailable
        })?;
        let _ = tokio::fs::rename(from.with_extension("lrc"), to.with_extension("lrc")).await;
        if let Some(dir) = from.parent() {
            let _ = tokio::fs::remove_dir(dir).await;
        }
        // Трек вернётся под новым номером: музыкальный сервер узнает его при сканировании
        sqlx::query("UPDATE added_tracks SET deleted_ms = 0, deleted_by = '', trash_path = '', track_id = '' WHERE path = ?")
            .bind(&row.path)
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        Ok(pb::TrashRestoreResponse {}.encode_to_vec())
    }

    /// Стереть раньше срока — только администратор.
    pub async fn trash_purge(&self, address: &str, r: pb::TrashPurgeRequest) -> Reply {
        if !self.is_admin(address) {
            return Err(ErrorCode::Forbidden);
        }
        let rows: Vec<FileRow> = if r.all {
            sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms > 0")).fetch_all(&self.pool).await.map_err(db_err)?
        } else {
            vec![self.trash_row(&r.id).await?]
        };
        for row in rows {
            self.erase(&row).await;
        }
        Ok(pb::TrashPurgeResponse {}.encode_to_vec())
    }

    async fn erase(&self, row: &FileRow) {
        if let Some(path) = self.library_path(&row.trash_path) {
            let _ = tokio::fs::remove_file(&path).await;
            let _ = tokio::fs::remove_file(path.with_extension("lrc")).await;
            if let Some(dir) = path.parent() {
                let _ = tokio::fs::remove_dir(dir).await;
            }
        }
        if let Err(e) = store::delete(&self.pool, &row.path).await {
            warn!("музыка: запись корзины не стёрта: {e}");
        }
    }

    /// Корзина старше 30 дней стирается сама (раз в шесть часов вместе с дозаполнением тегов).
    pub async fn purge_expired(&self) {
        let before = crate::now_ms() - TRASH_KEEP_MS;
        let rows: Vec<FileRow> = match sqlx::query_as(&format!("SELECT {COLUMNS} FROM added_tracks WHERE deleted_ms > 0 AND deleted_ms < ?")).bind(before).fetch_all(&self.pool).await {
            Ok(rows) => rows,
            Err(e) => {
                warn!("музыка: корзина не прочитана: {e}");
                return;
            }
        };
        for row in &rows {
            self.erase(row).await;
        }
        if !rows.is_empty() {
            info!("музыка: из корзины стёрто {} файлов", rows.len());
        }
    }
}

fn trash_id(trash_path: &str) -> String {
    trash_path.strip_prefix(&format!("{TRASH_DIR}/")).and_then(|rest| rest.split('/').next()).unwrap_or("").to_string()
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
