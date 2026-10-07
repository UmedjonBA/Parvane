//! Режим «усиленная приватность» (L2, FR-036, T079) против живого стека:
//! - личный чат: операция `ChatMode` доходит собеседнику, режим виден обоим,
//!   sealed-конверты в журнале инбокса лежат на сетке 512/2048/8192/32768,
//!   время приёма округлено до минуты;
//! - группа: политика `set_privacy_mode` — запись журнала; сервер проверяет
//!   право как у изменения сведений (участник без права → FORBIDDEN),
//!   групповые конверты на сетке.
//!
//! Без `nats-server` тест печатает SKIP и проходит.

mod v2common;

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{ClientError, Event};
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, Ref};
use parvane_protocol::pb::parvane::group::v2::{self as gpb, group_change::Change, GroupKind, Permissions};
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, Text};
use parvane_protocol::seal::L2_BUCKETS;
use prost::Message;
use v2common::Device;

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

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug").join(bin))
        .envs(envs.iter().copied())
        .env("PARVANE_LOG_LEVEL", "info")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

async fn start() -> Option<Stack> {
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
    let dir = std::env::temp_dir().join(format!("parvane-v2l2-{}-{}", std::process::id(), free_port()));
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
    let mut s = Stack { children, dir, gateway_tcp };
    let path = |n: &str| s.dir.join(n).to_string_lossy().to_string();
    let (id_db, wk, m_db) = (path("identity.db"), path("parvane.json"), path("messenger.db"));
    let c = spawn(
        "identity",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_DB_PATH", &id_db),
            ("PARVANE_DEV", "1"),
            ("PARVANE_WELL_KNOWN_FILE", &wk),
            ("PARVANE_LOGIN_RATE", "100000"),
            ("PARVANE_REGISTER_RATE", "100000"),
        ],
        &s.dir.join("identity.log"),
    );
    s.children.push(c);
    let m = spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db), ("PARVANE_GROUP_ENTRY_TS_WINDOW_MS", "0")], &s.dir.join("messenger.log"));
    s.children.push(m);
    let g = spawn(
        "gateway",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &s.gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws), ("PARVANE_V2_FEATURES", "sealed")],
        &s.dir.join("gateway.log"),
    );
    s.children.push(g);
    let t = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(t.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    for subject in ["v2.server.describe", "v2.msg.inbox.sync"] {
        loop {
            let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject, vec![].into())).await;
            if matches!(r, Ok(Ok(_))) {
                break;
            }
            assert!(t.elapsed() < Duration::from_secs(60), "{subject}: шард не поднялся");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    while TcpStream::connect(&s.gateway_tcp).is_err() {
        assert!(t.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some(s)
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
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

const TAG: usize = 16;

fn on_grid(n: usize) -> bool {
    L2_BUCKETS.contains(&n) || (n > 32768 && n % 32768 == 0)
}

/// Новые записи инбокса: события ядра + (размер внутреннего слоя, время приёма)
/// sealed- и групповых записей.
fn drain(d: &mut Device, cursor: &mut u64) -> (Vec<Event>, Vec<(usize, i64)>) {
    let b = d.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *cursor, max_bytes: 0 }.encode_to_vec()).expect("inbox.sync");
    let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
    let (mut events, mut sizes) = (vec![], vec![]);
    for r in recs {
        *cursor = (*cursor).max(r.seq);
        match &r.item {
            Some(inbox_record::Item::Sealed(e)) => sizes.push((e.ciphertext.len() - TAG, r.received_ms)),
            Some(inbox_record::Item::Group(e)) => sizes.push((e.epoch_aead_ciphertext.len() - TAG, r.received_ms)),
            _ => {}
        }
        let ev = d.open(&r.encode_to_vec());
        for e in &ev {
            if let Event::GroupChanged { group, .. } = e {
                group_sync(d, group);
                events.extend(d.client.drain_ready());
            }
        }
        events.extend(ev);
    }
    (events, sizes)
}

fn chat_modes(ev: &[Event]) -> Vec<(String, bool)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { from, content: Content { kind: Some(content::Kind::ChatMode(m)), .. }, .. } => Some((from.clone(), m.l2)),
            _ => None,
        })
        .collect()
}

