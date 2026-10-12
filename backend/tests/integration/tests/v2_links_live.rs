//! Ссылки облака для людей без аккаунта против живого стека (spec 022):
//! владелец в ID-канале собирает ссылку (`cloud.link.create/add/publish`),
//! человек без аккаунта через анонимный канал получает список и файл
//! (`cloud.link.get`, `cloud.link.download`), после отзыва — ничего;
//! - анонимному каналу закрыты ID-методы ссылок, ID-сессии — анонимные;
//! - копия ссылки не читается ни по секрету, ни обычным скачиванием владельца;
//! - в шину анонимные запросы уходят без личности и IP;
//! - в базах и журнале шарда нет ни названий из списка, ни ключа ссылки, а в
//!   журнале — и самого идентификатора ссылки.
//!
//! Стек: nats + identity + cloud + gateway. Без `nats-server` тест печатает
//! SKIP и проходит.

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::cloud::v1 as clpb;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode, ShardRequest};
use prost::Message;
use sha2::{Digest, Sha256};

mod v2common;
use v2common::{register_token, Conn};

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    gateway_tcp: String,
}

impl Stack {
    fn stop(&mut self) {
        for c in self.children.iter_mut().rev() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.children.clear();
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        self.stop();
        // Журналы стека нужны для разбора падения — при панике каталог остаётся
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

/// Каталог бинарников шардов: общий каталог сборки, если он задан окружением.
fn target_dir() -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => PathBuf::from(dir).join("debug"),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug"),
    }
}

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin))
        .envs(envs.iter().copied())
        .env("PARVANE_LOG_LEVEL", "debug")
        .env("NO_COLOR", "1")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

fn wait_log(path: &Path, needle: &str, start: Instant) {
    loop {
        if std::fs::read_to_string(path).unwrap_or_default().contains(needle) {
            return;
        }
        assert!(start.elapsed() < Duration::from_secs(120), "{} не дождался «{needle}»", path.display());
        std::thread::sleep(Duration::from_millis(100));
    }
}

