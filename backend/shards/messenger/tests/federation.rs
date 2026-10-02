//! Адресат на чужом домене (spec 007 US7, T105): без федерации messenger
//! отвечает `Error{FEDERATION_UNAVAILABLE}`, а не теряет сообщение молча.
//! Проверяется живой бинарник messenger через NATS (как его зовёт gateway:
//! `ShardRequest` на subject метода из реестра). Проверка домена в messenger
//! идёт до обращений к identity, поэтому identity для теста не нужен.
//!
//! Без `nats-server` (PATH или `~/.local/bin`) тест печатает SKIP и проходит.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::{
    sealed_envelope, shard_response, DeviceRef, ErrorCode, GroupStateEntry, Ref, SealedEnvelope, ShardRequest, ShardResponse,
};
use parvane_protocol::pb::parvane::group::v2::StateAppendRequest;
use parvane_protocol::pb::parvane::msg::v2::DeliverSealedRequest;
use prost::Message;

const LOCAL: &str = "home.example";

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
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
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

async fn start() -> Option<(Stack, async_nats::Client)> {
    let Some(nats_bin) = find_nats_server() else {
        eprintln!("SKIP: nats-server не найден");
        return None;
    };
    let dir = std::env::temp_dir().join(format!("parvane-msg-fed-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_url = format!("nats://127.0.0.1:{}", free_port());
    let port = nats_url.rsplit(':').next().unwrap().to_string();
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let mut children = vec![Command::new(nats_bin)
        .args(["-a", "127.0.0.1", "-p", &port])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap()];
    let mlog = std::fs::File::create(dir.join("messenger.log")).unwrap();
    children.push(
        Command::new(env!("CARGO_BIN_EXE_messenger"))
            .env("PARVANE_NATS_URL", &nats_url)
            .env("PARVANE_DB_PATH", dir.join("messenger.db"))
            .env("PARVANE_DOMAIN", LOCAL)
            .env("PARVANE_LOG_LEVEL", "info")
            .current_dir(&dir)
            .stdout(Stdio::from(mlog.try_clone().unwrap()))
            .stderr(Stdio::from(mlog))
            .spawn()
            .unwrap(),
    );
    let stack = Stack { children, dir };
    let t0 = Instant::now();
    let nc = loop {
        if let Ok(nc) = async_nats::connect(&nats_url).await {
            break nc;
        }
        assert!(t0.elapsed() < Duration::from_secs(20), "nats-server не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    Some((stack, nc))
}

fn subject_of(method: &str) -> &'static str {
    parvane_protocol::schema::METHODS.iter().find(|m| m.name == method).map(|m| m.subject).unwrap()
}

/// Запрос к messenger так, как его шлёт gateway; ждёт, пока шард поднимется.
async fn call(nc: &async_nats::Client, method: &str, user: &str, body: Vec<u8>, dir: &Path) -> Result<Vec<u8>, ErrorCode> {
    let req = ShardRequest { method: method.into(), user: user.into(), device_id: "d1".into(), body, ..Default::default() };
    let t0 = Instant::now();
    loop {
        let r = tokio::time::timeout(Duration::from_secs(5), nc.request(subject_of(method), req.encode_to_vec().into())).await;
        if let Ok(Ok(msg)) = r {
            let resp = ShardResponse::decode(msg.payload.as_ref()).unwrap();
            return match resp.result {
                Some(shard_response::Result::Ok(b)) => Ok(b),
                Some(shard_response::Result::Error(e)) => Err(ErrorCode::try_from(e.code).unwrap_or(ErrorCode::Unspecified)),
                None => Err(ErrorCode::Unspecified),
            };
        }
        assert!(
            t0.elapsed() < Duration::from_secs(60),
            "messenger не отвечает на {method}; лог:\n{}",
            std::fs::read_to_string(dir.join("messenger.log")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn sealed_to(addr: &str) -> Vec<u8> {
    DeliverSealedRequest {
        envelopes: vec![SealedEnvelope {
            recipient: Some(DeviceRef { address: addr.into(), device_id: "d1".into() }),
            access: Some(sealed_envelope::Access::DeliveryKey(vec![5; 32])),
            hpke_enc: vec![7; 32],
            ciphertext: vec![1, 2, 3],
        }],
    }
    .encode_to_vec()
}

fn append_to(domain: &str) -> Vec<u8> {
    StateAppendRequest {
        entry: Some(GroupStateEntry { group: Some(Ref { domain: domain.into(), id: vec![3; 16] }), version: 1, ..Default::default() }),
    }
    .encode_to_vec()
}

#[tokio::test]
async fn foreign_domain_gets_federation_unavailable() {
    let Some((stack, nc)) = start().await else { return };
    let dir = stack.dir.clone();

    // Sealed-доставка (анонимный канал) адресату чужого сервера.
    let r = call(&nc, "msg.deliver_sealed", "", sealed_to("bob@far.example"), &dir).await;
    assert_eq!(r.err(), Some(ErrorCode::FederationUnavailable), "deliver_sealed → чужой домен");

    // Журнал группы, живущей на чужом сервере.
    let r = call(&nc, "group.state.append", &format!("alice@{LOCAL}"), append_to("far.example"), &dir).await;
    assert_eq!(r.err(), Some(ErrorCode::FederationUnavailable), "group.state.append → чужой домен");

    // Контроль: свой домен до проверки федерации не отбрасывается этим кодом
    // (дальше — проверка доступа/состояния, здесь без identity она не проходит).
    let r = call(&nc, "msg.deliver_sealed", "", sealed_to(&format!("bob@{LOCAL}")), &dir).await;
    assert_ne!(r.err(), Some(ErrorCode::FederationUnavailable), "свой домен");
    let r = call(&nc, "group.state.append", &format!("alice@{LOCAL}"), append_to(LOCAL), &dir).await;
    assert_ne!(r.err(), Some(ErrorCode::FederationUnavailable), "своя группа");
    drop(stack);
}
