//! Журнал истории аккаунта против живого стека (spec 033; HIST-1, HIST-2, READ-2): `history.append` с
//! идемпотентностью, живое `JournalNotice` прочим устройствам пользователя (и после `state.append`),
//! `history.sync` (курсор, бюджет, `skip_chunks`, `head_seq`, `compacted`), `history.head`, `history.get`
//! (только свои записи), `history.checkpoint.commit` (CAS, обрезка, сегменты прежней точки), изоляция
//! чужого пользователя. Записи шифруются и открываются движком (`parvane_protocol::history`).
//!
//! Помощники стека скопированы из `v2_state_live.rs`. Без `nats-server` тест печатает SKIP и проходит.

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Client, Event};
use parvane_protocol::history::{self as h, HistorySession};
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode, UserRef};
use parvane_protocol::pb::parvane::history::v1::{
    history_op::Op, AppendRequest, AppendResponse, CommitRequest, CommitResponse, GetRequest, GetResponse, GoneScope, HeadResponse, HistoryOp,
    MessageRow, SyncRequest, SyncResponse,
};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2 as mpb;
use parvane_protocol::pb::parvane::state::v1::{peer, Peer};
use parvane_protocol::state::StateKey;
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

fn chat(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

fn msg(id: u8, from: &str, peer: &str, text: &str) -> HistoryOp {
    let mut idb = parvane_protocol::state::new_op_id().to_vec();
    idb[15] = id;
    h::row_op(MessageRow { id: idb, chat: Some(chat(peer)), from: from.into(), ts_ms: 1_700_000_000_000 + i64::from(id), body: format!(r#"{{"content":{{"kind":"text","text":"{text}"}}}}"#).into_bytes() })
}

fn append(c: &mut Conn, body: &[u8]) -> Result<u64, ErrorCode> {
    c.call("history.append", body.to_vec()).map(|b| AppendResponse::decode(b.as_slice()).unwrap_or_default().seq)
}

fn seal(s: &HistorySession, ops: Vec<HistoryOp>, chunk: bool) -> Vec<Vec<u8>> {
    s.seal(ops, chunk, 1).unwrap().into_iter().map(|(_, b)| b).collect()
}

fn sync(c: &mut Conn, after_seq: u64, skip_chunks: bool, max_bytes: u32) -> Result<(SyncResponse, Vec<u8>), ErrorCode> {
    c.call("history.sync", SyncRequest { after_seq, max_bytes, skip_chunks }.encode_to_vec()).map(|b| (SyncResponse::decode(b.as_slice()).unwrap_or_default(), b))
}

fn seqs(r: &SyncResponse) -> Vec<u64> {
    r.records.iter().map(|x| x.seq).collect()
}

/// Ждать живое уведомление журнала в инбоксе устройства (сокет с таймаутом чтения).
fn journal_notice(d: &mut Device, timeout: Duration) -> Option<mpb::JournalNotice> {
    d.id.s.set_read_timeout(Some(timeout)).ok()?;
    let r = wait_notice(d, timeout);
    let _ = d.id.s.set_read_timeout(Some(Duration::from_secs(10)));
    r
}

fn wait_notice(d: &mut Device, timeout: Duration) -> Option<mpb::JournalNotice> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let e = d.id.next_event()?;
        if e.kind != "inbox.record" {
            continue;
        }
        // Тот же путь, что у клиентов: ядро отдаёт событие Journal
        let ev = d.client.open_record(&e.body).unwrap_or_default();
        let rec = mpb::InboxRecord::decode(e.body.as_slice()).ok()?;
        if let Some(mpb::inbox_record::Item::Journal(j)) = rec.item {
            assert!(ev.iter().any(|x| matches!(x, Event::Journal { kind, seq } if *kind == j.kind && *seq == j.seq)), "{ev:?}");
            assert_eq!(rec.seq, 0, "живое событие без места в журнале инбокса");
            return Some(j);
        }
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_history_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let n = free_port();
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let (alice, bob) = (format!("ha{n}@local"), format!("hb{n}@local"));
        // Два устройства alice в журнале устройств: d1 — первое, d2 — привязано
        let mut d1 = Device::register(&addr, &alice, "d1");
        let mut d2 = login(&addr, &alice, "d2");
        let (ssk, entries, dk, gen) = d1.client.link_grant_material().unwrap();
        let reqs = d2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
        d2.run(&reqs).expect("d2 в журнале устройств");
        let mut b = Device::register(&addr, &bob, "b1");
        f.check("subscribe-d1", d1.id.call("msg.inbox.subscribe", vec![]).is_ok(), "");
        f.check("subscribe-d2", d2.id.call("msg.inbox.subscribe", vec![]).is_ok(), "");
        // Общий ключ состояния (на деле — из гранта привязки)
        let key = StateKey::generate();
        let s1 = HistorySession::new(&alice, &[], "d1", &[(&key, 1)]).unwrap();
        let s2 = HistorySession::new(&alice, &[], "d2", &[(&key, 1)]).unwrap();

        // ── append + живое уведомление ──
        let m1 = msg(1, &bob, &bob, "привет");
        let gone = h::gone_op(parvane_protocol::pb::parvane::history::v1::Gone {
            target: match &m1.op { Some(Op::Row(r)) => r.id.clone(), _ => vec![] },
            chat: Some(chat(&bob)),
            stamp: Some(h::new_stamp(1_700_000_001_000)),
            scope: GoneScope::Everyone as i32,
            by: alice.clone(),
            by_admin: false,
        });
        let r1 = seal(&s1, vec![m1.clone()], false);
        f.check("append-1", append(&mut d1.id, &r1[0]) == Ok(1), "");
        let j = journal_notice(&mut d2, Duration::from_secs(5));
        f.check("notice-history-to-other-device", j.as_ref().is_some_and(|j| j.kind == mpb::JournalKind::History as i32 && j.seq == 1), &j);
        let own = journal_notice(&mut d1, Duration::from_millis(1500));
        f.check("no-notice-to-self", own.is_none(), &own);
        f.check("append-retry-idempotent", append(&mut d2.id, &r1[0]) == Ok(1), "");
        let mut forged = AppendRequest::decode(r1[0].as_slice()).unwrap();
        forged.chunk = true;
        f.check("append-same-opid-other-chunk", append(&mut d1.id, &forged.encode_to_vec()) == Err(ErrorCode::Duplicate), "");
        let bad = AppendRequest { op_id: vec![1; 16], aead_ciphertext: vec![0; 40], chunk: false };
        f.check("append-bad-opid", append(&mut d1.id, &bad.encode_to_vec()) == Err(ErrorCode::Invalid), "");
        let r2 = seal(&s2, vec![gone.clone()], false);
        f.check("append-2-from-d2", append(&mut d2.id, &r2[0]) == Ok(2), "");
        let j = journal_notice(&mut d1, Duration::from_secs(5));
        f.check("notice-back-to-d1", j.as_ref().is_some_and(|j| j.seq == 2), &j);

        // ── state.append тоже будит прочие устройства ──
        let st_key = parvane_protocol::state::StateKey::generate();
        let mut clock = parvane_protocol::state::LamportClock::default();
        let op = parvane_protocol::state::make_op(&mut clock, "d1", 1, parvane_protocol::pb::parvane::state::v1::state_op::Op::ArchiveSet(
            parvane_protocol::pb::parvane::state::v1::PeerKey { peer: Some(chat(&bob)) })).unwrap();
        let sreq = parvane_protocol::state::seal_op(&st_key, &alice, &op).unwrap();
        f.check("state-append", d1.id.call("state.append", sreq.encode_to_vec()).is_ok(), "");
        let j = journal_notice(&mut d2, Duration::from_secs(5));
        f.check("notice-state", j.as_ref().is_some_and(|j| j.kind == mpb::JournalKind::State as i32 && j.seq == 1), &j);

        // ── sync: оба устройства сводят одно и то же ──
        let got = sync(&mut d2.id, 0, false, 0);
        f.check("sync-all", got.as_ref().is_ok_and(|(r, _)| seqs(r) == vec![1, 2] && r.head_seq == 2 && !r.more && r.compacted.is_none()), got.as_ref().map(|(r, _)| seqs(r)));
        let ing = got.as_ref().ok().and_then(|(_, raw)| s2.ingest(raw).ok());
        f.check("ingest-ops", ing.as_ref().is_some_and(|i| i.ops == vec![m1.clone(), gone.clone()] && i.rejected == 0), &ing.as_ref().map(|i| i.rejected));
        let state = ing.as_ref().map(|i| i.ops.iter().fold(None, |s, op| h::apply(s.as_ref(), op).ok()));
        f.check("deleted-stays-deleted", state.flatten().is_some_and(|s| s.gone.is_some() && s.row.is_some_and(|r| r.body.is_empty())), "");
        let got = sync(&mut d1.id, 1, false, 0);
        f.check("sync-cursor", got.as_ref().is_ok_and(|(r, _)| seqs(r) == vec![2]), "");
        let got = sync(&mut d1.id, 0, false, 10);
        f.check("sync-budget-page", got.as_ref().is_ok_and(|(r, _)| r.records.len() == 1 && r.more), "");

        // ── контрольная точка: сегмент 3, сводка 4, событие 5 ──
        let seg_state = h::apply(None, &m1).and_then(|s| h::apply(Some(&s), &gone)).unwrap();
        let seg = seal(&s1, vec![HistoryOp { op: Some(Op::State(seg_state.clone())) }], true);
        f.check("append-segment", append(&mut d1.id, &seg[0]) == Ok(3), "");
        let digest = h::segment_digest(std::slice::from_ref(&seg_state)).unwrap();
        let key_s = h::segment_key(&seg_state).unwrap();
        let sum = h::summary(vec![], vec![parvane_protocol::pb::parvane::history::v1::SegmentRef { key: key_s, digest: digest.to_vec(), seq: 3 }], 0).unwrap();
        let sm = seal(&s1, vec![sum], true);
        f.check("append-summary", append(&mut d1.id, &sm[0]) == Ok(4), "");
        let m2 = msg(2, &alice, &bob, "после точки");
        f.check("append-after", append(&mut d1.id, &seal(&s1, vec![m2.clone()], false)[0]) == Ok(5), "");
        let commit = |c: &mut Conn, expected, upto, summary, chunks: Vec<u64>| {
            c.call("history.checkpoint.commit", CommitRequest { expected_checkpoint_id: expected, upto_seq: upto, summary_seq: summary, chunk_seqs: chunks }.encode_to_vec())
                .map(|b| CommitResponse::decode(b.as_slice()).unwrap_or_default().checkpoint_id)
        };
        f.check("commit-not-a-chunk", commit(&mut d1.id, 0, 4, 4, vec![2]) == Err(ErrorCode::Invalid), "");
        f.check("commit-beyond-head", commit(&mut d1.id, 0, 9, 4, vec![3]) == Err(ErrorCode::Invalid), "");
        f.check("commit-ok", commit(&mut d1.id, 0, 4, 4, vec![3]) == Ok(1), "");
        f.check("commit-cas-lost", commit(&mut d2.id, 0, 4, 4, vec![3]) == Err(ErrorCode::Duplicate), "");
        let hd = d2.id.call("history.head", vec![]).map(|b| HeadResponse::decode(b.as_slice()).unwrap_or_default());
        f.check("head", hd.as_ref().is_ok_and(|h| h.head_seq == 5 && h.checkpoint.as_ref().is_some_and(|c| c.id == 1 && c.upto_seq == 4 && c.summary_seq == 4 && c.chunk_seqs == vec![3])), &hd);
        // Новое устройство с курсором 0: точка + записи только после неё
        let got = sync(&mut d2.id, 0, true, 0);
        f.check("sync-compacted", got.as_ref().is_ok_and(|(r, _)| seqs(r) == vec![5] && r.compacted.as_ref().is_some_and(|c| c.id == 1)), got.as_ref().map(|(r, _)| (seqs(r), r.compacted.clone())));
        let got = sync(&mut d2.id, 4, false, 0);
        f.check("sync-after-point", got.as_ref().is_ok_and(|(r, _)| seqs(r) == vec![5] && r.compacted.is_none()), "");
        let g = d2.id.call("history.get", GetRequest { seqs: vec![4, 3, 1, 2] }.encode_to_vec()).map(|b| (GetResponse::decode(b.as_slice()).unwrap_or_default(), b));
        f.check("get-trimmed", g.as_ref().is_ok_and(|(r, _)| r.records.iter().map(|x| x.seq).collect::<Vec<_>>() == vec![4, 3]), g.as_ref().map(|(r, _)| r.records.len()));
        let opened = g.as_ref().ok().and_then(|(_, raw)| s2.ingest(raw).ok());
        f.check(
            "get-opens-chunks",
            opened.as_ref().is_some_and(|i| i.rejected == 0 && i.records.iter().all(|r| r.chunk) && i.ops.iter().any(|o| matches!(o.op, Some(Op::Summary(_)))) && i.ops.iter().any(|o| o.op == Some(Op::State(seg_state.clone())))),
            &opened.as_ref().map(|i| i.rejected),
        );

        // ── чужой пользователь ──
        let got = sync(&mut b.id, 0, false, 0);
        f.check("other-user-empty", got.as_ref().is_ok_and(|(r, _)| r.records.is_empty() && r.head_seq == 0), "");
        let g = b.id.call("history.get", GetRequest { seqs: vec![3, 4, 5] }.encode_to_vec()).map(|b| GetResponse::decode(b.as_slice()).unwrap_or_default());
        f.check("other-user-get-nothing", g.as_ref().is_ok_and(|r| r.records.is_empty()), "");
        // Чужой ключ не открывает записи alice
        let sb = HistorySession::new(&bob, &[], "b1", &[(&StateKey::generate(), 1)]).unwrap();
        let raw = sync(&mut d1.id, 4, false, 0).map(|(_, raw)| raw).unwrap_or_default();
        f.check("foreign-key-rejected", sb.ingest(&raw).is_ok_and(|i| i.rejected == 1 && i.ops.is_empty()), "");
        // Без входа — FORBIDDEN
        let (mut anon, _) = Conn::connect(&addr, Channel::Identified);
        f.check("sync-without-auth", sync(&mut anon, 0, false, 0).err() == Some(ErrorCode::Forbidden), "");
        f
    })
    .await
    .unwrap();
    assert!(res.0.is_empty(), "провалены сценарии журнала истории: {:?} (логи: {})", res.0, stack.dir.display());
}
