//! Шард «Музыки» на поддельном Subsonic-сервере: каталог, отметки, ссылки, поток с Range, чужие и истёкшие
//! жетоны. Поддельный сервер, как настоящий с внешней аутентификацией, узнаёт пользователя по `Remote-User`.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response};
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use serde_json::json;

use crate::subsonic::{nd_user, Subsonic};
use crate::token::{self, Claims, Grant};
use crate::{http, now_ms, v2, Ctx};

/// Тело «файла» трека: 1000 байт 0..=249 по кругу.
fn audio() -> Vec<u8> {
    (0..1000u32).map(|i| (i % 250) as u8).collect()
}

#[derive(Default)]
struct Fake {
    /// Отметки «любимое»: (пользователь, трек).
    starred: Mutex<HashSet<(String, String)>>,
    /// Заведённые пользователи: как у Navidrome, API незнакомого не пускает (отказ 40), а страница `/app/` создаёт.
    users: Mutex<HashSet<String>>,
    /// Кто приходил (по `Remote-User`).
    seen_users: Mutex<Vec<String>>,
    /// Последние параметры потока.
    last_stream: Mutex<HashMap<String, String>>,
}

fn song(id: &str, starred: bool) -> serde_json::Value {
    let mut s = json!({"id": id, "title": format!("Песня {id}"), "artist": "Группа", "album": "Альбом", "albumId": "al-1", "artistId": "ar-1",
        "duration": 215, "size": 1000, "contentType": "audio/mpeg", "coverArt": "al-1", "track": 1, "year": 2020, "bitRate": 320});
    if starred {
        s["starred"] = json!("2026-11-16T00:00:00Z");
    }
    s
}

fn ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    let mut r = body;
    r["status"] = json!("ok");
    r["version"] = json!("1.16.1");
    Response::builder().header("content-type", "application/json").body(Full::new(Bytes::from(json!({"subsonic-response": r}).to_string()))).unwrap()
}

fn fail(code: i64) -> Response<Full<Bytes>> {
    let r = json!({"subsonic-response": {"status": "failed", "version": "1.16.1", "error": {"code": code, "message": "x"}}});
    Response::builder().header("content-type", "application/json").body(Full::new(Bytes::from(r.to_string()))).unwrap()
}

async fn fake_serve(fake: Arc<Fake>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let user = req.headers().get("Remote-User").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if user.is_empty() {
        return fail(40);
    }
    if req.uri().path() == "/app/" {
        fake.users.lock().unwrap().insert(user);
        return Response::builder().header("content-type", "text/html").body(Full::new(Bytes::from("<html></html>"))).unwrap();
    }
    if !fake.users.lock().unwrap().contains(&user) {
        return fail(40);
    }
    fake.seen_users.lock().unwrap().push(user.clone());
    let q: HashMap<String, String> = req.uri().query().unwrap_or("").split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.replace("%20", " "))).collect();
    if q.get("f").map(String::as_str) != Some("json") || !q.contains_key("v") || !q.contains_key("c") {
        return fail(10);
    }
    let id = q.get("id").cloned().unwrap_or_default();
    let known = ["t1", "t2", "t3"];
    let is_starred = |t: &str| fake.starred.lock().unwrap().contains(&(user.clone(), t.to_string()));
    match req.uri().path() {
        "/rest/ping" => ok(json!({})),
        "/rest/search3" => {
            let n: usize = q.get("songCount").and_then(|v| v.parse().ok()).unwrap_or(20);
            let off: usize = q.get("songOffset").and_then(|v| v.parse().ok()).unwrap_or(0);
            let songs: Vec<_> = known.iter().skip(off).take(n).map(|t| song(t, is_starred(t))).collect();
            ok(json!({"searchResult3": {"song": songs, "album": [{"id": "al-1", "name": "Альбом", "artist": "Группа", "artistId": "ar-1", "coverArt": "al-1", "songCount": 3, "duration": 645, "year": 2020}],
                "artist": [{"id": "ar-1", "name": "Группа", "albumCount": 1}]}}))
        }
        "/rest/getAlbumList2" => ok(json!({"albumList2": {"album": [{"id": "al-1", "name": "Альбом", "artist": "Группа", "songCount": 3}]}})),
        "/rest/getAlbum" if id == "al-1" => ok(json!({"album": {"id": "al-1", "name": "Альбом", "artist": "Группа", "songCount": 3, "song": known.iter().map(|t| song(t, is_starred(t))).collect::<Vec<_>>()}})),
        "/rest/getArtist" if id == "ar-1" => ok(json!({"artist": {"id": "ar-1", "name": "Группа", "albumCount": 1, "album": [{"id": "al-1", "name": "Альбом"}]}})),
        "/rest/getSong" if known.contains(&id.as_str()) => ok(json!({"song": song(&id, is_starred(&id))})),
        "/rest/star" => {
            fake.starred.lock().unwrap().insert((user, id));
            ok(json!({}))
        }
        "/rest/unstar" => {
            fake.starred.lock().unwrap().remove(&(user, id));
            ok(json!({}))
        }
        "/rest/getStarred2" => {
            let songs: Vec<_> = known.iter().filter(|t| is_starred(t)).map(|t| song(t, true)).collect();
            // Пустой список у Subsonic — отсутствие поля
            ok(if songs.is_empty() { json!({"starred2": {}}) } else { json!({"starred2": {"song": songs}}) })
        }
        "/rest/stream" if known.contains(&id.as_str()) => {
            *fake.last_stream.lock().unwrap() = q.clone();
            let data = audio();
            let ctype = if q.get("format").map(String::as_str) == Some("opus") { "audio/ogg" } else { "audio/mpeg" };
            match req.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split_once('-')) {
                Some((a, b)) => {
                    let a: usize = a.parse().unwrap();
                    let b: usize = if b.is_empty() { data.len() - 1 } else { b.parse().unwrap() };
                    Response::builder()
                        .status(206)
                        .header("content-type", ctype)
                        .header("content-range", format!("bytes {a}-{b}/{}", data.len()))
                        .header("accept-ranges", "bytes")
                        .body(Full::new(Bytes::from(data[a..=b].to_vec())))
                        .unwrap()
                }
                None => Response::builder().header("content-type", ctype).header("accept-ranges", "bytes").body(Full::new(Bytes::from(data))).unwrap(),
            }
        }
        "/rest/getCoverArt" if id == "al-1" => Response::builder().header("content-type", "image/jpeg").body(Full::new(Bytes::from(format!("jpeg:{}", q.get("size").cloned().unwrap_or_default())))).unwrap(),
        _ => fail(70),
    }
}

