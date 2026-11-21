//! «Музыка» против живого стека (spec 039 T7, spec 041): nats + identity + gateway + шард music с поддельным
//! Subsonic-сервером в самом тесте. Через gateway: `music.info`, общий плейлист двух пользователей (роли,
//! приглашение, ключ чата третьему), свой файл (ссылка на приём, PUT мимо gateway, задача в «Загрузках на
//! сервер», повтор того же файла), снятие законченной задачи. Без `nats-server` тест печатает SKIP.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode};
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use sha2::{Digest, Sha256};

mod v2common;
use v2common::{register_token, Conn};

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    gateway_tcp: String,
    music_http: String,
}

impl Drop for Stack {
    fn drop(&mut self) {
        for c in self.children.iter_mut().rev() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if !std::thread::panicking() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn find_nats_server() -> Option<PathBuf> {
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        let p = Path::new(dir).join("nats-server");
        if p.is_file() {
            return Some(p);
        }
    }
    let p = Path::new(&std::env::var("HOME").ok()?).join(".local/bin/nats-server");
    p.is_file().then_some(p)
}

fn target_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug")
}

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin)).envs(envs.iter().copied()).env("PARVANE_LOG_LEVEL", "info").stdout(Stdio::from(out)).stderr(Stdio::from(err)).spawn().unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

/// Поддельный Subsonic: одна песня «Песня t1» (её же «увидит» сканирование после загрузки своего файла).
fn fake_subsonic() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || serve_subsonic(stream));
        }
    });
    url
}

fn serve_subsonic(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
    }
    let path = line.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    let song = serde_json::json!({"id": "t1", "title": "Песня t1", "artist": "Группа", "album": "Альбом", "albumId": "al-1", "artistId": "ar-1", "duration": 215, "size": 1000, "contentType": "audio/mpeg"});
    let body = match path.as_str() {
        "/rest/search3" => serde_json::json!({"searchResult3": {"song": [song]}}),
        "/rest/getSong" => serde_json::json!({"song": song}),
        _ => serde_json::json!({}),
    };
    let mut r = body;
    r["status"] = "ok".into();
    r["version"] = "1.16.1".into();
    let text = serde_json::json!({"subsonic-response": r}).to_string();
    let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
}

