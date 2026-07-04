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

    let nc = parvane_types::nats::connect(&nats_url).await.context("подключение к NATS")?;

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

// ── DB-слой (без NATS — покрыт unit-тестами) ────────────────────────────────────

/// Сохранить один чанк файла. Декодирует base64 и пишет BLOB в `chunks`.
/// Идемпотентно (INSERT OR REPLACE) — повторная доставка чанка безопасна.
async fn store_chunk(pool: &SqlitePool, p: &UploadChunkPayload) -> Result<()> {
    let raw = B64.decode(&p.data).context("base64 decode")?;
    sqlx::query("INSERT OR REPLACE INTO chunks (file_id, chunk_index, data) VALUES (?, ?, ?)")
        .bind(p.file_id.to_string())
        .bind(p.chunk_index)
        .bind(raw)
        .execute(pool)
        .await
        .context("сохранение чанка")?;
    Ok(())
}

/// Завершить файл: проверить что все чанки на месте и записать метаданные.
/// Возвращает `file_id` при успехе, ошибку — если чанков недостаёт.
async fn finalize_file(
    pool: &SqlitePool,
    owner: &str,
    p: &UploadCompletePayload,
) -> Result<uuid::Uuid> {
    let (received,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
        .bind(p.file_id.to_string())
        .fetch_one(pool)
        .await?;

    if received != p.total_chunks as i64 {
        anyhow::bail!("получено {}/{} чанков", received, p.total_chunks);
    }

    sqlx::query(
        "INSERT OR REPLACE INTO files (id, owner, filename, mime_type, size_bytes, total_chunks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(p.file_id.to_string())
    .bind(owner)
    .bind(&p.filename)
    .bind(&p.mime_type)
    .bind(p.size_bytes as i64)
    .bind(p.total_chunks)
    .bind(now_unix())
    .execute(pool)
    .await?;

    Ok(p.file_id)
}

/// Собранный файл для отдачи: метаданные + все чанки по порядку.
struct LoadedFile {
    filename: String,
    mime_type: String,
    total_chunks: i64,
    chunks: Vec<(i64, Vec<u8>)>,
}

/// Загрузить файл целиком из БД. `None` — файла нет.
async fn load_file(pool: &SqlitePool, file_id: &str) -> Result<Option<LoadedFile>> {
    let meta: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT filename, mime_type, size_bytes, total_chunks FROM files WHERE id = ?",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;

    let Some((filename, mime_type, _size, total_chunks)) = meta else {
        return Ok(None);
    };

    let chunks: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT chunk_index, data FROM chunks WHERE file_id = ? ORDER BY chunk_index")
            .bind(file_id)
            .fetch_all(pool)
            .await?;

    Ok(Some(LoadedFile { filename, mime_type, total_chunks, chunks }))
}

/// Список файлов владельца, свежие первыми.
async fn list_files(pool: &SqlitePool, owner: &str) -> Result<Vec<FileEntry>> {
    let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, filename, mime_type, size_bytes, created_at FROM files WHERE owner = ? ORDER BY created_at DESC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(id, filename, mime_type, size_bytes, created_at)| {
            let file_id = uuid::Uuid::parse_str(&id).ok()?;
            Some(FileEntry { file_id, filename, mime_type, size_bytes, created_at })
        })
        .collect())
}

// ── file.upload.chunk ─────────────────────────────────────────────────────────

