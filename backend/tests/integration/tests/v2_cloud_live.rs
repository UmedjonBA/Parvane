//! Облако против живого стека (spec 016, T020): шарды `domains` (дерево
//! `cloud.v1`) и `cloud` (блобы bucket DRIVE) вместе с identity/messenger/gateway.
//! - личный диск: контейнер, файл в bucket 1 двоичными чанками с секретом
//!   доступа, узел дерева с этим блобом, скачивание анонимно по секрету;
//! - `cloud.blob.usage` считает bucket DRIVE отдельно от медиа чатов;
//! - `cloud.blob.copy` — копия под новым секретом, место считается дважды,
//!   удаление источника место возвращает, копия читается;
//! - второе устройство: ключ контейнера по E2E, правки в обе стороны;
//! - снимок после 200 операций, третье устройство по ключам экспорта линковки
//!   поднимается из снимка и дочитывает только хвост журнала;
//! - совместная папка: читатель получает ключ и приглашение, читает файл, но
//!   сервер не принимает от него операций; редактор — принимает.
//! Без `nats-server` тест печатает SKIP и проходит.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{CloudIngest, CloudRole, Event, Need};
use parvane_protocol::pb::parvane::cloud::v1 as clpb;
use parvane_protocol::pb::parvane::core::v2::{
    frame, Auth, Channel, DomainContainerGetRequest, DomainGrantListRequest, DomainOpSyncRequest, DomainSnapshotGetRequest,
    ErrorCode, Ref,
};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2 as mpb;
use prost::Message;
use sha2::{Digest, Sha256};

mod v2common;
use v2common::{Conn, Device, PASSWORD};

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    gateway_tcp: String,
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
        .env("PARVANE_LOG_LEVEL", "info")
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

async fn start() -> Option<Stack> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "domains", "-p", "cloud", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2cloud-{}-{}", std::process::id(), free_port()));
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
    let (id_db, wk, m_db, d_db, cl_db) = (db("identity.db"), db("parvane.json"), db("messenger.db"), db("domains.db"), db("cloud.db"));
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
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    children.push(spawn("domains", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &d_db)], &dir.join("domains.log")));
    children.push(spawn("cloud", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &cl_db)], &dir.join("cloud.log")));
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_V2_FEATURES", "sealed"),
            ("PARVANE_GATEWAY_MAX_CONNS_PER_IP", "10000"),
            // 200 операций подряд ради снимка
            ("GATEWAY_RATE_REQ_BURST", "100000"),
            ("GATEWAY_RATE_MSG_BURST", "100000"),
            ("GATEWAY_RATE_MSG_PER_SEC", "100000"),
            ("GATEWAY_RATE_REQ_PER_SEC", "100000"),
        ],
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp };
    let t0 = Instant::now();
    let d = stack.dir.clone();
    tokio::task::spawn_blocking(move || {
        for shard in ["identity", "messenger", "cloud"] {
            wait_log(&d.join(format!("{shard}.log")), "методы v2 подключены", t0);
        }
        wait_log(&d.join("domains.log"), "Domains шард запущен", t0);
    })
    .await
    .unwrap();
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some(stack)
}

/// Войти новым устройством уже зарегистрированного пользователя.
fn login(addr: &str, user: &str, device_id: &str) -> Device {
    let (mut id, w) = Conn::connect(addr, Channel::Identified);
    let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome") };
    let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).unwrap();
    let tok = id
        .call("identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: device_id.into(), ..Default::default() }.encode_to_vec())
        .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap_or_default().token)
        .expect("session.issue");
    id.send(frame::Kind::Auth(Auth { token: tok }));
    assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
    let (anon, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    let client = parvane_protocol::client::Client::new(user, device_id, &domain).unwrap();
    Device { client, id, anon, server_key, domain }
}

/// Привязать новое устройство `fresh` грантом от `owner` (как линковка web).
fn link(owner: &mut Device, fresh: &mut Device) {
    let (ssk, entries, dk, gen) = owner.client.link_grant_material().unwrap();
    let reqs = fresh.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
    fresh.run(&reqs).expect("сертификат нового устройства");
    let me = owner.client.user.clone();
    assert!(owner.satisfy(&Need::PeerLog { user: me, after: 0 }));
}

fn call<M: Message + Default>(c: &mut Conn, method: &str, body: impl Message) -> Result<M, ErrorCode> {
    c.call(method, body.encode_to_vec()).and_then(|b| M::decode(b.as_slice()).map_err(|_| ErrorCode::Invalid))
}

