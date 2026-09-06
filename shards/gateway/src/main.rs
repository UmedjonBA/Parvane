// Parvane gateway: единственная точка входа клиентов в шину. Клиент говорит с
// gateway JSON-кадрами, gateway верифицирует JWT и пропускает только в СВОИ
// subject'ы пользователя. Изоляция «людей» держится на gateway, а не на
// NATS-правах (где все клиенты были одним логином `client`).
//
// Два транспорта, одинаковый JSON-протокол кадров:
//  - TCP (построчный JSON, `\n`-разделитель) — для нативного клиента без
//    зависимостей (parvane-core GatewayTransport);
//  - WebSocket — для будущих браузер/мобильных клиентов.
use anyhow::{anyhow, Context, Result};
use async_nats::Client;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

/// Максимальная длина одного клиентского кадра (защита от кадра без разделителя,
/// раздувающего память). TCP рвёт соединение, WS отвергает по конфигу.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Ёмкость каналов кадров: даёт backpressure вместо неограниченного роста памяти.
const CHANNEL_CAP: usize = 512;
/// За сколько секунд соединение обязано пройти auth, иначе сокет закрывается.
const AUTH_TIMEOUT_SECS: u64 = 10;

/// Лимиты параллельных соединений (глобально и на IP-источник) против исчерпания
/// ресурсов множеством незакрытых/неавторизованных сокетов.
struct Limits {
    conns: Arc<Semaphore>,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    max_per_ip: usize,
}

/// RAII-учёт соединения: освобождает глобальный permit и счётчик по IP при Drop.
struct ConnGuard {
    _permit: OwnedSemaphorePermit,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    ip: IpAddr,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut map = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = map.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// Пытается «впустить» соединение: берёт глобальный permit и место в квоте IP.
/// None — лимит исчерпан (вызывающий закрывает сокет, ничего не выделив).
fn admit(limits: &Limits, ip: IpAddr) -> Option<ConnGuard> {
    let permit = limits.conns.clone().try_acquire_owned().ok()?;
    {
        let mut map = limits.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        let count = map.entry(ip).or_insert(0);
        if *count >= limits.max_per_ip {
            return None; // permit дропнется здесь → глобальный слот освобождён
        }
        *count += 1;
    }
    Some(ConnGuard { _permit: permit, per_ip: limits.per_ip.clone(), ip })
}

use parvane_types::{
    topic_contract::{
        GATEWAY_ALLOWED_PUBLISH, GATEWAY_ALLOWED_REQUEST, GATEWAY_EVENT_SUBJECTS,
        GATEWAY_TOKEN_REQUEST_SUBJECTS,
    },
    topics::{
        call_inbox, msg_inbox, FILE_UPLOAD_CHUNK, FILE_UPLOAD_COMPLETE, IDENTITY_EMAIL_CONFIRM,
        IDENTITY_ISSUE, IDENTITY_REGISTER, IDENTITY_REGISTER_STATUS, IDENTITY_SERVER_INFO,
        IDENTITY_TELEGRAM_CONFIRM, IDENTITY_VERIFY,
    },
    VerifyRequest, VerifyResponse,
};

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Token bucket: `capacity` — допустимый всплеск, `refill_per_sec` — устойчивая
/// частота. Клиент недоверенный: флуд сообщениями/чанками режем на gateway,
/// потому что для sealed-сообщений только он знает пользователя сессии.
struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    last: Instant,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { capacity, tokens: capacity, refill_per_sec, last: Instant::now() }
    }

    fn try_take_at(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    fn try_take(&mut self) -> bool {
        self.try_take_at(Instant::now())
    }
}

/// Лимиты одной авторизованной сессии по классам операций.
struct SessionRate {
    messages: TokenBucket,
    uploads: TokenBucket,
    requests: TokenBucket,
}

