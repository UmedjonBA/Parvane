//! spec 041: очередь, ход и отмена «Найти и скачать», задача по строке запроса, причина отказа сервиса, свои файлы
//! (приём по ссылке, сверка SHA-256, теги шардом, повтор), общие плейлисты (права, приглашение, ключ чата).

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response};
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::subsonic::Subsonic;
use crate::tests::{call, setup, spawn_fake};
use crate::{http, Ctx};

/// Поддельный сервис скачивания: «slow-*» качается 3 с по частям и сообщает ход, «refuse-*» — отказ с причиной.
#[derive(Default)]
struct Service {
    library: Mutex<std::path::PathBuf>,
    progress: Mutex<HashMap<String, (u64, u64)>>,
    cancelled: Mutex<Vec<String>>,
}

async fn serve_service(s: Arc<Service>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    use http_body_util::BodyExt as _;
    let reply = |status: u16, body: serde_json::Value| Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string()))).unwrap();
    let q: HashMap<String, String> = req.uri().query().unwrap_or("").split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    match req.uri().path() {
        "/health" => reply(200, json!({})),
        "/catalog" => reply(
            200,
            json!({"tracks": [
                {"artist": "Группа", "title": "Песня t3 (Remix)", "duration": 215},
                {"artist": "Группа", "title": "Песня t3", "duration": 215},
            ]}),
        ),
        "/candidates" => {
            let title = urlish(q.get("title").map(String::as_str).unwrap_or(""));
            let id = if title.contains("t8") { "slow-1" } else if title.contains("t9") { "refuse-1" } else { "fast-1" };
            reply(200, json!({"candidates": [{"id": id, "title": format!("Группа - {title}"), "uploader": "Группа", "duration": 215}]}))
        }
        "/progress" => {
            let dest = urlish(q.get("dest").map(String::as_str).unwrap_or(""));
            match s.progress.lock().unwrap().get(&dest) {
                Some((done, total)) => reply(200, json!({"bytes_done": done, "bytes_total": total})),
                None => reply(404, json!({})),
            }
        }
        "/cancel" => {
            let body = req.into_body().collect().await.unwrap().to_bytes();
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            s.cancelled.lock().unwrap().push(v["dest"].as_str().unwrap_or("").to_string());
            reply(200, json!({}))
        }
        "/download" => {
            let body = req.into_body().collect().await.unwrap().to_bytes();
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let (id, dest) = (v["id"].as_str().unwrap().to_string(), v["dest"].as_str().unwrap().to_string());
            if id.starts_with("refuse") {
                return reply(500, json!({"reason": "источник закрыт администратором"}));
            }
            let rel = format!("{dest}.mp3");
            let full = s.library.lock().unwrap().join(&rel);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            if id.starts_with("slow") {
                for step in 1..=6u64 {
                    s.progress.lock().unwrap().insert(dest.clone(), (step * 1000, 6000));
                    std::fs::write(format!("{}.part", full.display()), vec![1u8; (step * 1000) as usize]).unwrap();
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                let _ = std::fs::remove_file(format!("{}.part", full.display()));
            }
            std::fs::write(&full, vec![7u8; 6000]).unwrap();
            reply(200, json!({"path": rel, "bytes": 6000, "duration": 215}))
        }
        _ => reply(404, json!({})),
    }
}

