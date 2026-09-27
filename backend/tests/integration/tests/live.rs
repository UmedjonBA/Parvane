//! 4.8: интеграционные сценарии с живым nats-server, identity, messenger, push и
//! gateway (реальные бинарники из target/debug, временные БД).
//!
//! Требует `nats-server` в PATH или ~/.local/bin; без него тест печатает SKIP и
//! проходит (в CI бинарник ставит scripts/run_all_tests.sh). Бинарники шардов
//! собираются через `cargo build`, если их ещё нет.
//!
//! Все сценарии крутятся на одном стеке и собирают ошибки в список — падение
//! одного не скрывает остальные.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use parvane_types::topics::*;
use serde_json::{json, Value};

const PASSWORD: &str = "e2e-Test-pass-2026";

// ── стек ─────────────────────────────────────────────────────────────────────

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
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn find_nats_server() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = Path::new(dir).join("nats-server");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let home = std::env::var("HOME").ok()?;
    let p = Path::new(&home).join(".local/bin/nats-server");
    p.is_file().then_some(p)
}

fn target_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug")
}

fn ensure_binaries(names: &[&str]) {
    // Всегда `cargo build` нужных шардов: при актуальных бинарниках это no-op,
    // а устаревший бинарник давал бы ложные результаты.
    eprintln!("cargo build {:?}", names);
    let mut cmd = Command::new(env!("CARGO"));
    cmd.arg("build").current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    for n in names {
        cmd.arg("-p").arg(n);
    }
    let status = cmd.status().expect("cargo build");
    assert!(status.success(), "cargo build {:?} не удался", names);
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

async fn wait_ready(nats_url: &str, subject: &str, deadline: Duration) -> async_nats::Client {
    let start = Instant::now();
    let nc = loop {
        match async_nats::connect(nats_url).await {
            Ok(nc) => break nc,
            Err(e) if start.elapsed() < deadline => {
                let _ = e;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => panic!("nats-server не поднялся: {e}"),
        }
    };
    // ждём, пока появится подписчик: request с коротким таймаутом
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject.to_string(), "{}".into())).await;
        match r {
            Ok(Ok(_)) => return nc,
            _ if start.elapsed() < deadline => tokio::time::sleep(Duration::from_millis(100)).await,
            _ => panic!("{subject} не отвечает за {deadline:?}"),
        }
    }
}

