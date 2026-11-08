//! spec 035 T015 (FR-047, contracts/versioning.md): минимум минорной версии протокола.
//! Gateway без `PARVANE_V2_MIN_MINOR` в окружении (значение по умолчанию — минимум выпуска
//! `PROTO_MINOR_035`) отвечает на `Hello.proto_minor` ниже минимума `UPGRADE_REQUIRED` и закрывает
//! соединение; клиент текущей версии получает `Welcome` с `min_supported_minor` = минимум.
//! Межсерверная половина (S2S-кадр от сервера ниже минимума) — `v2_federation_live.rs`,
//! `federation_partner_below_min_minor_refused`.
//!
//! Без `nats-server` тест печатает SKIP и проходит.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{frame, response, Channel, ErrorCode, Frame, Hello};

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
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => PathBuf::from(dir).join("debug"),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug"),
    }
}

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin))
        .envs(envs.iter().copied())
        // Значение по умолчанию проверяется — окружение теста не должно его подменять.
        .env_remove("PARVANE_V2_MIN_MINOR")
        .env("PARVANE_LOG_LEVEL", "info")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

fn start() -> Option<Stack> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    let status = Command::new(env!("CARGO"))
        .args(["build", "-p", "identity", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2minor-{}-{}", std::process::id(), free_port()));
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
    children.push(spawn(
        "gateway",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws)],
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp };
    let t0 = Instant::now();
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(60), "gateway не слушает");
        std::thread::sleep(Duration::from_millis(100));
    }
    Some(stack)
}

struct Conn {
    s: TcpStream,
    dec: TcpDecoder,
}

impl Conn {
    fn hello(addr: &str, minor: u32) -> Conn {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(TCP_MAGIC).unwrap();
        let mut c = Conn { s, dec: TcpDecoder::new() };
        let b = codec::tcp_encode(&codec::encode_frame(frame::Kind::Hello(Hello {
            proto_minor: minor,
            channel: Channel::Identified as i32,
            ..Default::default()
        })));
        c.s.write_all(&b).unwrap();
        c
    }

    fn recv(&mut self) -> Option<Frame> {
        let mut buf = [0u8; 65536];
        loop {
            if let Ok(Some(f)) = self.dec.next_frame() {
                return codec::decode_frame(&f, Origin::Server).ok();
            }
            match self.s.read(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(n) => self.dec.push(&buf[..n]).ok()?,
            }
        }
    }
}

#[test]
fn gateway_refuses_hello_below_min_minor() {
    let Some(stack) = start() else { return };
    // Клиент прежнего выпуска (минор 0) — отказ и закрытие.
    let mut old = Conn::hello(&stack.gateway_tcp, 0);
    let f = old.recv().expect("ответ на Hello");
    match f.kind {
        Some(frame::Kind::Response(r)) => match r.result {
            Some(response::Result::Error(e)) => assert_eq!(ErrorCode::try_from(e.code), Ok(ErrorCode::UpgradeRequired), "код отказа"),
            other => panic!("ожидался отказ UPGRADE_REQUIRED, получено {other:?}"),
        },
        other => panic!("ожидался отказ UPGRADE_REQUIRED, получено {other:?}"),
    }
    assert!(old.recv().is_none(), "соединение после отказа не закрыто");

    let current = parvane_protocol::PROTO_MINOR;
    assert!(current >= 1, "выпуск spec 035 поднимает proto_minor (сейчас {current})");

    // Минор ниже текущего на 1 — тоже отказ (минимум = текущий выпуск).
    let mut prev = Conn::hello(&stack.gateway_tcp, current - 1);
    assert!(matches!(prev.recv().and_then(|f| f.kind), Some(frame::Kind::Response(_))), "минор {} принят", current - 1);

    // Клиент текущего выпуска — Welcome с минимумом.
    let mut cur = Conn::hello(&stack.gateway_tcp, current);
    match cur.recv().and_then(|f| f.kind) {
        Some(frame::Kind::Welcome(w)) => {
            assert_eq!(w.proto_minor, current);
            assert_eq!(w.min_supported_minor, current, "Welcome.min_supported_minor");
        }
        other => panic!("ожидался Welcome, получено {other:?}"),
    }
}
