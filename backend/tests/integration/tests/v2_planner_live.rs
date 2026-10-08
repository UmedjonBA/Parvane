//! Планировщик на сервере против живого стека (spec 010, T013): шард `domains`
//! в стеке; контейнер `parvane.planner.v1` на двух устройствах одного
//! пользователя (ключ контейнера — по E2E своим устройствам), правки обоих,
//! смена эпохи при отзыве устройства (отозванное новых операций не читает),
//! список контейнеров владельца. Без `nats-server` тест печатает SKIP.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Client, Event, Need};
use parvane_protocol::pb::parvane::core::v2::{
    frame, Auth, Channel, DomainContainerListRequest, DomainContainerListResponse, DomainGrantListRequest,
    DomainOpSyncRequest, DomainSnapshotGetRequest, ErrorCode, Ref,
};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2 as mpb;
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
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "domains", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2planner-{}-{}", std::process::id(), free_port()));
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

fn own_log_sync(d: &mut Device) {
    let me = d.client.user.clone();
    assert!(d.satisfy(&Need::PeerLog { user: me, after: 0 }));
}

fn container_ref(d: &Device) -> Ref {
    d.client.planner_container().expect("контейнер")
}

/// Открыть все новые записи инбокса устройства.
fn drain(d: &mut Device, after: &mut u64) -> Vec<Event> {
    let b = d.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *after, max_bytes: 0 }.encode_to_vec()).unwrap();
    let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
    let mut out = vec![];
    for r in recs {
        *after = (*after).max(r.seq);
        out.extend(d.open(&r.encode_to_vec()));
    }
    out
}

fn sync(d: &mut Device) -> parvane_protocol::client::PlannerIngest {
    let r = container_ref(d);
    let resp = d.id.call("domain.op.sync", DomainOpSyncRequest { container: Some(r), after_seq: d.client.planner_head_seq(), max_bytes: 0 }.encode_to_vec()).unwrap();
    d.client.planner_ingest_sync(&resp).expect("ingest")
}

fn edit(d: &mut Device, changes: &str) -> Result<Vec<u8>, ErrorCode> {
    let local = d.client.planner_prepare_local(changes).expect("prepare");
    let req = d.client.planner_seal(&local.op, &local.op_id, 1).expect("seal");
    d.exec(&req)
}

