//! T110: протокол v1 удалён из gateway. Любое v1-соединение (JSON-строка по TCP)
//! на первый же свой кадр получает `{"op":"err","error":"upgrade_required"}` и
//! закрывается — при любом значении прежней переменной `PARVANE_V1_MODE`.
//! Рукопожатие v2 (Hello → Welcome → Auth → AuthOk) на том же порту работает.
//!
//! Без `nats-server` тест печатает SKIP и проходит.

mod v2common;

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel};
use parvane_types::topics::IDENTITY_SERVER_INFO;
use serde_json::{json, Value};
use v2common::Conn;

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
async fn v1_frames_are_refused_live() {
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
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("v2.server.describe", vec![].into())).await;
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
    let first = addr.values().next().cloned().unwrap();
    let (u2, a2) = (user.clone(), first.clone());
    let token = tokio::task::spawn_blocking(move || v2common::register_token(&a2, &u2, "d1")).await.unwrap();
    assert!(!token.is_empty(), "session.issue");

    let addrs: Vec<String> = addr.values().cloned().collect();
    tokio::task::spawn_blocking(move || {
        for a in &addrs {
            // На первый же v1-кадр — безадресный upgrade_required и закрытие.
            let mut gw = Gw::connect(a);
            assert!(gw.send(json!({"op": "req", "id": "p1", "subject": IDENTITY_SERVER_INFO, "payload": "{}"})));
            let e = gw.recv().unwrap_or(Value::Null);
            assert_eq!(e, json!({"op": "err", "error": "upgrade_required"}), "{a}: первый кадр v1");
            assert!(gw.closed(), "{a}: соединение закрыто сервером");
            // Вход по v1 невозможен, v2 на том же порту работает.
            let mut gw = Gw::connect(a);
            let _ = gw.send(json!({"op": "auth", "token": token}));
            let first = gw.recv().unwrap_or(Value::Null);
            assert_eq!(first["error"], "upgrade_required", "{a}: auth не принимается: {first}");
            assert!(gw.closed(), "{a}: после отказа соединение закрыто");
            assert!(v2_handshake(a, &token), "{a}: рукопожатие v2 работает");
        }
    })
    .await
    .unwrap();
}
