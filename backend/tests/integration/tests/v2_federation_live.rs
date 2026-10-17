//! Федерация на двух живых стеках (spec 028): `a.parvane.test` и
//! `b.parvane.test` — у каждого свои nats, identity, messenger, domains, cloud,
//! call, gateway и federation; серверы связаны тестовым транспортом (http к
//! loopback, только с фичей `insecure-test-transport`). Клиенты ходят только к
//! своему gateway, запросы объектам чужого сервера несут `dest_domain`.
//! Без `nats-server` тест печатает SKIP и проходит.

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use parvane_protocol::client::{Chan, Client, ClientError, Event, Need, OutRequest};
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ErrorCode, UserRef};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, content, Content, Text};
use prost::Message;

mod v2common;
use v2common::{Conn, PASSWORD};

const A: &str = "a.parvane.test";
const B: &str = "b.parvane.test";

struct Stack {
    children: Vec<Child>,
    dir: PathBuf,
    gateway_tcp: String,
    domain: String,
    fed_port: u16,
    fed_env: Vec<(&'static str, String)>,
    /// Индекс процесса federation в `children`.
    fed_index: usize,
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

impl Stack {
    fn log(&self, shard: &str) -> String {
        std::fs::read_to_string(self.dir.join(format!("{shard}.log"))).unwrap_or_default()
    }

    fn stop_federation(&mut self) {
        let c = &mut self.children[self.fed_index];
        let _ = c.kill();
        let _ = c.wait();
    }

    fn start_federation(&mut self) {
        let log = self.dir.join("federation-2.log");
        self.children[self.fed_index] = spawn("federation", &self.fed_env, &log);
        wait_log(&log, "Federation шард запущен", Instant::now());
    }

    /// `federation_admin` по базе этого стека.
    fn admin(&self, args: &[&str]) {
        let st = Command::new(target_dir().join("federation_admin"))
            .args(args)
            .env("PARVANE_DB_PATH", self.dir.join("federation.db"))
            .output()
            .unwrap();
        assert!(st.status.success(), "federation_admin {args:?}: {}", String::from_utf8_lossy(&st.stderr));
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

fn spawn(bin: &str, envs: &[(&str, String)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin))
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
        .env("PARVANE_LOG_LEVEL", "info")
        .env("NO_COLOR", "1")
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .unwrap_or_else(|e| panic!("запуск {bin}: {e}"))
}

fn wait_log(path: &Path, needle: &str, start: Instant) {
    loop {
        if std::fs::read_to_string(path).unwrap_or_default().contains(needle) {
            return;
        }
        assert!(start.elapsed() < Duration::from_secs(120), "{} не дождался «{needle}»", path.display());
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn build() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for args in [
        vec!["build", "-p", "identity", "-p", "messenger", "-p", "domains", "-p", "cloud", "-p", "call", "-p", "gateway"],
        vec!["build", "-p", "federation", "--features", "insecure-test-transport"],
    ] {
        assert!(Command::new(env!("CARGO")).args(&args).current_dir(&root).status().unwrap().success());
    }
}

/// Стек домена `domain`; `fed_port` — свой вход федерации, `peer` — (домен, вход федерации) соседа.
fn start(nats_bin: &Path, domain: &str, fed_port: u16, peer: (&str, u16), extra: &[(&'static str, String)]) -> Stack {
    let dir = std::env::temp_dir().join(format!("parvane-v2fed-{domain}-{}-{}", std::process::id(), free_port()));
    std::fs::create_dir_all(&dir).unwrap();
    let nats_port = free_port();
    let nats_url = format!("nats://127.0.0.1:{nats_port}");
    let gateway_tcp = format!("127.0.0.1:{}", free_port());
    let log = std::fs::File::create(dir.join("nats.log")).unwrap();
    let mut children = vec![Command::new(nats_bin)
        .args(["-a", "127.0.0.1", "-p", &nats_port.to_string()])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap()];
    let db = |n: &str| dir.join(n).to_string_lossy().to_string();
    let wk = db("parvane.json");
    let base = vec![
        ("PARVANE_NATS_URL", nats_url.clone()),
        ("PARVANE_DOMAIN", domain.to_string()),
        ("PARVANE_FEDERATION", "on".to_string()),
    ];
    let with = |more: &[(&'static str, String)]| -> Vec<(&'static str, String)> {
        let mut v = base.clone();
        v.extend(more.iter().cloned());
        v.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        v
    };
    let unlimited = [
        ("PARVANE_LOGIN_RATE", "100000".to_string()),
        ("PARVANE_LOGIN_RATE_IP", "100000".to_string()),
        ("PARVANE_REGISTER_RATE", "100000".to_string()),
        ("PARVANE_REGISTER_RATE_IP", "100000".to_string()),
        ("PARVANE_REGISTER_RATE_GLOBAL", "100000".to_string()),
        ("PARVANE_PREKEY_FETCH_RATE", "100000".to_string()),
        ("PARVANE_V2_BUNDLE_RATE", "100000".to_string()),
    ];
    let mut id_env = vec![
        ("PARVANE_DB_PATH", db("identity.db")),
        ("PARVANE_DEV", "1".to_string()),
        ("PARVANE_WELL_KNOWN_FILE", wk.clone()),
        ("PARVANE_S2S_ENDPOINT", format!("http://127.0.0.1:{fed_port}")),
    ];
    id_env.extend(unlimited.iter().cloned());
    children.push(spawn("identity", &with(&id_env), &dir.join("identity.log")));
    children.push(spawn(
        "messenger",
        &with(&[("PARVANE_DB_PATH", db("messenger.db")), ("PARVANE_GROUP_ENTRY_TS_WINDOW_MS", "0".into())]),
        &dir.join("messenger.log"),
    ));
    children.push(spawn("domains", &with(&[("PARVANE_DB_PATH", db("domains.db"))]), &dir.join("domains.log")));
    children.push(spawn("cloud", &with(&[("PARVANE_DB_PATH", db("cloud.db"))]), &dir.join("cloud.log")));
    children.push(spawn("call", &with(&[("PARVANE_CALL_V2_RINGING_MAX", "1000".into())]), &dir.join("call.log")));
    let fed_env = with(&[
        ("PARVANE_DB_PATH", db("federation.db")),
        ("PARVANE_FEDERATION_BIND", format!("127.0.0.1:{fed_port}")),
        ("PARVANE_FEDERATION_ENDPOINTS", format!("{}=http://127.0.0.1:{}", peer.0, peer.1)),
        ("PARVANE_FEDERATION_INSECURE_HTTP", "1".into()),
        ("PARVANE_WELL_KNOWN_FILE", wk),
    ]);
    let fed_index = children.len();
    children.push(spawn("federation", &fed_env, &dir.join("federation.log")));
    children.push(spawn(
        "gateway",
        &with(&[
            ("PARVANE_GATEWAY_TCP_BIND", gateway_tcp.clone()),
            ("PARVANE_GATEWAY_BIND", format!("127.0.0.1:{}", free_port())),
            ("PARVANE_V2_FEATURES", "sealed".into()),
            ("PARVANE_GATEWAY_MAX_CONNS_PER_IP", "10000".into()),
            ("GATEWAY_RATE_REQ_BURST", "100000".into()),
            ("GATEWAY_RATE_REQ_PER_SEC", "100000".into()),
            ("GATEWAY_RATE_MSG_BURST", "100000".into()),
            ("GATEWAY_RATE_MSG_PER_SEC", "100000".into()),
            ("GATEWAY_RATE_ANON_BURST", "100000".into()),
            ("GATEWAY_RATE_ANON_PER_SEC", "100000".into()),
            ("GATEWAY_RATE_ANON_IP_BURST", "100000".into()),
            ("GATEWAY_RATE_ANON_IP_PER_SEC", "100000".into()),
            ("GATEWAY_RATE_BUNDLE_IP_BURST", "100000".into()),
            ("GATEWAY_RATE_BUNDLE_IP_PER_SEC", "100000".into()),
            ("GATEWAY_RATE_PRE_BURST", "100000".into()),
            ("GATEWAY_RATE_PRE_PER_SEC", "100000".into()),
        ]),
        &dir.join("gateway.log"),
    ));
    let stack = Stack { children, dir, gateway_tcp, domain: domain.to_string(), fed_port, fed_env, fed_index };
    let t0 = Instant::now();
    for shard in ["identity", "messenger", "cloud", "call"] {
        wait_log(&stack.dir.join(format!("{shard}.log")), "методы v2 подключены", t0);
    }
    wait_log(&stack.dir.join("domains.log"), "Domains шард запущен", t0);
    wait_log(&stack.dir.join("federation.log"), "Federation шард запущен", t0);
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(60), "gateway не слушает");
        std::thread::sleep(Duration::from_millis(100));
    }
    stack
}

fn two_stacks(extra_a: &[(&'static str, String)], extra_b: &[(&'static str, String)]) -> Option<(Stack, Stack)> {
    let nats_bin = find_nats_server().or_else(|| {
        eprintln!("SKIP: nats-server не найден");
        None
    })?;
    build();
    let (fa, fb) = (free_port(), free_port());
    let a = start(&nats_bin, A, fa, (B, fb), extra_a);
    let b = start(&nats_bin, B, fb, (A, fa), extra_b);
    Some((a, b))
}

// ── клиент: устройство на своём сервере, запросы чужим — с адресатом ─────────

struct Dev {
    client: Client,
    id: Conn,
    addr: String,
    server_key: [u8; 32],
}

fn domain_of(user: &str) -> String {
    parvane_protocol::address::address_domain(user).unwrap().to_string()
}

impl Dev {
    fn register(addr: &str, user: &str) -> Dev {
        let (mut id, w) = Conn::connect(addr, Channel::Identified);
        let Some(frame::Kind::Welcome(w)) = w.kind else { panic!("нет Welcome") };
        let (domain, server_key) = parvane_protocol::client::verify_server_descriptor(&w.server_descriptor).unwrap();
        let _ = id.call("identity.account.register", ipb::AccountRegisterRequest { user: user.into(), password: PASSWORD.into(), ..Default::default() }.encode_to_vec());
        let tok = id
            .call("identity.session.issue", ipb::SessionIssueRequest { login: user.into(), password: PASSWORD.into(), device_id: "d1".into(), ..Default::default() }.encode_to_vec())
            .map(|b| ipb::SessionIssueResponse::decode(b.as_slice()).unwrap_or_default().token)
            .expect("session.issue");
        id.send(frame::Kind::Auth(Auth { token: tok }));
        assert!(matches!(id.recv().and_then(|f| f.kind), Some(frame::Kind::AuthOk(_))), "auth");
        let mut d = Dev { client: Client::new(user, "d1", &domain).unwrap(), id, addr: addr.into(), server_key };
        let (reqs, _) = d.client.create_identity(20).unwrap();
        d.run(&reqs).expect("личность");
        d
    }

    fn own_domain(&self) -> String {
        domain_of(&self.client.user)
    }

    /// Адресат запроса: домен объекта, если он не свой.
    fn dest(&self, r: &OutRequest) -> String {
        parvane_protocol::routing::dest_of(r).filter(|d| *d != self.own_domain()).unwrap_or_default()
    }

    fn exec(&mut self, r: &OutRequest) -> Result<Vec<u8>, ErrorCode> {
        let dest = self.dest(r);
        match r.chan {
            Chan::Id => self.id.call_to(r.method, r.body.clone(), &dest),
            Chan::Anon => {
                let (mut c, _) = Conn::connect(&self.addr, Channel::AnonymousDelivery);
                c.call_to(r.method, r.body.clone(), &dest)
            }
        }
    }

    fn run(&mut self, reqs: &[OutRequest]) -> Result<(), (String, ErrorCode)> {
        for r in reqs {
            self.exec(r).map_err(|e| (r.method.to_string(), e))?;
        }
        Ok(())
    }

    fn anon_to(&self, method: &str, body: Vec<u8>, dest: &str) -> Result<Vec<u8>, ErrorCode> {
        let (mut c, _) = Conn::connect(&self.addr, Channel::AnonymousDelivery);
        c.call_to(method, body, dest)
    }

    /// Добрать недостающее; журналы, бандлы и жетоны — у сервера пользователя.
    fn satisfy(&mut self, n: &Need) -> bool {
        match n {
            Need::PeerLog { user, .. } => {
                let after = self.client.log_version(user);
                let body = ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: user.clone() }), after_version: after, ..Default::default() }.encode_to_vec();
                let dest = self.foreign(user);
                let Ok(b) = self.anon_to("identity.device.log_sync_anon", body, &dest) else { return false };
                let entries = ipb::DeviceLogSyncAnonResponse::decode(b.as_slice()).unwrap_or_default().entries;
                self.client.ingest_log(user, entries).is_ok()
            }
            Need::Bundle { user } => {
                let body = ipb::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: user.clone() }) }.encode_to_vec();
                let dest = self.foreign(user);
                let Ok(b) = self.anon_to("identity.device.fetch_bundle_anon", body, &dest) else { return false };
                let devices = ipb::DeviceFetchBundleAnonResponse::decode(b.as_slice()).unwrap_or_default().devices;
                self.client.ingest_bundle(user, devices).is_ok()
            }
            Need::Token { user } => {
                let dest = self.foreign(user);
                if dest.is_empty() {
                    self.own_tokens();
                } else {
                    self.foreign_tokens(&dest);
                }
                true
            }
            _ => false,
        }
    }

    fn foreign(&self, user: &str) -> String {
        let d = domain_of(user);
        if d == self.own_domain() {
            String::new()
        } else {
            d
        }
    }

    fn own_tokens(&mut self) {
        let kl = self.anon_to("identity.tokens.key_list", self.client.token_key_list_request().body, "").expect("key_list");
        let list = ipb::TokensKeyListResponse::decode(kl.as_slice()).unwrap().list.expect("список");
        let req = self.client.token_request(&list, &self.server_key, 10).expect("token_request");
        let resp = self.exec(&req).expect("issue_blinded");
        self.client.token_response(&ipb::TokensIssueBlindedResponse::decode(resp.as_slice()).unwrap()).expect("token_response");
    }

    /// Жетоны сервера `dest`: его ключ — `server.describe` с адресатом (PRE), список ключей — анонимно.
    fn foreign_tokens(&mut self, dest: &str) {
        let (mut pre, _) = Conn::connect(&self.addr, Channel::Identified);
        let d = pre.call_to("server.describe", ipb::ServerDescribeRequest::default().encode_to_vec(), dest).expect("server.describe чужого");
        let d = ipb::ServerDescribeResponse::decode(d.as_slice()).unwrap();
        let (domain, key) = parvane_protocol::client::verify_server_descriptor(&d.descriptor.as_ref().unwrap().encode_to_vec()).unwrap();
        assert_eq!(domain, dest, "описатель — того сервера");
        let kl = self.anon_to("identity.tokens.key_list", ipb::TokensKeyListRequest {}.encode_to_vec(), dest).expect("key_list чужого");
        let req = self.client.token_request_for(dest, &kl_list(&kl), &key, 10).expect("token_request_for");
        let resp = self.id.call_to(req.method, req.body.clone(), dest).expect("issue_blinded у чужого");
        let n = self.client.token_response_for(dest, &ipb::TokensIssueBlindedResponse::decode(resp.as_slice()).unwrap()).expect("token_response_for");
        assert_eq!(n, 10);
    }

    fn op(&mut self, f: &mut dyn FnMut(&mut Client) -> Result<Vec<OutRequest>, ClientError>) -> Result<(), String> {
        for _ in 0..10 {
            match f(&mut self.client) {
                Ok(reqs) => return self.run(&reqs).map_err(|e| format!("{e:?}")),
                Err(ClientError::Need(n)) => {
                    if !self.satisfy(&n) {
                        return Err(format!("не добрать {n:?}"));
                    }
                }
                Err(e) => return Err(format!("{e:?}")),
            }
        }
        Err("не сошлось".into())
    }

    fn drain(&mut self, after: &mut u64) -> Vec<Event> {
        let b = self.id.call("msg.inbox.sync", mpb::InboxSyncRequest { after_seq: *after, max_bytes: 0 }.encode_to_vec()).unwrap();
        let recs = mpb::InboxSyncResponse::decode(b.as_slice()).unwrap().records;
        let mut out = vec![];
        for r in recs {
            *after = (*after).max(r.seq);
            let bytes = r.encode_to_vec();
            for _ in 0..10 {
                match self.client.open_record(&bytes) {
                    Ok(ev) => {
                        for e in &ev {
                            if let Event::GroupChanged { group, .. } = e {
                                self.group_sync(group);
                                out.extend(self.client.drain_ready());
                            }
                        }
                        out.extend(ev);
                        break;
                    }
                    Err(ClientError::Need(n)) => {
                        if !self.satisfy(&n) {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        out
    }
}

impl Dev {
    /// Журнал группы — у сервера группы.
    fn group_sync(&mut self, g: &parvane_protocol::pb::parvane::core::v2::Ref) {
        use parvane_protocol::pb::parvane::group::v2 as gpb;
        let dest = if g.domain == self.own_domain() { String::new() } else { g.domain.clone() };
        for _ in 0..8 {
            let after = self.client.group_version(&g.id);
            // Исключённому журнал больше не отдают (FORBIDDEN) — как внутри одного сервера.
            let Ok(b) = self
                .id
                .call_to("group.state.sync", gpb::StateSyncRequest { group: Some(g.clone()), after_version: after, ..Default::default() }.encode_to_vec(), &dest)
            else {
                return;
            };
            let r = gpb::StateSyncResponse::decode(b.as_slice()).unwrap();
            match self.client.group_ingest_hinted(g, r.entries, &r.signer_hints) {
                Ok(_) => return,
                Err(ClientError::Need(n)) => assert!(self.satisfy(&n), "добор {n:?}"),
                Err(e) => panic!("group_ingest: {e:?}"),
            }
        }
        panic!("журнал группы не догнан");
    }
}

fn kl_list(bytes: &[u8]) -> parvane_protocol::pb::parvane::core::v2::SignedTokenKeyList {
    ipb::TokensKeyListResponse::decode(bytes).unwrap().list.expect("список ключей")
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn texts(ev: &[Event]) -> Vec<(String, String)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Direct { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((from.clone(), t.text.clone())),
            Event::Group { from, content: Content { kind: Some(content::Kind::Text(t)), .. }, .. } => Some((from.clone(), t.text.clone())),
            _ => None,
        })
        .collect()
}

/// Подождать, пока условие станет истинным (доставка между серверами асинхронна).
fn eventually<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "не дождались: {what}");
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn db_bytes(dir: &Path, prefix: &str) -> Vec<u8> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(prefix) {
            out.extend(std::fs::read(e.path()).unwrap_or_default());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn federation_direct_messages_between_two_servers() {
    let Some((a, b)) = tokio::task::spawn_blocking(|| two_stacks(&[], &[])).await.unwrap() else { return };
    let (addr_a, addr_b) = (a.gateway_tcp.clone(), b.gateway_tcp.clone());
    let tag = free_port();
    let r = tokio::task::spawn_blocking(move || {
        let anya_u = format!("anya{tag}@{A}");
        let boris_u = format!("boris{tag}@{B}");
        let mut anya = Dev::register(&addr_a, &anya_u);
        let mut boris = Dev::register(&addr_b, &boris_u);
        let mut cur_b = 0;
        let mut cur_a = 0;

        // Первое письмо незнакомцу на другом сервере: журнал и бандл — с сервера B,
        // жетон — сервера B, письмо — серверу B.
        let bu = boris_u.clone();
        anya.op(&mut |c| c.prepare_direct(&bu, &text("привет с сервера A"))).expect("письмо Борису");
        assert!(anya.client.token_count_for(B) < 10, "потрачен жетон сервера B");
        let got = eventually("письмо у Бориса", || {
            let t = texts(&boris.drain(&mut cur_b));
            (!t.is_empty()).then_some(t)
        });
        assert_eq!(got, vec![(anya_u.clone(), "привет с сервера A".to_string())]);

        // Ответ: ключ доступа Ани Борис получил в первом письме — без жетонов.
        let au = anya_u.clone();
        boris.op(&mut |c| c.prepare_direct(&au, &text("и тебе привет с B"))).expect("ответ Ане");
        let got = eventually("ответ у Ани", || {
            let t = texts(&anya.drain(&mut cur_a));
            (!t.is_empty()).then_some(t)
        });
        assert_eq!(got, vec![(boris_u.clone(), "и тебе привет с B".to_string())]);
        assert_eq!(boris.client.token_count_for(A), 0, "ответ без жетонов сервера A");
        (anya_u, boris_u)
    })
    .await;
    match r {
        Ok((anya_u, _boris_u)) => {
            // Сервер B не знает, кто из пользователей A написал Борису (sealed sender).
            let m = db_bytes(&b.dir, "messenger");
            assert!(!contains(&m, anya_u.as_bytes()), "адрес отправителя в базе messenger сервера B");
            assert!(!contains(&m, "привет с сервера A".as_bytes()), "текст в базе сервера B");
        }
        Err(e) => {
            let logs: String = ["federation", "gateway", "messenger", "identity"]
                .iter()
                .flat_map(|s| [(&a, *s), (&b, *s)])
                .map(|(st, s)| format!("\n── {} {s} ──\n{}", st.domain, st.log(s).lines().rev().take(25).collect::<Vec<_>>().join("\n")))
                .collect();
            panic!("{e:?}{logs}");
        }
    }
}

fn fail_logs(a: &Stack, b: &Stack) -> String {
    ["federation", "gateway", "messenger", "identity", "domains"]
        .iter()
        .flat_map(|s| [(a, *s), (b, *s)])
        .map(|(st, s)| format!("\n── {} {s} ──\n{}", st.domain, st.log(s).lines().rev().take(25).collect::<Vec<_>>().join("\n")))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn federation_groups_calls_and_shared_folders() {
    use parvane_protocol::pb::parvane::call::v2::{call_signal::Signal, CallSignal, Offer, RingSealedResponse};
    use parvane_protocol::pb::parvane::core::v2::{DomainContainerGetRequest, DomainGrantListRequest, DomainOpSyncRequest, Ref};
    use parvane_protocol::pb::parvane::group::v2::{GroupKind, Permissions};
    let Some((a, b)) = tokio::task::spawn_blocking(|| two_stacks(&[], &[])).await.unwrap() else { return };
    let (addr_a, addr_b) = (a.gateway_tcp.clone(), b.gateway_tcp.clone());
    let tag = free_port();
    let r = tokio::task::spawn_blocking(move || {
        let anya_u = format!("anya{tag}@{A}");
        let boris_u = format!("boris{tag}@{B}");
        let mut anya = Dev::register(&addr_a, &anya_u);
        let mut boris = Dev::register(&addr_b, &boris_u);
        let (mut ca, mut cb) = (0, 0);
        // Знакомство: ключи доступа друг друга.
        let bu = boris_u.clone();
        anya.op(&mut |c| c.prepare_direct(&bu, &text("знакомство"))).expect("знакомство");
        eventually("знакомство у Бориса", || (!texts(&boris.drain(&mut cb)).is_empty()).then_some(()));
        let au = anya_u.clone();
        boris.op(&mut |c| c.prepare_direct(&au, &text("ответ"))).expect("ответ");
        eventually("ответ у Ани", || (!texts(&anya.drain(&mut ca)).is_empty()).then_some(()));

        // ── группа на A с участником с B ──
        let perms = Permissions { send_messages: true, ..Default::default() };
        let (g, r) = anya.client.group_create(GroupKind::Group, "Кружок", std::slice::from_ref(&boris_u), perms).unwrap();
        assert_eq!(g.domain, A);
        anya.exec(&r).expect("генезис группы на A (приватность Бориса — у сервера B)");
        let gid = g.id.clone();
        anya.op(&mut |c| c.group_rotate_epoch(&gid)).expect("эпоха");
        eventually("Борис знает группу", || {
            boris.drain(&mut cb);
            boris.client.group_state(&gid).is_some().then_some(())
        });
        assert_eq!(boris.client.group_domain(&gid), A);
        // Борис пишет в группу: конверт — серверу A, тот раздаёт.
        boris.op(&mut |c| c.prepare_group(&gid, &text("в группе от Бориса"))).expect("групповое Бориса");
        let got = eventually("сообщение Бориса у Ани", || {
            let t = texts(&anya.drain(&mut ca));
            (!t.is_empty()).then_some(t)
        });
        assert!(got.contains(&(boris_u.clone(), "в группе от Бориса".to_string())), "{got:?}");
        // Аня пишет: конверт Борису — через сервер B (очередь federation).
        anya.op(&mut |c| c.prepare_group(&gid, &text("в группе от Ани"))).expect("групповое Ани");
        let got = eventually("сообщение Ани у Бориса", || {
            let t = texts(&boris.drain(&mut cb));
            t.iter().any(|(_, x)| x == "в группе от Ани").then_some(t)
        });
        assert!(got.contains(&(anya_u.clone(), "в группе от Ани".to_string())), "{got:?}");

        // ── звонок между серверами ──
        let offer = CallSignal { call_id: vec![7u8; 16], signal: Some(Signal::Offer(Offer { sdp: "v=0 FED".into(), video: false, group: None })), group_call_id: vec![] };
        let reqs = {
            let mut out = None;
            for _ in 0..6 {
                match anya.client.prepare_call(&boris_u, &offer) {
                    Ok(r) => {
                        out = Some(r);
                        break;
                    }
                    Err(ClientError::Need(n)) => assert!(anya.satisfy(&n)),
                    Err(e) => panic!("{e:?}"),
                }
            }
            out.expect("prepare_call")
        };
        let ring = anya.exec(&reqs[0]).expect("звонок Борису через сервер B");
        assert!(RingSealedResponse::decode(ring.as_slice()).unwrap().delivered >= 1, "звонок дошёл до устройства Бориса");

        // ── совместная папка на A, Борис — читатель ──
        let (cid, create) = anya.client.cloud_create(1).unwrap();
        anya.exec(&create).expect("контейнер");
        let local = anya.client.cloud_prepare_local(&cid, &serde_json::json!({"ops": [{"op": "meta", "name": "Общая"}]}).to_string()).unwrap();
        let req = anya.client.cloud_seal(&cid, &local.op, &local.op_id, 1).unwrap();
        anya.exec(&req).expect("операция");
        let (c2, bu) = (cid.clone(), boris_u.clone());
        anya.op(&mut |c| c.cloud_grant(&c2, &bu, false, "Приглашение", 2)).expect("грант Борису");
        eventually("ключ папки у Бориса", || {
            boris.drain(&mut cb);
            (boris.client.cloud_domain(&cid) == A).then_some(())
        });
        let cref = Ref { domain: A.into(), id: cid.clone() };
        let get = boris.id.call_to("domain.container.get", DomainContainerGetRequest { container: Some(cref.clone()) }.encode_to_vec(), A).expect("container.get у A");
        let grants = boris.id.call_to("domain.grant.list", DomainGrantListRequest { container: Some(cref.clone()), after_version: 0 }.encode_to_vec(), A).expect("grant.list у A");
        boris.op(&mut |c| c.cloud_attach(&get, &grants).map(|_| vec![])).expect("attach");
        assert!(boris.client.cloud_has_key(&cid), "ключ папки принят от сервера владельца");
        let sync = boris.id.call_to("domain.op.sync", DomainOpSyncRequest { container: Some(cref), after_seq: 0, max_bytes: 0 }.encode_to_vec(), A).expect("op.sync у A");
        let ing = boris.client.cloud_ingest_sync(&cid, &sync, false).expect("ingest");
        assert!(ing.applied >= 1, "{ing:?}");
        // Читатель не пишет: сервер A отказывает (право — по гранту адреса с B).
        let local = boris.client.cloud_prepare_local(&cid, &serde_json::json!({"ops": [{"op": "meta", "name": "x"}]}).to_string());
        assert!(local.is_err(), "движок не даёт читателю писать");

        // ── исключение Бориса: новая эпоха ──
        let (g2, bu) = (gid.clone(), boris_u.clone());
        let rm = parvane_protocol::pb::parvane::group::v2::group_change::Change::RemoveMember(parvane_protocol::pb::parvane::group::v2::RemoveMember {
            member: Some(UserRef { address: bu.clone() }),
        });
        let r = anya.client.group_change(&g2, rm).expect("исключение");
        anya.exec(&r).expect("исключение у A");
        // Смена эпохи — не чаще раза в 10 с (движок и сервер).
        std::thread::sleep(Duration::from_millis(parvane_protocol::group::EPOCH_MIN_INTERVAL_MS as u64 + 500));
        anya.op(&mut |c| c.group_rotate_epoch(&g2)).expect("новая эпоха");
        anya.op(&mut |c| c.prepare_group(&g2, &text("после исключения"))).expect("групповое после");
        std::thread::sleep(Duration::from_secs(3));
        let t = texts(&boris.drain(&mut cb));
        assert!(!t.iter().any(|(_, x)| x == "после исключения"), "исключённый прочитал: {t:?}");
    })
    .await;
    if let Err(e) = r {
        panic!("{e:?}{}", fail_logs(&a, &b));
    }
}

/// Сырой HTTP POST кадра на вход федерации → код статуса.
fn raw_post(port: u16, body: &[u8]) -> u16 {
    use std::io::{Read, Write};
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    let head = format!(
        "POST /_parvane/s2s HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/vnd.parvane.s2s\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

/// Знакомство и группа на A с Борисом; курсоры инбоксов.
fn meet_and_group(anya: &mut Dev, boris: &mut Dev, ca: &mut u64, cb: &mut u64) -> Vec<u8> {
    use parvane_protocol::pb::parvane::group::v2::{GroupKind, Permissions};
    let (anya_u, boris_u) = (anya.client.user.clone(), boris.client.user.clone());
    let bu = boris_u.clone();
    anya.op(&mut |c| c.prepare_direct(&bu, &text("знакомство"))).expect("знакомство");
    eventually("знакомство у Бориса", || (!texts(&boris.drain(cb)).is_empty()).then_some(()));
    let au = anya_u.clone();
    boris.op(&mut |c| c.prepare_direct(&au, &text("ответ"))).expect("ответ");
    eventually("ответ у Ани", || (!texts(&anya.drain(ca)).is_empty()).then_some(()));
    let perms = Permissions { send_messages: true, ..Default::default() };
    let (g, r) = anya.client.group_create(GroupKind::Group, "Кружок", std::slice::from_ref(&boris_u), perms).unwrap();
    anya.exec(&r).expect("генезис");
    let gid = g.id.clone();
    anya.op(&mut |c| c.group_rotate_epoch(&gid)).expect("эпоха");
    eventually("Борис знает группу", || {
        boris.drain(cb);
        boris.client.group_state(&gid).is_some().then_some(())
    });
    gid
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn federation_refusals_admin_and_queue() {
    use parvane_protocol::pb::parvane::core::v2::{s2s_request, S2sForward, S2sRequest};
    let Some((a, b)) = tokio::task::spawn_blocking(|| two_stacks(&[], &[])).await.unwrap() else { return };
    let (addr_a, addr_b) = (a.gateway_tcp.clone(), b.gateway_tcp.clone());
    let b_port = b.fed_port;
    let tag = free_port();
    let stacks = std::sync::Arc::new(std::sync::Mutex::new((a, b)));
    let st = stacks.clone();
    let r = tokio::task::spawn_blocking(move || {
        let anya_u = format!("anya{tag}@{A}");
        let boris_u = format!("boris{tag}@{B}");
        let mut anya = Dev::register(&addr_a, &anya_u);
        let mut boris = Dev::register(&addr_b, &boris_u);
        let (mut ca, mut cb) = (0, 0);
        let gid = meet_and_group(&mut anya, &mut boris, &mut ca, &mut cb);
        let log_req = || ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: boris_u.clone() }), after_version: 0, ..Default::default() }.encode_to_vec();

        // ── блокировка своим администратором → DOMAIN_BLOCKED ──
        st.lock().unwrap().0.admin(&["block", B]);
        assert_eq!(anya.anon_to("identity.device.log_sync_anon", log_req(), B).err(), Some(ErrorCode::DomainBlocked));
        st.lock().unwrap().0.admin(&["unblock", B]);
        assert!(anya.anon_to("identity.device.log_sync_anon", log_req(), B).is_ok(), "после разблокировки");

        // ── блокировка чужим администратором → DOMAIN_REFUSED ──
        st.lock().unwrap().1.admin(&["block", A]);
        assert_eq!(anya.anon_to("identity.device.log_sync_anon", log_req(), B).err(), Some(ErrorCode::DomainRefused));
        st.lock().unwrap().1.admin(&["unblock", A]);
        assert!(anya.anon_to("identity.device.log_sync_anon", log_req(), B).is_ok());

        // ── поддельный кадр «от A» чужим ключом — отказ до шины ──
        let fake = ed25519_dalek::SigningKey::from_bytes(&[0xEE; 32]);
        let req = S2sRequest {
            kind: Some(s2s_request::Kind::Forward(S2sForward {
                method: "identity.device.log_sync_anon".into(),
                body: log_req(),
                ..Default::default()
            })),
        };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let frame = parvane_protocol::federation::sign_frame(&fake, A, B, now, parvane_protocol::federation::REQUEST_TYPE, req.encode_to_vec()).unwrap();
        assert_eq!(raw_post(b_port, &frame.encode_to_vec()), 400, "поддельная подпись");
        assert_eq!(raw_post(b_port, b"not a frame"), 400, "мусор");

        // ── сервер B недоступен: запрос — DOMAIN_UNREACHABLE, запись группы ждёт в очереди ──
        // Ключ сессии группы Борису раздаётся личным письмом при первом сообщении эпохи — синхронно,
        // повтор при недоступном сервере за клиентом; поэтому первое сообщение — до остановки B.
        let g1 = gid.clone();
        anya.op(&mut |c| c.prepare_group(&g1, &text("до остановки B"))).expect("групповое до остановки");
        eventually("сообщение до остановки у Бориса", || texts(&boris.drain(&mut cb)).iter().any(|(_, x)| x == "до остановки B").then_some(()));
        st.lock().unwrap().1.stop_federation();
        assert_eq!(anya.anon_to("identity.device.log_sync_anon", log_req(), B).err(), Some(ErrorCode::DomainUnreachable));
        let g2 = gid.clone();
        anya.op(&mut |c| c.prepare_group(&g2, &text("пока B лежал"))).expect("групповое при недоступном B");
        std::thread::sleep(Duration::from_secs(3));
        st.lock().unwrap().1.start_federation();
        let got = eventually("запись из очереди у Бориса после возвращения B", || {
            let t = texts(&boris.drain(&mut cb));
            t.iter().any(|(_, x)| x == "пока B лежал").then_some(t)
        });
        assert!(got.contains(&(anya_u.clone(), "пока B лежал".to_string())));
    })
    .await;
    if let Err(e) = r {
        let g = stacks.lock().unwrap();
        panic!("{e:?}{}", fail_logs(&g.0, &g.1));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn federation_switched_off_refuses_both_ways() {
    let off = [("PARVANE_FEDERATION", "off".to_string())];
    let Some((a, b)) = tokio::task::spawn_blocking(move || two_stacks(&off, &[])).await.unwrap() else { return };
    let (addr_a, addr_b) = (a.gateway_tcp.clone(), b.gateway_tcp.clone());
    let tag = free_port();
    let r = tokio::task::spawn_blocking(move || {
        let anya = Dev::register(&addr_a, &format!("anya{tag}@{A}"));
        let boris = Dev::register(&addr_b, &format!("boris{tag}@{B}"));
        let req = |u: &str| ipb::DeviceLogSyncAnonRequest { user: Some(UserRef { address: u.into() }), after_version: 0, ..Default::default() }.encode_to_vec();
        // Свой сервер с выключенной федерацией — наружу не ходит.
        assert_eq!(anya.anon_to("identity.device.log_sync_anon", req(&boris.client.user), B).err(), Some(ErrorCode::FederationUnavailable));
        // Чужой сервер получает отказ «выключено».
        assert_eq!(boris.anon_to("identity.device.log_sync_anon", req(&anya.client.user), A).err(), Some(ErrorCode::DomainRefused));
    })
    .await;
    if let Err(e) = r {
        panic!("{e:?}{}", fail_logs(&a, &b));
    }
}