impl SessionRate {
    fn from_env() -> Self {
        Self {
            // сообщения/правки/реакции: всплеск 30, устойчиво 3 в секунду
            messages: TokenBucket::new(env_f64("GATEWAY_RATE_MSG_BURST", 30.0), env_f64("GATEWAY_RATE_MSG_PER_SEC", 3.0)),
            // чанки загрузки (256 КиБ): всплеск 400, устойчиво 40/с ≈ 10 МБ/с
            uploads: TokenBucket::new(env_f64("GATEWAY_RATE_UPLOAD_BURST", 400.0), env_f64("GATEWAY_RATE_UPLOAD_PER_SEC", 40.0)),
            // прочие request/reply: всплеск 120, устойчиво 20/с
            requests: TokenBucket::new(env_f64("GATEWAY_RATE_REQ_BURST", 120.0), env_f64("GATEWAY_RATE_REQ_PER_SEC", 20.0)),
        }
    }

    /// true — операция допущена; false — лимит исчерпан
    fn allow(&mut self, subject: &str) -> bool {
        if subject == FILE_UPLOAD_CHUNK || subject == FILE_UPLOAD_COMPLETE {
            self.uploads.try_take()
        } else if subject.starts_with("msg.chat.") {
            self.messages.try_take()
        } else {
            self.requests.try_take()
        }
    }
}

const RATE_LIMITED: &str = "rate_limited: слишком часто, подождите";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    dotenvy::dotenv().ok();

    let ws_bind = env("PARVANE_GATEWAY_BIND", "0.0.0.0:9222");
    let tcp_bind = env("PARVANE_GATEWAY_TCP_BIND", "0.0.0.0:9223");
    let nats_url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    let user = env("PARVANE_NATS_USER", "gateway");
    let pass = std::env::var("PARVANE_NATS_PASS").unwrap_or_default();

    let mut opts = async_nats::ConnectOptions::new();
    if !pass.is_empty() {
        opts = opts.user_and_password(user, pass);
    }
    let nats = Arc::new(opts.connect(&nats_url).await.context("подключение к NATS")?);
    info!("NATS подключён: {}", nats_url);

    let max_conns = std::env::var("PARVANE_GATEWAY_MAX_CONNS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2000usize);
    let max_per_ip = std::env::var("PARVANE_GATEWAY_MAX_CONNS_PER_IP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(64usize);
    let limits = Arc::new(Limits {
        conns: Arc::new(Semaphore::new(max_conns)),
        per_ip: Arc::new(Mutex::new(HashMap::new())),
        max_per_ip,
    });
    info!("Лимиты соединений: всего {}, на IP {}", max_conns, max_per_ip);

    // TCP-листенер (нативный клиент).
    let tcp = TcpListener::bind(&tcp_bind).await.context("bind TCP")?;
    info!("Gateway TCP на {}", tcp_bind);
    {
        let nats = nats.clone();
        let limits = limits.clone();
        tokio::spawn(async move {
            loop {
                match tcp.accept().await {
                    Ok((stream, peer)) => {
                        let Some(guard) = admit(&limits, peer.ip()) else {
                            warn!("tcp {}: соединение отклонено (лимит)", peer);
                            continue; // stream дропается → сокет закрыт
                        };
                        let nats = nats.clone();
                        tokio::spawn(async move {
                            let _guard = guard;
                            if let Err(e) = handle_tcp(stream, nats).await {
                                warn!("tcp {}: {}", peer, e);
                            }
                        });
                    }
                    Err(e) => warn!("tcp accept: {}", e),
                }
            }
        });
    }

    // WebSocket-листенер (будущие браузер/мобилки).
    let ws = TcpListener::bind(&ws_bind).await.context("bind WS")?;
    info!("Gateway WebSocket на {}", ws_bind);
    loop {
        let (stream, peer) = ws.accept().await?;
        let Some(guard) = admit(&limits, peer.ip()) else {
            warn!("ws {}: соединение отклонено (лимит)", peer);
            continue;
        };
        let nats = nats.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if let Err(e) = handle_ws(stream, nats).await {
                warn!("ws {}: {}", peer, e);
            }
        });
    }
}

