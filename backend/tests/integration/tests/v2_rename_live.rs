//! Смена ника против живого стека (spec 026): identity переносит аккаунт, шарды — свои строки; прежний ник
//! ведёт на новый (вход и доставка), занят для других; токены прежнего адреса недействительны; собеседник видит
//! журнал прежнего адреса закрытым и продолжает переписку с новым; группа и «План» — у нового адреса.
//! Без `nats-server` тест печатает SKIP.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Client, ClientError, Event, LogVerdict};
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, DomainOpSyncRequest, ErrorCode, Ref, UserRef};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, GroupKind, Permissions};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, Content, Text};
use prost::Message;

mod v2common;
use v2common::{Conn, Device};

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
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "domains", "-p", "cloud", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2rename-{}-{}", std::process::id(), free_port()));
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
    let d_db = dir.join("domains.db").to_string_lossy().to_string();
    children.push(spawn("domains", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &d_db)], &dir.join("domains.log")));
    let c_db = dir.join("cloud.db").to_string_lossy().to_string();
    children.push(spawn("cloud", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &c_db)], &dir.join("cloud.log")));
    children.push(spawn(
        "gateway",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws), ("PARVANE_V2_FEATURES", "sealed")],
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
    for (subject, name) in [("v2.server.describe", "identity"), ("v2.msg.inbox.sync", "messenger"), ("v2.domain.container.list", "domains")] {
        loop {
            let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject, vec![].into())).await;
            if matches!(r, Ok(Ok(_))) {
                break;
            }
            assert!(startt.elapsed() < Duration::from_secs(60), "{name} не поднялся");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(startt.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

/// Тексты событий: (чат, от кого, текст).
fn texts(ev: &[Event]) -> Vec<(String, String, String)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { chat, from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((chat.clone(), from.clone(), t.text.clone())),
            Event::Group { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some(("group".into(), from.clone(), t.text.clone())),
            _ => None,
        })
        .collect()
}

fn group_sync(d: &mut Device, g: &Ref) {
    for _ in 0..8 {
        let after = d.client.group_version(&g.id);
        let b = d.id.call("group.state.sync", gpb::StateSyncRequest { group: Some(g.clone()), after_version: after, ..Default::default() }.encode_to_vec()).expect("state.sync");
        let r = gpb::StateSyncResponse::decode(b.as_slice()).unwrap();
        match d.client.group_ingest_hinted(g, r.entries, &r.signer_hints) {
            Ok(_) => return,
            Err(ClientError::Need(n)) => assert!(d.satisfy(&n), "добор {n:?}"),
            Err(e) => panic!("group_ingest: {e:?}"),
        }
    }
    panic!("журнал группы не догнан");
}

/// Новые записи инбокса; изменение группы — догнать её журнал и применить отложенное (как хост).
fn drain(d: &mut Device, after: &mut u64) -> Vec<Event> {
    let b = d.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *after, max_bytes: 0 }.encode_to_vec()).unwrap();
    let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
    let mut out = vec![];
    for r in recs {
        assert!(r.seq > *after, "нумерация инбокса продолжается: {} после {}", r.seq, after);
        *after = r.seq;
        let ev = d.open(&r.encode_to_vec());
        for e in &ev {
            if let Event::GroupChanged { group, .. } = e {
                group_sync(d, group);
                out.extend(d.client.drain_ready());
            }
        }
        out.extend(ev);
    }
    out
}

/// Регистрация с корнем (он нужен для смены ника) и копией корня под ключом восстановления на сервере.
fn register_with_root(addr: &str, user: &str) -> (Device, [u8; 32], String) {
    let (mut id, w) = Conn::connect(addr, Channel::Identified);
    let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome") };
    let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).unwrap();
    id.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec())
        .expect("регистрация");
    let tok = issue(&mut id, user, "d1").token;
    id.send(frame::Kind::Auth(Auth { token: tok }));
    assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
    let (anon, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    let client = Client::new(user, "d1", &domain).unwrap();
    let mut d = Device { client, id, anon, server_key, domain };
    let (reqs, root) = d.client.create_identity(20).unwrap();
    d.run(&reqs).expect("личность");
    let key = parvane_protocol::recovery::RecoveryKey::generate();
    let backup = d.client.export_root_backup(&root.root.to_bytes(), &key).unwrap();
    d.id.call("identity.root.backup_set", ipb::RootBackupSetRequest { backup, ..Default::default() }.encode_to_vec()).expect("копия корня");
    (d, root.root.to_bytes(), key.to_display().to_string())
}

