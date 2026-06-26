use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    DeliveredPayload, ParvaneEvent, ReadPayload, SendPayload, StoredMessage, SyncRequestPayload,
    SyncResponsePayload, VerifyRequest, VerifyResponse,
    topics::{
        IDENTITY_VERIFY, MSG_DELIVERED, MSG_READ, MSG_SEND, MSG_SYNC_REQUEST, MSG_SYNC_RESPONSE,
    },
};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};
use uuid::Uuid;

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
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./messenger.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url)
        .await
        .context("подключение к SQLite")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let nc = async_nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    let mut send_sub = nc.subscribe(MSG_SEND).await?;
    let mut read_sub = nc.subscribe(MSG_READ).await?;
    let mut sync_sub = nc.subscribe(MSG_SYNC_REQUEST).await?;

    info!(
        "Messenger шард запущен. Слушаю: {}, {}, {}",
        MSG_SEND, MSG_READ, MSG_SYNC_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = send_sub.next() => {
                handle_send(&nc, &pool, msg).await;
            }
            Some(msg) = read_sub.next() => {
                handle_read(&nc, &pool, msg).await;
            }
            Some(msg) = sync_sub.next() => {
                handle_sync(&nc, &pool, msg).await;
            }
        }
    }
}

// ── auth helper ───────────────────────────────────────────────────────────────

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc
        .request(IDENTITY_VERIFY, req.into())
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

// ── доменная логика (тестируемая, без NATS) ───────────────────────────────────

/// Проверка от подмены: subject JWT должен совпадать с заявленным `from`.
fn validate_sender(jwt_sub: &str, claimed_from: &str) -> Result<()> {
    if jwt_sub != claimed_from {
        anyhow::bail!("JWT sub '{}' не совпадает с from '{}'", jwt_sub, claimed_from);
    }
    Ok(())
}

/// Сохранить сообщение. Идемпотентно по `id` (INSERT OR IGNORE).
async fn store_message(pool: &SqlitePool, ev: &ParvaneEvent<SendPayload>, now: i64) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO messages (id, from_user, to_user, text, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ev.id.to_string())
    .bind(&ev.from)
    .bind(&ev.payload.to)
    .bind(&ev.payload.text)
    .bind(ev.ts)
    .bind(now)
    .execute(pool)
    .await
    .context("сохранение сообщения")?;
    Ok(())
}

/// Зафиксировать прочтение. Идемпотентно по паре (message_id, reader).
async fn store_read_receipt(
    pool: &SqlitePool,
    message_id: &str,
    reader: &str,
    now: i64,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO read_receipts (message_id, reader, ts) VALUES (?, ?, ?)")
        .bind(message_id)
        .bind(reader)
        .bind(now)
        .execute(pool)
        .await
        .context("сохранение read receipt")?;
    Ok(())
}

/// Сообщения, адресованные `user`, с `id` строго больше `last_seen_id`.
/// UUID v7 лексикографически упорядочен по времени, поэтому сравнение строк
/// эквивалентно сравнению по времени создания.
async fn fetch_missed(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
) -> Result<Vec<StoredMessage>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, from_user, to_user, text, ts
         FROM messages
         WHERE to_user = ? AND id > ?
         ORDER BY id
         LIMIT 100",
    )
    .bind(user)
    .bind(last_seen_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, from, to, text, ts)| StoredMessage {
            id: id.parse().unwrap_or(Uuid::nil()),
            from,
            to,
            text,
            ts,
        })
        .collect())
}

// ── msg.chat.send ─────────────────────────────────────────────────────────────

async fn handle_send(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<SendPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.send")?;

        let sender = verify_token(nc, &event.token).await?;
        validate_sender(&sender, &event.from)?;

        store_message(pool, &event, now_unix()).await?;
        info!("Сообщение сохранено: {} → {} ({})", event.from, event.payload.to, event.id);

        let delivered = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: DeliveredPayload { message_id: event.id },
        };
        nc.publish(MSG_DELIVERED, serde_json::to_vec(&delivered)?.into()).await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_send: {}", e);
    }
}

// ── msg.chat.read ─────────────────────────────────────────────────────────────

