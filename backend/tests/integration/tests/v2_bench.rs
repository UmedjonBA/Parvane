//! T109 / SC-010: задержка доставки и трафик на сообщение, v2 против v1, на
//! одном стенде (nats-server + identity + messenger + gateway, как v2_live.rs).
//!
//! - v1: построчный JSON через gateway TCP, как web/desktop v1: событие с
//!   JWT, sealed-вариант (`from` пуст, `sender_signing_key`, подпись SEND-1,
//!   копия устройству), содержимое — Olm-шифртекст JSON `{"kind":"text",…}`;
//!   получатель подписан на `msg.user.<адрес>`.
//! - v2: TCP с преамбулой `PVN2`, клиентское ядро `parvane_protocol::client`
//!   (sealed sender HPKE поверх Olm, ключ доступа собеседника), доставка
//!   `msg.deliver_sealed` анонимным каналом, получение — событие
//!   `inbox.record` подписки `msg.inbox.subscribe`.
//!
//! Замер: после разогрева (обмен в обе стороны — Olm выходит из pre-key)
//! N сообщений отправитель→получатель по одному (следующее — после приёма
//! предыдущего). Задержка — от начала подготовки (шифрование) у отправителя
//! до расшифрованного сообщения у получателя. Трафик — байты TCP-полезной
//! нагрузки на сокетах клиента (запись + чтение), отдельно у отправителя и
//! у получателя, делённые на N.
//!
//! Запуск: `scripts/protocol_bench.sh` (или
//! `cargo test [--release] -p parvane-integration --test v2_bench -- --ignored --nocapture`),
//! N — `PARVANE_BENCH_N` (по умолчанию 200). Печатает строку `BENCH_JSON {…}`.

mod v2common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use parvane_protocol::client::Event;
use parvane_protocol::olm::{OlmAccount, OlmSession};
use parvane_protocol::pb::parvane::msg::v2::{content, Content, Text};
use serde_json::{json, Value};
use v2common::{Device, PASSWORD};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD_NO_PAD;

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
        if std::env::var("PARVANE_BENCH_KEEP_LOGS").is_ok() {
            eprintln!("логи стека: {}", self.dir.display());
        } else {
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

fn release() -> bool {
    !cfg!(debug_assertions)
}

fn target_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target").join(if release() { "release" } else { "debug" })
}