async fn start_stack() -> Option<(Stack, async_nats::Client)> {
    let Some(nats_bin) = find_nats_server() else {
        eprintln!("SKIP: nats-server не найден (PATH, ~/.local/bin)");
        return None;
    };
    ensure_binaries(&["identity", "messenger", "push", "gateway"]);
    let dir = std::env::temp_dir().join(format!("parvane-live-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_port = free_port();
    let gw_tcp = free_port();
    let gw_ws = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let mut children = vec![];
    let nats_log = std::fs::File::create(dir.join("nats.log")).unwrap();
    children.push(
        Command::new(nats_bin)
            .args(["-a", "127.0.0.1", "-p", &nats_port.to_string()])
            .stdout(Stdio::from(nats_log.try_clone().unwrap()))
            .stderr(Stdio::from(nats_log))
            .spawn()
            .expect("nats-server"),
    );
    let db = |n: &str| dir.join(format!("{n}.db")).to_string_lossy().to_string();
    let id_db = db("identity");
    children.push(spawn(
        "identity",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &id_db), ("PARVANE_DEV", "1")],
        &dir.join("identity.log"),
    ));
    let m_db = db("messenger");
    children.push(spawn(
        "messenger",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)],
        &dir.join("messenger.log"),
    ));
    let p_db = db("push");
    children.push(spawn(
        "push",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &p_db)],
        &dir.join("push.log"),
    ));
    let gateway_tcp = format!("127.0.0.1:{gw_tcp}");
    let gateway_ws = format!("127.0.0.1:{gw_ws}");
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_GATEWAY_REVERIFY_SECS", "1"),
        ],
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp };
    let nc = wait_ready(&nats_url, IDENTITY_SERVER_INFO, Duration::from_secs(20)).await;
    // messenger и push: ждём их подписки
    let _ = wait_ready(&nats_url, GROUP_LIST, Duration::from_secs(20)).await;
    let _ = wait_ready(&nats_url, PUSH_VAPID_GET, Duration::from_secs(20)).await;
    // gateway: ждём открытия TCP-порта
    let start = Instant::now();
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(start.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

// ── помощники ────────────────────────────────────────────────────────────────

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

async fn req(nc: &async_nats::Client, subject: &str, body: Value) -> Value {
    let resp = tokio::time::timeout(Duration::from_secs(5), nc.request(subject.to_string(), body.to_string().into()))
        .await
        .unwrap_or_else(|_| panic!("{subject}: таймаут"))
        .unwrap_or_else(|e| panic!("{subject}: {e}"));
    serde_json::from_slice(&resp.payload).unwrap_or(Value::Null)
}

fn envelope(from: &str, token: &str, payload: Value) -> Value {
    json!({"id": uuid::Uuid::now_v7().to_string(), "from": from, "ts": now(), "token": token, "payload": payload})
}

fn envelope_with_id(id: &str, from: &str, token: &str, payload: Value) -> Value {
    json!({"id": id, "from": from, "ts": now(), "token": token, "payload": payload})
}

async fn register(nc: &async_nats::Client, user: &str, password: &str) -> Value {
    req(nc, IDENTITY_REGISTER, json!({"user": user, "password": password, "invite": "", "email": "", "client_ip": "127.0.0.1"})).await
}

async fn issue(nc: &async_nats::Client, user: &str, device: Option<&str>) -> String {
    let r = req(nc, IDENTITY_ISSUE, json!({"user": user, "password": PASSWORD, "device_id": device})).await;
    r["token"].as_str().unwrap_or_else(|| panic!("issue {user}: {r}")).to_string()
}

async fn verify(nc: &async_nats::Client, token: &str) -> Value {
    req(nc, IDENTITY_VERIFY, json!({"token": token})).await
}

async fn sync_messages(nc: &async_nats::Client, user: &str, token: &str) -> Vec<Value> {
    let r = req(
        nc,
        MSG_SYNC_REQUEST,
        envelope(user, token, json!({"last_seen_id": "00000000-0000-0000-0000-000000000000", "device_id": "", "since_updated": 0})),
    )
    .await;
    r["payload"]["messages"].as_array().cloned().unwrap_or_default()
}

async fn sync_ids(nc: &async_nats::Client, user: &str, token: &str) -> Vec<String> {
    let r = req(
        nc,
        MSG_SYNC_REQUEST,
        envelope(user, token, json!({"last_seen_id": "00000000-0000-0000-0000-000000000000", "device_id": "", "since_updated": 0})),
    )
    .await;
    r["payload"]["messages"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Публикация prekey-бандла устройства (регистрирует устройство в identity);
/// сервер криптографию бандла не проверяет — значения случайные.
async fn publish_prekeys(nc: &async_nats::Client, token: &str, device_id: &str) -> Value {
    let rnd = |n: usize| {
        use rand::RngCore;
        let mut b = vec![0u8; n];
        rand::rngs::OsRng.fill_bytes(&mut b);
        b64(&b)
    };
    req(
        nc,
        IDENTITY_PREKEYS_PUBLISH,
        json!({
            "token": token, "device_id": device_id, "signing_key": rnd(32), "registration_id": 1,
            "identity_key": rnd(32), "signed_prekey_id": 1, "signed_prekey": rnd(32), "signed_prekey_sig": rnd(64),
            "one_time": [],
        }),
    )
    .await
}

fn b64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in b.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn text(t: &str) -> Value {
    json!({"kind": "text", "text": t})
}

/// Подписанный чужим Ed25519-ключом JWT с теми же claims (форма верная, ключ нет).
fn forged_token(user: &str) -> String {
    let signing = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    // PKCS#8 v1 для Ed25519: фиксированный префикс + 32-байтовый seed
    let mut der = hex_prefix();
    der.extend_from_slice(signing.as_bytes());
    let key = jsonwebtoken::EncodingKey::from_ed_der(&der);
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA);
    header.kid = Some("deadbeefdeadbeef".into());
    let claims = json!({"sub": user, "exp": now() + 3600, "iat": now()});
    jsonwebtoken::encode(&header, &claims, &key).unwrap()
}

fn hex_prefix() -> Vec<u8> {
    vec![0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]
}

/// Просроченный токен настоящим ключом identity (файл рядом с БД).
fn expired_token(stack: &Stack, user: &str) -> String {
    let pem = std::fs::read_to_string(stack.dir.join("identity-jwt-ed25519.pem")).expect("ключ identity");
    let key = jsonwebtoken::EncodingKey::from_ed_pem(pem.as_bytes()).unwrap();
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA);
    // leeway jsonwebtoken по умолчанию 60 с — берём заведомо просроченный
    let claims = json!({"sub": user, "exp": now() - 600, "iat": now() - 4200});
    jsonwebtoken::encode(&header, &claims, &key).unwrap()
}

/// Клиент gateway по TCP: строки JSON.
struct Gw {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Gw {
    fn connect(addr: &str) -> Gw {
        let s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        Gw { reader: BufReader::new(s.try_clone().unwrap()), writer: s }
    }
    fn send(&mut self, v: Value) {
        self.writer.write_all(format!("{v}\n").as_bytes()).unwrap();
    }
    fn publish(&mut self, subject: &str, payload: Value) {
        self.send(json!({"op": "pub", "subject": subject, "payload": payload.to_string()}));
    }
    fn send_raw(&mut self, raw: &str) {
        self.writer.write_all(raw.as_bytes()).unwrap();
    }
    fn recv(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(&line).ok(),
        }
    }
    fn auth(&mut self, token: &str) -> Value {
        self.send(json!({"op": "auth", "token": token}));
        self.recv().unwrap_or(Value::Null)
    }
    fn request(&mut self, subject: &str, payload: Value) -> Value {
        let id = uuid::Uuid::now_v7().to_string();
        // payload в кадрах gateway — строка с JSON (как у web/desktop клиентов)
        self.send(json!({"op": "req", "id": id, "subject": subject, "payload": payload.to_string()}));
        loop {
            let f = self.recv().unwrap_or(Value::Null);
            if f["id"] == id || f["op"] == "err" && f["id"].is_null() {
                return f;
            }
            if f.is_null() {
                return f;
            }
        }
    }
}

struct Failures(Vec<String>);
impl Failures {
    fn check(&mut self, name: &str, ok: bool, detail: impl std::fmt::Display) {
        if ok {
            eprintln!("  ok   {name}");
        } else {
            eprintln!("  FAIL {name} — {detail}");
            self.0.push(format!("{name}: {detail}"));
        }
    }
}

// ── сценарии ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn live_stack_adversarial_scenarios() {
    let Some((stack, nc)) = start_stack().await else { return };
    let mut f = Failures(vec![]);

    // 1. регистрация: политика пароля и домен
    let weak = register(&nc, "alice@local", "short").await;
    f.check("register: короткий пароль отклонён", weak["ok"] == false, &weak);
    let foreign = register(&nc, "eve@evil", PASSWORD).await;
    f.check("register: чужой домен отклонён", foreign["ok"] == false, &foreign);
    let a = register(&nc, "alice@local", PASSWORD).await;
    f.check("register: alice", a["ok"] == true, &a);
    let b = register(&nc, "bob@local", PASSWORD).await;
    f.check("register: bob", b["ok"] == true, &b);
    let m = register(&nc, "mallory@local", PASSWORD).await;
    f.check("register: mallory", m["ok"] == true, &m);

    // 2. issue/verify
    let bad = req(&nc, IDENTITY_ISSUE, json!({"user": "alice@local", "password": "wrong-password-1"})).await;
    f.check("issue: неверный пароль", bad["ok"] == false && bad["token"].is_null(), &bad);
    let alice = issue(&nc, "alice@local", Some("dev-a1")).await;
    let bob = issue(&nc, "bob@local", Some("dev-b1")).await;
    let mallory = issue(&nc, "mallory@local", Some("dev-m1")).await;
    let v = verify(&nc, &alice).await;
    f.check("verify: свой токен", v["ok"] == true && v["user"] == "alice@local", &v);
    let pk = publish_prekeys(&nc, &alice, "dev-a1").await;
    f.check("prekeys.publish: alice/dev-a1", pk["ok"] == true, &pk);
    let pk = publish_prekeys(&nc, &bob, "dev-b1").await;
    f.check("prekeys.publish: bob/dev-b1", pk["ok"] == true, &pk);
    let pk = publish_prekeys(&nc, &forged_token("alice@local"), "dev-x").await;
    f.check("prekeys.publish: поддельный токен отклонён", pk["ok"] == false, &pk);

    // 3. чужой (поддельный) и просроченный токены
    let forged = forged_token("alice@local");
    let v = verify(&nc, &forged).await;
    f.check("verify: токен чужим ключом отклонён", v["ok"] == false, &v);
    let expired = expired_token(&stack, "alice@local");
    let v = verify(&nc, &expired).await;
    f.check("verify: просроченный токен отклонён", v["ok"] == false, &v);
    // messenger: send с поддельным токеном не доставляется
    nc.publish(MSG_SEND.to_string(), envelope("alice@local", &forged, json!({"to": "bob@local", "content": text("forged")})).to_string().into())
        .await
        .unwrap();
    // и с чужим from при настоящем токене mallory (validate_sender)
    nc.publish(MSG_SEND.to_string(), envelope("alice@local", &mallory, json!({"to": "bob@local", "content": text("spoofed from")})).to_string().into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let ids = sync_ids(&nc, "bob@local", &bob).await;
    f.check("messenger: send с поддельным токеном/чужим from не сохранён", ids.is_empty(), format!("{ids:?}"));

    // 4. subject-инъекция через `to` и повтор id
    let bad_to = ["bob@local.>", "bob@local.*", "bob@local\r\nPUB x", " bob@local", "bob@local.evil"];
    for to in bad_to {
        nc.publish(MSG_SEND.to_string(), envelope("alice@local", &alice, json!({"to": to, "content": text("inject")})).to_string().into())
            .await
            .unwrap();
    }
    let mid = uuid::Uuid::now_v7().to_string();
    for _ in 0..2 {
        nc.publish(MSG_SEND.to_string(), envelope_with_id(&mid, "alice@local", &alice, json!({"to": "bob@local", "content": text("hello")})).to_string().into())
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ids = sync_ids(&nc, "bob@local", &bob).await;
    f.check("messenger: невалидные `to` отброшены, повтор id сохранён один раз", ids == vec![mid.clone()], format!("{ids:?}"));

    // 5. размер payload: контент больше лимита не сохраняется
    let huge = "x".repeat(300 * 1024);
    let big_id = uuid::Uuid::now_v7().to_string();
    nc.publish(MSG_SEND.to_string(), envelope_with_id(&big_id, "alice@local", &alice, json!({"to": "bob@local", "content": text(&huge)})).to_string().into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let ids = sync_ids(&nc, "bob@local", &bob).await;
    f.check("messenger: контент > лимита отброшен", !ids.contains(&big_id), format!("{ids:?}"));
    // NATS max_payload (1 МиБ по умолчанию) — клиент не может даже отправить
    let too_big = vec![b'x'; 2 * 1024 * 1024];
    let r = nc.publish(MSG_SEND.to_string(), too_big.into()).await;
    f.check("nats: публикация > max_payload отклонена клиентом", r.is_err(), format!("{r:?}"));

    // 6. правка не меняет E2E-вид: text → encrypted запрещено (edit — publish без ответа)
    nc.publish(
        MSG_EDIT.to_string(),
        envelope("alice@local", &alice, json!({"message_id": mid, "content": {"kind": "encrypted", "ciphertext": "AAAA", "session_id": "s", "message_type": 1}, "copies": []}))
            .to_string()
            .into(),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let msgs = sync_messages(&nc, "bob@local", &bob).await;
    let kind = msgs.iter().find(|m| m["id"] == mid).map(|m| m["content"]["kind"].clone());
    f.check("messenger: edit со сменой вида отклонён", kind.as_ref().map(|k| k == "text").unwrap_or(false), format!("{kind:?}"));

    // 7. push: endpoint без схемы / приватный IP / http
    for ep in ["fcm.googleapis.com/fcm/send/x", "https://10.0.0.1/push", "http://fcm.googleapis.com/x", "https://127.0.0.1/x"] {
        let r = req(&nc, PUSH_REGISTER, json!({"token": alice, "subscription": {"endpoint": ep, "keys": {"p256dh": "BA", "auth": "AA"}}})).await;
        f.check(&format!("push: endpoint {ep} отклонён"), r["ok"] == false, &r);
    }

    // 8. gateway: ACL и привязка к JWT
    let mut gw = Gw::connect(&stack.gateway_tcp);
    let pre = gw.request(GROUP_LIST, json!({"token": alice}));
    f.check("gateway: req до auth запрещён", pre["op"] == "err", &pre);
    let bad_auth = Gw::connect(&stack.gateway_tcp).auth(&forged);
    f.check("gateway: auth поддельным токеном", bad_auth["op"] == "auth_err", &bad_auth);
    let ok = gw.auth(&alice);
    f.check("gateway: auth alice", ok["op"] == "auth_ok" && ok["user"] == "alice@local", &ok);
    gw.send(json!({"op": "sub", "subject": msg_inbox("bob@local")}));
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: sub на чужой инбокс запрещён", r["op"] == "err", &r);
    for s in ["msg.user.>", "msg.user.*", "presence.*", "msg.typing.>", "_INBOX.>"] {
        gw.send(json!({"op": "sub", "subject": s}));
        let r = gw.recv().unwrap_or(Value::Null);
        f.check(&format!("gateway: sub {s} запрещён"), r["op"] == "err", &r);
    }
    gw.send_raw("{\"op\":\"sub\",\"subject\":\"msg.user.alice@local\\r\\n\"}\n");
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: CRLF в subject запрещён", r["op"] == "err", &r);
    gw.publish(&msg_inbox("bob@local"), json!({"x": 1}));
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: pub в чужой инбокс запрещён", r["op"] == "err", &r);
    // plaintext-правка через gateway
    gw.publish(MSG_EDIT, envelope("alice@local", &alice, json!({"message_id": mid, "text": "plain"})));
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: plaintext edit отклонён", r["op"] == "err" && r["error"].as_str().unwrap_or("").contains("plaintext"), &r);
    // plaintext-отправка через gateway запрещена целиком (SEND-1)
    gw.publish(MSG_SEND, envelope("alice@local", &alice, json!({"to": "bob@local", "content": text("plain")})));
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: plaintext send отклонён", r["op"] == "err" && r["error"].as_str().unwrap_or("").contains("plaintext"), &r);
    // E2E-конверт с инъекцией в `to` режется на gateway до шины (P-01)
    gw.publish(MSG_SEND, envelope("alice@local", &alice, json!({"to": "bob@local.>", "content": {"kind": "encrypted", "ciphertext": "AAAA", "session_id": "s", "message_type": 1}})));
    let r = gw.recv().unwrap_or(Value::Null);
    f.check("gateway: wildcard в `to` отклонён до NATS", r["op"] == "err", &r);
    // подмена from: gateway привязывает from к JWT-субъекту. bob шлёт read-квитанцию
    // «от mallory» — messenger видит bob (участник), квитанция записывается за bob.
    let mut gw_b = Gw::connect(&stack.gateway_tcp);
    let ok = gw_b.auth(&bob);
    f.check("gateway: auth bob", ok["op"] == "auth_ok", &ok);
    gw_b.publish(MSG_READ, envelope("mallory@local", &bob, json!({"message_id": mid})));
    gw_b.writer.set_read_timeout(Some(Duration::from_millis(800))).unwrap();
    let after_pub = gw_b.recv();
    gw_b.writer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    f.check("gateway: pub msg.chat.read принят (нет err-кадра)", after_pub.is_none(), format!("{after_pub:?}"));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let readers = req(&nc, MSG_READERS, envelope("alice@local", &alice, json!({"message_id": mid}))).await;
    let names: Vec<String> = readers["readers"]
        .as_array()
        .map(|a| a.iter().filter_map(|r| r["address"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    f.check("gateway: from перепривязан к JWT-субъекту (read от bob, не от mallory)", names == vec!["bob@local".to_string()], format!("{readers}"));

    // 9. отзыв устройства посреди сессии: verify падает, gateway рвёт сессию при переверификации
    let rev = req(&nc, IDENTITY_DEVICE_REVOKE, json!({"token": bob, "device_id": "dev-a1", "password": PASSWORD})).await;
    f.check("revoke: чужое устройство нельзя отозвать", rev["ok"] == false, &rev);
    let rev = req(&nc, IDENTITY_DEVICE_REVOKE, json!({"token": alice, "device_id": "dev-a1"})).await;
    f.check("revoke: без пароля отклонён (P-07)", rev["ok"] == false, &rev);
    let rev = req(&nc, IDENTITY_DEVICE_REVOKE, json!({"token": alice, "device_id": "dev-a1", "password": PASSWORD})).await;
    f.check("revoke: своё устройство с паролем", rev["ok"] == true, &rev);
    let v = verify(&nc, &alice).await;
    f.check("verify: отозванный токен отклонён", v["ok"] == false, &v);
    let mut closed = false;
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        match gw.recv() {
            Some(fr) if fr["op"] == "auth_err" => {
                closed = true;
                break;
            }
            Some(_) => continue,
            None => {
                closed = true;
                break;
            }
        }
    }
    f.check("gateway: сессия отозванного устройства разорвана переверификацией", closed, "нет auth_err/закрытия за 6 с");
    let again = Gw::connect(&stack.gateway_tcp).auth(&alice);
    f.check("gateway: повторный auth отозванным токеном", again["op"] == "auth_err", &again);

    // 10. gateway: sub на свой инбокс работает и доставляет
    let mut gw_b2 = Gw::connect(&stack.gateway_tcp);
    let ok = gw_b2.auth(&bob);
    f.check("gateway: auth bob (вторая сессия)", ok["op"] == "auth_ok", &ok);
    gw_b2.send(json!({"op": "sub", "subject": msg_inbox("bob@local")}));
    let mut sub = nc.subscribe(msg_inbox("bob@local")).await.unwrap();
    nc.publish(MSG_SEND.to_string(), envelope("mallory@local", &mallory, json!({"to": "bob@local", "content": text("hi bob")})).to_string().into())
        .await
        .unwrap();
    let direct = tokio::time::timeout(Duration::from_secs(3), sub.next()).await.ok().flatten();
    f.check("messenger: доставка в инбокс bob", direct.is_some(), "нет InboxPush за 3 с");
    let got = (0..5).find_map(|_| gw_b2.recv().filter(|fr| fr["op"] == "msg" && fr["subject"] == msg_inbox("bob@local")));
    f.check("gateway: сообщение пришло подписчику инбокса", got.is_some(), "нет кадра msg");

    assert!(f.0.is_empty(), "провалы:\n  {}", f.0.join("\n  "));
}
