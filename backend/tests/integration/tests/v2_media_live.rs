//! Вложения и обходные каналы метаданных протокола v2 против живого стека
//! (spec 007, T123, ревью дизайна D-08, инвариант 28):
//! - вложение сообщения: загрузка в ID-канале регистрирует только SHA-256
//!   capability, получатель качает блоб `cloud.blob.download_cap` через
//!   анонимный канал — грантов на получателей на сервере нет;
//! - `identity.device.fetch_bundle_anon`: при исчерпании OTK и сверх лимита на
//!   адресата — fallback-ключ; лимит на IP-источник в gateway (анонимные
//!   соединения одноразовые, лимит на соединение не работает);
//! - генератор данных для `scripts/protocol_sender_leak_check.sh` (T068,
//!   медиа и звонки; `#[ignore]`).
//!
//! Стек: nats + identity + messenger + call + cloud + gateway; клиент v2 — TCP
//! с преамбулой `PVN2`. Без `nats-server` тесты печатают SKIP и проходят.
//! Помощники скопированы из `v2_us2_live.rs` (тот файл не меняется).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::identity::{DeviceLog, RootIdentity};
use parvane_protocol::limits::Origin;
use parvane_protocol::msg as emsg;
use parvane_protocol::olm::OlmAccount;
use parvane_protocol::pb::parvane::call::v2 as cpb;
use parvane_protocol::pb::parvane::cloud::v1 as clpb;
use parvane_protocol::pb::parvane::core::v2::{
    frame, response, sealed_envelope::Access, Auth, Channel, DeviceCertificate, DeviceRef, ErrorCode, Frame, Hello,
    OpHeader, Ref, Request, ShardRequest, SignedDeviceCertificate, SignedOp, UserRef,
};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, Media, MediaKind};
use parvane_protocol::seal;
use prost::Message;
use sha2::{Digest, Sha256};

const PASSWORD: &str = "e2e-Test-pass-2026";

// ── стек ─────────────────────────────────────────────────────────────────────

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    keep: bool,
    gateway_tcp: String,
}

impl Stack {
    /// Остановить процессы (логи и БД остаются в `dir`).
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
        if !self.keep {
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
        assert!(start.elapsed() < Duration::from_secs(120), "{} не дождался «{needle}»:\n{}", path.display(), std::fs::read_to_string(path).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Поднять стек. `keep` — каталог для логов/БД, который не удаляется.
async fn start(keep: Option<PathBuf>, id_extra: &[(&str, &str)], gw_extra: &[(&str, &str)]) -> Option<(Stack, async_nats::Client)> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "gateway", "-p", "call", "-p", "cloud"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let (dir, keep_dir) = match keep {
        Some(d) => (d, true),
        None => (std::env::temp_dir().join(format!("parvane-v2media-{}-{}", std::process::id(), free_port())), false),
    };
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
    let wk = db("parvane.json");
    let rates = [
        ("PARVANE_LOGIN_RATE", "100000"),
        ("PARVANE_LOGIN_RATE_IP", "100000"),
        ("PARVANE_REGISTER_RATE", "100000"),
        ("PARVANE_REGISTER_RATE_IP", "100000"),
        ("PARVANE_REGISTER_RATE_GLOBAL", "100000"),
        ("PARVANE_PREKEY_FETCH_RATE", "100000"),
    ];
    let mut id_env: Vec<(&str, &str)> = vec![("PARVANE_NATS_URL", &nats_url), ("PARVANE_DEV", "1"), ("PARVANE_WELL_KNOWN_FILE", &wk)];
    let id_db = db("identity.db");
    id_env.push(("PARVANE_DB_PATH", &id_db));
    id_env.extend_from_slice(&rates);
    id_env.extend_from_slice(id_extra);
    children.push(spawn("identity", &id_env, &dir.join("identity.log")));
    let m_db = db("messenger.db");
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    let c_db = db("call.db");
    children.push(spawn("call", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &c_db), ("PARVANE_STUN_URLS", "stun:stun.test:3478"), ("PARVANE_TURN_URL", "turn:turn.test:3478"), ("PARVANE_TURN_SECRET", "turn-secret")], &dir.join("call.log")));
    let cl_db = db("cloud.db");
    children.push(spawn("cloud", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &cl_db)], &dir.join("cloud.log")));
    let mut gw_env: Vec<(&str, &str)> = vec![
        ("PARVANE_NATS_URL", &nats_url),
        ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
        ("PARVANE_GATEWAY_BIND", &gateway_ws),
        ("PARVANE_V2_FEATURES", "sealed"),
        ("PARVANE_GATEWAY_MAX_CONNS_PER_IP", "10000"),
    ];
    gw_env.extend_from_slice(gw_extra);
    children.push(spawn("gateway", &gw_env, &dir.join("gateway.log")));
    let stack = Stack { children, dir, keep: keep_dir, gateway_tcp };
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
        wait_log(&d.join("messenger.log"), "методы v2 подключены", t0);
        wait_log(&d.join("call.log"), "методы v2 подключены", t0);
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

