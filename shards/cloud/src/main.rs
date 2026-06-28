use anyhow::{Context, Result};
use async_nats::Client;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures::StreamExt;
use parvane_types::{
    DownloadRequest, DownloadResponse, FileEntry, FileListPayload, FileListResponse, ParvaneEvent,
    UploadChunkPayload, UploadCompletePayload, UploadCompleteResponse, VerifyRequest, VerifyResponse,
    topics::{
        FILE_DOWNLOAD_REQUEST, FILE_DOWNLOAD_RESPONSE, FILE_LIST_REQUEST, FILE_UPLOAD_CHUNK,
        FILE_UPLOAD_COMPLETE, IDENTITY_VERIFY,
    },
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
    let db_path = std::env::var("PARVANE_DB_PATH")
        .unwrap_or_else(|_| "./cloud.db".to_string());

    let db_url = format!("sqlite://{}?mode=rwc", db_path);
    let pool = SqlitePool::connect(&db_url)
        .await
        .context("подключение к SQLite")?;

    sqlx::migrate!("./migrations").run(&pool).await.context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let nc = async_nats::connect(&nats_url).await.context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    let mut chunk_sub = nc.subscribe(FILE_UPLOAD_CHUNK).await?;
    let mut complete_sub = nc.subscribe(FILE_UPLOAD_COMPLETE).await?;
    let mut download_sub = nc.subscribe(FILE_DOWNLOAD_REQUEST).await?;
    let mut list_sub = nc.subscribe(FILE_LIST_REQUEST).await?;

    info!(
        "Cloud шард запущен. Слушаю: {}, {}, {}, {}",
        FILE_UPLOAD_CHUNK, FILE_UPLOAD_COMPLETE, FILE_DOWNLOAD_REQUEST, FILE_LIST_REQUEST
    );

    loop {
        tokio::select! {
            Some(msg) = chunk_sub.next() => handle_chunk(&nc, &pool, msg).await,
            Some(msg) = complete_sub.next() => handle_complete(&nc, &pool, msg).await,
            Some(msg) = download_sub.next() => handle_download(&nc, &pool, msg).await,
            Some(msg) = list_sub.next() => handle_list(&nc, &pool, msg).await,
        }
    }
}

// ── auth helper ───────────────────────────────────────────────────────────────

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

// ── file.upload.chunk ─────────────────────────────────────────────────────────

async fn handle_chunk(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<UploadChunkPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в upload.chunk")?;

        let owner = verify_token(nc, &event.token).await?;

        let raw = B64.decode(&event.payload.data).context("base64 decode")?;

        sqlx::query(
            "INSERT OR REPLACE INTO chunks (file_id, chunk_index, data) VALUES (?, ?, ?)",
        )
        .bind(event.payload.file_id.to_string())
        .bind(event.payload.chunk_index)
        .bind(raw)
        .execute(pool)
        .await
        .context("сохранение чанка")?;

        info!(
            "Чанк сохранён: {} [{}/{}] owner={}",
            event.payload.file_id,
            event.payload.chunk_index + 1,
            event.payload.total_chunks,
            owner
        );
        anyhow::Ok(())
    }
    .await;

    // Если клиент прислал чанк как request (с reply-топиком) — подтверждаем
    // сохранение. Это сериализует загрузку: клиент дожидается записи каждого
    // чанка до отправки complete, исключая гонку chunk/complete в select!.
    if let Some(reply) = msg.reply {
        let ack = match &result {
            Ok(()) => serde_json::json!({ "ok": true }),
            Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        };
        if let Ok(bytes) = serde_json::to_vec(&ack) {
            let _ = nc.publish(reply, bytes.into()).await;
        }
    }

    if let Err(e) = result {
        error!("handle_chunk: {}", e);
    }
}

// ── file.upload.complete ──────────────────────────────────────────────────────

