//! Сведения о библиотеке для экранов «Музыки» (spec 041): сколько треков, исполнителей и альбомов, треков у
//! исполнителя и «Популярное на сервере». Числа библиотеки общие для всех — шард держит их недолго в памяти;
//! прослушивания считает сам (музыкальный сервер ведёт их по пользователю, а «популярное» — по всему серверу).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1::Track;
use sqlx::SqlitePool;
use tracing::warn;

use crate::subsonic::{album_of, list, track_of, Subsonic};

/// Страница перечня альбомов при подсчёте и сколько страниц читаем самое большее.
const ALBUM_PAGE: usize = 500;
const ALBUM_PAGES_MAX: usize = 40;
const STATS_TTL_DEFAULT_SECS: u64 = 60;
pub(crate) const POPULAR_MAX: usize = 10;
const DAY_MS: i64 = 86_400_000;

#[derive(Default)]
pub(crate) struct Stats {
    pub tracks: u32,
    pub artists: u32,
    pub albums: u32,
    /// Треков у исполнителя (по id).
    pub artist_tracks: HashMap<String, u32>,
}

static STATS: Mutex<Option<(Instant, Arc<Stats>)>> = Mutex::new(None);
static PLAYS: OnceLock<SqlitePool> = OnceLock::new();

/// База прослушиваний (та же, что у учёта добавленного): микс, «не нравится», история поиска.
pub(crate) fn plays_pool() -> Option<&'static SqlitePool> {
    PLAYS.get()
}

fn stats_ttl() -> Duration {
    let secs = std::env::var("PARVANE_MUSIC_STATS_TTL_SECS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(STATS_TTL_DEFAULT_SECS);
    Duration::from_secs(secs)
}

/// Числа библиотеки: по перечню всех альбомов (исполнители — авторы альбомов, как у Subsonic ID3).
pub(crate) async fn stats(sub: &Subsonic, user: &str) -> Result<Arc<Stats>, ErrorCode> {
    if let Ok(cached) = STATS.lock() {
        if let Some((at, s)) = cached.as_ref() {
            if at.elapsed() < stats_ttl() {
                return Ok(s.clone());
            }
        }
    }
    let mut s = Stats::default();
    let mut artists = HashSet::new();
    for page in 0..ALBUM_PAGES_MAX {
        let v = sub
            .call(user, "getAlbumList2", &[("type", "alphabeticalByName".into()), ("size", ALBUM_PAGE.to_string()), ("offset", (page * ALBUM_PAGE).to_string())])
            .await?;
        let items = list(&v, &["albumList2", "album"]);
        for a in items.iter().filter_map(album_of) {
            s.albums = s.albums.saturating_add(1);
            s.tracks = s.tracks.saturating_add(a.track_count);
            if !a.artist_id.is_empty() {
                artists.insert(a.artist_id.clone());
                let n = s.artist_tracks.entry(a.artist_id).or_default();
                *n = n.saturating_add(a.track_count);
            }
        }
        if items.len() < ALBUM_PAGE {
            break;
        }
    }
    s.artists = u32::try_from(artists.len()).unwrap_or(u32::MAX);
    let s = Arc::new(s);
    if let Ok(mut cached) = STATS.lock() {
        *cached = Some((Instant::now(), s.clone()));
    }
    Ok(s)
}

/// Учёт прослушиваний — в базе шарда (та же, что у «Найти и скачать»).
pub(crate) async fn open_plays(db_path: &str) {
    match crate::fetch::store::open(db_path).await {
        Ok(pool) => {
            let _ = PLAYS.set(pool);
        }
        Err(e) => warn!("музыка: база прослушиваний не открыта — «Популярное» будет пустым: {e:#}"),
    }
}

/// Прослушивание: один человек — одно прослушивание трека в сутки.
pub(crate) async fn record_play(user: &str, track: &Track) {
    let Some(pool) = PLAYS.get() else { return };
    let day = crate::now_ms() / DAY_MS;
    let r = sqlx::query("INSERT OR IGNORE INTO plays (track_id, artist_id, user, day) VALUES (?, ?, ?, ?)")
        .bind(&track.id)
        .bind(&track.artist_id)
        .bind(user)
        .bind(day)
        .execute(pool)
        .await;
    if let Err(e) = r {
        warn!("музыка: прослушивание не записано: {e}");
    }
}

/// «Популярное на сервере»: треки исполнителя по числу прослушиваний; треков, которых уже нет, не будет.
pub(crate) async fn popular(sub: &Subsonic, user: &str, artist_id: &str) -> Vec<Track> {
    let Some(pool) = PLAYS.get() else { return vec![] };
    let ids: Vec<(String,)> = match sqlx::query_as("SELECT track_id FROM plays WHERE artist_id = ? GROUP BY track_id ORDER BY COUNT(*) DESC, track_id LIMIT ?")
        .bind(artist_id)
        .bind(POPULAR_MAX as i64)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            warn!("музыка: популярное не прочитано: {e}");
            return vec![];
        }
    };
    let mut out = Vec::with_capacity(ids.len());
    for (id,) in ids {
        if let Ok(v) = sub.call(user, "getSong", &[("id", id)]).await {
            if let Some(t) = v.get("song").and_then(track_of) {
                out.push(t);
            }
        }
    }
    out
}

