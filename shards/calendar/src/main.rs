mod lww;

use anyhow::{Context, Result};
use async_nats::Client;
use futures::StreamExt;
use lww::CalEvent;
use parvane_types::{
    CalDeletePayload, CalEventSnapshot, CalSetPayload, CalSyncResponsePayload, LwwField,
    ParvaneEvent, Stamp, VerifyRequest, VerifyResponse,
    topics::{
        CAL_CREATE, CAL_DELETE, CAL_SYNC_REQUEST, CAL_SYNC_RESPONSE, CAL_UPDATE, IDENTITY_VERIFY,
    },
};
use sqlx::SqlitePool;
use std::collections::BTreeMap;
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
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./calendar.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url).await.context("подключение к SQLite")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;
    info!("SQLite готов: {}", db_path);

    let nc = async_nats::connect(&nats_url).await.context("подключение к NATS")?;
    info!("NATS подключён: {}", nats_url);

    // create и update несут одинаковый payload (CalSetPayload). Создаём оба
    // подписчика; разница лишь в том, что create фиксирует владельца, если
    // события ещё нет.
    let mut create_sub = nc.subscribe(CAL_CREATE).await?;
    let mut update_sub = nc.subscribe(CAL_UPDATE).await?;
    let mut delete_sub = nc.subscribe(CAL_DELETE).await?;
    let mut sync_sub = nc.subscribe(CAL_SYNC_REQUEST).await?;

    info!(
        "Calendar шард запущен. Слушаю: {}, {}, {}, {}",
        CAL_CREATE, CAL_UPDATE, CAL_DELETE, CAL_SYNC_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = create_sub.next() => handle_set(&nc, &pool, msg, true).await,
            Some(msg) = update_sub.next() => handle_set(&nc, &pool, msg, false).await,
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

/// Возвращает владельца события, если оно существует.
async fn event_owner(pool: &SqlitePool, event_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT owner FROM cal_events WHERE id = ?")
        .bind(event_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(o,)| o))
}

// ── cal.event.create / cal.event.update ──────────────────────────────────────

async fn handle_set(nc: &Client, pool: &SqlitePool, msg: async_nats::Message, is_create: bool) {
    let result = async {
        let event: ParvaneEvent<CalSetPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в cal set")?;
        let user = verify_token(nc, &event.token).await?;
        let event_id = event.payload.event_id.to_string();

        match event_owner(pool, &event_id).await? {
            Some(owner) if owner != user => {
                anyhow::bail!("событие принадлежит другому пользователю")
            }
            Some(_) => {} // существует и наше
            None => {
                if !is_create {
                    anyhow::bail!("событие не найдено: {}", event_id);
                }
                sqlx::query(
                    "INSERT INTO cal_events (id, owner, created_at) VALUES (?, ?, ?)",
                )
                .bind(&event_id)
                .bind(&user)
                .bind(now_unix())
                .execute(pool)
                .await?;
            }
        }

        // Загружаем текущее состояние, применяем LWW-мерж, пишем изменённое.
        let mut ev = load_event(pool, &event_id).await?;
        let stamp = event.payload.stamp.clone();
        let mut changed = Vec::new();
        for (field, value) in &event.payload.fields {
            if ev.set_field(field, value.clone(), stamp.clone()) {
                changed.push(field.clone());
            }
        }

        for field in &changed {
            let f = &ev.fields()[field];
            sqlx::query(
                "INSERT INTO cal_fields (event_id, field, value, stamp_ts, stamp_site)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(event_id, field) DO UPDATE SET
                   value = excluded.value,
                   stamp_ts = excluded.stamp_ts,
                   stamp_site = excluded.stamp_site",
            )
            .bind(&event_id)
            .bind(field)
            .bind(&f.value)
            .bind(f.stamp.ts)
            .bind(&f.stamp.site)
            .execute(pool)
            .await?;
        }

        info!(
            "Событие {} ({}): применено {}/{} полей, удалено={}",
            event_id,
            if is_create { "create" } else { "update" },
            changed.len(),
            event.payload.fields.len(),
            ev.is_deleted()
        );
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_set: {}", e);
    }
}

// ── cal.event.delete ─────────────────────────────────────────────────────────

async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<CalDeletePayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в cal.event.delete")?;
        let user = verify_token(nc, &event.token).await?;
        let event_id = event.payload.event_id.to_string();

        match event_owner(pool, &event_id).await? {
            Some(owner) if owner != user => {
                anyhow::bail!("событие принадлежит другому пользователю")
            }
            None => anyhow::bail!("событие не найдено: {}", event_id),
            Some(_) => {}
        }

        let mut ev = load_event(pool, &event_id).await?;
        if ev.delete(event.payload.stamp.clone()) {
            sqlx::query("UPDATE cal_events SET deleted_ts = ?, deleted_site = ? WHERE id = ?")
                .bind(event.payload.stamp.ts)
                .bind(&event.payload.stamp.site)
                .bind(&event_id)
                .execute(pool)
                .await?;
        }

        info!("Событие {}: delete-штамп применён, удалено={}", event_id, ev.is_deleted());
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_delete: {}", e);
    }
}

// ── cal.sync.request ─────────────────────────────────────────────────────────

async fn handle_sync(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("sync: нет reply-топика");
        return;
    };

    let result = async {
        let event: ParvaneEvent<serde_json::Value> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в cal.sync.request")?;
        let user = verify_token(nc, &event.token).await?;

        let ids: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM cal_events WHERE owner = ? ORDER BY created_at")
                .bind(&user)
                .fetch_all(pool)
                .await?;

        let mut events = Vec::new();
        for (id,) in ids {
            let ev = load_event(pool, &id).await?;
            events.push(CalEventSnapshot {
                event_id: id.parse().unwrap_or_default(),
                fields: ev.fields().clone(),
                deleted: ev.is_deleted(),
                deleted_stamp: ev.deleted_stamp().cloned(),
            });
        }

        let count = events.len();
        let resp = ParvaneEvent {
            id: uuid::Uuid::now_v7(),
            from: "calendar".to_string(),
            ts: now_unix(),
            token: String::new(),
            payload: CalSyncResponsePayload { events },
        };
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply.clone(), json.clone().into()).await?;
        nc.publish(CAL_SYNC_RESPONSE, json.into()).await?;

        info!("Sync для {}: {} событий", user, count);
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        error!("handle_sync: {}", e);
        let _ = nc.publish(reply, b"{}".as_ref().into()).await;
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async fn load_event(pool: &SqlitePool, event_id: &str) -> Result<CalEvent> {
    let field_rows: Vec<(String, String, i64, String)> = sqlx::query_as(
        "SELECT field, value, stamp_ts, stamp_site FROM cal_fields WHERE event_id = ?",
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;

    let mut fields = BTreeMap::new();
    for (field, value, ts, site) in field_rows {
        fields.insert(field, LwwField { value, stamp: Stamp { ts, site } });
    }

    let del: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT deleted_ts, deleted_site FROM cal_events WHERE id = ?")
            .bind(event_id)
            .fetch_optional(pool)
            .await?;
    let deleted_stamp = match del {
        Some((Some(ts), Some(site))) => Some(Stamp { ts, site }),
        _ => None,
    };

    Ok(CalEvent::from_parts(fields, deleted_stamp))
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}