/// Новые записи инбокса устройства, открытые ядром.
fn drain(d: &mut Device, after: &mut u64) -> Vec<Event> {
    let b = d.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *after, max_bytes: 0 }.encode_to_vec()).unwrap();
    let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
    let mut out = vec![];
    for r in recs {
        *after = (*after).max(r.seq);
        out.extend(d.open(&r.encode_to_vec()));
    }
    out
}

fn cref(id: &[u8]) -> Ref {
    Ref { domain: "local".into(), id: id.to_vec() }
}

/// Подключить контейнер (`domain.container.get` + журнал грантов), с добором журналов.
fn attach(d: &mut Device, id: &[u8]) {
    let get = d.id.call("domain.container.get", DomainContainerGetRequest { container: Some(cref(id)) }.encode_to_vec()).unwrap();
    let grants = d.id.call("domain.grant.list", DomainGrantListRequest { container: Some(cref(id)), after_version: 0 }.encode_to_vec()).unwrap();
    d.op(&mut |c| c.cloud_attach(&get, &grants).map(|_| vec![])).expect("cloud_attach");
}

/// Догнать гранты и журнал операций контейнера (как хост web), все страницы.
fn pull(d: &mut Device, id: &[u8], peers: &[&str]) -> CloudIngest {
    let mut total = CloudIngest::default();
    for _ in 0..64 {
        let after = d.client.cloud_grant_version(id);
        let grants = d.id.call("domain.grant.list", DomainGrantListRequest { container: Some(cref(id)), after_version: after }.encode_to_vec()).unwrap();
        d.op(&mut |c| c.cloud_ingest_grants(id, &grants).map(|_| vec![])).expect("гранты");
        let resp = d.id.call("domain.op.sync", DomainOpSyncRequest { container: Some(cref(id)), after_seq: d.client.cloud_head_seq(id), max_bytes: 0 }.encode_to_vec()).unwrap();
        let mut r = d.client.cloud_ingest_sync(id, &resp, true).expect("ingest");
        if r.authors_behind {
            for u in peers {
                assert!(d.satisfy(&Need::PeerLog { user: (*u).into(), after: 0 }));
            }
            r = d.client.cloud_ingest_sync(id, &resp, false).expect("ingest повтор");
        }
        total.applied += r.applied;
        total.head_seq = r.head_seq;
        total.missing_epoch = r.missing_epoch;
        if r.grants_behind {
            continue;
        }
        if !r.more {
            return total;
        }
    }
    panic!("журнал контейнера не догнан");
}

fn edit(d: &mut Device, id: &[u8], ops: serde_json::Value) -> Result<Vec<u8>, ErrorCode> {
    let local = d.client.cloud_prepare_local(id, &serde_json::json!({ "ops": ops }).to_string()).expect("prepare");
    let req = d.client.cloud_seal(id, &local.op, &local.op_id, 1).expect("seal");
    d.exec(&req)
}

fn names(d: &Device, id: &[u8]) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(&d.client.cloud_state_json(id).unwrap()).unwrap();
    let mut out: Vec<String> = v["nodes"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap().to_string()).collect();
    out.sort();
    out
}

fn hexid(n: u32) -> String {
    let mut b = [0u8; 16];
    b[12..].copy_from_slice(&n.to_be_bytes());
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn b64(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    b
}

/// Загрузить шифртекст в bucket DRIVE под секретом доступа. Ok(file_id).
fn upload_drive(c: &mut Conn, parts: &[Vec<u8>], capability: &[u8]) -> Result<String, ErrorCode> {
    let mut upload_id = String::new();
    for (i, p) in parts.iter().enumerate() {
        let r: clpb::UploadChunkResponse = call(
            c,
            "cloud.blob.upload_chunk",
            clpb::UploadChunkRequest { upload_id: upload_id.clone(), index: i as u32, data: p.clone(), bucket: clpb::BlobBucket::Drive as i32 },
        )?;
        upload_id = r.upload_id;
    }
    let status: clpb::UploadStatusResponse = call(c, "cloud.blob.upload_status", clpb::UploadStatusRequest { upload_id: upload_id.clone() })?;
    assert_eq!(status.chunks as usize, parts.len(), "upload_status видит все чанки");
    let done = clpb::UploadCompleteRequest {
        upload_id,
        chunks: parts.len() as u32,
        size: parts.iter().map(|p| p.len() as u64).sum(),
        visibility: clpb::Visibility::Private as i32,
        capability_hash: Sha256::digest(capability).to_vec(),
    };
    call::<clpb::UploadCompleteResponse>(c, "cloud.blob.upload_complete", done).map(|r| r.file_id)
}

/// Скачать блоб по секрету доступа через новое анонимное соединение.
fn download_cap(addr: &str, file_id: &str, capability: &[u8], chunks: u32) -> Result<Vec<u8>, ErrorCode> {
    let (mut c, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    let r = clpb::DownloadCapRequest { file_id: file_id.into(), capability: capability.to_vec(), first_chunk: 0, chunk_count: chunks };
    let _meta = c.call("cloud.blob.download_cap", r.encode_to_vec())?;
    let mut data = vec![];
    loop {
        let f = c.recv().ok_or(ErrorCode::Unavailable)?;
        if let Some(frame::Kind::StreamChunk(ch)) = f.kind {
            if let Some(e) = ch.error {
                return Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unspecified));
            }
            data.extend_from_slice(&ch.data);
            if ch.last {
                return Ok(data);
            }
        }
    }
}