/// «Популярное на сервере» за неделю (доска `MusicHome`): id трека и число прослушиваний всех людей за 7 суток.
pub(crate) async fn popular_week(limit: usize) -> Vec<(String, u32)> {
    let Some(pool) = PLAYS.get() else { return vec![] };
    let since = crate::now_ms() / DAY_MS - 6;
    let r: Result<Vec<(String, i64)>, _> =
        sqlx::query_as("SELECT track_id, COUNT(*) AS n FROM plays WHERE day >= ? GROUP BY track_id ORDER BY n DESC, track_id LIMIT ?")
            .bind(since)
            .bind(limit as i64)
            .fetch_all(pool)
            .await;
    match r {
        Ok(rows) => rows.into_iter().map(|(id, n)| (id, u32::try_from(n).unwrap_or(u32::MAX))).collect(),
        Err(e) => {
            warn!("музыка: популярное за неделю не прочитано: {e}");
            vec![]
        }
    }
}

/// «Частое у вас»: исполнители, которых человек слушал больше всего дней за 30 суток.
/// Кто чаще всех слушал исполнителя за 30 дней (ник); никто — пусто.
pub(crate) async fn top_listener(artist_id: &str) -> String {
    let Some(pool) = PLAYS.get() else { return String::new() };
    let since = crate::now_ms() / DAY_MS - 29;
    let r: Result<Option<(String,)>, _> =
        sqlx::query_as("SELECT user FROM plays WHERE artist_id = ? AND day >= ? GROUP BY user ORDER BY COUNT(*) DESC, user LIMIT 1").bind(artist_id).bind(since).fetch_optional(pool).await;
    match r {
        // Прослушивания записаны пользователем музыкального сервера: «ник.метка» (`nd_user`) — показывается ник
        Ok(row) => row.map(|(user,)| user.rsplit_once('.').map_or(user.as_str(), |(nick, _)| nick).to_string()).unwrap_or_default(),
        Err(e) => {
            warn!("музыка: слушатель исполнителя не прочитан: {e}");
            String::new()
        }
    }
}

pub(crate) async fn frequent_artists(user: &str, limit: usize) -> Vec<String> {
    let Some(pool) = PLAYS.get() else { return vec![] };
    let since = crate::now_ms() / DAY_MS - 29;
    let r: Result<Vec<(String,)>, _> = sqlx::query_as(
        "SELECT artist_id FROM plays WHERE user = ? AND day >= ? AND artist_id != '' GROUP BY artist_id ORDER BY COUNT(*) DESC, artist_id LIMIT ?",
    )
    .bind(user)
    .bind(since)
    .bind(limit as i64)
    .fetch_all(pool)
    .await;
    match r {
        Ok(rows) => rows.into_iter().map(|(id,)| id).collect(),
        Err(e) => {
            warn!("музыка: частые исполнители не прочитаны: {e}");
            vec![]
        }
    }
}

#[cfg(test)]
pub(crate) fn reset_stats() {
    if let Ok(mut cached) = STATS.lock() {
        *cached = None;
    }
}
