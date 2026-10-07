//! Личное состояние v2 против живого стека (spec 007, US5: T096).
//! `state.append` с двух устройств одного пользователя, `state.sync` с
//! курсором и бюджетом, изоляция чужого пользователя; согласие на добавление
//! в группы из `identity.privacy.set` для v1-кода messenger (FR-040).
//!
//! Помощники скопированы из `v2_live.rs`. Без `nats-server` тест печатает SKIP
//! и проходит.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{frame, response, Auth, Channel, ErrorCode, Frame, Hello, Request};
use parvane_protocol::pb::parvane::identity::v2::{Audience, PrivacySetRequest, PrivacySettings};
use parvane_protocol::pb::parvane::state::v1::{peer, state_op::Op, AppendRequest, AppendResponse, BlockEntry, Peer, SyncRequest, SyncResponse};
use parvane_protocol::pb::parvane::core::v2::UserRef;
use parvane_protocol::state::{self as st, LamportClock, PersonalState, StateKey};
use prost::Message;
use serde_json::{json, Value};

const PASSWORD: &str = "e2e-Test-pass-2026";

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
        let _ = std::fs::remove_dir_all(&self.dir);
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
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

async fn start() -> Option<(Stack, async_nats::Client)> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2live-{}-{}", std::process::id(), free_port()));
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
    let id_db = dir.join("identity.db").to_string_lossy().to_string();
    let wk = dir.join("parvane.json").to_string_lossy().to_string();
    children.push(spawn(
        "identity",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &id_db), ("PARVANE_DEV", "1"), ("PARVANE_WELL_KNOWN_FILE", &wk)],
        &dir.join("identity.log"),
    ));
    let m_db = dir.join("messenger.db").to_string_lossy().to_string();
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db), ("PARVANE_GROUP_ENTRY_TS_WINDOW_MS", "0")], &dir.join("messenger.log")));
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_V2_FEATURES", "sealed"),
        ],
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp };
    let startt = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(startt.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("identity.server.info", "{}".into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(startt.elapsed() < Duration::from_secs(60), "identity не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("v2.msg.inbox.sync", vec![].into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(startt.elapsed() < Duration::from_secs(60), "messenger не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(
            startt.elapsed() < Duration::from_secs(60),
            "gateway не слушает; лог:\n{}",
            std::fs::read_to_string(stack.dir.join("gateway.log")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

async fn nreq(nc: &async_nats::Client, subject: &str, body: Value) -> Value {
    let r = nc.request(subject.to_string(), body.to_string().into()).await.unwrap();
    serde_json::from_slice(&r.payload).unwrap_or(Value::Null)
}

/// v2-клиент по TCP.
struct V2 {
    s: TcpStream,
    dec: TcpDecoder,
    next_id: u64,
}

impl V2 {
    fn connect(addr: &str, channel: Channel) -> (V2, Frame) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(TCP_MAGIC).unwrap();
        let mut c = V2 { s, dec: TcpDecoder::new(), next_id: 0 };
        c.send(frame::Kind::Hello(Hello { proto_minor: 0, channel: channel as i32, ..Default::default() }));
        let w = c.recv().expect("welcome");
        (c, w)
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
    /// Запрос → Ok(тело) | Err(код).
    fn call(&mut self, method: &str, body: Vec<u8>) -> Result<Vec<u8>, ErrorCode> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(frame::Kind::Request(Request { id, method: method.into(), body, timeout_ms: 5000 }));
        loop {
            let f = self.recv().expect("ответ");
            if let Some(frame::Kind::Response(r)) = f.kind {
                if r.id != id {
                    continue;
                }
                return match r.result {
                    Some(response::Result::Ok(b)) => Ok(b),
                    Some(response::Result::Error(e)) => Err(ErrorCode::try_from(e.code).unwrap()),
                    None => Err(ErrorCode::Unspecified),
                };
            }
        }
    }
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


/// Идентифицированная v2-сессия с токеном устройства.
fn session(addr: &str, token: &str) -> V2 {
    let (mut c, _) = V2::connect(addr, Channel::Identified);
    c.send(frame::Kind::Auth(Auth { token: token.to_string() }));
    let ok = matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_)));
    assert!(ok, "auth");
    c
}

async fn register(nc: &async_nats::Client, user: &str) {
    let r = nreq(nc, "identity.user.register", json!({"user": user, "password": PASSWORD, "invite": "", "email": "", "client_ip": "127.0.0.1"})).await;
    assert!(r["ok"] == true || r["error"].is_null(), "register {user}: {r}");
}

async fn token(nc: &async_nats::Client, user: &str, dev: &str) -> String {
    let t = nreq(nc, "identity.token.issue", json!({"user": user, "password": PASSWORD, "device_id": dev})).await;
    t["token"].as_str().unwrap_or("").to_string()
}

fn append(c: &mut V2, r: &AppendRequest) -> Result<u64, ErrorCode> {
    c.call("state.append", r.encode_to_vec()).map(|b| AppendResponse::decode(b.as_slice()).unwrap_or_default().seq)
}

fn sync(c: &mut V2, after_seq: u64, max_bytes: u32) -> Result<SyncResponse, ErrorCode> {
    c.call("state.sync", SyncRequest { after_seq, max_bytes }.encode_to_vec()).map(|b| SyncResponse::decode(b.as_slice()).unwrap_or_default())
}

fn set_group_add(addr: &str, token: &str, a: Audience) -> bool {
    let mut c = session(addr, token);
    let body = PrivacySetRequest { settings: Some(PrivacySettings { group_add: a as i32, messages_from_strangers: true, ..Default::default() }) }.encode_to_vec();
    c.call("identity.privacy.set", body).is_ok()
}

fn user_peer(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_state_live() {
    let Some((stack, nc)) = start().await else { return };
    let mut f = Failures(vec![]);
    let n = free_port();
    let (alice, bob, carol) = (format!("sa{n}@local"), format!("sb{n}@local"), format!("sc{n}@local"));
    for u in [&alice, &bob, &carol] {
        register(&nc, u).await;
    }
    let (ta1, ta2, tb) = (token(&nc, &alice, "dev1").await, token(&nc, &alice, "dev2").await, token(&nc, &bob, "devb").await);
    let tc = token(&nc, &carol, "devc").await;

    // ── state.append / state.sync ──
    let addr = stack.gateway_tcp.clone();
    let (alice2, bob2) = (alice.clone(), bob.clone());
    let a = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let (alice, bob) = (alice2, bob2);
        let mut a1 = session(&addr, &ta1);
        let mut a2 = session(&addr, &ta2);
        let mut b = session(&addr, &tb);
        let key = StateKey::generate();
        let mut clock1 = LamportClock::default();
        let mut clock2 = LamportClock::default();
        let op1 = st::make_op(&mut clock1, "dev1", 1, Op::BlockSet(BlockEntry { peer: Some(user_peer(&bob)), blocked_at_ms: 1 })).unwrap();
        let op2 = st::make_op(&mut clock2, "dev2", 2, Op::BlockSet(BlockEntry { peer: Some(user_peer("eve@local")), blocked_at_ms: 2 })).unwrap();
        let r1 = st::seal_op(&key, &alice, &op1).unwrap();
        let r2 = st::seal_op(&key, &alice, &op2).unwrap();
        f.check("append-dev1", append(&mut a1, &r1) == Ok(1), "");
        f.check("append-dev2", append(&mut a2, &r2) == Ok(2), "");
        f.check("append-retry-idempotent", append(&mut a2, &r1) == Ok(1), "");
        let mut forged = r1.clone();
        forged.aead_ciphertext[20] ^= 1;
        f.check("append-same-opid-other-ct", append(&mut a1, &forged) == Err(ErrorCode::Duplicate), "");
        let bad = AppendRequest { op_id: vec![1; 16], aead_ciphertext: r1.aead_ciphertext.clone() };
        f.check("append-bad-opid", append(&mut a1, &bad) == Err(ErrorCode::Invalid), "");
        let short = AppendRequest { op_id: st::new_op_id().to_vec(), aead_ciphertext: vec![0; 8] };
        f.check("append-short-ct", append(&mut a1, &short) == Err(ErrorCode::Invalid), "");

        // Второе устройство видит обе записи и сводит их ключом состояния.
        let s = sync(&mut a2, 0, 0);
        let seqs: Vec<u64> = s.as_ref().map(|s| s.records.iter().map(|r| r.seq).collect()).unwrap_or_default();
        f.check("sync-all", seqs == vec![1, 2] && s.as_ref().is_ok_and(|s| !s.more), &s);
        let mut state = PersonalState::new();
        for r in s.as_ref().map(|s| s.records.clone()).unwrap_or_default() {
            match st::open_state_record(&key, &alice, &r) {
                Ok(op) => {
                    let _ = state.apply(&op);
                }
                Err(e) => f.check("open-record", false, e),
            }
        }
        f.check("merged-blocklist", state.snapshot().blocked.len() == 2, state.snapshot().blocked);
        let s = sync(&mut a1, 1, 0);
        f.check("sync-cursor", s.as_ref().is_ok_and(|s| s.records.len() == 1 && s.records[0].seq == 2 && s.records[0].op_id == r2.op_id), &s);
        let s = sync(&mut a1, 0, 10);
        f.check("sync-budget-page", s.as_ref().is_ok_and(|s| s.records.len() == 1 && s.more), &s);
        let s = sync(&mut a1, 2, 0);
        f.check("sync-tail-empty", s.as_ref().is_ok_and(|s| s.records.is_empty() && !s.more), &s);

        // Чужой пользователь не видит журнал alice; у него свой seq.
        let s = sync(&mut b, 0, 0);
        f.check("other-user-empty", s.as_ref().is_ok_and(|s| s.records.is_empty()), &s);
        let rb = st::seal_op(&key, &bob, &op1).unwrap();
        f.check("other-user-own-seq", append(&mut b, &rb) == Ok(1), "");
        let s = sync(&mut b, 0, 0);
        f.check("other-user-sees-own", s.as_ref().is_ok_and(|s| s.records.len() == 1 && s.records[0].aead_ciphertext == rb.aead_ciphertext), &s);
        let s = sync(&mut a1, 0, 0);
        f.check("alice-unchanged", s.as_ref().is_ok_and(|s| s.records.len() == 2), &s);
        // Запись alice под чужим журналом не расшифровывается (AAD = user ‖ op_id).
        f.check("record-bound-to-user", st::open_record(&key, &bob, &r1.op_id, &r1.aead_ciphertext).is_err(), "");

        // Без входа — FORBIDDEN (ID-метод).
        let (mut anon, _) = V2::connect(&addr, Channel::Identified);
        f.check("sync-without-auth", sync(&mut anon, 0, 0).err() == Some(ErrorCode::Forbidden), "");
        let _ = alice;
        f
    })
    .await
    .unwrap();
    f.0.extend(a.0);

    // ── согласие на добавление в группы: identity.privacy.set → v1 group.addmember ──
    let g = nreq(&nc, "group.create", json!({"token": tc, "name": "privacy", "kind": "group", "members": []})).await;
    let gid = g["group_id"].as_str().unwrap_or("").to_string();
    f.check("group-created", !gid.is_empty(), &g);
    let add = |member: String| {
        let (nc, tc, gid) = (nc.clone(), tc.clone(), gid.clone());
        async move { nreq(&nc, "group.addmember", json!({"token": tc, "group_id": gid, "member": member})).await["ok"] == true }
    };
    let (addr, t) = (stack.gateway_tcp.clone(), token(&nc, &alice, "dev1").await);
    let set = tokio::task::spawn_blocking(move || set_group_add(&addr, &t, Audience::Nobody)).await.unwrap();
    f.check("privacy-set-nobody", set, "");
    f.check("v2-privacy-blocks-add", !add(alice.clone()).await, "");
    f.check("default-allows-add", add(bob.clone()).await, "");
    // Блоб настроек v1 (`msg.chat.setnotify`) больше не существует (T110): источник — только v2.
    assert!(f.0.is_empty(), "провалены сценарии state v2: {:?} (логи: {})", f.0, stack.dir.display());
}
