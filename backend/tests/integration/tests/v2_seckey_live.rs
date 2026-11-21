//! Ключ безопасности — второй фактор входа (SECKEY-1, spec 041) против живого стека с программным аутентификатором
//! (P-256 и Ed25519): заводит и снимает ключи только устройство журнала со свежим паролем; новое устройство входит
//! паролем и ответом ключа на вызов сервера; чужой ключ, повтор ответа и просроченный вызов — отказ; потерянный ключ
//! заменяет ключ восстановления; привязанное устройство (доказательство ID-01) ключ не спрашивает; выключатель
//! «Требовать ключ при входе» и снятие последнего ключа возвращают вход по паролю. Без `nats-server` — SKIP.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use parvane_protocol::client::Client;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use prost::Message;
use sha2::{Digest, Sha256};

mod v2common;
use v2common::{Conn, Device};

const PASSWORD: &str = "e2e-Test-pass-2026";
const RP: &str = "parvane.test";
const ORIGIN: &str = "https://parvane.test";

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
    let dir = std::env::temp_dir().join(format!("parvane-v2seckey-{}-{}", std::process::id(), free_port()));
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
            ("PARVANE_REQUIRE_DEVICE_PROOF", "1"),
            ("PARVANE_WEBAUTHN_RP_ID", RP),
            ("PARVANE_LOGIN_RATE", "100000"),
            ("PARVANE_LOGIN_RATE_IP", "100000"),
        ],
        &dir.join("identity.log"),
    ));
    let m_db = dir.join("messenger.db").to_string_lossy().to_string();
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    children.push(spawn(
        "gateway",
        &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp), ("PARVANE_GATEWAY_BIND", &gateway_ws)],
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
    for (subject, name) in [("v2.server.describe", "identity"), ("v2.msg.inbox.sync", "messenger")] {
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
    Some(stack)
}

// ── программный аутентификатор ─────────────────────────────────────────────

enum Key {
    P256(p256::ecdsa::SigningKey),
    Ed(ed25519_dalek::SigningKey),
}

struct Authenticator {
    id: Vec<u8>,
    key: Key,
    count: u32,
}

fn b64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn client_data(kind: &str, challenge: &[u8]) -> Vec<u8> {
    serde_json::json!({"type": kind, "challenge": b64url(challenge), "origin": ORIGIN, "crossOrigin": false}).to_string().into_bytes()
}

fn cbor_int(v: i64, out: &mut Vec<u8>) {
    let (major, n) = if v >= 0 { (0u8, v as u64) } else { (1u8, (-1 - v) as u64) };
    out.push((major << 5) | n as u8);
}

fn cbor_bytes(b: &[u8], out: &mut Vec<u8>) {
    out.push((2 << 5) | 24);
    out.push(b.len() as u8);
    out.extend_from_slice(b);
}