// ── адаптеры транспорта: превращают соединение в пару каналов кадров-строк ─────

async fn handle_tcp(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    let (mut rd, mut wr) = stream.into_split();
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    // Построчное чтение с жёстким лимитом длины кадра: кадр без разделителя,
    // превысивший MAX_FRAME_BYTES, рвёт соединение (защита от OOM). Ранее
    // BufReader::lines читал строку неограниченной длины.
    tokio::spawn(async move {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = match rd.read(&mut buf).await {
                Ok(0) => break, // EOF
                Ok(n) => n,
                Err(_) => break,
            };
            for &byte in &buf[..n] {
                if byte == b'\n' {
                    let line = String::from_utf8_lossy(&acc).trim().to_string();
                    acc.clear();
                    if !line.is_empty() && in_tx.send(line).await.is_err() {
                        return;
                    }
                } else {
                    if acc.len() >= MAX_FRAME_BYTES {
                        return; // кадр слишком длинный — закрываем сокет
                    }
                    acc.push(byte);
                }
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(mut s) = out_rx.recv().await {
            s.push('\n');
            if wr.write_all(s.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    serve(in_rx, out_tx, nats).await;
    let _ = writer.await;
    Ok(())
}

async fn handle_ws(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    // Ограничиваем размер сообщения/кадра WS на уровне протокола (симметрично TCP).
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(MAX_FRAME_BYTES);
    config.max_frame_size = Some(MAX_FRAME_BYTES);
    let ws = tokio_tungstenite::accept_async_with_config(stream, Some(config))
        .await
        .context("WS handshake")?;
    let (mut write, mut read) = ws.split();
    let (in_tx, in_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    tokio::spawn(async move {
        while let Some(m) = read.next().await {
            match m {
                Ok(WsMessage::Text(t)) => {
                    if in_tx.send(t).await.is_err() {
                        break;
                    }
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::channel::<String>(CHANNEL_CAP);
    let writer = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if write.send(WsMessage::Text(s)).await.is_err() {
                break;
            }
        }
    });
    serve(in_rx, out_tx, nats).await;
    let _ = writer.await;
    Ok(())
}

// ── общая логика: auth + pub/req/reqmany/sub с проверкой прав ──────────────────

async fn serve(
    mut in_rx: mpsc::Receiver<String>,
    tx: mpsc::Sender<String>,
    nats: Arc<Client>,
) {
    // 1) pre-auth: до авторизации разрешены ТОЛЬКО bootstrap-запросы (логин и
    // регистрация — иначе получить токен через gateway было бы невозможно).
    // Всё остальное — после auth с валидным JWT. На всю фазу — idle-timeout:
    // соединение, не авторизовавшееся за AUTH_TIMEOUT_SECS, закрывается.
    let auth_deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    let (user, auth_token) = loop {
        let remaining = auth_deadline.saturating_duration_since(Instant::now());
        let text = match tokio::time::timeout(remaining, in_rx.recv()).await {
            Ok(Some(text)) => text,
            Ok(None) => return, // закрыто до auth
            Err(_) => {
                let _ = tx.send(err_frame(None, "таймаут авторизации")).await;
                return; // не авторизовался вовремя — рвём соединение
            }
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match v["op"].as_str().unwrap_or("") {
            "auth" => match verify_token(&nats, v["token"].as_str().unwrap_or("")).await {
                Ok(u) => {
                    let token = v["token"].as_str().unwrap_or("").to_string();
                    let _ = tx.send(json!({"op":"auth_ok","user":u}).to_string()).await;
                    break (u, token);
                }
                Err(e) => {
                    let _ = tx
                        .send(json!({"op":"auth_err","error":e.to_string()}).to_string())
                        .await;
                    return;
                }
            },
            "req" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if subject == IDENTITY_ISSUE
                    || subject == IDENTITY_REGISTER
                    || subject == IDENTITY_EMAIL_CONFIRM
                    || subject == IDENTITY_SERVER_INFO
                    || subject == IDENTITY_TELEGRAM_CONFIRM
                    || subject == IDENTITY_REGISTER_STATUS
                {
                    spawn_req(
                        nats.clone(),
                        tx.clone(),
                        v["id"].as_str().unwrap_or("").to_string(),
                        subject,
                        v["payload"].as_str().unwrap_or("").to_string(),
                        v["timeout_ms"].as_u64().unwrap_or(3000),
                    );
                } else {
                    let _ = tx.send(err_frame(v["id"].as_str(), "нужна авторизация")).await;
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "нужна авторизация")).await;
            }
        }
    };
    info!("Клиент авторизован: {}", user);

    let mut subs: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    // 2) основной цикл
    let mut rate = SessionRate::from_env();
    while let Some(text) = in_rx.recv().await {
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(err_frame(None, "битый json")).await;
                continue;
            }
        };
        match v["op"].as_str().unwrap_or("") {
            "pub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if !rate.allow(&subject) {
                    warn!("rate limit: {} pub {}", user, subject);
                    let _ = tx.send(json!({"op":"err","error":RATE_LIMITED,"subject":subject}).to_string()).await;
                    continue;
                }
                if allowed_pub(&user, &subject) {
                    match bind_client_payload(
                        &user,
                        &auth_token,
                        &subject,
                        v["payload"].as_str().unwrap_or(""),
                    ) {
                        Ok(payload) => {
                            let _ = nats.publish(subject, payload.into()).await;
                        }
                        Err(e) => {
                            let _ = tx.send(err_frame(None, &e.to_string())).await;
                        }
                    }
                } else {
                    let _ = tx.send(err_frame(None, "publish в этот subject запрещён")).await;
                }
            }
            "req" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let timeout = v["timeout_ms"].as_u64().unwrap_or(3000);
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён")).await;
                    continue;
                }
                if !rate.allow(&subject) {
                    warn!("rate limit: {} req {}", user, subject);
                    let _ = tx.send(err_frame(Some(&id), RATE_LIMITED)).await;
                    continue;
                }
                let payload = match bind_client_payload(
                    &user,
                    &auth_token,
                    &subject,
                    v["payload"].as_str().unwrap_or(""),
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        let _ = tx.send(err_frame(Some(&id), &e.to_string())).await;
                        continue;
                    }
                };
                spawn_req(nats.clone(), tx.clone(), id, subject, payload, timeout);
            }
            // Множественные ответы на один запрос (chunked download): собираем
            // все ответы на приватный inbox до тишины (timeout между ответами)
            // и завершаем reply_end.
            "reqmany" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let timeout = v["timeout_ms"].as_u64().unwrap_or(5000);
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён")).await;
                    continue;
                }
                if !rate.allow(&subject) {
                    warn!("rate limit: {} reqmany {}", user, subject);
                    let _ = tx.send(err_frame(Some(&id), RATE_LIMITED)).await;
                    continue;
                }
                let payload = match bind_client_payload(
                    &user,
                    &auth_token,
                    &subject,
                    v["payload"].as_str().unwrap_or(""),
                ) {
                    Ok(payload) => payload,
                    Err(e) => {
                        let _ = tx.send(err_frame(Some(&id), &e.to_string())).await;
                        continue;
                    }
                };
                let nats2 = nats.clone();
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = reqmany(&nats2, &tx2, &id, subject, payload, timeout).await {
                        let _ = tx2.send(err_frame(Some(&id), &e.to_string())).await;
                    }
                    let _ = tx2.send(json!({"op":"reply_end","id":id}).to_string()).await;
                });
            }
            "sub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if !allowed_sub(&user, &subject) {
                    let _ = tx.send(err_frame(None, "подписка на чужой/запрещённый subject")).await;
                    continue;
                }
                match nats.subscribe(subject).await {
                    Ok(mut sub) => {
                        let tx2 = tx.clone();
                        subs.push(tokio::spawn(async move {
                            while let Some(m) = sub.next().await {
                                let p = String::from_utf8_lossy(&m.payload).to_string();
                                let frame =
                                    json!({"op":"msg","subject":m.subject.as_str(),"payload":p})
                                        .to_string();
                                if tx2.send(frame).await.is_err() {
                                    break;
                                }
                            }
                        }));
                    }
                    Err(_) => {
                        let _ = tx.send(err_frame(None, "не удалось подписаться")).await;
                    }
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "неизвестный op")).await;
            }
        }
    }

    for h in subs {
        h.abort();
    }
    info!("Клиент отключился: {}", user);
}