async fn handle_complete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("upload.complete: нет reply-топика");
        return;
    };

    let reply_err = reply.clone();
    let result = async {
        let event: ParvaneEvent<UploadCompletePayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в upload.complete")?;

        let owner = verify_token(nc, &event.token).await?;

        // Проверяем что все чанки на месте
        let (received,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
                .bind(event.payload.file_id.to_string())
                .fetch_one(pool)
                .await?;

        if received != event.payload.total_chunks as i64 {
            anyhow::bail!(
                "получено {}/{} чанков",
                received,
                event.payload.total_chunks
            );
        }

        let now = now_unix();
        sqlx::query(
            "INSERT OR REPLACE INTO files (id, owner, filename, mime_type, size_bytes, total_chunks, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(event.payload.file_id.to_string())
        .bind(&owner)
        .bind(&event.payload.filename)
        .bind(&event.payload.mime_type)
        .bind(event.payload.size_bytes as i64)
        .bind(event.payload.total_chunks)
        .bind(now)
        .execute(pool)
        .await?;

        info!(
            "Файл завершён: {} ({}, {} байт) owner={}",
            event.payload.filename, event.payload.file_id, event.payload.size_bytes, owner
        );

        let resp = UploadCompleteResponse {
            ok: true,
            file_id: Some(event.payload.file_id),
            error: None,
        };
        let json = serde_json::to_vec(&resp)?;
        nc.publish(reply, json.into()).await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_complete: {}", e);
        let resp = UploadCompleteResponse { ok: false, file_id: None, error: Some(e.to_string()) };
        let _ = nc.publish(reply_err, serde_json::to_vec(&resp).unwrap().into()).await;
    }
}

// ── file.download.request ─────────────────────────────────────────────────────

async fn handle_download(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("download.request: нет reply-топика");
        return;
    };

    let result = async {
        let event: ParvaneEvent<DownloadRequest> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в download.request")?;

        verify_token(nc, &event.token).await?;

        let file_id = event.payload.file_id.to_string();

        let meta: Option<(String, String, i64, i64)> = sqlx::query_as(
            "SELECT filename, mime_type, size_bytes, total_chunks FROM files WHERE id = ?",
        )
        .bind(&file_id)
        .fetch_optional(pool)
        .await?;

        let (filename, mime_type, _size, total_chunks) = meta
            .ok_or_else(|| anyhow::anyhow!("файл не найден: {}", file_id))?;

        // Шлём чанки последовательно через reply-топик
        let chunks: Vec<(i64, Vec<u8>)> =
            sqlx::query_as("SELECT chunk_index, data FROM chunks WHERE file_id = ? ORDER BY chunk_index")
                .bind(&file_id)
                .fetch_all(pool)
                .await?;

        for (idx, data) in chunks {
            let resp = DownloadResponse {
                ok: true,
                file_id: Some(event.payload.file_id),
                filename: Some(filename.clone()),
                mime_type: Some(mime_type.clone()),
                chunk_index: Some(idx as u32),
                total_chunks: Some(total_chunks as u32),
                data: Some(B64.encode(&data)),
                error: None,
            };
            let json = serde_json::to_vec(&resp)?;
            nc.publish(reply.clone(), json.into()).await?;
        }

        // Публикуем на общий топик для подписчиков
        let done = DownloadResponse {
            ok: true,
            file_id: Some(event.payload.file_id),
            filename: Some(filename.clone()),
            mime_type: Some(mime_type),
            chunk_index: None,
            total_chunks: Some(total_chunks as u32),
            data: None,
            error: None,
        };
        nc.publish(FILE_DOWNLOAD_RESPONSE, serde_json::to_vec(&done)?.into()).await?;

        info!("Файл отдан: {} ({} чанков)", filename, total_chunks);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_download: {}", e);
        let resp = DownloadResponse {
            ok: false, file_id: None, filename: None, mime_type: None,
            chunk_index: None, total_chunks: None, data: None,
            error: Some(e.to_string()),
        };
        let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap().into()).await;
    }
}

// ── file.list.request ─────────────────────────────────────────────────────────

async fn handle_list(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("file.list.request: нет reply-топика");
        return;
    };

    let result = async {
        let event: ParvaneEvent<FileListPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в file.list.request")?;

        let owner = verify_token(nc, &event.token).await?;

        let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
            "SELECT id, filename, mime_type, size_bytes, created_at FROM files WHERE owner = ? ORDER BY created_at DESC",
        )
        .bind(&owner)
        .fetch_all(pool)
        .await?;

        let files = rows
            .into_iter()
            .filter_map(|(id, filename, mime_type, size_bytes, created_at)| {
                let file_id = uuid::Uuid::parse_str(&id).ok()?;
                Some(FileEntry { file_id, filename, mime_type, size_bytes, created_at })
            })
            .collect();

        let resp = FileListResponse { files };
        nc.publish(reply, serde_json::to_vec(&resp)?.into()).await?;
        info!("Список файлов отдан owner={}", owner);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_list: {}", e);
        if let Some(reply) = msg.reply {
            let resp = FileListResponse { files: vec![] };
            let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap().into()).await;
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}
