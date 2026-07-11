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
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use parvane_types::{
    topics::{call_inbox, msg_inbox, IDENTITY_ISSUE, IDENTITY_REGISTER, IDENTITY_VERIFY},
    VerifyRequest, VerifyResponse,
};

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

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

    // TCP-листенер (нативный клиент).
    let tcp = TcpListener::bind(&tcp_bind).await.context("bind TCP")?;
    info!("Gateway TCP на {}", tcp_bind);
    {
        let nats = nats.clone();
        tokio::spawn(async move {
            loop {
                match tcp.accept().await {
                    Ok((stream, peer)) => {
                        let nats = nats.clone();
                        tokio::spawn(async move {
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
        let nats = nats.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_ws(stream, nats).await {
                warn!("ws {}: {}", peer, e);
            }
        });
    }
}

// ── адаптеры транспорта: превращают соединение в пару каналов кадров-строк ─────

async fn handle_tcp(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(rd).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            if in_tx.send(line).is_err() {
                break;
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
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
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .context("WS handshake")?;
    let (mut write, mut read) = ws.split();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(m) = read.next().await {
            match m {
                Ok(WsMessage::Text(t)) => {
                    if in_tx.send(t).is_err() {
                        break;
                    }
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
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
    mut in_rx: mpsc::UnboundedReceiver<String>,
    tx: mpsc::UnboundedSender<String>,
    nats: Arc<Client>,
) {
    // 1) pre-auth: до авторизации разрешены ТОЛЬКО bootstrap-запросы (логин и
    // регистрация — иначе получить токен через gateway было бы невозможно).
    // Всё остальное — после auth с валидным JWT.
    let user = loop {
        let Some(text) = in_rx.recv().await else {
            return; // закрыто до auth
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match v["op"].as_str().unwrap_or("") {
            "auth" => match verify_token(&nats, v["token"].as_str().unwrap_or("")).await {
                Ok(u) => {
                    let _ = tx.send(json!({"op":"auth_ok","user":u}).to_string());
                    break u;
                }
                Err(e) => {
                    let _ = tx.send(json!({"op":"auth_err","error":e.to_string()}).to_string());
                    return;
                }
            },
            "req" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if subject == IDENTITY_ISSUE || subject == IDENTITY_REGISTER {
                    spawn_req(
                        nats.clone(),
                        tx.clone(),
                        v["id"].as_str().unwrap_or("").to_string(),
                        subject,
                        v["payload"].as_str().unwrap_or("").to_string(),
                        v["timeout_ms"].as_u64().unwrap_or(3000),
                    );
                } else {
                    let _ = tx.send(err_frame(v["id"].as_str(), "нужна авторизация"));
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "нужна авторизация"));
            }
        }
    };
    info!("Клиент авторизован: {}", user);

    let mut subs: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    // 2) основной цикл
    while let Some(text) = in_rx.recv().await {
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(err_frame(None, "битый json"));
                continue;
            }
        };
        match v["op"].as_str().unwrap_or("") {
            "pub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let payload = v["payload"].as_str().unwrap_or("").to_string();
                if allowed_pub(&user, &subject) {
                    let _ = nats.publish(subject, payload.into()).await;
                } else {
                    let _ = tx.send(err_frame(None, "publish в этот subject запрещён"));
                }
            }
            "req" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let payload = v["payload"].as_str().unwrap_or("").to_string();
                let timeout = v["timeout_ms"].as_u64().unwrap_or(3000);
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён"));
                    continue;
                }
                spawn_req(nats.clone(), tx.clone(), id, subject, payload, timeout);
            }
            // Множественные ответы на один запрос (chunked download): собираем
            // все ответы на приватный inbox до тишины (timeout между ответами)
            // и завершаем reply_end.
            "reqmany" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let payload = v["payload"].as_str().unwrap_or("").to_string();
                let timeout = v["timeout_ms"].as_u64().unwrap_or(5000);
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён"));
                    continue;
                }
                let nats2 = nats.clone();
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = reqmany(&nats2, &tx2, &id, subject, payload, timeout).await {
                        let _ = tx2.send(err_frame(Some(&id), &e.to_string()));
                    }
                    let _ = tx2.send(json!({"op":"reply_end","id":id}).to_string());
                });
            }
            "sub" => {
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                if !allowed_sub(&user, &subject) {
                    let _ = tx.send(err_frame(None, "подписка на чужой/запрещённый subject"));
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
                                if tx2.send(frame).is_err() {
                                    break;
                                }
                            }
                        }));
                    }
                    Err(_) => {
                        let _ = tx.send(err_frame(None, "не удалось подписаться"));
                    }
                }
            }
            _ => {
                let _ = tx.send(err_frame(None, "неизвестный op"));
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
    tx: &mpsc::UnboundedSender<String>,
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
                let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string());
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
    tx: mpsc::UnboundedSender<String>,
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
                let _ = tx.send(json!({"op":"reply","id":id,"payload":p}).to_string());
            }
            _ => {
                let _ = tx.send(err_frame(Some(&id), "нет ответа / таймаут"));
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

/// На что можно ПОДПИСАТЬСЯ: только свои инбоксы + свои reply + эфемерные
/// typing/presence. Чужой `msg.user.*`/`call.user.*` — запрещён.
fn allowed_sub(user: &str, subject: &str) -> bool {
    subject == msg_inbox(user)
        || subject == call_inbox(user)
        || subject.starts_with("_INBOX.")
        || subject.starts_with("msg.typing.")
        || subject.starts_with("presence.")
}

/// Что можно ПУБЛИКОВАТЬ (fire-and-forget).
fn allowed_pub(_user: &str, subject: &str) -> bool {
    const OK: &[&str] = &[
        "msg.chat.send",
        "msg.chat.read",
        "msg.chat.edit",
        "msg.chat.delete",
        "msg.chat.react",
        "msg.chat.pin",
        "msg.chat.ack",
        "call.signal",
        "file.upload.chunk",
        "file.upload.complete",
    ];
    OK.contains(&subject)
        || subject.starts_with("msg.typing.")
        || subject.starts_with("presence.")
}

/// Что можно запросить (request / reqmany).
fn allowed_req(_user: &str, subject: &str) -> bool {
    const OK: &[&str] = &[
        "identity.token.issue",
        "identity.user.register",
        "identity.token.verify",
        "identity.user.search",
        "identity.user.setname",
        "identity.user.setavatar",
        "identity.user.setkey",
        "identity.user.resolve",
        "msg.sync.request",
        "file.download.request",
        "file.list.request",
        "group.create",
        "group.addmember",
        "group.removemember",
        "group.list",
        "group.info",
        "call.history.request",
    ];
    OK.contains(&subject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_allows_only_own_inboxes() {
        assert!(allowed_sub("alice@local", "msg.user.alice@local"));
        assert!(allowed_sub("alice@local", "call.user.alice@local"));
        assert!(allowed_sub("alice@local", "_INBOX.abc123"));
        assert!(allowed_sub("alice@local", "msg.typing.999"));
        assert!(allowed_sub("alice@local", "presence.999"));
    }

    #[test]
    fn sub_rejects_other_users_inbox() {
        assert!(!allowed_sub("alice@local", "msg.user.bob@local"));
        assert!(!allowed_sub("alice@local", "call.user.bob@local"));
        assert!(!allowed_sub("alice@local", "msg.>"));
        assert!(!allowed_sub("alice@local", "msg.sync.response"));
    }

    #[test]
    fn pub_allows_send_denies_arbitrary() {
        assert!(allowed_pub("alice@local", "msg.chat.send"));
        assert!(allowed_pub("alice@local", "call.signal"));
        assert!(allowed_pub("alice@local", "msg.typing.5"));
        assert!(!allowed_pub("alice@local", "msg.user.bob@local"));
        assert!(!allowed_pub("alice@local", "identity.token.issue"));
        assert!(!allowed_pub("alice@local", "anything.else"));
    }

    #[test]
    fn req_allows_known_denies_unknown() {
        assert!(allowed_req("alice@local", "identity.token.issue"));
        assert!(allowed_req("alice@local", "identity.user.register"));
        assert!(allowed_req("alice@local", "msg.sync.request"));
        assert!(allowed_req("alice@local", "group.create"));
        assert!(!allowed_req("alice@local", "msg.user.bob@local"));
        assert!(!allowed_req("alice@local", "something.random"));
    }
}
