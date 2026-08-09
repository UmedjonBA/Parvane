mod calls;

use anyhow::{Context, Result};
use async_nats::Client;
use calls::{is_terminal, next_status};
use futures::StreamExt;
use parvane_types::{
    CallHistoryResponse, CallMedia, CallRecord, CallSignal, CallSignalPayload, IceServer,
    IceServersResponse, ParvaneEvent, VerifyRequest, VerifyResponse,
    topics::{CALL_HISTORY_REQUEST, CALL_ICE_REQUEST, CALL_SIGNAL, IDENTITY_VERIFY, call_inbox},
};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

// ── main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("PARVANE_LOG_LEVEL")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    dotenvy::dotenv().ok();

    let nats_url = std::env::var("PARVANE_NATS_URL")
        .unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./call.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url).await.context("подключение к SQLite")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let ice_config = IceConfig::from_env();

    let mut signal_sub = nc.subscribe(CALL_SIGNAL).await?;
    let mut history_sub = nc.subscribe(CALL_HISTORY_REQUEST).await?;
    let mut ice_sub = nc.subscribe(CALL_ICE_REQUEST).await?;

    info!(
        "Call шард запущен. Слушаю: {}, {}, {}",
        CALL_SIGNAL, CALL_HISTORY_REQUEST, CALL_ICE_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = signal_sub.next()  => handle_signal(&nc, &pool, msg).await,
            Some(msg) = history_sub.next() => handle_history(&nc, &pool, msg).await,
            Some(msg) = ice_sub.next()     => handle_ice_request(&nc, &ice_config, msg).await,
        }
    }
}

// ── auth ─────────────────────────────────────────────────────────────────────

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc.request(IDENTITY_VERIFY, req.into()).await.context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

// ── работа с БД (тестируемая) ─────────────────────────────────────────────────

fn media_str(m: CallMedia) -> &'static str {
    match m {
        CallMedia::Audio => "audio",
        CallMedia::Video => "video",
    }
}

fn route_principal(route: &str) -> &str {
    route.strip_prefix("gcall:").unwrap_or(route)
}

