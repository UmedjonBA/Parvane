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
    topic_contract::{
        GATEWAY_ALLOWED_PUBLISH, GATEWAY_ALLOWED_REQUEST, GATEWAY_EVENT_SUBJECTS,
        GATEWAY_TOKEN_REQUEST_SUBJECTS,
    },
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
    let (user, auth_token) = loop {
        let Some(text) = in_rx.recv().await else {
            return; // закрыто до auth
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match v["op"].as_str().unwrap_or("") {
            "auth" => match verify_token(&nats, v["token"].as_str().unwrap_or("")).await {
                Ok(u) => {
                    let token = v["token"].as_str().unwrap_or("").to_string();
                    let _ = tx.send(json!({"op":"auth_ok","user":u}).to_string());
                    break (u, token);
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
                            let _ = tx.send(err_frame(None, &e.to_string()));
                        }
                    }
                } else {
                    let _ = tx.send(err_frame(None, "publish в этот subject запрещён"));
                }
            }
            "req" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let subject = v["subject"].as_str().unwrap_or("").to_string();
                let timeout = v["timeout_ms"].as_u64().unwrap_or(3000);
                if !allowed_req(&user, &subject) {
                    let _ = tx.send(err_frame(Some(&id), "request запрещён"));
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
                        let _ = tx.send(err_frame(Some(&id), &e.to_string()));
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
                    let _ = tx.send(err_frame(Some(&id), "request запрещён"));
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
                        let _ = tx.send(err_frame(Some(&id), &e.to_string()));
                        continue;
                    }
                };
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
    subject
        .strip_prefix("msg.typing.")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
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
        || is_own_ephemeral_subject(user, "msg.typing.", subject)
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
        let bob_web_id = web_user_id("bob@local");
        assert!(!allowed_sub(
            "alice@local",
            &format!("msg.typing.{bob_web_id}")
        ));
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
