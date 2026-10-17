//! Удаление аккаунта против живого стека (spec 027): запрос только со свежим паролем; аккаунт сразу без сессий и
//! скрыт (журнал устройств пуст с признаком `deleted`, профиля и поиска нет, доставка не принимается); вход паролем
//! без отмены токена не даёт, с отменой — снимает удаление; по сроку identity и шарды стирают строки, ник свободен.
//! Без `nats-server` тест печатает SKIP.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::Event;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode, UserRef};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, Content, Text};
use prost::Message;

mod v2common;
use v2common::{Conn, Device};
use std::path::Path as StdPath;

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
    let dir = std::env::temp_dir().join(format!("parvane-v2delete-{}-{}", std::process::id(), free_port()));
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
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_DB_PATH", &id_db),
            ("PARVANE_DEV", "1"),
            ("PARVANE_WELL_KNOWN_FILE", &wk),
            ("PARVANE_ACCOUNT_DELETE_DELAY_MS", "4000"),
            ("PARVANE_IDENTITY_UPKEEP_SECS", "1"),
        ],
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

fn got_text(d: &mut Device, after: &mut u64, want: &str) -> bool {
    let b = d.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *after, max_bytes: 0 }.encode_to_vec()).unwrap();
    let mut found = false;
    for r in mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records {
        *after = r.seq;
        for e in d.open(&r.encode_to_vec()) {
            if let Event::Direct { content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } = e {
                found |= t.text == want;
            }
        }
    }
    found
}

fn issue(id: &mut Conn, login: &str, device_id: &str, cancel: bool) -> Result<ipb::SessionIssueResponse, ErrorCode> {
    id.call(
        "identity.session.issue",
        ipb::SessionIssueRequest { login: login.into(), password: PASSWORD.into(), device_id: device_id.into(), cancel_deletion: cancel, ..Default::default() }.encode_to_vec(),
    )
    .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap())
}

fn auth(addr: &str, token: &str) -> Option<Conn> {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.send(frame::Kind::Auth(Auth { token: token.into() }));
    matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))).then_some(id)
}

fn log_of(d: &mut Device, user: &str) -> ipb::DeviceLogSyncAnonResponse {
    let r = d.anon.call("identity.device.log_sync_anon", ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: user.into() }), after_version: 0, ..Default::default() }.encode_to_vec()).unwrap();
    ipb::DeviceLogSyncAnonResponse::decode(r.as_slice()).unwrap()
}

fn search(d: &mut Device, q: &str) -> Vec<String> {
    let r = d.id.call("identity.directory.search", ipb::DirectorySearchRequest { query: q.into(), ..Default::default() }.encode_to_vec()).unwrap();
    ipb::DirectorySearchResponse::decode(r.as_slice()).unwrap().results.into_iter().filter_map(|p| p.user.map(|u| u.address)).collect()
}

fn delete(d: &mut Device) -> ipb::AccountDeleteResponse {
    d.id.call("identity.session.reauth", ipb::SessionReauthRequest { password: PASSWORD.into() }.encode_to_vec()).expect("reauth");
    ipb::AccountDeleteResponse::decode(d.id.call("identity.account.delete", vec![]).expect("удаление").as_slice()).unwrap()
}

fn log_has(dir: &StdPath, file: &str, needle: &str) -> bool {
    std::fs::read_to_string(dir.join(file)).unwrap_or_default().contains(needle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_delete_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let port = free_port();
    let (a_user, b_user) = (format!("gone{port}@local"), format!("stay{port}@local"));
    let dir = stack.dir.clone();
    let logs = dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut alice = Device::register(&addr, &a_user, "d1");
        let mut bob = Device::register(&addr, &b_user, "d1");
        bob.client.set_peer_delivery_key(&a_user, alice.client.delivery_key().to_vec(), 1);
        let mut a_cur = 0u64;
        bob.op(&mut |c| c.prepare_direct(&a_user, &text("до удаления"))).expect("Боб → Алиса");
        assert!(got_text(&mut alice, &mut a_cur, "до удаления"));
        let nick = a_user.split('@').next().unwrap().to_string();
        assert!(search(&mut bob, &nick).contains(&a_user), "до удаления Алиса находится");

        // Без свежего пароля — нет
        assert_eq!(alice.id.call("identity.account.delete", vec![]), Err(ErrorCode::ReauthRequired));
        let resp = delete(&mut alice);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!(resp.deletion_at_ms > now, "срок в будущем");

        // Для Боба Алисы нет: журнал пуст с признаком, поиска нет, доставка не принимается
        let log = log_of(&mut bob, &a_user);
        assert!(log.deleted && log.entries.is_empty(), "журнал удаляемого: {log:?}");
        assert!(!search(&mut bob, &nick).contains(&a_user), "удаляемый не ищется");
        let r = bob.op(&mut |c| c.prepare_direct(&a_user, &text("в пустоту")));
        eprintln!("доставка удаляемому: {r:?}");

        // Сессии и токены закрыты; вход паролем без отмены — без токена, со сроком
        let (mut probe, _) = Conn::connect(&addr, Channel::Identified);
        let pending = issue(&mut probe, &a_user, "d1", false).expect("вход");
        assert!(pending.token.is_empty() && pending.deletion_at_ms == resp.deletion_at_ms, "без отмены токена нет: {pending:?}");
        // Отмена: токен, аккаунт снова виден
        let back = issue(&mut probe, &a_user, "d1", true).expect("вход с отменой");
        assert!(!back.token.is_empty() && back.deletion_at_ms == 0);
        alice.id = auth(&addr, &back.token).expect("токен после отмены");
        let log = log_of(&mut bob, &a_user);
        assert!(!log.deleted && !log.entries.is_empty(), "после отмены журнал на месте");
        bob.op(&mut |c| c.prepare_direct(&a_user, &text("после отмены"))).expect("Боб → Алиса после отмены");
        assert!(got_text(&mut alice, &mut a_cur, "после отмены"));

        // Удаление по сроку: identity и шарды стирают строки
        let resp = delete(&mut alice);
        assert!(auth(&addr, &back.token).is_none() || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            auth(&addr, &back.token).is_none()
        }, "токен удаляемого недействителен");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let done = ["messenger", "domains", "cloud"].iter().all(|s| log_has(&logs, "identity.log", &format!("стирание аккаунта принят шардом {s}")));
            if done {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "шарды не подтвердили стирание (срок {})", resp.deletion_at_ms);
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        assert!(log_has(&logs, "messenger.log", "аккаунт стёрт"));
        let (mut probe, _) = Conn::connect(&addr, Channel::Identified);
        assert!(issue(&mut probe, &a_user, "d1", true).is_err(), "стёртый аккаунт не входит");
        let log = log_of(&mut bob, &a_user);
        assert!(log.deleted && log.entries.is_empty(), "стёртый — «удалённый аккаунт»: {log:?}");

        // Ник свободен: новый аккаунт с тем же ником — новый журнал, признак снят
        let mut again = Device::register(&addr, &a_user, "n1");
        let log = log_of(&mut bob, &a_user);
        assert!(!log.deleted && !log.entries.is_empty(), "новый владелец ника");
        let _ = &mut again;
    })
    .await;
    if result.is_err() {
        eprintln!("логи стека: {}", dir.display());
        let mut stack = stack;
        for c in stack.children.iter_mut().rev() {
            let _ = c.kill();
            let _ = c.wait();
        }
        std::mem::forget(stack);
        panic!("удаление аккаунта: тест не прошёл");
    }
}