async fn spawn_fake() -> (Arc<Fake>, String) {
    let fake = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let f = fake.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let f = f.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| {
                    let f = f.clone();
                    async move { Ok::<_, Infallible>(fake_serve(f, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), svc).await;
            });
        }
    });
    (fake, format!("http://{addr}"))
}

/// Шард с поддельным сервером; HTTP-ссылки — на случайном порту.
async fn setup() -> (Arc<Fake>, Arc<Ctx>, String) {
    let (fake, base) = spawn_fake().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public = format!("http://{}", listener.local_addr().unwrap());
    let ctx = Arc::new(Ctx { sub: Some(Arc::new(Subsonic::new(&base).unwrap())), fetch: None, key: [9u8; 32], public_base: public.clone() });
    tokio::spawn(http::serve_listener(ctx.clone(), listener));
    (fake, ctx, public)
}

async fn call<R: Message + Default>(ctx: &Ctx, user: &str, method: &str, body: impl Message) -> Result<R, ErrorCode> {
    let req = ShardRequest { user: user.into(), body: body.encode_to_vec(), ..Default::default() };
    v2::dispatch(ctx, method, req).await.map(|b| R::decode(b.as_slice()).unwrap())
}

#[tokio::test]
async fn catalogue_and_stars_are_per_user() {
    let (fake, ctx, _) = setup().await;
    let (alice, bob) = ("alice@local", "bob@local");
    let r: pb::LibrarySearchResponse = call(&ctx, alice, "music.library.search", pb::LibrarySearchRequest { query: "песня".into(), offset: 0, limit: 2 }).await.unwrap();
    assert_eq!(r.tracks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["t1", "t2"]);
    assert_eq!((r.albums.len(), r.artists.len(), r.tracks[0].duration_secs, r.tracks[0].cover_id.as_str()), (1, 1, 215, "al-1"));
    // Музыкальному серверу пользователь назван именем шарда, не адресом
    assert_eq!(fake.seen_users.lock().unwrap().last().unwrap(), &nd_user(alice));
    let a: pb::LibraryAlbumResponse = call(&ctx, alice, "music.library.album", pb::LibraryAlbumRequest { album_id: "al-1".into() }).await.unwrap();
    assert_eq!((a.album.unwrap().track_count, a.tracks.len()), (3, 3));
    let ar: pb::LibraryArtistResponse = call(&ctx, alice, "music.library.artist", pb::LibraryArtistRequest { artist_id: "ar-1".into() }).await.unwrap();
    assert_eq!(ar.albums.len(), 1);
    let rc: pb::LibraryRecentResponse = call(&ctx, alice, "music.library.recent", pb::LibraryRecentRequest::default()).await.unwrap();
    assert_eq!(rc.albums[0].title, "Альбом");
    assert_eq!(call::<pb::LibraryAlbumResponse>(&ctx, alice, "music.library.album", pb::LibraryAlbumRequest { album_id: "нет".into() }).await.unwrap_err(), ErrorCode::Invalid);
    assert_eq!(call::<pb::LibraryAlbumResponse>(&ctx, alice, "music.library.album", pb::LibraryAlbumRequest { album_id: "al-404".into() }).await.unwrap_err(), ErrorCode::NotFound);

    // Отметки: у каждого свои; несуществующий трек — отказ; пустой список — не ошибка
    let empty: pb::StarListResponse = call(&ctx, alice, "music.star.list", pb::StarListRequest::default()).await.unwrap();
    assert!(empty.tracks.is_empty() && !empty.more);
    for t in ["t1", "t3"] {
        let _: pb::StarSetResponse = call(&ctx, alice, "music.star.set", pb::StarSetRequest { track_id: t.into(), starred: true }).await.unwrap();
    }
    assert_eq!(call::<pb::StarSetResponse>(&ctx, alice, "music.star.set", pb::StarSetRequest { track_id: "t404".into(), starred: true }).await.unwrap_err(), ErrorCode::NotFound);
    let page: pb::StarListResponse = call(&ctx, alice, "music.star.list", pb::StarListRequest { offset: 0, limit: 1 }).await.unwrap();
    assert_eq!((page.tracks.len(), page.more, page.tracks[0].starred), (1, true, true));
    let bobs: pb::StarListResponse = call(&ctx, bob, "music.star.list", pb::StarListRequest::default()).await.unwrap();
    assert!(bobs.tracks.is_empty(), "отметки alice не видны bob");
    let _: pb::StarSetResponse = call(&ctx, alice, "music.star.set", pb::StarSetRequest { track_id: "t1".into(), starred: false }).await.unwrap();
    let got: pb::TrackGetResponse = call(&ctx, alice, "music.track.get", pb::TrackGetRequest { track_ids: vec!["t3".into(), "t404".into(), "t1".into()] }).await.unwrap();
    assert_eq!(got.tracks.iter().map(|t| (t.id.as_str(), t.starred)).collect::<Vec<_>>(), vec![("t3", true), ("t1", false)], "порядок запроса, ненайденное пропущено");

    // Без личности — отказ
    assert_eq!(call::<pb::InfoResponse>(&ctx, "", "music.info", pb::InfoRequest {}).await.unwrap_err(), ErrorCode::Forbidden);
}

