//! Исправления security-ревью кода v2 (security-code-review-us1/us2.md) против
//! живого стека: C1-01 (ключ устройства закреплён за одним устройством),
//! C1-04 (журнал группы перестраивается после отзыва устройства подписанта и
//! рестарта messenger, бан не откатывается), C2-03 (в журнале инбокса нет
//! ключа доставки/жетона).
//!
//! Без `nats-server` тест печатает SKIP и проходит.

mod v2common;

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Client, ClientError, Need};
use parvane_protocol::identity::{self, DeviceLog, RootIdentity};
use parvane_protocol::olm::OlmAccount;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, DeviceCertificate, ErrorCode, Ref, UserRef};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, group_change::Change, GroupKind, Permissions};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, Text};
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
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug")
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
    let dir = std::env::temp_dir().join(format!("parvane-v2review-{}-{}", std::process::id(), free_port()));
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

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn group_sync(d: &mut Device, g: &Ref) -> Result<u64, ErrorCode> {
    let after = d.client.group_version(&g.id);
    let b = d.id.call("group.state.sync", gpb::StateSyncRequest { group: Some(g.clone()), after_version: after, ..Default::default() }.encode_to_vec())?;
    let r = gpb::StateSyncResponse::decode(b.as_slice()).unwrap();
    for _ in 0..8 {
        match d.client.group_ingest(g, r.entries.clone()) {
            Ok(v) => return Ok(v),
            Err(ClientError::Need(n)) => {
                assert!(d.satisfy(&n), "добор {n:?}");
            }
            Err(e) => panic!("group_ingest: {e:?}"),
        }
    }
    Err(ErrorCode::Unavailable)
}

fn own_log_sync(d: &mut Device) {
    let me = d.client.user.clone();
    assert!(d.satisfy(&Need::PeerLog { user: me, after: 0 }));
}

/// C1-04 + C2-03: админ банит с устройства d2, затем d2 отозвано и messenger
/// перезапущен — журнал группы перестраивается (подписант сохранён при
/// приёме), бан остаётся в силе, новые записи принимаются (не DUPLICATE).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_review_group_rebuild_after_revocation_live() {
    let Some((mut stack, nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let (ua, ub, um) = (format!("ra{p}@local"), format!("rb{p}@local"), format!("rm{p}@local"));

    let (addr2, ua2, ub2, um2) = (addr.clone(), ua.clone(), ub.clone(), um.clone());
    let (mut alice, mut alice2, g) = tokio::task::spawn_blocking(move || {
        let mut alice = Device::register(&addr2, &ua2, "d1");
        let mut bob = Device::register(&addr2, &ub2, "d1");
        let _mallory = Device::register(&addr2, &um2, "d1");
        // Второе устройство Алисы (линковка: SSK + журнал + ключ доставки).
        let mut alice2 = login(&addr2, &ua2, "d2");
        let (ssk, entries, dk, gen) = alice.client.link_grant_material().unwrap();
        let reqs = alice2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
        alice2.run(&reqs).expect("d2 сертификат");
        own_log_sync(&mut alice);

        // C2-03: sealed-запись в журнале инбокса — без ключа доставки.
        alice.client.set_peer_delivery_key(&ub2, bob.client.delivery_key().to_vec(), 1);
        alice.op(&mut |c| c.prepare_direct(&ub2, &text("привет"))).expect("sealed");
        let b = bob.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: 0, max_bytes: 0 }.encode_to_vec()).unwrap();
        let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
        let sealed: Vec<_> = recs.iter().filter_map(|r| match &r.item {
            Some(inbox_record::Item::Sealed(e)) => Some(e.clone()),
            _ => None,
        }).collect();
        assert!(!sealed.is_empty(), "sealed-запись дошла");
        assert!(sealed.iter().all(|e| e.access.is_none()), "в журнале инбокса нет ключа доставки/жетона");
        let raw: Vec<u8> = recs.iter().flat_map(|r| r.encode_to_vec()).collect();
        let dkb = bob.client.delivery_key().to_vec();
        assert!(!raw.windows(32).any(|w| w == dkb.as_slice()), "ключ доставки Боба не хранится");

        // Группа создаётся и ведётся с d2; бан Мэллори подписан d2.
        let perms = Permissions { send_messages: true, ..Default::default() };
        let (g, r) = alice2.client.group_create(GroupKind::Group, "Ревью", &[ub2.clone(), um2.clone()], perms).unwrap();
        alice2.exec(&r).expect("генезис");
        let r = alice2.client.group_change(&g.id, Change::Ban(gpb::Ban { member: Some(UserRef { address: um2.clone() }) })).unwrap();
        alice2.exec(&r).expect("бан");
        // d1 знает журнал группы до отзыва d2.
        group_sync(&mut alice, &g).expect("d1 догнал журнал");
        assert!(alice.client.group_state(&g.id).unwrap().banned.contains(&um2));
        (alice, alice2, g)
    })
    .await
    .unwrap();

    // Отзыв d2 с d1.
    let alice = tokio::task::spawn_blocking(move || {
        let r = alice.client.revoke_device_request("d2").unwrap();
        alice.exec(&r).expect("отзыв d2");
        alice
    })
    .await
    .unwrap();
    // Рестарт messenger: кэш состояний групп пуст, журнал перестраивается из БД.
    {
        let m = &mut stack.children[MESSENGER];
        let _ = m.kill();
        let _ = m.wait();
    }
    let m = spawn_messenger(&stack);
    stack.children[MESSENGER] = m;
    wait_messenger(&nc).await;

    let um3 = um.clone();
    let addr3 = addr.clone();
    tokio::task::spawn_blocking(move || {
        let mut alice = alice;
        // Новая запись с d1 принимается (не DUPLICATE/UNAVAILABLE).
        let r = alice.client.group_change(&g.id, Change::SetInfo(gpb::SetInfo { name: "После рестарта".into(), ..Default::default() })).unwrap();
        let res = alice.exec(&r);
        assert!(res.is_ok(), "запись после отзыва подписанта и рестарта: {res:?}");
        // Бан на сервере в силе: Мэллори не участник.
        let mut mallory = login(&addr3, &um3, "d1");
        let inv = mallory.id.call("group.invite.list", gpb::InviteListRequest { group: Some(g.clone()) }.encode_to_vec());
        assert_eq!(inv.err(), Some(ErrorCode::Forbidden), "бан не откатился");
        // Отозванное устройство записей не добавляет.
        let r = alice2.client.group_change(&g.id, Change::SetInfo(gpb::SetInfo { name: "с d2".into(), ..Default::default() }));
        if let Ok(r) = r {
            assert!(alice2.exec(&r).is_err(), "отозванное d2 не пишет в журнал");
        }
    })
    .await
    .unwrap();
}