async fn start() -> Option<Stack> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO")).args(["build", "-p", "identity", "-p", "gateway", "-p", "music"]).current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).status().unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2music-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(dir.join("library")).unwrap();
    let nats_port = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let gateway_tcp = format!("127.0.0.1:{}", free_port());
    let gateway_ws = format!("127.0.0.1:{}", free_port());
    let music_http = format!("127.0.0.1:{}", free_port());
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let mut children = vec![Command::new(nats_bin).args(["-a", "127.0.0.1", "-p", &nats_port.to_string()]).stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log)).spawn().unwrap()];
    let s = |p: PathBuf| p.to_string_lossy().to_string();
    let (id_db, wk) = (s(dir.join("identity.db")), s(dir.join("parvane.json")));
    children.push(spawn("identity", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &id_db), ("PARVANE_DEV", "1"), ("PARVANE_WELL_KNOWN_FILE", &wk)], &dir.join("identity.log")));
    let (navidrome, public) = (fake_subsonic(), format!("http://{music_http}"));
    let (m_db, lib, key) = (s(dir.join("music.db")), s(dir.join("library")), s(dir.join("music-url.key")));
    children.push(spawn(
        "music",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_DB_PATH", &m_db),
            ("PARVANE_MUSIC_NAVIDROME_URL", &navidrome),
            ("PARVANE_MUSIC_PUBLIC_BASE", &public),
            ("PARVANE_MUSIC_HTTP_BIND", &music_http),
            ("PARVANE_MUSIC_LIBRARY_DIR", &lib),
            ("PARVANE_MUSIC_URL_KEY_FILE", &key),
        ],
        &dir.join("music.log"),
    ));
    children.push(spawn("gateway", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws)], &dir.join("gateway.log")));
    let stack = Stack { children, dir, gateway_tcp, music_http };
    let startt = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(startt.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    for (subject, name) in [("v2.server.describe", "identity"), ("v2.music.info", "music")] {
        loop {
            let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject, vec![].into())).await;
            if matches!(r, Ok(Ok(_))) {
                break;
            }
            assert!(startt.elapsed() < Duration::from_secs(60), "{name} не поднялся");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() || TcpStream::connect(&stack.music_http).is_err() {
        assert!(startt.elapsed() < Duration::from_secs(60), "gateway/music не слушают");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some(stack)
}

fn session(addr: &str, user: &str) -> Conn {
    let token = register_token(addr, user, "d1");
    let (mut c, _) = Conn::connect(addr, Channel::Identified);
    c.send(frame::Kind::Auth(Auth { token }));
    assert!(matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth {user}");
    c
}

fn call<R: Message + Default>(c: &mut Conn, method: &str, body: impl Message) -> Result<R, ErrorCode> {
    c.call(method, body.encode_to_vec()).map(|b| R::decode(b.as_slice()).unwrap())
}

/// PUT тела на ссылку шарда (мимо gateway) → код HTTP.
fn put(url: &str, data: &[u8]) -> u16 {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut s = TcpStream::connect(host).unwrap();
    write!(s, "PUT /{path} HTTP/1.1\r\nhost: {host}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", data.len()).unwrap();
    s.write_all(data).unwrap();
    let mut resp = String::new();
    let _ = s.read_to_string(&mut resp);
    resp.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

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
    out.extend(std::iter::repeat_n(0x55u8, 4000));
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_music_shared_playlist_and_own_file_live() {
    let Some(stack) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let n = free_port();
    let (alice, bob, carol) = (format!("malice{n}@local"), format!("mbob{n}@local"), format!("mcarol{n}@local"));
    let result = tokio::task::spawn_blocking(move || {
        let (mut a, mut b, mut c) = (session(&addr, &alice), session(&addr, &bob), session(&addr, &carol));
        let info: pb::InfoResponse = call(&mut a, "music.info", pb::InfoRequest {}).unwrap();
        assert!(info.enabled && info.upload_enabled && !info.fetch_enabled, "{info:?}");

        // Общий плейлист: alice зовёт bob «добавляет», bob добавляет трек, carol вступает ключом из чата
        let item = |t: &str| pb::SharedItemAdd { track_id: t.into(), title: format!("Песня {t}"), artist: "Группа".into(), duration_secs: 215, ..Default::default() };
        let pl = call::<pb::SharedCreateResponse>(&mut a, "music.shared.create", pb::SharedCreateRequest { name: "Linux-чат: общее".into(), access: pb::SharedAccess::Members as i32, items: vec![item("t1")] }).unwrap().playlist.unwrap();
        let id = pl.id.clone();
        assert_eq!(call::<pb::SharedGetResponse>(&mut b, "music.shared.get", pb::SharedGetRequest { playlist_id: id.clone(), if_version: 0 }).unwrap_err(), ErrorCode::NotFound);
        call::<pb::SharedMemberResponse>(&mut a, "music.shared.member", pb::SharedMemberRequest { playlist_id: id.clone(), address: bob.clone(), role: pb::SharedRole::Editor as i32, remove: false }).unwrap();
        let listed: pb::SharedListResponse = call(&mut b, "music.shared.list", pb::SharedListRequest::default()).unwrap();
        assert!(listed.playlists.iter().any(|p| p.id == id && p.invited));
        let r: pb::SharedItemsResponse = call(&mut b, "music.shared.items", pb::SharedItemsRequest { playlist_id: id.clone(), add: vec![item("t2"), item("t1")], ..Default::default() }).unwrap();
        assert_eq!((r.skipped, r.playlist.unwrap().track_count), (1, 2));
        let key = call::<pb::SharedEditResponse>(&mut a, "music.shared.edit", pb::SharedEditRequest { playlist_id: id.clone(), issue_join_key: true, ..Default::default() }).unwrap().playlist.unwrap().join_key;
        assert_eq!(call::<pb::SharedJoinResponse>(&mut c, "music.shared.join", pb::SharedJoinRequest { playlist_id: id.clone(), join_key: key }).unwrap().playlist.unwrap().member_count, 3);
        let full: pb::SharedGetResponse = call(&mut c, "music.shared.get", pb::SharedGetRequest { playlist_id: id.clone(), if_version: 0 }).unwrap();
        assert_eq!(full.items.iter().map(|i| (i.track_id.as_str(), i.adder.as_str())).collect::<Vec<_>>(), vec![("t1", alice.as_str()), ("t2", bob.as_str())]);
        assert_eq!(call::<pb::SharedDeleteResponse>(&mut c, "music.shared.delete", pb::SharedDeleteRequest { playlist_id: id.clone() }).unwrap_err(), ErrorCode::Forbidden);

        // Свой файл: ссылка на приём, байты мимо gateway, задача доходит до «готово» с треком библиотеки
        let file = mp3("Песня t1", "Группа");
        let sha: String = Sha256::digest(&file).iter().map(|x| format!("{x:02x}")).collect();
        let up: pb::UploadStartResponse = call(&mut b, "music.upload.start", pb::UploadStartRequest { file_name: "берег.mp3".into(), bytes: file.len() as u64, sha256: sha.clone(), ..Default::default() }).unwrap();
        assert_eq!(put(&up.url, &file), 200);
        let job_id = up.job.unwrap().job_id;
        let t0 = Instant::now();
        let done = loop {
            let jobs = call::<pb::FetchStatusResponse>(&mut b, "music.fetch.status", pb::FetchStatusRequest {}).unwrap().jobs;
            let j = jobs.into_iter().find(|j| j.job_id == job_id).expect("задача свого файла в списке");
            if j.state != pb::FetchState::Downloading as i32 {
                break j;
            }
            assert!(t0.elapsed() < Duration::from_secs(40), "свой файл не дошёл до библиотеки");
            std::thread::sleep(Duration::from_millis(300));
        };
        assert_eq!((done.state, done.track_id.as_str(), done.upload_name.as_str()), (pb::FetchState::Done as i32, "t1", "берег.mp3"), "{done:?}");
        // Тот же файл другим пользователем — «уже есть»
        let again: pb::UploadStartResponse = call(&mut c, "music.upload.start", pb::UploadStartRequest { file_name: "копия.mp3".into(), bytes: file.len() as u64, sha256: sha, ..Default::default() }).unwrap();
        assert_eq!(again.job.unwrap().failure, pb::FetchFailure::Duplicate as i32);
        // Законченную задачу можно убрать из списка
        call::<pb::FetchCancelResponse>(&mut b, "music.fetch.cancel", pb::FetchCancelRequest { job_id: job_id.clone() }).unwrap();
        assert!(call::<pb::FetchStatusResponse>(&mut b, "music.fetch.status", pb::FetchStatusRequest {}).unwrap().jobs.is_empty());
    })
    .await;
    if result.is_err() {
        eprintln!("журналы стека: {}", stack.dir.display());
        std::mem::forget(stack.dir.clone());
    }
    result.unwrap();
}