fn texts(ev: &[Event]) -> Vec<String> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } | Event::Group { content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some(t.text.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_l2_mode_live() {
    let Some(stack) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let (ua, ub) = (format!("la{p}@local"), format!("lb{p}@local"));
    tokio::task::spawn_blocking(move || {
        let mut alice = Device::register(&addr, &ua, "d1");
        let mut bob = Device::register(&addr, &ub, "d1");
        alice.client.set_peer_delivery_key(&ub, bob.client.delivery_key().to_vec(), 1);
        bob.client.set_peer_delivery_key(&ua, alice.client.delivery_key().to_vec(), 1);
        let (mut ca, mut cb) = (0u64, 0u64);

        // Обычный режим: конверт не на сетке.
        alice.op(&mut |c| c.prepare_direct(&ub, &text("до режима"))).expect("sealed");
        let (ev, sizes) = drain(&mut bob, &mut cb);
        assert!(texts(&ev).contains(&"до режима".to_string()), "{ev:?}");
        assert!(sizes.iter().any(|(n, _)| !on_grid(*n)), "{sizes:?}");
        // Время приёма sealed-записей округлено до минуты (для всех записей:
        // сервер режима не знает).
        assert!(sizes.iter().all(|(_, t)| *t > 0 && t % 60_000 == 0), "{sizes:?}");

        // Алиса включает L2: Боб видит служебное событие, режим активен у обоих.
        alice.op(&mut |c| c.l2_set_direct(&ub, true)).expect("ChatMode");
        assert!(alice.client.l2_direct(&ub).active && !alice.client.presence_allowed());
        let (ev, sizes) = drain(&mut bob, &mut cb);
        assert_eq!(chat_modes(&ev), vec![(ua.clone(), true)], "{ev:?}");
        assert!(sizes.iter().all(|(n, _)| on_grid(*n)), "смена режима выровнена: {sizes:?}");
        let v = bob.client.l2_direct(&ua);
        assert!(v.active && !v.mine && v.pad && !v.ephemeral_allowed && v.enabled_by == vec![ua.clone()], "{v:?}");

        // Оба направления — на сетке; длина текста по размеру не видна.
        bob.op(&mut |c| c.prepare_direct(&ua, &text("коротко"))).expect("sealed");
        bob.op(&mut |c| c.prepare_direct(&ua, &text(&"длинное сообщение ".repeat(20)))).expect("sealed");
        let (ev, sizes) = drain(&mut alice, &mut ca);
        assert_eq!(texts(&ev).len(), 2, "{ev:?}");
        assert!(sizes.len() >= 2 && sizes.iter().all(|(n, _)| on_grid(*n)), "{sizes:?}");
        assert!(sizes.windows(2).all(|w| w[0].0 == w[1].0), "одна корзина: {sizes:?}");
        alice.op(&mut |c| c.prepare_direct(&ub, &text("в режиме"))).expect("sealed");
        let (ev, sizes) = drain(&mut bob, &mut cb);
        assert!(texts(&ev).contains(&"в режиме".to_string()));
        assert!(sizes.iter().all(|(n, _)| on_grid(*n)), "{sizes:?}");

        // Выключение: режим снят у обоих.
        alice.op(&mut |c| c.l2_set_direct(&ub, false)).expect("ChatMode off");
        let (ev, _) = drain(&mut bob, &mut cb);
        assert_eq!(chat_modes(&ev), vec![(ua.clone(), false)]);
        assert!(!bob.client.l2_direct(&ua).active && bob.client.presence_allowed());
        assert!(!alice.client.l2_direct(&ub).active && alice.client.presence_allowed());

        // ── группа ──
        let perms = Permissions { send_messages: true, ..Default::default() };
        let (g, r) = alice.client.group_create(GroupKind::Group, "Тихая", std::slice::from_ref(&ub), perms).unwrap();
        alice.exec(&r).expect("генезис");
        alice.op(&mut |c| c.group_rotate_epoch(&g.id)).expect("эпоха");
        drain(&mut bob, &mut cb);
        assert!(bob.client.group_state(&g.id).is_some(), "Боб знает группу");

        // Участник без права менять сведения: сервер отвергает запись (право
        // по состоянию до записи), журнал не меняется.
        let before = alice.client.group_version(&g.id);
        let raw = bob.client.group_change_raw(&g.id, Change::SetPrivacyMode(gpb::SetPrivacyMode { l2: true })).unwrap();
        assert_eq!(bob.exec(&raw).err(), Some(ErrorCode::Forbidden), "политика L2 без права change_info");
        group_sync(&mut alice, &g);
        assert_eq!(alice.client.group_version(&g.id), before);

        // Обычный режим группы: конверт не на сетке.
        alice.op(&mut |c| c.prepare_group(&g.id, &text("группа до режима"))).expect("групповое");
        let (ev, sizes) = drain(&mut bob, &mut cb);
        assert!(texts(&ev).contains(&"группа до режима".to_string()), "{ev:?} {:?}", bob.client.last_error);
        assert!(sizes.iter().any(|(n, _)| !on_grid(*n)), "{sizes:?}");

        // Своя копия группового сообщения (до режима) — прочитана заранее.
        drain(&mut alice, &mut ca);

        // Владелец включает политику; участник узнаёт из журнала.
        let r = alice.client.group_change(&g.id, Change::SetPrivacyMode(gpb::SetPrivacyMode { l2: true })).unwrap();
        alice.exec(&r).expect("политика L2");
        drain(&mut bob, &mut cb);
        let v = bob.client.l2_group(&g.id);
        assert!(v.active && v.pad && !v.ephemeral_allowed && v.enabled_by == vec![ua.clone()], "{v:?}");
        assert!(!bob.client.presence_allowed());

        // Групповые конверты обоих участников — на сетке.
        bob.op(&mut |c| c.prepare_group(&g.id, &text("от Боба"))).expect("групповое Боба");
        let (ev, sizes) = drain(&mut alice, &mut ca);
        assert!(texts(&ev).contains(&"от Боба".to_string()), "{ev:?} {:?}", alice.client.last_error);
        assert!(!sizes.is_empty() && sizes.iter().all(|(n, _)| on_grid(*n)), "{sizes:?}");
        alice.op(&mut |c| c.prepare_group(&g.id, &text("от Алисы"))).expect("групповое Алисы");
        let (ev, sizes) = drain(&mut bob, &mut cb);
        assert!(texts(&ev).contains(&"от Алисы".to_string()), "{ev:?}");
        assert!(!sizes.is_empty() && sizes.iter().all(|(n, t)| on_grid(*n) && t % 60_000 == 0), "{sizes:?}");

        // Политика снята.
        let r = alice.client.group_change(&g.id, Change::SetPrivacyMode(gpb::SetPrivacyMode { l2: false })).unwrap();
        alice.exec(&r).expect("политика снята");
        drain(&mut bob, &mut cb);
        assert!(!bob.client.l2_group(&g.id).active && bob.client.presence_allowed());
    })
    .await
    .unwrap();
}