impl Authenticator {
    fn p256(seed: u8) -> Self {
        Authenticator { id: vec![seed; 20], key: Key::P256(p256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap()), count: 0 }
    }
    fn ed25519(seed: u8) -> Self {
        Authenticator { id: vec![seed; 24], key: Key::Ed(ed25519_dalek::SigningKey::from_bytes(&[seed; 32])), count: 0 }
    }
    fn head(&self, flags: u8) -> Vec<u8> {
        let mut a = Sha256::digest(RP.as_bytes()).to_vec();
        a.push(flags);
        a.extend_from_slice(&self.count.to_be_bytes());
        a
    }
    /// Ответ регистрации: (clientDataJSON, authenticatorData).
    fn register(&self, challenge: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut a = self.head(0x41);
        a.extend_from_slice(&[0u8; 16]);
        a.extend_from_slice(&(self.id.len() as u16).to_be_bytes());
        a.extend_from_slice(&self.id);
        match &self.key {
            Key::P256(sk) => {
                let p = sk.verifying_key().to_encoded_point(false);
                a.push(0xa5);
                for (k, v) in [(1, 2), (3, -7), (-1, 1)] {
                    cbor_int(k, &mut a);
                    cbor_int(v, &mut a);
                }
                cbor_int(-2, &mut a);
                cbor_bytes(p.x().unwrap().as_slice(), &mut a);
                cbor_int(-3, &mut a);
                cbor_bytes(p.y().unwrap().as_slice(), &mut a);
            }
            Key::Ed(sk) => {
                a.push(0xa4);
                for (k, v) in [(1, 1), (3, -8), (-1, 6)] {
                    cbor_int(k, &mut a);
                    cbor_int(v, &mut a);
                }
                cbor_int(-2, &mut a);
                cbor_bytes(sk.verifying_key().as_bytes(), &mut a);
            }
        }
        (client_data("webauthn.create", challenge), a)
    }
    fn assert(&mut self, challenge: &[u8]) -> ipb::SecKeyAssertion {
        self.count += 1;
        let cd = client_data("webauthn.get", challenge);
        let a = self.head(0x01);
        let mut msg = a.clone();
        msg.extend_from_slice(&Sha256::digest(&cd));
        let signature = match &self.key {
            Key::P256(sk) => {
                use p256::ecdsa::signature::Signer as _;
                let s: p256::ecdsa::Signature = sk.sign(&msg);
                s.to_der().as_bytes().to_vec()
            }
            Key::Ed(sk) => {
                use ed25519_dalek::Signer as _;
                sk.sign(&msg).to_bytes().to_vec()
            }
        };
        ipb::SecKeyAssertion { credential_id: self.id.clone(), client_data_json: cd, authenticator_data: a, signature }
    }
}

// ── помощники стека ─────────────────────────────────────────────────────────

fn issue(addr: &str, req: ipb::SessionIssueRequest) -> Result<ipb::SessionIssueResponse, ErrorCode> {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.call("identity.session.issue", req.encode_to_vec())
        .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap())
}

fn login(user: &str, device: &str) -> ipb::SessionIssueRequest {
    ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: device.into(), ..Default::default() }
}

fn auth(addr: &str, token: &str) -> Conn {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.send(frame::Kind::Auth(Auth { token: token.into() }));
    assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
    id
}

/// Первое устройство аккаунта с личностью (копии корня на сервере ещё нет) → (устройство, корень, ключ восстановления).
fn create(addr: &str, user: &str) -> (Device, [u8; 32], String) {
    let (mut id, w) = Conn::connect(addr, Channel::Identified);
    let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome") };
    let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).unwrap();
    id.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec())
        .expect("регистрация");
    let tok = issue(addr, login(user, "d1")).unwrap().token;
    id.send(frame::Kind::Auth(Auth { token: tok }));
    assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
    let (anon, _) = Conn::connect(addr, Channel::AnonymousDelivery);
    let client = Client::new(user, "d1", &domain).unwrap();
    let mut d = Device { client, id, anon, server_key, domain };
    let (reqs, root) = d.client.create_identity(5).unwrap();
    d.run(&reqs).expect("личность");
    let key = parvane_protocol::recovery::RecoveryKey::generate();
    (d, root.root.to_bytes(), key.to_display().to_string())
}

fn set_backup(d: &mut Device, user: &str, root: &[u8; 32], key: &str) {
    let k = parvane_protocol::recovery::RecoveryKey::parse(key).unwrap();
    let backup = parvane_protocol::recovery::export_root_backup(root, user, &k).unwrap();
    d.id.call("identity.root.backup_set", ipb::RootBackupSetRequest { backup, ..Default::default() }.encode_to_vec()).expect("копия корня");
}

fn reauth(c: &mut Conn) {
    c.call("identity.session.reauth", ipb::SessionReauthRequest { password: PASSWORD.into() }.encode_to_vec()).expect("reauth");
}

fn list(c: &mut Conn) -> ipb::SecKeyListResponse {
    ipb::SecKeyListResponse::decode(c.call("identity.seckey.list", vec![]).expect("список").as_slice()).unwrap()
}

