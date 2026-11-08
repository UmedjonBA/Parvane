//! Привязка нового устройства при НЕСКОЛЬКИХ старых (LINK-1 п. 13, 31 окт 2026) против живого стека: запрос виден
//! обоим старым устройствам, challenge фиксирует первое, второе открывает обёртку ключа challenge (ключ из SSK),
//! считает тот же код и выдаёт грант; после гранта запрос пропадает у обоих; грант под чужой ключ отвергнут.
//! Без `nats-server` тест печатает SKIP.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use parvane_protocol::client::{Client, Need};
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use prost::Message;
use sha2::{Digest, Sha256};

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
    start_with(&[]).await
}

const TG_SECRET: &str = "parvane-e2e-telegram-secret";

async fn start_with(identity_env: &[(&str, &str)]) -> Option<(Stack, async_nats::Client)> {
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
    let dir = std::env::temp_dir().join(format!("parvane-v2link-{}-{}", std::process::id(), free_port()));
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
    let mut id_env = vec![("PARVANE_NATS_URL", nats_url.as_str()), ("PARVANE_DB_PATH", &id_db), ("PARVANE_DEV", "1"), ("PARVANE_WELL_KNOWN_FILE", &wk)];
    id_env.extend_from_slice(identity_env);
    children.push(spawn("identity", &id_env, &dir.join("identity.log")));
    let m_db = dir.join("messenger.db").to_string_lossy().to_string();
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db), ("PARVANE_GROUP_ENTRY_TS_WINDOW_MS", "0")], &dir.join("messenger.log")));
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

fn poll(d: &mut Device) -> ipb::LinkPollResponse {
    let b = d.id.call("identity.link.poll", ipb::LinkPollRequest {}.encode_to_vec()).expect("link.poll");
    ipb::LinkPollResponse::decode(b.as_slice()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn link_request_reaches_every_old_device_and_any_grants_live() {
    let Some((stack, _nc)) = start().await else { return };
    let addr = stack.gateway_tcp.clone();
    let user = format!("linker{}@local", free_port());
    let dir = stack.dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        // Два старых устройства одного аккаунта (второе вошло грантом — держит тот же SSK)
        let mut d1 = Device::register(&addr, &user, "d1");
        let mut d2 = login(&addr, &user, "d2");
        let (ssk, entries, dk, gen) = d1.client.link_grant_material().unwrap();
        let reqs = d2.client.join_with_ssk(ssk, entries, dk, gen, 5).unwrap();
        d2.run(&reqs).expect("d2 сертификат");
        let me = user.clone();
        assert!(d1.satisfy(&Need::PeerLog { user: me, after: 0 }));
        // Новое устройство: оффер с обязательством
        let mut d3 = login(&addr, &user, "d3");
        let n_raw = [4u8; 65];
        let n_pub = b64.encode(n_raw);
        let commitment = b64.encode(Sha256::digest(n_raw));
        d3.id.call("identity.link.offer", ipb::LinkOfferRequest { commitment: commitment.clone(), signing_key: "S".into(), ..Default::default() }.encode_to_vec()).expect("offer");
        // Оба старых видят запрос
        for d in [&mut d1, &mut d2] {
            let p = poll(d);
            assert_eq!(p.offers.len(), 1, "старое устройство видит запрос");
            assert_eq!(p.offers[0].device_id, "d3");
        }
        // d1 выставляет challenge с обёрткой; challenge d2 другим ключом — отказ
        let c_raw = [6u8; 65];
        let c_pub = b64.encode(c_raw);
        let secret = [0x5au8; 32];
        let wrap = d1.client.link_challenge_wrap("d3", &commitment, &c_pub, &secret).unwrap();
        d1.id.call("identity.link.challenge", ipb::LinkChallengeRequest { device_id: "d3".into(), eph_pub: c_pub.clone(), wrap: b64.encode(&wrap) }.encode_to_vec()).expect("challenge d1");
        let lost = d2.id.call("identity.link.challenge", ipb::LinkChallengeRequest { device_id: "d3".into(), eph_pub: b64.encode([7u8; 65]), wrap: String::new() }.encode_to_vec());
        assert!(lost.is_err(), "второй challenge не заменяет первый");
        // Новое раскрывает ключ под challenge
        assert_eq!(poll(&mut d3).challenge, c_pub);
        d3.id.call("identity.link.offer", ipb::LinkOfferRequest { eph_pub: n_pub.clone(), commitment: commitment.clone(), ..Default::default() }.encode_to_vec()).expect("reveal");
        // d2 открывает обёртку: тот же ключ challenge → тот же код сверки, что у d1 и d3
        let p = poll(&mut d2);
        let o = &p.offers[0];
        assert_eq!((o.eph_pub.as_str(), o.challenge_pub.as_str()), (n_pub.as_str(), c_pub.as_str()));
        let got = d2.client.link_challenge_unwrap("d3", &o.commitment, &o.challenge_pub, &b64.decode(&o.challenge_wrap).unwrap()).expect("обёртка открывается своим SSK");
        assert_eq!(got.as_slice(), &secret);
        // Подмена сервером (другой оффер) не открывается
        assert!(d2.client.link_challenge_unwrap("d3", &b64.encode([1u8; 32]), &o.challenge_pub, &b64.decode(&o.challenge_wrap).unwrap()).is_err());
        // Грант под ключ проигравшего challenge — отказ, запрос жив
        let bad = d2.id.call("identity.link.grant", ipb::LinkGrantRequest { device_id: "d3".into(), box_payload: "BOX".into(), eph_pub: b64.encode([7u8; 65]) }.encode_to_vec());
        assert!(bad.is_err());
        assert_eq!(poll(&mut d1).offers.len(), 1);
        // d2 (не выставлявшее challenge) выдаёт грант ключом общего challenge
        d2.id.call("identity.link.grant", ipb::LinkGrantRequest { device_id: "d3".into(), box_payload: "BOX".into(), eph_pub: c_pub.clone() }.encode_to_vec()).expect("grant d2");
        assert!(poll(&mut d1).offers.is_empty(), "у d1 запрос исчез");
        assert!(poll(&mut d2).offers.is_empty(), "у d2 запрос исчез");
        let g = poll(&mut d3).grant.expect("грант новому устройству");
        assert_eq!(g.eph_pub, c_pub);
    })
    .await;
    if result.is_err() {
        eprintln!("журналы стека: {}", dir.display());
    }
    drop(stack);
    result.unwrap();
}