async fn handle_read(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<ReadPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.read")?;

        let reader = verify_token(nc, &event.token).await?;
        store_read_receipt(pool, &event.payload.message_id.to_string(), &reader, now_unix()).await?;

        info!("Read receipt: {} прочитал {}", reader, event.payload.message_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_read: {}", e);
    }
}

// ── msg.sync.request ──────────────────────────────────────────────────────────

async fn handle_sync(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("sync: нет reply-топика, игнорирую");
        return;
    };

    let result = async {
        let event: ParvaneEvent<SyncRequestPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.sync.request")?;

        let user = verify_token(nc, &event.token).await?;
        let last_id = &event.payload.last_seen_id;
        let messages = fetch_missed(pool, &user, last_id).await?;

        let count = messages.len();
        let resp = ParvaneEvent {
            id: Uuid::now_v7(),
            from: "messenger".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: SyncResponsePayload { messages },
        };

        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.clone().into()).await?;
        nc.publish(MSG_SYNC_RESPONSE, json.into()).await?;

        info!("Sync для {}: {} сообщений после '{}'", user, count, last_id);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_sync: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_types::SendPayload;
    use sqlx::sqlite::SqlitePoolOptions;

    fn send_event(id: &str, from: &str, to: &str, text: &str) -> ParvaneEvent<SendPayload> {
        ParvaneEvent {
            id: id.parse().unwrap(),
            from: from.into(),
            ts: 1_000_000,
            token: "tok".into(),
            payload: SendPayload { to: to.into(), text: text.into() },
        }
    }

    /// In-memory SQLite с одной живой connection (иначе каждый коннект — своя
    /// пустая база) и применёнными миграциями.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    // ── чистая проверка отправителя ──

    #[test]
    fn validate_sender_accepts_match() {
        assert!(validate_sender("alice@local", "alice@local").is_ok());
    }

    #[test]
    fn validate_sender_rejects_spoof() {
        let err = validate_sender("alice@local", "mallory@evil").unwrap_err();
        assert!(err.to_string().contains("не совпадает"));
    }

    // ── хранение и выборка сообщений ──

    #[tokio::test]
    async fn store_and_fetch_message() {
        let pool = test_pool().await;
        let ev = send_event(
            "00000000-0000-7000-8000-000000000001",
            "alice@local",
            "bob@local",
            "привет",
        );
        store_message(&pool, &ev, 1).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000")
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].text, "привет");
        assert_eq!(missed[0].from, "alice@local");
    }

    #[tokio::test]
    async fn fetch_missed_filters_by_recipient() {
        let pool = test_pool().await;
        store_message(
            &pool,
            &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "для боба"),
            1,
        )
        .await
        .unwrap();

        // получатель carol не должен видеть сообщение для bob
        let missed = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000")
            .await
            .unwrap();
        assert!(missed.is_empty());
    }

    #[tokio::test]
    async fn fetch_missed_respects_last_seen_id() {
        let pool = test_pool().await;
        let older = "00000000-0000-7000-8000-000000000001";
        let newer = "00000000-0000-7000-8000-000000000002";
        store_message(&pool, &send_event(older, "alice@local", "bob@local", "первое"), 1)
            .await
            .unwrap();
        store_message(&pool, &send_event(newer, "alice@local", "bob@local", "второе"), 2)
            .await
            .unwrap();

        // last_seen = older → возвращается только newer
        let missed = fetch_missed(&pool, "bob@local", older).await.unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].text, "второе");
    }

    #[tokio::test]
    async fn store_message_is_idempotent() {
        let pool = test_pool().await;
        let ev = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "раз");
        store_message(&pool, &ev, 1).await.unwrap();
        // повторная доставка того же id (даже с другим текстом) не создаёт дубликат
        let dup = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "два");
        store_message(&pool, &dup, 2).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000")
            .await
            .unwrap();
        assert_eq!(missed.len(), 1, "дубликата быть не должно");
        assert_eq!(missed[0].text, "раз", "первая запись сохраняется");
    }

    // ── read receipts ──

    #[tokio::test]
    async fn read_receipt_stored_once() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000aa";
        store_read_receipt(&pool, mid, "bob@local", 5).await.unwrap();
        store_read_receipt(&pool, mid, "bob@local", 6).await.unwrap(); // идемпотентно

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM read_receipts WHERE message_id = ? AND reader = ?")
                .bind(mid)
                .bind("bob@local")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count.0, 1);
    }
}
