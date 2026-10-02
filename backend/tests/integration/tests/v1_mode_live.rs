//! Инструмент E6 (T110): режим v1-пути gateway `PARVANE_V1_MODE` против
//! живого стека. Три gateway на одном NATS/identity:
//! - `normal` — вход по v1 без дополнительных кадров;
//! - `notice` — после `auth_ok` приходит `{"op":"notice","kind":"upgrade_available"}`,
//!   v1 работает дальше;
//! - `disabled` — любое v1-соединение на первый же свой кадр (протокол
//!   соединения gateway узнаёт по первым байтам клиента) получает
//!   `{"op":"err","error":"upgrade_required"}` и закрывается.
//! Рукопожатие v2 (Hello → Welcome → Auth → AuthOk) во всех режимах работает.
//!
//! Без `nats-server` тест печатает SKIP и проходит.

mod v2common;

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel};
use parvane_types::topics::{IDENTITY_ISSUE, IDENTITY_REGISTER, IDENTITY_SERVER_INFO};
use serde_json::{json, Value};
use v2common::{Conn, PASSWORD};

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
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

/// Клиент v1 по TCP: строки JSON.
struct Gw {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Gw {
    fn connect(addr: &str) -> Gw {
        let s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(1500))).unwrap();
        Gw { reader: BufReader::new(s.try_clone().unwrap()), writer: s }
    }
    /// false — соединение уже закрыто сервером.
    fn send(&mut self, v: Value) -> bool {
        self.writer.write_all(format!("{v}\n").as_bytes()).is_ok()
    }
    /// Кадр; `None` — закрыто или тишина в пределах таймаута чтения.
    fn recv(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(&line).ok(),
        }
    }
    /// Соединение закрыто сервером (EOF, а не таймаут).
    fn closed(&mut self) -> bool {
        let mut line = String::new();
        matches!(self.reader.read_line(&mut line), Ok(0))
    }
}

async fn req(nc: &async_nats::Client, subject: &str, body: Value) -> Value {
    let resp = tokio::time::timeout(Duration::from_secs(10), nc.request(subject.to_string(), body.to_string().into()))
        .await
        .unwrap_or_else(|_| panic!("{subject}: таймаут"))
        .unwrap_or_else(|e| panic!("{subject}: {e}"));
    serde_json::from_slice(&resp.payload).unwrap_or(Value::Null)
}