fn tasks(d: &Device) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(&d.client.planner_state_json().unwrap()).unwrap();
    v["tasks"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_planner_two_devices_and_revocation_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let user = format!("planner{}@local", free_port());
    let (addr2, user2) = (addr.clone(), user.clone());
    let dir = stack.dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut alice = Device::register(&addr2, &user2, "d1");
        // Контейнер и первая правка.
        let create = alice.client.planner_create(1).unwrap();
        alice.exec(&create).expect("container.create");
        let seq = edit(&mut alice, r#"{"changes":[{"task":{"id":"t1","name":"Первая","status":"queue","day":"2026-10-08","minutes":60}}]}"#).expect("append");
        assert_eq!(parvane_protocol::pb::parvane::core::v2::DomainOpAppendResponse::decode(seq.as_slice()).unwrap().seq, 1);
        // Повтор того же op_id — DUPLICATE, не вторая копия.
        let local = alice.client.planner_prepare_local(r#"{"changes":[{"task":{"id":"t2","name":"Вторая"}}]}"#).unwrap();
        let req = alice.client.planner_seal(&local.op, &local.op_id, 1).unwrap();
        alice.exec(&req).expect("append 2");
        let again = alice.client.planner_seal(&local.op, &local.op_id, 2).unwrap();
        assert_eq!(alice.exec(&again), Err(ErrorCode::Duplicate));
        // Список контейнеров владельца.
        let list = alice.id.call("domain.container.list", DomainContainerListRequest { domain: "parvane.planner.v1".into() }.encode_to_vec()).unwrap();
        let list = DomainContainerListResponse::decode(list.as_slice()).unwrap();
        assert_eq!(list.containers.len(), 1);
        assert_eq!(list.containers[0].r#ref, Some(container_ref(&alice)));

        // Второе устройство: грант линковки + ключ контейнера по E2E (вместе с группами).
        let mut alice2 = login(&addr2, &user2, "d2");
        let (ssk, entries, dk, gen) = alice.client.link_grant_material().unwrap();
        let reqs = alice2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
        alice2.run(&reqs).expect("d2 сертификат");
        own_log_sync(&mut alice);
        alice.op(&mut |c| c.share_groups_with_own_devices(&["d2".into()])).expect("ключ своим устройствам");
        let mut cursor2 = 0;
        let ev = drain(&mut alice2, &mut cursor2);
        assert!(ev.iter().any(|e| matches!(e, Event::PlannerChanged { .. })), "{ev:?} {:?}", alice2.client.last_error);
        // Контейнер находится списком (журнал состояния не подключён в тесте).
        let list = alice2.id.call("domain.container.list", DomainContainerListRequest { domain: "parvane.planner.v1".into() }.encode_to_vec()).unwrap();
        let first = DomainContainerListResponse::decode(list.as_slice()).unwrap().containers.remove(0);
        let got = alice2.id.call("domain.container.get", parvane_protocol::pb::parvane::core::v2::DomainContainerGetRequest { container: first.r#ref.clone() }.encode_to_vec()).unwrap();
        let grants = alice2.id.call("domain.grant.list", DomainGrantListRequest { container: first.r#ref.clone(), after_version: 0 }.encode_to_vec()).unwrap();
        alice2.client.planner_attach(&got, &grants).expect("attach d2");
        assert!(alice2.client.planner_has_key(), "ключ контейнера принят из E2E");
        // Снимка ещё нет.
        let snap = alice2.id.call("domain.snapshot.get", DomainSnapshotGetRequest { container: first.r#ref.clone() }.encode_to_vec()).unwrap();
        assert_eq!(alice2.client.planner_ingest_snapshot(&snap).unwrap(), 0);
        let r = sync(&mut alice2);
        assert_eq!((r.applied, r.head_seq, r.missing_epoch), (2, 2, None), "{r:?}");
        assert_eq!(tasks(&alice2), vec!["Первая", "Вторая"]);

        // Правка со второго устройства — первому.
        edit(&mut alice2, r#"{"changes":[{"task":{"id":"t1","status":"done"}}]}"#).expect("append d2");
        // (эхо двух своих операций — три изменения, идемпотентно — плюс одна чужая)
        let r = sync(&mut alice);
        assert_eq!((r.applied, r.head_seq), (3, 3), "{r:?}");

        // Отзыв d2: запись rotate → эпоха 2; новые операции d1 — в эпохе 2.
        alice.op(&mut |c| c.revoke_device("d2").map(|o| o.requests)).expect("отзыв");
        let got = alice.id.call("domain.container.get", parvane_protocol::pb::parvane::core::v2::DomainContainerGetRequest { container: Some(container_ref(&alice)) }.encode_to_vec()).unwrap();
        let got = parvane_protocol::pb::parvane::core::v2::DomainContainerGetResponse::decode(got.as_slice()).unwrap();
        assert_eq!((got.container.unwrap().key_epoch, got.grant_version), (2, 1));
        edit(&mut alice, r#"{"changes":[{"task":{"id":"t3","name":"После отзыва"}}]}"#).expect("append epoch 2");
        // Отозванное устройство: сервер закрыл его сессию (gateway гасит по `v2.revoked`) —
        // запросы недоступны; даже получив журнал грантов и операции (здесь — байтами
        // от владельца), ключа эпохи 2 у него нет и новую операцию оно не читает.
        let cref = container_ref(&alice);
        assert_eq!(
            alice2.id.call("domain.grant.list", DomainGrantListRequest { container: Some(cref.clone()), after_version: 0 }.encode_to_vec()),
            Err(ErrorCode::Unavailable),
            "сессия отозванного устройства закрыта"
        );
        let grants = alice.id.call("domain.grant.list", DomainGrantListRequest { container: Some(cref.clone()), after_version: 0 }.encode_to_vec()).unwrap();
        assert_eq!(alice2.client.planner_ingest_grants(&grants).unwrap(), 1);
        let ops = alice.id.call("domain.op.sync", DomainOpSyncRequest { container: Some(cref), after_seq: alice2.client.planner_head_seq(), max_bytes: 0 }.encode_to_vec()).unwrap();
        let r = alice2.client.planner_ingest_sync(&ops).unwrap();
        assert_eq!(r.missing_epoch, Some(2), "{r:?}");
        assert_eq!(tasks(&alice2), vec!["Первая", "Вторая"]);
        assert_eq!(tasks(&alice), vec!["Первая", "Вторая", "После отзыва"]);
        Ok::<(), String>(())
    })
    .await
    .unwrap();
    if let Err(e) = result {
        panic!("{e}\nжурнал domains:\n{}", std::fs::read_to_string(dir.join("domains.log")).unwrap_or_default());
    }
    drop(stack);
}