// ── клиент v2 по TCP ─────────────────────────────────────────────────────────

struct V2 {
    s: TcpStream,
    dec: TcpDecoder,
    next_id: u64,
    events: Vec<parvane_protocol::pb::parvane::core::v2::Event>,
}

impl V2 {
    fn connect(addr: &str, channel: Channel) -> V2 {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(TCP_MAGIC).unwrap();
        let mut c = V2 { s, dec: TcpDecoder::new(), next_id: 0, events: vec![] };
        c.send(frame::Kind::Hello(Hello { proto_minor: 0, channel: channel as i32, ..Default::default() }));
        let w = c.recv().expect("welcome");
        assert!(matches!(w.kind, Some(frame::Kind::Welcome(_))), "{w:?}");
        c
    }
    fn send(&mut self, k: frame::Kind) {
        self.s.write_all(&codec::tcp_encode(&codec::encode_frame(k))).unwrap();
    }
    fn recv(&mut self) -> Option<Frame> {
        let mut buf = [0u8; 65536];
        loop {
            if let Ok(Some(f)) = self.dec.next_frame() {
                return codec::decode_frame(&f, Origin::Server).ok();
            }
            match self.s.read(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(n) => self.dec.push(&buf[..n]).ok()?,
            }
        }
    }
    /// Запрос → Ok(тело) | Err(код). События по пути копятся в `events`.
    fn call(&mut self, method: &str, body: Vec<u8>) -> Result<Vec<u8>, ErrorCode> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(frame::Kind::Request(Request { id, method: method.into(), body, timeout_ms: 5000 }));
        loop {
            let f = self.recv().expect("ответ");
            match f.kind {
                Some(frame::Kind::Response(r)) if r.id == id => {
                    return match r.result {
                        Some(response::Result::Ok(b)) => Ok(b),
                        Some(response::Result::Error(e)) => Err(ErrorCode::try_from(e.code).unwrap()),
                        None => Err(ErrorCode::Unspecified),
                    }
                }
                Some(frame::Kind::Event(e)) => self.events.push(e),
                _ => {}
            }
        }
    }
    /// STREAM-метод: Ok((метаданные, склеенные данные чанков)) | Err(код).
    fn stream(&mut self, method: &str, body: Vec<u8>) -> Result<(Vec<u8>, Vec<u8>), ErrorCode> {
        let meta = self.call(method, body)?;
        let id = self.next_id;
        let mut data = vec![];
        loop {
            let f = self.recv().ok_or(ErrorCode::Unavailable)?;
            if let Some(frame::Kind::StreamChunk(c)) = f.kind {
                if c.id != id {
                    continue;
                }
                if let Some(e) = c.error {
                    return Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unspecified));
                }
                data.extend_from_slice(&c.data);
                if c.last {
                    return Ok((meta, data));
                }
            }
        }
    }
}

