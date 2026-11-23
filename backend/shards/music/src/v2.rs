//! Методы `music.*` (spec 039). Пользователь — `req.user` (JWT уже проверил gateway); музыкальному серверу он
//! называется именем `subsonic::nd_user`. Текста ошибок нет — только `ErrorCode`.

use std::sync::Arc;

use futures::StreamExt as _;
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_protocol::pb::parvane::music::v1 as pb;
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message;
use tracing::info;

use crate::subsonic::{album_of, artist_of, list, nd_user, track_of, valid_id, Subsonic};
use crate::token::{self, Claims, Grant};
use crate::{now_ms, Ctx};

const GENRES_MAX: usize = 200;
const GENRE_PAGE: usize = 50;
const PAGE_DEFAULT: u32 = 20;
const PAGE_MAX: u32 = 50;
const ALBUM_TRACKS_MAX: usize = 1000;
const ARTIST_ALBUMS_MAX: usize = 500;
/// Сколько любимых треков шард готов перелистать (список сервер отдаёт целиком).
const STARRED_MAX: usize = 5000;

pub(crate) async fn run(nc: async_nats::Client, ctx: Arc<Ctx>) -> anyhow::Result<()> {
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let ctx = ctx.clone();
        Box::pin(async move { dispatch(&ctx, m.name, req).await })
    });
    let concurrency = std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(16);
    let per_user = std::env::var("PARVANE_HANDLER_PER_USER").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    parvane_v2rt::serve_with(nc, "music", concurrency, Some(parvane_v2rt::OwnerSlots::new(per_user)), handler).await?;
    info!("music: методы v2 подключены");
    Ok(())
}

