//! spec 035 T032 (US2): журнал личного состояния v2 против живого стека — `state.ops.append` (seq на
//! пользователя, повтор с теми же байтами → прежний seq, другие байты при том же op_id → `DUPLICATE`,
//! детерминированный шифртекст повтора с двух устройств → один seq), живое `JournalNotice{STATE}` прочим
//! устройствам, `state.ops.sync` (курсор, бюджет), сведение правок разных полей с двух устройств (`state2`),
//! изоляция чужого пользователя. Прежний журнал `state.v1` удалён (T149).
//!
//! Помощники стека скопированы из `v2_history_live.rs`. Без `nats-server` тест печатает SKIP и проходит.

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::Client;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2 as mpb;
use parvane_protocol::pb::parvane::state::v1::Folder;
use parvane_protocol::pb::parvane::state::v2::{
    state_op::Op, AppendRequest, AppendResponse, FieldValue, ObjectKey, ObjectKind, Patch, StateOp, SyncRequest, SyncResponse,
};
use parvane_protocol::state::{self as st, StateKey};
use parvane_protocol::state2::{self, State2};
use prost::Message;

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
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("v2.server.describe", vec![].into())).await;
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

/// Войти вторым устройством (без личности; её даёт `join_with_ssk`).
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
    let client = Client::new(user, device_id, &domain).unwrap();
    Device { client, id, anon, server_key, domain }
}

fn append(c: &mut Conn, method: &str, r: &AppendRequest) -> Result<u64, ErrorCode> {
    c.call(method, r.encode_to_vec()).map(|b| AppendResponse::decode(b.as_slice()).unwrap_or_default().seq)
}

fn sync(c: &mut Conn, after_seq: u64, max_bytes: u32) -> Result<SyncResponse, ErrorCode> {
    c.call("state.ops.sync", SyncRequest { after_seq, max_bytes }.encode_to_vec()).map(|b| SyncResponse::decode(b.as_slice()).unwrap_or_default())
}

fn patch(op_id: [u8; 16], lamport: u64, device: &str, folder: &str, field: u32, text: &str) -> StateOp {
    let mut value = Vec::new();
    prost::encoding::encode_key(field, prost::encoding::WireType::LengthDelimited, &mut value);
    prost::encoding::encode_varint(text.len() as u64, &mut value);
    value.extend_from_slice(text.as_bytes());
    StateOp {
        op_id: op_id.to_vec(),
        lamport,
        device_id: device.into(),
        ts_ms: 0,
        op: Some(Op::Patch(Patch { object: Some(ObjectKey { kind: ObjectKind::Folder as i32, key: folder.into() }), set: vec![FieldValue { field, value }], clear: vec![] })),
    }
}

