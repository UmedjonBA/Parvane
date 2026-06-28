use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    DeletePayload, DeliveredPayload, EditPayload, MessageContent, ParvaneEvent, ReadPayload,
    SendPayload, StoredMessage, SyncRequestPayload, SyncResponsePayload, VerifyRequest,
    VerifyResponse,
    topics::{
        IDENTITY_VERIFY, MSG_DELETE, MSG_DELIVERED, MSG_EDIT, MSG_READ, MSG_SEND,
        MSG_SYNC_REQUEST, MSG_SYNC_RESPONSE,
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
    let mut edit_sub = nc.subscribe(MSG_EDIT).await?;
    let mut delete_sub = nc.subscribe(MSG_DELETE).await?;
    let mut sync_sub = nc.subscribe(MSG_SYNC_REQUEST).await?;

    info!(
        "Messenger шард запущен. Слушаю: {}, {}, {}, {}, {}",
        MSG_SEND, MSG_READ, MSG_EDIT, MSG_DELETE, MSG_SYNC_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = send_sub.next() => {
                handle_send(&nc, &pool, msg).await;
            }
            Some(msg) = read_sub.next() => {
                handle_read(&nc, &pool, msg).await;
            }
            Some(msg) = edit_sub.next() => {
                handle_edit(&nc, &pool, msg).await;
            }
            Some(msg) = delete_sub.next() => {
                handle_delete(&nc, &pool, msg).await;
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
/// `content` хранится как JSON `MessageContent`, `kind` — для фильтрации.
async fn store_message(pool: &SqlitePool, ev: &ParvaneEvent<SendPayload>, now: i64) -> Result<()> {
    let content_json = serde_json::to_string(&ev.payload.content).context("сериализация content")?;
    // legacy-колонка `text` объявлена NOT NULL: для Text кладём сам текст, для
    // медиа — пустую строку (источник истины — `content`).
    let legacy_text = match &ev.payload.content {
        MessageContent::Text { text } => text.as_str(),
        _ => "",
    };
    let reply_to = ev.payload.reply_to.map(|u| u.to_string());
    sqlx::query(
        "INSERT OR IGNORE INTO messages
           (id, from_user, to_user, text, kind, content, ts, created_at, reply_to, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ev.id.to_string())
    .bind(&ev.from)
    .bind(&ev.payload.to)
    .bind(legacy_text)
    .bind(ev.payload.content.kind())
    .bind(&content_json)
    .bind(ev.ts)
    .bind(now)
    .bind(reply_to)
    .bind(now)
    .execute(pool)
    .await
    .context("сохранение сообщения")?;
    Ok(())
}

/// Отредактировать текст своего сообщения. Возвращает `true`, если строка
/// действительно принадлежит автору и была обновлена. Бампает `updated_at`.
async fn edit_message(pool: &SqlitePool, message_id: &str, author: &str, text: &str, now: i64) -> Result<bool> {
    let content_json = serde_json::to_string(&MessageContent::Text { text: text.to_string() })?;
    let res = sqlx::query(
        "UPDATE messages
            SET text = ?, kind = 'text', content = ?, edited = 1, updated_at = ?
          WHERE id = ? AND from_user = ? AND deleted = 0",
    )
    .bind(text)
    .bind(&content_json)
    .bind(now)
    .bind(message_id)
    .bind(author)
    .execute(pool)
    .await
    .context("правка сообщения")?;
    Ok(res.rows_affected() > 0)
}

/// Удалить своё сообщение «у всех» (tombstone). Содержимое затирается.
async fn delete_message(pool: &SqlitePool, message_id: &str, author: &str, now: i64) -> Result<bool> {
    let empty = serde_json::to_string(&MessageContent::Text { text: String::new() })?;
    let res = sqlx::query(
        "UPDATE messages
            SET deleted = 1, text = '', kind = 'text', content = ?, updated_at = ?
          WHERE id = ? AND from_user = ?",
    )
    .bind(&empty)
    .bind(now)
    .bind(message_id)
    .bind(author)
    .execute(pool)
    .await
    .context("удаление сообщения")?;
    Ok(res.rows_affected() > 0)
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
    // Бампаем updated_at сообщения, чтобы отправитель увидел прочтение через
    // курсор синка по мутациям (read-галочка ✓✓).
    sqlx::query("UPDATE messages SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(message_id)
        .execute(pool)
        .await
        .context("бамп updated_at при прочтении")?;
    Ok(())
}

/// Сообщения переписки `user` (как входящие `to_user = user`, так и его
/// собственные исходящие `from_user = user`) с `id` строго больше
/// `last_seen_id`. Без исходящих клиент после перезахода терял свои
/// отправленные сообщения.
/// UUID v7 лексикографически упорядочен по времени, поэтому сравнение строк
/// эквивалентно сравнению по времени создания.
async fn fetch_missed(
    pool: &SqlitePool,
    user: &str,
    last_seen_id: &str,
    since_updated: i64,
) -> Result<Vec<StoredMessage>> {
    // Два курсора: новые сообщения (`id > last_seen_id`) И мутации старых
    // (`updated_at > since_updated`: правки, удаления, отметки о прочтении).
    // `read` считается подзапросом: есть ли receipt от получателя (to_user).
    type Row = (
        String,         // id
        String,         // from_user
        String,         // to_user
        Option<String>, // content
        i64,            // ts
        Option<String>, // reply_to
        i64,            // edited
        i64,            // deleted
        i64,            // updated_at
        i64,            // read (0/1)
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT m.id, m.from_user, m.to_user, m.content, m.ts,
                m.reply_to, m.edited, m.deleted, m.updated_at,
                EXISTS(SELECT 1 FROM read_receipts r
                        WHERE r.message_id = m.id AND r.reader = m.to_user) AS read
         FROM messages m
         WHERE (m.to_user = ? OR m.from_user = ?)
           AND (m.id > ? OR m.updated_at > ?)
         ORDER BY m.updated_at, m.id
         LIMIT 100",
    )
    .bind(user)
    .bind(user)
    .bind(last_seen_id)
    .bind(since_updated)
    .fetch_all(pool)
    .await?;

    let mut messages = Vec::with_capacity(rows.len());
    for (id, from, to, content_json, ts, reply_to, edited, deleted, updated_at, read) in rows {
        // content может быть NULL только для legacy-строк без миграции данных;
        // в норме всегда заполнен.
        let content = match content_json {
            Some(json) => serde_json::from_str(&json).context("разбор content")?,
            None => MessageContent::Text { text: String::new() },
        };
        messages.push(StoredMessage {
            id: id.parse().unwrap_or(Uuid::nil()),
            from,
            to,
            content,
            ts,
            reply_to: reply_to.and_then(|s| s.parse().ok()),
            edited: edited != 0,
            deleted: deleted != 0,
            read: read != 0,
            updated_at,
        });
    }
    Ok(messages)
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

// ── msg.chat.edit ─────────────────────────────────────────────────────────────

async fn handle_edit(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<EditPayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.edit")?;
        let author = verify_token(nc, &event.token).await?;
        validate_sender(&author, &event.from)?;

        let ok = edit_message(pool, &event.payload.message_id.to_string(), &author, &event.payload.text, now_unix()).await?;
        if ok {
            info!("Сообщение {} отредактировано автором {}", event.payload.message_id, author);
        } else {
            warn!("Правка {} отклонена (не автор или удалено)", event.payload.message_id);
        }
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_edit: {}", e);
    }
}

// ── msg.chat.delete ───────────────────────────────────────────────────────────

async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<DeletePayload> = serde_json::from_slice(&msg.payload)
            .context("неверный JSON в msg.chat.delete")?;
        let author = verify_token(nc, &event.token).await?;
        validate_sender(&author, &event.from)?;

        let ok = delete_message(pool, &event.payload.message_id.to_string(), &author, now_unix()).await?;
        if ok {
            info!("Сообщение {} удалено у всех автором {}", event.payload.message_id, author);
        } else {
            warn!("Удаление {} отклонено (не автор)", event.payload.message_id);
        }
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_delete: {}", e);
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
        let messages = fetch_missed(pool, &user, last_id, event.payload.since_updated).await?;

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
    use parvane_types::{MessageContent, SendPayload};
    use sqlx::sqlite::SqlitePoolOptions;

    /// Текстовое сообщение.
    fn send_event(id: &str, from: &str, to: &str, text: &str) -> ParvaneEvent<SendPayload> {
        send_content(id, from, to, MessageContent::Text { text: text.into() })
    }

    /// Сообщение с произвольным контентом (для медиа-тестов).
    fn send_content(
        id: &str,
        from: &str,
        to: &str,
        content: MessageContent,
    ) -> ParvaneEvent<SendPayload> {
        ParvaneEvent {
            id: id.parse().unwrap(),
            from: from.into(),
            ts: 1_000_000,
            token: "tok".into(),
            payload: SendPayload { to: to.into(), content, reply_to: None },
        }
    }

    /// Достаёт текст из текстового сообщения (для ассертов).
    fn text_of(m: &StoredMessage) -> &str {
        match &m.content {
            MessageContent::Text { text } => text,
            other => panic!("ожидался Text, получено {:?}", other),
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

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "привет");
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
        let missed = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(missed.is_empty());
    }

    #[tokio::test]
    async fn fetch_missed_includes_own_sent_messages() {
        // регрессия: после перезахода отправитель должен видеть свои исходящие
        let pool = test_pool().await;
        store_message(
            &pool,
            &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "моё исходящее"),
            1,
        )
        .await
        .unwrap();

        // alice — отправитель, должна получить своё же сообщение при ресинке
        let missed = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "моё исходящее");
        assert_eq!(missed[0].from, "alice@local");
        assert_eq!(missed[0].to, "bob@local");
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

        // Клиент, уже видевший older, держит оба курсора: last_seen=older и
        // since_updated=updated_at(older)=1. Тогда отдаётся только newer.
        let missed = fetch_missed(&pool, "bob@local", older, 1).await.unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "второе");
    }

    #[tokio::test]
    async fn fetch_missed_picks_up_mutations_past_id_cursor() {
        // Курсор по мутациям ловит правку старого сообщения, даже когда его id
        // ≤ last_seen_id (инкрементальный синк по id такое пропускал).
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-000000000001";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "до правки"), 1)
            .await
            .unwrap();
        // Клиент уже видел это сообщение (id и updated_at=1).
        let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert!(none.is_empty());
        // Автор редактирует — updated_at прыгает на 5.
        assert!(edit_message(&pool, mid, "alice@local", "после правки", 5).await.unwrap());
        let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(text_of(&missed[0]), "после правки");
        assert!(missed[0].edited);
    }

    #[tokio::test]
    async fn read_receipt_surfaces_in_sync() {
        // Отправитель видит read=true после receipt получателя (галочка ✓✓).
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000bb";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "прочти меня"), 1)
            .await
            .unwrap();
        // До прочтения — read=false.
        let before = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(before.len(), 1);
        assert!(!before[0].read);
        // Получатель прочитал.
        store_read_receipt(&pool, mid, "bob@local", 7).await.unwrap();
        let after = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert!(after[0].read, "read-галочка после receipt");
    }

    #[tokio::test]
    async fn delete_message_only_by_author() {
        let pool = test_pool().await;
        let mid = "00000000-0000-7000-8000-0000000000cc";
        store_message(&pool, &send_event(mid, "alice@local", "bob@local", "секрет"), 1)
            .await
            .unwrap();
        // Чужак не может удалить.
        assert!(!delete_message(&pool, mid, "bob@local", 3).await.unwrap());
        // Автор может.
        assert!(delete_message(&pool, mid, "alice@local", 4).await.unwrap());
        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        assert!(missed[0].deleted);
    }

    #[tokio::test]
    async fn store_message_is_idempotent() {
        let pool = test_pool().await;
        let ev = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "раз");
        store_message(&pool, &ev, 1).await.unwrap();
        // повторная доставка того же id (даже с другим текстом) не создаёт дубликат
        let dup = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "два");
        store_message(&pool, &dup, 2).await.unwrap();

        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1, "дубликата быть не должно");
        assert_eq!(text_of(&missed[0]), "раз", "первая запись сохраняется");
    }

    // ── медиа-сообщения ──

    #[tokio::test]
    async fn store_and_fetch_voice_message() {
        let pool = test_pool().await;
        let file_id = uuid::Uuid::now_v7();
        let ev = send_content(
            "00000000-0000-7000-8000-0000000000f1",
            "alice@local",
            "bob@local",
            MessageContent::Voice {
                file_id,
                duration_secs: 5,
                mime: "audio/ogg".into(),
                size_bytes: 4096,
            },
        );
        store_message(&pool, &ev, 1).await.unwrap();

        // kind пишется отдельной колонкой для фильтрации
        let kind: (String,) = sqlx::query_as("SELECT kind FROM messages WHERE id = ?")
            .bind("00000000-0000-7000-8000-0000000000f1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kind.0, "voice");

        // content десериализуется обратно в тот же вариант
        let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
            .await
            .unwrap();
        assert_eq!(missed.len(), 1);
        match &missed[0].content {
            MessageContent::Voice { file_id: f, duration_secs, size_bytes, .. } => {
                assert_eq!(*f, file_id);
                assert_eq!(*duration_secs, 5);
                assert_eq!(*size_bytes, 4096);
            }
            other => panic!("ожидался Voice, получено {:?}", other),
        }
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