fn drive_used(d: &mut Device) -> (u64, u64) {
    let u: clpb::UsageResponse = call(&mut d.id, "cloud.blob.usage", clpb::UsageRequest {}).unwrap();
    let get = |b: clpb::BlobBucket| u.buckets.iter().find(|x| x.bucket == b as i32).map(|x| x.used).unwrap_or(0);
    (get(clpb::BlobBucket::Unspecified), get(clpb::BlobBucket::Drive))
}

fn file_node(n: u32, parent: Option<u32>, name: &str, file_id: &str, capability: &[u8], size: u64, chunks: u32, uploader: &str) -> serde_json::Value {
    serde_json::json!({"op": "create", "id": hexid(n), "kind": "file", "parent": parent.map(hexid), "name": name, "mtime": 5,
        "blob": {"fileId": file_id, "key": b64(&[1; 32]), "nonce": b64(&[2; 12]), "capability": b64(capability), "size": size, "chunks": chunks,
                 "mime": "text/plain", "uploader": uploader}})
}

fn folder_node(n: u32, parent: Option<u32>, name: &str) -> serde_json::Value {
    serde_json::json!({"op": "create", "id": hexid(n), "kind": "folder", "parent": parent.map(hexid), "name": name})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_cloud_drive_devices_snapshot_copy_and_sharing_live() {
    let Some(stack) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let dir = stack.dir.clone();
    let tag = free_port();
    let result = tokio::task::spawn_blocking(move || {
        let alice_u = format!("clouda{tag}@local");
        let bob_u = format!("cloudb{tag}@local");
        let mut alice = Device::register(&addr, &alice_u, "d1");
        let mut bob = Device::register(&addr, &bob_u, "d1");
        let mut bob_cursor = 0;

        // ── Личный диск: контейнер и файл в bucket DRIVE ───────────────────────
        let (drive, create) = alice.client.cloud_create(1).unwrap();
        alice.exec(&create).expect("container.create");
        assert_eq!(alice.client.cloud_role(&drive), Some(CloudRole::Owner));
        assert_eq!(drive_used(&mut alice), (0, 0));
        let parts: Vec<Vec<u8>> = vec![random::<4096>().to_vec(), random::<4096>().to_vec(), random::<100>().to_vec()];
        let whole: Vec<u8> = parts.concat();
        let cap = random::<32>();
        let file_id = upload_drive(&mut alice.id, &parts, &cap).expect("загрузка в bucket DRIVE");
        // Место — в bucket DRIVE, медиа чатов не тронуты.
        assert_eq!(drive_used(&mut alice), (0, whole.len() as u64));
        edit(&mut alice, &drive, serde_json::json!([folder_node(1, None, "Документы"), file_node(2, Some(1), "отчёт.bin", &file_id, &cap, whole.len() as u64, 3, &alice_u)]))
            .expect("операция дерева");
        assert_eq!(names(&alice, &drive), vec!["Документы", "отчёт.bin"]);
        // Скачивание по секрету — анонимно; чужой секрет не подходит.
        assert_eq!(download_cap(&addr, &file_id, &cap, 3).expect("download_cap"), whole);
        assert_eq!(download_cap(&addr, &file_id, &random::<32>(), 3), Err(ErrorCode::NotFound));

        // ── Копия под новым секретом (перенос между контейнерами в web) ───────
        let cap2 = random::<32>();
        let copy: clpb::CopyResponse = call(
            &mut alice.id,
            "cloud.blob.copy",
            clpb::CopyRequest { file_id: file_id.clone(), capability: cap.to_vec(), bucket: clpb::BlobBucket::Drive as i32, capability_hash: Sha256::digest(cap2).to_vec() },
        )
        .expect("cloud.blob.copy");
        assert_ne!(copy.file_id, file_id);
        assert_eq!((copy.size, copy.chunks), (whole.len() as u64, 3));
        assert_eq!(drive_used(&mut alice).1, 2 * whole.len() as u64, "копия занимает место");
        assert_eq!(download_cap(&addr, &copy.file_id, &cap2, 3).unwrap(), whole);
        assert_eq!(download_cap(&addr, &copy.file_id, &cap, 3), Err(ErrorCode::NotFound), "у копии свой секрет");
        // Чужой не копирует блоб без секрета.
        let foreign = call::<clpb::CopyResponse>(
            &mut bob.id,
            "cloud.blob.copy",
            clpb::CopyRequest { file_id: file_id.clone(), capability: vec![], bucket: clpb::BlobBucket::Drive as i32, capability_hash: Sha256::digest(random::<32>()).to_vec() },
        );
        assert!(foreign.is_err(), "{foreign:?}");
        call::<clpb::DeleteResponse>(&mut alice.id, "cloud.blob.delete", clpb::DeleteRequest { file_id: file_id.clone() }).expect("delete");
        assert_eq!(drive_used(&mut alice).1, whole.len() as u64, "удаление вернуло место");
        assert_eq!(download_cap(&addr, &copy.file_id, &cap2, 3).unwrap(), whole, "копия пережила источник");
        // Узел файла теперь ссылается на копию (`setBlob`, как при переносе в web).
        let mut blob = file_node(2, Some(1), "отчёт.bin", &copy.file_id, &cap2, whole.len() as u64, 3, &alice_u);
        blob["op"] = "setBlob".into();
        edit(&mut alice, &drive, serde_json::json!([blob])).expect("узел копии");

        // ── Второе устройство: ключ по E2E, правки в обе стороны ──────────────
        let mut alice2 = login(&addr, &alice_u, "d2");
        link(&mut alice, &mut alice2);
        let drive_c = drive.clone();
        alice.op(&mut |c| c.cloud_share_with_own_devices(&drive_c)).expect("ключ своим устройствам");
        let mut cur2 = 0;
        let ev = drain(&mut alice2, &mut cur2);
        assert!(ev.iter().any(|e| matches!(e, Event::CloudChanged { id, .. } if *id == drive)), "{ev:?} {:?}", alice2.client.last_error);
        attach(&mut alice2, &drive);
        assert!(alice2.client.cloud_has_key(&drive));
        pull(&mut alice2, &drive, &[]);
        assert_eq!(alice2.client.cloud_state_json(&drive), alice.client.cloud_state_json(&drive));
        pull(&mut alice, &drive, &[]); // эхо своих операций
        edit(&mut alice2, &drive, serde_json::json!([{"op": "move", "id": hexid(1), "parent": null, "name": "Архив"}])).expect("правка d2");
        assert_eq!(pull(&mut alice, &drive, &[]).applied, 1);
        assert!(names(&alice, &drive).contains(&"Архив".to_string()), "{:?}", names(&alice, &drive));

        // ── Снимок после 200 операций и третье устройство из него ─────────────
        let head = alice.client.cloud_head_seq(&drive);
        for n in 0..(201 - head as u32) {
            edit(&mut alice, &drive, serde_json::json!([folder_node(100 + n, None, &format!("п{n}"))])).expect("операция");
        }
        pull(&mut alice, &drive, &[]);
        assert!(alice.client.cloud_head_seq(&drive) >= 200);
        let snap = alice.client.cloud_snapshot_request(&drive, 2).unwrap().expect("снимок по порогу");
        alice.exec(&snap).expect("domain.snapshot.put");
        let snap_seq = alice.client.cloud_head_seq(&drive);
        edit(&mut alice, &drive, serde_json::json!([folder_node(9000, None, "после снимка")])).expect("хвост");
        pull(&mut alice, &drive, &[]);
        let mut alice3 = login(&addr, &alice_u, "d3");
        link(&mut alice, &mut alice3);
        alice3.client.cloud_keys_import(&alice.client.cloud_keys_export()).unwrap();
        attach(&mut alice3, &drive);
        let s = alice3.id.call("domain.snapshot.get", DomainSnapshotGetRequest { container: Some(cref(&drive)) }.encode_to_vec()).unwrap();
        assert_eq!(alice3.client.cloud_ingest_snapshot(&drive, &s).unwrap(), snap_seq, "третье устройство поднято из снимка");
        let tail = pull(&mut alice3, &drive, &[]);
        assert_eq!(tail.applied, 1, "из журнала — только хвост после снимка: {tail:?}");
        assert_eq!(alice3.client.cloud_state_json(&drive), alice.client.cloud_state_json(&drive));
        assert_eq!(download_cap(&addr, &copy.file_id, &cap2, 3).unwrap(), whole);

        // ── Совместная папка: читатель, затем редактор ───────────────────────
        let (shared, create) = alice.client.cloud_create(3).unwrap();
        alice.exec(&create).expect("совместная папка");
        let scap = random::<32>();
        let sparts = vec![b"plan for the week".to_vec()];
        let sfile = upload_drive(&mut alice.id, &sparts, &scap).unwrap();
        edit(&mut alice, &shared, serde_json::json!([{"op": "meta", "name": "Проект"}, file_node(1, None, "план.txt", &sfile, &scap, 17, 1, &alice_u)])).unwrap();
        let (sh, bu) = (shared.clone(), bob_u.clone());
        alice.op(&mut |c| c.cloud_grant(&sh, &bu, false, "Приглашение в папку «Проект»", 4)).expect("грант читателю");
        let ev = drain(&mut bob, &mut bob_cursor);
        assert!(ev.iter().any(|e| matches!(e, Event::CloudChanged { id, .. } if *id == shared)), "{ev:?} {:?}", bob.client.last_error);
        let invited = ev.iter().any(|e| matches!(e, Event::Direct { content: mpb::Content { kind: Some(mpb::content::Kind::CloudInvite(_)), .. }, .. }));
        assert!(invited, "приглашение сообщением чата: {ev:?}");
        attach(&mut bob, &shared);
        assert_eq!(bob.client.cloud_role(&shared), Some(CloudRole::Reader));
        pull(&mut bob, &shared, &[&alice_u]);
        assert_eq!(names(&bob, &shared), vec!["план.txt"]);
        assert_eq!(download_cap(&addr, &sfile, &scap, 1).unwrap(), sparts[0], "читатель скачивает по секрету из дерева");
        // Операцию читателя в обход ядра сервер не принимает.
        let forged = {
            use parvane_protocol::domain::{cloud as dc, cloud_json, LamportGuard};
            let mut batch = cloud_json::batch_from_json(&serde_json::json!({ "ops": [folder_node(5, None, "от читателя")] }).to_string()).unwrap();
            let mut guard = LamportGuard::default();
            dc::stamp_batch(&mut batch, "d1", &mut guard);
            batch.encode_to_vec()
        };
        let req = bob.client.cloud_seal(&shared, &forged, &parvane_protocol::sign::new_op_id(), 5).unwrap();
        assert_eq!(bob.exec(&req), Err(ErrorCode::Forbidden), "сервер отверг операцию читателя");
        // Редактор пишет, владелец видит.
        alice.op(&mut |c| c.cloud_grant(&sh, &bu, true, "", 6)).expect("повышение");
        drain(&mut bob, &mut bob_cursor);
        pull(&mut bob, &shared, &[&alice_u]);
        assert_eq!(bob.client.cloud_role(&shared), Some(CloudRole::Editor));
        pull(&mut alice, &shared, &[&bob_u]); // эхо своих операций
        edit(&mut bob, &shared, serde_json::json!([folder_node(6, None, "от Боба")])).expect("правка редактора");
        assert_eq!(pull(&mut alice, &shared, &[&bob_u]).applied, 1);
        assert_eq!(names(&alice, &shared), vec!["от Боба", "план.txt"]);
        // Личный диск владельца Бобу не виден — даже его существование.
        assert_eq!(
            bob.id.call("domain.op.sync", DomainOpSyncRequest { container: Some(cref(&drive)), after_seq: 0, max_bytes: 0 }.encode_to_vec()).err(),
            Some(ErrorCode::NotFound)
        );
        Ok::<(), String>(())
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        other => {
            let logs: String = ["domains", "cloud", "messenger"]
                .iter()
                .map(|s| format!("\n── {s}.log ──\n{}", std::fs::read_to_string(dir.join(format!("{s}.log"))).unwrap_or_default().lines().rev().take(40).collect::<Vec<_>>().join("\n")))
                .collect();
            panic!("{other:?}{logs}");
        }
    }
    drop(stack);
}
