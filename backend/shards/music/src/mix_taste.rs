//! «Микс дня»: вкус человека и откуда брать новое. Сигналы вкуса (выбранные исполнители, ♡, прослушивания,
//! дослушанное и пропущенное, скачанное, «не нравится») собираются здесь, веса считает движок
//! ([`music_mix::taste`]). Новое из каталога — три источника: радио главных исполнителей профиля (самое близкое),
//! похожие на них исполнители и популярное в соседнем жанре (разнообразие).

use std::collections::{BTreeSet, HashMap};

use parvane_protocol::music_mix::{self, CatalogCandidate, LibraryCandidate, Signals, Source, Taste};
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message as _;
use serde_json::Value;
use sqlx::SqlitePool;
use tracing::error;

use crate::fetch::jobs::Fetch;
use crate::fetch::service::query_of_json;
use crate::subsonic::{list, Subsonic};
use crate::now_ms;

type Reply = Result<Vec<u8>, ErrorCode>;

const DAY_MS: i64 = 86_400_000;
/// За сколько дней смотреть прослушивания, пропуски и скачанное.
const SIGNAL_DAYS: i64 = 60;
/// Радио скольких главных исполнителей профиля брать.
const RADIO_ARTISTS: usize = 4;
/// Похожих на скольких главных исполнителей искать и сколько похожих брать.
const RELATED_FROM: usize = 2;
const RELATED_ARTISTS: usize = 8;
const TRACKS_PER_RELATED: u32 = 5;
/// Жанры скольких главных исполнителей узнавать и сколько соседних жанров брать.
const GENRE_FROM: usize = 2;
const NEIGHBOR_GENRES: usize = 2;
/// Пропуск — меньше стольких секунд у трека длиннее минуты; дослушал — не меньше 80 %.
const SKIP_SECS: u32 = 30;

fn db_err(e: sqlx::Error) -> ErrorCode {
    error!("музыка: вкус микса: {e}");
    ErrorCode::Unavailable
}

/// `music.listen.report`: дослушал либо пропустил трек исполнителя — запомнить; середина — ничего.
pub(crate) async fn listen_report(pool: &SqlitePool, address: &str, r: pb::ListenReportRequest) -> Reply {
    let artist = r.artist.trim();
    if artist.is_empty() {
        return Err(ErrorCode::Invalid);
    }
    let finished = r.duration_secs > 0 && u64::from(r.listened_secs) * 10 >= u64::from(r.duration_secs) * 8;
    let skipped = r.duration_secs > 60 && r.listened_secs < SKIP_SECS;
    if finished || skipped {
        sqlx::query("INSERT INTO listens (user, artist, finished, created_ms) VALUES (?, ?, ?, ?)")
            .bind(address)
            .bind(artist.chars().take(512).collect::<String>())
            .bind(i64::from(finished))
            .bind(now_ms())
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    Ok(pb::ListenReportResponse {}.encode_to_vec())
}

/// Сигналы вкуса: всё, что сервер знает о том, как человек слушает.
pub(crate) async fn signals(pool: &SqlitePool, sub: &Subsonic, user: &str, address: &str, seeds: &[pb::CatalogArtist], library: &[LibraryCandidate]) -> Signals {
    let since = now_ms() - SIGNAL_DAYS * DAY_MS;
    let mut s = Signals { seeds: seeds.iter().map(|a| a.name.clone()).collect(), ..Default::default() };
    s.starred = library.iter().filter(|t| t.starred).map(|t| t.artist.clone()).collect();
    // Прослушивания записаны с id исполнителя музыкального сервера — имена из его списка исполнителей
    let plays: Vec<(String, i64)> = sqlx::query_as("SELECT artist_id, COUNT(*) FROM plays WHERE user = ? AND day >= ? AND artist_id != '' GROUP BY artist_id")
        .bind(user)
        .bind(since / DAY_MS)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    if !plays.is_empty() {
        let names: HashMap<String, String> = match sub.call(user, "getArtists", &[]).await {
            Ok(v) => list(&v, &["artists", "index"])
                .iter()
                .flat_map(|i| i.get("artist").and_then(Value::as_array).cloned().unwrap_or_default())
                .filter_map(|a| Some((a.get("id")?.as_str()?.to_string(), a.get("name")?.as_str()?.to_string())))
                .collect(),
            Err(_) => HashMap::new(),
        };
        for (id, n) in plays {
            if let Some(name) = names.get(&id) {
                s.played.extend(std::iter::repeat_n(name.clone(), usize::try_from(n).unwrap_or(0).min(30)));
            }
        }
    }
    let listens: Vec<(String, i64)> = sqlx::query_as("SELECT artist, finished FROM listens WHERE user = ? AND created_ms >= ?")
        .bind(address)
        .bind(since)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    for (artist, finished) in listens {
        if finished == 1 {
            s.finished.push(artist);
        } else {
            s.skipped.push(artist);
        }
    }
    s.fetched = sqlx::query_as::<_, (String,)>("SELECT artist FROM added_tracks WHERE adder = ? AND added_ms >= ? AND deleted_ms = 0")
        .bind(address)
        .bind(since)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(a,)| a)
        .collect();
    let dislikes: Vec<(String, String)> = sqlx::query_as("SELECT kind, artist FROM dislikes WHERE user = ? AND artist != ''")
        .bind(address)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    for (kind, artist) in dislikes {
        if kind == "artist" {
            s.disliked_artists.push(artist);
        } else {
            s.disliked_tracks.push(artist);
        }
    }
    s
}