fn issue(id: &mut Conn, login: &str, device_id: &str) -> ipb::SessionIssueResponse {
    id.call("identity.session.issue", ipb::SessionIssueRequest { login: login.into(), password: PASSWORD.into(), device_id: device_id.into(), ..Default::default() }.encode_to_vec())
        .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap())
        .unwrap_or_else(|e| panic!("session.issue {login}: {e:?}"))
}

fn auth(addr: &str, token: &str) -> Option<Conn> {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.send(frame::Kind::Auth(Auth { token: token.into() }));
    matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))).then_some(id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_rename_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let port = free_port();
    let (a_old, a_new, b_user) = (format!("ren{port}@local"), format!("renamed{port}@local"), format!("peer{port}@local"));
    let dir = stack.dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (mut alice, root, recovery) = register_with_root(&addr, &a_old);
        let mut bob = Device::register(&addr, &b_user, "d1");
        // Переписка: Боб пишет первым по ключу доступа Алисы (как из профиля), Алиса отвечает
        bob.client.set_peer_delivery_key(&a_old, alice.client.delivery_key().to_vec(), 1);
        bob.op(&mut |c| c.prepare_direct(&a_old, &text("привет"))).expect("Боб → Алиса");
        let (mut a_cur, mut b_cur) = (0u64, 0u64);
        assert!(texts(&drain(&mut alice, &mut a_cur)).iter().any(|(_, _, t)| t == "привет"));
        alice.op(&mut |c| c.prepare_direct(&b_user, &text("и тебе"))).expect("Алиса → Боб");
        assert!(texts(&drain(&mut bob, &mut b_cur)).iter().any(|(_, _, t)| t == "и тебе"));
        // Группа Алисы с Бобом
        let perms = Permissions { send_messages: true, ..Default::default() };
        let (g, req) = alice.client.group_create(GroupKind::Group, "Клуб", &[b_user.clone()], perms).unwrap();
        alice.exec(&req).expect("группа");
        alice.op(&mut |c| c.group_rotate_epoch(&g.id)).expect("эпоха");
        alice.op(&mut |c| c.prepare_group(&g.id, &text("в группу до смены"))).expect("в группу");
        drain(&mut bob, &mut b_cur);
        assert_eq!(bob.client.group_state(&g.id).map(|s| s.owner.clone()), Some(a_old.clone()));
        // «План» Алисы
        let create = alice.client.planner_create(1).unwrap();
        alice.exec(&create).expect("контейнер");
        let local = alice.client.planner_prepare_local(r#"{"changes":[{"task":{"id":"t1","name":"До смены"}}]}"#).unwrap();
        let req = alice.client.planner_seal(&local.op, &local.op_id, 1).unwrap();
        alice.exec(&req).expect("правка до смены");

        // ── смена ника ──
        let plan = alice.client.rename_prepare(&root, &a_new).unwrap();
        let body = ipb::AccountRenameRequest {
            new_login: a_new.split('@').next().unwrap().into(),
            rename: Some(plan.rename.clone()),
            new_log: plan.new_log.clone(),
            root_backup: parvane_protocol::recovery::export_root_backup(&root, &a_new, &parvane_protocol::recovery::RecoveryKey::parse(&recovery).unwrap()).unwrap(),
        };
        assert_eq!(alice.id.call("identity.account.rename", body.encode_to_vec()), Err(ErrorCode::ReauthRequired), "без пароля — нет");
        alice.id.call("identity.session.reauth", ipb::SessionReauthRequest { password: PASSWORD.into() }.encode_to_vec()).expect("reauth");
        // Чужой ник занят
        let taken = ipb::AccountRenameRequest { new_login: b_user.split('@').next().unwrap().into(), ..body.clone() };
        assert_eq!(alice.id.call("identity.account.rename", taken.encode_to_vec()), Err(ErrorCode::Duplicate));
        let resp = ipb::AccountRenameResponse::decode(alice.id.call("identity.account.rename", body.encode_to_vec()).expect("смена ника").as_slice()).unwrap();
        assert_eq!(resp.address, a_new);
        alice.client.rename_apply(&plan).unwrap();
        assert_eq!(alice.client.user, a_new);
        alice.id = auth(&addr, &resp.token).expect("токен нового адреса");

        // Токены прежнего адреса недействительны; вход прежним ником ведёт на новый адрес; ник занят
        let (mut probe, _) = Conn::connect(&addr, Channel::Identified);
        let old_login = issue(&mut probe, &a_old, "d9");
        assert_eq!(old_login.address, a_new, "прежний ник ведёт на новый адрес");
        assert!(auth(&addr, &old_login.token).is_some());
        let reg = probe.call("identity.account.register", ipb::AccountRegisterRequest { user: a_old.clone(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
        assert!(reg.is_err(), "прежний ник занят: {reg:?}");

        // Копия корня под новым адресом
        let got = ipb::RootBackupGetResponse::decode(alice.id.call("identity.root.backup_get", vec![]).unwrap().as_slice()).unwrap();
        let back = alice.client.import_root_backup(&got.backup, &parvane_protocol::recovery::RecoveryKey::parse(&recovery).unwrap()).unwrap();
        assert_eq!(*back, root);

        // Группа: участник переезжает (запись под новым адресом)
        let group_reqs = alice.client.rename_groups_pending().unwrap();
        assert_eq!(group_reqs.len(), 1);
        alice.run(&group_reqs).expect("RenameMember");

        // Боб ещё не знает: пишет на прежний адрес — доходит, нумерация инбокса Алисы продолжается
        bob.op(&mut |c| c.prepare_direct(&a_old, &text("на старый адрес"))).expect("на прежний адрес");
        let ev = drain(&mut alice, &mut a_cur);
        assert!(texts(&ev).iter().any(|(_, _, t)| t == "на старый адрес"), "{ev:?} {:?}", alice.client.last_error);

        // Боб перечитывает журнал прежнего адреса: закрыт → журнал нового адреса → перенос
        let after = bob.client.log_version(&a_old);
        let r = bob.anon.call("identity.device.log_sync_anon", ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: a_old.clone() }), after_version: after, ..Default::default() }.encode_to_vec()).unwrap();
        assert_eq!(bob.client.ingest_log(&a_old, ipb::DeviceLogSyncAnonResponse::decode(r.as_slice()).unwrap().entries).unwrap(), LogVerdict::Moved);
        let r = bob.anon.call("identity.device.log_sync_anon", ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: a_new.clone() }), after_version: 0, ..Default::default() }.encode_to_vec()).unwrap();
        assert_eq!(bob.client.ingest_log(&a_new, ipb::DeviceLogSyncAnonResponse::decode(r.as_slice()).unwrap().entries).unwrap(), LogVerdict::Renamed);
        bob.op(&mut |c| c.prepare_direct(&a_new, &text("на новый адрес"))).expect("на новый адрес");
        let ev = drain(&mut alice, &mut a_cur);
        assert!(texts(&ev).iter().any(|(c, _, t)| c == &b_user && t == "на новый адрес"), "{ev:?}");
        alice.op(&mut |c| c.prepare_direct(&b_user, &text("ответ с нового"))).expect("ответ");
        let ev = drain(&mut bob, &mut b_cur);
        assert!(texts(&ev).iter().any(|(c, f, t)| c == &a_new && f == &a_new && t == "ответ с нового"), "{ev:?}");
        assert_eq!(bob.client.group_state(&g.id).map(|s| s.owner.clone()), Some(a_new.clone()), "{:?}", bob.client.last_error);
        alice.op(&mut |c| c.prepare_group(&g.id, &text("в группу после смены"))).expect("в группу после");
        let ev = drain(&mut bob, &mut b_cur);
        assert!(texts(&ev).iter().any(|(_, f, t)| f == &a_new && t == "в группу после смены"), "{ev:?} {:?}", bob.client.last_error);

        // «План»: правка под новым адресом принимается, история читается
        let local = alice.client.planner_prepare_local(r#"{"changes":[{"task":{"id":"t2","name":"После смены"}}]}"#).unwrap();
        let req = alice.client.planner_seal(&local.op, &local.op_id, 2).unwrap();
        alice.exec(&req).expect("правка после смены");
        let cref = alice.client.planner_container().unwrap();
        let resp = alice.id.call("domain.op.sync", DomainOpSyncRequest { container: Some(cref), after_seq: 0, max_bytes: 0 }.encode_to_vec()).expect("op.sync под новым адресом");
        assert!(!resp.is_empty());
    })
    .await;
    if result.is_err() {
        eprintln!("логи стека: {}", dir.display());
        // Каталог с логами остаётся, процессы стека — нет (иначе держали бы замок тяжёлых прогонов)
        let mut stack = stack;
        for c in stack.children.iter_mut().rev() {
            let _ = c.kill();
            let _ = c.wait();
        }
        std::mem::forget(stack);
        panic!("смена ника: тест не прошёл");
    }
}