async fn reqmany(
    nats: &Client,
    tx: &mpsc::Sender<String>,
    id: &str,
    subject: String,
    payload: String,
    timeout_ms: u64,
) -> Result<()> {
    let inbox = nats.new_inbox();
    let mut sub = nats.subscribe(inbox.clone()).await?;
    nats.publish_with_reply(subject, inbox, payload.into()).await?;
    let per = Duration::from_millis(timeout_ms);
    loop {
        match tokio::time::timeout(per, sub.next()).await {
            Ok(Some(m)) => {
                let p = String::from_utf8_lossy(&m.payload).to_string();
                let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string()).await;
            }
            _ => break, // тишина/конец — завершаем (reply_end шлёт вызывающий)
        }
    }
    Ok(())
}

async fn verify_token(nats: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = tokio::time::timeout(
        Duration::from_secs(3),
        nats.request(IDENTITY_VERIFY, req.into()),
    )
    .await
    .map_err(|_| anyhow!("таймаут верификации токена"))?
    .context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow!("identity вернул ok без user"))
    } else {
        Err(anyhow!(resp.error.unwrap_or_else(|| "невалидный токен".into())))
    }
}

/// Одиночный request/reply → отдельным таском (не блокирует цикл чтения).
fn spawn_req(
    nats: Arc<Client>,
    tx: mpsc::Sender<String>,
    id: String,
    subject: String,
    payload: String,
    timeout_ms: u64,
) {
    tokio::spawn(async move {
        let fut = nats.request(subject, payload.into());
        match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
            Ok(Ok(reply)) => {
                let p = String::from_utf8_lossy(&reply.payload).to_string();
                let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string()).await;
            }
            _ => {
                let _ = tx.send(err_frame(Some(&id), "нет ответа / таймаут")).await;
            }
        }
    });
}