/// Рукопожатие v2 на том же TCP-порту: Welcome и AuthOk.
fn v2_handshake(addr: &str, token: &str) -> bool {
    let (mut c, w) = Conn::connect(addr, Channel::Identified);
    if !matches!(w.kind, Some(frame::Kind::Welcome(_))) {
        return false;
    }
    c.send(frame::Kind::Auth(Auth { token: token.into() }));
    matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v1_mode_notice_and_disabled_live() {
    let Some(nats_bin) = find_nats_server() else {
        eprintln!("SKIP: nats-server не найден (PATH, ~/.local/bin)");
        return;
    };
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v1mode-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_port = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let children = vec![Command::new(nats_bin)
        .args(["-a", "127.0.0.1", "-p", &nats_port.to_string()])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap()];
    let mut stack = Stack { children, dir };
    let id_db = stack.dir.join("identity.db").to_string_lossy().to_string();
    let wk = stack.dir.join("parvane.json").to_string_lossy().to_string();
    let c = spawn(
        "identity",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &id_db), ("PARVANE_DEV", "1"), ("PARVANE_WELL_KNOWN_FILE", &wk)],
        &stack.dir.join("identity.log"),
    );
    stack.children.push(c);
    // Три gateway: режим читается из окружения при старте процесса.
    let mut addr = std::collections::HashMap::new();
    for mode in ["normal", "notice", "disabled"] {
        let tcp = format!("127.0.0.1:{}", free_port());
        let ws = format!("127.0.0.1:{}", free_port());
        let g = spawn(
            "gateway",
            &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &tcp), ("PARVANE_GATEWAY_BIND", &ws), ("PARVANE_V1_MODE", mode)],
            &stack.dir.join(format!("gateway-{mode}.log")),
        );
        stack.children.push(g);
        addr.insert(mode, tcp);
    }
    let t = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(t.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request(IDENTITY_SERVER_INFO, "{}".into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "identity не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for a in addr.values() {
        while TcpStream::connect(a).is_err() {
            assert!(t.elapsed() < Duration::from_secs(60), "gateway {a} не слушает");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    let user = format!("e6u{}@local", free_port());
    let reg = req(&nc, IDENTITY_REGISTER, json!({"user": user, "password": PASSWORD, "invite": "", "email": "", "client_ip": "127.0.0.1"})).await;
    assert!(reg["error"].is_null(), "регистрация: {reg}");
    let issued = req(&nc, IDENTITY_ISSUE, json!({"user": user, "password": PASSWORD, "device_id": "d1"})).await;
    let token = issued["token"].as_str().unwrap_or_else(|| panic!("issue: {issued}")).to_string();

    let (normal, notice, disabled) = (addr["normal"].clone(), addr["notice"].clone(), addr["disabled"].clone());
    tokio::task::spawn_blocking(move || {
        // normal: вход без дополнительных кадров.
        let mut gw = Gw::connect(&normal);
        assert!(gw.send(json!({"op": "auth", "token": token})));
        let ok = gw.recv().unwrap_or(Value::Null);
        assert_eq!(ok["op"], "auth_ok", "{ok}");
        assert!(gw.recv().is_none(), "normal: после auth_ok кадров нет");
        assert!(v2_handshake(&normal, &token), "normal: рукопожатие v2");

        // notice: сразу после auth_ok — кадр upgrade_available; v1 работает дальше.
        let mut gw = Gw::connect(&notice);
        assert!(gw.send(json!({"op": "auth", "token": token})));
        let ok = gw.recv().unwrap_or(Value::Null);
        assert_eq!(ok["op"], "auth_ok", "{ok}");
        let n = gw.recv().unwrap_or(Value::Null);
        assert_eq!(n, json!({"op": "notice", "kind": "upgrade_available"}), "notice: кадр после входа");
        assert!(gw.send(json!({"op": "req", "id": "r1", "subject": IDENTITY_SERVER_INFO, "payload": "{}"})));
        let r = gw.recv().unwrap_or(Value::Null);
        assert!(r["op"] == "reply" && r["id"] == "r1", "notice: v1-запрос после кадра работает: {r}");
        assert!(v2_handshake(&notice, &token), "notice: рукопожатие v2");
        // До входа кадра notice нет (pre-auth запрос отвечает как обычно).
        let mut pre = Gw::connect(&notice);
        assert!(pre.send(json!({"op": "req", "id": "p1", "subject": IDENTITY_SERVER_INFO, "payload": "{}"})));
        let r = pre.recv().unwrap_or(Value::Null);
        assert!(r["op"] == "reply" && r["id"] == "p1", "notice: pre-auth запрос: {r}");

        // disabled: на первый же v1-кадр (здесь — pre-auth запрос) приходит
        // безадресный upgrade_required вместо ответа, затем закрытие.
        let mut gw = Gw::connect(&disabled);
        assert!(gw.send(json!({"op": "req", "id": "p1", "subject": IDENTITY_SERVER_INFO, "payload": "{}"})));
        let e = gw.recv().unwrap_or(Value::Null);
        assert_eq!(e, json!({"op": "err", "error": "upgrade_required"}), "disabled: первый кадр");
        assert!(e.get("id").is_none(), "disabled: ошибка безадресная");
        assert!(gw.closed(), "disabled: соединение закрыто сервером");
        // Вход по v1 невозможен, v2 на том же порту работает.
        let mut gw = Gw::connect(&disabled);
        let _ = gw.send(json!({"op": "auth", "token": token}));
        let first = gw.recv().unwrap_or(Value::Null);
        assert_eq!(first["error"], "upgrade_required", "disabled: auth не принимается: {first}");
        assert!(gw.closed(), "disabled: после отказа соединение закрыто (auth_ok не приходит)");
        assert!(v2_handshake(&disabled, &token), "disabled: рукопожатие v2 работает");
    })
    .await
    .unwrap();
}