#[tokio::test]
async fn stream_links_carry_ranges_and_refuse_foreign_tokens() {
    let (fake, ctx, public) = setup().await;
    let http = reqwest::Client::new();
    let r: pb::StreamUrlResponse = call(&ctx, "alice@local", "music.stream.url", pb::StreamUrlRequest { track_id: "t2".into(), quality: pb::StreamQuality::Original as i32 }).await.unwrap();
    assert!(r.url.starts_with(&format!("{public}/_parvane/music/s/")) && r.mime == "audio/mpeg" && r.expires_ms > now_ms());
    // Целиком
    let full = http.get(&r.url).send().await.unwrap();
    assert_eq!((full.status().as_u16(), full.headers()["content-type"].to_str().unwrap()), (200, "audio/mpeg"));
    assert_eq!(full.bytes().await.unwrap().to_vec(), audio());
    assert_eq!(fake.last_stream.lock().unwrap().get("format").map(String::as_str), Some("raw"));
    // Диапазон — как просит плеер при перемотке
    let part = http.get(&r.url).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(part.status().as_u16(), 206);
    assert_eq!(part.headers()["content-range"].to_str().unwrap(), "bytes 100-199/1000");
    assert_eq!(part.bytes().await.unwrap().to_vec(), audio()[100..200].to_vec());
    // Перекодированный поток
    let o: pb::StreamUrlResponse = call(&ctx, "alice@local", "music.stream.url", pb::StreamUrlRequest { track_id: "t2".into(), quality: pb::StreamQuality::Opus as i32 }).await.unwrap();
    assert_eq!(o.mime, "audio/ogg");
    assert_eq!(http.get(&o.url).send().await.unwrap().headers()["content-type"].to_str().unwrap(), "audio/ogg");
    let q = fake.last_stream.lock().unwrap().clone();
    assert_eq!((q.get("format").map(String::as_str), q.get("maxBitRate").map(String::as_str)), (Some("opus"), Some("128")));
    // Ссылку на несуществующий трек шард не выдаёт
    assert_eq!(call::<pb::StreamUrlResponse>(&ctx, "alice@local", "music.stream.url", pb::StreamUrlRequest { track_id: "t404".into(), quality: 1 }).await.unwrap_err(), ErrorCode::NotFound);

    // Подделки: чужой ключ, истёкший срок, изменённый жетон, жетон обложек вместо потока, POST
    let user = nd_user("alice@local");
    let stream = |key: &[u8; 32], exp: i64| token::sign(key, &Claims { user: user.clone(), exp_ms: exp, grant: Grant::Stream { track: "t2".into(), opus: false } }).unwrap();
    let covers = token::sign(&ctx.key, &Claims { user: user.clone(), exp_ms: now_ms() + 60_000, grant: Grant::Covers }).unwrap();
    for bad in [stream(&[1u8; 32], now_ms() + 60_000), stream(&ctx.key, now_ms() - 1), format!("{}A", stream(&ctx.key, now_ms() + 60_000)), covers.clone()] {
        assert_eq!(http.get(format!("{public}/_parvane/music/s/{bad}")).send().await.unwrap().status().as_u16(), 403);
    }
    assert_eq!(http.post(&r.url).send().await.unwrap().status().as_u16(), 405);
    assert_eq!(http.get(format!("{public}/_parvane/other")).send().await.unwrap().status().as_u16(), 404);

    // Обложки: база из music.info, размер ограничен, жетон потока обложку не открывает
    let info: pb::InfoResponse = call(&ctx, "alice@local", "music.info", pb::InfoRequest {}).await.unwrap();
    assert!(info.enabled && info.cover_expires_ms > now_ms());
    let c = http.get(format!("{}al-1?size=99999", info.cover_base)).send().await.unwrap();
    assert_eq!((c.status().as_u16(), c.headers()["content-type"].to_str().unwrap()), (200, "image/jpeg"));
    assert_eq!(c.text().await.unwrap(), "jpeg:1200");
    assert_eq!(http.get(format!("{}al-404", info.cover_base)).send().await.unwrap().status().as_u16(), 404, "отказ сервера — не картинка");
    let s = stream(&ctx.key, now_ms() + 60_000);
    assert_eq!(http.get(format!("{public}/_parvane/music/c/{s}/al-1")).send().await.unwrap().status().as_u16(), 403);
}