/// Значения запроса у поддельного сервиса приходят закодированными — нам хватит пробелов и кириллицы.
fn urlish(s: &str) -> String {
    let bytes = s.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn listen<F, Fut>(handler: F) -> String
where
    F: Fn(Request<Incoming>) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response<Full<Bytes>>> + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let h = handler.clone();
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req| {
                    let h = h.clone();
                    async move { Ok::<_, Infallible>(h(req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), svc).await;
            });
        }
    });
    url
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let mut salt = [0u8; 6];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut salt);
    let dir = std::env::temp_dir().join(format!("parvane-music-{tag}-{}", salt.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::create_dir_all(dir.join("library")).unwrap();
    dir
}

/// Шард с поддельными библиотекой и (необязательно) сервисом; `parallel` задач разом; HTTP-ссылки — настоящие.
async fn stack(with_service: bool, parallel: usize) -> (Arc<Service>, Arc<Ctx>, std::path::PathBuf, String) {
    let (_, base) = spawn_fake().await;
    let dir = temp_dir("s041");
    let svc = Arc::new(Service::default());
    *svc.library.lock().unwrap() = dir.join("library");
    let service = if with_service {
        let s = svc.clone();
        let url = listen(move |req| serve_service(s.clone(), req)).await;
        crate::fetch::service::FetchService::new(&url)
    } else {
        None
    };
    let pool = crate::fetch::store::open(dir.join("music.db").to_str().unwrap()).await.unwrap();
    let fetch = crate::fetch::jobs::Fetch::new(service, pool, Default::default(), dir.join("library"), 30, u64::MAX, 1_000_000, vec![], parallel);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public = format!("http://{}", listener.local_addr().unwrap());
    let ctx = Arc::new(Ctx { sub: Some(Arc::new(Subsonic::new(&base).unwrap())), fetch: Some(Arc::new(fetch)), key: [5u8; 32], public_base: public.clone() });
    tokio::spawn(http::serve_listener(ctx.clone(), listener));
    (svc, ctx, dir, public)
}

async fn jobs(ctx: &Ctx, user: &str) -> Vec<pb::FetchJob> {
    call::<pb::FetchStatusResponse>(ctx, user, "music.fetch.status", pb::FetchStatusRequest {}).await.unwrap().jobs
}

async fn wait_job(ctx: &Ctx, user: &str, id: &str, done: impl Fn(&pb::FetchJob) -> bool) -> pb::FetchJob {
    for _ in 0..300 {
        if let Some(j) = jobs(ctx, user).await.into_iter().find(|j| j.job_id == id) {
            if done(&j) {
                return j;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("задача {id} не дошла до нужного состояния: {:?}", jobs(ctx, user).await);
}

fn finished(j: &pb::FetchJob) -> bool {
    matches!(pb::FetchState::try_from(j.state), Ok(pb::FetchState::Done | pb::FetchState::Failed | pb::FetchState::NeedsChoice))
}

async fn start_title(ctx: &Ctx, user: &str, title: &str) -> pb::FetchJob {
    let track = pb::CatalogTrack { artist: "Группа".into(), title: title.into(), duration_secs: 215, ..Default::default() };
    call::<pb::FetchStartResponse>(ctx, user, "music.fetch.start", pb::FetchStartRequest { track: Some(track), ..Default::default() }).await.unwrap().job.unwrap()
}

#[tokio::test]
async fn fetch_queue_progress_and_cancel() {
    let (svc, ctx, dir, _) = stack(true, 1).await;
    let alice = "alice@local";
    let slow = start_title(&ctx, alice, "Песня t8").await;
    let second = start_title(&ctx, alice, "Песня t1").await;
    // Пока первая качается, вторая ждёт в очереди сервера первой
    let queued = wait_job(&ctx, alice, &second.job_id, |j| j.state == pb::FetchState::Queued as i32).await;
    assert_eq!(queued.queue_ahead, 0);
    let going = wait_job(&ctx, alice, &slow.job_id, |j| j.state == pb::FetchState::Downloading as i32 && j.bytes_done > 0).await;
    assert_eq!(going.bytes_total, 6000, "ход — по словам сервиса");
    // Чужую задачу не снять
    assert_eq!(call::<pb::FetchCancelResponse>(&ctx, "bob@local", "music.fetch.cancel", pb::FetchCancelRequest { job_id: slow.job_id.clone() }).await.unwrap_err(), ErrorCode::NotFound);
    call::<pb::FetchCancelResponse>(&ctx, alice, "music.fetch.cancel", pb::FetchCancelRequest { job_id: slow.job_id.clone() }).await.unwrap();
    assert!(jobs(&ctx, alice).await.iter().all(|j| j.job_id != slow.job_id), "снятая задача убрана из списка");
    assert_eq!(svc.cancelled.lock().unwrap().len(), 1, "сервис попросили остановиться");
    // Место освободилось — вторая пошла и закончилась
    let done = wait_job(&ctx, alice, &second.job_id, finished).await;
    assert_eq!((done.state, done.track_id.as_str()), (pb::FetchState::Done as i32, "t1"), "{done:?}");
    // Законченную можно убрать из списка («Убрать»)
    call::<pb::FetchCancelResponse>(&ctx, alice, "music.fetch.cancel", pb::FetchCancelRequest { job_id: second.job_id.clone() }).await.unwrap();
    assert!(jobs(&ctx, alice).await.is_empty());
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let mine = call::<pb::AddedListResponse>(&ctx, alice, "music.added.list", pb::AddedListRequest { mine: true, ..Default::default() }).await.unwrap();
    assert!(mine.tracks.iter().all(|t| t.track.as_ref().unwrap().title != "Песня t8"), "снятая не учтена как добавленная");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn fetch_by_query_takes_reference_itself_and_reports_service_reason() {
    let (_, ctx, dir, _) = stack(true, 2).await;
    let alice = "alice@local";
    // Эталон по строке: ремикс без слова «ремикс» не берётся; трек уже в библиотеке — задача сразу готова
    let job = call::<pb::FetchStartResponse>(&ctx, alice, "music.fetch.start", pb::FetchStartRequest { query: "группа песня t3".into(), ..Default::default() }).await.unwrap().job.unwrap();
    assert_eq!(job.query, "группа песня t3");
    let done = wait_job(&ctx, alice, &job.job_id, finished).await;
    assert_eq!((done.state, done.track_id.as_str()), (pb::FetchState::Done as i32, "t3"));
    assert_eq!(done.track.unwrap().title, "Песня t3");
    // Повтор той же строки, пока идёт, — DUPLICATE; пустой запрос — INVALID
    assert_eq!(call::<pb::FetchStartResponse>(&ctx, alice, "music.fetch.start", pb::FetchStartRequest::default()).await.unwrap_err(), ErrorCode::Invalid);
    // Сервис отказал с причиной — она в задаче
    let refused = start_title(&ctx, alice, "Песня t9").await;
    let failed = wait_job(&ctx, alice, &refused.job_id, finished).await;
    assert_eq!((failed.failure, failed.failure_detail.as_str()), (pb::FetchFailure::Source as i32, "источник закрыт администратором"));
    let _ = std::fs::remove_dir_all(dir);
}

/// MP3 с тегами ID3v2.3: название и исполнитель.
fn mp3(title: &str, artist: &str) -> Vec<u8> {
    let frame = |id: &[u8], text: &str| {
        let mut body = vec![3u8];
        body.extend_from_slice(text.as_bytes());
        let mut f = id.to_vec();
        f.extend_from_slice(&(body.len() as u32).to_be_bytes());
        f.extend_from_slice(&[0, 0]);
        f.extend_from_slice(&body);
        f
    };
    let frames = [frame(b"TIT2", title), frame(b"TPE1", artist)].concat();
    let n = frames.len();
    let mut out = b"ID3\x03\x00\x00".to_vec();
    out.extend_from_slice(&[(n >> 21) as u8 & 0x7F, (n >> 14) as u8 & 0x7F, (n >> 7) as u8 & 0x7F, n as u8 & 0x7F]);
    out.extend_from_slice(&frames);
    out.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
    out.extend(std::iter::repeat_n(0x55u8, 3000));
    out
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

async fn upload_start(ctx: &Ctx, user: &str, name: &str, data: &[u8], hash: &str) -> Result<pb::UploadStartResponse, ErrorCode> {
    call(ctx, user, "music.upload.start", pb::UploadStartRequest { file_name: name.into(), bytes: data.len() as u64, sha256: hash.into(), ..Default::default() }).await
}

#[tokio::test]
async fn own_files_are_checked_tagged_and_deduplicated() {
    let (_, ctx, dir, public) = stack(false, 1).await;
    let http = reqwest::Client::new();
    let alice = "alice@local";
    let info: pb::InfoResponse = call(&ctx, alice, "music.info", pb::InfoRequest {}).await.unwrap();
    assert!(info.upload_enabled && !info.fetch_enabled && info.upload_max_bytes == 1_000_000, "{info:?}");
    // Без сервиса скачивания «Найти и скачать» недоступно, а свои файлы — да
    assert_eq!(call::<pb::FetchCatalogResponse>(&ctx, alice, "music.fetch.catalog", pb::FetchCatalogRequest { query: "x".into(), limit: 0 }).await.unwrap_err(), ErrorCode::Unavailable);

    let file = mp3("Песня t2", "Группа");
    let started = upload_start(&ctx, alice, "мой трек.mp3", &file, &sha(&file)).await.unwrap();
    assert!(started.url.starts_with(&format!("{public}/_parvane/music/u/")));
    let job = started.job.unwrap();
    assert_eq!((job.state, job.upload_name.as_str(), job.bytes_total), (pb::FetchState::Downloading as i32, "мой трек.mp3", file.len() as u64));
    assert_eq!(http.put(&started.url).body(file.clone()).send().await.unwrap().status().as_u16(), 200);
    // Ссылка — на один приём
    assert_eq!(http.put(&started.url).body(file.clone()).send().await.unwrap().status().as_u16(), 409);
    let done = wait_job(&ctx, alice, &job.job_id, finished).await;
    assert_eq!((done.state, done.track_id.as_str(), done.bytes_done), (pb::FetchState::Done as i32, "t2", file.len() as u64), "{done:?}");
    assert_eq!(done.track.unwrap().title, "Песня t2", "теги перечитал шард");
    let stored: Vec<_> = walk(&dir.join("library"));
    assert!(stored.iter().any(|p| p.contains("/uploads/Группа - Песня t2 [") && p.ends_with(".mp3")), "{stored:?}");
    assert!(!stored.iter().any(|p| p.contains(".parvane-upload/") && p.ends_with(".part")), "временного не осталось");
    // Тот же файл ещё раз — сразу «уже есть» с треком
    let again = upload_start(&ctx, "bob@local", "копия.mp3", &file, &sha(&file)).await.unwrap();
    let dup = again.job.unwrap();
    assert!(again.url.is_empty());
    assert_eq!((dup.state, dup.failure, dup.track_id.as_str()), (pb::FetchState::Failed as i32, pb::FetchFailure::Duplicate as i32, "t2"));
    // Подмена байтов: SHA-256 не сошлась — отказ, файла нет
    let other = mp3("Песня t1", "Группа");
    let bad = upload_start(&ctx, alice, "b.mp3", &other, &sha(&file).replace('a', "b")).await.unwrap();
    assert_eq!(http.put(&bad.url).body(other.clone()).send().await.unwrap().status().as_u16(), 400);
    let failed = wait_job(&ctx, alice, &bad.job.unwrap().job_id, finished).await;
    assert_eq!(failed.failure, pb::FetchFailure::Source as i32);
    // Не звук — FORMAT; не то расширение и сверх предела — отказ сразу
    let pdf = b"%PDF-1.7 not audio".repeat(10);
    let p = upload_start(&ctx, alice, "doc.mp3", &pdf, &sha(&pdf)).await.unwrap();
    assert_eq!(http.put(&p.url).body(pdf.clone()).send().await.unwrap().status().as_u16(), 415);
    assert_eq!(wait_job(&ctx, alice, &p.job.unwrap().job_id, finished).await.failure, pb::FetchFailure::Format as i32);
    assert_eq!(upload_start(&ctx, alice, "doc.pdf", &pdf, &sha(&pdf)).await.unwrap_err(), ErrorCode::Invalid);
    let big = vec![0u8; 1_000_001];
    assert_eq!(upload_start(&ctx, alice, "big.mp3", &big, &sha(&big)).await.unwrap_err(), ErrorCode::Limit);
    // Чужой жетон — 403
    assert_eq!(http.put(format!("{public}/_parvane/music/u/нет")).body("x").send().await.unwrap().status().as_u16(), 403);
    let mine = call::<pb::AddedListResponse>(&ctx, alice, "music.added.list", pb::AddedListRequest { mine: true, ..Default::default() }).await.unwrap();
    assert_eq!(mine.tracks.len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

fn walk(dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p.display().to_string());
        }
    }
    out
}

async fn shared_ctx() -> Arc<Ctx> {
    let (_, ctx, _) = setup().await;
    let dir = temp_dir("shared");
    crate::shared::open(dir.join("music.db").to_str().unwrap()).await;
    ctx
}

fn add(track: &str) -> pb::SharedItemAdd {
    pb::SharedItemAdd { track_id: track.into(), title: format!("Песня {track}"), artist: "Группа".into(), duration_secs: 215, ..Default::default() }
}

#[tokio::test]
async fn shared_playlist_roles_invites_and_chat_key() {
    let ctx = shared_ctx().await;
    let (alice, bob, carol, dave) = ("alice41@local", "bob41@local", "carol41@local", "dave41@local");
    let created: pb::SharedCreateResponse =
        call(&ctx, alice, "music.shared.create", pb::SharedCreateRequest { name: " Дорога ".into(), access: pb::SharedAccess::Members as i32, items: vec![add("t1"), add("t2"), add("t1")] }).await.unwrap();
    let pl = created.playlist.unwrap();
    assert_eq!((pl.name.as_str(), pl.track_count, pl.member_count, pl.my_role), ("Дорога", 2, 1, pb::SharedRole::Owner as i32), "повтор трека пропущен");
    let id = pl.id.clone();
    let get = |user: &'static str, if_version: u64| call::<pb::SharedGetResponse>(&ctx, user, "music.shared.get", pb::SharedGetRequest { playlist_id: id.clone(), if_version });
    // Не участнику частный плейлист не виден
    assert_eq!(get(bob, 0).await.unwrap_err(), ErrorCode::NotFound);
    // Позвать «слушает»: в списке с отметкой «позван», первое чтение её снимает
    let invite = |user: &str, role: pb::SharedRole| pb::SharedMemberRequest { playlist_id: id.clone(), address: user.into(), role: role as i32, remove: false };
    call::<pb::SharedMemberResponse>(&ctx, alice, "music.shared.member", invite(bob, pb::SharedRole::Listener)).await.unwrap();
    assert_eq!(call::<pb::SharedMemberResponse>(&ctx, alice, "music.shared.member", invite("eve@other.example", pb::SharedRole::Editor)).await.unwrap_err(), ErrorCode::Invalid, "только свой сервер");
    let listed: pb::SharedListResponse = call(&ctx, bob, "music.shared.list", pb::SharedListRequest::default()).await.unwrap();
    assert_eq!(listed.playlists.iter().map(|p| (p.id.as_str(), p.invited, p.my_role)).collect::<Vec<_>>(), vec![(id.as_str(), true, pb::SharedRole::Listener as i32)]);
    let seen = get(bob, 0).await.unwrap();
    let members: Vec<_> = seen.members.iter().map(|m| (m.address.as_str(), m.role, m.invited, m.added_count)).collect();
    assert_eq!(members, vec![(alice, pb::SharedRole::Owner as i32, false, 2), (bob, pb::SharedRole::Listener as i32, false, 0)]);
    assert!(seen.playlist.as_ref().unwrap().join_key.is_empty(), "ключ вступления — только владельцу");
    let version = seen.playlist.unwrap().version;
    assert!(get(bob, version).await.unwrap().unchanged);
    // «Слушает» треки не правит; стал «добавляет» — правит
    let edit_items = |user: &'static str, r: pb::SharedItemsRequest| call::<pb::SharedItemsResponse>(&ctx, user, "music.shared.items", r);
    let adding = |tracks: &[&str]| pb::SharedItemsRequest { playlist_id: id.clone(), add: tracks.iter().map(|t| add(t)).collect(), ..Default::default() };
    assert_eq!(edit_items(bob, adding(&["t3"])).await.unwrap_err(), ErrorCode::Forbidden);
    call::<pb::SharedMemberResponse>(&ctx, alice, "music.shared.member", invite(bob, pb::SharedRole::Editor)).await.unwrap();
    let r = edit_items(bob, adding(&["t3", "t2"])).await.unwrap();
    assert_eq!((r.skipped, r.playlist.unwrap().track_count), (1, 3));
    // Переставить последний первым; убрать второй
    let items = get(bob, 0).await.unwrap().items;
    assert_eq!(items.iter().map(|i| (i.track_id.as_str(), i.adder.as_str())).collect::<Vec<_>>(), vec![("t1", alice), ("t2", alice), ("t3", bob)]);
    edit_items(bob, pb::SharedItemsRequest { playlist_id: id.clone(), move_id: items[2].id.clone(), move_before_id: items[0].id.clone(), ..Default::default() }).await.unwrap();
    edit_items(alice, pb::SharedItemsRequest { playlist_id: id.clone(), remove: vec![items[1].id.clone()], ..Default::default() }).await.unwrap();
    assert_eq!(get(alice, 0).await.unwrap().items.iter().map(|i| i.track_id.as_str()).collect::<Vec<_>>(), vec!["t3", "t1"]);
    // Название и доступ — только владелец
    let rename = |user: &'static str| call::<pb::SharedEditResponse>(&ctx, user, "music.shared.edit", pb::SharedEditRequest { playlist_id: id.clone(), name: "Своё".into(), ..Default::default() });
    assert_eq!(rename(bob).await.unwrap_err(), ErrorCode::Forbidden);
    rename(alice).await.unwrap();
    // Плейлист чата: без ключа не вступить; владелец выдаёт ключ — вступивший «добавляет»
    let join = |user: &'static str, key: String| call::<pb::SharedJoinResponse>(&ctx, user, "music.shared.join", pb::SharedJoinRequest { playlist_id: id.clone(), join_key: key });
    assert_eq!(join(carol, "0".repeat(32)).await.unwrap_err(), ErrorCode::NotFound);
    let key = call::<pb::SharedEditResponse>(&ctx, alice, "music.shared.edit", pb::SharedEditRequest { playlist_id: id.clone(), issue_join_key: true, ..Default::default() }).await.unwrap().playlist.unwrap().join_key;
    assert_eq!(key.len(), 32);
    assert_eq!(join(carol, key.clone()).await.unwrap().playlist.unwrap().my_role, pb::SharedRole::Editor as i32);
    // Смена ключа: прежняя карточка больше не впускает
    call::<pb::SharedEditResponse>(&ctx, alice, "music.shared.edit", pb::SharedEditRequest { playlist_id: id.clone(), rotate_join_key: true, ..Default::default() }).await.unwrap();
    assert_eq!(join(dave, key).await.unwrap_err(), ErrorCode::NotFound);
    // Выход участника; владелец выйти не может
    call::<pb::SharedLeaveResponse>(&ctx, carol, "music.shared.leave", pb::SharedLeaveRequest { playlist_id: id.clone() }).await.unwrap();
    assert_eq!(call::<pb::SharedLeaveResponse>(&ctx, alice, "music.shared.leave", pb::SharedLeaveRequest { playlist_id: id.clone() }).await.unwrap_err(), ErrorCode::Forbidden);
    // «Все на сервере»: не участник видит в общем списке и слушает, но не правит
    call::<pb::SharedEditResponse>(&ctx, alice, "music.shared.edit", pb::SharedEditRequest { playlist_id: id.clone(), access: pb::SharedAccess::Server as i32, ..Default::default() }).await.unwrap();
    let open: pb::SharedListResponse = call(&ctx, dave, "music.shared.list", pb::SharedListRequest { server_wide: true }).await.unwrap();
    assert!(open.playlists.iter().any(|p| p.id == id && p.my_role == pb::SharedRole::Unspecified as i32));
    assert_eq!(get(dave, 0).await.unwrap().items.len(), 2);
    assert_eq!(edit_items(dave, adding(&["t1"])).await.unwrap_err(), ErrorCode::Forbidden);
    // Убрать участника, удалить плейлист
    call::<pb::SharedMemberResponse>(&ctx, alice, "music.shared.member", pb::SharedMemberRequest { playlist_id: id.clone(), address: bob.into(), remove: true, ..Default::default() }).await.unwrap();
    assert_eq!(edit_items(bob, adding(&["t1"])).await.unwrap_err(), ErrorCode::Forbidden);
    assert_eq!(call::<pb::SharedDeleteResponse>(&ctx, bob, "music.shared.delete", pb::SharedDeleteRequest { playlist_id: id.clone() }).await.unwrap_err(), ErrorCode::Forbidden);
    call::<pb::SharedDeleteResponse>(&ctx, alice, "music.shared.delete", pb::SharedDeleteRequest { playlist_id: id.clone() }).await.unwrap();
    assert_eq!(get(alice, 0).await.unwrap_err(), ErrorCode::NotFound);
}