fn call_ok<M: Message + Default>(c: &mut V2, m: &str, b: Vec<u8>) -> Result<M, ErrorCode> {
    c.call(m, b).and_then(|x| M::decode(x.as_slice()).map_err(|_| ErrorCode::Invalid))
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

// ── пользователи и устройства ────────────────────────────────────────────────

struct Dev {
    c: V2,
    user: String,
    token: String,
    dev: DeviceRef,
    acc: OlmAccount,
    cert: SignedDeviceCertificate,
    hpke_sk: [u8; 32],
    hpke_pk: [u8; 32],
    delivery_key: Vec<u8>,
    root: RootIdentity,
}

/// Зарегистрировать пользователя через v2 и поднять устройство с сертификатом.
fn device(addr: &str, user: &str) -> Dev {
    device_n(addr, user, 5)
}

/// То же с `n_otk` одноразовыми ключами.
fn device_n(addr: &str, user: &str, n_otk: usize) -> Dev {
    let mut c = V2::connect(addr, Channel::Identified);
    let _ = c.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
    let tok: ipb::SessionIssueResponse = call_ok(&mut c, "identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec()).expect("issue");
    c.send(frame::Kind::Auth(Auth { token: tok.token.clone() }));
    assert!(matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))));
    let root = RootIdentity::generate(user).unwrap();
    let g = root.genesis_entry().unwrap();
    c.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(g.clone()) }.encode_to_vec()).expect("genesis");
    let mut log = DeviceLog::new(user).unwrap();
    log.apply(&g).unwrap();
    let mut acc = OlmAccount::new();
    let (hsk, hpk) = seal::generate_keypair();
    let mut cert = DeviceCertificate {
        user: Some(UserRef { address: user.into() }),
        device_id: "d1".into(),
        olm_curve25519: acc.curve25519().to_vec(),
        olm_ed25519: acc.ed25519().to_vec(),
        hpke_x25519: hpk.to_vec(),
        proto_major: 2,
        serial: 1,
        ..Default::default()
    };
    // C1-01: доказательство владения ключом устройства.
    parvane_protocol::identity::prove_possession(&acc, &mut cert, &root.root_pub()).unwrap();
    let add = root.add_device_entry(2, log.head_hash, &cert).unwrap();
    let otks: Vec<ipb::OneTimeKey> = acc
        .generate_one_time_keys(n_otk)
        .into_iter()
        .map(|(id, k)| ipb::OneTimeKey { signature: parvane_protocol::sign::sign_ctx(&acc, parvane_protocol::sign::ctx::OTK, &[&id, &k]), key_id: id, curve25519: k.to_vec() })
        .collect();
    let fb = acc.generate_fallback_key().unwrap();
    let fb_id = b"fallback".to_vec();
    let fallback = ipb::OneTimeKey { signature: parvane_protocol::sign::sign_ctx(&acc, parvane_protocol::sign::ctx::OTK, &[&fb_id, &fb]), key_id: fb_id, curve25519: fb.to_vec() };
    c.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(add), one_time_keys: otks, fallback_key: Some(fallback) }.encode_to_vec()).expect("cert");
    let mut delivery_key = vec![0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut delivery_key);
    c.call("identity.delivery_key.set", ipb::DeliveryKeySetRequest { delivery_key: delivery_key.clone() }.encode_to_vec()).expect("dk");
    let signed = root.certify(&cert).unwrap();
    Dev { c, user: user.into(), token: tok.token, dev: DeviceRef { address: user.into(), device_id: "d1".into() }, acc, cert: signed, hpke_sk: *hsk, hpke_pk: hpk, delivery_key, root }
}

/// Бандл адресата (анонимно): (устройство, HPKE-ключ, identity Olm, одноразовый ключ).
/// (устройство, HPKE-ключ, identity Olm, одноразовый/fallback-ключ).
type BundleEntry = (DeviceRef, [u8; 32], Vec<u8>, Vec<u8>);