#[tokio::test]
async fn disabled_library_answers_unavailable() {
    let ctx = Ctx { sub: None, fetch: None, key: [9u8; 32], public_base: String::new() };
    let info: pb::InfoResponse = call(&ctx, "alice@local", "music.info", pb::InfoRequest {}).await.unwrap();
    assert!(!info.enabled && info.cover_base.is_empty());
    assert_eq!(call::<pb::LibrarySearchResponse>(&ctx, "alice@local", "music.library.search", pb::LibrarySearchRequest::default()).await.unwrap_err(), ErrorCode::Unavailable);
}

/// Проверка на настоящем Navidrome (spec 039 T6): `PARVANE_TEST_NAVIDROME_URL=http://127.0.0.1:4533 cargo test -p
/// music real_navidrome -- --ignored --nocapture`. Сервер должен доверять заголовку от 127.0.0.1
/// (`ND_EXTAUTH_TRUSTEDSOURCES=127.0.0.1/32`) и иметь в библиотеке хотя бы один трек.
#[tokio::test]
#[ignore]
async fn real_navidrome() {
    let base = std::env::var("PARVANE_TEST_NAVIDROME_URL").expect("PARVANE_TEST_NAVIDROME_URL");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public = format!("http://{}", listener.local_addr().unwrap());
    let ctx = Arc::new(Ctx { sub: Some(Arc::new(Subsonic::new(&base).unwrap())), fetch: None, key: [9u8; 32], public_base: public.clone() });
    tokio::spawn(http::serve_listener(ctx.clone(), listener));
    // Служебный пользователь первым — как при старте шарда
    ctx.sub.as_ref().unwrap().call(crate::subsonic::SERVICE_USER, "ping", &[]).await.expect("ping служебным пользователем");
    let (alice, bob) = ("alice@music.test", "bob@music.test");
    let http = reqwest::Client::new();

    let r: pb::LibrarySearchResponse = call(&ctx, alice, "music.library.search", pb::LibrarySearchRequest::default()).await.unwrap();
    eprintln!("поиск: треков {}, альбомов {}, артистов {}", r.tracks.len(), r.albums.len(), r.artists.len());
    let t = r.tracks.first().expect("в библиотеке нет треков").clone();
    eprintln!("трек: {t:?}");
    assert!(!t.title.is_empty() && t.duration_secs > 0 && t.size_bytes > 0 && t.mime.starts_with("audio/"));
    let a: pb::LibraryAlbumResponse = call(&ctx, alice, "music.library.album", pb::LibraryAlbumRequest { album_id: t.album_id.clone() }).await.unwrap();
    assert!(a.tracks.iter().any(|x| x.id == t.id));
    let ar: pb::LibraryArtistResponse = call(&ctx, alice, "music.library.artist", pb::LibraryArtistRequest { artist_id: t.artist_id.clone() }).await.unwrap();
    assert!(!ar.albums.is_empty());
    let rc: pb::LibraryRecentResponse = call(&ctx, alice, "music.library.recent", pb::LibraryRecentRequest::default()).await.unwrap();
    assert!(!rc.albums.is_empty());
    assert_eq!(call::<pb::LibraryAlbumResponse>(&ctx, alice, "music.library.album", pb::LibraryAlbumRequest { album_id: "no-such-album".into() }).await.unwrap_err(), ErrorCode::NotFound);
    assert_eq!(call::<pb::StreamUrlResponse>(&ctx, alice, "music.stream.url", pb::StreamUrlRequest { track_id: "no-such-track".into(), quality: 1 }).await.unwrap_err(), ErrorCode::NotFound);

    // Поток: целиком, диапазоном и перекодированный
    let s: pb::StreamUrlResponse = call(&ctx, alice, "music.stream.url", pb::StreamUrlRequest { track_id: t.id.clone(), quality: 1 }).await.unwrap();
    let full = http.get(&s.url).send().await.unwrap();
    eprintln!("поток: {} {:?}", full.status(), full.headers());
    assert_eq!(full.status().as_u16(), 200);
    assert_eq!(full.bytes().await.unwrap().len() as u64, t.size_bytes);
    let part = http.get(&s.url).header("Range", "bytes=100-199").send().await.unwrap();
    assert_eq!(part.status().as_u16(), 206);
    assert_eq!(part.bytes().await.unwrap().len(), 100);
    let o: pb::StreamUrlResponse = call(&ctx, alice, "music.stream.url", pb::StreamUrlRequest { track_id: t.id.clone(), quality: 2 }).await.unwrap();
    let opus = http.get(&o.url).send().await.unwrap();
    eprintln!("opus: {} {:?}", opus.status(), opus.headers().get("content-type"));
    assert_eq!(opus.status().as_u16(), 200);
    let body = opus.bytes().await.unwrap();
    assert!(body.starts_with(b"OggS"), "перекодированный поток — Ogg, {} байт", body.len());

    // Отметки — свои у каждого
    let _: pb::StarSetResponse = call(&ctx, alice, "music.star.set", pb::StarSetRequest { track_id: t.id.clone(), starred: true }).await.unwrap();
    let mine: pb::StarListResponse = call(&ctx, alice, "music.star.list", pb::StarListRequest::default()).await.unwrap();
    assert!(mine.tracks.iter().any(|x| x.id == t.id && x.starred));
    let theirs: pb::StarListResponse = call(&ctx, bob, "music.star.list", pb::StarListRequest::default()).await.unwrap();
    assert!(theirs.tracks.is_empty());
    let got: pb::TrackGetResponse = call(&ctx, alice, "music.track.get", pb::TrackGetRequest { track_ids: vec![t.id.clone()] }).await.unwrap();
    assert!(got.tracks[0].starred);
    let _: pb::StarSetResponse = call(&ctx, alice, "music.star.set", pb::StarSetRequest { track_id: t.id.clone(), starred: false }).await.unwrap();

    // Обложка (у трека без картинки сервер отдаёт заглушку)
    let info: pb::InfoResponse = call(&ctx, alice, "music.info", pb::InfoRequest {}).await.unwrap();
    if !t.cover_id.is_empty() {
        let c = http.get(format!("{}{}?size=64", info.cover_base, t.cover_id)).send().await.unwrap();
        eprintln!("обложка: {} {:?}", c.status(), c.headers().get("content-type"));
        assert_eq!(c.status().as_u16(), 200);
    }
}