async fn start() -> Option<(Stack, async_nats::Client)> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "gateway", "-p", "cloud"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2links-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_port = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let gateway_tcp = format!("127.0.0.1:{}", free_port());
    let gateway_ws = format!("127.0.0.1:{}", free_port());
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let mut children = vec![Command::new(nats_bin)
        .args(["-a", "127.0.0.1", "-p", &nats_port.to_string()])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap()];
    let db = |n: &str| dir.join(n).to_string_lossy().to_string();
    let (id_db, wk, cl_db) = (db("identity.db"), db("parvane.json"), db("cloud.db"));
    children.push(spawn(
        "identity",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_DB_PATH", &id_db),
            ("PARVANE_DEV", "1"),
            ("PARVANE_WELL_KNOWN_FILE", &wk),
            ("PARVANE_LOGIN_RATE", "100000"),
            ("PARVANE_LOGIN_RATE_IP", "100000"),
            ("PARVANE_REGISTER_RATE", "100000"),
            ("PARVANE_REGISTER_RATE_IP", "100000"),
            ("PARVANE_REGISTER_RATE_GLOBAL", "100000"),
        ],
        &dir.join("identity.log"),
    ));
    children.push(spawn("cloud", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &cl_db)], &dir.join("cloud.log")));
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_V2_FEATURES", "sealed"),
            ("PARVANE_GATEWAY_MAX_CONNS_PER_IP", "10000"),
        ],
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp };
    let t0 = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(t0.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let d = stack.dir.clone();
    tokio::task::spawn_blocking(move || {
        wait_log(&d.join("identity.log"), "методы v2 подключены", t0);
        wait_log(&d.join("cloud.log"), "методы v2 подключены", t0);
    })
    .await
    .unwrap();
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

// ── клиенты ──────────────────────────────────────────────────────────────────

/// ID-сессия пользователя (регистрация, токен, Auth).
fn login(addr: &str, user: &str) -> Conn {
    let token = register_token(addr, user, "d1");
    let (mut c, _) = Conn::connect(addr, Channel::Identified);
    c.send(frame::Kind::Auth(Auth { token }));
    assert!(matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth {user}");
    c
}

fn call<M: Message + Default>(c: &mut Conn, method: &str, body: impl Message) -> Result<M, ErrorCode> {
    c.call(method, body.encode_to_vec()).and_then(|b| M::decode(b.as_slice()).map_err(|_| ErrorCode::Invalid))
}

/// Запрос человека без аккаунта: новое анонимное соединение.
fn anon<M: Message + Default>(addr: &str, method: &str, body: impl Message) -> Result<M, ErrorCode> {
    let (mut c, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    call(&mut c, method, body)
}

/// STREAM-метод на свежем соединении `c`: Ok((метаданные, данные)) | Err(код).
fn stream(c: &mut Conn, method: &str, body: impl Message) -> Result<(Vec<u8>, Vec<u8>), ErrorCode> {
    let meta = c.call(method, body.encode_to_vec())?;
    let mut data = vec![];
    loop {
        let f = c.recv().ok_or(ErrorCode::Unavailable)?;
        if let Some(frame::Kind::StreamChunk(ch)) = f.kind {
            if let Some(e) = ch.error {
                return Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unspecified));
            }
            data.extend_from_slice(&ch.data);
            if ch.last {
                return Ok((meta, data));
            }
        }
    }
}

/// Скачать файл ссылки без аккаунта (окно `first`/`count`).
fn link_download(addr: &str, link: &str, file_id: &str, first: u32, count: u32) -> Result<(clpb::LinkDownloadResponse, Vec<u8>), ErrorCode> {
    let (mut c, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    let r = clpb::LinkDownloadRequest { link_id: link.into(), file_id: file_id.into(), first_chunk: first, chunk_count: count };
    let (meta, data) = stream(&mut c, "cloud.link.download", r)?;
    Ok((clpb::LinkDownloadResponse::decode(meta.as_slice()).map_err(|_| ErrorCode::Invalid)?, data))
}

/// Загрузить файл облака (bucket DRIVE) без секрета доступа. Ok(file_id).
fn upload_drive(c: &mut Conn, parts: &[Vec<u8>]) -> Result<String, ErrorCode> {
    let mut upload_id = String::new();
    for (i, p) in parts.iter().enumerate() {
        let r: clpb::UploadChunkResponse = call(
            c,
            "cloud.blob.upload_chunk",
            clpb::UploadChunkRequest { upload_id: upload_id.clone(), index: i as u32, data: p.clone(), bucket: clpb::BlobBucket::Drive as i32 },
        )?;
        upload_id = r.upload_id;
    }
    let done = clpb::UploadCompleteRequest {
        upload_id,
        chunks: parts.len() as u32,
        size: parts.iter().map(|p| p.len() as u64).sum(),
        visibility: clpb::Visibility::Private as i32,
        capability_hash: vec![],
    };
    call::<clpb::UploadCompleteResponse>(c, "cloud.blob.upload_complete", done).map(|r| r.file_id)
}

struct Failures(Vec<String>);
impl Failures {
    fn check(&mut self, name: &str, ok: bool, detail: impl std::fmt::Debug) {
        if ok {
            eprintln!("PASS {name}");
        } else {
            eprintln!("FAIL {name}: {detail:?}");
            self.0.push(name.to_string());
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    b
}

fn b64url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Все файлы БД шарда (`<name>*`: основная, `-v2.db`, WAL, SHM) одним блобом.
fn db_blob(dir: &Path, prefix: &str) -> Vec<u8> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with(prefix) {
            out.extend(std::fs::read(e.path()).unwrap_or_default());
        }
    }
    out
}

/// Шифрование списка для теста: поток SHA-256(ключ ‖ счётчик). Клиент шифрует
/// PVB2; серверу всё равно — он хранит непрозрачные байты.
fn seal(key: &[u8; 32], plain: &[u8]) -> Vec<u8> {
    plain
        .chunks(32)
        .enumerate()
        .flat_map(|(i, block)| {
            let pad = Sha256::new().chain_update(key).chain_update((i as u64).to_be_bytes()).finalize();
            block.iter().zip(pad).map(|(a, b)| a ^ b).collect::<Vec<u8>>()
        })
        .collect()
}

const FILE_NAME: &str = "Секретный-отчёт-2026.pdf";
const LINK_NAME: &str = "Папка для бухгалтера";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cloud_link_for_people_without_account_live() {
    use futures::StreamExt;
    let Some((mut stack, nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    // Слушатель шины: что gateway передаёт шарду от человека без аккаунта.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    for m in ["cloud.link.get", "cloud.link.download"] {
        let mut tap = nc.subscribe(parvane_protocol::schema::method(m).unwrap().subject.to_string()).await.unwrap();
        let tx = tx.clone();
        tokio::spawn(async move {
            while let Some(m) = tap.next().await {
                let _ = tx.send(m.payload.to_vec());
            }
        });
    }
    let p = free_port();
    let (mut f, alice, link, link_key, manifest, tapped) = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let alice = format!("la{p}@local");
        let mut a = login(&addr, &alice);
        let mut b = login(&addr, &format!("lb{p}@local"));
        // 1) Файл облака владельца (шифртекст PVB2 — для сервера случайные байты).
        let parts: Vec<Vec<u8>> = (0..3).map(|_| random::<1500>().to_vec()).collect();
        let whole: Vec<u8> = parts.concat();
        let source = upload_drive(&mut a, &parts);
        f.check("upload-source", source.is_ok(), &source);
        let source = source.unwrap_or_default();
        // 2) Ссылка: идентификатор от сервера, копия, список под ключом ссылки.
        let created = call::<clpb::LinkCreateResponse>(&mut a, "cloud.link.create", clpb::LinkCreateRequest { ttl_days: 7 });
        f.check("create", created.as_ref().is_ok_and(|r| r.link_id.len() == 22), &created);
        let link = created.map(|r| r.link_id).unwrap_or_default();
        let not_yet = anon::<clpb::LinkGetResponse>(&addr, "cloud.link.get", clpb::LinkGetRequest { link_id: link.clone() }).map(|_| ());
        f.check("preparing-is-not-found", not_yet == Err(ErrorCode::NotFound), not_yet);
        let add = clpb::LinkAddRequest { link_id: link.clone(), file_id: source.clone(), capability: vec![] };
        let added = call::<clpb::LinkAddResponse>(&mut a, "cloud.link.add", add.clone());
        f.check("add", added.as_ref().is_ok_and(|r| r.size == whole.len() as u64 && r.chunks == 3 && r.file_id != source), &added);
        let copy = added.map(|r| r.file_id).unwrap_or_default();
        let again = call::<clpb::LinkAddResponse>(&mut a, "cloud.link.add", add).map(|r| r.file_id);
        f.check("add-idempotent", again.as_ref() == Ok(&copy), &again);
        let foreign = call::<clpb::LinkAddResponse>(&mut b, "cloud.link.add", clpb::LinkAddRequest { link_id: link.clone(), file_id: source.clone(), capability: vec![] }).map(|_| ());
        f.check("add-by-stranger", foreign == Err(ErrorCode::NotFound), foreign);
        let link_key: [u8; 32] = random();
        let plain = format!(r#"{{"v":1,"name":"{LINK_NAME}","kind":"folder","items":[{{"path":"{FILE_NAME}","size":4500,"fileId":"{copy}","key":"{}","chunks":3}}]}}"#, b64url(&random::<32>()));
        let manifest = seal(&link_key, plain.as_bytes());
        let owner_record = random::<120>().to_vec();
        let publish = clpb::LinkPublishRequest { link_id: link.clone(), manifest: manifest.clone(), owner_record: owner_record.clone() };
        let stolen = call::<clpb::LinkPublishResponse>(&mut b, "cloud.link.publish", publish.clone()).map(|_| ());
        f.check("publish-by-stranger", stolen == Err(ErrorCode::NotFound), stolen);
        let published = call::<clpb::LinkPublishResponse>(&mut a, "cloud.link.publish", publish);
        f.check("publish", published.as_ref().is_ok_and(|r| r.expires_at > 0), &published);
        let expires_at = published.map(|r| r.expires_at).unwrap_or_default();
        // 3) Человек без аккаунта: список и файл через анонимный канал.
        let got = anon::<clpb::LinkGetResponse>(&addr, "cloud.link.get", clpb::LinkGetRequest { link_id: link.clone() });
        f.check("anon-get", got.as_ref().is_ok_and(|r| r.manifest == manifest && r.expires_at == expires_at && !r.expired), got.as_ref().map(|r| (r.manifest.len(), r.expires_at, r.expired)));
        let opened = String::from_utf8(seal(&link_key, &got.map(|r| r.manifest).unwrap_or_default())).unwrap_or_default();
        f.check("manifest-opens-with-link-key", opened.contains(FILE_NAME) && opened.contains(&copy), "");
        let dl = link_download(&addr, &link, &copy, 0, 0);
        f.check("anon-download", dl.as_ref().is_ok_and(|(m, d)| m.size == whole.len() as u64 && m.chunks == 3 && *d == whole), dl.as_ref().map(|(m, d)| (m.size, m.chunks, d.len())));
        let part = link_download(&addr, &link, &copy, 1, 1);
        f.check("anon-download-window", part.as_ref().is_ok_and(|(_, d)| *d == parts[1]), part.as_ref().map(|(_, d)| d.len()));
        // Снимок: источник удалён — ссылка отдаёт прежнее.
        let gone = call::<clpb::DeleteResponse>(&mut a, "cloud.blob.delete", clpb::DeleteRequest { file_id: source.clone() }).map(|_| ());
        let still = link_download(&addr, &link, &copy, 0, 0);
        f.check("snapshot-survives-source-delete", gone.is_ok() && still.is_ok_and(|(_, d)| d == whole), gone);
        // 4) По ссылке читается только её содержимое.
        let other = upload_drive(&mut a, &[b"not-in-link".to_vec()]).unwrap_or_default();
        let outside = link_download(&addr, &link, &other, 0, 0).map(|_| ());
        let unknown = link_download(&addr, &b64url(&random::<16>()), &copy, 0, 0).map(|_| ());
        f.check("only-files-of-link", outside == Err(ErrorCode::NotFound) && unknown == Err(ErrorCode::NotFound), (outside, unknown));
        // Копия не читается ни по секрету, ни обычными методами владельца.
        let (mut an, _) = Conn::connect(&addr, Channel::AnonymousDelivery);
        let by_cap = stream(&mut an, "cloud.blob.download_cap", clpb::DownloadCapRequest { file_id: copy.clone(), capability: vec![0; 32], ..Default::default() }).map(|_| ());
        let by_owner = stream(&mut a, "cloud.blob.download", clpb::DownloadRequest { file_id: copy.clone(), ..Default::default() }).map(|_| ());
        let del = call::<clpb::DeleteResponse>(&mut a, "cloud.blob.delete", clpb::DeleteRequest { file_id: copy.clone() }).map(|_| ());
        f.check("copy-hidden-from-blob-methods", by_cap == Err(ErrorCode::NotFound) && by_owner == Err(ErrorCode::NotFound) && del == Err(ErrorCode::NotFound), (by_cap, by_owner, del));
        // 5) Каналы: анониму закрыты ID-методы ссылок, ID-сессии — анонимные.
        let lid = link.clone();
        let anon_id: Vec<(&str, Result<(), ErrorCode>)> = vec![
            ("create", anon::<clpb::LinkCreateResponse>(&addr, "cloud.link.create", clpb::LinkCreateRequest { ttl_days: 7 }).map(|_| ())),
            ("add", anon::<clpb::LinkAddResponse>(&addr, "cloud.link.add", clpb::LinkAddRequest { link_id: lid.clone(), file_id: other.clone(), capability: vec![] }).map(|_| ())),
            ("publish", anon::<clpb::LinkPublishResponse>(&addr, "cloud.link.publish", clpb::LinkPublishRequest { link_id: lid.clone(), manifest: vec![1], owner_record: vec![] }).map(|_| ())),
            ("list", anon::<clpb::LinkListResponse>(&addr, "cloud.link.list", clpb::LinkListRequest {}).map(|_| ())),
            ("revoke", anon::<clpb::LinkRevokeResponse>(&addr, "cloud.link.revoke", clpb::LinkRevokeRequest { link_id: lid.clone() }).map(|_| ())),
            ("extend", anon::<clpb::LinkExtendResponse>(&addr, "cloud.link.extend", clpb::LinkExtendRequest { link_id: lid.clone(), ttl_days: 0 }).map(|_| ())),
        ];
        f.check("anon-cannot-manage-links", anon_id.iter().all(|(_, r)| *r == Err(ErrorCode::Forbidden)), &anon_id);
        let in_id = call::<clpb::LinkGetResponse>(&mut a, "cloud.link.get", clpb::LinkGetRequest { link_id: lid.clone() }).map(|_| ());
        f.check("get-in-id-forbidden", in_id == Err(ErrorCode::Forbidden), in_id);
        // 6) Владелец: список, занятое место, продление; чужой — ничего.
        let mine = call::<clpb::LinkListResponse>(&mut a, "cloud.link.list", clpb::LinkListRequest {}).map(|r| r.links).unwrap_or_default();
        let info = mine.first().cloned().unwrap_or_default();
        f.check(
            "owner-list",
            mine.len() == 1 && info.link_id == link && info.state == clpb::LinkState::Active as i32 && info.bytes == whole.len() as u64 && info.files == 1 && info.owner_record == owner_record,
            (mine.len(), info.state, info.bytes, info.files),
        );
        let theirs = call::<clpb::LinkListResponse>(&mut b, "cloud.link.list", clpb::LinkListRequest {}).map(|r| r.links.len());
        f.check("stranger-list-empty", theirs == Ok(0), theirs);
        let usage = call::<clpb::UsageResponse>(&mut a, "cloud.blob.usage", clpb::UsageRequest {});
        f.check("usage-links-bytes", usage.as_ref().is_ok_and(|u| u.links_bytes == whole.len() as u64 && u.buckets[1].used == whole.len() as u64 + 11), usage.as_ref().map(|u| (u.links_bytes, u.buckets[1].used)));
        let extended = call::<clpb::LinkExtendResponse>(&mut a, "cloud.link.extend", clpb::LinkExtendRequest { link_id: link.clone(), ttl_days: 0 }).map(|r| r.expires_at);
        f.check("extend-forever", extended == Ok(0), extended);
        let bad_ttl = call::<clpb::LinkExtendResponse>(&mut a, "cloud.link.extend", clpb::LinkExtendRequest { link_id: link.clone(), ttl_days: 3 }).map(|_| ());
        f.check("extend-bad-ttl", bad_ttl == Err(ErrorCode::Invalid), bad_ttl);
        // 7) Отзыв: чужой не может; после отзыва владельцем — ни списка, ни файла, место вернулось.
        let by_stranger = call::<clpb::LinkRevokeResponse>(&mut b, "cloud.link.revoke", clpb::LinkRevokeRequest { link_id: link.clone() }).map(|_| ());
        f.check("revoke-by-stranger", by_stranger == Err(ErrorCode::NotFound) && link_download(&addr, &link, &copy, 0, 1).is_ok(), by_stranger);
        let revoked = call::<clpb::LinkRevokeResponse>(&mut a, "cloud.link.revoke", clpb::LinkRevokeRequest { link_id: link.clone() }).map(|_| ());
        f.check("revoke", revoked.is_ok(), revoked);
        let get_after = anon::<clpb::LinkGetResponse>(&addr, "cloud.link.get", clpb::LinkGetRequest { link_id: link.clone() }).map(|_| ());
        let dl_after = link_download(&addr, &link, &copy, 0, 0).map(|_| ());
        f.check("revoked-serves-nothing", get_after == Err(ErrorCode::NotFound) && dl_after == Err(ErrorCode::NotFound), (get_after, dl_after));
        let usage = call::<clpb::UsageResponse>(&mut a, "cloud.blob.usage", clpb::UsageRequest {});
        f.check("revoke-returns-space", usage.as_ref().is_ok_and(|u| u.links_bytes == 0 && u.buckets[1].used == 11), usage.as_ref().map(|u| (u.links_bytes, u.buckets[1].used)));
        let left = call::<clpb::LinkListResponse>(&mut a, "cloud.link.list", clpb::LinkListRequest {}).map(|r| r.links.len());
        f.check("revoked-not-listed", left == Ok(0), left);
        // Вторая ссылка остаётся в базе — для проверки того, что в ней хранится.
        let kept = call::<clpb::LinkCreateResponse>(&mut a, "cloud.link.create", clpb::LinkCreateRequest { ttl_days: 0 }).map(|r| r.link_id).unwrap_or_default();
        let kept_pub = call::<clpb::LinkPublishResponse>(&mut a, "cloud.link.publish", clpb::LinkPublishRequest { link_id: kept.clone(), manifest: manifest.clone(), owner_record: vec![] }).map(|r| r.expires_at);
        f.check("second-link-without-term", kept_pub == Ok(0), kept_pub);
        // Анонимных обращений, дошедших до шарда: get ×3 и download ×7.
        (f, alice, kept, link_key, manifest, 10usize)
    })
    .await
    .unwrap();
    // 8) В шину анонимные запросы уходят без личности и IP.
    let (mut n, mut clean) = (0, true);
    while n < tapped {
        let Ok(Some(b)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await else { break };
        n += 1;
        let r = ShardRequest::decode(b.as_slice()).unwrap_or_default();
        clean &= r.user.is_empty() && r.device_id.is_empty() && r.token.is_empty() && r.client_ip.is_empty();
        clean &= !contains(&b, alice.as_bytes());
    }
    f.check("bus-anon-requests-clean", clean && n == tapped, n);
    // 9) Что лежит у сервера: шифртекст списка — да; названия и ключ ссылки — нет.
    stack.stop();
    let cloud = db_blob(&stack.dir, "cloud.db");
    f.check("db-keeps-manifest-ciphertext", contains(&cloud, &manifest) && contains(&cloud, link.as_bytes()), cloud.len());
    let secret: Vec<Vec<u8>> = vec![
        FILE_NAME.as_bytes().to_vec(),
        LINK_NAME.as_bytes().to_vec(),
        link_key.to_vec(),
        b64url(&link_key).into_bytes(),
        hexs(&link_key).into_bytes(),
    ];
    f.check("db-has-no-names-or-link-key", secret.iter().all(|s| !contains(&cloud, s)), "");
    let log = std::fs::read(stack.dir.join("cloud.log")).unwrap_or_default();
    f.check("log-has-no-names-or-link-key", !log.is_empty() && secret.iter().all(|s| !contains(&log, s)), log.len());
    // Идентификатор ссылки — половина доступа: в журнале (даже на уровне debug) его нет целиком.
    f.check("log-has-no-link-id", !contains(&log, link.as_bytes()) && contains(&log, link[..6].as_bytes()), "");
    let gw_log = std::fs::read(stack.dir.join("gateway.log")).unwrap_or_default();
    f.check("gateway-log-has-no-link-id", !contains(&gw_log, link.as_bytes()), "");
    assert!(f.0.is_empty(), "провалены сценарии ссылок облака: {:?} (логи: {})", f.0, stack.dir.display());
}