fn add(c: &mut Conn, a: &Authenticator, name: &str) -> Result<ipb::SecKeyAddResponse, ErrorCode> {
    let ch = ipb::SecKeyChallengeResponse::decode(c.call("identity.seckey.challenge", vec![])?.as_slice()).unwrap();
    assert_eq!(ch.rp_id, RP);
    let (client_data_json, authenticator_data) = a.register(&ch.challenge);
    c.call("identity.seckey.add", ipb::SecKeyAddRequest { name: name.into(), client_data_json, authenticator_data }.encode_to_vec())
        .map(|b| ipb::SecKeyAddResponse::decode(b.as_slice()).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn security_key_is_second_factor_for_new_devices() {
    let Some(stack) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let user = "ana@local";
    let (mut d1, root, rk) = create(&addr, user);
    let mut usb = Authenticator::p256(3);

    // Без копии корня ключ не заводится (потеря ключа заперла бы вход новых устройств)
    reauth(&mut d1.id);
    assert_eq!(add(&mut d1.id, &usb, "USB").unwrap_err(), ErrorCode::NotFound, "ключ без копии корня");
    set_backup(&mut d1, user, &root, &rk);
    let l = list(&mut d1.id);
    assert!(l.keys.is_empty() && !l.required && l.recovery_ready);

    // Добавление — только со свежим паролем на этом соединении
    let ts = now_ms();
    let token = issue(&addr, ipb::SessionIssueRequest { device_proof: d1.client.session_proof(ts), proof_ts_ms: ts, ..login(user, "d1") }).unwrap().token;
    let mut fresh = auth(&addr, &token);
    assert_eq!(add(&mut fresh, &usb, "USB").unwrap_err(), ErrorCode::ReauthRequired);
    let k = add(&mut d1.id, &usb, "USB-ключ 1").expect("ключ добавлен").key.unwrap();
    assert_eq!((k.name.as_str(), k.alg, k.last_used_ms), ("USB-ключ 1", -7, 0));
    assert_eq!(add(&mut d1.id, &usb, "второй раз").unwrap_err(), ErrorCode::Duplicate, "тот же ключ дважды");
    // Ответ на чужой вызов (вызов уже израсходован) — просрочен
    let (cd, ad) = usb.register(&[1u8; 32]);
    assert_eq!(
        d1.id.call("identity.seckey.add", ipb::SecKeyAddRequest { name: "x".into(), client_data_json: cd, authenticator_data: ad }.encode_to_vec()).unwrap_err(),
        ErrorCode::Expired
    );
    let l = list(&mut d1.id);
    assert_eq!((l.keys.len(), l.required), (1, true), "первый ключ включает требование");

    // Новое устройство: пароль верен, но токена нет — вызов ключа
    let step = issue(&addr, login(user, "d2")).unwrap();
    assert!(step.seckey_required && step.token.is_empty() && step.seckey_recovery, "шаг ключа");
    assert_eq!((step.seckey_ids.clone(), step.seckey_rp_id.as_str()), (vec![usb.id.clone()], RP));
    // Чужой ключ — отказ с новым вызовом
    let mut stranger = Authenticator::p256(9);
    let bad = issue(&addr, ipb::SessionIssueRequest { seckey: Some(stranger.assert(&step.seckey_challenge)), ..login(user, "d2") }).unwrap();
    assert!(bad.seckey_required && bad.seckey_rejected && bad.token.is_empty(), "чужой ключ");
    // Ответ на израсходованный вызов — отказ
    let stale = issue(&addr, ipb::SessionIssueRequest { seckey: Some(usb.assert(&step.seckey_challenge)), ..login(user, "d2") }).unwrap();
    assert!(stale.seckey_rejected && stale.token.is_empty(), "старый вызов");
    // Верный ответ на свежий вызов — токен
    let good_assertion = usb.assert(&stale.seckey_challenge);
    let ok = issue(&addr, ipb::SessionIssueRequest { seckey: Some(good_assertion.clone()), ..login(user, "d2") }).unwrap();
    assert!(!ok.token.is_empty() && !ok.seckey_required, "вход с ключом");
    let mut d2 = auth(&addr, &ok.token);
    assert!(list(&mut d2).keys[0].last_used_ms > 0, "отметка использования");
    // Сессия одним паролем (вне журнала) ключи не трогает
    assert_eq!(d2.call("identity.seckey.challenge", vec![]).unwrap_err(), ErrorCode::Forbidden);
    // Повтор того же ответа на новый вызов: подпись не над ним, счётчик не вырос
    let again = issue(&addr, login(user, "d3")).unwrap();
    let replay = issue(&addr, ipb::SessionIssueRequest { seckey: Some(good_assertion), ..login(user, "d3") }).unwrap();
    assert!(again.seckey_required && replay.seckey_rejected, "повтор ответа");

    // Ключ потерян: неверный ключ восстановления — шаг снова, верный — вход
    let wrong = issue(&addr, ipb::SessionIssueRequest { recovery_key: "AAAA-BBBB-CCCC".into(), ..login(user, "d3") }).unwrap();
    assert!(wrong.seckey_required && wrong.recovery_key_wrong && wrong.token.is_empty());
    let rec = issue(&addr, ipb::SessionIssueRequest { recovery_key: rk.clone(), ..login(user, "d3") }).unwrap();
    assert!(!rec.token.is_empty(), "вход ключом восстановления");

    // Привязанное устройство с доказательством ID-01 ключ не спрашивает
    let ts = now_ms();
    let own = issue(&addr, ipb::SessionIssueRequest { device_proof: d1.client.session_proof(ts), proof_ts_ms: ts, ..login(user, "d1") }).unwrap();
    assert!(!own.token.is_empty() && !own.seckey_required, "устройство журнала");

    // Второй ключ (Ed25519); выключатель снимает требование
    reauth(&mut d1.id);
    let mut nfc = Authenticator::ed25519(4);
    assert_eq!(add(&mut d1.id, &nfc, "NFC").unwrap().key.unwrap().alg, -8);
    let step = issue(&addr, login(user, "d4")).unwrap();
    assert_eq!(step.seckey_ids.len(), 2);
    let ok = issue(&addr, ipb::SessionIssueRequest { seckey: Some(nfc.assert(&step.seckey_challenge)), ..login(user, "d4") }).unwrap();
    assert!(!ok.token.is_empty(), "вход вторым ключом");
    d1.id.call("identity.seckey.set_required", ipb::SecKeySetRequiredRequest { required: false }.encode_to_vec()).expect("выключить");
    assert!(!issue(&addr, login(user, "d5")).unwrap().token.is_empty(), "требование выключено");
    d1.id.call("identity.seckey.set_required", ipb::SecKeySetRequiredRequest { required: true }.encode_to_vec()).expect("включить");
    assert!(issue(&addr, login(user, "d5")).unwrap().seckey_required);

    // Снятие обоих ключей — вход паролем как раньше
    for id in [usb.id.clone(), nfc.id.clone()] {
        d1.id.call("identity.seckey.remove", ipb::SecKeyRemoveRequest { credential_id: id }.encode_to_vec()).expect("снять");
    }
    assert_eq!(
        d1.id.call("identity.seckey.remove", ipb::SecKeyRemoveRequest { credential_id: vec![1] }.encode_to_vec()).unwrap_err(),
        ErrorCode::NotFound
    );
    let l = list(&mut d1.id);
    assert!(l.keys.is_empty() && !l.required);
    assert!(!issue(&addr, login(user, "d6")).unwrap().token.is_empty(), "без ключей — пароль");
    // Неверный пароль на аккаунте с ключом — прежний шаг «неверный пароль», вызова ключа нет
    reauth(&mut d1.id);
    add(&mut d1.id, &usb, "USB").unwrap();
    let wp = issue(&addr, ipb::SessionIssueRequest { password: "nope-Wrong-1".into(), ..login(user, "d7") }).unwrap();
    assert!(wp.password_wrong && !wp.seckey_required && wp.seckey_challenge.is_empty(), "без пароля вызов не выдаётся");
    drop(stack);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}