// ── «Найти и скачать» (этап B): поддельный сервис скачивания ────────────────────────────────────────────────

/// Поддельный сервис скачивания: каталог и кандидаты заданы тестом, «загрузка» пишет файл в папку библиотеки.
#[derive(Default)]
struct FakeFetch {
    catalog: Mutex<Vec<serde_json::Value>>,
    /// Источник → кандидаты; источника нет в таблице — он «отказал» (503).
    candidates: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    asked_sources: Mutex<Vec<String>>,
    library_dir: Mutex<std::path::PathBuf>,
}

async fn fake_fetch_serve(fake: Arc<FakeFetch>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    use http_body_util::BodyExt as _;
    let reply = |status: u16, body: serde_json::Value| Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string()))).unwrap();
    let path = req.uri().path().to_string();
    let q: HashMap<String, String> = req.uri().query().unwrap_or("").split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    match path.as_str() {
        "/health" => reply(200, json!({"ok": true})),
        "/catalog" => reply(200, json!({"tracks": fake.catalog.lock().unwrap().clone()})),
        "/candidates" => {
            let source = q.get("source").cloned().unwrap_or_default();
            fake.asked_sources.lock().unwrap().push(source.clone());
            match fake.candidates.lock().unwrap().get(&source) {
                Some(list) => reply(200, json!({"candidates": list})),
                None => reply(503, json!({})),
            }
        }
        "/download" => {
            let body = req.into_body().collect().await.unwrap().to_bytes();
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let rel = format!("{}.mp3", v["dest"].as_str().unwrap());
            let full = fake.library_dir.lock().unwrap().join(&rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(&full, vec![7u8; 4000]).unwrap();
            // «preview» в id — источник отдал отрывок
            let duration = if v["id"].as_str().unwrap_or("").contains("preview") { 30 } else { 215 };
            reply(200, json!({"path": rel, "bytes": 4000, "duration": duration}))
        }
        _ => reply(404, json!({})),
    }
}

