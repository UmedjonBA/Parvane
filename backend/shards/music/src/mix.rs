//! «Микс дня», «Не нравится» и история поиска «Музыки» (как в HomeMusic).
//!
//! Микс собирается раз в местные сутки после часа из настроек: кандидаты — библиотека сервера (любимое, свои
//! прослушивания, треки выбранных исполнителей, случайные) и каталог (треки похожих на выбранных исполнителей);
//! отбор и порядок — `parvane_protocol::music_mix`. Сборка идёт в фоне (каталог отвечает секунды): `music.mix.today`
//! отвечает `building`, клиент спрашивает снова. Хранится в базе шарда (`mixes`), выдаётся с треками библиотеки
//! целиком; трек каталога, который тем временем скачали, выдаётся уже треком библиотеки.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use futures::StreamExt as _;
use parvane_protocol::music_mix::{self, CatalogCandidate, Input, LibraryCandidate, Mode, Pick};
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_protocol::pb::parvane::music::v1 as pb;
use parvane_v2rt::body;
use prost::Message as _;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tracing::{error, info, warn};

use crate::fetch::catalog::artist_pb;
use crate::fetch::jobs::{catalog_pb, Fetch};
use crate::fetch::service::query_of_json;
use crate::subsonic::{list, nd_user, track_of, Subsonic};
use crate::{now_ms, Ctx};

type Reply = Result<Vec<u8>, ErrorCode>;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
const DEFAULT_HOUR: u32 = 6;
/// Выбранных исполнителей — не больше (как в протоколе).
const ARTISTS_MAX: usize = 20;
/// Исполнителей, похожих на которых ищем для каталожной части микса.
const SEEDS_FOR_RELATED: usize = 4;
const RELATED_ARTISTS: usize = 8;
const TRACKS_PER_RELATED: u32 = 5;
/// Дней прошлых миксов, треки которых не повторяются.
const RECENT_MIX_DAYS: i64 = 2;
const HISTORY_MAX: i64 = 30;
const FETCH_PARALLEL: usize = 8;

/// Миксы, которые сейчас собираются: (человек, день).
fn building() -> &'static Mutex<HashSet<(String, String)>> {
    static BUILDING: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    BUILDING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn pool() -> Result<&'static SqlitePool, ErrorCode> {
    crate::library::plays_pool().ok_or(ErrorCode::Unavailable)
}

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: микс, отметки, история: {e}");
    ErrorCode::Unavailable
}

