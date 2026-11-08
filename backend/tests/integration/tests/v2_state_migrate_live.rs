//! spec 035 T100 (US1, FR-063, research.md R9): разовый перенос журнала личного состояния против живого стека.
//! Два устройства аккаунта переносят замороженный журнал `state.v1` одновременно (шаги движков вперемешку через
//! свои сессии gateway) — в новом журнале `state.v2` одна копия каждого объекта и `Migrated{from_seq}` последней,
//! показ нового = снимку старого; третье устройство, обновившееся позже, читает уже перенесённый журнал и свой
//! перенос не пишет. Записи старого журнала кладутся в базу messenger напрямую: `state.append` с выпуска
//! отвергается. Помощники стека — из `v2_state2_live.rs`. Без `nats-server` тест печатает SKIP и проходит.

use std::collections::{BTreeMap, VecDeque};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::Client;
use parvane_protocol::migrate;
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, UserRef};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::state::v1::{self as v1pb, peer, Folder, Peer};
use parvane_protocol::pb::parvane::state::v2::{state_op::Op, SyncRequest, SyncResponse};
use parvane_protocol::state::{self as st, StateKey};
use parvane_protocol::state2::{self, State2};
use prost::Message;
use serde_json::{json, Value};

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
    match std::env::var("CARGO_TARGET_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d).join("debug"),
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug"),
    }
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
    let dir = std::env::temp_dir().join(format!("parvane-v2mig-{}-{}", std::process::id(), free_port()));
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
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
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
    for subject in ["v2.server.describe", "v2.msg.inbox.sync"] {
        loop {
            let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject, vec![].into())).await;
            if matches!(r, Ok(Ok(_))) {
                break;
            }
            assert!(startt.elapsed() < Duration::from_secs(60), "{subject}: шард не поднялся");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(startt.elapsed() < Duration::from_secs(60), "gateway не слушает");
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