fn login_token(addr: &str, user: &str, device_id: &str) -> String {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.call("identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: device_id.into(), ..Default::default() }.encode_to_vec())
        .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap_or_default().token)
        .expect("session.issue")
}

fn authed(addr: &str, token: &str) -> Conn {
    let (mut id, _) = Conn::connect(addr, Channel::Identified);
    id.send(frame::Kind::Auth(Auth { token: token.into() }));
    assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
    id
}

fn tg_request(c: &mut Conn, eph: &[u8]) -> Result<String, parvane_protocol::pb::parvane::core::v2::ErrorCode> {
    c.call("identity.recovery.tg_request", ipb::RecoveryTgRequestRequest { client: "Test".into(), again: false, eph_public: eph.to_vec() }.encode_to_vec())
        .map(|b| ipb::RecoveryTgRequestResponse::decode(b.as_slice()).unwrap().code)
}

fn tg_poll(c: &mut Conn) -> ipb::RecoveryTgPollResponse {
    let b = c.call("identity.recovery.tg_poll", ipb::RecoveryTgPollRequest { done: false }.encode_to_vec()).expect("tg_poll");
    ipb::RecoveryTgPollResponse::decode(b.as_slice()).unwrap()
}

/// S7-1: вошедший паролем «как» новое устройство (тот же `device_id`, другая сессия) не перехватывает его
/// запрос ключа через Telegram: ни своим ключом, ни запросом без ключа; опрос ему пуст, бот получает один
/// вопрос, и ответ владельца открывается только ключом настоящего устройства. Офферы привязки (откуда
/// берётся `device_id` нового устройства) сессии вне журнала не видны.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telegram_recovery_request_is_bound_to_session_live() {
    let Some((stack, _nc)) = start_with(&[("PARVANE_TELEGRAM_BOT", "parvane_e2e_bot"), ("PARVANE_TELEGRAM_SECRET", TG_SECRET)]).await else { return };
    let addr = stack.gateway_tcp.clone();
    let user = format!("tgrec{}@local", free_port());
    let dir = stack.dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let telegram_id = 700_000 + i64::from(free_port());
        // Регистрация с подтверждением через Telegram (бот — этот тест)
        let (mut pre, w) = Conn::connect(&addr, Channel::Identified);
        let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome") };
        let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).unwrap();
        let reg = pre
            .call("identity.account.register", ipb::AccountRegisterRequest { user: user.clone(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec())
            .map(|b| ipb::AccountRegisterResponse::decode(b.as_slice()).unwrap())
            .expect("регистрация");
        assert!(!reg.telegram_token.is_empty(), "регистрация через Telegram");
        pre.call(
            "identity.account.confirm_telegram",
            ipb::AccountConfirmTelegramRequest { secret: TG_SECRET.into(), token: reg.telegram_token, telegram_id, telegram_name: "Test".into() }.encode_to_vec(),
        )
        .expect("подтверждение Telegram");
        // Старое устройство: личность и копия корня под ключом восстановления
        let tok1 = login_token(&addr, &user, "d1");
        let id1 = authed(&addr, &tok1);
        let (anon, _) = Conn::connect(&addr, Channel::AnonymousDelivery);
        let client = Client::new(&user, "d1", &domain).unwrap();
        let mut d1 = Device { client, id: id1, anon, server_key, domain };
        let (reqs, root) = d1.client.create_identity(5).unwrap();
        d1.run(&reqs).expect("личность");
        let key = parvane_protocol::recovery::RecoveryKey::generate();
        let backup = d1.client.export_root_backup(&root.root.to_bytes(), &key).unwrap();
        d1.id.call("identity.root.backup_set", ipb::RootBackupSetRequest { backup, ..Default::default() }.encode_to_vec()).expect("копия корня");

        // Новое устройство dN: оффер привязки и запрос ключа через Telegram
        let mut real = authed(&addr, &login_token(&addr, &user, "dN"));
        real.call("identity.link.offer", ipb::LinkOfferRequest { commitment: b64.encode([3u8; 32]), signing_key: "S".into(), ..Default::default() }.encode_to_vec()).expect("offer");
        // Сессия вне журнала (знает только пароль) чужих офферов не видит; устройство журнала — видит
        let mut spy = authed(&addr, &login_token(&addr, &user, "dSpy"));
        let p = ipb::LinkPollResponse::decode(spy.call("identity.link.poll", ipb::LinkPollRequest {}.encode_to_vec()).expect("poll").as_slice()).unwrap();
        assert!(p.offers.is_empty(), "сессия вне журнала не узнаёт device_id нового устройства");
        assert_eq!(poll(&mut d1).offers.iter().map(|o| o.device_id.as_str()).collect::<Vec<_>>(), vec!["dN"]);

        let (eph_secret, eph_public) = parvane_protocol::recovery_tg::generate();
        let code = tg_request(&mut real, &eph_public).expect("запрос ключа");
        // Атакующий: вход паролем с тем же device_id, свой эфемерный ключ — отказ; без ключа — отказ
        let mut evil = authed(&addr, &login_token(&addr, &user, "dN"));
        let (_evil_secret, evil_public) = parvane_protocol::recovery_tg::generate();
        assert_eq!(tg_request(&mut evil, &evil_public), Err(parvane_protocol::pb::parvane::core::v2::ErrorCode::Forbidden), "запрос другой сессии не заменяет");
        assert_eq!(tg_request(&mut evil, &[]), Err(parvane_protocol::pb::parvane::core::v2::ErrorCode::Invalid), "запроса без ключа нет");
        let ep = tg_poll(&mut evil);
        assert!(!ep.pending && ep.code.is_empty() && ep.sealed_key.is_empty() && ep.recovery_key.is_empty(), "чужой сессии опрос пуст");
        assert_eq!(tg_poll(&mut real).code, code, "код у настоящего устройства прежний");

        // Бот: один вопрос — от настоящего устройства, с его кодом
        let (mut bot, _) = Conn::connect(&addr, Channel::Identified);
        let pulled = ipb::TelegramPullResponse::decode(
            bot.call("identity.telegram.pull", ipb::TelegramPullRequest { secret: TG_SECRET.into(), ack: vec![], wait_ms: 0 }.encode_to_vec()).expect("pull").as_slice(),
        )
        .unwrap();
        let asks: Vec<_> = pulled.messages.iter().filter(|m| m.kind == "ask" && m.user == user).collect();
        assert_eq!(asks.len(), 1, "у бота один вопрос: {:?}", pulled.messages);
        assert_eq!(asks[0].code, code);
        let reply = ipb::TelegramReplyResponse::decode(
            bot.call(
                "identity.telegram.reply",
                ipb::TelegramReplyRequest { secret: TG_SECRET.into(), telegram_id, text: key.to_display().to_string(), request_id: asks[0].request_id }.encode_to_vec(),
            )
            .expect("reply")
            .as_slice(),
        )
        .unwrap();
        assert_eq!(reply.result, "ok");
        // Ответ — только настоящему устройству и только запечатанным на его ключ
        let ep = tg_poll(&mut evil);
        assert!(ep.sealed_key.is_empty() && ep.recovery_key.is_empty(), "атакующему ответ не достаётся");
        let rp = tg_poll(&mut real);
        assert!(rp.recovery_key.is_empty(), "открытым текстом ключ не отдаётся");
        let opened = parvane_protocol::recovery_tg::open(&eph_secret[..], &user, "dN", &rp.sealed_key).expect("ответ открывается ключом устройства");
        assert_eq!(opened.as_slice(), key.to_display().as_bytes());
    })
    .await;
    if result.is_err() {
        eprintln!("журналы стека: {}", dir.display());
    }
    drop(stack);
    result.unwrap();
}