pub(crate) async fn dispatch(ctx: &Ctx, method: &str, req: ShardRequest) -> Reply {
    if req.user.is_empty() {
        return Err(ErrorCode::Forbidden);
    }
    let user = nd_user(&req.user);
    if method == "music.info" {
        return info_reply(ctx, &req.user, &user).await;
    }
    let sub_shared = ctx.sub.as_ref().ok_or(ErrorCode::Unavailable)?;
    let sub: &Subsonic = sub_shared;
    // «Микс дня», «Не нравится», история поиска
    if method.starts_with("music.mix.") || method.starts_with("music.dislike.") || method.starts_with("music.search.") {
        return crate::mix::dispatch(ctx, sub, method, &req).await;
    }
    // Общие плейлисты (spec 041, MUSIC-3): права проверяет шард
    if method.starts_with("music.shared.") {
        return crate::shared::dispatch(method, &req).await;
    }
    // Этап B: добавление треков — нужна папка библиотеки; «Найти и скачать» — ещё и сервис скачивания
    if method.starts_with("music.fetch.") || method.starts_with("music.added.") || method.starts_with("music.upload.") || method.starts_with("music.catalog.") || method.starts_with("music.file.") || method.starts_with("music.trash.") || method.starts_with("music.admin.") {
        let fetch = ctx.fetch.as_ref().ok_or(ErrorCode::Unavailable)?;
        return match method {
            "music.fetch.catalog" => fetch.catalog(sub, &user, body(&req)?).await,
            "music.catalog.search" => fetch.catalog_search(sub, &user, body(&req)?).await,
            "music.catalog.chart" => fetch.catalog_chart(sub, &user).await,
            "music.catalog.artist" => fetch.catalog_artist(sub, &user, body(&req)?).await,
            "music.catalog.album" => fetch.catalog_album(sub, &user, body(&req)?).await,
            "music.fetch.start" => fetch.start(sub_shared.clone(), &req.user, body(&req)?).await,
            "music.fetch.status" => fetch.status(&req.user),
            "music.fetch.cancel" => fetch.cancel(&req.user, body(&req)?).await,
            "music.fetch.first" => fetch.first(&req.user, body(&req)?).await,
            "music.upload.start" => crate::upload::start(fetch, ctx, &req.user, body(&req)?).await,
            "music.added.list" => fetch.added_list(sub, &req.user, body(&req)?).await,
            "music.added.delete" => fetch.added_delete(sub, &req.user, body(&req)?).await,
            "music.file.info" => fetch.file_info(sub, &req.user, body(&req)?).await,
            "music.file.tags" => fetch.file_tags(sub, &req.user, body(&req)?).await,
            "music.file.restore_tags" => fetch.restore_tags(sub, &req.user, body(&req)?).await,
            "music.trash.list" => fetch.trash_list(&req.user).await,
            "music.trash.restore" => fetch.trash_restore(sub, &req.user, body(&req)?).await,
            "music.trash.purge" => fetch.trash_purge(&req.user, body(&req)?).await,
            "music.admin.get" => fetch.admin_get(sub, &req.user).await,
            "music.admin.set" => fetch.admin_set(&req.user, body(&req)?).await,
            "music.admin.people" => fetch.admin_people(&req.user).await,
            "music.admin.person_set" => fetch.admin_person_set(&req.user, body(&req)?).await,
            "music.admin.scan" => fetch.admin_scan(sub, &req.user).await,
            _ => Err(ErrorCode::Unavailable),
        };
    }
    match method {
        "music.library.search" => search(sub, &user, body(&req)?).await,
        "music.library.recent" => recent(sub, &user, body(&req)?).await,
        "music.library.home" => home(sub, &user).await,
        "music.library.genres" => genres(sub, &user).await,
        "music.library.genre" => genre(sub, &user, body(&req)?).await,
        "music.library.album" => album(sub, &user, body(&req)?).await,
        "music.library.artist" => artist(sub, &user, body(&req)?).await,
        "music.track.get" => track_get(sub, &user, body(&req)?).await,
        "music.stream.url" => stream_url(ctx, sub, &user, body(&req)?).await,
        "music.star.set" => star_set(sub, &user, body(&req)?).await,
        "music.star.list" => star_list(sub, &user, body(&req)?).await,
        "music.lyrics" => lyrics(sub, &user, body(&req)?).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

fn page(limit: u32) -> u32 {
    if limit == 0 { PAGE_DEFAULT } else { limit.min(PAGE_MAX) }
}

async fn info_reply(ctx: &Ctx, address: &str, user: &str) -> Reply {
    let exp = now_ms() + token::COVER_TTL_MS;
    let cover_base = match &ctx.sub {
        Some(_) => token::sign(&ctx.key, &Claims { user: user.to_string(), exp_ms: exp, grant: Grant::Covers })
            .map(|t| format!("{}/_parvane/music/c/{t}/", ctx.public_base))
            .ok_or(ErrorCode::Unavailable)?,
        None => String::new(),
    };
    // Добавление треков (этап B): без папки библиотеки лимиты нулевые («выключено»)
    let mut info = pb::InfoResponse { enabled: ctx.sub.is_some(), cover_expires_ms: if cover_base.is_empty() { 0 } else { exp }, cover_base, ..Default::default() };
    // Числа для экранов (spec 041): сбой подсчёта модуль не выключает — числа просто не показываются
    if let Some(sub) = &ctx.sub {
        if let Ok(s) = crate::library::stats(sub, user).await {
            (info.library_tracks, info.library_artists, info.library_albums) = (s.tracks, s.artists, s.albums);
        }
        if let Ok(v) = sub.call(user, "getStarred2", &[]).await {
            info.starred_count = u32::try_from(list(&v, &["starred2", "song"]).len()).unwrap_or(u32::MAX);
        }
    }
    if let Some(fetch) = &ctx.fetch {
        info.admin = fetch.admins.iter().any(|a| a == address);
        info.fetch_parallel = u32::try_from(fetch.parallel).unwrap_or(u32::MAX);
        let (today, used) = fetch.usage(address).await;
        info.fetch_enabled = fetch.service.is_some();
        let limits = fetch.limits_for(address).await;
        info.fetch_enabled = info.fetch_enabled && limits.per_day > 0;
        info.upload_enabled = limits.uploads;
        info.upload_max_bytes = limits.upload_max_bytes;
        info.add_per_day = limits.per_day;
        info.quota_bytes = limits.quota_bytes;
        info.added_today = today;
        info.used_bytes = used;
    }
    Ok(info.encode_to_vec())
}

async fn search(sub: &Subsonic, user: &str, r: pb::LibrarySearchRequest) -> Reply {
    let (n, off) = (page(r.limit).to_string(), r.offset.to_string());
    let v = sub
        .call(
            user,
            "search3",
            &[
                ("query", r.query),
                ("songCount", n.clone()),
                ("songOffset", off.clone()),
                ("albumCount", n.clone()),
                ("albumOffset", off.clone()),
                ("artistCount", n),
                ("artistOffset", off),
            ],
        )
        .await?;
    let cap = PAGE_MAX as usize;
    let mut artists: Vec<pb::Artist> = list(&v, &["searchResult3", "artist"]).iter().filter_map(artist_of).take(cap).collect();
    if !artists.is_empty() {
        if let Ok(s) = crate::library::stats(sub, user).await {
            for a in &mut artists {
                a.track_count = s.artist_tracks.get(&a.id).copied().unwrap_or(0);
            }
        }
    }
    let mut tracks: Vec<pb::Track> = list(&v, &["searchResult3", "song"]).iter().filter_map(track_of).take(cap).collect();
    crate::files::annotate_tracks(&mut tracks).await;
    Ok(pb::LibrarySearchResponse {
        tracks,
        albums: list(&v, &["searchResult3", "album"]).iter().filter_map(album_of).take(cap).collect(),
        artists,
    }
    .encode_to_vec())
}

async fn recent(sub: &Subsonic, user: &str, r: pb::LibraryRecentRequest) -> Reply {
    let v = sub.call(user, "getAlbumList2", &[("type", "newest".into()), ("size", page(r.limit).to_string()), ("offset", r.offset.to_string())]).await?;
    Ok(pb::LibraryRecentResponse { albums: list(&v, &["albumList2", "album"]).iter().filter_map(album_of).take(PAGE_MAX as usize).collect() }.encode_to_vec())
}

const HOME_POPULAR: usize = 20;
const HOME_ARTISTS: usize = 12;
const HOME_FRESH: u32 = 12;

/// «Главная»: популярное за неделю с числом прослушиваний, частые исполнители человека, новые альбомы. Трека или
/// исполнителя, которых уже нет в библиотеке, в ответе нет.
async fn home(sub: &Subsonic, user: &str) -> Reply {
    let popular_ids = crate::library::popular_week(HOME_POPULAR).await;
    let jobs = popular_ids.into_iter().map(|(id, plays)| {
        let (sub, user) = (sub.clone(), user.to_string());
        async move { song(&sub, &user, &id).await.ok().map(|track| pb::PopularTrack { track: Some(track), plays_week: plays }) }
    });
    let popular: Vec<pb::PopularTrack> = futures::stream::iter(jobs).buffered(8).collect::<Vec<_>>().await.into_iter().flatten().collect();
    let artist_ids = crate::library::frequent_artists(user, HOME_ARTISTS).await;
    let jobs = artist_ids.into_iter().map(|id| {
        let (sub, user) = (sub.clone(), user.to_string());
        async move {
            let v = sub.call(&user, "getArtist", &[("id", id)]).await.ok()?;
            v.get("artist").and_then(artist_of)
        }
    });
    let frequent_artists: Vec<pb::Artist> = futures::stream::iter(jobs).buffered(8).collect::<Vec<_>>().await.into_iter().flatten().collect();
    let fresh = match sub.call(user, "getAlbumList2", &[("type", "newest".into()), ("size", HOME_FRESH.to_string())]).await {
        Ok(v) => list(&v, &["albumList2", "album"]).iter().filter_map(album_of).take(HOME_FRESH as usize).collect(),
        Err(_) => vec![],
    };
    let mut popular = popular;
    let mut tracks: Vec<pb::Track> = popular.iter_mut().filter_map(|p| p.track.take()).collect();
    crate::files::annotate_tracks(&mut tracks).await;
    for (p, t) in popular.iter_mut().zip(tracks) {
        p.track = Some(t);
    }
    Ok(pb::LibraryHomeResponse { popular, frequent_artists, fresh }.encode_to_vec())
}

async fn album(sub: &Subsonic, user: &str, r: pb::LibraryAlbumRequest) -> Reply {
    if !valid_id(&r.album_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    let v = sub.call(user, "getAlbum", &[("id", r.album_id)]).await?;
    let a = v.get("album").ok_or(ErrorCode::NotFound)?;
    let mut tracks: Vec<pb::Track> = list(a, &["song"]).iter().filter_map(track_of).take(ALBUM_TRACKS_MAX).collect();
    crate::files::annotate_tracks(&mut tracks).await;
    Ok(pb::LibraryAlbumResponse { album: album_of(a), tracks }.encode_to_vec())
}

/// Жанры библиотеки по числу треков.
async fn genres(sub: &Subsonic, user: &str) -> Reply {
    let v = sub.call(user, "getGenres", &[]).await?;
    let mut genres: Vec<pb::Genre> = list(&v, &["genres", "genre"])
        .iter()
        .filter_map(|g| {
            let name = g.get("value").and_then(serde_json::Value::as_str).unwrap_or("").trim();
            let count = |k: &str| g.get(k).and_then(serde_json::Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
            (!name.is_empty() && name.len() <= 128).then(|| pb::Genre { name: name.to_string(), track_count: count("songCount"), album_count: count("albumCount") })
        })
        .collect();
    genres.sort_by(|a, b| b.track_count.cmp(&a.track_count).then_with(|| a.name.cmp(&b.name)));
    genres.truncate(GENRES_MAX);
    Ok(pb::LibraryGenresResponse { genres }.encode_to_vec())
}

/// Треки жанра страницами по 50.
async fn genre(sub: &Subsonic, user: &str, r: pb::LibraryGenreRequest) -> Reply {
    let name = r.name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err(ErrorCode::Invalid);
    }
    let v = sub.call(user, "getSongsByGenre", &[("genre", name.to_string()), ("count", GENRE_PAGE.to_string()), ("offset", r.offset.to_string())]).await?;
    let mut tracks: Vec<pb::Track> = list(&v, &["songsByGenre", "song"]).iter().filter_map(track_of).collect();
    crate::files::annotate_tracks(&mut tracks).await;
    Ok(pb::LibraryGenreResponse { tracks }.encode_to_vec())
}

async fn artist(sub: &Subsonic, user: &str, r: pb::LibraryArtistRequest) -> Reply {
    if !valid_id(&r.artist_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    let v = sub.call(user, "getArtist", &[("id", r.artist_id.clone())]).await?;
    let a = v.get("artist").ok_or(ErrorCode::NotFound)?;
    let albums: Vec<pb::Album> = list(a, &["album"]).iter().filter_map(album_of).take(ARTIST_ALBUMS_MAX).collect();
    let artist = artist_of(a).map(|mut x| {
        x.track_count = albums.iter().fold(0u32, |n, al| n.saturating_add(al.track_count));
        x
    });
    let mut popular = crate::library::popular(sub, user, &r.artist_id).await;
    crate::files::annotate_tracks(&mut popular).await;
    let top_listener = crate::library::top_listener(&r.artist_id).await;
    Ok(pb::LibraryArtistResponse { artist, albums, popular, top_listener }.encode_to_vec())
}

async fn song(sub: &Subsonic, user: &str, id: &str) -> Result<pb::Track, ErrorCode> {
    let v = sub.call(user, "getSong", &[("id", id.to_string())]).await?;
    v.get("song").and_then(track_of).ok_or(ErrorCode::NotFound)
}

async fn track_get(sub: &Subsonic, user: &str, r: pb::TrackGetRequest) -> Reply {
    if r.track_ids.iter().any(|id| !valid_id(id, 64)) {
        return Err(ErrorCode::Invalid);
    }
    // По одному запросу на трек, не больше восьми разом; порядок ответа — порядок запроса
    let jobs = r.track_ids.into_iter().map(|id| {
        let (sub, user) = (sub.clone(), user.to_string());
        async move { song(&sub, &user, &id).await }
    });
    let found: Vec<Result<pb::Track, ErrorCode>> = futures::stream::iter(jobs).buffered(8).collect().await;
    let mut tracks = Vec::with_capacity(found.len());
    for t in found {
        match t {
            Ok(t) => tracks.push(t),
            Err(ErrorCode::NotFound) => {}
            Err(e) => return Err(e),
        }
    }
    crate::files::annotate_tracks(&mut tracks).await;
    Ok(pb::TrackGetResponse { tracks }.encode_to_vec())
}

async fn stream_url(ctx: &Ctx, sub: &Subsonic, user: &str, r: pb::StreamUrlRequest) -> Reply {
    if !valid_id(&r.track_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    let opus = match pb::StreamQuality::try_from(r.quality) {
        Ok(pb::StreamQuality::Opus) => true,
        Ok(pb::StreamQuality::Original | pb::StreamQuality::Unspecified) => false,
        Err(_) => return Err(ErrorCode::Invalid),
    };
    // Трек существует и виден пользователю — иначе ссылку не выдаём
    let t = song(sub, user, &r.track_id).await?;
    if !r.download {
        crate::library::record_play(user, &t).await;
    }
    let exp = now_ms() + token::STREAM_TTL_MS;
    let tok = token::sign(&ctx.key, &Claims { user: user.to_string(), exp_ms: exp, grant: Grant::Stream { track: t.id, opus } }).ok_or(ErrorCode::Unavailable)?;
    let mime = if opus { "audio/ogg".to_string() } else { t.mime };
    Ok(pb::StreamUrlResponse { url: format!("{}/_parvane/music/s/{tok}", ctx.public_base), expires_ms: exp, mime }.encode_to_vec())
}

async fn star_set(sub: &Subsonic, user: &str, r: pb::StarSetRequest) -> Reply {
    if !valid_id(&r.track_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    // Отметка несуществующего трека у Subsonic проходит молча — проверяем сами
    song(sub, user, &r.track_id).await?;
    sub.call(user, if r.starred { "star" } else { "unstar" }, &[("id", r.track_id)]).await?;
    Ok(pb::StarSetResponse {}.encode_to_vec())
}

async fn star_list(sub: &Subsonic, user: &str, r: pb::StarListRequest) -> Reply {
    let v = sub.call(user, "getStarred2", &[]).await?;
    let all: Vec<pb::Track> = list(&v, &["starred2", "song"]).iter().filter_map(track_of).take(STARRED_MAX).collect();
    let (off, n) = (r.offset as usize, page(r.limit) as usize);
    let more = all.len() > off.saturating_add(n);
    let mut tracks: Vec<pb::Track> = all.into_iter().skip(off).take(n).collect();
    crate::files::annotate_tracks(&mut tracks).await;
    Ok(pb::StarListResponse { tracks, more }.encode_to_vec())
}

/// Текст песни: OpenSubsonic `getLyricsBySongId` (музыкальный сервер берёт его из файла `.lrc` рядом с треком либо из
/// тегов). Синхронный — первым; текста нет — пусто.
async fn lyrics(sub: &Subsonic, user: &str, r: pb::LyricsRequest) -> Reply {
    if !valid_id(&r.track_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    let Ok(v) = sub.call(user, "getLyricsBySongId", &[("id", r.track_id.clone())]).await else {
        return Ok(pb::LyricsResponse::default().encode_to_vec());
    };
    let mut all: Vec<&serde_json::Value> = list(&v, &["lyricsList", "structuredLyrics"]).iter().collect();
    all.sort_by_key(|l| !l.get("synced").and_then(serde_json::Value::as_bool).unwrap_or(false));
    let Some(best) = all.first() else {
        return Ok(pb::LyricsResponse::default().encode_to_vec());
    };
    let synced = best.get("synced").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let lines = best
        .get("line")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .take(1000)
        .map(|l| pb::LyricsLine {
            start_ms: if synced { l.get("start").and_then(serde_json::Value::as_u64).and_then(|s| u32::try_from(s).ok()).unwrap_or(0) } else { 0 },
            text: l.get("value").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(1024).collect(),
        })
        .collect();
    Ok(pb::LyricsResponse { synced, lines }.encode_to_vec())
}
