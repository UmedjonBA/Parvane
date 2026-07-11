// Parvane gateway: единственная точка входа клиентов в шину. Клиент говорит с
// gateway по WebSocket (JSON-кадры), gateway верифицирует JWT и пропускает
// только в СВОИ subject'ы пользователя. Так изоляция «людей» держится на
// gateway, а не на NATS-правах (где все клиенты были одним логином `client`).
// Это же — фундамент под будущий мобильный/push-транспорт.
use anyhow::{anyhow, Context, Result};
use async_nats::Client;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

use parvane_types::{
    topics::{call_inbox, msg_inbox, IDENTITY_VERIFY},
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

    let bind = env("PARVANE_GATEWAY_BIND", "0.0.0.0:9222");
    let nats_url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    let user = env("PARVANE_NATS_USER", "gateway");
    let pass = std::env::var("PARVANE_NATS_PASS").unwrap_or_default();

    let mut opts = async_nats::ConnectOptions::new();
    if !pass.is_empty() {
        opts = opts.user_and_password(user, pass);
    }
    let nats = opts.connect(&nats_url).await.context("подключение к NATS")?;
    let nats = Arc::new(nats);
    info!("NATS подключён: {}", nats_url);

    let listener = TcpListener::bind(&bind).await.context("bind WS")?;
    info!("Gateway слушает WebSocket на {}", bind);

    loop {
        let (stream, peer) = listener.accept().await?;
        let nats = nats.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, nats).await {
                warn!("соединение {}: {}", peer, e);
            }
        });
    }
}

async fn handle_conn(stream: TcpStream, nats: Arc<Client>) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .context("WS handshake")?;
    let (mut write, mut read) = ws.split();

    // ── 1) auth: первый осмысленный кадр обязан быть {op:"auth", token} ──
    let user = loop {
        let Some(msg) = read.next().await else {
            return Ok(()); // закрыто до auth
        };
        let text = match msg? {
            WsMessage::Text(t) => t,
            WsMessage::Close(_) => return Ok(()),
            _ => continue, // ping/pong/binary до auth — игнор
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if v["op"] != "auth" {
            let _ = write
                .send(WsMessage::Text(
                    json!({"op":"auth_err","error":"нужен auth первым кадром"}).to_string(),
                ))
                .await;
            return Ok(());
        }
        let token = v["token"].as_str().unwrap_or("");
        match verify_token(&nats, token).await {
            Ok(u) => {
                write
                    .send(WsMessage::Text(
                        json!({"op":"auth_ok","user":u}).to_string(),
                    ))
                    .await?;
                break u;
            }
            Err(e) => {
                let _ = write
                    .send(WsMessage::Text(
                        json!({"op":"auth_err","error":e.to_string()}).to_string(),
                    ))
                    .await;
                return Ok(());
            }
        }
    };
    info!("Клиент авторизован: {}", user);

    // ── 2) канал наружу + writer-таск (единственный писатель в WS-sink) ──
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if write.send(WsMessage::Text(s)).await.is_err() {
                break;
            }
        }
    });

    let mut subs: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    // ── 3) главный цикл: pub / req / sub с проверкой прав ──
    while let Some(msg) = read.next().await {
        let text = match msg {
            Ok(WsMessage::Text(t)) => t,
            Ok(WsMessage::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
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
                    let _ = tx.send(err_frame(Some(&id), "request к этому subject запрещён"));
                    continue;
                }
                // Отдельным таском, чтобы долгий request не блокировал цикл чтения.
                let nats2 = nats.clone();
                let tx2 = tx.clone();
                tokio::spawn(async move {
                    let fut = nats2.request(subject, payload.into());
                    match tokio::time::timeout(Duration::from_millis(timeout), fut).await {
                        Ok(Ok(reply)) => {
                            let p = String::from_utf8_lossy(&reply.payload).to_string();
                            let _ = tx2
                                .send(json!({"op":"reply","id":id,"payload":p}).to_string());
                        }
                        _ => {
                            let _ = tx2.send(err_frame(Some(&id), "нет ответа / таймаут"));
                        }
                    }
                });
                // NB: file.download.request отдаёт файл НЕСКОЛЬКИМИ ответами
                // (requestMany). Здесь возвращается только первый. Полноценный
                // стриминг чанков — отдельный op "reqmany" на этапе врезки клиента.
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
                                let frame = json!({
                                    "op":"msg","subject":m.subject.as_str(),"payload":p
                                })
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

    // ── 4) уборка ──
    for h in subs {
        h.abort();
    }
    drop(tx);
    let _ = writer.await;
    info!("Клиент отключился: {}", user);
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

fn err_frame(id: Option<&str>, msg: &str) -> String {
    match id {
        Some(i) => json!({"op":"err","id":i,"error":msg}).to_string(),
        None => json!({"op":"err","error":msg}).to_string(),
    }
}

// ── права (изоляция «людей») — чистые функции, покрыты тестами ────────────────

/// На что пользователю можно ПОДПИСАТЬСЯ. Только свои инбоксы + свои reply +
/// эфемерные typing/presence (без пользовательского контента). Чужой
/// `msg.user.*`/`call.user.*` — запрещён.
fn allowed_sub(user: &str, subject: &str) -> bool {
    subject == msg_inbox(user)
        || subject == call_inbox(user)
        || subject.starts_with("_INBOX.")
        || subject.starts_with("msg.typing.")
        || subject.starts_with("presence.")
}

/// Что можно ПУБЛИКОВАТЬ (fire-and-forget). Запросы request/reply — через req.
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

/// Что можно запросить (request/reply).
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
        // Ядро изоляции: alice не может слушать инбокс bob.
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
        assert!(!allowed_pub("alice@local", "identity.token.issue")); // это req, не pub
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
