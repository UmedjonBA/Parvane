mod rga;

use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use parvane_types::{
    NoteCreatePayload, NoteDeletePayload, NoteElement, NoteOp, NoteSnapshot,
    NoteSyncResponsePayload, NoteUpdatePayload, OpId, ParvaneEvent, VerifyRequest, VerifyResponse,
    topics::{
        IDENTITY_VERIFY, NOTE_CREATE, NOTE_DELETE, NOTE_SYNC_REQUEST, NOTE_SYNC_RESPONSE,
        NOTE_UPDATE,
    },
};
use rga::Rga;
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
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./notes.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url).await.context("подключение к SQLite")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let nc = async_nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    let mut create_sub = nc.subscribe(NOTE_CREATE).await?;
    let mut update_sub = nc.subscribe(NOTE_UPDATE).await?;
    let mut delete_sub = nc.subscribe(NOTE_DELETE).await?;
    let mut sync_sub = nc.subscribe(NOTE_SYNC_REQUEST).await?;

    info!(
        "Notes шард запущен. Слушаю: {}, {}, {}, {}",
        NOTE_CREATE, NOTE_UPDATE, NOTE_DELETE, NOTE_SYNC_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = create_sub.next() => handle_create(&nc, &pool, msg).await,
            Some(msg) = update_sub.next() => handle_update(&nc, &pool, msg).await,
            Some(msg) = delete_sub.next() => handle_delete(&nc, &pool, msg).await,
            Some(msg) = sync_sub.next()   => handle_sync(&nc, &pool, msg).await,
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

/// Проверяет что заметка существует и принадлежит `user`. Возвращает заголовок.
async fn assert_owner(pool: &SqlitePool, note_id: &str, user: &str) -> Result<()> {
    let row: Option<(String,)> = sqlx::query_as("SELECT owner FROM notes WHERE id = ?")
        .bind(note_id)
        .fetch_optional(pool)
        .await?;
    match row {
        Some((owner,)) if owner == user => Ok(()),
        Some(_) => anyhow::bail!("заметка принадлежит другому пользователю"),
        None => anyhow::bail!("заметка не найдена: {}", note_id),
    }
}

// ── note.create ──────────────────────────────────────────────────────────────

async fn handle_create(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<NoteCreatePayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в note.create")?;
        let owner = verify_token(nc, &event.token).await?;

        sqlx::query(
            "INSERT OR IGNORE INTO notes (id, owner, title, deleted, created_at)
             VALUES (?, ?, ?, 0, ?)",
        )
        .bind(event.payload.note_id.to_string())
        .bind(&owner)
        .bind(&event.payload.title)
        .bind(now_unix())
        .execute(pool)
        .await?;

        info!("Заметка создана: '{}' ({}) owner={}", event.payload.title, event.payload.note_id, owner);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_create: {}", e);
    }
}

// ── note.update ──────────────────────────────────────────────────────────────

async fn handle_update(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<NoteUpdatePayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в note.update")?;
        let user = verify_token(nc, &event.token).await?;
        let note_id = event.payload.note_id.to_string();
        assert_owner(pool, &note_id, &user).await?;

        // Применяем операции напрямую в БД — INSERT OR IGNORE и UPDATE
        // идемпотентны, поэтому повторная доставка операций безопасна.
        for op in &event.payload.ops {
            match op {
                NoteOp::Insert { id, after, ch } => {
                    let (after_site, after_seq) = match after {
                        Some(a) => (Some(a.site.clone()), Some(a.seq as i64)),
                        None => (None, None),
                    };
                    sqlx::query(
                        "INSERT OR IGNORE INTO note_elements
                         (note_id, site, seq, after_site, after_seq, ch, deleted)
                         VALUES (?, ?, ?, ?, ?, ?, 0)",
                    )
                    .bind(&note_id)
                    .bind(&id.site)
                    .bind(id.seq as i64)
                    .bind(after_site)
                    .bind(after_seq)
                    .bind(ch.to_string())
                    .execute(pool)
                    .await?;
                }
                NoteOp::Delete { target } => {
                    sqlx::query(
                        "UPDATE note_elements SET deleted = 1
                         WHERE note_id = ? AND site = ? AND seq = ?",
                    )
                    .bind(&note_id)
                    .bind(&target.site)
                    .bind(target.seq as i64)
                    .execute(pool)
                    .await?;
                }
            }
        }

        let text = render_note(pool, &note_id).await?;
        info!("Заметка обновлена ({}): {} операций → \"{}\"", note_id, event.payload.ops.len(), text);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_update: {}", e);
    }
}

// ── note.delete ──────────────────────────────────────────────────────────────

async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<NoteDeletePayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в note.delete")?;
        let user = verify_token(nc, &event.token).await?;
        let note_id = event.payload.note_id.to_string();
        assert_owner(pool, &note_id, &user).await?;

        sqlx::query("UPDATE notes SET deleted = 1 WHERE id = ?")
            .bind(&note_id)
            .execute(pool)
            .await?;

        info!("Заметка удалена: {}", note_id);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_delete: {}", e);
    }
}

// ── note.sync.request ────────────────────────────────────────────────────────

async fn handle_sync(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("sync: нет reply-топика, игнорирую");
        return;
    };

    let result = async {
        let event: ParvaneEvent<serde_json::Value> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в note.sync.request")?;
        let user = verify_token(nc, &event.token).await?;

        let notes_rows: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT id, title, deleted FROM notes WHERE owner = ? ORDER BY created_at")
                .bind(&user)
                .fetch_all(pool)
                .await?;

        let mut notes = Vec::new();
        for (id, title, deleted) in notes_rows {
            let elements = load_elements(pool, &id).await?;
            let text = Rga::from_elements(elements.clone()).text();
            notes.push(NoteSnapshot {
                note_id: id.parse().unwrap_or_default(),
                title,
                text,
                elements,
                deleted: deleted != 0,
            });
        }

        let count = notes.len();
        let resp = ParvaneEvent {
            id: uuid::Uuid::now_v7(),
            from: "notes".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: NoteSyncResponsePayload { notes },
        };
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.clone().into()).await?;
        nc.publish(NOTE_SYNC_RESPONSE, json.into()).await?;

        info!("Sync для {}: {} заметок", user, count);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_sync: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async fn load_elements(pool: &SqlitePool, note_id: &str) -> Result<Vec<NoteElement>> {
    let rows: Vec<(String, i64, Option<String>, Option<i64>, String, i64)> = sqlx::query_as(
        "SELECT site, seq, after_site, after_seq, ch, deleted
         FROM note_elements WHERE note_id = ?",
    )
    .bind(note_id)
    .fetch_all(pool)
    .await?;

    let mut elements = Vec::with_capacity(rows.len());
    for (site, seq, after_site, after_seq, ch, deleted) in rows {
        let after = match (after_site, after_seq) {
            (Some(s), Some(q)) => Some(OpId { seq: q as u64, site: s }),
            _ => None,
        };
        elements.push(NoteElement {
            id: OpId { seq: seq as u64, site },
            after,
            ch: ch.chars().next().unwrap_or('\u{fffd}'),
            deleted: deleted != 0,
        });
    }
    Ok(elements)
}

async fn render_note(pool: &SqlitePool, note_id: &str) -> Result<String> {
    let elements = load_elements(pool, note_id).await?;
    Ok(Rga::from_elements(elements).text())
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}