/// Шард с поддельными музыкальным сервером и сервисом скачивания; лимит — `per_day` треков в сутки.
async fn setup_fetch(per_day: u32, quota: u64) -> (Arc<FakeFetch>, Arc<Ctx>, std::path::PathBuf) {
    let (_, base) = spawn_fake().await;
    let fake = Arc::new(FakeFetch::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let f = fake.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let f = f.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| {
                    let f = f.clone();
                    async move { Ok::<_, Infallible>(fake_fetch_serve(f, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), svc).await;
            });
        }
    });
    let mut salt = [0u8; 6];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut salt);
    let dir = std::env::temp_dir().join(format!("parvane-music-test-{}", salt.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::create_dir_all(dir.join("library")).unwrap();
    *fake.library_dir.lock().unwrap() = dir.join("library");
    let pool = crate::fetch::store::open(dir.join("music.db").to_str().unwrap()).await.unwrap();
    let service = crate::fetch::service::FetchService::new(&url).unwrap();
    let fetch = crate::fetch::jobs::Fetch::new(service, pool, Default::default(), dir.join("library"), per_day, quota, vec!["admin@local".into()]);
    let ctx = Arc::new(Ctx { sub: Some(Arc::new(Subsonic::new(&base).unwrap())), fetch: Some(Arc::new(fetch)), key: [9u8; 32], public_base: String::new() });
    (fake, ctx, dir)
}

fn catalog_track(title: &str) -> pb::CatalogTrack {
    pb::CatalogTrack { artist: "Группа".into(), title: title.into(), duration_secs: 215, ..Default::default() }
}

fn found(id: &str, title: &str, duration: u32) -> serde_json::Value {
    json!({"id": id, "title": title, "uploader": "Группа", "duration": duration, "uploaded": "2025-01-10", "bitrate": 128})
}

/// Дождаться конца задачи пользователя (не «ищем» и не «качаем»).
async fn settled(ctx: &Ctx, user: &str, job_id: &str) -> pb::FetchJob {
    for _ in 0..200 {
        let jobs = call::<pb::FetchStatusResponse>(ctx, user, "music.fetch.status", pb::FetchStatusRequest {}).await.unwrap().jobs;
        let job = jobs.into_iter().find(|j| j.job_id == job_id).expect("задача в списке");
        if !matches!(pb::FetchState::try_from(job.state), Ok(pb::FetchState::Searching | pb::FetchState::Downloading)) {
            return job;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("задача не закончилась");
}

async fn start(ctx: &Ctx, user: &str, title: &str) -> Result<pb::FetchJob, ErrorCode> {
    call::<pb::FetchStartResponse>(ctx, user, "music.fetch.start", pb::FetchStartRequest { track: Some(catalog_track(title)), ..Default::default() }).await.map(|r| r.job.unwrap())
}

#[tokio::test]
async fn fetch_catalog_marks_tracks_already_in_library() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    *fake.catalog.lock().unwrap() = vec![
        json!({"artist": "Группа", "title": "Песня t1", "album": "Альбом", "duration": 215, "explicit": true, "year": 2020}),
        json!({"artist": "Группа", "title": "Совсем другая", "duration": 200, "explicit": null}),
        json!({"artist": "", "title": "без исполнителя"}),
    ];
    let r: pb::FetchCatalogResponse = call(&ctx, "alice@local", "music.fetch.catalog", pb::FetchCatalogRequest { query: "песня".into(), limit: 0 }).await.unwrap();
    assert_eq!(r.tracks.len(), 2, "эталон без исполнителя отброшен");
    assert_eq!(r.tracks[0].library_track_id, "t1");
    assert_eq!(r.tracks[0].explicit, pb::Explicit::Yes as i32);
    assert_eq!(r.tracks[1].library_track_id, "");
    assert_eq!(r.tracks[1].explicit, pb::Explicit::Unspecified as i32);
    let empty = call::<pb::FetchCatalogResponse>(&ctx, "alice@local", "music.fetch.catalog", pb::FetchCatalogRequest { query: " ".into(), limit: 0 }).await;
    assert_eq!(empty.unwrap_err(), ErrorCode::Invalid);
    let info: pb::InfoResponse = call(&ctx, "alice@local", "music.info", pb::InfoRequest {}).await.unwrap();
    assert!(info.fetch_enabled && info.add_per_day == 30 && info.added_today == 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fetch_takes_confident_match_and_tracks_who_added_it() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    // Кавер отброшен сверкой, точное совпадение берётся само
    fake.candidates.lock().unwrap().insert("soundcloud".into(), vec![found("cover", "Группа - Песня t2 (cover)", 215), found("exact", "Группа - Песня t2", 215)]);
    let job = start(&ctx, "alice@local", "Песня t2").await.unwrap();
    assert_eq!(job.state, pb::FetchState::Searching as i32);
    let done = settled(&ctx, "alice@local", &job.job_id).await;
    assert_eq!(done.state, pb::FetchState::Done as i32, "{done:?}");
    assert_eq!(done.track_id, "t2");
    assert_eq!(fake.asked_sources.lock().unwrap()[..], ["soundcloud"], "русский трек: сначала SoundCloud; уверенное совпадение заканчивает поиск");
    let mine: pb::AddedListResponse = call(&ctx, "alice@local", "music.added.list", pb::AddedListRequest { mine: true, ..Default::default() }).await.unwrap();
    assert_eq!(mine.tracks.len(), 1);
    assert_eq!((mine.tracks[0].adder.as_str(), mine.tracks[0].bytes, mine.tracks[0].track.as_ref().unwrap().id.as_str()), ("alice", 4000, "t2"));
    // «Новое на сервере» видно всем, с тем, кто добавил
    let all: pb::AddedListResponse = call(&ctx, "bob@local", "music.added.list", pb::AddedListRequest::default()).await.unwrap();
    assert_eq!(all.tracks[0].adder, "alice");
    let info: pb::InfoResponse = call(&ctx, "alice@local", "music.info", pb::InfoRequest {}).await.unwrap();
    assert_eq!((info.added_today, info.used_bytes), (1, 4000));
    let files = |user: &str| std::fs::read_dir(dir.join("library").join(nd_user(user))).map(|d| d.count()).unwrap_or(0);
    assert_eq!(files("alice@local"), 1);
    // Чужой удалить не может, добавивший — может; файл стирается
    let del = |user: &'static str| call::<pb::AddedDeleteResponse>(&ctx, user, "music.added.delete", pb::AddedDeleteRequest { track_id: "t2".into() });
    assert_eq!(del("bob@local").await.unwrap_err(), ErrorCode::Forbidden);
    del("alice@local").await.unwrap();
    assert_eq!(files("alice@local"), 0);
    assert_eq!(del("alice@local").await.unwrap_err(), ErrorCode::NotFound);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fetch_asks_to_choose_reports_nothing_found_and_admin_can_delete() {
    let (fake, ctx, dir) = setup_fetch(30, u64::MAX).await;
    {
        let mut c = fake.candidates.lock().unwrap();
        c.insert("youtube".into(), vec![found("live", "Группа - Песня t3 (live)", 215)]);
        c.insert("soundcloud".into(), vec![]);
    }
    // Только другая версия: уверенности нет — список на выбор
    let job = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t3").await.unwrap().job_id).await;
    assert_eq!(job.state, pb::FetchState::NeedsChoice as i32, "{job:?}");
    assert_eq!(job.candidates.len(), 1);
    assert_eq!((job.candidates[0].id.as_str(), job.candidates[0].source.as_str(), job.candidates[0].uploaded.as_str()), ("live", "youtube", "2025-01-10"));
    assert!(job.candidates[0].score < 900);
    let pick = |candidate: &str| pb::FetchStartRequest { job_id: job.job_id.clone(), candidate_id: candidate.into(), ..Default::default() };
    assert_eq!(call::<pb::FetchStartResponse>(&ctx, "alice@local", "music.fetch.start", pick("чужой")).await.unwrap_err(), ErrorCode::NotFound);
    assert_eq!(call::<pb::FetchStartResponse>(&ctx, "bob@local", "music.fetch.start", pick("live")).await.unwrap_err(), ErrorCode::NotFound, "чужая задача");
    call::<pb::FetchStartResponse>(&ctx, "alice@local", "music.fetch.start", pick("live")).await.unwrap();
    assert_eq!(settled(&ctx, "alice@local", &job.job_id).await.state, pb::FetchState::Done as i32);
    // Администратор удаляет чужое добавление
    call::<pb::AddedDeleteResponse>(&ctx, "admin@local", "music.added.delete", pb::AddedDeleteRequest { track_id: "t3".into() }).await.unwrap();
    // Ничего подходящего: чужой исполнитель
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("other", "Другие - Песня t1", 215)]);
    let none = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t1").await.unwrap().job_id).await;
    assert_eq!((none.state, none.failure), (pb::FetchState::Failed as i32, pb::FetchFailure::NotFound as i32));
    // Источник отдал отрывок вместо трека: файл убран, задача не удалась
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("preview-1", "Группа - Песня t1", 215)]);
    let short = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t1").await.unwrap().job_id).await;
    assert_eq!((short.state, short.failure), (pb::FetchState::Failed as i32, pb::FetchFailure::Source as i32));
    assert_eq!(std::fs::read_dir(dir.join("library").join(nd_user("alice@local"))).unwrap().count(), 0, "отрывок и удалённый трек не остались на диске");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fetch_enforces_daily_limit_and_quota() {
    let (fake, ctx, dir) = setup_fetch(1, u64::MAX).await;
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("a", "Группа - Песня t1", 215), found("b", "Группа - Песня t2", 215)]);
    let first = start(&ctx, "alice@local", "Песня t1").await.unwrap();
    // Идущая задача уже расходует суточный лимит
    assert_eq!(start(&ctx, "alice@local", "Песня t2").await.unwrap_err(), ErrorCode::Limit);
    assert_eq!(settled(&ctx, "alice@local", &first.job_id).await.state, pb::FetchState::Done as i32);
    assert_eq!(start(&ctx, "alice@local", "Песня t2").await.unwrap_err(), ErrorCode::Limit);
    // У другого пользователя свой лимит
    assert!(start(&ctx, "bob@local", "Песня t2").await.is_ok());
    let _ = std::fs::remove_dir_all(dir);
    // Место: файл не помещается — убирается, задача не удалась
    let (fake, ctx, dir) = setup_fetch(30, 1000).await;
    fake.candidates.lock().unwrap().insert("youtube".into(), vec![found("a", "Группа - Песня t1", 215)]);
    let job = settled(&ctx, "alice@local", &start(&ctx, "alice@local", "Песня t1").await.unwrap().job_id).await;
    assert_eq!((job.state, job.failure), (pb::FetchState::Failed as i32, pb::FetchFailure::Limit as i32));
    // Без сервиса скачивания методы отвечают UNAVAILABLE
    let (_, plain, _) = setup().await;
    assert_eq!(start(&plain, "alice@local", "Песня t1").await.unwrap_err(), ErrorCode::Unavailable);
    let _ = std::fs::remove_dir_all(dir);
}
