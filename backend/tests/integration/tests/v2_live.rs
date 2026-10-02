//! Протокол v2 против живого стека (spec 007, E1: T032–T036). Двойной стек:
//! на одном gateway v2-клиент (TCP-преамбула `PVN2`, двоичные кадры) и
//! v1-клиент (построчный JSON) работают одновременно.
//!
//! Без `nats-server` тест печатает SKIP и проходит.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::codec::{self, TcpDecoder, TCP_MAGIC};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    frame, response, Auth, Channel, ErrorCode, Frame, Hello, Request, ServerDescriptor, SignedServerDescriptor,
};
use parvane_protocol::pb::parvane::identity::v2::{SessionReauthRequest, SessionReauthResponse};
use parvane_protocol::pb::parvane::msg::v2::DeliverSealedRequest;
use prost::Message;
use serde_json::{json, Value};

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
        .args(["build", "-p", "identity", "-p", "messenger", "-p", "gateway"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .status()
        .unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2live-{}-{}", std::process::id(), free_port()));
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
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_V2_FEATURES", "sealed"),
        ],
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
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("identity.server.info", "{}".into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(startt.elapsed() < Duration::from_secs(30), "identity не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    loop {
        let r = tokio::time::timeout(Duration::from_millis(300), nc.request("group.list", "{}".into())).await;
        if matches!(r, Ok(Ok(_))) {
            break;
        }
        assert!(startt.elapsed() < Duration::from_secs(30), "messenger не поднялся");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(
            startt.elapsed() < Duration::from_secs(60),
            "gateway не слушает; лог:\n{}",
            std::fs::read_to_string(stack.dir.join("gateway.log")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

async fn nreq(nc: &async_nats::Client, subject: &str, body: Value) -> Value {
    let r = nc.request(subject.to_string(), body.to_string().into()).await.unwrap();
    serde_json::from_slice(&r.payload).unwrap_or(Value::Null)
}

/// v2-клиент по TCP.
struct V2 {
    s: TcpStream,
    dec: TcpDecoder,
    next_id: u64,
}

impl V2 {
    fn connect(addr: &str, channel: Channel) -> (V2, Frame) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(TCP_MAGIC).unwrap();
        let mut c = V2 { s, dec: TcpDecoder::new(), next_id: 0 };
        c.send(frame::Kind::Hello(Hello { proto_minor: 0, channel: channel as i32, ..Default::default() }));
        let w = c.recv().expect("welcome");
        (c, w)
    }
    fn send(&mut self, k: frame::Kind) {
        self.s.write_all(&codec::tcp_encode(&codec::encode_frame(k))).unwrap();
    }
    fn send_raw(&mut self, frame_bytes: &[u8]) {
        self.s.write_all(&codec::tcp_encode(frame_bytes)).unwrap();
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
    /// Запрос → Ok(тело) | Err(код).
    fn call(&mut self, method: &str, body: Vec<u8>) -> Result<Vec<u8>, ErrorCode> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(frame::Kind::Request(Request { id, method: method.into(), body, timeout_ms: 5000 }));
        loop {
            let f = self.recv().expect("ответ");
            if let Some(frame::Kind::Response(r)) = f.kind {
                if r.id != id {
                    continue;
                }
                return match r.result {
                    Some(response::Result::Ok(b)) => Ok(b),
                    Some(response::Result::Error(e)) => Err(ErrorCode::try_from(e.code).unwrap()),
                    None => Err(ErrorCode::Unspecified),
                };
            }
        }
    }
}

struct Failures(Vec<String>);
impl Failures {
    fn check(&mut self, name: &str, ok: bool, detail: impl std::fmt::Debug) {
        if ok {
            eprintln!("PASS {name}");
        } else {
            eprintln!("FAIL {name}: {detail:?}");
            self.0.push(name.to_string());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_dual_stack_live() {
    let Some((stack, nc)) = start().await else { return };
    let mut f = Failures(vec![]);
    let addr = stack.gateway_tcp.clone();
    let user = format!("v2u{}@local", free_port());
    let r = nreq(&nc, "identity.user.register", json!({"user": user, "password": PASSWORD, "invite": "", "email": "", "client_ip": "127.0.0.1"})).await;
    f.check("register", r["ok"] == true || r["error"].is_null(), &r);
    let t = nreq(&nc, "identity.token.issue", json!({"user": user, "password": PASSWORD, "device_id": "dev1"})).await;
    let token = t["token"].as_str().unwrap_or("").to_string();
    let t2 = nreq(&nc, "identity.token.issue", json!({"user": user, "password": PASSWORD})).await;
    let token_nodev = t2["token"].as_str().unwrap_or("").to_string();

    let (a, token, token_nodev) = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        // 1) Hello → Welcome с подписанным описателем.
        let (mut c, w) = V2::connect(&addr, Channel::Identified);
        let welcome = match w.kind.clone() {
            Some(frame::Kind::Welcome(w)) => Some(w),
            _ => None,
        };
        f.check("welcome", welcome.is_some(), &w);
        if let Some(w) = welcome {
            let sd = SignedServerDescriptor::decode(w.server_descriptor.as_slice()).unwrap_or_default();
            let d = ServerDescriptor::decode(sd.descriptor.as_slice()).unwrap_or_default();
            let ok = parvane_protocol::sign::verify_ctx(&d.server_key, &sd.signature, parvane_protocol::sign::ctx::SERVER_DESCRIPTOR, &[&sd.descriptor]).is_ok();
            f.check("descriptor-signed", ok && d.proto_major == 2, &d);
            f.check("features", w.features == vec!["sealed".to_string()], &w.features);
        }
        // 2) ID-метод до Auth → FORBIDDEN; PRE — проходит в шард.
        f.check("id-before-auth", c.call("msg.inbox.sync", vec![]) == Err(ErrorCode::Forbidden), "");
        f.check("pre-reaches-shard", c.call("server.describe", vec![]).is_ok(), "");
        // 3) v1-топик через v2 → INVALID.
        f.check("v1-topic-rejected", c.call("msg.chat.send", vec![]) == Err(ErrorCode::Invalid), "");
        // 4) ANON-метод в идентифицированной сессии → FORBIDDEN (D-05).
        f.check("anon-in-id", c.call("msg.deliver_sealed", DeliverSealedRequest::default().encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // 5) Auth → AuthOk с устройством.
        c.send(frame::Kind::Auth(Auth { token: token.clone() }));
        let ok = matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(a)) if a.device_id == "dev1");
        f.check("auth-ok", ok, "");
        // 6) reauth: опасный метод без подтверждения → REAUTH_REQUIRED.
        f.check("reauth-required", c.call("identity.device.revoke", vec![]) == Err(ErrorCode::ReauthRequired), "");
        let bad = SessionReauthRequest { password: "wrong".into(), ..Default::default() }.encode_to_vec();
        f.check("reauth-wrong-password", c.call("identity.session.reauth", bad) == Err(ErrorCode::Forbidden), "");
        let good = SessionReauthRequest { password: PASSWORD.into(), ..Default::default() }.encode_to_vec();
        let r = c.call("identity.session.reauth", good);
        let fresh = r.as_ref().ok().and_then(|b| SessionReauthResponse::decode(b.as_slice()).ok()).is_some_and(|x| x.valid_until_ms > 0);
        f.check("reauth-ok", fresh, &r);
        // После подтверждения отзыв допускается gateway (реализация метода — US1).
        f.check("reauth-then-revoke-admitted", c.call("identity.device.revoke", vec![]) != Err(ErrorCode::ReauthRequired), "");
        // 7) Серверное поле от клиента → INVALID, соединение живо.
        let bad_frame = Frame { proto_major: 2, kind: Some(frame::Kind::AuthOk(Default::default())) }.encode_to_vec();
        c.send_raw(&bad_frame);
        let got = c.recv();
        f.check("wrong-direction", matches!(got.and_then(|f| f.kind), Some(frame::Kind::Response(r)) if r.id == 0), "");
        // 8) Ping/Pong.
        c.send(frame::Kind::Ping(parvane_protocol::pb::parvane::core::v2::Ping { nonce: 42 }));
        f.check("pong", matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::Pong(p)) if p.nonce == 42), "");
        // 9) Мажорная версия 3 → UPGRADE_REQUIRED.
        let mut s = TcpStream::connect(&addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(TCP_MAGIC).unwrap();
        s.write_all(&codec::tcp_encode(&Frame { proto_major: 3, kind: Some(frame::Kind::Hello(Hello::default())) }.encode_to_vec())).unwrap();
        let mut up = V2 { s, dec: TcpDecoder::new(), next_id: 0 };
        let upgrade = matches!(up.recv().and_then(|f| f.kind), Some(frame::Kind::Response(r)) if matches!(&r.result, Some(response::Result::Error(e)) if e.code == ErrorCode::UpgradeRequired as i32));
        f.check("upgrade-required", upgrade, "");
        // 10) Токен без dev → отказ (класс 5).
        let (mut c2, _) = V2::connect(&addr, Channel::Identified);
        c2.send(frame::Kind::Auth(Auth { token: token_nodev.clone() }));
        let denied = matches!(c2.recv().and_then(|f| f.kind), Some(frame::Kind::Response(r)) if matches!(&r.result, Some(response::Result::Error(e)) if e.code == ErrorCode::Forbidden as i32));
        f.check("token-without-dev-denied", denied, "");
        // 11) Анонимный канал: Auth запрещён, ID-методы запрещены.
        let (mut an, _) = V2::connect(&addr, Channel::AnonymousDelivery);
        f.check("anon-id-method", an.call("msg.inbox.sync", vec![]) == Err(ErrorCode::Forbidden), "");
        f.check("anon-pre-method", an.call("identity.session.issue", vec![]) == Err(ErrorCode::Forbidden), "");
        (f, token, token_nodev)
    })
    .await
    .unwrap();
    let _ = token_nodev;
    f.0.extend(a.0);

    // 12) v1-клиент на том же gateway работает как раньше.
    let addr = stack.gateway_tcp.clone();
    let v1ok = tokio::task::spawn_blocking(move || {
        let s = TcpStream::connect(&addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        w.write_all(format!("{}\n", json!({"op": "auth", "token": token})).as_bytes()).unwrap();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).map(|v| v["op"] == "auth_ok").unwrap_or(false)
    })
    .await
    .unwrap();
    f.check("v1-still-works", v1ok, "");
    // 13) .well-known описатель записан identity.
    let wk = std::fs::read_to_string(stack.dir.join("parvane.json")).unwrap_or_default();
    f.check("well-known-written", wk.contains("descriptor") && wk.contains("signature"), &wk);
    assert!(f.0.is_empty(), "провалены сценарии v2: {:?} (логи: {})", f.0, stack.dir.display());
}

// ── identity v2 (T047–T051, T119, T071, T121) ───────────────────────────────

fn ok_of<M: Message + Default>(r: Result<Vec<u8>, ErrorCode>, name: &str, f: &mut Failures) -> Option<M> {
    match r {
        Ok(b) => M::decode(b.as_slice()).ok(),
        Err(e) => {
            f.check(name, false, e);
            None
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_identity_live() {
    use parvane_protocol::identity::RootIdentity;
    use parvane_protocol::olm::OlmAccount;
    use parvane_protocol::pb::parvane::core::v2::{DeviceCertificate, UserRef};
    use parvane_protocol::pb::parvane::identity::v2 as ipb;
    use parvane_protocol::tokens;

    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let user = format!("v2id{}@local", free_port());
    let res = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        // Регистрация и вход через v2 (правила v1 под капотом).
        let (mut c, _) = V2::connect(&addr, Channel::Identified);
        let reg = c.call("identity.account.register", ipb::AccountRegisterRequest { user: user.clone(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
        f.check("v2-register", reg.is_ok(), &reg);
        let weak = c.call("identity.account.register", ipb::AccountRegisterRequest { user: format!("x{user}"), password: "123".into(), ..Default::default() }.encode_to_vec());
        f.check("v2-register-weak-password", weak.is_err(), &weak);
        let issue = c.call("identity.session.issue", ipb::SessionIssueRequest { login: user.clone(), password: PASSWORD.into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec());
        let token = ok_of::<ipb::SessionIssueResponse>(issue, "v2-issue", &mut f).map(|r| r.token).unwrap_or_default();
        f.check("v2-issue-token", !token.is_empty(), "");
        let bad = c.call("identity.session.issue", ipb::SessionIssueRequest { login: user.clone(), password: "wrong-Pass-1".into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec());
        f.check("v2-issue-wrong-password", bad == Err(ErrorCode::Forbidden), &bad);
        c.send(frame::Kind::Auth(Auth { token }));
        f.check("v2-auth", matches!(c.recv().and_then(|x| x.kind), Some(frame::Kind::AuthOk(_))), "");

        // Журнал устройств: генезис → сертификат устройства d1 + прекеи.
        let root = RootIdentity::generate(&user).unwrap();
        let g = root.genesis_entry().unwrap();
        let r = c.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(g.clone()) }.encode_to_vec());
        f.check("log-genesis", r.is_ok(), &r);
        let again = c.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(g) }.encode_to_vec());
        f.check("log-replay-rejected", again.is_err(), &again);
        let mut acc = OlmAccount::new();
        let mut cert = DeviceCertificate {
            user: Some(UserRef { address: user.clone() }),
            device_id: "d1".into(),
            olm_curve25519: acc.curve25519().to_vec(),
            olm_ed25519: acc.ed25519().to_vec(),
            hpke_x25519: vec![5; 32],
            proto_major: 2,
            serial: 1,
            ..Default::default()
        };
        // Версия и hash головы — из log_sync.
        let sync = ok_of::<ipb::DeviceLogSyncResponse>(c.call("identity.device.log_sync", ipb::DeviceLogSyncRequest { user: Some(UserRef { address: user.clone() }), after_version: 0 }.encode_to_vec()), "log-sync", &mut f);
        let mut log = parvane_protocol::identity::DeviceLog::new(&user).unwrap();
        for e in sync.map(|s| s.entries).unwrap_or_default() {
            log.apply(&e).unwrap();
        }
        // C1-01: доказательство владения ключом устройства.
        parvane_protocol::identity::prove_possession(&acc, &mut cert, &root.root_pub()).unwrap();
        let add = root.add_device_entry(2, log.head_hash, &cert).unwrap();
        let otks: Vec<ipb::OneTimeKey> = acc
            .generate_one_time_keys(3)
            .into_iter()
            .map(|(id, k)| ipb::OneTimeKey {
                signature: parvane_protocol::sign::sign_ctx(&acc, parvane_protocol::sign::ctx::OTK, &[&id, &k]),
                key_id: id,
                curve25519: k.to_vec(),
            })
            .collect();
        let pubr = c.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(add), one_time_keys: otks.clone(), fallback_key: None }.encode_to_vec());
        let stored = ok_of::<ipb::DevicePublishCertificateResponse>(pubr, "publish-cert", &mut f).map(|r| r.one_time_keys_stored).unwrap_or(0);
        f.check("publish-cert-otks", stored == 3, stored);
        // Прекей с чужой подписью отвергается.
        let mut forged = otks[0].clone();
        forged.key_id = b"forged".to_vec();
        let fr = c.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { one_time_keys: vec![forged], ..Default::default() }.encode_to_vec());
        f.check("forged-otk-rejected", fr.is_err(), &fr);

        // Бандл через анонимный канал: сертификат + одноразовый ключ (расходуется).
        let (mut an, _) = V2::connect(&addr, Channel::AnonymousDelivery);
        let b = ok_of::<ipb::DeviceFetchBundleAnonResponse>(an.call("identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: user.clone() }) }.encode_to_vec()), "bundle-anon", &mut f);
        let devs = b.map(|b| b.devices).unwrap_or_default();
        let cert_ok = devs.first().and_then(|d| d.certificate.as_ref()).is_some_and(|c| parvane_protocol::identity::verify_certificate(c, Some(&user)).is_ok());
        f.check("bundle-cert-verifies", devs.len() == 1 && cert_ok, devs.len());
        f.check("bundle-otk", devs.first().is_some_and(|d| d.one_time_key.is_some()), "");
        // Журнал анонимно.
        let ls = ok_of::<ipb::DeviceLogSyncAnonResponse>(an.call("identity.device.log_sync_anon", ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: user.clone() }), after_version: 0 }.encode_to_vec()), "log-sync-anon", &mut f);
        f.check("log-sync-anon-2", ls.map(|l| l.entries.len()).unwrap_or(0) == 2, "");

        // Ключ доставки и приватность.
        f.check("delivery-key-set", c.call("identity.delivery_key.set", ipb::DeliveryKeySetRequest { delivery_key: vec![7; 32] }.encode_to_vec()).is_ok(), "");
        f.check("delivery-key-bad-len", c.call("identity.delivery_key.set", ipb::DeliveryKeySetRequest { delivery_key: vec![7; 31] }.encode_to_vec()) == Err(ErrorCode::Invalid), "");
        f.check("privacy-set", c.call("identity.privacy.set", ipb::PrivacySetRequest { settings: Some(ipb::PrivacySettings { messages_from_strangers: false, ..Default::default() }) }.encode_to_vec()).is_ok(), "");

        // Жетоны: список ключей анонимно, выдача по сессии, проверка.
        let kl = ok_of::<ipb::TokensKeyListResponse>(an.call("identity.tokens.key_list", vec![]), "token-key-list", &mut f).and_then(|r| r.list);
        let desc = ok_of::<ipb::ServerDescribeResponse>(c.call("server.describe", vec![]), "describe", &mut f).and_then(|d| d.descriptor);
        let server_key = desc.and_then(|d| parvane_protocol::pb::parvane::core::v2::ServerDescriptor::decode(d.descriptor.as_slice()).ok()).map(|d| d.server_key).unwrap_or_default();
        if let Some(kl) = kl {
            match tokens::verify_key_list(&kl, &server_key) {
                Ok(trusted) => {
                    let today = trusted.keys.iter().max_by_key(|k| k.valid_from_ms).map(|k| k.key_id.clone()).unwrap_or_default();
                    let (treq, blinded) = tokens::TokenRequest::new(&trusted, &today, 3).unwrap();
                    let got = ok_of::<ipb::TokensIssueBlindedResponse>(c.call("identity.tokens.issue_blinded", ipb::TokensIssueBlindedRequest { blinded }.encode_to_vec()), "tokens-issue", &mut f);
                    let toks = got.map(|g| treq.finalize(&g.blind_signatures)).transpose().ok().flatten().unwrap_or_default();
                    f.check("tokens-finalized", toks.len() == 3, toks.len());
                    let (_, over) = tokens::TokenRequest::new(&trusted, &today, 48).unwrap();
                    f.check("tokens-daily-limit", c.call("identity.tokens.issue_blinded", ipb::TokensIssueBlindedRequest { blinded: over }.encode_to_vec()) == Err(ErrorCode::Limit), "");
                }
                Err(e) => f.check("token-key-list-signed", false, e),
            }
        }

        // Профиль и каталог (правила v1).
        f.check("set-name", c.call("identity.profile.set_name", ipb::ProfileSetNameRequest { display_name: "Тест".into(), bio: Some("о себе".into()), ..Default::default() }.encode_to_vec()).is_ok(), "");
        let pr = ok_of::<ipb::ProfileResolveResponse>(c.call("identity.profile.resolve", ipb::ProfileResolveRequest { users: vec![UserRef { address: user.clone() }] }.encode_to_vec()), "resolve", &mut f);
        let p = pr.and_then(|r| r.profiles.into_iter().next()).unwrap_or_default();
        f.check("resolve-name-root", p.display_name == "Тест" && p.root_key == root.root_pub().to_vec(), &p);
        // Список устройств, статистика (не оператор).
        let dl = ok_of::<ipb::DeviceListResponse>(c.call("identity.device.list", vec![]), "device-list", &mut f);
        f.check("device-list", dl.is_some_and(|d| d.devices.iter().any(|x| x.device_id == "d1" && !x.legacy)), "");
        f.check("stats-not-operator", c.call("server.stats.versions", vec![]) == Err(ErrorCode::Forbidden), "");
        f
    })
    .await
    .unwrap();
    assert!(res.0.is_empty(), "провалены сценарии identity v2: {:?} (логи: {})", res.0, stack.dir.display());
}

// ── messenger v2: sealed-доставка, группы, мост v1 (T043–T046, T072, T073) ──

mod msgv2 {
    use super::*;
    use parvane_protocol::group::{self, SignerInfo};
    use parvane_protocol::identity::{DeviceLog, RootIdentity};
    use parvane_protocol::msg as emsg;
    use parvane_protocol::olm::OlmAccount;
    use parvane_protocol::pb::parvane::core::v2::{
        sealed_envelope::Access, DeviceCertificate, DeviceRef, GroupEnvelopeInner, Ref, SignedDeviceCertificate, UserRef,
    };
    use parvane_protocol::pb::parvane::group::v2::{group_change::Change, AddMember, Create, GroupKind, NewEpoch, Permissions};
    use parvane_protocol::pb::parvane::identity::v2 as ipb;
    use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, Text};
    use parvane_protocol::seal;

    pub struct Dev {
        pub c: V2,
        pub user: String,
        pub dev: DeviceRef,
        pub acc: OlmAccount,
        pub cert: SignedDeviceCertificate,
        pub hpke_sk: [u8; 32],
        pub delivery_key: Vec<u8>,
        pub root: RootIdentity,
    }

    fn call<M: Message + Default>(c: &mut V2, m: &str, b: Vec<u8>) -> Result<M, ErrorCode> {
        c.call(m, b).and_then(|x| M::decode(x.as_slice()).map_err(|_| ErrorCode::Invalid))
    }

    /// Зарегистрировать пользователя через v2 и поднять устройство с сертификатом.
    pub fn device(addr: &str, user: &str) -> Dev {
        let (mut c, _) = V2::connect(addr, Channel::Identified);
        let _ = c.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
        let tok: ipb::SessionIssueResponse = call(&mut c, "identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec()).expect("issue");
        c.send(frame::Kind::Auth(Auth { token: tok.token }));
        assert!(matches!(c.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))));
        let root = RootIdentity::generate(user).unwrap();
        let g = root.genesis_entry().unwrap();
        c.call("identity.device.log_append", ipb::DeviceLogAppendRequest { entry: Some(g.clone()) }.encode_to_vec()).expect("genesis");
        let mut log = DeviceLog::new(user).unwrap();
        log.apply(&g).unwrap();
        let mut acc = OlmAccount::new();
        let (hsk, hpk) = seal::generate_keypair();
        let mut cert = DeviceCertificate {
            user: Some(UserRef { address: user.into() }),
            device_id: "d1".into(),
            olm_curve25519: acc.curve25519().to_vec(),
            olm_ed25519: acc.ed25519().to_vec(),
            hpke_x25519: hpk.to_vec(),
            proto_major: 2,
            serial: 1,
            ..Default::default()
        };
        // C1-01: доказательство владения ключом устройства.
        parvane_protocol::identity::prove_possession(&acc, &mut cert, &root.root_pub()).unwrap();
        let add = root.add_device_entry(2, log.head_hash, &cert).unwrap();
        let otks: Vec<ipb::OneTimeKey> = acc
            .generate_one_time_keys(5)
            .into_iter()
            .map(|(id, k)| ipb::OneTimeKey { signature: parvane_protocol::sign::sign_ctx(&acc, parvane_protocol::sign::ctx::OTK, &[&id, &k]), key_id: id, curve25519: k.to_vec() })
            .collect();
        let fb = acc.generate_fallback_key().unwrap();
        let fb_id = b"fallback".to_vec();
        let fallback = ipb::OneTimeKey { signature: parvane_protocol::sign::sign_ctx(&acc, parvane_protocol::sign::ctx::OTK, &[&fb_id, &fb]), key_id: fb_id, curve25519: fb.to_vec() };
        c.call("identity.device.publish_certificate", ipb::DevicePublishCertificateRequest { log_entry: Some(add), one_time_keys: otks, fallback_key: Some(fallback) }.encode_to_vec()).expect("cert");
        let delivery_key = vec![user.len() as u8; 32];
        c.call("identity.delivery_key.set", ipb::DeliveryKeySetRequest { delivery_key: delivery_key.clone() }.encode_to_vec()).expect("dk");
        let signed = root.certify(&cert).unwrap();
        Dev { c, user: user.into(), dev: DeviceRef { address: user.into(), device_id: "d1".into() }, acc, cert: signed, hpke_sk: *hsk, delivery_key, root }
    }

    pub fn text(t: &str) -> Content {
        Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
    }

    /// Собрать sealed-конверт от `from` устройству `to` (бандл — анонимно).
    pub fn seal_to(addr: &str, from: &Dev, to_user: &str, access: Access, c: &Content) -> mpb::DeliverSealedRequest {
        let (mut an, _) = V2::connect(addr, Channel::AnonymousDelivery);
        let b: ipb::DeviceFetchBundleAnonResponse = call(&mut an, "identity.device.fetch_bundle_anon", ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: to_user.into() }) }.encode_to_vec()).expect("bundle");
        let mut envelopes = vec![];
        for d in b.devices {
            let v = parvane_protocol::identity::verify_certificate(d.certificate.as_ref().unwrap(), Some(to_user)).unwrap();
            let otk = d.one_time_key.or(d.fallback_key).unwrap();
            let mut s = from.acc.outbound(&v.cert.olm_curve25519, &otk.curve25519).unwrap();
            let dr = DeviceRef { address: to_user.into(), device_id: v.cert.device_id.clone() };
            let op = emsg::sign_direct(&from.acc, c, to_user, vec![dr.clone()], 1).unwrap();
            let inner = emsg::seal_inner(&from.cert, &mut s, &op).unwrap();
            envelopes.push(seal::seal(&dr, &v.hpke_x25519().unwrap(), access.clone(), inner, false).unwrap());
        }
        mpb::DeliverSealedRequest { envelopes }
    }

    /// Записи журнала устройства после курсора.
    pub fn sync(d: &mut Dev, after: u64) -> Vec<mpb::InboxRecord> {
        call::<mpb::InboxSyncResponse>(&mut d.c, "msg.inbox.sync", mpb::InboxSyncRequest { after_seq: after, max_bytes: 0 }.encode_to_vec()).map(|r| r.records).unwrap_or_default()
    }

    /// Открыть sealed-запись получателем.
    pub fn open(d: &mut Dev, rec: &mpb::InboxRecord) -> Option<emsg::Opened> {
        let Some(inbox_record::Item::Sealed(env)) = &rec.item else { return None };
        let inner = seal::open(env, &d.dev, &d.hpke_sk).ok()?;
        let me = d.dev.clone();
        let acc = &mut d.acc;
        let mut dec = |id: &[u8; 32], _t: u32, b: &[u8]| acc.inbound(id, b).map(|(_, pt)| pt);
        emsg::open_direct(&inner, &me, &|_| true, &mut dec, &mut parvane_protocol::sign::ReplayGuard::new(100)).ok()
    }

    pub fn group_flow(addr: &str, a: &mut Dev, b: &mut Dev, f: &mut Failures) {
        let owners: std::collections::HashMap<[u8; 32], SignerInfo> = [
            (a.acc.ed25519(), SignerInfo { user: a.user.clone(), root_key: a.root.root_pub() }),
            (b.acc.ed25519(), SignerInfo { user: b.user.clone(), root_key: b.root.root_pub() }),
        ]
        .into();
        let resolve = |k: &[u8; 32]| owners.get(k).cloned();
        let perms = Permissions { send_messages: true, send_media: true, send_stickers_gifs: true, send_polls: true, embed_links: true, invite_users: false, pin_messages: false, change_info: false };
        let g = group::build_entry(&a.acc, None, "local", Change::Create(Create { kind: GroupKind::Group as i32, name: "G".into(), default_permissions: Some(perms), ..Default::default() }), 1).unwrap();
        let r = a.c.call("group.state.append", parvane_protocol::pb::parvane::group::v2::StateAppendRequest { entry: Some(g.clone()) }.encode_to_vec());
        f.check("group-genesis", r.is_ok(), &r);
        let s1 = group::apply(None, &g, &resolve).unwrap();
        let add = group::build_entry(&a.acc, Some(&s1), "local", Change::AddMember(AddMember { member: Some(UserRef { address: b.user.clone() }) }), 2).unwrap();
        // Боб не вправе добавлять — сервер проверяет права движком.
        let forged = group::build_entry(&b.acc, Some(&s1), "local", Change::AddMember(AddMember { member: Some(UserRef { address: "eve@local".into() }) }), 2).unwrap();
        f.check("group-forged-add-rejected", b.c.call("group.state.append", parvane_protocol::pb::parvane::group::v2::StateAppendRequest { entry: Some(forged) }.encode_to_vec()).is_err(), "");
        f.check("group-add", a.c.call("group.state.append", parvane_protocol::pb::parvane::group::v2::StateAppendRequest { entry: Some(add.clone()) }.encode_to_vec()).is_ok(), "");
        let s2 = group::apply(Some(&s1), &add, &resolve).unwrap();
        let send = parvane_protocol::sign::generate_signing_key();
        let ep = group::build_entry(&a.acc, Some(&s2), "local", Change::NewEpoch(NewEpoch { epoch: 1, send_public_key: send.verifying_key().to_bytes().to_vec() }), 100_000).unwrap();
        let r = a.c.call("group.epoch.publish_send_key", parvane_protocol::pb::parvane::group::v2::EpochPublishSendKeyRequest { entry: Some(ep.clone()) }.encode_to_vec());
        f.check("group-epoch", r.is_ok(), &r);
        let s3 = group::apply(Some(&s2), &ep, &resolve).unwrap();
        // Групповой конверт через анонимный канал.
        let env = group::seal_envelope(&send, &[9; 32], &s3.group, 1, &GroupEnvelopeInner { megolm_session_id: b"s".to_vec(), megolm_message: b"m".to_vec(), padding: vec![] }).unwrap();
        let (mut an, _) = V2::connect(addr, Channel::AnonymousDelivery);
        let r = an.call("msg.deliver_group", mpb::DeliverGroupRequest { envelope: Some(env.clone()) }.encode_to_vec());
        f.check("group-deliver", r.is_ok(), &r);
        f.check("group-envelope-replay", an.call("msg.deliver_group", mpb::DeliverGroupRequest { envelope: Some(env) }.encode_to_vec()) == Err(ErrorCode::Duplicate), "");
        let wrong = parvane_protocol::sign::generate_signing_key();
        let bad = group::seal_envelope(&wrong, &[9; 32], &s3.group, 1, &GroupEnvelopeInner::default()).unwrap();
        f.check("group-wrong-epoch-key", an.call("msg.deliver_group", mpb::DeliverGroupRequest { envelope: Some(bad) }.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // Получили оба участника (включая автора, D-07).
        let got_b = sync(b, 0).iter().any(|r| matches!(&r.item, Some(inbox_record::Item::Group(e)) if e.group.as_ref() == Some(&s3.group)));
        let got_a = sync(a, 0).iter().any(|r| matches!(&r.item, Some(inbox_record::Item::Group(e)) if e.group.as_ref() == Some(&s3.group)));
        f.check("group-fanout-incl-author", got_a && got_b, (got_a, got_b));
        // Журнал группы видят участники.
        let gs = call::<parvane_protocol::pb::parvane::group::v2::StateSyncResponse>(&mut b.c, "group.state.sync", parvane_protocol::pb::parvane::group::v2::StateSyncRequest { group: Some(s3.group.clone()), after_version: 0, ..Default::default() }.encode_to_vec());
        f.check("group-sync-3", gs.map(|g| g.entries.len()).unwrap_or(0) == 3, "");
        let _ = Ref::default();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_messenger_live() {
    use msgv2::*;
    use parvane_protocol::pb::parvane::core::v2::sealed_envelope::Access;
    use parvane_protocol::pb::parvane::identity::v2 as ipb;
    use parvane_protocol::pb::parvane::msg::v2::{self as mpb, inbox_record};

    let Some((stack, nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let p = free_port();
    let (ua, ub, uc) = (format!("ma{p}@local"), format!("mb{p}@local"), format!("mc{p}@local"));
    // carol — v1-клиент (прямой NATS).
    let _ = nreq(&nc, "identity.user.register", json!({"user": uc, "password": PASSWORD, "invite": ""})).await;
    let carol_tok = nreq(&nc, "identity.token.issue", json!({"user": uc, "password": PASSWORD})).await["token"].as_str().unwrap_or("").to_string();

    let (f, ub2, bob_dev) = tokio::task::spawn_blocking(move || {
        let mut f = Failures(vec![]);
        let mut a = device(&addr, &ua);
        let mut b = device(&addr, &ub);
        // 1) Sealed alice → bob с ключом доступа bob.
        let req = seal_to(&addr, &a, &ub, Access::DeliveryKey(b.delivery_key.clone()), &text("привет, Боб"));
        let (mut an, _) = V2::connect(&addr, Channel::AnonymousDelivery);
        let r = an.call("msg.deliver_sealed", req.encode_to_vec()).map(|x| mpb::DeliverSealedResponse::decode(x.as_slice()).unwrap_or_default().accepted);
        f.check("sealed-accepted", r == Ok(1), &r);
        let recs = sync(&mut b, 0);
        let opened = recs.iter().find_map(|r| open(&mut b, r));
        let ok = opened.as_ref().is_some_and(|o| o.sender.user() == ua && matches!(&o.content.kind, Some(parvane_protocol::pb::parvane::msg::v2::content::Kind::Text(t)) if t.text == "привет, Боб"));
        f.check("sealed-opened-by-recipient", ok, recs.len());
        // Сервер не хранит отправителя: запись не содержит адреса alice.
        let raw = recs.iter().map(|r| r.encode_to_vec()).collect::<Vec<_>>().concat();
        f.check("no-sender-in-record", !raw.windows(ua.len()).any(|w| w == ua.as_bytes()), "");
        // 2) Неверный ключ доступа → FORBIDDEN.
        let bad = seal_to(&addr, &a, &ub, Access::DeliveryKey(vec![0; 32]), &text("x"));
        f.check("wrong-delivery-key", an.call("msg.deliver_sealed", bad.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        // 3) Смешанные получатели в одном запросе → INVALID (D-05).
        let mut mixed = seal_to(&addr, &a, &ub, Access::DeliveryKey(b.delivery_key.clone()), &text("x"));
        let mut other = mixed.envelopes[0].clone();
        other.recipient = Some(parvane_protocol::pb::parvane::core::v2::DeviceRef { address: ua.clone(), device_id: "d1".into() });
        mixed.envelopes.push(other);
        f.check("mixed-recipients", an.call("msg.deliver_sealed", mixed.encode_to_vec()) == Err(ErrorCode::Invalid), "");
        // 4) Жетон незнакомца: bob запретил незнакомых → FORBIDDEN; разрешил → OK; повтор → DUPLICATE.
        let kl = ipb::TokensKeyListResponse::decode(an.call("identity.tokens.key_list", vec![]).unwrap().as_slice()).unwrap().list.unwrap();
        let desc = ipb::ServerDescribeResponse::decode(a.c.call("server.describe", vec![]).unwrap().as_slice()).unwrap().descriptor.unwrap();
        let sk = parvane_protocol::pb::parvane::core::v2::ServerDescriptor::decode(desc.descriptor.as_slice()).unwrap().server_key;
        let trusted = parvane_protocol::tokens::verify_key_list(&kl, &sk).unwrap();
        let kid = trusted.keys.iter().max_by_key(|k| k.valid_from_ms).unwrap().key_id.clone();
        let (treq, bl) = parvane_protocol::tokens::TokenRequest::new(&trusted, &kid, 2).unwrap();
        let sigs = ipb::TokensIssueBlindedResponse::decode(a.c.call("identity.tokens.issue_blinded", ipb::TokensIssueBlindedRequest { blinded: bl }.encode_to_vec()).unwrap().as_slice()).unwrap().blind_signatures;
        let toks = treq.finalize(&sigs).unwrap();
        b.c.call("identity.privacy.set", ipb::PrivacySetRequest { settings: Some(ipb::PrivacySettings { messages_from_strangers: false, ..Default::default() }) }.encode_to_vec()).unwrap();
        let t0 = seal_to(&addr, &a, &ub, Access::AnonToken(toks[0].clone()), &text("незнакомец"));
        f.check("strangers-disabled", an.call("msg.deliver_sealed", t0.encode_to_vec()) == Err(ErrorCode::Forbidden), "");
        b.c.call("identity.privacy.set", ipb::PrivacySetRequest { settings: Some(ipb::PrivacySettings { messages_from_strangers: true, ..Default::default() }) }.encode_to_vec()).unwrap();
        let t1 = seal_to(&addr, &a, &ub, Access::AnonToken(toks[1].clone()), &text("незнакомец"));
        f.check("token-accepted", an.call("msg.deliver_sealed", t1.encode_to_vec()).is_ok(), "");
        let t1b = seal_to(&addr, &a, &ub, Access::AnonToken(toks[1].clone()), &text("повтор"));
        f.check("token-double-spend", an.call("msg.deliver_sealed", t1b.encode_to_vec()) == Err(ErrorCode::Duplicate), "");
        // 5) ack.
        let last = sync(&mut b, 0).last().map(|r| r.seq).unwrap_or(0);
        f.check("ack", b.c.call("msg.inbox.ack", mpb::InboxAckRequest { up_to_seq: last }.encode_to_vec()).is_ok(), "");
        // 6) Группы.
        group_flow(&addr, &mut a, &mut b, &mut f);
        let bob_dev = b;
        (f, ub, bob_dev)
    })
    .await
    .unwrap();
    let mut f = f;
    // 7) Мост v1 → v2: carol (v1) пишет bob'у; запись LegacyV1 в журнале v2-устройства bob.
    let mid = uuid::Uuid::now_v7().to_string();
    let ev = json!({"id": mid, "from": uc, "ts": 1, "token": carol_tok, "payload": {"to": ub2, "content": {"kind": "text", "text": "из v1"}}});
    nc.publish("msg.chat.send", ev.to_string().into()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (f2, _) = tokio::task::spawn_blocking(move || {
        let mut b = bob_dev;
        let mut f = Failures(vec![]);
        let recs = sync(&mut b, 0);
        let legacy = recs.iter().any(|r| matches!(&r.item, Some(inbox_record::Item::LegacyV1(l)) if String::from_utf8_lossy(&l.json).contains(&mid)));
        f.check("v1-to-v2-bridge", legacy, recs.len());
        (f, b)
    })
    .await
    .unwrap();
    f.0.extend(f2.0);
    assert!(f.0.is_empty(), "провалены сценарии messenger v2: {:?} (логи: {})", f.0, stack.dir.display());
}
