mod calls;

use anyhow::{Context, Result};
use async_nats::Client;
use calls::{is_terminal, next_status};
use futures::StreamExt;
use parvane_types::{
    CallHistoryResponse, CallMedia, CallRecord, CallSignal, CallSignalPayload, ParvaneEvent,
    VerifyRequest, VerifyResponse,
    topics::{CALL_HISTORY_REQUEST, CALL_HISTORY_RESPONSE, CALL_SIGNAL, call_inbox},
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

    let nc = async_nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let mut signal_sub = nc.subscribe(CALL_SIGNAL).await?;
    let mut history_sub = nc.subscribe(CALL_HISTORY_REQUEST).await?;

    info!("Call шард запущен. Слушаю: {}, {}", CALL_SIGNAL, CALL_HISTORY_REQUEST);

    loop {
        tokio::select! {
            Some(msg) = signal_sub.next()  => handle_signal(&nc, &pool, msg).await,
            Some(msg) = history_sub.next() => handle_history(&nc, &pool, msg).await,
        }
    }
}

// ── auth ─────────────────────────────────────────────────────────────────────

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc
        .request("identity.token.verify", req.into())
        .await
        .context("запрос к identity")?;
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

/// Обновить запись звонка по сигналу. Invite создаёт запись, остальные сигналы
/// двигают статус (см. [`next_status`]). ICE ничего не пишет.
async fn record_signal(
    pool: &SqlitePool,
    from: &str,
    to: &str,
    signal: &CallSignal,
    now: i64,
) -> Result<()> {
    let call_id = signal.call_id().to_string();

    if let CallSignal::Invite { media, .. } = signal {
        sqlx::query(
            "INSERT OR IGNORE INTO calls (id, caller, callee, media, status, started_at)
             VALUES (?, ?, ?, ?, 'ringing', ?)",
        )
        .bind(&call_id)
        .bind(from)
        .bind(to)
        .bind(media_str(*media))
        .bind(now)
        .execute(pool)
        .await
        .context("создание записи звонка")?;
        return Ok(());
    }

    let current: Option<(String,)> = sqlx::query_as("SELECT status FROM calls WHERE id = ?")
        .bind(&call_id)
        .fetch_optional(pool)
        .await?;
    let current = current.as_ref().map(|(s,)| s.as_str());

    if let Some(new_status) = next_status(current, signal) {
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

async fn fetch_history(pool: &SqlitePool, user: &str) -> Result<Vec<CallRecord>> {
    let rows: Vec<(String, String, String, String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, caller, callee, media, status, started_at, ended_at
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
        .map(|(id, caller, callee, media, status, started_at, ended_at)| CallRecord {
            call_id: id.parse().unwrap_or_default(),
            caller,
            callee,
            media: if media == "video" { CallMedia::Video } else { CallMedia::Audio },
            status,
            started_at,
            ended_at,
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
        nc.publish(reply.clone(), json.clone().into()).await?;
        nc.publish(CALL_HISTORY_RESPONSE, json.into()).await?;

        info!("История звонков для {}: {} записей", user, count);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_history: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_types::CallMedia;
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

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
        CallSignal::Invite { call_id: id, media: CallMedia::Audio, sdp: "offer".into() }
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
        record_signal(&pool, "bob@local", "alice@local", &CallSignal::Answer { call_id: id, sdp: "ans".into() }, 2).await.unwrap();
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
        record_signal(&pool, "alice@local", "bob@local", &CallSignal::Ice { call_id: id, candidate: "c".into() }, 1).await.unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM calls").fetch_one(&pool).await.unwrap();
        assert_eq!(count.0, 0);
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