fn spawn(bin: &str, envs: &[(&str, &str)], log: &Path) -> Child {
    let out = std::fs::File::create(log).unwrap();
    let err = out.try_clone().unwrap();
    Command::new(target_dir().join(bin))
        .envs(envs.iter().copied())
        .env("PARVANE_LOG_LEVEL", "warn")
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
    let mut args = vec!["build", "-p", "identity", "-p", "messenger", "-p", "gateway"];
    if release() {
        args.push("--release");
    }
    let status = Command::new(env!("CARGO")).args(&args).current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).status().unwrap();
    assert!(status.success());
    let dir = std::env::temp_dir().join(format!("parvane-v2bench-{}-{}", std::process::id(), free_port()));
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
            ("PARVANE_LOGIN_RATE_IP", "100000"),
            ("PARVANE_REGISTER_RATE_IP", "100000"),
        ],
        &dir.join("identity.log"),
    ));
    let m_db = dir.join("messenger.db").to_string_lossy().to_string();
    children.push(spawn("messenger", &[("PARVANE_NATS_URL", &nats_url), ("PARVANE_DB_PATH", &m_db)], &dir.join("messenger.log")));
    // Лимиты частоты подняты: замер идёт подряд, а не с темпом человека.
    let big = "1000000";
    children.push(spawn(
        "gateway",
        &[
            ("PARVANE_NATS_URL", &nats_url),
            ("PARVANE_GATEWAY_TCP_BIND", &gateway_tcp),
            ("PARVANE_GATEWAY_BIND", &gateway_ws),
            ("PARVANE_V2_FEATURES", "sealed"),
            ("GATEWAY_RATE_MSG_BURST", big),
            ("GATEWAY_RATE_MSG_PER_SEC", big),
            ("GATEWAY_RATE_REQ_BURST", big),
            ("GATEWAY_RATE_REQ_PER_SEC", big),
            ("GATEWAY_RATE_ANON_BURST", big),
            ("GATEWAY_RATE_ANON_PER_SEC", big),
            ("GATEWAY_RATE_ANON_IP_BURST", big),
            ("GATEWAY_RATE_ANON_IP_PER_SEC", big),
            ("GATEWAY_RATE_PRE_BURST", big),
            ("GATEWAY_RATE_PRE_PER_SEC", big),
            ("GATEWAY_RATE_BUNDLE_IP_BURST", big),
            ("GATEWAY_RATE_BUNDLE_IP_PER_SEC", big),
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
    for subject in ["identity.server.info", "group.list"] {
        loop {
            let r = tokio::time::timeout(Duration::from_millis(300), nc.request(subject, "{}".into())).await;
            if matches!(r, Ok(Ok(_))) {
                break;
            }
            assert!(startt.elapsed() < Duration::from_secs(30), "{subject}: шард не поднялся");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    while TcpStream::connect(&stack.gateway_tcp).is_err() {
        assert!(startt.elapsed() < Duration::from_secs(60), "gateway не слушает");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Some((stack, nc))
}

async fn nreq(nc: &async_nats::Client, subject: &str, body: Value) -> Value {
    let r = nc.request(subject.to_string(), body.to_string().into()).await.unwrap();
    serde_json::from_slice(&r.payload).unwrap_or(Value::Null)
}

// ── v1: построчный JSON ─────────────────────────────────────────────────────

struct V1 {
    w: TcpStream,
    r: BufReader<CountingRead>,
    tx_bytes: u64,
}

struct CountingRead {
    s: TcpStream,
    n: u64,
}

impl Read for CountingRead {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let k = self.s.read(buf)?;
        self.n += k as u64;
        Ok(k)
    }
}

impl V1 {
    fn connect(addr: &str, token: &str) -> V1 {
        let s = TcpStream::connect(addr).unwrap();
        s.set_nodelay(true).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let w = s.try_clone().unwrap();
        let mut c = V1 { w, r: BufReader::new(CountingRead { s, n: 0 }), tx_bytes: 0 };
        c.send(&json!({"op": "auth", "token": token}));
        let v = c.recv().expect("auth ответ");
        assert_eq!(v["op"], "auth_ok", "v1 auth: {v}");
        c
    }
    fn send(&mut self, v: &Value) {
        let line = format!("{v}\n");
        self.w.write_all(line.as_bytes()).unwrap();
        self.tx_bytes += line.len() as u64;
    }
    fn recv(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.r.read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(&line).ok(),
        }
    }
    fn bytes(&self) -> u64 {
        self.tx_bytes + self.r.get_ref().n
    }
}

/// v1-отправитель: Olm-аккаунт + сессия с устройством собеседника.
struct V1Peer {
    user: String,
    token: String,
    acc: OlmAccount,
    /// Одна Olm-сессия пары (двусторонняя).
    sess: Option<OlmSession>,
}

impl V1Peer {
    /// Событие `msg.chat.send` как у web v1 (messages.ts: sealForAddress + SEND-1).
    fn send_frame(&mut self, to: &str, device: &str, text: &str) -> Value {
        let inner = json!({"kind": "text", "text": text}).to_string();
        let (ctype, ct) = self.sess.as_mut().unwrap().encrypt(inner.as_bytes()).unwrap();
        let ciphertext = B64.encode(ct);
        let id = uuid::Uuid::now_v7().to_string();
        let signature = B64.encode(self.acc.sign(format!("send:{id}:{ciphertext}").as_bytes()));
        let ev = json!({
            "id": id, "from": "", "ts": chrono_secs(), "token": self.token,
            "payload": {
                "to": to,
                "content": {
                    "kind": "encrypted", "ciphertext": ciphertext, "ctype": ctype,
                    "sender_identity": B64.encode(self.acc.curve25519()),
                    "sender_signing_key": B64.encode(self.acc.ed25519()),
                },
                "copies": [{"recipient": to, "device_id": device, "ciphertext": ciphertext, "ctype": ctype}],
                "signature": signature,
            }
        });
        json!({"op": "pub", "subject": "msg.chat.send", "payload": ev.to_string()})
    }

    /// Расшифровать входящее из live-пуша инбокса.
    fn open(&mut self, frame: &Value, from_identity: &[u8; 32]) -> Option<String> {
        if frame["op"] != "msg" {
            return None;
        }
        let m: Value = serde_json::from_str(frame["payload"].as_str()?).ok()?;
        // Кадр инбокса: ParvaneEvent<InboxPush { message }>.
        let c = &m["payload"]["message"]["content"];
        let ct = B64.decode(c["ciphertext"].as_str()?).ok()?;
        let t = c["ctype"].as_u64().unwrap_or(1) as u32;
        let pt = match &mut self.sess {
            Some(s) => s.decrypt(t, &ct).ok()?,
            None => {
                let (s, pt) = self.acc.inbound(from_identity, &ct).ok()?;
                self.sess = Some(s);
                pt
            }
        };
        let v: Value = serde_json::from_slice(&pt).ok()?;
        v["text"].as_str().map(str::to_string)
    }
}

fn chrono_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Default)]
struct Sample {
    lat_us: Vec<u64>,
    sender_bytes: u64,
    receiver_bytes: u64,
}

fn pct(v: &[u64], p: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_unstable();
    if s.is_empty() {
        return 0.0;
    }
    let i = ((p * (s.len() - 1) as f64).round() as usize).min(s.len() - 1);
    s[i] as f64 / 1000.0
}

fn summary(s: &Sample, n: usize) -> Value {
    let mean = s.lat_us.iter().sum::<u64>() as f64 / s.lat_us.len().max(1) as f64 / 1000.0;
    json!({
        "n": s.lat_us.len(),
        "latency_ms": {"p50": pct(&s.lat_us, 0.5), "p95": pct(&s.lat_us, 0.95), "mean": (mean * 1000.0).round() / 1000.0, "max": pct(&s.lat_us, 1.0)},
        "bytes_per_msg": {
            "sender": s.sender_bytes as f64 / n as f64,
            "receiver": s.receiver_bytes as f64 / n as f64,
            "total": (s.sender_bytes + s.receiver_bytes) as f64 / n as f64,
        },
    })
}

fn bench_v1(addr: &str, a: &mut V1Peer, b: &mut V1Peer, n: usize, text_len: usize) -> Sample {
    let mut sa = V1::connect(addr, &a.token);
    let mut rb = V1::connect(addr, &b.token);
    let mut ra = V1::connect(addr, &a.token);
    // Сессии Olm (прекей устройства получателя — как из бандла).
    let (_, otk_b) = b.acc.generate_one_time_keys(1).remove(0);
    a.sess = Some(a.acc.outbound(&b.acc.curve25519(), &otk_b).unwrap());
    rb.send(&json!({"op": "sub", "subject": format!("msg.user.{}", b.user)}));
    ra.send(&json!({"op": "sub", "subject": format!("msg.user.{}", a.user)}));
    std::thread::sleep(Duration::from_millis(500));
    let (ida, idb) = (a.acc.curve25519(), b.acc.curve25519());
    let wait = |conn: &mut V1, peer: &mut V1Peer, from: &[u8; 32], needle: &str| loop {
        let f = conn.recv().expect("v1: нет входящего");
        if f["op"] != "msg" {
            eprintln!("v1: кадр {f}");
        }
        if let Some(t) = peer.open(&f, from) {
            if t == needle {
                return;
            }
        }
    };
    // Разогрев: a→b, b→a (Olm выходит из pre-key), a→b.
    let f = a.send_frame(&b.user, "d1", "warm-1");
    sa.send(&f);
    sa.w.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
    if let Some(e) = sa.recv() {
        panic!("v1: отправка отвергнута: {e}");
    }
    sa.w.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    wait(&mut rb, b, &ida, "warm-1");
    let f = b.send_frame(&a.user, "d1", "warm-2");
    rb.send(&f);
    wait(&mut ra, a, &idb, "warm-2");
    let f = a.send_frame(&b.user, "d1", "warm-3");
    sa.send(&f);
    wait(&mut rb, b, &ida, "warm-3");

    let pad = "x".repeat(text_len.saturating_sub(12));
    let mut s = Sample::default();
    let (s0, r0) = (sa.bytes(), rb.bytes());
    for i in 0..n {
        let text = format!("m{i:05}-{pad}");
        let t0 = Instant::now();
        let f = a.send_frame(&b.user, "d1", &text);
        sa.send(&f);
        wait(&mut rb, b, &ida, &text);
        s.lat_us.push(t0.elapsed().as_micros() as u64);
    }
    s.sender_bytes = sa.bytes() - s0;
    s.receiver_bytes = rb.bytes() - r0;
    drop(ra);
    s
}

fn text(t: &str) -> Content {
    Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
}

fn wait_v2(d: &mut Device, needle: &str) {
    loop {
        let ev = d.id.next_event().expect("v2: нет события");
        if ev.kind != "inbox.record" {
            continue;
        }
        for e in d.open(&ev.body) {
            if let Event::Direct { content, .. } = e {
                if matches!(&content.kind, Some(content::Kind::Text(t)) if t.text == needle) {
                    return;
                }
            }
        }
    }
}

fn bench_v2(addr: &str, n: usize, text_len: usize, p: u16) -> Sample {
    let (ua, ub) = (format!("bv2a{p}@local"), format!("bv2b{p}@local"));
    let mut a = Device::register(addr, &ua, "d1");
    let mut b = Device::register(addr, &ub, "d1");
    b.id.call("msg.inbox.subscribe", vec![]).expect("subscribe b");
    a.id.call("msg.inbox.subscribe", vec![]).expect("subscribe a");
    // Ключ доступа b известен a (профиль/прошлый контакт) — без жетонов.
    let (k, g) = (b.client.delivery_key().to_vec(), b.client.delivery_key_generation());
    a.client.set_peer_delivery_key(&ub, k, g);
    // Разогрев: a→b (с раздачей ключа доступа a), b→a, a→b.
    a.op(&mut |c| c.prepare_direct(&ub, &text("warm-1"))).unwrap();
    wait_v2(&mut b, "warm-1");
    b.op(&mut |c| c.prepare_direct(&ua, &text("warm-2"))).unwrap();
    wait_v2(&mut a, "warm-2");
    a.op(&mut |c| c.prepare_direct(&ub, &text("warm-3"))).unwrap();
    wait_v2(&mut b, "warm-3");

    let pad = "x".repeat(text_len.saturating_sub(12));
    let texts: Vec<String> = (0..n).map(|i| format!("m{i:05}-{pad}")).collect();
    let b_bytes0 = b.id.tx_bytes + b.id.rx_bytes + b.anon.tx_bytes + b.anon.rx_bytes;
    let a_bytes0 = a.id.tx_bytes + a.id.rx_bytes + a.anon.tx_bytes + a.anon.rx_bytes;
    // Получатель — отдельный поток: ответ отправителю (deliver_sealed) и
    // событие получателю идут параллельно, как у живых клиентов.
    let (tx, rx) = mpsc::channel::<Instant>();
    let texts_r = texts.clone();
    let recv = std::thread::spawn(move || {
        for t in &texts_r {
            wait_v2(&mut b, t);
            tx.send(Instant::now()).unwrap();
        }
        b
    });
    let mut s = Sample::default();
    for t in &texts {
        let t0 = Instant::now();
        a.op(&mut |c| c.prepare_direct(&ub, &text(t))).unwrap();
        let t1 = rx.recv_timeout(Duration::from_secs(20)).expect("v2: получатель не принял");
        s.lat_us.push(t1.duration_since(t0).as_micros() as u64);
    }
    let b = recv.join().unwrap();
    s.sender_bytes = a.id.tx_bytes + a.id.rx_bytes + a.anon.tx_bytes + a.anon.rx_bytes - a_bytes0;
    s.receiver_bytes = b.id.tx_bytes + b.id.rx_bytes + b.anon.tx_bytes + b.anon.rx_bytes - b_bytes0;
    s
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "замер SC-010 (scripts/protocol_bench.sh)"]
async fn v2_vs_v1_bench() {
    let Some((stack, nc)) = start().await else { return };
    let n: usize = std::env::var("PARVANE_BENCH_N").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
    let text_len: usize = std::env::var("PARVANE_BENCH_TEXT_LEN").ok().and_then(|v| v.parse().ok()).unwrap_or(64);
    let p = free_port();
    let (ua, ub) = (format!("bv1a{p}@local"), format!("bv1b{p}@local"));
    let mut peers = vec![];
    for u in [&ua, &ub] {
        let _ = nreq(&nc, "identity.user.register", json!({"user": u, "password": PASSWORD, "invite": "", "email": "", "client_ip": "127.0.0.1"})).await;
        let t = nreq(&nc, "identity.token.issue", json!({"user": u, "password": PASSWORD, "device_id": "d1"})).await;
        let token = t["token"].as_str().unwrap_or_else(|| panic!("v1 токен {u}: {t}")).to_string();
        peers.push(V1Peer { user: u.clone(), token, acc: OlmAccount::new(), sess: None });
    }
    let addr = stack.gateway_tcp.clone();
    let (v1, v2) = tokio::task::spawn_blocking(move || {
        let mut b = peers.pop().unwrap();
        let mut a = peers.pop().unwrap();
        // Чередуем порядок, чтобы прогрев стека не шёл в пользу одного протокола.
        let v2 = bench_v2(&addr, n, text_len, p);
        let v1 = bench_v1(&addr, &mut a, &mut b, n, text_len);
        (v1, v2)
    })
    .await
    .unwrap();
    let out = json!({
        "profile": if release() { "release" } else { "debug" },
        "n": n,
        "text_len": text_len,
        "v1": summary(&v1, n),
        "v2": summary(&v2, n),
    });
    println!("BENCH_JSON {out}");
    drop(stack);
}