/// Проверить, что сигнал идёт между участниками конкретного звонка, и обновить
/// его состояние. Неизвестные `call_id`, replay и сигналы третьей стороны
/// отклоняются до публикации в персональный inbox.
async fn record_signal(
    pool: &SqlitePool,
    from: &str,
    to: &str,
    signal: &CallSignal,
    now: i64,
) -> Result<()> {
    let target = route_principal(to);
    if from.is_empty() || target.is_empty() || from == target {
        anyhow::bail!("некорректные участники звонка");
    }

    if let CallSignal::GroupInvite { group_call_id, participants, .. } = signal {
        let unique: std::collections::HashSet<&str> = participants.iter().map(String::as_str).collect();
        if group_call_id.is_empty() || participants.len() < 2 || participants.len() > 32
            || unique.len() != participants.len() || !unique.contains(from) || !unique.contains(target)
        {
            anyhow::bail!("некорректное групповое приглашение");
        }
        return Ok(());
    }
    if signal.call_id().is_nil() {
        anyhow::bail!("пустой call_id");
    }
    let call_id = signal.call_id().to_string();

    if let CallSignal::Invite { media, sdp, sig, .. } = signal {
        if sdp.is_empty() || sig.is_empty() {
            anyhow::bail!("invite должен содержать подписанный SDP");
        }
        let is_group = to.starts_with("gcall:");
        sqlx::query(
            "INSERT INTO calls (id, caller, callee, media, status, started_at, is_group)
             VALUES (?, ?, ?, ?, 'ringing', ?, ?)",
        )
        .bind(&call_id)
        .bind(from)
        .bind(target)
        .bind(media_str(*media))
        .bind(now)
        .bind(is_group)
        .execute(pool)
        .await
        .context("создание записи звонка")?;
        return Ok(());
    }

    let call: Option<(String, String, String)> =
        sqlx::query_as("SELECT caller, callee, status FROM calls WHERE id = ?")
        .bind(&call_id)
        .fetch_optional(pool)
        .await?;
    let Some((caller, callee, current)) = call else {
        anyhow::bail!("неизвестный call_id");
    };
    let is_caller = from == caller && target == callee;
    let is_callee = from == callee && target == caller;
    if !is_caller && !is_callee {
        anyhow::bail!("сигнал отправлен не участником звонка или не тому получателю");
    }

    match signal {
        CallSignal::Answer { sdp, sig, .. } => {
            if !is_callee || current != "ringing" || sdp.is_empty() || sig.is_empty() {
                anyhow::bail!("недопустимый answer");
            }
        }
        CallSignal::Reject { .. } => {
            if !is_callee || current != "ringing" {
                anyhow::bail!("недопустимый reject");
            }
        }
        CallSignal::Hangup { .. } | CallSignal::Ice { .. } => {
            if current != "ringing" && current != "answered" {
                anyhow::bail!("звонок уже завершён");
            }
        }
        CallSignal::Invite { .. } | CallSignal::GroupInvite { .. } => unreachable!(),
    }

    if let Some(new_status) = next_status(Some(&current), signal) {
        if is_terminal(new_status) {
            sqlx::query("UPDATE calls SET status = ?, ended_at = ? WHERE id = ?")
                .bind(new_status)
                .bind(now)
                .bind(&call_id)
                .execute(pool)
                .await?;
        } else {
            sqlx::query("UPDATE calls SET status = ? WHERE id = ?")
                .bind(new_status)
                .bind(&call_id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

/// Зависшие ringing-звонки (получатель офлайн, hangup не дошёл и т.п.)
/// терминализируются в missed по таймауту — иначе висят вечно.
const STALE_RINGING_SECS: i64 = 120;

async fn terminate_stale_ringing(pool: &SqlitePool, now: i64) -> Result<()> {
    sqlx::query(
        "UPDATE calls SET status = 'missed', ended_at = ?
         WHERE status = 'ringing' AND started_at < ?",
    )
    .bind(now)
    .bind(now - STALE_RINGING_SECS)
    .execute(pool)
    .await?;
    Ok(())
}

async fn fetch_history(pool: &SqlitePool, user: &str) -> Result<Vec<CallRecord>> {
    terminate_stale_ringing(pool, now_unix()).await?;
    let rows: Vec<(String, String, String, String, String, i64, Option<i64>, bool)> = sqlx::query_as(
        "SELECT id, caller, callee, media, status, started_at, ended_at, is_group
         FROM calls
         WHERE caller = ? OR callee = ?
         ORDER BY started_at DESC
         LIMIT 100",
    )
    .bind(user)
    .bind(user)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, caller, callee, media, status, started_at, ended_at, is_group)| CallRecord {
            call_id: id.parse().unwrap_or_default(),
            caller,
            callee,
            media: if media == "video" { CallMedia::Video } else { CallMedia::Audio },
            status,
            started_at,
            ended_at,
            is_group,
        })
        .collect())
}

// ── call.signal ───────────────────────────────────────────────────────────────

async fn handle_signal(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<CallSignalPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в call.signal")?;

        let signer = verify_token(nc, &event.token).await?;
        if signer != event.from {
            anyhow::bail!("JWT sub '{}' не совпадает с from '{}'", signer, event.from);
        }

        let to = event.payload.to.clone();
        let signal = event.payload.signal.clone();

        record_signal(pool, &event.from, &to, &signal, now_unix()).await?;

        // Релеим сигнал в персональный инбокс получателя. `from` = инициатор
        // этого сигнала, `token` пустой (сообщение от сервера).
        let relay = ParvaneEvent {
            id: event.id,
            from: event.from.clone(),
            ts: now_unix(),
            token: String::new(),
            payload: signal.clone(),
        };
        nc.publish(call_inbox(&to), serde_json::to_vec(&relay)?.into()).await?;

        info!(
            "Сигнал {} от {} → {} (call {})",
            signal_name(&signal),
            event.from,
            to,
            signal.call_id()
        );
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_signal: {}", e);
    }
}

fn signal_name(s: &CallSignal) -> &'static str {
    match s {
        CallSignal::Invite { .. } => "invite",
        CallSignal::Answer { .. } => "answer",
        CallSignal::Reject { .. } => "reject",
        CallSignal::Ice { .. } => "ice",
        CallSignal::Hangup { .. } => "hangup",
        CallSignal::GroupInvite { .. } => "group_invite",
    }
}

// ── call.history.request ──────────────────────────────────────────────────────

async fn handle_history(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("history: нет reply-топика");
        return;
    };

    let result = async {
        let event: ParvaneEvent<serde_json::Value> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в call.history.request")?;
        let user = verify_token(nc, &event.token).await?;

        let calls = fetch_history(pool, &user).await?;
        let count = calls.len();

        let resp = ParvaneEvent {
            id: uuid::Uuid::now_v7(),
            from: "call".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: CallHistoryResponse { calls },
        };
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.into()).await?;

        info!("История звонков для {}: {} записей", user, count);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_history: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