fn bundle(addr: &str, to_user: &str) -> Vec<BundleEntry> {
    let mut an = V2::connect(addr, Channel::AnonymousDelivery);
    let b: ipb::DeviceFetchBundleAnonResponse = call_ok(&mut an, "identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: to_user.into() }) }.encode_to_vec()).expect("bundle");
    b.devices
        .into_iter()
        .map(|d| {
            let v = parvane_protocol::identity::verify_certificate(d.certificate.as_ref().unwrap(), Some(to_user)).unwrap();
            let otk = d.one_time_key.or(d.fallback_key).unwrap();
            (DeviceRef { address: to_user.into(), device_id: v.cert.device_id.clone() }, v.hpke_x25519().unwrap(), v.cert.olm_curve25519.clone(), otk.curve25519)
        })
        .collect()
}

/// Sealed-сообщение `from` → `to_user`.
fn seal_msg(addr: &str, from: &Dev, to_user: &str, access: Access, c: &Content) -> mpb::DeliverSealedRequest {
    let mut envelopes = vec![];
    for (dr, hpke, ident, otk) in bundle(addr, to_user) {
        let mut s = from.acc.outbound(&ident, &otk).unwrap();
        let op = emsg::sign_direct(&from.acc, c, to_user, vec![dr.clone()], 1).unwrap();
        let inner = emsg::seal_inner(&from.cert, &mut s, &op).unwrap();
        envelopes.push(seal::seal(&dr, &hpke, access.clone(), inner, false).unwrap());
    }
    mpb::DeliverSealedRequest { envelopes }
}

/// Подписанный сигнал звонка: target = звонок, audience = устройство адресата (класс 6).
fn call_op(from: &Dev, call_id: &[u8; 16], to: &DeviceRef, signal: cpb::CallSignal) -> SignedOp {
    let header = OpHeader {
        domain: "call".into(),
        op_type: "signal".into(),
        op_id: parvane_protocol::sign::new_op_id(),
        target: Some(Ref { domain: "local".into(), id: call_id.to_vec() }),
        audience: vec![to.clone()],
        ts_ms: 1,
        ..Default::default()
    };
    parvane_protocol::sign::sign_op(&from.acc, header, signal.encode_to_vec()).unwrap()
}

fn sync(d: &mut Dev, after: u64) -> Vec<mpb::InboxRecord> {
    call_ok::<mpb::InboxSyncResponse>(&mut d.c, "msg.inbox.sync", mpb::InboxSyncRequest { after_seq: after, max_bytes: 0 }.encode_to_vec()).map(|r| r.records).unwrap_or_default()
}

// ── вложения ─────────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    b
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

/// Загрузить вложение в ID-канале владельца; сервер получает только SHA-256
/// capability. Ok(file_id).
fn upload_attachment(c: &mut V2, parts: &[Vec<u8>], cap: &[u8; 32]) -> Result<String, ErrorCode> {
    let mut upload_id = String::new();
    for (i, p) in parts.iter().enumerate() {
        let r: clpb::UploadChunkResponse = call_ok(c, "cloud.blob.upload_chunk", clpb::UploadChunkRequest { upload_id: upload_id.clone(), index: i as u32, data: p.clone() }.encode_to_vec())?;
        upload_id = r.upload_id;
    }
    let size = parts.iter().map(|p| p.len() as u64).sum();
    let done = clpb::UploadCompleteRequest {
        upload_id,
        chunks: parts.len() as u32,
        size,
        visibility: clpb::Visibility::Private as i32,
        capability_hash: Sha256::digest(cap).to_vec(),
    };
    call_ok::<clpb::UploadCompleteResponse>(c, "cloud.blob.upload_complete", done.encode_to_vec()).map(|r| r.file_id)
}

/// Содержимое медиа-сообщения: file_id + capability + ключ блоба — всё внутри E2E.
fn media_content(file_id: &str, cap: &[u8; 32], size: u64) -> Content {
    Content {
        kind: Some(content::Kind::Media(Media {
            kind: MediaKind::Photo as i32,
            file_id: file_id.into(),
            capability: cap.to_vec(),
            file_key: vec![0x11; 32],
            file_nonce: vec![0x22; 24],
            size,
            mime: "image/jpeg".into(),
            ..Default::default()
        })),
        ..Default::default()
    }
}

/// Скачать вложение по capability через новое анонимное соединение.
fn download_cap(addr: &str, file_id: &str, cap: &[u8], first: u32, count: u32) -> Result<(clpb::DownloadCapResponse, Vec<u8>), ErrorCode> {
    let mut an = V2::connect(addr, Channel::AnonymousDelivery);
    let (meta, data) = an.stream("cloud.blob.download_cap", clpb::DownloadCapRequest { file_id: file_id.into(), capability: cap.to_vec(), first_chunk: first, chunk_count: count }.encode_to_vec())?;
    Ok((clpb::DownloadCapResponse::decode(meta.as_slice()).map_err(|_| ErrorCode::Invalid)?, data))
}

/// Вложения из sealed-записей журнала получателя (подпись отправителя проверена).
fn received_media(d: &mut Dev, sender_key: &[u8; 32]) -> Vec<Media> {
    let recs = sync(d, 0);
    let mut out = vec![];
    // Входящие Olm-сессии: одноразовый ключ расходуется первым pre-key
    // сообщением, следующие открываются уже установленной сессией.
    let mut sessions: Vec<parvane_protocol::olm::OlmSession> = vec![];
    for r in recs {
        let Some(inbox_record::Item::Sealed(env)) = r.item else { continue };
        let Ok(inner) = seal::open(&env, &d.dev, &d.hpke_sk) else { continue };
        let pt = match sessions.iter_mut().find(|s| inner.olm_type == 0 && s.matches_prekey(&inner.olm_message)) {
            Some(s) => s.decrypt(inner.olm_type, &inner.olm_message).ok(),
            None => {
                let Some(v) = inner.sender.as_ref().and_then(|c| parvane_protocol::identity::verify_certificate(c, None).ok()) else { continue };
                match d.acc.inbound(&v.cert.olm_curve25519, &inner.olm_message) {
                    Ok((s, pt)) => {
                        sessions.push(s);
                        Some(pt)
                    }
                    Err(_) => None,
                }
            }
        };
        let Some(op) = pt.and_then(|pt| SignedOp::decode(pt.as_slice()).ok()) else { continue };
        let Ok(v) = parvane_protocol::sign::verify_op(&op, emsg::MSG_DOMAIN, emsg::CONTENT_OP, Some(sender_key)) else { continue };
        if let Ok(Content { kind: Some(content::Kind::Media(m)), .. }) = Content::decode(v.payload.as_slice()) {
            out.push(m);
        }
    }
    out
}

fn anon_bundle(addr: &str, user: &str) -> Result<ipb::DeviceFetchBundleAnonResponse, ErrorCode> {
    let mut an = V2::connect(addr, Channel::AnonymousDelivery);
    call_ok(&mut an, "identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: user.into() }) }.encode_to_vec())
}

/// (есть OTK, есть fallback) у единственного устройства.
fn bundle_shape(b: &ipb::DeviceFetchBundleAnonResponse) -> Option<(bool, bool)> {
    let d = b.devices.first()?;
    Some((d.one_time_key.is_some(), d.fallback_key.is_some()))
}

// ── T123: вложение по capability, fallback-ключ, лимит бандлов на IP ─────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn media_capability_live() {
    use futures::StreamExt;
    // Лимит бандлов на адресата — 4 в минуту; на IP-источник — всплеск 20.
    let id_extra = [("PARVANE_V2_BUNDLE_RATE", "4")];
    let gw_extra = [("GATEWAY_RATE_BUNDLE_IP_BURST", "20"), ("GATEWAY_RATE_BUNDLE_IP_PER_SEC", "0.001")];
    let Some((stack, nc)) = start(None, &id_extra, &gw_extra).await else { return };
    let addr = stack.gateway_tcp.clone();
    // Слушатель шины: ShardRequest анонимного скачивания.
    let mut tap = nc.subscribe(parvane_protocol::schema::method("cloud.blob.download_cap").unwrap().subject.to_string()).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(m) = tap.next().await {
            let _ = tx.send(m.payload.to_vec());
        }
    });
    let p = free_port();
    let (mut f, alice, bob, bob_token, cap) = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let mut a = device(&addr, &format!("ma{p}@local"));
        let mut b = device(&addr, &format!("mb{p}@local"));
        let bob = b.user.clone();
        // 1) Загрузка вложения (ID-канал отправителя) с capability.
        let cap: [u8; 32] = random();
        let parts: Vec<Vec<u8>> = (0..3).map(|i| [b"PVB2".as_slice(), &[i; 1000]].concat()).collect();
        let whole: Vec<u8> = parts.concat();
        let file_id = upload_attachment(&mut a.c, &parts, &cap);
        f.check("upload-with-capability", file_id.is_ok(), &file_id);
        let file_id = file_id.unwrap_or_default();
        // 2) Сообщение с вложением — sealed через анонимный канал.
        let msg = seal_msg(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &media_content(&file_id, &cap, whole.len() as u64));
        let sent = V2::connect(&addr, Channel::AnonymousDelivery).call("msg.deliver_sealed", msg.encode_to_vec());
        f.check("media-message-sealed", sent.is_ok(), &sent);
        // 3) Получатель открыл сообщение: file_id и capability — только внутри E2E.
        let got = received_media(&mut b, &a.acc.ed25519());
        let m = got.first().cloned().unwrap_or_default();
        f.check("media-received", got.len() == 1 && m.file_id == file_id && m.capability == cap.to_vec(), got.len());
        f.check("sealed-hides-capability", !contains(&msg.encode_to_vec(), &cap) && !contains(&msg.encode_to_vec(), file_id.as_bytes()), "");
        // 4) Скачивание по capability через анонимный канал — целиком и окном.
        let dl = download_cap(&addr, &m.file_id, &m.capability, 0, 0);
        f.check("download-cap", dl.as_ref().is_ok_and(|(meta, data)| meta.size == whole.len() as u64 && meta.chunks == 3 && *data == whole), dl.as_ref().map(|(m, d)| (m.size, m.chunks, d.len())));
        let part = download_cap(&addr, &file_id, &cap, 1, 1);
        f.check("download-cap-window", part.as_ref().is_ok_and(|(_, d)| *d == parts[1]), part.as_ref().map(|(_, d)| d.len()));
        // Неверный секрет и неизвестный файл неразличимы; секрет не той длины — INVALID.
        let wrong = download_cap(&addr, &file_id, &random::<32>(), 0, 0).map(|_| ());
        let unknown = download_cap(&addr, &uuid::Uuid::now_v7().to_string(), &cap, 0, 0).map(|_| ());
        f.check("wrong-capability", wrong == Err(ErrorCode::NotFound) && unknown == Err(ErrorCode::NotFound), (wrong, unknown));
        f.check("short-capability", download_cap(&addr, &file_id, &cap[..16], 0, 0).map(|_| ()) == Err(ErrorCode::Invalid), "");
        // Хэш вместо секрета не подходит.
        f.check("hash-is-not-capability", download_cap(&addr, &file_id, &Sha256::digest(cap), 0, 0).map(|_| ()) == Err(ErrorCode::NotFound), "");
        // 5) Каналы: download_cap — только ANON; у получателя гранта нет (ID-скачивание — NOT_FOUND),
        // у владельца — есть (свой файл).
        let in_id = b.c.stream("cloud.blob.download_cap", clpb::DownloadCapRequest { file_id: file_id.clone(), capability: cap.to_vec(), ..Default::default() }.encode_to_vec()).map(|_| ());
        f.check("download-cap-in-id-forbidden", in_id == Err(ErrorCode::Forbidden), in_id);
        let by_grant = b.c.stream("cloud.blob.download", clpb::DownloadRequest { file_id: file_id.clone(), ..Default::default() }.encode_to_vec()).map(|_| ());
        f.check("no-recipient-grant", by_grant == Err(ErrorCode::NotFound), by_grant);
        let own = a.c.stream("cloud.blob.download", clpb::DownloadRequest { file_id: file_id.clone(), ..Default::default() }.encode_to_vec());
        f.check("owner-download", own.as_ref().is_ok_and(|(_, d)| *d == whole), own.as_ref().map(|(_, d)| d.len()));
        // Загрузка — только в ID-канале.
        let anon_up = V2::connect(&addr, Channel::AnonymousDelivery).call("cloud.blob.upload_chunk", clpb::UploadChunkRequest { index: 0, data: vec![1], ..Default::default() }.encode_to_vec());
        f.check("upload-anon-forbidden", anon_up == Err(ErrorCode::Forbidden), &anon_up);
        // 6) fallback-ключ: при исчерпании OTK (2 ключа) — бандл с fallback.
        let dave = device_n(&addr, &format!("md{p}@local"), 2).user;
        let shapes: Vec<_> = (0..3).map(|_| anon_bundle(&addr, &dave).ok().as_ref().and_then(bundle_shape)).collect();
        f.check("otk-exhausted-fallback", shapes == vec![Some((true, true)), Some((true, true)), Some((false, true))], &shapes);
        // Сверх лимита на адресата (4/мин) — не отказ, а fallback без расхода OTK.
        let erin = device_n(&addr, &format!("me{p}@local"), 10).user;
        let shapes: Vec<_> = (0..5).map(|_| anon_bundle(&addr, &erin).ok().as_ref().and_then(bundle_shape)).collect();
        f.check("over-rate-fallback-only", shapes[..4].iter().all(|s| *s == Some((true, true))) && shapes[4] == Some((false, true)), &shapes);
        // ANON-метод в ID-сессии — FORBIDDEN (и не расходует лимит).
        let r = a.c.call("identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: erin.clone() }) }.encode_to_vec());
        f.check("bundle-anon-in-id-forbidden", r == Err(ErrorCode::Forbidden), &r);
        // 7) Лимит бандлов на IP-источник (всплеск 20): каждый запрос — новое
        // соединение, переподключение лимит не обходит. До сих пор — 9 бандлов.
        let mut codes = vec![];
        for _ in 0..20 {
            let r = anon_bundle(&addr, &erin).map(|_| ());
            codes.push(r);
            if r.is_err() {
                break;
            }
        }
        let ok_before = codes.iter().filter(|r| r.is_ok()).count();
        f.check("bundle-ip-limit", codes.last() == Some(&Err(ErrorCode::RateLimited)) && ok_before == 11, (ok_before, codes.last()));
        // Прочие ANON-методы того же источника — своя корзина.
        f.check("download-after-bundle-limit", download_cap(&addr, &file_id, &cap, 0, 1).is_ok(), "");
        (f, a.user, bob, b.token, cap)
    })
    .await
    .unwrap();
    // 8) В шину анонимное скачивание уходит без личности и IP.
    let (mut n, mut clean) = (0, true);
    let t0 = Instant::now();
    while n < 7 || t0.elapsed() < Duration::from_millis(300) {
        let Ok(Some(b)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await else { break };
        n += 1;
        let r = ShardRequest::decode(b.as_slice()).unwrap_or_default();
        clean &= r.user.is_empty() && r.device_id.is_empty() && r.token.is_empty() && r.client_ip.is_empty();
        clean &= !contains(&b, bob.as_bytes()) && !contains(&b, bob_token.as_bytes());
    }
    f.check("bus-download-cap-clean", clean && n >= 7, n);
    // 9) Сервер не хранит связь «вложение → получатель» и сам секрет.
    let cloud = db_blob(&stack.dir, "cloud.db");
    let cloud_v2 = db_blob(&stack.dir, "cloud.db-v2.db");
    f.check("cloud-db-no-recipient", !cloud.is_empty() && !contains(&cloud, bob.as_bytes()), "");
    f.check("cloud-db-no-capability", !contains(&cloud, &cap) && !contains(&cloud, hexs(&cap).as_bytes()), "");
    f.check("cloud-v2-stores-hash-only", contains(&cloud_v2, &Sha256::digest(cap)), "");
    f.check("cloud-db-owner-is-uploader", contains(&cloud, alice.as_bytes()), "");
    let cloud_log = std::fs::read(stack.dir.join("cloud.log")).unwrap_or_default();
    f.check("cloud-log-clean", !contains(&cloud_log, bob.as_bytes()) && !contains(&cloud_log, alice.as_bytes()) && !contains(&cloud_log, hexs(&cap).as_bytes()), "");
    assert!(f.0.is_empty(), "провалены сценарии вложений v2: {:?} (логи: {})", f.0, stack.dir.display());
}