fn chat(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn b64e(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default()
}

fn call(e: &mut Engine, name: &str, args: &Value) -> Value {
    let out: Value = serde_json::from_str(&e.call(name, &args.to_string())).unwrap();
    assert!(out.get("error").is_none(), "{name}: {out}");
    out
}

/// Хост движка одного устройства: хранилище в памяти, очередь итогов и запросов; запросы — через сессию устройства.
struct Mig {
    e: Engine,
    store: BTreeMap<String, Vec<u8>>,
    outs: Vec<Value>,
    reqs: VecDeque<Value>,
    ready: bool,
    appends: usize,
}

impl Mig {
    fn new(d: &Device, device_id: &str, export_key: &[u8; 32]) -> Mig {
        let cfg = json!({"user": d.client.user, "device_id": device_id, "domain": d.domain, "now_ms": "1800000000000", "device_key": b64e(&[9u8; 32]), "legacy_present": true});
        let mut e = Engine::open_json(&cfg.to_string()).unwrap();
        let start = call(&mut e, "start", &json!({}));
        let read_id = start["store_reads"][0]["read_id"].clone();
        let opened = call(&mut e, "storeLoaded", &json!({"read_id": read_id, "entries": []}));
        assert_eq!(opened["open"]["state"], "OPEN_STATE_MIGRATION_NEEDED", "{opened}");
        let blob = d.client.export(export_key).unwrap();
        let records = json!([
            {"key": "record:v2-engine-bin", "value": b64e(&blob)},
            {"key": "record:v2-storage-key", "value": b64e(export_key)},
        ]);
        let first = call(&mut e, "migrateStep", &json!({"layer": "web", "records": records, "last": true}));
        Mig { e, store: BTreeMap::new(), outs: vec![first], reqs: VecDeque::new(), ready: false, appends: 0 }
    }

    /// Один шаг: итог движка, либо один запрос серверу, либо следующий шаг переноса. false — делать нечего.
    fn step(&mut self, conn: &mut Conn) -> bool {
        if let Some(out) = self.outs.pop() {
            if out["open"]["state"] == "OPEN_STATE_READY" {
                self.ready = true;
            }
            if let Some(b) = out.get("store_batch").filter(|b| !b.is_null()) {
                for d in b["deletes"].as_array().into_iter().flatten() {
                    self.store.remove(d.as_str().unwrap());
                }
                for p in b["puts"].as_array().into_iter().flatten() {
                    self.store.insert(p["key"].as_str().unwrap().into(), b64d(p["value"].as_str().unwrap_or("")));
                }
                let id = b["batch_id"].clone();
                let c = call(&mut self.e, "storeCommitted", &json!({"batch_id": id}));
                self.outs.push(c);
            }
            for r in out["requests"].as_array().into_iter().flatten() {
                self.reqs.push_back(r.clone());
            }
            return true;
        }
        if let Some(r) = self.reqs.pop_front() {
            let method = r["method"].as_str().unwrap().to_string();
            if method == "state.ops.append" {
                self.appends += 1;
            }
            let (err, body) = match conn.call(&method, b64d(r["body"].as_str().unwrap_or(""))) {
                Ok(b) => (0, b),
                Err(c) => (c as i32, vec![]),
            };
            let o = call(&mut self.e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": r["req_id"], "body": b64e(&body), "error": err}));
            self.outs.push(o);
            return true;
        }
        if !self.ready {
            let o = call(&mut self.e, "migrateStep", &json!({}));
            let empty = o["store_batch"].is_null() && o["requests"].as_array().is_none_or(|a| a.is_empty()) && o["open"].is_null();
            self.outs.push(o);
            return !empty;
        }
        false
    }

    fn finish(&mut self, conn: &mut Conn) {
        for _ in 0..100_000 {
            if self.ready && self.outs.is_empty() && self.reqs.is_empty() {
                return;
            }
            if !self.step(conn) && !self.ready {
                panic!("перенос встал: {}", call(&mut self.e, "migrateStatus", &json!({})));
            }
        }
        panic!("перенос не закончился");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_state_migrate_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let db = stack.dir.join("messenger.db-v2.db");
    let n = free_port();
    let alice = format!("mig{n}@local");
    let key = StateKey::generate();
    let export_key = [0x3cu8; 32];
    // Три устройства аккаунта с одним ключом личного состояния
    let (d1, d2, d3) = {
        let (a, addr, key) = (alice.clone(), addr.clone(), key.clone());
        tokio::task::spawn_blocking(move || {
            let mut d1 = Device::register(&addr, &a, "d1");
            let mut d2 = login(&addr, &a, "d2");
            let mut d3 = login(&addr, &a, "d3");
            // Привязка по цепочке: у последнего привязанного устройства журнал устройств уже с ним самим
            let (ssk, entries, dk, gen) = d1.client.link_grant_material().unwrap();
            let reqs = d2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
            d2.run(&reqs).expect("d2 в журнале устройств");
            let (ssk, entries, dk, gen) = d2.client.link_grant_material().unwrap();
            let reqs = d3.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
            d3.run(&reqs).expect("d3 в журнале устройств");
            for d in [&mut d1, &mut d2, &mut d3] {
                d.client.set_state_key(key.clone(), 1);
            }
            (d1, d2, d3)
        })
        .await
        .unwrap()
    };
    // Замороженный журнал state.v1: записи прежнего выпуска (через state.append их уже не записать)
    let ops = vec![
        v1pb::state_op::Op::FolderSet(Folder { id: 2, title: "Работа".into(), include_peers: vec![chat("bob@local")], color: -1, ..Default::default() }),
        v1pb::state_op::Op::ArchiveSet(v1pb::PeerKey { peer: Some(chat("carol@local")) }),
        v1pb::state_op::Op::ContactSet(v1pb::Contact { user: Some(UserRef { address: "bob@local".into() }), first_name: "Боб".into(), note: "выдуманная".into(), ..Default::default() }),
        v1pb::state_op::Op::QuickReaction(v1pb::QuickReaction { emoji: "👍".into(), ..Default::default() }),
    ];
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect(&format!("sqlite://{}", db.display())).await.unwrap();
    let mut old = st::PersonalState::new();
    for (i, k) in ops.into_iter().enumerate() {
        let op = st::make_op(&mut st::LamportClock::new(i as u64), "d0", 1, k).unwrap();
        old.apply(&op).unwrap();
        let r = st::seal_op(&key, &alice, &op).unwrap();
        sqlx::query("INSERT INTO user_state_log (user, seq, op_id, record, at) VALUES (?, ?, ?, ?, 0)")
            .bind(&alice)
            .bind(i as i64 + 1)
            .bind(r.op_id)
            .bind(r.aead_ciphertext)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
    let res = tokio::task::spawn_blocking(move || {
        let (mut d1, mut d2, mut d3) = (d1, d2, d3);
        let mut f = Failures(vec![]);
        // ── два устройства переносят одновременно: шаги вперемешку ──
        let mut m1 = Mig::new(&d1, "d1", &export_key);
        let mut m2 = Mig::new(&d2, "d2", &export_key);
        for _ in 0..100_000 {
            let a = m1.step(&mut d1.id);
            let b = m2.step(&mut d2.id);
            if !a && !b && m1.ready && m2.ready {
                break;
            }
        }
        m1.finish(&mut d1.id);
        m2.finish(&mut d2.id);
        f.check("both-ready", m1.ready && m2.ready, "");
        f.check("both-appended", m1.appends >= 5 && m2.appends >= 5, (m1.appends, m2.appends));
        let s = d1.id.call("state.ops.sync", SyncRequest { after_seq: 0, max_bytes: 0 }.encode_to_vec()).map(|b| SyncResponse::decode(b.as_slice()).unwrap());
        let recs = s.map(|s| s.records).unwrap_or_default();
        f.check("one-copy-per-object", recs.len() == 5, recs.len());
        let mut state = State2::new();
        let mut migrated_last = false;
        for (i, r) in recs.iter().enumerate() {
            let pt = state2::open(&key, &alice, &r.op_id, &r.aead_ciphertext).unwrap();
            let op = parvane_protocol::pb::parvane::state::v2::StateOp::decode(pt.as_slice()).unwrap();
            if i + 1 == recs.len() {
                migrated_last = matches!(op.op, Some(Op::Migrated(ref m)) if m.from_seq == 4);
            }
            state.apply_bytes(&pt).unwrap();
        }
        f.check("migrated-last", migrated_last, "");
        let new = serde_json::to_value(migrate::state_v1::project_v1(&state)).unwrap();
        f.check("view-equals-old-snapshot", new == serde_json::to_value(old.snapshot()).unwrap(), &new);
        // ── третье устройство позже: читает перенесённый журнал, своего переноса не пишет ──
        let mut m3 = Mig::new(&d3, "d3", &export_key);
        m3.finish(&mut d3.id);
        f.check("third-ready", m3.ready, "");
        f.check("third-writes-nothing", m3.appends == 0, m3.appends);
        let s = d3.id.call("state.ops.sync", SyncRequest { after_seq: 0, max_bytes: 0 }.encode_to_vec()).map(|b| SyncResponse::decode(b.as_slice()).unwrap());
        f.check("journal-unchanged", s.as_ref().is_ok_and(|s| s.records.len() == 5), "");
        let dump = call(&mut m3.e, "auditDump", &json!({}));
        f.check("third-sees-state", dump["jsonl"].as_str().is_some_and(|d| d.contains("\"state:contacts\"") && d.contains("\"state:folders\"")), &dump);
        f.0
    })
    .await
    .unwrap();
    assert!(res.is_empty(), "провалены: {res:?}");
    drop(stack);
}