fn cert_entry(root: &RootIdentity, log: &DeviceLog, user: &str, device: &str, acc: &OlmAccount) -> parvane_protocol::pb::parvane::core::v2::SignedOp {
    let mut cert = DeviceCertificate {
        user: Some(UserRef { address: user.into() }),
        device_id: device.into(),
        olm_curve25519: acc.curve25519().to_vec(),
        olm_ed25519: acc.ed25519().to_vec(),
        hpke_x25519: vec![5; 32],
        proto_major: 2,
        serial: 1,
        ..Default::default()
    };
    identity::prove_possession(acc, &mut cert, &root.root_pub()).unwrap();
    root.add_device_entry(log.version + 1, log.head_hash, &cert).unwrap()
}

/// Зарегистрировать пользователя и выложить генезис журнала (сырой клиент).
fn raw_user(addr: &str, user: &str) -> (Conn, RootIdentity, DeviceLog) {
    let (mut c, _) = Conn::connect(addr, Channel::Identified);
    let _ = c.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
    let tok = c
        .call("identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec())
        .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap_or_default().token)
        .unwrap();
    c.send(frame::Kind::Auth(Auth { token: tok }));
    assert!(matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))));
    let root = RootIdentity::generate(user).unwrap();
    let g = root.genesis_entry().unwrap();
    c.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(g.clone()) }.encode_to_vec()).expect("genesis");
    let mut log = DeviceLog::new(user).unwrap();
    log.apply(&g).unwrap();
    (c, root, log)
}

/// C1-01 (сервер): ключ подписи устройства закреплён за первым устройством —
/// тот же ключ (даже с доказательством владения, т. е. украденный) под
/// другим пользователем сервер отвергает; сертификат без доказательства
/// владения отвергает движок на сервере.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_review_device_key_claims_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    tokio::task::spawn_blocking(move || {
        let (ua, um) = (format!("ka{p}@local"), format!("km{p}@local"));
        let acc = OlmAccount::new();
        let (mut a, ra, la) = raw_user(&addr, &ua);
        let e = cert_entry(&ra, &la, &ua, "d1", &acc);
        a.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(e), ..Default::default() }.encode_to_vec()).expect("сертификат Алисы");
        // Мэллори с украденным ключом устройства Алисы.
        let (mut m, rm, lm) = raw_user(&addr, &um);
        let e = cert_entry(&rm, &lm, &um, "d1", &acc);
        let r = m.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(e), ..Default::default() }.encode_to_vec());
        assert_eq!(r.err(), Some(ErrorCode::Duplicate), "ключ чужого устройства");
        // Без доказательства владения: ключ Алисы вписан в сертификат Мэллори.
        let mut cert = DeviceCertificate {
            user: Some(UserRef { address: um.clone() }),
            device_id: "d2".into(),
            olm_curve25519: vec![3; 32],
            olm_ed25519: acc.ed25519().to_vec(),
            hpke_x25519: vec![5; 32],
            proto_major: 2,
            serial: 1,
            ..Default::default()
        };
        cert.possession_signature = vec![0; 64];
        let e = rm.add_device_entry(lm.version + 1, lm.head_hash, &cert).unwrap();
        let r = m.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(e) }.encode_to_vec());
        assert!(r.is_err(), "сертификат без доказательства владения: {r:?}");
        // Свой ключ Мэллори — принимается.
        let own = OlmAccount::new();
        let e = cert_entry(&rm, &lm, &um, "d1", &own);
        m.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(e), ..Default::default() }.encode_to_vec()).expect("свой ключ");
    })
    .await
    .unwrap();
    drop(stack);
}
