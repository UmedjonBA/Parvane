//! US2 протокола v2 против живого стека (spec 007, Phase 4): звонки
//! `call.signal_sealed`/`call.ice_config` (T078), эфемерные каналы и анонимный
//! «печатает» в группе (T077, T122), гигиена анонимного канала (T070, T120),
//! SC-003a — бан/мьют/исключение → отказ со следующей эпохи (T069), генератор
//! данных для `scripts/protocol_sender_leak_check.sh` (T068, `#[ignore]`).
//!
//! Стек: nats + identity + messenger + call + gateway; клиент v2 — TCP с
//! преамбулой `PVN2`. Без `nats-server` тесты печатают SKIP и проходят.
//! Помощники скопированы из `v2_live.rs` (тот файл не меняется).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::ephemeral::{self as eph, EphChannel};
use parvane_protocol::group::{self, GroupState, SignerInfo};
use parvane_protocol::identity::{DeviceLog, RootIdentity};
use parvane_protocol::limits::Origin;
use parvane_protocol::msg as emsg;
use parvane_protocol::olm::{MegolmOutbound, OlmAccount};
use parvane_protocol::pb::parvane::call::v2 as cpb;
use parvane_protocol::pb::parvane::core::v2::{
    frame, response, sealed_envelope::Access, Auth, Channel, DeviceCertificate, DeviceRef, ErrorCode, Frame,
    GroupEnvelopeInner, Hello, OpHeader, Ref, Request, SealedEnvelope, ShardRequest, SignedDeviceCertificate, SignedOp,
    UserRef,
};
use parvane_protocol::pb::parvane::group::v2::{
    self as gpb, group_change::Change, AddMember, Ban, Create, GroupKind, Mute, NewEpoch, Permissions, RemoveMember,
};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, Text, TypingAction};
use parvane_protocol::seal;
use prost::Message;

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
async fn start(keep: Option<PathBuf>) -> Option<(Stack, async_nats::Client)> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "gateway", "-p", "call"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let (dir, keep_dir) = match keep {
        Some(d) => (d, true),
        None => (std::env::temp_dir().join(format!("parvane-v2us2-{}-{}", std::process::id(), free_port())), false),
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
    children.push(spawn("identity", &id_env, &dir.join("identity.log")));
    let m_db = db("messenger.db");
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    let c_db = db("call.db");
    children.push(spawn("call", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &c_db), ("PARVANE_STUN_URLS", "stun:stun.test:3478"), ("PARVANE_TURN_URL", "turn:turn.test:3478"), ("PARVANE_TURN_SECRET", "turn-secret")], &dir.join("call.log")));
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
    fn local_port(&self) -> u16 {
        self.s.local_addr().map(|a| a.port()).unwrap_or(0)
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
    /// Дождаться события вида `kind` (или None за `wait`).
    fn event(&mut self, kind: &str, wait: Duration) -> Option<parvane_protocol::pb::parvane::core::v2::Event> {
        if let Some(i) = self.events.iter().position(|e| e.kind == kind) {
            return Some(self.events.remove(i));
        }
        self.s.set_read_timeout(Some(wait)).ok()?;
        let got = loop {
            match self.recv() {
                Some(Frame { kind: Some(frame::Kind::Event(e)), .. }) if e.kind == kind => break Some(e),
                Some(Frame { kind: Some(frame::Kind::Event(e)), .. }) => self.events.push(e),
                Some(_) => {}
                None => break None,
            }
        };
        self.s.set_read_timeout(Some(Duration::from_secs(5))).ok();
        got
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
        .generate_one_time_keys(5)
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

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

/// Бандл адресата (анонимно): (устройство, HPKE-ключ, identity Olm, одноразовый ключ).
fn bundle(addr: &str, to_user: &str) -> Vec<(DeviceRef, [u8; 32], Vec<u8>, Vec<u8>)> {
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

/// Конверты сигнала звонка (тело `call.signal_sealed` и `call.ring_sealed` одинаково).
fn seal_call(addr: &str, from: &Dev, to_user: &str, access: Access, call_id: &[u8; 16], signal: cpb::CallSignal) -> cpb::SignalSealedRequest {
    let mut envelopes = vec![];
    for (dr, hpke, ident, otk) in bundle(addr, to_user) {
        let mut s = from.acc.outbound(&ident, &otk).unwrap();
        let op = call_op(from, call_id, &dr, signal.clone());
        let inner = emsg::seal_inner(&from.cert, &mut s, &op).unwrap();
        envelopes.push(seal::seal(&dr, &hpke, access.clone(), inner, false).unwrap());
    }
    cpb::SignalSealedRequest { envelopes }
}

/// Открыть sealed-конверт получателем: (сертификат отправителя, SignedOp).
fn open_sealed(d: &mut Dev, env: &SealedEnvelope) -> Option<(SignedDeviceCertificate, SignedOp)> {
    let inner = seal::open(env, &d.dev, &d.hpke_sk).ok()?;
    let cert = inner.sender.clone()?;
    let v = parvane_protocol::identity::verify_certificate(&cert, None).ok()?;
    let ident: [u8; 32] = v.cert.olm_curve25519.as_slice().try_into().ok()?;
    let (_, pt) = d.acc.inbound(&ident, &inner.olm_message).ok()?;
    Some((cert, SignedOp::decode(pt.as_slice()).ok()?))
}

fn sync(d: &mut Dev, after: u64) -> Vec<mpb::InboxRecord> {
    call_ok::<mpb::InboxSyncResponse>(&mut d.c, "msg.inbox.sync", mpb::InboxSyncRequest { after_seq: after, max_bytes: 0 }.encode_to_vec()).map(|r| r.records).unwrap_or_default()
}

// ── группы ───────────────────────────────────────────────────────────────────

struct G {
    state: GroupState,
    owners: HashMap<[u8; 32], SignerInfo>,
}

impl G {
    fn resolve(&self) -> impl Fn(&[u8; 32]) -> Option<SignerInfo> + '_ {
        |k| self.owners.get(k).cloned()
    }
    /// Запись журнала от `who` (через его ID-сессию) → новое состояние.
    fn append(&mut self, who: &mut Dev, change: Change, ts_ms: i64) -> Result<(), ErrorCode> {
        let e = group::build_entry(&who.acc, Some(&self.state), "local", change.clone(), ts_ms).unwrap();
        let method = if matches!(change, Change::NewEpoch(_)) { "group.epoch.publish_send_key" } else { "group.state.append" };
        let body = if method == "group.state.append" {
            gpb::StateAppendRequest { entry: Some(e.clone()) }.encode_to_vec()
        } else {
            gpb::EpochPublishSendKeyRequest { entry: Some(e.clone()) }.encode_to_vec()
        };
        who.c.call(method, body)?;
        let next = group::apply(Some(&self.state), &e, &self.resolve()).unwrap();
        self.state = next;
        Ok(())
    }
}

fn perms() -> Permissions {
    Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, invite_users: false, pin_messages: false, change_info: false }
}

/// Группа владельца `owner` с участниками `members`.
fn create_group(owner: &mut Dev, members: &[&Dev]) -> G {
    let mut owners: HashMap<[u8; 32], SignerInfo> = HashMap::new();
    owners.insert(owner.acc.ed25519(), SignerInfo { user: owner.user.clone(), root_key: owner.root.root_pub() });
    for m in members {
        owners.insert(m.acc.ed25519(), SignerInfo { user: m.user.clone(), root_key: m.root.root_pub() });
    }
    let genesis = group::build_entry(&owner.acc, None, "local", Change::Create(Create { kind: GroupKind::Group as i32, name: "G".into(), default_permissions: Some(perms()), ..Default::default() }), 1).unwrap();
    owner.c.call("group.state.append", gpb::StateAppendRequest { entry: Some(genesis.clone()) }.encode_to_vec()).expect("genesis группы");
    let state = group::apply(None, &genesis, &|k: &[u8; 32]| owners.get(k).cloned()).unwrap();
    let mut g = G { state, owners };
    for (i, m) in members.iter().enumerate() {
        g.append(owner, Change::AddMember(AddMember { member: Some(UserRef { address: m.user.clone() }) }), 2 + i as i64).expect("add");
    }
    g
}

fn deliver_group(addr: &str, env: &parvane_protocol::pb::parvane::core::v2::GroupEnvelope) -> Result<Vec<u8>, ErrorCode> {
    let mut an = V2::connect(addr, Channel::AnonymousDelivery);
    an.call("msg.deliver_group", mpb::DeliverGroupRequest { envelope: Some(env.clone()) }.encode_to_vec())
}

fn inner_of(n: u8) -> GroupEnvelopeInner {
    GroupEnvelopeInner { megolm_session_id: vec![n; 43], megolm_message: vec![n; 64], padding: vec![] }
}

fn group_typing_req(send_key: &ed25519_dalek::SigningKey, g: &Ref, epoch: u64, ch: &EphChannel, from: &str) -> mpb::EphemeralGroupTypingRequest {
    let payload = ch.seal(&eph::typing(from, TypingAction::Typing, now_ms())).unwrap();
    let mut nonce = vec![0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
    let sig = group::sign_group_typing(send_key, g, epoch, &nonce, &payload);
    mpb::EphemeralGroupTypingRequest { group: Some(g.clone()), epoch, payload, nonce, epoch_signature: sig, channel_id: ch.id.to_vec() }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

// ── T078: звонки v2 ──────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn us2_calls_live() {
    let Some((stack, _nc)) = start(None).await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let mut a = device(&addr, &format!("ca{p}@local"));
        let mut b = device(&addr, &format!("cb{p}@local"));
        let c = device(&addr, &format!("cc{p}@local"));
        let bob = b.user.clone();
        // Боб слушает свой журнал.
        f.check("inbox-subscribe", b.c.call("msg.inbox.subscribe", vec![]).is_ok(), "");
        // 1) Offer alice → bob через анонимный канал с ключом доступа Боба.
        let call_id = [7u8; 16];
        let offer = cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Offer(cpb::Offer { sdp: "v=0 SDP-OFFER".into(), video: false, group: None })), group_call_id: vec![] };
        let req = seal_call(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &call_id, offer.clone());
        let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
        let r = call_ok::<cpb::RingSealedResponse>(&mut an, "call.ring_sealed", req.encode_to_vec());
        f.check("signal-delivered", r.as_ref().map(|x| x.delivered) == Ok(1), &r);
        // 2) Боб получил живое событие seq = 0, открыл, проверил подпись и адресацию.
        let ev = b.c.event("inbox.record", Duration::from_secs(5));
        let rec = ev.as_ref().and_then(|e| mpb::InboxRecord::decode(e.body.as_slice()).ok());
        f.check("signal-live-seq0", rec.as_ref().is_some_and(|r| r.seq == 0) && ev.as_ref().is_some_and(|e| e.seq == 0), &rec.as_ref().map(|r| r.seq));
        let env = rec.and_then(|r| match r.item {
            Some(inbox_record::Item::Sealed(e)) => Some(e),
            _ => None,
        });
        let opened = env.as_ref().and_then(|e| open_sealed(&mut b, e));
        let ok = opened.as_ref().is_some_and(|(cert, op)| {
            let alice_key: [u8; 32] = a.acc.ed25519();
            let v = parvane_protocol::sign::verify_op(op, "call", "signal", Some(&alice_key));
            let sig = v.as_ref().ok().and_then(|v| cpb::CallSignal::decode(v.payload.as_slice()).ok());
            cert == &a.cert
                && v.as_ref().is_ok_and(|v| v.require_target(&Ref { domain: "local".into(), id: call_id.to_vec() }).is_ok() && v.require_audience(&b.dev).is_ok())
                && sig == Some(offer.clone())
        });
        f.check("signal-opened-signed", ok, opened.is_some());
        // Класс 6: тот же подписанный SDP, переадресованный Кэрол, у неё не проходит.
        let forwarded_ok = opened.as_ref().is_some_and(|(_, op)| {
            parvane_protocol::sign::verify_op(op, "call", "signal", Some(&a.acc.ed25519())).is_ok_and(|v| v.require_audience(&c.dev).is_err())
        });
        f.check("sdp-forwarded-rejected", forwarded_ok, "");
        // Сервер не видит SDP: в конверте нет открытого текста.
        f.check("sdp-not-visible", env.as_ref().is_some_and(|e| !contains(&e.encode_to_vec(), b"SDP-OFFER") && !contains(&e.encode_to_vec(), a.user.as_bytes())), "");
        // 3) Сигналы не пишутся в журнал (D-08).
        let recs = sync(&mut b, 0);
        f.check("signal-not-in-journal", !recs.iter().any(|r| matches!(&r.item, Some(inbox_record::Item::Sealed(_)))), recs.len());
        // 4) Cooldown вызова на соединение → RATE_LIMITED; не-вызов на том же соединении проходит.
        let again = seal_call(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &call_id, offer.clone());
        f.check("ring-cooldown", an.call("call.ring_sealed", again.encode_to_vec()) == Err(ErrorCode::RateLimited), "");
        let ice = cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Ice(cpb::IceCandidate { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host".into(), sdp_mid: "0".into(), sdp_mline_index: 0 })), group_call_id: vec![] };
        let ice_req = seal_call(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &call_id, ice);
        f.check("ice-after-ring", an.call("call.signal_sealed", ice_req.encode_to_vec()).is_ok(), "");
        // 5) Неверный ключ доступа → FORBIDDEN; жетон незнакомца → FORBIDDEN.
        let bad = seal_call(&addr, &a, &bob, Access::DeliveryKey(vec![0; 32]), &call_id, offer.clone());
        f.check("wrong-delivery-key", V2::connect(&addr, Channel::AnonymousDelivery).call("call.signal_sealed", bad.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        let tok = seal_call(&addr, &a, &bob, Access::AnonToken(Default::default()), &call_id, offer.clone());
        f.check("anon-token-rejected", V2::connect(&addr, Channel::AnonymousDelivery).call("call.signal_sealed", tok.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // 6) Два адресата в одном запросе → INVALID (D-05).
        let mut mixed = seal_call(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &call_id, offer.clone());
        let mut other = mixed.envelopes[0].clone();
        other.recipient = Some(c.dev.clone());
        mixed.envelopes.push(other);
        f.check("mixed-recipients", V2::connect(&addr, Channel::AnonymousDelivery).call("call.signal_sealed", mixed.encode_to_vec()) == Err(ErrorCode::Invalid), "");
        // 7) ≤ 3 одновременных вызова одному адресату (Кэрол) — даже с разных соединений.
        let carol = c.user.clone();
        let mut codes = vec![];
        for i in 0..4u8 {
            let r = seal_call(&addr, &a, &carol, Access::DeliveryKey(c.delivery_key.clone()), &[i; 16], offer.clone());
            codes.push(V2::connect(&addr, Channel::AnonymousDelivery).call("call.ring_sealed", r.encode_to_vec()).map(|_| ()));
        }
        f.check("max-3-ringing-per-recipient", codes[..3].iter().all(|r| r.is_ok()) && codes[3] == Err(ErrorCode::RateLimited), &codes);
        // 8) Каналы: ANON-метод в ID-сессии → FORBIDDEN; ice_config — ID.
        f.check("signal-in-id-session", a.c.call("call.signal_sealed", req.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        f.check("ring-in-id-session", a.c.call("call.ring_sealed", req.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        let ice = call_ok::<cpb::IceConfigResponse>(&mut a.c, "call.ice_config", vec![]);
        let ok = ice.as_ref().is_ok_and(|r| r.servers.len() == 2 && r.servers[1].username.ends_with(&a.user) && !r.servers[1].credential.is_empty() && r.expires_ms > now_ms());
        f.check("ice-config", ok, &ice);
        f.check("ice-config-anon-forbidden", V2::connect(&addr, Channel::AnonymousDelivery).call("call.ice_config", vec![]) == Err(ErrorCode::Forbidden), "");
        f
    })
    .await
    .unwrap();
    // 9) Серверной истории звонков v2 нет (D-08): таблица v1 calls пуста.
    let calls_db = std::fs::read(stack.dir.join("call.db")).unwrap_or_default();
    let mut f = res;
    f.check("no-call-history", !contains(&calls_db, format!("ca{p}@local").as_bytes()), "");
    assert!(f.0.is_empty(), "провалены сценарии звонков v2: {:?} (логи: {})", f.0, stack.dir.display());
}

// ── T077/T122: эфемерные каналы ──────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn us2_ephemeral_live() {
    let Some((stack, _nc)) = start(None).await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let mut a = device(&addr, &format!("ea{p}@local"));
        let mut b = device(&addr, &format!("eb{p}@local"));
        let mut m = device(&addr, &format!("em{p}@local"));
        // 1) Личный typing: канал из ключей доставки обоих; знание id = право.
        let ch = EphChannel::direct_typing(&a.delivery_key, &b.delivery_key, 0).unwrap();
        let sub = mpb::EphemeralSubscribeRequest { channel_ids: vec![ch.id.to_vec()] }.encode_to_vec();
        f.check("typing-subscribe", b.c.call("ephemeral.subscribe", sub).is_ok(), "");
        let payload = ch.seal(&eph::typing(&a.user, TypingAction::Typing, now_ms())).unwrap();
        let r = a.c.call("ephemeral.typing", mpb::EphemeralTypingRequest { channel_id: ch.id.to_vec(), payload: payload.clone() }.encode_to_vec());
        f.check("typing-publish", r.is_ok(), &r);
        let ev = b.c.event("ephemeral", Duration::from_secs(5));
        let got = ev.and_then(|e| mpb::EphemeralTypingRequest::decode(e.body.as_slice()).ok()).and_then(|t| ch.open(&t.payload).ok());
        f.check("typing-received", got.as_ref().and_then(|g| g.from.as_ref()).is_some_and(|u| u.address == a.user), &got);
        // Посторонний, не знающий ключа, подсунул мусор в канал — у Боба не расшифруется.
        let _ = m.c.call("ephemeral.typing", mpb::EphemeralTypingRequest { channel_id: ch.id.to_vec(), payload: vec![1; 60] }.encode_to_vec());
        let junk = b.c.event("ephemeral", Duration::from_secs(3)).and_then(|e| mpb::EphemeralTypingRequest::decode(e.body.as_slice()).ok());
        f.check("forged-typing-not-decrypted", junk.is_some_and(|t| ch.open(&t.payload).is_err()), "");
        // 2) Присутствие — только в свой канал.
        let pres = EphChannel::presence(&a.delivery_key, 0).unwrap();
        let pp = pres.seal(&eph::presence(&a.user, true, 0, now_ms())).unwrap();
        f.check("presence-own", a.c.call("ephemeral.presence", mpb::EphemeralPresenceRequest { channel_id: pres.id.to_vec(), payload: pp.clone() }.encode_to_vec()).is_ok(), "");
        f.check("presence-foreign-forbidden", b.c.call("ephemeral.presence", mpb::EphemeralPresenceRequest { channel_id: pres.id.to_vec(), payload: pp.clone() }.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        f.check("typing-into-presence-forbidden", b.c.call("ephemeral.typing", mpb::EphemeralTypingRequest { channel_id: pres.id.to_vec(), payload: pp }.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // 3) «Печатает» в группе: ANON, подпись ключом отправки эпохи (D-07).
        let mut g = create_group(&mut a, &[&b]);
        let send = parvane_protocol::sign::generate_signing_key();
        g.append(&mut a, Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec() }), 100_000).expect("epoch 1");
        let env_key = [9u8; 32];
        let gch = EphChannel::group_typing(&env_key, &g.state.group, 1).unwrap();
        f.check("group-typing-subscribe", b.c.call("ephemeral.subscribe", mpb::EphemeralSubscribeRequest { channel_ids: vec![gch.id.to_vec()] }.encode_to_vec()).is_ok(), "");
        let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
        let req = group_typing_req(&send, &g.state.group, 1, &gch, &a.user);
        let r = an.call("ephemeral.group_typing", req.encode_to_vec());
        f.check("group-typing-anon", r.is_ok(), &r);
        let ev = b.c.event("ephemeral", Duration::from_secs(5));
        let got = ev.and_then(|e| mpb::EphemeralTypingRequest::decode(e.body.as_slice()).ok()).and_then(|t| gch.open(&t.payload).ok());
        f.check("group-typing-received", got.and_then(|g| g.from).is_some_and(|u| u.address == a.user), "");
        f.check("group-typing-replay", an.call("ephemeral.group_typing", req.encode_to_vec()) == Err(ErrorCode::Duplicate), "");
        // Ложный typing в чужой чат: посторонний (не участник эпохи) — своим ключом → FORBIDDEN.
        let mallory = parvane_protocol::sign::generate_signing_key();
        let forged = group_typing_req(&mallory, &g.state.group, 1, &gch, &m.user);
        f.check("false-typing-foreign-group", an.call("ephemeral.group_typing", forged.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        let wrong_epoch = group_typing_req(&send, &g.state.group, 2, &gch, &a.user);
        f.check("group-typing-wrong-epoch", an.call("ephemeral.group_typing", wrong_epoch.encode_to_vec()) == Err(ErrorCode::Expired), "");
        let unknown = group_typing_req(&send, &Ref { domain: "local".into(), id: vec![1; 16] }, 1, &gch, &a.user);
        f.check("group-typing-unknown-group", an.call("ephemeral.group_typing", unknown.encode_to_vec()) == Err(ErrorCode::NotFound), "");
        // Через идентифицированную сессию — нельзя (иначе автор связывается с сессией).
        f.check("group-typing-in-id", a.c.call("ephemeral.group_typing", group_typing_req(&send, &g.state.group, 1, &gch, &a.user).encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // Смена состава без новой эпохи: ключ мог остаться у исключённого → EXPIRED.
        g.append(&mut a, Change::AddMember(AddMember { member: Some(UserRef { address: m.user.clone() }) }), 100_001).expect("add m");
        f.check("group-typing-stale-epoch", an.call("ephemeral.group_typing", group_typing_req(&send, &g.state.group, 1, &gch, &a.user).encode_to_vec()) == Err(ErrorCode::Expired), "");
        // L2: движок не отдаёт каналы.
        f.check("l2-no-ephemeral", !eph::allowed(true), "");
        let _ = &mut m;
        f
    })
    .await
    .unwrap();
    assert!(res.0.is_empty(), "провалены сценарии эфемерных каналов: {:?} (логи: {})", res.0, stack.dir.display());
}

/// Новая эпоха от владельца. Сервер ограничивает смену эпохи 1 раз в 10 с
/// по своим часам — между эпохами ждём.
fn next_epoch(g: &mut G, a: &mut Dev, f: &mut Failures, name: &str, epoch: &mut u64, ts: &mut i64) -> ed25519_dalek::SigningKey {
    if *epoch > 0 {
        std::thread::sleep(Duration::from_millis(10_300));
    }
    *epoch += 1;
    *ts += 20_000;
    let k = parvane_protocol::sign::generate_signing_key();
    let r = g.append(a, Change::NewEpoch(NewEpoch { epoch: *epoch, send_public_key: k.verifying_key().to_bytes().to_vec() }), *ts);
    f.check(name, r.is_ok(), &r);
    k
}

// ── T069: SC-003a — бан/мьют/исключение → отказ со следующей эпохи ──────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn us2_group_epochs_live() {
    let Some((stack, _nc)) = start(None).await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let mut a = device(&addr, &format!("ga{p}@local"));
        let b = device(&addr, &format!("gb{p}@local"));
        let c = device(&addr, &format!("gc{p}@local"));
        let d = device(&addr, &format!("gd{p}@local"));
        let e = device(&addr, &format!("ge{p}@local"));
        let mut g = create_group(&mut a, &[&b, &c, &d, &e]);
        let env_key = [5u8; 32];
        let mut epoch = 0u64;
        let mut ts = 100_000i64;
        let mut key = next_epoch(&mut g, &mut a, &mut f, "epoch-1", &mut epoch, &mut ts);
        let ok = group::seal_envelope(&key, &env_key, &g.state.group, 1, &inner_of(1)).unwrap();
        f.check("member-writes-epoch-1", deliver_group(&addr, &ok).is_ok(), "");
        let cases: [(&str, &Dev, Change); 3] = [
            ("ban", &c, Change::Ban(Ban { member: Some(UserRef { address: c.user.clone() }) })),
            ("mute", &d, Change::Mute(Mute { member: Some(UserRef { address: d.user.clone() }), until_ms: 4_000_000_000_000 })),
            ("remove", &e, Change::RemoveMember(RemoveMember { member: Some(UserRef { address: e.user.clone() }) })),
        ];
        for (name, victim, change) in cases {
            let old_key = key.clone();
            let old_epoch = epoch;
            ts += 1;
            let r = g.append(&mut a, change, ts);
            f.check(&format!("{name}-append"), r.is_ok(), &r);
            // Клиенты (движок) перестают принимать автора сразу — со следующей операции.
            f.check(&format!("{name}-engine-cannot-write"), !g.state.can_write(&victim.user, now_ms()) && g.state.epoch_stale, "");
            // Анонимный «печатает» старым ключом до новой эпохи → EXPIRED (эпоха устарела).
            let gch = EphChannel::group_typing(&env_key, &g.state.group, old_epoch).unwrap();
            let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
            f.check(&format!("{name}-typing-stale"), an.call("ephemeral.group_typing", group_typing_req(&old_key, &g.state.group, old_epoch, &gch, &victim.user).encode_to_vec()) == Err(ErrorCode::Expired), "");
            // Известное окно: до публикации новой эпохи messenger ещё принимает
            // конверт старым ключом (deliver_group не смотрит epoch_stale);
            // честные клиенты его отвергают (движок: автор не вправе писать).
            let gap = deliver_group(&addr, &group::seal_envelope(&old_key, &env_key, &g.state.group, old_epoch, &inner_of(2)).unwrap());
            eprintln!("NOTE {name}: deliver_group старым ключом до новой эпохи → {:?}", gap.as_ref().map(|_| "принят"));
            key = next_epoch(&mut g, &mut a, &mut f, &format!("{name}-new-epoch"), &mut epoch, &mut ts);
            // Следующая операция исключённого: конверт ключом старой эпохи.
            let stale = group::seal_envelope(&old_key, &env_key, &g.state.group, old_epoch, &inner_of(3)).unwrap();
            f.check(&format!("{name}-old-epoch-expired"), deliver_group(&addr, &stale) == Err(ErrorCode::Expired), "");
            // Старым ключом, выдав себя за новую эпоху → FORBIDDEN.
            let spoof = group::seal_envelope(&old_key, &env_key, &g.state.group, epoch, &inner_of(4)).unwrap();
            f.check(&format!("{name}-old-key-new-epoch-forbidden"), deliver_group(&addr, &spoof) == Err(ErrorCode::Forbidden), "");
            // Оставшийся участник (b) с новым ключом пишет.
            let fresh = group::seal_envelope(&key, &env_key, &g.state.group, epoch, &inner_of(5)).unwrap();
            f.check(&format!("{name}-writer-new-epoch-ok"), deliver_group(&addr, &fresh).is_ok(), "");
        }
        let _ = (&b, &c, &d, &e);
        f
    })
    .await
    .unwrap();
    assert!(res.0.is_empty(), "провалены сценарии эпох (SC-003a): {:?} (логи: {})", res.0, stack.dir.display());
}

// ── T070/T120: гигиена анонимного канала ─────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn us2_anon_hygiene_live() {
    use futures::StreamExt;
    let Some((stack, nc)) = start(None).await else { return };
    let addr = stack.gateway_tcp.clone();
    // Слушатель шины: копии ShardRequest ANON-методов (шарды подписаны без
    // очереди, поэтому видны и тесту).
    let mut taps = vec![];
    for name in ["msg.deliver_sealed", "call.signal_sealed", "msg.deliver_group"] {
        taps.push(nc.subscribe(parvane_protocol::schema::method(name).unwrap().subject.to_string()).await.unwrap());
    }
    let mut tap = futures::stream::select_all(taps);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(m) = tap.next().await {
            let _ = tx.send(m.payload.to_vec());
        }
    });
    let gw_log = stack.dir.join("gateway.log");
    let offset = std::fs::metadata(&gw_log).map(|m| m.len()).unwrap_or(0);
    let p = free_port();
    let (f, sender, token, ports) = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let a = device(&addr, &format!("ha{p}@local"));
        let mut b = device(&addr, &format!("hb{p}@local"));
        let bob = b.user.clone();
        let mut ports = vec![];
        let bun = bundle(&addr, &bob);
        let (dr, hpke, ident, otk) = bun[0].clone();
        let mut s = a.acc.outbound(&ident, &otk).unwrap();
        let mut accepted = 0;
        // 100 sealed-отправок: новое анонимное соединение на каждые 10 (серия ≤ 60 с).
        for chunk in 0..10 {
            let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
            ports.push(an.local_port());
            for i in 0..10 {
                let op = emsg::sign_direct(&a.acc, &text(&format!("m{chunk}-{i}")), &bob, vec![dr.clone()], 1).unwrap();
                let inner = emsg::seal_inner(&a.cert, &mut s, &op).unwrap();
                let env = seal::seal(&dr, &hpke, Access::DeliveryKey(b.delivery_key.clone()), inner, false).unwrap();
                if an.call("msg.deliver_sealed", mpb::DeliverSealedRequest { envelopes: vec![env] }.encode_to_vec()).is_ok() {
                    accepted += 1;
                }
            }
        }
        f.check("100-sealed-accepted", accepted == 100, accepted);
        f.check("100-in-journal", sync(&mut b, 0).iter().filter(|r| matches!(&r.item, Some(inbox_record::Item::Sealed(_)))).count() == 100, "");
        // Пакет «Боб + свои устройства» → INVALID уже в gateway.
        let mut mixed = seal_msg(&addr, &a, &bob, Access::DeliveryKey(b.delivery_key.clone()), &text("x"));
        let mut own = mixed.envelopes[0].clone();
        own.recipient = Some(a.dev.clone());
        mixed.envelopes.push(own);
        f.check("mixed-bob-and-own", V2::connect(&addr, Channel::AnonymousDelivery).call("msg.deliver_sealed", mixed.encode_to_vec()) == Err(ErrorCode::Invalid), "");
        // ANON-метод в ID-сессии → FORBIDDEN; подписка в ANON → FORBIDDEN.
        let mut ac = a.c;
        f.check("anon-in-id", ac.call("msg.deliver_sealed", mixed.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
        f.check("no-subscribe-in-anon", an.call("msg.inbox.subscribe", vec![]) == Err(ErrorCode::Forbidden) && an.call("ephemeral.subscribe", vec![]) == Err(ErrorCode::Forbidden), "");
        // Auth в анонимном соединении не принимается.
        an.send(frame::Kind::Auth(Auth { token: a.token.clone() }));
        let rej = matches!(an.recv().and_then(|x| x.kind), Some(frame::Kind::Response(r)) if matches!(r.result, Some(response::Result::Error(_))));
        f.check("no-auth-in-anon", rej, "");
        let _ = &a.hpke_pk;
        (f, a.user, a.token, ports)
    })
    .await
    .unwrap();
    let mut f = f;
    // В шину не ушли ни токен, ни адрес отправителя; поля личности пусты.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut n = 0;
    let mut clean = true;
    while let Ok(b) = rx.try_recv() {
        n += 1;
        let r = ShardRequest::decode(b.as_slice()).unwrap_or_default();
        clean &= r.user.is_empty() && r.device_id.is_empty() && r.token.is_empty() && r.client_ip.is_empty();
        clean &= !contains(&b, sender.as_bytes()) && !contains(&b, token.as_bytes());
    }
    f.check("bus-anon-requests-clean", clean && n >= 100, n);
    // Журнал gateway info+ после отправок: ни IP, ни портов анонимных соединений.
    let log = std::fs::read(&gw_log).unwrap_or_default();
    let tail = String::from_utf8_lossy(&log[offset as usize..]).to_string();
    let leaked_ip = tail.contains("127.0.0.1");
    let leaked_port = ports.iter().any(|p| tail.contains(&format!(":{p}")));
    f.check("no-ip-in-gateway-log", !leaked_ip && !leaked_port, &tail.lines().filter(|l| l.contains("127.0.0.1")).take(3).collect::<Vec<_>>());
    assert!(f.0.is_empty(), "провалены сценарии гигиены анонимного канала: {:?} (логи: {})", f.0, stack.dir.display());
}

// ── T068: генератор для scripts/protocol_sender_leak_check.sh ───────────────

/// Ключи устройства отправителя (сырые; кодировки hex/base64 строит скрипт).
fn key_needles(d: &Dev) -> Vec<Vec<u8>> {
    vec![d.acc.ed25519().to_vec(), d.acc.curve25519().to_vec(), d.hpke_pk.to_vec(), d.root.root_pub().to_vec()]
}

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Генерация: 100 личных sealed + 100 групповых (реальный Megolm) + сигналы
/// звонка, затем стек останавливается, БД и логи остаются в `PARVANE_LEAK_DIR`,
/// рядом `manifest.json` с иглами для поиска. Запуск — из скрипта.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "запускается scripts/protocol_sender_leak_check.sh"]
async fn leak_generate() {
    let Some(dir) = std::env::var_os("PARVANE_LEAK_DIR").map(PathBuf::from) else {
        eprintln!("SKIP: нужен PARVANE_LEAK_DIR");
        return;
    };
    let _ = std::fs::remove_dir_all(&dir);
    let Some((mut stack, _nc)) = start(Some(dir.clone())).await else { return };
    let addr = stack.gateway_tcp.clone();
    let d2 = dir.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        let p = free_port();
        // Подготовка (идентифицированные сессии — до отметки).
        let mut alice = device(&addr, &format!("leakalice{p}@local"));
        let mut bob = device(&addr, &format!("leakbob{p}@local"));
        let mut carol = device(&addr, &format!("leakcarol{p}@local"));
        let mut owner = device(&addr, &format!("leakowner{p}@local"));
        let mut g = create_group(&mut owner, &[&carol, &bob]);
        let send = parvane_protocol::sign::generate_signing_key();
        g.append(&mut owner, Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec() }), 100_000).expect("epoch");
        let env_key = [0x5a_u8; 32];
        let bob_dk = bob.delivery_key.clone();
        let bun = bundle(&addr, &bob.user);
        let tokens = vec![alice.token.clone(), carol.token.clone()];
        let senders_personal = (alice.user.clone(), key_needles(&alice));
        let senders_group = (carol.user.clone(), key_needles(&carol));
        // Отправители закрывают свои ID-сессии до отметки: дальше — только ANON.
        let alice_c = std::mem::replace(&mut alice.c, V2::connect(&addr, Channel::AnonymousDelivery));
        drop(alice_c);
        let carol_c = std::mem::replace(&mut carol.c, V2::connect(&addr, Channel::AnonymousDelivery));
        drop(carol_c);
        std::thread::sleep(Duration::from_millis(500));
        // Отметка: смещения логов — скрипт смотрит только то, что после неё.
        let mut offsets = serde_json::Map::new();
        for n in ["gateway.log", "identity.log", "messenger.log", "call.log", "nats.log"] {
            let len = std::fs::metadata(d2.join(n)).map(|m| m.len()).unwrap_or(0);
            offsets.insert(n.to_string(), serde_json::json!(len));
        }
        // 1) 100 личных sealed alice → bob.
        let mut sessions: Vec<_> = bun.iter().map(|(dr, hpke, ident, otk)| (dr.clone(), *hpke, alice.acc.outbound(ident, otk).unwrap())).collect();
        let mut personal = 0;
        for chunk in 0..10 {
            let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
            for i in 0..10 {
                let mut envelopes = vec![];
                for (dr, hpke, s) in sessions.iter_mut() {
                    let op = emsg::sign_direct(&alice.acc, &text(&format!("секрет {chunk}-{i}")), &bob.user, vec![dr.clone()], now_ms()).unwrap();
                    let inner = emsg::seal_inner(&alice.cert, s, &op).unwrap();
                    envelopes.push(seal::seal(dr, hpke, Access::DeliveryKey(bob_dk.clone()), inner, false).unwrap());
                }
                if an.call("msg.deliver_sealed", mpb::DeliverSealedRequest { envelopes }.encode_to_vec()).is_ok() {
                    personal += 1;
                }
            }
        }
        // 2) Сигналы звонка alice → bob (D-08: без истории на сервере).
        let call_id = [0x42u8; 16];
        let offer = cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Offer(cpb::Offer { sdp: "v=0 leak-offer".into(), ..Default::default() })), group_call_id: vec![] };
        let mut calls = 0;
        let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
        for i in 0..10 {
            let signal = if i == 0 {
                offer.clone()
            } else {
                cpb::CallSignal { call_id: call_id.to_vec(), signal: Some(cpb::call_signal::Signal::Ice(cpb::IceCandidate { candidate: format!("candidate:{i} 1 udp 1 10.0.0.{i} 5000 typ host"), sdp_mid: "0".into(), sdp_mline_index: 0 })), group_call_id: vec![] }
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
        // 3) 100 групповых carol → группа (реальный Megolm, session_id под AEAD эпохи).
        let mut megolm = MegolmOutbound::new();
        let session_id = megolm.session_id();
        let mut grp = 0;
        for chunk in 0..10 {
            let mut an = V2::connect(&addr, Channel::AnonymousDelivery);
            for i in 0..10 {
                let op = emsg::sign_group(&carol.acc, &text(&format!("группа {chunk}-{i}")), g.state.context(), now_ms()).unwrap();
                let pt = emsg::group_plaintext(&carol.cert, op);
                let inner = GroupEnvelopeInner { megolm_session_id: session_id.as_bytes().to_vec(), megolm_message: megolm.encrypt(&pt), padding: vec![] };
                let env = group::seal_envelope(&send, &env_key, &g.state.group, 1, &inner).unwrap();
                if an.call("msg.deliver_group", mpb::DeliverGroupRequest { envelope: Some(env) }.encode_to_vec()).is_ok() {
                    grp += 1;
                }
            }
        }
        // Получатель синхронизирует журнал (идентифицированно — это он сам).
        let recs = sync(&mut bob, 0);
        let groups: Vec<_> = recs
            .iter()
            .filter_map(|r| match &r.item {
                Some(inbox_record::Item::Group(e)) => Some(e.clone()),
                _ => None,
            })
            .collect();
        // D-07: в том, что хранит сервер, нет общего для сообщений одного автора
        // идентификатора: ни одно 12-байтовое окно шифртекста/nonce/подписи не
        // повторяется в двух разных конвертах.
        let mut seen: HashMap<Vec<u8>, usize> = HashMap::new();
        let mut repeated = 0;
        for (i, e) in groups.iter().enumerate() {
            let mut blob = e.epoch_aead_ciphertext.clone();
            blob.extend_from_slice(&e.envelope_nonce);
            blob.extend_from_slice(&e.epoch_signature);
            let mut mine = std::collections::HashSet::new();
            for w in blob.windows(12) {
                if !mine.insert(w.to_vec()) {
                    continue;
                }
                match seen.get(w) {
                    Some(j) if *j != i => repeated += 1,
                    _ => {
                        seen.insert(w.to_vec(), i);
                    }
                }
            }
        }
        let opened = recs.iter().filter(|r| matches!(&r.item, Some(inbox_record::Item::Sealed(_)))).count();
        let needles = |v: &Vec<Vec<u8>>| v.iter().map(|x| hexs(x)).collect::<Vec<_>>();
        // Строка session_id (base64); сырые байты скрипт получает декодированием.
        let sid_needles = vec![session_id.as_bytes().to_vec()];
        let _ = (&owner, &g.owners);
        serde_json::json!({
            "personal_sent": personal,
            "group_sent": grp,
            "call_signals": calls,
            "sealed_in_recipient_journal": opened,
            "group_in_recipient_journal": groups.len(),
            "group_repeated_windows": repeated,
            "log_offsets": offsets,
            "personal_sender": { "address": senders_personal.0, "keys_hex": needles(&senders_personal.1) },
            "group_sender": { "address": senders_group.0, "keys_hex": needles(&senders_group.1) },
            "tokens": tokens,
            "megolm_session_ids_hex": needles(&sid_needles),
            "megolm_session_ids": [session_id],
            "catalog_dbs": ["identity.db", "identity.db-v2.db"],
            "membership_tables": ["group_state_log", "group_members_v2", "group_join_requests_v2"],
        })
    })
    .await
    .unwrap();
    stack.stop();
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    eprintln!("leak_generate: {}", dir.display());
    assert_eq!(manifest["personal_sent"], 100);
    assert_eq!(manifest["group_sent"], 100);
}
