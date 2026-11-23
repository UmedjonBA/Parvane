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
    if method.starts_with("music.fetch.") || method.starts_with("music.added.") || method.starts_with("music.upload.") || method.starts_with("music.catalog.") {
        let fetch = ctx.fetch.as_ref().ok_or(ErrorCode::Unavailable)?;
        return match method {
            "music.fetch.catalog" => fetch.catalog(sub, &user, body(&req)?).await,
            "music.catalog.search" => fetch.catalog_search(sub, &user, body(&req)?).await,
            "music.catalog.artist" => fetch.catalog_artist(body(&req)?).await,
            "music.catalog.album" => fetch.catalog_album(sub, &user, body(&req)?).await,
            "music.fetch.start" => fetch.start(sub_shared.clone(), &req.user, body(&req)?).await,
            "music.fetch.status" => fetch.status(&req.user),
            "music.fetch.cancel" => fetch.cancel(&req.user, body(&req)?).await,
            "music.upload.start" => crate::upload::start(fetch, ctx, &req.user, body(&req)?).await,
            "music.added.list" => fetch.added_list(sub, &req.user, body(&req)?).await,
            "music.added.delete" => fetch.added_delete(sub, &req.user, body(&req)?).await,
            _ => Err(ErrorCode::Unavailable),
        };
    }
    match method {
        "music.library.search" => search(sub, &user, body(&req)?).await,
        "music.library.recent" => recent(sub, &user, body(&req)?).await,
        "music.library.album" => album(sub, &user, body(&req)?).await,
        "music.library.artist" => artist(sub, &user, body(&req)?).await,
        "music.track.get" => track_get(sub, &user, body(&req)?).await,
        "music.stream.url" => stream_url(ctx, sub, &user, body(&req)?).await,
        "music.star.set" => star_set(sub, &user, body(&req)?).await,
        "music.star.list" => star_list(sub, &user, body(&req)?).await,
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
        let (today, used) = fetch.usage(address).await;
        info.fetch_enabled = fetch.service.is_some();
        info.upload_enabled = true;
        info.upload_max_bytes = fetch.upload_max_bytes;
        info.add_per_day = fetch.add_per_day;
        info.quota_bytes = fetch.quota_bytes;
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
    Ok(pb::LibrarySearchResponse {
        tracks: list(&v, &["searchResult3", "song"]).iter().filter_map(track_of).take(cap).collect(),
        albums: list(&v, &["searchResult3", "album"]).iter().filter_map(album_of).take(cap).collect(),
        artists,
    }
    .encode_to_vec())
}

async fn recent(sub: &Subsonic, user: &str, r: pb::LibraryRecentRequest) -> Reply {
    let v = sub.call(user, "getAlbumList2", &[("type", "newest".into()), ("size", page(r.limit).to_string()), ("offset", r.offset.to_string())]).await?;
    Ok(pb::LibraryRecentResponse { albums: list(&v, &["albumList2", "album"]).iter().filter_map(album_of).take(PAGE_MAX as usize).collect() }.encode_to_vec())
}

async fn album(sub: &Subsonic, user: &str, r: pb::LibraryAlbumRequest) -> Reply {
    if !valid_id(&r.album_id, 64) {
        return Err(ErrorCode::Invalid);
    }
    let v = sub.call(user, "getAlbum", &[("id", r.album_id)]).await?;
    let a = v.get("album").ok_or(ErrorCode::NotFound)?;
    Ok(pb::LibraryAlbumResponse { album: album_of(a), tracks: list(a, &["song"]).iter().filter_map(track_of).take(ALBUM_TRACKS_MAX).collect() }.encode_to_vec())
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
    let popular = crate::library::popular(sub, user, &r.artist_id).await;
    Ok(pb::LibraryArtistResponse { artist, albums, popular }.encode_to_vec())
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
    Ok(pb::StarListResponse { tracks: all.into_iter().skip(off).take(n).collect(), more }.encode_to_vec())
}