pub(crate) async fn dispatch(ctx: &Ctx, sub: &Subsonic, method: &str, req: &ShardRequest) -> Reply {
    let address = req.user.as_str();
    match method {
        "music.mix.today" => today(ctx, sub, address, body(req)?).await,
        "music.mix.settings" => settings_set(ctx, sub, address, body(req)?).await,
        "music.mix.rebuild" => rebuild(ctx, sub, address, body(req)?).await,
        "music.mix.artists" => artists(ctx, sub, address, body(req)?).await,
        "music.dislike.set" => dislike_set(address, body(req)?).await,
        "music.dislike.list" => dislike_list(address).await,
        "music.search.history" => history(address).await,
        "music.search.remember" => remember(address, body(req)?).await,
        "music.search.forget" => forget(address).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

// ── Настройки ───────────────────────────────────────────────────────────────────────────────────────────────────

struct Settings {
    mode: Mode,
    hour: u32,
    tz_offset_min: i32,
    artists: Vec<pb::CatalogArtist>,
}

async fn load_settings(address: &str) -> Result<Settings, ErrorCode> {
    let row: Option<(String, i64, i64, String)> = sqlx::query_as("SELECT mode, hour, tz_offset_min, artists FROM mix_settings WHERE user = ?")
        .bind(address)
        .fetch_optional(pool()?)
        .await
        .map_err(db_err)?;
    Ok(match row {
        Some((mode, hour, tz, artists)) => Settings {
            mode: Mode::parse(&mode),
            hour: u32::try_from(hour).unwrap_or(DEFAULT_HOUR).min(23),
            tz_offset_min: i32::try_from(tz).unwrap_or(0),
            artists: serde_json::from_str::<Vec<Value>>(&artists).unwrap_or_default().iter().map(artist_pb).collect(),
        },
        None => Settings { mode: Mode::Normal, hour: DEFAULT_HOUR, tz_offset_min: 0, artists: Vec::new() },
    })
}

async fn save_settings(address: &str, s: &Settings) -> Result<(), ErrorCode> {
    let artists: Vec<Value> = s.artists.iter().map(|a| json!({"ref": a.r#ref, "name": a.name, "picture": a.picture_url, "albums": a.albums_count})).collect();
    sqlx::query("INSERT OR REPLACE INTO mix_settings (user, mode, hour, tz_offset_min, artists, updated_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(address)
        .bind(s.mode.as_str())
        .bind(i64::from(s.hour))
        .bind(i64::from(s.tz_offset_min))
        .bind(Value::Array(artists).to_string())
        .bind(now_ms())
        .execute(pool()?)
        .await
        .map_err(db_err)?;
    Ok(())
}

fn settings_pb(s: &Settings) -> pb::MixSettings {
    pb::MixSettings { mode: s.mode.as_str().to_string(), hour: s.hour, artists: s.artists.clone() }
}

/// Смещение пояса клиента: не больше суток в обе стороны.
fn tz(minutes: i32) -> i32 {
    minutes.clamp(-14 * 60, 14 * 60)
}

async fn settings_set(ctx: &Ctx, sub: &Subsonic, address: &str, r: pb::MixSettingsSetRequest) -> Reply {
    let mut s = load_settings(address).await?;
    let before = (s.mode, s.artists.iter().map(|a| a.r#ref.clone()).collect::<Vec<_>>());
    if !r.mode.is_empty() {
        s.mode = Mode::parse(&r.mode);
    }
    if r.set_hour {
        s.hour = r.hour.min(23);
    }
    if r.set_artists {
        let mut seen = BTreeSet::new();
        s.artists = r.artists.into_iter().filter(|a| a.r#ref.starts_with("dz:") && !a.name.trim().is_empty() && seen.insert(a.r#ref.clone())).take(ARTISTS_MAX).collect();
    }
    s.tz_offset_min = tz(r.tz_offset_min);
    save_settings(address, &s).await?;
    // Новые исполнители или режим — сегодняшний микс собирается заново (первый выбор — первая сборка)
    if before != (s.mode, s.artists.iter().map(|a| a.r#ref.clone()).collect::<Vec<_>>()) && !s.artists.is_empty() {
        let day = mix_day(now_ms(), &s);
        let _ = sqlx::query("DELETE FROM mixes WHERE user = ? AND day = ?").bind(address).bind(&day).execute(pool()?).await;
        start_build(ctx, sub, address, day, 0);
    }
    Ok(pb::MixSettingsSetResponse { settings: Some(settings_pb(&s)) }.encode_to_vec())
}

// ── Микс ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Местный день микса: до часа обновления — ещё вчерашний.
fn mix_day(now: i64, s: &Settings) -> String {
    let local = now + i64::from(s.tz_offset_min) * 60_000;
    let mut day = local.div_euclid(DAY_MS);
    if local.rem_euclid(DAY_MS) < i64::from(s.hour) * HOUR_MS {
        day -= 1;
    }
    day_text(day)
}

fn day_text(day: i64) -> String {
    let (y, m, d) = parvane_protocol::domain::health::civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

fn day_number(text: &str) -> i64 {
    let mut parts = text.split('-').map(|p| p.parse::<i64>().unwrap_or(0));
    let (y, m, d) = (parts.next().unwrap_or(1970), parts.next().unwrap_or(1), parts.next().unwrap_or(1));
    parvane_protocol::domain::health::days_from_civil(y, u32::try_from(m).unwrap_or(1), u32::try_from(d).unwrap_or(1))
}

/// Когда соберётся следующий микс (UTC, мс).
fn next_build_ms(day: &str, s: &Settings) -> i64 {
    (day_number(day) + 1) * DAY_MS + i64::from(s.hour) * HOUR_MS - i64::from(s.tz_offset_min) * 60_000
}

async fn today(ctx: &Ctx, sub: &Subsonic, address: &str, r: pb::MixTodayRequest) -> Reply {
    let mut s = load_settings(address).await?;
    let offset = tz(r.tz_offset_min);
    if offset != s.tz_offset_min && !s.artists.is_empty() {
        s.tz_offset_min = offset;
        save_settings(address, &s).await?;
    }
    s.tz_offset_min = offset;
    if s.artists.is_empty() {
        return Ok(pb::MixTodayResponse { settings: Some(settings_pb(&s)), needs_artists: true, ..Default::default() }.encode_to_vec());
    }
    let day = mix_day(now_ms(), &s);
    let stored: Option<(i64, String, String)> = sqlx::query_as("SELECT built_ms, mode, tracks FROM mixes WHERE user = ? AND day = ?")
        .bind(address)
        .bind(&day)
        .fetch_optional(pool()?)
        .await
        .map_err(db_err)?;
    let Some((built_ms, mode, tracks)) = stored else {
        start_build(ctx, sub, address, day, 0);
        return Ok(pb::MixTodayResponse { settings: Some(settings_pb(&s)), building: true, ..Default::default() }.encode_to_vec());
    };
    let rows: Vec<Value> = serde_json::from_str(&tracks).unwrap_or_default();
    let tracks = resolve(ctx, sub, address, &rows).await;
    let mix = pb::Mix { next_ms: next_build_ms(&day, &s), day, built_ms, mode, tracks };
    let is_building = building().lock().map(|b| b.contains(&(address.to_string(), mix.day.clone()))).unwrap_or(false);
    Ok(pb::MixTodayResponse { mix: Some(mix), settings: Some(settings_pb(&s)), building: is_building, needs_artists: false }.encode_to_vec())
}

async fn rebuild(ctx: &Ctx, sub: &Subsonic, address: &str, r: pb::MixRebuildRequest) -> Reply {
    let mut s = load_settings(address).await?;
    s.tz_offset_min = tz(r.tz_offset_min);
    if s.artists.is_empty() {
        return Err(ErrorCode::Invalid);
    }
    let day = mix_day(now_ms(), &s);
    // Другое зерно — другой микс; прежний остаётся в «недавних» и не повторится
    let salt = u64::try_from(now_ms()).unwrap_or(1);
    start_build(ctx, sub, address, day, salt);
    Ok(pb::MixRebuildResponse { building: true }.encode_to_vec())
}

fn start_build(ctx: &Ctx, sub: &Subsonic, address: &str, day: String, salt: u64) {
    let key = (address.to_string(), day.clone());
    if let Ok(mut b) = building().lock() {
        if !b.insert(key.clone()) {
            return;
        }
    }
    let (sub, fetch, address) = (sub.clone(), ctx.fetch.clone(), address.to_string());
    tokio::spawn(async move {
        if let Err(e) = build(&sub, fetch.as_deref(), &address, &day, salt).await {
            warn!("музыка: микс не собран: {e:?}");
        }
        if let Ok(mut b) = building().lock() {
            b.remove(&key);
        }
    });
}

async fn build(sub: &Subsonic, fetch: Option<&Fetch>, address: &str, day: &str, salt: u64) -> Result<(), ErrorCode> {
    let s = load_settings(address).await?;
    let user = nd_user(address);
    let today = day_number(day);
    let seed_names: BTreeSet<String> = s.artists.iter().map(|a| music_mix::norm(&a.name)).collect();
    let library = library_candidates(sub, &user, &s, &seed_names).await;
    let catalog = match fetch {
        Some(f) => catalog_candidates(f, &s).await,
        None => Vec::new(),
    };
    let (disliked_tracks, disliked_artists) = dislike_sets(address).await?;
    let recent = recent_mix_tracks(address, today).await?;
    let catalog_by_ref: HashMap<String, Value> = catalog.iter().map(|(c, raw)| (c.reference.clone(), raw.clone())).collect();
    let input = Input {
        mode: s.mode,
        today,
        seed: music_mix::seed(address, today, salt),
        library,
        catalog: catalog.into_iter().map(|(c, _)| c).collect(),
        recent,
        disliked_tracks,
        disliked_artists,
    };
    let picks = music_mix::build(&input);
    let rows: Vec<Value> = picks
        .iter()
        .map(|p| match p {
            Pick::Library { id, reason } => json!({"kind": "library", "id": id, "reason": reason.as_str()}),
            Pick::Catalog { reference, because_of } => json!({"kind": "catalog", "track": catalog_by_ref.get(reference), "because_of": because_of}),
        })
        .collect();
    sqlx::query("INSERT OR REPLACE INTO mixes (user, day, built_ms, mode, tracks) VALUES (?, ?, ?, ?, ?)")
        .bind(address)
        .bind(day)
        .bind(now_ms())
        .bind(s.mode.as_str())
        .bind(Value::Array(rows).to_string())
        .execute(pool()?)
        .await
        .map_err(db_err)?;
    info!("музыка: микс собран ({} треков)", picks.len());
    Ok(())
}

/// Библиотека: любимое, свои прослушивания, треки выбранных исполнителей, случайные.
async fn library_candidates(sub: &Subsonic, user: &str, s: &Settings, seeds: &BTreeSet<String>) -> Vec<LibraryCandidate> {
    let mut by_id: HashMap<String, LibraryCandidate> = HashMap::new();
    let add = |by_id: &mut HashMap<String, LibraryCandidate>, v: &Value, starred: bool| add_candidate(by_id, seeds, v, starred);
    if let Ok(v) = sub.call(user, "getStarred2", &[]).await {
        list(&v, &["starred2", "song"]).iter().for_each(|x| add(&mut by_id, x, true));
    }
    if let Ok(v) = sub.call(user, "getRandomSongs", &[("size", "80".into())]).await {
        list(&v, &["randomSongs", "song"]).iter().for_each(|x| add(&mut by_id, x, false));
    }
    for artist in s.artists.iter().take(ARTISTS_MAX) {
        if let Ok(v) = sub.call(user, "search3", &[("query", artist.name.clone()), ("songCount", "20".into()), ("albumCount", "0".into()), ("artistCount", "0".into())]).await {
            list(&v, &["searchResult3", "song"]).iter().filter(|x| track_of(x).is_some_and(|t| music_mix::norm(&t.artist).contains(&music_mix::norm(&artist.name)))).for_each(|x| add(&mut by_id, x, false));
        }
    }
    // Свои прослушивания: сколько дней слушал и когда последний раз
    if let Ok(pool) = pool() {
        let plays: Vec<(String, i64, i64)> = sqlx::query_as("SELECT track_id, COUNT(*), MAX(day) FROM plays WHERE user = ? GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 60")
            .bind(user)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        let missing: Vec<String> = plays.iter().map(|(id, _, _)| id.clone()).filter(|id| !by_id.contains_key(id)).collect();
        let fetched: Vec<Option<Value>> = futures::stream::iter(missing.into_iter().map(|id| async move {
            sub.call(user, "getSong", &[("id", id)]).await.ok().and_then(|v| v.get("song").cloned())
        }))
        .buffered(FETCH_PARALLEL)
        .collect()
        .await;
        fetched.iter().flatten().for_each(|x| add(&mut by_id, x, false));
        for (id, count, last) in plays {
            if let Some(c) = by_id.get_mut(&id) {
                c.plays = u32::try_from(count).unwrap_or(0);
                c.last_day = Some(last);
            }
        }
    }
    by_id.into_values().collect()
}

fn add_candidate(by_id: &mut HashMap<String, LibraryCandidate>, seeds: &BTreeSet<String>, v: &Value, starred: bool) {
    let Some(t) = track_of(v) else { return };
    let entry = by_id.entry(t.id.clone()).or_insert_with(|| LibraryCandidate {
        id: t.id.clone(),
        artist: t.artist.clone(),
        title: t.title.clone(),
        seed_artist: seeds.contains(&music_mix::norm(&t.artist)),
        ..Default::default()
    });
    entry.starred |= starred || t.starred;
}

/// Каталог: треки исполнителей, похожих на выбранных.
async fn catalog_candidates(fetch: &Fetch, s: &Settings) -> Vec<(CatalogCandidate, Value)> {
    let Ok(service) = fetch.service() else { return Vec::new() };
    let mut related: Vec<(String, String)> = Vec::new();
    let mut seen = BTreeSet::new();
    let chosen: BTreeSet<String> = s.artists.iter().map(|a| music_mix::norm(&a.name)).collect();
    for artist in s.artists.iter().take(SEEDS_FOR_RELATED) {
        let Ok(v) = service.catalog_call("related", &[("ref", artist.r#ref.clone())]).await else { continue };
        for r in v.get("artists").and_then(Value::as_array).into_iter().flatten() {
            let name = r.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            if !name.is_empty() && seen.insert(music_mix::norm(&name)) {
                related.push((name, artist.name.clone()));
            }
        }
    }
    // В режиме «Новое» — и сами выбранные исполнители (их треки, которых нет на сервере)
    if s.mode == Mode::Discover {
        related.extend(s.artists.iter().map(|a| (a.name.clone(), a.name.clone())));
    }
    related.retain(|(name, _)| s.mode == Mode::Discover || !chosen.contains(&music_mix::norm(name)));
    related.truncate(RELATED_ARTISTS);
    let mut out = Vec::new();
    for (name, because_of) in related {
        let Ok(found) = service.catalog_raw(&format!("artist:\"{}\"", name.replace('"', "")), TRACKS_PER_RELATED).await else { continue };
        for raw in found {
            let q = query_of_json(&raw);
            if q.reference.is_empty() {
                continue;
            }
            out.push((CatalogCandidate { reference: q.reference.clone(), artist: q.artist.clone(), title: q.title.clone(), because_of: because_of.clone() }, raw));
        }
    }
    out
}

async fn recent_mix_tracks(address: &str, today: i64) -> Result<BTreeSet<String>, ErrorCode> {
    let since = day_text(today - RECENT_MIX_DAYS);
    let rows: Vec<(String,)> = sqlx::query_as("SELECT tracks FROM mixes WHERE user = ? AND day >= ? AND day < ?")
        .bind(address)
        .bind(&since)
        .bind(day_text(today))
        .fetch_all(pool()?)
        .await
        .map_err(db_err)?;
    let mut out = BTreeSet::new();
    for (tracks,) in rows {
        for row in serde_json::from_str::<Vec<Value>>(&tracks).unwrap_or_default() {
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                out.insert(id.to_string());
            }
            if let Some(r) = row.pointer("/track/ref").and_then(Value::as_str) {
                out.insert(r.to_string());
            }
        }
    }
    Ok(out)
}

/// Строки микса для клиента: библиотека — трек целиком; каталог — эталон либо, если уже скачан, трек библиотеки.
async fn resolve(ctx: &Ctx, sub: &Subsonic, address: &str, rows: &[Value]) -> Vec<pb::MixTrack> {
    let user = nd_user(address);
    let fetch = ctx.fetch.clone();
    let items = rows.iter().cloned().map(|row| {
        let (user, fetch) = (user.clone(), fetch.clone());
        async move {
            let reason = row.get("reason").and_then(Value::as_str).unwrap_or("catalog").to_string();
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                let track = sub.call(&user, "getSong", &[("id", id.to_string())]).await.ok().and_then(|v| v.get("song").and_then(track_of))?;
                return Some(pb::MixTrack { track: Some(track), reason, ..Default::default() });
            }
            let raw = row.get("track")?;
            let q = query_of_json(raw);
            let because_of = row.get("because_of").and_then(Value::as_str).unwrap_or("").to_string();
            let year = raw.get("year").and_then(Value::as_u64).and_then(|y| u32::try_from(y).ok()).unwrap_or(0);
            if let Some(f) = fetch.as_deref() {
                if let Some(track) = f.in_library(sub, &user, &q).await {
                    return Some(pb::MixTrack { track: Some(track), reason: "catalog".into(), because_of, ..Default::default() });
                }
            }
            Some(pb::MixTrack { catalog: Some(catalog_pb(&q, year, String::new())), reason: "catalog".into(), because_of, ..Default::default() })
        }
    });
    futures::stream::iter(items).buffered(FETCH_PARALLEL).filter_map(|x| async move { x }).collect().await
}

/// Исполнители для выбора: подсказки (самые частые в библиотеке, найденные в каталоге, и чарт) либо поиск.
async fn artists(ctx: &Ctx, sub: &Subsonic, address: &str, r: pb::MixArtistsRequest) -> Reply {
    let fetch = ctx.fetch.as_ref().ok_or(ErrorCode::Unavailable)?;
    let service = fetch.service()?;
    let query = r.query.trim();
    if !query.is_empty() {
        let v = service.catalog_call("artists", &[("q", query.to_string())]).await.map_err(|_| ErrorCode::Unavailable)?;
        return Ok(pb::MixArtistsResponse { artists: v.get("artists").and_then(Value::as_array).into_iter().flatten().map(artist_pb).collect() }.encode_to_vec());
    }
    let mut out: Vec<pb::CatalogArtist> = Vec::new();
    let mut seen = BTreeSet::new();
    // Исполнители библиотеки с большим числом альбомов — сперва (их знают на этом сервере)
    if let Ok(v) = sub.call(&nd_user(address), "getArtists", &[]).await {
        let mut local: Vec<(String, u64)> = list(&v, &["artists", "index"])
            .iter()
            .flat_map(|i| i.get("artist").and_then(Value::as_array).cloned().unwrap_or_default())
            .map(|a| (a.get("name").and_then(Value::as_str).unwrap_or("").to_string(), a.get("albumCount").and_then(Value::as_u64).unwrap_or(0)))
            .filter(|(n, _)| !n.is_empty())
            .collect();
        local.sort_by(|a, b| b.1.cmp(&a.1));
        for (name, _) in local.into_iter().take(8) {
            if let Ok(v) = service.catalog_call("artists", &[("q", name)]).await {
                if let Some(first) = v.get("artists").and_then(Value::as_array).and_then(|a| a.first()) {
                    let a = artist_pb(first);
                    if seen.insert(a.r#ref.clone()) {
                        out.push(a);
                    }
                }
            }
        }
    }
    if let Ok(v) = service.catalog_call("artists", &[]).await {
        for a in v.get("artists").and_then(Value::as_array).into_iter().flatten().map(artist_pb) {
            if out.len() >= 40 {
                break;
            }
            if seen.insert(a.r#ref.clone()) {
                out.push(a);
            }
        }
    }
    Ok(pb::MixArtistsResponse { artists: out }.encode_to_vec())
}

// ── «Не нравится» ───────────────────────────────────────────────────────────────────────────────────────────────

async fn dislike_set(address: &str, r: pb::DislikeSetRequest) -> Reply {
    let (kind, key) = if !r.track_id.trim().is_empty() {
        ("track", r.track_id.trim().to_string())
    } else if !r.r#ref.trim().is_empty() {
        ("track", r.r#ref.trim().to_string())
    } else if !r.artist.trim().is_empty() {
        ("artist", music_mix::norm(&r.artist))
    } else {
        return Err(ErrorCode::Invalid);
    };
    if key.is_empty() {
        return Err(ErrorCode::Invalid);
    }
    if r.undo {
        sqlx::query("DELETE FROM dislikes WHERE user = ? AND kind = ? AND key = ?").bind(address).bind(kind).bind(&key).execute(pool()?).await.map_err(db_err)?;
    } else {
        sqlx::query("INSERT OR REPLACE INTO dislikes (user, kind, key, track_id, ref, artist, title, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(address)
            .bind(kind)
            .bind(&key)
            .bind(r.track_id.trim())
            .bind(r.r#ref.trim())
            .bind(r.artist.trim())
            .bind(r.title.trim())
            .bind(now_ms())
            .execute(pool()?)
            .await
            .map_err(db_err)?;
    }
    Ok(pb::DislikeSetResponse {}.encode_to_vec())
}

async fn dislike_list(address: &str) -> Reply {
    let rows: Vec<(String, String, String, String, String, i64)> =
        sqlx::query_as("SELECT kind, track_id, ref, artist, title, created_ms FROM dislikes WHERE user = ? ORDER BY created_ms DESC LIMIT 500")
            .bind(address)
            .fetch_all(pool()?)
            .await
            .map_err(db_err)?;
    let items = rows.into_iter().map(|(kind, track_id, r, artist, title, created_ms)| pb::Dislike { kind, track_id, r#ref: r, artist, title, created_ms }).collect();
    Ok(pb::DislikeListResponse { items }.encode_to_vec())
}

async fn dislike_sets(address: &str) -> Result<(BTreeSet<String>, BTreeSet<String>), ErrorCode> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT kind, key FROM dislikes WHERE user = ?").bind(address).fetch_all(pool()?).await.map_err(db_err)?;
    let mut tracks = BTreeSet::new();
    let mut artists = BTreeSet::new();
    for (kind, key) in rows {
        if kind == "artist" {
            artists.insert(key);
        } else {
            tracks.insert(key);
        }
    }
    Ok((tracks, artists))
}

// ── История поиска ──────────────────────────────────────────────────────────────────────────────────────────────

async fn history(address: &str) -> Reply {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT query FROM search_history WHERE user = ? ORDER BY searched_ms DESC LIMIT ?")
        .bind(address)
        .bind(HISTORY_MAX)
        .fetch_all(pool()?)
        .await
        .map_err(db_err)?;
    Ok(pb::SearchHistoryResponse { queries: rows.into_iter().map(|(q,)| q).collect() }.encode_to_vec())
}

async fn remember(address: &str, r: pb::SearchRememberRequest) -> Reply {
    let query = r.query.trim();
    if query.chars().count() < 2 {
        return Err(ErrorCode::Invalid);
    }
    let pool = pool()?;
    sqlx::query("INSERT OR REPLACE INTO search_history (user, query_key, query, searched_ms) VALUES (?, ?, ?, ?)")
        .bind(address)
        .bind(query.to_lowercase())
        .bind(query)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM search_history WHERE user = ? AND query_key NOT IN (SELECT query_key FROM search_history WHERE user = ? ORDER BY searched_ms DESC LIMIT ?)")
        .bind(address)
        .bind(address)
        .bind(HISTORY_MAX)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(pb::SearchRememberResponse {}.encode_to_vec())
}

async fn forget(address: &str) -> Reply {
    sqlx::query("DELETE FROM search_history WHERE user = ?").bind(address).execute(pool()?).await.map_err(db_err)?;
    Ok(pb::SearchForgetResponse {}.encode_to_vec())
}