fn err_frame(id: Option<&str>, msg: &str) -> String {
    match id {
        Some(i) => json!({"op":"err","id":i,"error":msg}).to_string(),
        None => json!({"op":"err","error":msg}).to_string(),
    }
}

// ── права (изоляция «людей») — чистые функции, покрыты тестами ────────────────

/// Web использует FNV-1a/32 по UTF-16 code units, затем снимает знаковый бит.
/// Сохраняем этот id на wire, пока Web и desktop не перейдут на адресные topics.
fn web_user_id(user: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for unit in user.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    (hash >> 1).to_string()
}

/// Desktop использует FNV-1a/64 по UTF-8 и оставляет младшие 48 бит.
fn desktop_user_id(user: &str) -> String {
    let mut hash = 1_469_598_103_934_665_603_u64;
    for byte in user.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    let id = hash & ((1_u64 << 48) - 1);
    if id == 0 {
        "1".to_string()
    } else {
        id.to_string()
    }
}

fn is_own_ephemeral_subject(user: &str, prefix: &str, subject: &str) -> bool {
    subject == format!("{prefix}{}", web_user_id(user))
        || subject == format!("{prefix}{}", desktop_user_id(user))
}

fn is_concrete_typing_subject(subject: &str) -> bool {
    subject.strip_prefix("msg.typing.").is_some_and(|id| {
        // Групповой typing веб-клиента адресован chat-id вида "-<digits>"
        // (FNV с ведущим минусом); 1-на-1 — просто <digits>.
        let digits = id.strip_prefix('-').unwrap_or(id);
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// Привязывает actor-поля к уже проверенному WebSocket/TCP соединению. Клиент
/// может прислать устаревший или поддельный `from`/`token`, но на NATS попадут
/// только значения текущей авторизованной сессии.
fn bind_client_payload(user: &str, token: &str, subject: &str, payload: &str) -> Result<String> {
    let mut value: Value = serde_json::from_str(payload).context("payload: битый json")?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("payload должен быть JSON-объектом"))?;

    if GATEWAY_EVENT_SUBJECTS.contains(&subject) {
        if subject == "msg.chat.send" {
            let kind = object
                .get("payload")
                .and_then(|payload| payload.get("content"))
                .and_then(|content| content.get("kind"))
                .and_then(Value::as_str);
            if !matches!(kind, Some("encrypted" | "group_encrypted")) {
                return Err(anyhow!(
                    "plaintext msg.chat.send запрещён: E2E-сообщение не отправлено"
                ));
            }
        }

        // В sealed 1-на-1 реальный sender находится внутри Olm ciphertext. Пустой
        // `from` сохраняем только для этого wire-варианта; plaintext, group и
        // прочие события получают явного actor из авторизованной сессии.
        let sealed_direct = subject == "msg.chat.send"
            && object.get("from").and_then(Value::as_str) == Some("")
            && object
                .get("payload")
                .and_then(|payload| payload.get("content"))
                .and_then(|content| content.get("kind"))
                .and_then(Value::as_str)
                == Some("encrypted")
            && object
                .get("payload")
                .and_then(|payload| payload.get("to"))
                .and_then(Value::as_str)
                .is_some_and(|to| to.contains('@'));
        object.insert("token".into(), Value::String(token.to_string()));
        if !sealed_direct {
            object.insert("from".into(), Value::String(user.to_string()));
        }
    } else if GATEWAY_TOKEN_REQUEST_SUBJECTS.contains(&subject) {
        object.insert("token".into(), Value::String(token.to_string()));
    } else if subject.starts_with("msg.typing.") || subject.starts_with("presence.") {
        object.insert("from".into(), Value::String(user.to_string()));
    }

    serde_json::to_string(&value).context("payload: не удалось сериализовать")
}

/// На что можно ПОДПИСАТЬСЯ: только свои пользовательские инбоксы (включая
/// групповой mesh-инбокс `call.user.gcall:<self>`) и эфемерные typing/presence.
/// NATS reply inbox создаёт и обслуживает только gateway.
fn allowed_sub(user: &str, subject: &str) -> bool {
    subject == msg_inbox(user)
        || subject == call_inbox(user)
        || subject == call_inbox(&format!("gcall:{user}"))
        // Групповой typing: подписка на msg.typing.<chatId> (эфемерный индикатор
        // «печатает…»). Симметрично publish (is_concrete_typing_subject уже
        // открыт). Утечка минимальна: только факт набора для известного chatId,
        // без содержимого; сообщения по-прежнему изолированы инбоксами.
        || is_concrete_typing_subject(subject)
        || subject == "presence.*"
}

/// Что можно ПУБЛИКОВАТЬ (fire-and-forget).
fn allowed_pub(user: &str, subject: &str) -> bool {
    GATEWAY_ALLOWED_PUBLISH.contains(&subject)
        || is_concrete_typing_subject(subject)
        || is_own_ephemeral_subject(user, "presence.", subject)
}

/// Что можно запросить (request / reqmany).
fn allowed_req(_user: &str, subject: &str) -> bool {
    GATEWAY_ALLOWED_REQUEST.contains(&subject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_bursts_then_refills() {
        let mut bucket = TokenBucket::new(3.0, 1.0);
        let t0 = Instant::now();
        assert!(bucket.try_take_at(t0));
        assert!(bucket.try_take_at(t0));
        assert!(bucket.try_take_at(t0));
        assert!(!bucket.try_take_at(t0), "всплеск исчерпан");
        assert!(!bucket.try_take_at(t0 + Duration::from_millis(500)));
        assert!(bucket.try_take_at(t0 + Duration::from_millis(1100)), "через секунду — один токен");
        assert!(!bucket.try_take_at(t0 + Duration::from_millis(1100)));
        // Долгая пауза не копит больше capacity
        assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
        assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
        assert!(bucket.try_take_at(t0 + Duration::from_secs(60)));
        assert!(!bucket.try_take_at(t0 + Duration::from_secs(60)));
    }

    #[test]
    fn session_rate_classifies_subjects() {
        let mut rate = SessionRate {
            messages: TokenBucket::new(1.0, 0.0),
            uploads: TokenBucket::new(1.0, 0.0),
            requests: TokenBucket::new(1.0, 0.0),
        };
        assert!(rate.allow("msg.chat.send"));
        assert!(!rate.allow("msg.chat.edit"), "сообщения делят одну корзину");
        assert!(rate.allow("file.upload.chunk"));
        assert!(!rate.allow("file.upload.complete"));
        assert!(rate.allow("identity.user.search"));
        assert!(!rate.allow("group.list"));
    }

    #[test]
    fn sub_allows_only_own_inboxes() {
        let web_id = web_user_id("alice@local");
        let desktop_id = desktop_user_id("alice@local");
        assert_eq!(web_id, "1050889428");
        assert_eq!(desktop_id, "84775232636990");
        assert!(allowed_sub("alice@local", "msg.user.alice@local"));
        assert!(allowed_sub("alice@local", "call.user.alice@local"));
        assert!(allowed_sub("alice@local", &format!("msg.typing.{web_id}")));
        assert!(allowed_sub(
            "alice@local",
            &format!("msg.typing.{desktop_id}")
        ));
        assert!(allowed_sub("alice@local", "presence.*"));
    }

    #[test]
    fn sub_rejects_mallory_wildcards_and_private_inboxes() {
        for subject in [
            ">",
            "*",
            "_INBOX.>",
            "_INBOX.abc123",
            "msg.user.>",
            "msg.user.*",
            "msg.user.bob@local",
            "call.user.*",
            "call.user.bob@local",
            "msg.>",
            "msg.sync.response",
            "msg.typing.*",
            "msg.typing.>",
            "presence.>",
            "presence.123",
        ] {
            assert!(!allowed_sub("alice@local", subject), "allowed {subject}");
        }
        // Групповой typing: подписка на КОНКРЕТНЫЙ msg.typing.<id> теперь
        // разрешена всем (эфемерный индикатор набора; см. allowed_sub) —
        // включая чужой 1-на-1 id и групповой "-<digits>". Раньше блокировалось.
        let bob_web_id = web_user_id("bob@local");
        assert!(allowed_sub("alice@local", &format!("msg.typing.{bob_web_id}")));
        assert!(allowed_sub("alice@local", "msg.typing.-123456"));
    }

    #[test]
    fn pub_allows_send_denies_arbitrary() {
        assert!(allowed_pub("alice@local", "msg.chat.send"));
        assert!(allowed_pub("alice@local", "call.signal"));
        assert!(allowed_pub("alice@local", "msg.typing.5"));
        assert!(allowed_pub(
            "alice@local",
            &format!("presence.{}", web_user_id("alice@local"))
        ));
        assert!(allowed_pub(
            "alice@local",
            &format!("presence.{}", desktop_user_id("alice@local"))
        ));
        assert!(!allowed_pub("alice@local", "msg.typing.*"));
        assert!(!allowed_pub("alice@local", "msg.typing.>"));
        assert!(!allowed_pub("alice@local", "presence.*"));
        assert!(!allowed_pub(
            "alice@local",
            &format!("presence.{}", web_user_id("bob@local"))
        ));
        assert!(!allowed_pub("alice@local", "msg.user.bob@local"));
        assert!(!allowed_pub("alice@local", "identity.token.issue"));
        assert!(!allowed_pub("alice@local", "anything.else"));
    }

    #[test]
    fn req_allows_known_denies_unknown() {
        assert!(allowed_req("alice@local", "identity.token.issue"));
        assert!(allowed_req("alice@local", "identity.user.register"));
        assert!(allowed_req("alice@local", "identity.email.confirm"));
        assert!(allowed_req("alice@local", "identity.server.info"));
        assert!(allowed_req("alice@local", "identity.telegram.confirm"));
        assert!(allowed_req("alice@local", "identity.register.status"));
        assert!(allowed_req("alice@local", "identity.user.twofa"));
        assert!(allowed_req("alice@local", "msg.sync.request"));
        assert!(allowed_req("alice@local", "group.create"));
        assert!(!allowed_req("alice@local", "msg.user.bob@local"));
        assert!(!allowed_req("alice@local", "something.random"));
    }

    #[test]
    fn payload_actor_and_token_are_bound_to_authenticated_session() {
        let payload = json!({
            "id": "00000000-0000-7000-8000-000000000001",
            "from": "victim@local",
            "ts": 1,
            "token": "victim-token",
            "payload": {
                "to": "group-id",
                "content": {
                    "kind": "group_encrypted",
                    "ciphertext": "ciphertext",
                    "group": "group-id",
                    "sender_identity": "curve25519"
                }
            }
        })
        .to_string();
        let bound =
            bind_client_payload("mallory@local", "mallory-token", "msg.chat.send", &payload)
                .unwrap();
        let value: Value = serde_json::from_str(&bound).unwrap();
        assert_eq!(value["from"], "mallory@local");
        assert_eq!(value["token"], "mallory-token");

        let group = bind_client_payload(
            "mallory@local",
            "mallory-token",
            "group.create",
            r#"{"token":"victim-token","name":"x","members":[]}"#,
        )
        .unwrap();
        let group: Value = serde_json::from_str(&group).unwrap();
        assert_eq!(group["token"], "mallory-token");

        let typing = bind_client_payload(
            "mallory@local",
            "mallory-token",
            "msg.typing.123",
            r#"{"from":"victim@local","to":"bob@local"}"#,
        )
        .unwrap();
        let typing: Value = serde_json::from_str(&typing).unwrap();
        assert_eq!(typing["from"], "mallory@local");
    }

    #[test]
    fn sealed_sender_is_preserved_only_for_encrypted_direct_messages() {
        let event = |to: &str, kind: &str| {
            json!({
                "id": "00000000-0000-7000-8000-000000000002",
                "from": "",
                "ts": 1,
                "token": "stale",
                "payload": {"to": to, "content": {"kind": kind, "ciphertext": "x"}}
            })
            .to_string()
        };

        let direct = bind_client_payload(
            "alice@local",
            "fresh",
            "msg.chat.send",
            &event("bob@local", "encrypted"),
        )
        .unwrap();
        let direct: Value = serde_json::from_str(&direct).unwrap();
        assert_eq!(direct["from"], "");
        assert_eq!(direct["token"], "fresh");

        let group_target = event("group-uuid", "encrypted");
        let bound =
            bind_client_payload("alice@local", "fresh", "msg.chat.send", &group_target).unwrap();
        let bound: Value = serde_json::from_str(&bound).unwrap();
        assert_eq!(bound["from"], "alice@local");
    }

    #[test]
    fn plaintext_messages_are_rejected_fail_closed() {
        for kind in ["text", "photo", "file", "poll"] {
            let payload = json!({
                "id": "00000000-0000-7000-8000-000000000003",
                "from": "alice@local",
                "ts": 1,
                "token": "fresh",
                "payload": {"to": "bob@local", "content": {"kind": kind, "text": "secret"}}
            })
            .to_string();
            let error = bind_client_payload(
                "alice@local",
                "fresh",
                "msg.chat.send",
                &payload,
            )
            .unwrap_err();
            assert!(error.to_string().contains("plaintext"));
        }
    }
}
