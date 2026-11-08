//! spec 035 T073 (US7): матрица доступа к журналу группы (`contracts/group-access.md`) против живого стека —
//! nats, identity, messenger, gateway; роли из `proto/parvane/vectors/group_access/matrix.json` ходят своими
//! сессиями через gateway. Без `nats-server` тест печатает SKIP и проходит.

mod v2common;

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Client, ClientError};
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode, Ref, UserRef};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, group_change::Change, GroupKind, Permissions};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use prost::Message;
use v2common::{Conn, Device, PASSWORD};

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    gateway_tcp: String,
    nats_url: String,
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
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => PathBuf::from(dir).join("debug"),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug"),
    }
}

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin))
        .envs(envs.iter().copied())
        .env("PARVANE_LOG_LEVEL", "info")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

/// messenger — индекс 2 в `children`.
#[allow(dead_code)]
const MESSENGER: usize = 2;

fn spawn_messenger(s: &Stack) -> Child {
    let db = s.dir.join("messenger.db").to_string_lossy().to_string();
    spawn("messenger", &[("PARVANE_NATS_URL", &s.nats_url), ("PARVANE_DB_PATH", &db), ("PARVANE_GROUP_ENTRY_TS_WINDOW_MS", "0")], &s.dir.join("messenger.log"))
}