// ── T068 (T123): генератор медиа и звонков для protocol_sender_leak_check.sh ─

/// Ключи устройства отправителя (сырые; кодировки hex/base64 строит скрипт).
fn key_needles(d: &Dev) -> Vec<Vec<u8>> {
    vec![d.acc.ed25519().to_vec(), d.acc.curve25519().to_vec(), d.hpke_pk.to_vec(), d.root.root_pub().to_vec()]
}

/// Генерация: 20 вложений alice → bob (загрузка в ID-канале владельца,
/// сообщение sealed через ANON, скачивание получателем по capability через
/// ANON) и сигналы звонка alice → bob; стек останавливается, БД и журналы
/// остаются в `PARVANE_LEAK_DIR`, рядом `manifest.json` (`kind: "media"`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "запускается scripts/protocol_sender_leak_check.sh"]
async fn leak_generate_media() {
    let Some(dir) = std::env::var_os("PARVANE_LEAK_DIR").map(PathBuf::from) else {
        eprintln!("SKIP: нужен PARVANE_LEAK_DIR");
        return;
    };
    let _ = std::fs::remove_dir_all(&dir);
    let Some((mut stack, _nc)) = start(Some(dir.clone()), &[], &[]).await else { return };
    let addr = stack.gateway_tcp.clone();
    let d2 = dir.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        let p = free_port();
        let mut alice = device(&addr, &format!("leakmalice{p}@local"));
        let mut bob = device(&addr, &format!("leakmbob{p}@local"));
        let bob_dk = bob.delivery_key.clone();
        let bun = bundle(&addr, &bob.user);
        // 1) Загрузка 20 вложений владельцем (ID-канал: владелец файла известен
        // серверу по построению — квота; получатель — нет).
        let mut caps = vec![];
        let mut file_ids = vec![];
        for i in 0..20u8 {
            let cap: [u8; 32] = random();
            let parts = vec![[b"PVB2".as_slice(), &[i; 700]].concat(), vec![i; 300]];
            if let Ok(id) = upload_attachment(&mut alice.c, &parts, &cap) {
                file_ids.push(id);
                caps.push(cap);
            }
        }
        // Отправитель закрывает ID-сессию: дальше — только ANON.
        let alice_c = std::mem::replace(&mut alice.c, V2::connect(&addr, Channel::AnonymousDelivery));
        drop(alice_c);
        std::thread::sleep(Duration::from_millis(500));
        // Отметка: скрипт смотрит журналы только после неё (журнал cloud —
        // целиком: получателя и секретов там не должно быть никогда).
        let mut offsets = serde_json::Map::new();
        for n in ["gateway.log", "identity.log", "messenger.log", "call.log", "cloud.log", "nats.log"] {
            let len = std::fs::metadata(d2.join(n)).map(|m| m.len()).unwrap_or(0);
            offsets.insert(n.to_string(), serde_json::json!(len));
        }
        // 2) 20 медиа-сообщений alice → bob через анонимный канал.
        let mut sessions: Vec<_> = bun.iter().map(|(dr, hpke, ident, otk)| (dr.clone(), *hpke, alice.acc.outbound(ident, otk).unwrap())).collect();
        let mut sent = 0;
        for (id, cap) in file_ids.iter().zip(&caps) {
            let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
            let mut envelopes = vec![];
            for (dr, hpke, s) in sessions.iter_mut() {
                let op = emsg::sign_direct(&alice.acc, &media_content(id, cap, 1004), &bob.user, vec![dr.clone()], now_ms()).unwrap();
                let inner = emsg::seal_inner(&alice.cert, s, &op).unwrap();
                envelopes.push(seal::seal(dr, hpke, Access::DeliveryKey(bob_dk.clone()), inner, false).unwrap());
            }
            if an.call("msg.deliver_sealed", mpb::DeliverSealedRequest { envelopes }.encode_to_vec()).is_ok() {
                sent += 1;
            }
        }
        // 3) Получатель открывает сообщения и качает вложения по capability (ANON).
        let got = received_media(&mut bob, &alice.acc.ed25519());
        let downloaded = got.iter().filter(|m| download_cap(&addr, &m.file_id, &m.capability, 0, 0).is_ok_and(|(meta, d)| meta.chunks == 2 && d.len() == 1004)).count();
        // 4) Сигналы звонка alice → bob (эфемерны; история — в личном состоянии).
        let call_id: [u8; 16] = random();
        let mut calls = 0;
        let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
        for i in 0..10 {
            let signal = if i == 0 {
                cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Offer(cpb::Offer { sdp: "v=0 leak-media-offer".into(), ..Default::default() })) }
            } else {
                cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Ice(cpb::IceCandidate { candidate: format!("candidate:{i} 1 udp 1 10.0.1.{i} 5000 typ host"), sdp_mid: "0".into(), sdp_mline_index: 0 })) }
            };
            let mut envelopes = vec![];
            for (dr, hpke, s) in sessions.iter_mut() {
                let op = call_op(&alice, &call_id, dr, signal.clone());
                let inner = emsg::seal_inner(&alice.cert, s, &op).unwrap();
                envelopes.push(seal::seal(dr, hpke, Access::DeliveryKey(bob_dk.clone()), inner, false).unwrap());
            }
            let method = if i == 0 { "call.ring_sealed" } else { "call.signal_sealed" };
            if an.call(method, cpb::SignalSealedRequest { envelopes }.encode_to_vec()).is_ok() {
                calls += 1;
            }
        }
        let needles = |v: &[Vec<u8>]| v.iter().map(|x| hexs(x)).collect::<Vec<_>>();
        let cap_hashes: Vec<Vec<u8>> = caps.iter().map(|c| Sha256::digest(c).to_vec()).collect();
        let caps: Vec<Vec<u8>> = caps.iter().map(|c| c.to_vec()).collect();
        serde_json::json!({
            "kind": "media",
            "media_sent": sent,
            "media_received": got.len(),
            "media_downloaded": downloaded,
            "call_signals": calls,
            "log_offsets": offsets,
            "sender": { "address": alice.user, "keys_hex": needles(&key_needles(&alice)) },
            "recipient": { "address": bob.user },
            "tokens": [alice.token],
            "capabilities_hex": needles(&caps),
            "capability_hashes_hex": needles(&cap_hashes),
            "file_ids": file_ids,
            "catalog_dbs": ["identity.db", "identity.db-v2.db"],
            // Владелец блоба известен серверу по построению (квота, удаление).
            "owner_tables": { "cloud.db": ["files", "uploads"] },
        })
    })
    .await
    .unwrap();
    stack.stop();
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    eprintln!("leak_generate_media: {}", dir.display());
    assert_eq!(manifest["media_sent"], 20);
    assert_eq!(manifest["media_downloaded"], 20);
}