// ── call.ice.request ─────────────────────────────────────────────────────────

/// Конфигурация выдачи ICE-серверов. STUN отдаётся всем как есть; для TURN
/// генерируются краткоживущие креды (TURN REST): username = `<expiry>:<user>`,
/// credential = base64(HMAC-SHA1(secret, username)).
struct IceConfig {
    stun_urls: Vec<String>,
    turn_url: Option<String>,
    turn_secret: Option<String>,
    ttl_secs: u64,
}

impl IceConfig {
    fn from_env() -> Self {
        let stun_urls = std::env::var("PARVANE_STUN_URLS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .collect();
        let turn_url = std::env::var("PARVANE_TURN_URL").ok().filter(|v| !v.is_empty());
        let turn_secret = std::env::var("PARVANE_TURN_SECRET").ok().filter(|v| !v.is_empty());
        let ttl_secs = std::env::var("PARVANE_TURN_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);
        Self { stun_urls, turn_url, turn_secret, ttl_secs }
    }

    fn build_response(&self, user: &str, now: i64) -> IceServersResponse {
        let mut ice_servers = Vec::new();
        if !self.stun_urls.is_empty() {
            ice_servers.push(IceServer {
                urls: self.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }
        if let (Some(turn_url), Some(secret)) = (&self.turn_url, &self.turn_secret) {
            let username = format!("{}:{}", now + self.ttl_secs as i64, user);
            let credential = turn_rest_credential(secret, &username);
            ice_servers.push(IceServer {
                urls: vec![turn_url.clone()],
                username: Some(username),
                credential: Some(credential),
            });
        }
        IceServersResponse { ice_servers, ttl_secs: self.ttl_secs }
    }
}

fn turn_rest_credential(secret: &str, username: &str) -> String {
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC принимает ключ любой длины");
    mac.update(username.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

async fn handle_ice_request(nc: &Client, config: &IceConfig, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("ice: нет reply-топика");
        return;
    };

    let result = async {
        let event: ParvaneEvent<serde_json::Value> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в call.ice.request")?;
        let user = verify_token(nc, &event.token).await?;

        let payload = config.build_response(&user, now_unix());
        let servers = payload.ice_servers.len();
        let resp = ParvaneEvent {
            id: uuid::Uuid::now_v7(),
            from: "call".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload,
        };
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.into()).await?;
        info!("ICE-конфигурация для {}: {} серверов", user, servers);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_ice_request: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_types::CallMedia;
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    #[test]
    fn turn_rest_credential_is_stable_hmac_sha1() {
        // Референс посчитан независимо: python hmac/sha1/base64
        assert_eq!(
            turn_rest_credential("north", "1700000000:alice@local"),
            "ng6stooO+WmFmwZcKnSQqroGfRc=",
        );
    }

    #[test]
    fn ice_response_contains_stun_and_ephemeral_turn() {
        let config = IceConfig {
            stun_urls: vec!["stun:stun.example:3478".into()],
            turn_url: Some("turn:turn.example:3478".into()),
            turn_secret: Some("secret".into()),
            ttl_secs: 600,
        };
        let resp = config.build_response("bob@local", 1_700_000_000);
        assert_eq!(resp.ttl_secs, 600);
        assert_eq!(resp.ice_servers.len(), 2);
        let turn = &resp.ice_servers[1];
        assert_eq!(turn.username.as_deref(), Some("1700000600:bob@local"));
        assert_eq!(
            turn.credential.as_deref().unwrap(),
            turn_rest_credential("secret", "1700000600:bob@local"),
        );
    }

    #[test]
    fn ice_response_without_turn_env_is_stun_only() {
        let config = IceConfig {
            stun_urls: vec!["stun:s".into()],
            turn_url: None,
            turn_secret: None,
            ttl_secs: 3600,
        };
        let resp = config.build_response("bob@local", 0);
        assert_eq!(resp.ice_servers.len(), 1);
        assert!(resp.ice_servers[0].username.is_none());
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn invite(id: Uuid) -> CallSignal {
        CallSignal::Invite {
            call_id: id,
            media: CallMedia::Audio,
            sdp: "offer".into(),
            sig: "signature".into(),
        }
    }

    async fn status_of(pool: &SqlitePool, id: &str) -> String {
        let r: (String,) = sqlx::query_as("SELECT status FROM calls WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        r.0
    }

    #[tokio::test]
    async fn full_call_ends() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        let ids = id.to_string();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        assert_eq!(status_of(&pool, &ids).await, "ringing");
        record_signal(&pool, "bob@local", "alice@local", &CallSignal::Answer { call_id: id, sdp: "ans".into(), sig: "signature".into() }, 2).await.unwrap();
        assert_eq!(status_of(&pool, &ids).await, "answered");
        record_signal(&pool, "alice@local", "bob@local", &CallSignal::Hangup { call_id: id }, 3).await.unwrap();
        assert_eq!(status_of(&pool, &ids).await, "ended");
    }

    #[tokio::test]
    async fn unanswered_call_is_missed() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        record_signal(&pool, "alice@local", "bob@local", &CallSignal::Hangup { call_id: id }, 2).await.unwrap();
        assert_eq!(status_of(&pool, &id.to_string()).await, "missed");
    }

    #[tokio::test]
    async fn stale_ringing_terminates_as_missed() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        terminate_stale_ringing(&pool, 1 + STALE_RINGING_SECS + 1).await.unwrap();
        assert_eq!(status_of(&pool, &id.to_string()).await, "missed");

        // Свежий ringing не трогается
        let fresh = Uuid::now_v7();
        let now = 1 + STALE_RINGING_SECS + 2;
        record_signal(&pool, "alice@local", "bob@local", &invite(fresh), now).await.unwrap();
        terminate_stale_ringing(&pool, now + 10).await.unwrap();
        assert_eq!(status_of(&pool, &fresh.to_string()).await, "ringing");
    }

    #[tokio::test]
    async fn rejected_call() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        record_signal(&pool, "bob@local", "alice@local", &CallSignal::Reject { call_id: id, reason: None }, 2).await.unwrap();
        assert_eq!(status_of(&pool, &id.to_string()).await, "rejected");
    }

    #[tokio::test]
    async fn ice_does_not_create_or_change() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        // ICE без существующего звонка ничего не создаёт
        assert!(record_signal(&pool, "alice@local", "bob@local", &CallSignal::Ice { call_id: id, candidate: "c".into() }, 1).await.is_err());
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM calls").fetch_one(&pool).await.unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn signal_requires_original_participants_and_direction() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        let answer = CallSignal::Answer {
            call_id: id,
            sdp: "answer".into(),
            sig: "signature".into(),
        };

        assert!(record_signal(&pool, "mallory@evil", "alice@local", &answer, 2).await.is_err());
        assert!(record_signal(&pool, "alice@local", "bob@local", &answer, 2).await.is_err());
        assert!(record_signal(&pool, "bob@local", "mallory@evil", &answer, 2).await.is_err());
        assert_eq!(status_of(&pool, &id.to_string()).await, "ringing");
    }

    #[tokio::test]
    async fn replay_and_unsigned_sdp_are_rejected() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        record_signal(&pool, "alice@local", "bob@local", &invite(id), 1).await.unwrap();
        assert!(record_signal(&pool, "alice@local", "bob@local", &invite(id), 2).await.is_err());

        let mut unsigned_answer = CallSignal::Answer {
            call_id: id,
            sdp: "answer".into(),
            sig: String::new(),
        };
        assert!(record_signal(&pool, "bob@local", "alice@local", &unsigned_answer, 3).await.is_err());
        if let CallSignal::Answer { sig, .. } = &mut unsigned_answer {
            *sig = "signature".into();
        }
        record_signal(&pool, "bob@local", "alice@local", &unsigned_answer, 4).await.unwrap();
        assert!(record_signal(&pool, "bob@local", "alice@local", &unsigned_answer, 5).await.is_err());
    }

    #[tokio::test]
    async fn history_returns_both_directions() {
        let pool = test_pool().await;
        let id1 = Uuid::now_v7();
        let id2 = Uuid::now_v7();
        // alice звонит bob
        record_signal(&pool, "alice@local", "bob@local", &invite(id1), 1).await.unwrap();
        // carol звонит alice
        record_signal(&pool, "carol@local", "alice@local", &invite(id2), 2).await.unwrap();

        let hist = fetch_history(&pool, "alice@local").await.unwrap();
        assert_eq!(hist.len(), 2, "alice участвует в обоих звонках");

        let bob_hist = fetch_history(&pool, "bob@local").await.unwrap();
        assert_eq!(bob_hist.len(), 1);
    }
}