/// Ждать живое уведомление журнала в инбоксе устройства.
fn journal_notice(d: &mut Device, timeout: Duration) -> Option<mpb::JournalNotice> {
    d.id.s.set_read_timeout(Some(timeout)).ok()?;
    let deadline = Instant::now() + timeout;
    let mut found = None;
    while Instant::now() < deadline {
        let Some(e) = d.id.next_event() else { break };
        if e.kind != "inbox.record" {
            continue;
        }
        let Ok(rec) = mpb::InboxRecord::decode(e.body.as_slice()) else { continue };
        if let Some(mpb::inbox_record::Item::Journal(j)) = rec.item {
            found = Some(j);
            break;
        }
    }
    let _ = d.id.s.set_read_timeout(Some(Duration::from_secs(10)));
    found
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_state2_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let n = free_port();
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let (alice, bob) = (format!("s2a{n}@local"), format!("s2b{n}@local"));
        let mut d1 = Device::register(&addr, &alice, "d1");
        let mut d2 = login(&addr, &alice, "d2");
        let (ssk, entries, dk, gen) = d1.client.link_grant_material().unwrap();
        let reqs = d2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
        d2.run(&reqs).expect("d2 в журнале устройств");
        let mut b = Device::register(&addr, &bob, "b1");
        f.check("subscribe-d1", d1.id.call("msg.inbox.subscribe", vec![]).is_ok(), "");
        f.check("subscribe-d2", d2.id.call("msg.inbox.subscribe", vec![]).is_ok(), "");
        let key = StateKey::generate();

        // ── state.ops.append: seq, идемпотентность повтора, DUPLICATE, живое уведомление ──
        let op1 = patch(st::new_op_id(), 1, "d1", "5", 2, "Дела");
        let op2 = patch(st::new_op_id(), 1, "d2", "5", 3, "📌");
        let r1 = state2::seal_op(&key, &alice, &op1).unwrap();
        let r2 = state2::seal_op(&key, &alice, &op2).unwrap();
        f.check("append-1", append(&mut d1.id, "state.ops.append", &r1) == Ok(1), "");
        let j = journal_notice(&mut d2, Duration::from_secs(5));
        f.check("notice-state-to-other-device", j.as_ref().is_some_and(|j| j.kind == mpb::JournalKind::State as i32 && j.seq == 1), &j);
        f.check("append-2", append(&mut d2.id, "state.ops.append", &r2) == Ok(2), "");
        f.check("append-retry-same-bytes", append(&mut d2.id, "state.ops.append", &r1) == Ok(1), "");
        // Повтор неотправленной записи с двух устройств (детерминированный шифртекст) — те же байты, тот же seq
        let rep = patch(st::new_op_id(), 3, "d1", "6", 2, "повтор");
        let rep_pt = rep.encode_to_vec();
        let m1 = state2::seal_raw_deterministic(&key, &alice, &rep.op_id, &rep_pt).unwrap();
        let m2 = state2::seal_raw_deterministic(&key, &alice, &rep.op_id, &rep_pt).unwrap();
        f.check("retry-bytes-equal", m1 == m2, "");
        f.check("retry-d1", append(&mut d1.id, "state.ops.append", &m1) == Ok(3), "");
        f.check("retry-d2-same-seq", append(&mut d2.id, "state.ops.append", &m2) == Ok(3), "");
        let mut forged = r1.clone();
        forged.aead_ciphertext[20] ^= 1;
        f.check("same-opid-other-bytes-duplicate", append(&mut d1.id, "state.ops.append", &forged) == Err(ErrorCode::Duplicate), "");
        let short = AppendRequest { op_id: st::new_op_id().to_vec(), aead_ciphertext: vec![0; 8] };
        f.check("short-ct-invalid", append(&mut d1.id, "state.ops.append", &short) == Err(ErrorCode::Invalid), "");

        // ── state.ops.sync: второе устройство сводит обе правки разных полей ──
        let s = sync(&mut d2.id, 0, 0);
        let seqs: Vec<u64> = s.as_ref().map(|s| s.records.iter().map(|r| r.seq).collect()).unwrap_or_default();
        f.check("sync-all", seqs == vec![1, 2, 3] && s.as_ref().is_ok_and(|s| !s.more), &s);
        let mut state = State2::new();
        for r in s.as_ref().map(|s| s.records.clone()).unwrap_or_default() {
            match state2::open(&key, &alice, &r.op_id, &r.aead_ciphertext) {
                Ok(pt) => f.check("apply", state.apply_bytes(&pt).is_ok(), ""),
                Err(e) => f.check("open-record", false, e),
            }
        }
        let view = state.view();
        let folder5 = view.iter().find(|o| o.key == "5").map(|o| Folder::decode(o.value.as_slice()).unwrap_or_default());
        f.check("both-fields-kept", folder5.as_ref().is_some_and(|f| f.title == "Дела" && f.emoticon == "📌"), &folder5);
        let s = sync(&mut d1.id, 1, 0);
        f.check("sync-cursor", s.as_ref().is_ok_and(|s| s.records.first().map(|r| r.seq) == Some(2)), &s);
        let s = sync(&mut d1.id, 0, 10);
        f.check("sync-budget", s.as_ref().is_ok_and(|s| s.records.len() == 1 && s.more), &s);

        // ── изоляция пользователей ──
        let s = sync(&mut b.id, 0, 0);
        f.check("other-user-empty", s.as_ref().is_ok_and(|s| s.records.is_empty()), &s);
        f.check("record-bound-to-user", state2::open(&key, &bob, &r1.op_id, &r1.aead_ciphertext).is_err(), "");

        f.0
    })
    .await
    .unwrap();
    assert!(res.is_empty(), "провалены: {res:?}");
    drop(stack);
}