async fn handle_chunk(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<UploadChunkPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в upload.chunk")?;

        let owner = verify_token(nc, &event.token).await?;
        store_chunk(pool, &event.payload).await?;

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
        let file_id = finalize_file(pool, &owner, &event.payload).await?;

        info!(
            "Файл завершён: {} ({}, {} байт) owner={}",
            event.payload.filename, file_id, event.payload.size_bytes, owner
        );

        let resp = UploadCompleteResponse { ok: true, file_id: Some(file_id), error: None };
        nc.publish(reply, serde_json::to_vec(&resp)?.into()).await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_complete: {}", e);
        let resp = UploadCompleteResponse { ok: false, file_id: None, error: Some(e.to_string()) };
        let _ = nc.publish(reply_err, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
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
        let file = load_file(pool, &file_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("файл не найден: {}", file_id))?;

        // Шлём чанки последовательно через reply-топик
        for (idx, data) in &file.chunks {
            let resp = DownloadResponse {
                ok: true,
                file_id: Some(event.payload.file_id),
                filename: Some(file.filename.clone()),
                mime_type: Some(file.mime_type.clone()),
                chunk_index: Some(*idx as u32),
                total_chunks: Some(file.total_chunks as u32),
                data: Some(B64.encode(data)),
                error: None,
            };
            nc.publish(reply.clone(), serde_json::to_vec(&resp)?.into()).await?;
        }

        // Публикуем на общий топик для подписчиков
        let done = DownloadResponse {
            ok: true,
            file_id: Some(event.payload.file_id),
            filename: Some(file.filename.clone()),
            mime_type: Some(file.mime_type.clone()),
            chunk_index: None,
            total_chunks: Some(file.total_chunks as u32),
            data: None,
            error: None,
        };
        nc.publish(FILE_DOWNLOAD_RESPONSE, serde_json::to_vec(&done)?.into()).await?;

        info!("Файл отдан: {} ({} чанков)", file.filename, file.total_chunks);
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
        let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
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
        let files = list_files(pool, &owner).await?;

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
            let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

// ── unit-тесты DB-слоя (in-memory SQLite, без NATS) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
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

    fn chunk(file_id: Uuid, idx: u32, total: u32, bytes: &[u8]) -> UploadChunkPayload {
        UploadChunkPayload {
            file_id,
            chunk_index: idx,
            total_chunks: total,
            data: B64.encode(bytes),
            filename: "f.bin".into(),
            mime_type: "application/octet-stream".into(),
        }
    }

    fn complete(file_id: Uuid, total: u32, size: u64) -> UploadCompletePayload {
        UploadCompletePayload {
            file_id,
            filename: "f.bin".into(),
            total_chunks: total,
            size_bytes: size,
            mime_type: "application/octet-stream".into(),
        }
    }

    #[tokio::test]
    async fn store_chunk_decodes_base64_blob() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, &chunk(id, 0, 1, b"hello")).await.unwrap();

        let (data,): (Vec<u8>,) =
            sqlx::query_as("SELECT data FROM chunks WHERE file_id = ? AND chunk_index = 0")
                .bind(id.to_string())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(data, b"hello");
    }

    #[tokio::test]
    async fn store_chunk_is_idempotent() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, &chunk(id, 0, 1, b"aaa")).await.unwrap();
        store_chunk(&pool, &chunk(id, 0, 1, b"bbb")).await.unwrap(); // перезапись того же индекса

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
            .bind(id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "повторный чанк не должен дублироваться");
    }

    #[tokio::test]
    async fn finalize_rejects_missing_chunks() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, &chunk(id, 0, 2, b"part0")).await.unwrap();
        // прислали только 1 из 2 чанков
        let err = finalize_file(&pool, "alice@local", &complete(id, 2, 10)).await;
        assert!(err.is_err(), "неполный файл должен отклоняться");
        // метаданных быть не должно
        let (files,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(files, 0);
    }

    #[tokio::test]
    async fn finalize_succeeds_when_all_chunks_present() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, &chunk(id, 0, 2, b"part0")).await.unwrap();
        store_chunk(&pool, &chunk(id, 1, 2, b"part1")).await.unwrap();
        let fid = finalize_file(&pool, "alice@local", &complete(id, 2, 10)).await.unwrap();
        assert_eq!(fid, id);

        let (owner,): (String,) = sqlx::query_as("SELECT owner FROM files WHERE id = ?")
            .bind(id.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(owner, "alice@local");
    }

    #[tokio::test]
    async fn upload_then_download_roundtrip() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, &chunk(id, 0, 2, b"AAAA")).await.unwrap();
        store_chunk(&pool, &chunk(id, 1, 2, b"BBBB")).await.unwrap();
        finalize_file(&pool, "alice@local", &complete(id, 2, 8)).await.unwrap();

        let loaded = load_file(&pool, &id.to_string()).await.unwrap().expect("файл есть");
        assert_eq!(loaded.total_chunks, 2);
        assert_eq!(loaded.chunks.len(), 2);
        // чанки отсортированы по индексу — склейка даёт исходные байты
        let mut joined = Vec::new();
        for (_, d) in &loaded.chunks { joined.extend_from_slice(d); }
        assert_eq!(joined, b"AAAABBBB");
    }

    #[tokio::test]
    async fn load_missing_file_is_none() {
        let pool = test_pool().await;
        let got = load_file(&pool, &Uuid::now_v7().to_string()).await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn list_files_only_owner_newest_first() {
        let pool = test_pool().await;
        // alice: два файла; bob: один
        let a1 = Uuid::now_v7();
        store_chunk(&pool, &chunk(a1, 0, 1, b"x")).await.unwrap();
        finalize_file(&pool, "alice@local", &complete(a1, 1, 1)).await.unwrap();
        let a2 = Uuid::now_v7();
        store_chunk(&pool, &chunk(a2, 0, 1, b"y")).await.unwrap();
        finalize_file(&pool, "alice@local", &complete(a2, 1, 1)).await.unwrap();
        let b1 = Uuid::now_v7();
        store_chunk(&pool, &chunk(b1, 0, 1, b"z")).await.unwrap();
        finalize_file(&pool, "bob@local", &complete(b1, 1, 1)).await.unwrap();

        let alice = list_files(&pool, "alice@local").await.unwrap();
        assert_eq!(alice.len(), 2, "только файлы alice");
        assert!(alice.iter().all(|f| f.file_id == a1 || f.file_id == a2));

        let bob = list_files(&pool, "bob@local").await.unwrap();
        assert_eq!(bob.len(), 1);
        assert_eq!(bob[0].file_id, b1);
    }
}