async fn wait_messenger(nc: &async_nats::Client) {
    let t = Instant::now();
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("v2.msg.inbox.sync", vec![].into())).await;
        if matches!(r, Ok(Ok(_))) {
            return;
        }
        assert!(t.elapsed() < Duration::from_secs(30), "messenger не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
    let dir = std::env::temp_dir().join(format!("parvane-v2access-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_port = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let gateway_tcp = format!("127.0.0.1:{}", free_port());
    let gateway_ws = format!("127.0.0.1:{}", free_port());
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let children = vec![Command::new(nats_bin)
        .args(["-a", "127.0.0.1", "-p", &nats_port.to_string()])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap()];
    let mut s = Stack { children, dir, gateway_tcp, nats_url };
    let id_db = s.dir.join("identity.db").to_string_lossy().to_string();
    let wk = s.dir.join("parvane.json").to_string_lossy().to_string();
    let c = spawn(
        "identity",
        &[
            ("PARVANE_NATS_URL", &s.nats_url),
            ("PARVANE_DB_PATH", &id_db),
            ("PARVANE_DEV", "1"),
            ("PARVANE_WELL_KNOWN_FILE", &wk),
            ("PARVANE_LOGIN_RATE", "100000"),
            ("PARVANE_REGISTER_RATE", "100000"),
        ],
        &s.dir.join("identity.log"),
    );
    s.children.push(c);
    let m = spawn_messenger(&s);
    s.children.push(m);
    let g = spawn(
        "gateway",
        &[("PARVANE_NATS_URL", &s.nats_url), ("PARVANE_GATEWAY_TCP_BIND", &s.gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws), ("PARVANE_V2_FEATURES", "sealed")],
        &s.dir.join("gateway.log"),
    );
    s.children.push(g);
    let t = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&s.nats_url).await {
            break nc;
        }
        assert!(t.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("v2.server.describe", vec![].into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(30), "identity не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    wait_messenger(&nc).await;
    while TcpStream::connect(&s.gateway_tcp).is_err() {
        assert!(t.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((s, nc))
}

#[allow(dead_code)]
/// Войти существующим пользователем устройством `device_id` (без личности).
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


/// Ответ `group.state.sync` роли: `Ok(версии записей)` либо код отказа.
#[derive(Default, Clone)]
struct Ask {
    link_id: Vec<u8>,
    proof: Vec<u8>,
    proof_ts_ms: i64,
}

fn sync(d: &mut Device, g: &Ref, ask: &Ask) -> Result<Vec<u64>, ErrorCode> {
    let req = gpb::StateSyncRequest {
        group: Some(g.clone()),
        after_version: 0,
        invite_link_id: ask.link_id.clone(),
        invite_proof: ask.proof.clone(),
        invite_proof_ts_ms: ask.proof_ts_ms,
    };
    let b = d.id.call("group.state.sync", req.encode_to_vec())?;
    Ok(gpb::StateSyncResponse::decode(b.as_slice()).unwrap().entries.iter().map(|e| e.version).collect())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Доказательство знания секрета ссылки `parts` от имени `user` (как намерение `groupJoinByLink`).
fn proof(parts: &gpb::InviteLinkParts, g: &Ref, user: &str, ts_ms: i64) -> Ask {
    let key = parvane_protocol::invite::signing_key(parts).unwrap();
    Ask { link_id: parts.link_id.clone(), proof: parvane_protocol::invite::sync_proof(&key, g, user, ts_ms), proof_ts_ms: ts_ms }
}

fn link_only(parts: &gpb::InviteLinkParts) -> Ask {
    Ask { link_id: parts.link_id.clone(), ..Default::default() }
}

/// Записи `1..=n`.
fn upto(n: u64) -> Vec<u64> {
    (1..=n).collect()
}

/// Журнал группы через gateway — в клиент (для вступления по ссылке).
fn ingest(d: &mut Device, g: &Ref, ask: &Ask) {
    let req = gpb::StateSyncRequest {
        group: Some(g.clone()),
        after_version: 0,
        invite_link_id: ask.link_id.clone(),
        invite_proof: ask.proof.clone(),
        invite_proof_ts_ms: ask.proof_ts_ms,
    };
    let b = d.id.call("group.state.sync", req.encode_to_vec()).expect("журнал для вступления");
    let r = gpb::StateSyncResponse::decode(b.as_slice()).unwrap();
    for _ in 0..8 {
        match d.client.group_ingest_hinted(g, r.entries.clone(), &r.signer_hints) {
            Ok(_) => return,
            Err(ClientError::Need(n)) => assert!(d.satisfy(&n), "добор {n:?}"),
            Err(e) => panic!("group_ingest: {e:?}"),
        }
    }
    panic!("журнал группы не догнан");
}

/// spec 035 T073 (US7, FR-070…FR-073; PV-006, PV-007, A0023-2, D5, PUBLIC-1): матрица доступа к журналу группы
/// `contracts/group-access.md` через gateway — каждая роль `proto/parvane/vectors/group_access/matrix.json`
/// запрашивает `group.state.sync` своей сессией. Без правки фаз 8–9 посторонний с одним `invite_link_id` получал
/// журнал (PV-006), забаненный посторонний — записи до бана (PV-007).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_group_access_matrix_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let r = tokio::task::spawn_blocking(move || {
        let u = |r: &str| format!("{r}{p}@local");
        let (owner_u, mem_u, former_u, fban_u, inv_u, pend_u, zban_u, out_u) =
            (u("own"), u("mem"), u("frm"), u("fbn"), u("inv"), u("pnd"), u("zbn"), u("out"));
        let mut owner = Device::register(&addr, &owner_u, "d1");
        let mut mem = Device::register(&addr, &mem_u, "d1");
        let mut former = Device::register(&addr, &former_u, "d1");
        let mut fban = Device::register(&addr, &fban_u, "d1");
        let mut inv = Device::register(&addr, &inv_u, "d1");
        let mut pend = Device::register(&addr, &pend_u, "d1");
        let mut zban = Device::register(&addr, &zban_u, "d1");
        let mut out = Device::register(&addr, &out_u, "d1");

        // ── частная группа: участники, бывший (исключён), бывший забаненный, забаненный посторонний, ссылки ──
        let perms = Permissions { send_messages: true, ..Default::default() };
        let (g, r) = owner.client.group_create(GroupKind::Group, "Кружок вязания", &[mem_u.clone(), former_u.clone(), fban_u.clone()], perms).unwrap();
        owner.exec(&r).expect("генезис");
        let user = |a: &str| Some(UserRef { address: a.to_string() });
        let r = owner.client.group_change(&g.id, Change::RemoveMember(gpb::RemoveMember { member: user(&former_u) })).unwrap();
        owner.exec(&r).expect("исключение");
        let exit_former = owner.client.group_version(&g.id);
        let r = owner.client.group_change(&g.id, Change::Ban(gpb::Ban { member: user(&fban_u) })).unwrap();
        owner.exec(&r).expect("бан участника");
        let exit_fban = owner.client.group_version(&g.id);
        let r = owner.client.group_change(&g.id, Change::Ban(gpb::Ban { member: user(&zban_u) })).unwrap();
        owner.exec(&r).expect("бан постороннего");
        let (r, link) = owner.client.group_invite_create(&g.id, "Для своих", 0, 0, false).unwrap();
        owner.exec(&r).expect("ссылка");
        let (r, link_ap) = owner.client.group_invite_create(&g.id, "По одобрению", 0, 0, true).unwrap();
        owner.exec(&r).expect("ссылка с одобрением");
        let r = owner.client.group_change(&g.id, Change::SetInfo(gpb::SetInfo { name: "Кружок вязания и чая".into(), ..Default::default() })).unwrap();
        owner.exec(&r).expect("сведения");
        let head = owner.client.group_version(&g.id);
        assert!(exit_former < exit_fban && exit_fban < head);

        // Ожидающий одобрения: журнал по доказательству, заявка по ссылке с одобрением
        let t = now_ms();
        ingest(&mut pend, &g, &proof(&link_ap, &g, &pend_u, t));
        let r = pend.client.group_join(&link_ap).unwrap();
        let jr = gpb::JoinResponse::decode(pend.exec(&r).expect("заявка").as_slice()).unwrap();
        assert!(jr.pending, "заявка ждёт одобрения");

        let t = now_ms();
        let mut bad = Vec::new();
        // 1. участник
        bad.extend(check("member", sync(&mut mem, &g, &Ask::default()), Ok(upto(head))));
        // 2. бывший: исключён без бана — до записи исключения
        bad.extend(check("former_left_or_removed", sync(&mut former, &g, &Ask::default()), Ok(upto(exit_former))));
        // 3. бывший: забанен после вступления — до записи бана
        bad.extend(check("former_banned", sync(&mut fban, &g, &Ask::default()), Ok(upto(exit_fban))));
        // 4. приглашённый с верным доказательством
        bad.extend(check("invited_with_proof", sync(&mut inv, &g, &proof(&link, &g, &inv_u, t)), Ok(upto(head))));
        // 5. только invite_link_id; неверное доказательство (чужой адрес, несвежее, чужой ключ)
        bad.extend(check("invited_link_id_only", sync(&mut inv, &g, &link_only(&link)), Err(ErrorCode::Forbidden)));
        bad.extend(check("invited_bad_proof:user", sync(&mut inv, &g, &proof(&link, &g, &out_u, t)), Err(ErrorCode::Forbidden)));
        bad.extend(check("invited_bad_proof:stale", sync(&mut inv, &g, &proof(&link, &g, &inv_u, t - 3_600_000)), Err(ErrorCode::Forbidden)));
        let mut forged = proof(&link_ap, &g, &inv_u, t);
        forged.link_id = link.link_id.clone();
        bad.extend(check("invited_bad_proof:key", sync(&mut inv, &g, &forged), Err(ErrorCode::Forbidden)));
        // 6. бывший с живой ссылкой без доказательства — как бывший
        bad.extend(check("former_with_live_link_no_proof", sync(&mut former, &g, &link_only(&link)), Ok(upto(exit_former))));
        // 7. бывший с верным доказательством (повторное вступление) — как приглашённый
        bad.extend(check("former_with_proof_rejoining", sync(&mut former, &g, &proof(&link, &g, &former_u, t)), Ok(upto(head))));
        // 8. ожидающий одобрения — и без свежего доказательства
        bad.extend(check("pending_approval_no_fresh_proof", sync(&mut pend, &g, &Ask::default()), Ok(upto(head))));
        bad.extend(check("pending_approval_with_proof", sync(&mut pend, &g, &proof(&link_ap, &g, &pend_u, t)), Ok(upto(head))));
        // 9. забаненный посторонний — ни с доказательством, ни без
        bad.extend(check("banned_outsider", sync(&mut zban, &g, &proof(&link, &g, &zban_u, t)), Err(ErrorCode::Forbidden)));
        bad.extend(check("banned_outsider_no_link", sync(&mut zban, &g, &Ask::default()), Err(ErrorCode::Forbidden)));
        // 10. посторонний без ссылки
        bad.extend(check("outsider", sync(&mut out, &g, &Ask::default()), Err(ErrorCode::Forbidden)));

        // ── публичная группа (PUBLIC-1): открыта всем незабаненным ──
        let (pg, r) = owner.client.group_create(GroupKind::Group, "Открытый кружок", &[fban_u.clone()], perms).unwrap();
        owner.exec(&r).expect("генезис публичной");
        let r = owner.client.group_change(&pg.id, Change::Ban(gpb::Ban { member: user(&fban_u) })).unwrap();
        owner.exec(&r).expect("бан в публичной");
        let r = owner.client.group_change(&pg.id, Change::Ban(gpb::Ban { member: user(&zban_u) })).unwrap();
        owner.exec(&r).expect("бан постороннего в публичной");
        let r = owner.client.group_set_public(&pg.id, true, &format!("knit{p}"), true, true).unwrap();
        owner.exec(&r).expect("публичная");
        let phead = owner.client.group_version(&pg.id);
        bad.extend(check("public:outsider", sync(&mut out, &pg, &Ask::default()), Ok(upto(phead))));
        bad.extend(check("public:former_banned", sync(&mut fban, &pg, &Ask::default()), Err(ErrorCode::Forbidden)));
        bad.extend(check("public:banned_outsider", sync(&mut zban, &pg, &Ask::default()), Err(ErrorCode::Forbidden)));
        bad.extend(check("public:member", sync(&mut owner, &pg, &Ask::default()), Ok(upto(phead))));
        assert!(bad.is_empty(), "матрица доступа через gateway:\n{}", bad.join("\n"));
    })
    .await;
    if let Err(e) = r {
        let log = std::fs::read_to_string(stack.dir.join("messenger.log")).unwrap_or_default();
        let tail: Vec<&str> = log.lines().rev().take(40).collect();
        panic!("{e:?}\nmessenger.log (хвост):\n{}", tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
}

fn check(name: &str, got: Result<Vec<u64>, ErrorCode>, want: Result<Vec<u64>, ErrorCode>) -> Option<String> {
    (got != want).then(|| format!("{name}: ждали {want:?}, получили {got:?}"))
}