/// Новое из каталога для этого вкуса: радио, похожие, соседний жанр.
pub(crate) async fn catalog_candidates(fetch: &Fetch, seeds: &[pb::CatalogArtist], taste: &Taste, signals: &Signals) -> Vec<(CatalogCandidate, Value)> {
    let Ok(service) = fetch.service() else { return Vec::new() };
    let profile = profile_artists(fetch, seeds, taste, signals).await;
    let mut out: Vec<(CatalogCandidate, Value)> = Vec::new();
    let mut push = |raw: Value, source: Source, because_of: &str| {
        let q = query_of_json(&raw);
        if q.reference.is_empty() || taste.blocked.contains(&music_mix::norm(&q.artist)) {
            return;
        }
        out.push((CatalogCandidate { reference: q.reference.clone(), artist: q.artist.clone(), title: q.title.clone(), source, because_of: because_of.to_string() }, raw));
    };
    // Радио главных исполнителей
    for (name, reference) in profile.iter().take(RADIO_ARTISTS) {
        if let Ok(v) = service.catalog_call("radio", &[("ref", reference.clone())]).await {
            for raw in v.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default() {
                push(raw, Source::Radio, name);
            }
        }
    }
    // Похожие исполнители — их популярные треки
    let mut seen: BTreeSet<String> = profile.iter().map(|(name, _)| music_mix::norm(name)).collect();
    let mut related: Vec<(String, String)> = Vec::new();
    for (name, reference) in profile.iter().take(RELATED_FROM) {
        let Ok(v) = service.catalog_call("related", &[("ref", reference.clone())]).await else { continue };
        for r in v.get("artists").and_then(Value::as_array).into_iter().flatten() {
            let other = r.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            if !other.is_empty() && !taste.blocked.contains(&music_mix::norm(&other)) && seen.insert(music_mix::norm(&other)) {
                related.push((other, name.clone()));
            }
        }
    }
    related.truncate(RELATED_ARTISTS);
    for (other, because_of) in related {
        if let Ok(found) = service.catalog_raw(&format!("artist:\"{}\"", other.replace('"', "")), TRACKS_PER_RELATED).await {
            for raw in found {
                push(raw, Source::Related, &because_of);
            }
        }
    }
    // Соседний жанр: жанры главных исполнителей и их соседи — популярное там
    let mut own: Vec<u32> = Vec::new();
    for (_, reference) in profile.iter().take(GENRE_FROM) {
        if let Ok(v) = service.catalog_call("genre_of", &[("ref", reference.clone())]).await {
            if let Some(id) = v.get("id").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok()).filter(|id| *id > 0) {
                if !own.contains(&id) {
                    own.push(id);
                }
            }
        }
    }
    let mut neighbors: Vec<u32> = Vec::new();
    for id in &own {
        for n in music_mix::neighbor_genres(*id) {
            if !own.contains(n) && !neighbors.contains(n) {
                neighbors.push(*n);
            }
        }
    }
    for id in neighbors.into_iter().take(NEIGHBOR_GENRES) {
        if let Ok(v) = service.catalog_call("genre_chart", &[("id", id.to_string())]).await {
            let genre = v.pointer("/genre/name").and_then(Value::as_str).unwrap_or("").to_string();
            for raw in v.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default() {
                push(raw, Source::Genre, &genre);
            }
        }
    }
    out
}

/// Главные исполнители профиля с их ссылками каталога: выбранные знают ссылку, остальных ищем по имени.
async fn profile_artists(fetch: &Fetch, seeds: &[pb::CatalogArtist], taste: &Taste, signals: &Signals) -> Vec<(String, String)> {
    let Ok(service) = fetch.service() else { return Vec::new() };
    let known: HashMap<String, (String, String)> = seeds.iter().map(|a| (music_mix::norm(&a.name), (a.name.clone(), a.r#ref.clone()))).collect();
    // Имя как его пишут (для поиска в каталоге) по нормализованному
    let names: HashMap<String, String> = [&signals.starred, &signals.played, &signals.finished, &signals.fetched]
        .into_iter()
        .flatten()
        .map(|a| (music_mix::norm(a), a.clone()))
        .collect();
    let mut out = Vec::new();
    for norm in taste.top(RADIO_ARTISTS.max(RELATED_FROM)) {
        if let Some(found) = known.get(&norm) {
            out.push(found.clone());
            continue;
        }
        let Some(name) = names.get(&norm) else { continue };
        let Ok(v) = service.catalog_call("artists", &[("q", name.clone())]).await else { continue };
        let first = v.get("artists").and_then(Value::as_array).and_then(|list| {
            list.iter().find(|a| a.get("name").and_then(Value::as_str).is_some_and(|n| music_mix::norm(n) == norm))
        });
        if let Some(a) = first {
            let (Some(name), Some(reference)) = (a.get("name").and_then(Value::as_str), a.get("ref").and_then(Value::as_str)) else { continue };
            out.push((name.to_string(), reference.to_string()));
        }
    }
    // Профиль ещё пуст (новый человек) — выбранные исполнители
    if out.is_empty() {
        out = seeds.iter().map(|a| (a.name.clone(), a.r#ref.clone())).collect();
    }
    out
}
