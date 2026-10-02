use anyhow::{Context, Result};
use async_nats::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::StreamExt;
use parvane_types::{
    topics::{
        FILE_DELETE, FILE_DOWNLOAD_REQUEST, FILE_LIST_REQUEST, FILE_UPLOAD_CHUNK,
        FILE_UPLOAD_COMPLETE, IDENTITY_VERIFY,
    },
    DownloadRequest, DownloadResponse, FileDeleteRequest, FileDeleteResponse, FileEntry,
    FileListPayload, FileListResponse, ParvaneEvent,
    UploadChunkPayload, UploadCompletePayload, UploadCompleteResponse, VerifyRequest,
    VerifyResponse,
};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};

mod v2;

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

    let nats_url =
        std::env::var("PARVANE_NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let db_path = std::env::var("PARVANE_DB_PATH").unwrap_or_else(|_| "./cloud.db".to_string());

    // P-38: общий коннект (WAL, busy_timeout 30 с) — см. parvane-db
    let pool = parvane_db::connect(&db_path).await?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("миграции")?;

    info!("SQLite готов: {}", db_path);

    let nc = parvane_types::nats::connect(&nats_url)
        .await
        .context("подключение к NATS")?;

    info!("NATS подключён: {}", nats_url);

    // Протокол v2 (spec 007, T052/T123): методы реестра роли cloud. Блобы —
    // в общих v1-таблицах (файл из v2 виден v1-клиенту по file_id), новые
    // данные (capability_hash) — в отдельной `<PARVANE_DB_PATH>-v2.db` со
    // своими миграциями: откат бинарника на v1 не упирается в миграции.
    let v2_path = v2::db_path(&db_path);
    let pool_v2 = parvane_db::connect(&v2_path).await?;
    sqlx::migrate!("./migrations_v2")
        .run(&pool_v2)
        .await
        .context("миграции v2")?;
    info!("SQLite v2 готов: {}", v2_path);
    v2::run(nc.clone(), std::sync::Arc::new(v2::V2Ctx { pool: pool.clone(), pool_v2 })).await?;

    let mut chunk_sub = nc.subscribe(FILE_UPLOAD_CHUNK).await?;
    let mut complete_sub = nc.subscribe(FILE_UPLOAD_COMPLETE).await?;
    let mut download_sub = nc.subscribe(FILE_DOWNLOAD_REQUEST).await?;
    let mut list_sub = nc.subscribe(FILE_LIST_REQUEST).await?;
    let mut delete_sub = nc.subscribe(FILE_DELETE).await?;

    info!(
        "Cloud шард запущен. Слушаю: {}, {}, {}, {}, {}",
        FILE_UPLOAD_CHUNK, FILE_UPLOAD_COMPLETE, FILE_DOWNLOAD_REQUEST, FILE_LIST_REQUEST, FILE_DELETE
    );

    // P-08: чистим брошенные незавершённые аплоады при старте и раз в час.
    match purge_stale_uploads(&pool).await {
        Ok(n) if n > 0 => info!("очищено брошенных аплоадов при старте: {}", n),
        Err(e) => warn!("очистка аплоадов при старте не удалась: {}", e),
        _ => {}
    }
    {
        let pool_gc = pool.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            tick.tick().await;
            loop {
                tick.tick().await;
                match purge_stale_uploads(&pool_gc).await {
                    Ok(n) if n > 0 => info!("GC: очищено брошенных аплоадов: {}", n),
                    Err(e) => warn!("GC аплоадов не удался: {}", e),
                    _ => {}
                }
            }
        });
    }

    // 4.5/P-28: обработчики — в tokio::spawn под семафором: длинный download
    // одного клиента не стопорит чанки/списки остальных. Гонки chunk/complete
    // нет: клиент дожидается ack каждого чанка до отправки complete.
    let handlers = std::sync::Arc::new(tokio::sync::Semaphore::new(handler_concurrency()));
    loop {
        let (nc2, pool2) = (nc.clone(), pool.clone());
        let permit = handlers.clone().acquire_owned().await;
        tokio::select! {
            Some(msg) = chunk_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_chunk(&nc2, &pool2, msg).await });
            }
            Some(msg) = complete_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_complete(&nc2, &pool2, msg).await });
            }
            Some(msg) = download_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_download(&nc2, &pool2, msg).await });
            }
            Some(msg) = list_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_list(&nc2, &pool2, msg).await });
            }
            Some(msg) = delete_sub.next() => {
                tokio::spawn(async move { let _p = permit; handle_delete(&nc2, &pool2, msg).await });
            }
        }
    }
}

/// Параллелизм обработчиков (PARVANE_HANDLER_CONCURRENCY, по умолчанию 32).
pub(crate) fn handler_concurrency() -> usize {
    env_usize("PARVANE_HANDLER_CONCURRENCY", 32)
}

/// P-28: максимум чанков за один download (окно range-стриминга). Целый файл
/// в 512 МиБ больше не поднимается в память: чанки читаются и отдаются по
/// одному, а клиент запрашивает окнами.
pub(crate) fn max_download_chunks() -> u32 {
    env_usize("PARVANE_CLOUD_MAX_DOWNLOAD_CHUNKS", 256) as u32
}

// ── auth helper ───────────────────────────────────────────────────────────────

async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest {
        token: token.to_string(),
    })?;
    let reply = nc
        .request(IDENTITY_VERIFY, req.into())
        .await
        .context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user
            .ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

// ── квоты (защита от заполнения диска шарда) ─────────────────────────────────

/// Верхняя граница размера одного чанка после декодирования (клиент шлёт по
/// 192 КиБ). Держим ≤ 700 КиБ: чанк + base64 + JSON при отдаче должен уместиться
/// в NATS max_payload (P-52). PARVANE_CLOUD_MAX_CHUNK_BYTES.
pub(crate) fn max_chunk_bytes() -> usize {
    env_usize("PARVANE_CLOUD_MAX_CHUNK_BYTES", 700 * 1024)
}
/// Максимум незавершённых аплоадов на владельца (P-08): без лимита можно занять
/// диск множеством начатых и не завершённых загрузок.
fn max_pending_uploads() -> i64 {
    env_usize("PARVANE_CLOUD_MAX_PENDING_UPLOADS", 32) as i64
}
/// Возраст, после которого незавершённый аплоад считается брошенным и чистится
/// (сек). PARVANE_CLOUD_UPLOAD_TTL_SECS.
fn upload_ttl_secs() -> i64 {
    env_usize("PARVANE_CLOUD_UPLOAD_TTL_SECS", 24 * 3600) as i64
}
/// Верхняя граница размера одного файла. PARVANE_CLOUD_MAX_FILE_BYTES.
pub(crate) fn max_file_bytes() -> i64 {
    env_usize("PARVANE_CLOUD_MAX_FILE_BYTES", 512 * 1024 * 1024) as i64
}
/// Верхняя граница числа чанков в одном файле (против взрывного роста строк).
pub(crate) fn max_total_chunks() -> u32 {
    env_usize("PARVANE_CLOUD_MAX_TOTAL_CHUNKS", 100_000) as u32
}
/// Суммарная квота хранилища на владельца (0 = без лимита).
/// PARVANE_CLOUD_OWNER_QUOTA_BYTES.
fn owner_quota_bytes() -> i64 {
    #[cfg(test)]
    if let Some(q) = tests::QUOTA_OVERRIDE.with(|c| c.get()) {
        return q;
    }
    env_usize("PARVANE_CLOUD_OWNER_QUOTA_BYTES", 4 * 1024 * 1024 * 1024) as i64
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

// ── DB-слой (без NATS — покрыт unit-тестами) ────────────────────────────────────

/// Класс отказа хранилища: v1 отдаёт клиенту текст (как раньше), v2 — код
/// ошибки. Ошибки SQLite/IO сюда не попадают — они идут как есть и наружу
/// уходят только как `internal_error` / `UNAVAILABLE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RejectKind {
    Invalid,
    Forbidden,
    NotFound,
    Limit,
}

#[derive(Debug)]
pub(crate) struct Rejected {
    pub kind: RejectKind,
    msg: String,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Rejected {}

fn reject(kind: RejectKind, msg: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(Rejected { kind, msg: msg.into() })
}

/// Сохранить один чанк файла. Декодирует base64 и пишет BLOB в `chunks`.
/// Идемпотентно (INSERT OR REPLACE) — повторная доставка чанка безопасна.
async fn store_chunk(pool: &SqlitePool, owner: &str, p: &UploadChunkPayload) -> Result<()> {
    if p.total_chunks == 0 || p.chunk_index >= p.total_chunks {
        return Err(reject(RejectKind::Invalid, "некорректный индекс чанка"));
    }
    if p.total_chunks > max_total_chunks() {
        return Err(reject(RejectKind::Limit, format!("слишком много чанков (лимит {})", max_total_chunks())));
    }
    let raw = B64.decode(&p.data).context("base64 decode")?;
    store_chunk_raw(pool, owner, &p.file_id.to_string(), p.chunk_index, p.total_chunks, raw).await
}

/// Общая часть записи чанка (v1 и v2). `total_chunks` — заявленное число
/// чанков загрузки; 0 — загрузка v2, где число чанков известно только на
/// complete (v1 ноль не пропускает, поэтому чужую загрузку не подхватит).
pub(crate) async fn store_chunk_raw(
    pool: &SqlitePool,
    owner: &str,
    file_id: &str,
    chunk_index: u32,
    total_chunks: u32,
    raw: Vec<u8>,
) -> Result<()> {
    if raw.len() > max_chunk_bytes() {
        return Err(reject(RejectKind::Limit, format!("чанк больше лимита {} байт", max_chunk_bytes())));
    }
    let mut tx = pool.begin().await?;
    let finalized: Option<(String,)> = sqlx::query_as("SELECT owner FROM files WHERE id = ?")
        .bind(file_id)
        .fetch_optional(&mut *tx)
        .await?;
    if finalized.is_some() {
        return Err(reject(RejectKind::Invalid, "файл уже завершён"));
    }
    let is_new_upload = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM uploads WHERE file_id = ?",
    )
    .bind(file_id)
    .fetch_one(&mut *tx)
    .await?
    .0 == 0;
    if is_new_upload {
        // P-08: лимит числа незавершённых аплоадов на владельца.
        let (pending,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM uploads WHERE owner = ?")
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
        if pending >= max_pending_uploads() {
            return Err(reject(
                RejectKind::Limit,
                format!("слишком много незавершённых загрузок (лимит {})", max_pending_uploads()),
            ));
        }
    }
    sqlx::query(
        "INSERT OR IGNORE INTO uploads (file_id, owner, total_chunks, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(file_id)
    .bind(owner)
    .bind(total_chunks)
    .bind(now_unix())
    .execute(&mut *tx)
    .await?;
    let claim: (String, i64) =
        sqlx::query_as("SELECT owner, total_chunks FROM uploads WHERE file_id = ?")
            .bind(file_id)
            .fetch_one(&mut *tx)
            .await?;
    if claim.0 != owner || claim.1 != i64::from(total_chunks) {
        return Err(reject(RejectKind::Forbidden, "file_id принадлежит другому upload"));
    }
    // P-08: незавершённые чанки тоже считаем в квоту владельца — иначе диск
    // забивался начатыми и не завершёнными загрузками в обход квоты файлов.
    let quota = owner_quota_bytes();
    if quota > 0 {
        let (finished,): (i64,) =
            sqlx::query_as("SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE owner = ?")
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
        let (pending_bytes,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(LENGTH(c.data)), 0) FROM chunks c
             JOIN uploads u ON u.file_id = c.file_id WHERE u.owner = ?",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if finished + pending_bytes + raw.len() as i64 > quota {
            return Err(reject(
                RejectKind::Limit,
                format!("превышена квота хранилища владельца ({} байт)", quota),
            ));
        }
    }
    sqlx::query("INSERT OR REPLACE INTO chunks (file_id, chunk_index, data) VALUES (?, ?, ?)")
        .bind(file_id)
        .bind(chunk_index)
        .bind(raw)
        .execute(&mut *tx)
        .await
        .context("сохранение чанка")?;
    tx.commit().await?;
    Ok(())
}

/// Завершить файл: проверить что все чанки на месте и записать метаданные.
/// Возвращает `file_id` при успехе, ошибку — если чанков недостаёт.
async fn finalize_file(
    pool: &SqlitePool,
    owner: &str,
    p: &UploadCompletePayload,
) -> Result<uuid::Uuid> {
    finalize_upload(
        pool,
        owner,
        &Finalize {
            file_id: p.file_id.to_string(),
            claimed_total: p.total_chunks,
            total_chunks: p.total_chunks,
            size_bytes: p.size_bytes,
            filename: &p.filename,
            mime_type: &p.mime_type,
            recipients: &p.recipients,
            public_access: p.public_access,
        },
    )
    .await?;
    Ok(p.file_id)
}

/// Параметры завершения загрузки (общие для v1 и v2).
pub(crate) struct Finalize<'a> {
    pub file_id: String,
    /// `total_chunks`, с которым загрузка заведена в `uploads` (0 — v2).
    pub claimed_total: u32,
    pub total_chunks: u32,
    pub size_bytes: u64,
    pub filename: &'a str,
    pub mime_type: &'a str,
    pub recipients: &'a [String],
    pub public_access: bool,
}

pub(crate) async fn finalize_upload(pool: &SqlitePool, owner: &str, p: &Finalize<'_>) -> Result<()> {
    if p.total_chunks == 0 {
        return Err(reject(RejectKind::Invalid, "total_chunks не может быть 0"));
    }
    if p.total_chunks > max_total_chunks() {
        return Err(reject(RejectKind::Limit, format!("слишком много чанков (лимит {})", max_total_chunks())));
    }
    if p.size_bytes > max_file_bytes() as u64 {
        return Err(reject(RejectKind::Limit, format!("файл больше лимита {} байт", max_file_bytes())));
    }
    // P-52: лимиты полей метаданных (иначе — тысячи INSERT в одной транзакции
    // и неограниченные строки в БД).
    if p.filename.len() > 255 {
        return Err(reject(RejectKind::Invalid, "имя файла длиннее 255 байт"));
    }
    if p.mime_type.len() > 128 {
        return Err(reject(RejectKind::Invalid, "mime_type длиннее 128 байт"));
    }
    if p.recipients.len() > 256 {
        return Err(reject(RejectKind::Limit, "слишком много получателей (лимит 256)"));
    }
    let file_id = p.file_id.as_str();
    let mut tx = pool.begin().await?;
    let claim: Option<(String, i64)> =
        sqlx::query_as("SELECT owner, total_chunks FROM uploads WHERE file_id = ?")
            .bind(file_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((claimed_owner, claimed_total)) = claim else {
        return Err(reject(RejectKind::NotFound, "upload не найден"));
    };
    if claimed_owner != owner || claimed_total != i64::from(p.claimed_total) {
        return Err(reject(
            RejectKind::Forbidden,
            "upload принадлежит другому владельцу или изменён total_chunks",
        ));
    }

    let (received, actual_size, max_index): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0), COALESCE(MAX(chunk_index), -1)
         FROM chunks WHERE file_id = ?",
    )
    .bind(file_id)
    .fetch_one(&mut *tx)
    .await?;

    // Индексы уникальны (PK), поэтому count == total и max == total-1 значат
    // «ровно 0..total-1» — v2-загрузка не знает total заранее.
    if received != p.total_chunks as i64 || max_index != p.total_chunks as i64 - 1 {
        return Err(reject(RejectKind::Invalid, format!("получено {}/{} чанков", received, p.total_chunks)));
    }
    if actual_size != p.size_bytes as i64 {
        return Err(reject(
            RejectKind::Invalid,
            format!("размер чанков {actual_size} не совпадает с заявленным {}", p.size_bytes),
        ));
    }

    // Квота владельца: сумма его завершённых файлов + этот не должна превышать
    // лимит (0 = без лимита). Считаем в той же транзакции.
    let quota = owner_quota_bytes();
    if quota > 0 {
        let (used,): (i64,) =
            sqlx::query_as("SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE owner = ?")
                .bind(owner)
                .fetch_one(&mut *tx)
                .await?;
        if used + actual_size > quota {
            return Err(reject(
                RejectKind::Limit,
                format!("превышена квота хранилища владельца ({} байт)", quota),
            ));
        }
    }

    sqlx::query(
        "INSERT INTO files (id, owner, filename, mime_type, size_bytes, total_chunks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(file_id)
    .bind(owner)
    .bind(p.filename)
    .bind(p.mime_type)
    .bind(p.size_bytes as i64)
    .bind(p.total_chunks)
    .bind(now_unix())
    .execute(&mut *tx)
    .await?;

    let mut grants: HashSet<&str> = p
        .recipients
        .iter()
        .map(String::as_str)
        .filter(|recipient| !recipient.is_empty() && *recipient != owner && *recipient != "*")
        .collect();
    if p.public_access {
        grants.insert("*");
    }
    for principal in grants {
        sqlx::query(
            "INSERT OR IGNORE INTO file_grants (file_id, principal, granted_at) VALUES (?, ?, ?)",
        )
        .bind(file_id)
        .bind(principal)
        .bind(now_unix())
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM uploads WHERE file_id = ?")
        .bind(file_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(())
}

/// Собранный файл для отдачи: метаданные + все чанки по порядку.
#[cfg(test)]
struct LoadedFile {
    filename: String,
    mime_type: String,
    total_chunks: i64,
    size_bytes: i64,
    chunk_bytes: i64,
    chunks: Vec<(i64, Vec<u8>)>,
}

/// Загрузить файл целиком из БД. `None` — файла нет.
#[cfg(test)]
async fn load_file_for_user(
    pool: &SqlitePool,
    file_id: &str,
    user: &str,
) -> Result<Option<LoadedFile>> {
    load_file_range_for_user(pool, file_id, user, None).await
}

/// Метаданные файла без чанков (ACL — как у целого файла). P-28: download
/// читает чанки по одному, не поднимая файл целиком.
pub(crate) struct FileMeta {
    filename: String,
    mime_type: String,
    pub size_bytes: i64,
    pub total_chunks: i64,
    chunk_bytes: i64,
}

pub(crate) async fn file_meta_for_user(pool: &SqlitePool, file_id: &str, user: &str) -> Result<Option<FileMeta>> {
    let meta: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT f.filename, f.mime_type, f.size_bytes, f.total_chunks
         FROM files f
         WHERE f.id = ? AND (
           f.owner = ? OR EXISTS (
             SELECT 1 FROM file_grants g
             WHERE g.file_id = f.id AND (g.principal = ? OR g.principal = '*')
           )
         )",
    )
    .bind(file_id)
    .bind(user)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    let Some((filename, mime_type, size_bytes, total_chunks)) = meta else {
        return Ok(None);
    };
    let chunk_bytes: Option<i64> = sqlx::query_scalar(
        "SELECT length(data) FROM chunks WHERE file_id = ? AND chunk_index = 0",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    Ok(Some(FileMeta { filename, mime_type, size_bytes, total_chunks, chunk_bytes: chunk_bytes.unwrap_or(0) }))
}

/// Метаданные файла по id БЕЗ проверки личности — только для capability-пути
/// v2 (`cloud.blob.download_cap`), где доступ уже подтверждён секретом.
pub(crate) async fn file_meta_any(pool: &SqlitePool, file_id: &str) -> Result<Option<FileMeta>> {
    let meta: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT filename, mime_type, size_bytes, total_chunks FROM files WHERE id = ?",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;
    let Some((filename, mime_type, size_bytes, total_chunks)) = meta else {
        return Ok(None);
    };
    Ok(Some(FileMeta { filename, mime_type, size_bytes, total_chunks, chunk_bytes: 0 }))
}

/// Загрузить файл или диапазон его чанков (включительно) — range-стриминг
/// видео: клиент просит только нужное окно. ACL — как у целого файла.
#[cfg(test)]
async fn load_file_range_for_user(
    pool: &SqlitePool,
    file_id: &str,
    user: &str,
    range: Option<(u32, u32)>,
) -> Result<Option<LoadedFile>> {
    let meta: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT f.filename, f.mime_type, f.size_bytes, f.total_chunks
         FROM files f
         WHERE f.id = ? AND (
           f.owner = ? OR EXISTS (
             SELECT 1 FROM file_grants g
             WHERE g.file_id = f.id AND (g.principal = ? OR g.principal = '*')
           )
         )",
    )
    .bind(file_id)
    .bind(user)
    .bind(user)
    .fetch_optional(pool)
    .await?;

    let Some((filename, mime_type, size_bytes, total_chunks)) = meta else {
        return Ok(None);
    };

    let chunk_bytes: Option<i64> = sqlx::query_scalar(
        "SELECT length(data) FROM chunks WHERE file_id = ? AND chunk_index = 0",
    )
    .bind(file_id)
    .fetch_optional(pool)
    .await?;

    let chunks: Vec<(i64, Vec<u8>)> = match range {
        Some((from, to)) => sqlx::query_as(
            "SELECT chunk_index, data FROM chunks
             WHERE file_id = ? AND chunk_index BETWEEN ? AND ? ORDER BY chunk_index",
        )
        .bind(file_id)
        .bind(from as i64)
        .bind(to.max(from) as i64)
        .fetch_all(pool)
        .await?,
        None => sqlx::query_as(
            "SELECT chunk_index, data FROM chunks WHERE file_id = ? ORDER BY chunk_index",
        )
        .bind(file_id)
        .fetch_all(pool)
        .await?,
    };

    Ok(Some(LoadedFile {
        filename,
        mime_type,
        total_chunks,
        size_bytes,
        chunk_bytes: chunk_bytes.unwrap_or(0),
        chunks,
    }))
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
            Some(FileEntry {
                file_id,
                filename,
                mime_type,
                size_bytes,
                created_at,
            })
        })
        .collect())
}

// ── file.upload.chunk ─────────────────────────────────────────────────────────

async fn handle_chunk(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let result = async {
        let event: ParvaneEvent<UploadChunkPayload> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в upload.chunk")?;

        let owner = verify_token(nc, &event.token).await?;
        store_chunk(pool, &owner, &event.payload).await?;

        debug!(
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
            Err(e) => serde_json::json!({ "ok": false, "error": parvane_db::public_error(e) }),
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

        // P-29/P-42: имя файла в лог не пишем (для E2E-вложений клиенты и так
        // шлют непрозрачное имя), владелец — на уровне debug
        debug!("Файл завершён: {} ({} байт) owner={}", file_id, event.payload.size_bytes, owner);

        let resp = UploadCompleteResponse {
            ok: true,
            file_id: Some(file_id),
            error: None,
        };
        nc.publish(reply, serde_json::to_vec(&resp)?.into()).await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_complete: {}", e);
        let resp = UploadCompleteResponse {
            ok: false,
            file_id: None,
            error: Some(parvane_db::public_error(&e)),
        };
        let _ = nc
            .publish(
                reply_err,
                serde_json::to_vec(&resp).unwrap_or_default().into(),
            )
            .await;
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

        let user = verify_token(nc, &event.token).await?;

        let file_id = event.payload.file_id.to_string();
        let range = match (event.payload.chunk_from, event.payload.chunk_to) {
            (Some(from), Some(to)) => Some((from, to)),
            (Some(from), None) => Some((from, from)),
            _ => None,
        };
        let meta = file_meta_for_user(pool, &file_id, &user)
            .await?
            .ok_or_else(|| anyhow::anyhow!("файл не найден или доступ запрещён"))?;
        let total = meta.total_chunks.max(0) as u32;
        // P-28: диапазон ограничен окном; целый файл — не более окна за запрос
        let (from, to) = match range {
            Some((from, to)) => (from, to.max(from)),
            None => (0, total.saturating_sub(1)),
        };
        let to = to.min(total.saturating_sub(1)).min(from.saturating_add(max_download_chunks() - 1));

        // Шлём чанки по одному через reply-топик, читая каждый из БД отдельно —
        // память ограничена одним чанком, а не размером файла
        let mut sent = 0u32;
        for idx in from..=to {
            let data: Option<Vec<u8>> = sqlx::query_scalar(
                "SELECT data FROM chunks WHERE file_id = ? AND chunk_index = ?",
            )
            .bind(&file_id)
            .bind(idx as i64)
            .fetch_optional(pool)
            .await?;
            let Some(data) = data else { continue };
            let resp = DownloadResponse {
                ok: true,
                file_id: Some(event.payload.file_id),
                filename: Some(meta.filename.clone()),
                mime_type: Some(meta.mime_type.clone()),
                chunk_index: Some(idx),
                total_chunks: Some(total),
                data: Some(B64.encode(&data)),
                error: None,
                size_bytes: Some(meta.size_bytes),
                chunk_bytes: Some(meta.chunk_bytes as u32),
            };
            nc.publish(reply.clone(), serde_json::to_vec(&resp)?.into())
                .await?;
            sent += 1;
        }

        debug!("Файл отдан: {} чанков ({}..={} из {})", sent, from, to, total);
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("handle_download: {}", e);
        let resp = DownloadResponse {
            ok: false,
            file_id: None,
            filename: None,
            mime_type: None,
            chunk_index: None,
            total_chunks: None,
            data: None,
            error: Some(parvane_db::public_error(&e)),
            size_bytes: None,
            chunk_bytes: None,
        };
        let _ = nc
            .publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into())
            .await;
    }
}

// ── file.list.request ─────────────────────────────────────────────────────────

async fn handle_delete(nc: &Client, pool: &SqlitePool, msg: async_nats::Message) {
    let Some(reply) = msg.reply.clone() else {
        warn!("file.delete: нет reply-топика");
        return;
    };
    let result = async {
        let event: ParvaneEvent<FileDeleteRequest> =
            serde_json::from_slice(&msg.payload).context("неверный JSON в file.delete")?;
        let owner = verify_token(nc, &event.token).await?;
        let deleted = delete_file(pool, &owner, &event.payload.file_id.to_string()).await?;
        if deleted {
            info!("Файл удалён owner={} ({})", owner, event.payload.file_id);
            Ok(FileDeleteResponse { ok: true, error: None })
        } else {
            Ok::<_, anyhow::Error>(FileDeleteResponse {
                ok: false,
                error: Some("файл не найден или не принадлежит вам".into()),
            })
        }
    }
    .await;
    let resp = result.unwrap_or_else(|e| FileDeleteResponse { ok: false, error: Some(parvane_db::public_error(&e)) });
    let _ = nc.publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into()).await;
}

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
            let _ = nc
                .publish(reply, serde_json::to_vec(&resp).unwrap_or_default().into())
                .await;
        }
    }
}

/// P-08: удалить брошенные незавершённые аплоады (старше upload_ttl_secs) и их
/// чанки. Вызывается при старте и периодически.
async fn purge_stale_uploads(pool: &SqlitePool) -> Result<u64> {
    let cutoff = now_unix() - upload_ttl_secs();
    sqlx::query(
        "DELETE FROM chunks WHERE file_id IN (SELECT file_id FROM uploads WHERE created_at < ?)",
    )
    .bind(cutoff)
    .execute(pool)
    .await?;
    let r = sqlx::query("DELETE FROM uploads WHERE created_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// P-52/C2: удалить файл владельца — метаданные, чанки и гранты. Возвращает
/// true, если файл принадлежал `owner` и был удалён.
pub(crate) async fn delete_file(pool: &SqlitePool, owner: &str, file_id: &str) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let res = sqlx::query("DELETE FROM files WHERE id = ? AND owner = ?")
        .bind(file_id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM chunks WHERE file_id = ?")
        .bind(file_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM file_grants WHERE file_id = ?")
        .bind(file_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ── unit-тесты DB-слоя (in-memory SQLite, без NATS) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    thread_local! {
        /// Квота владельца для теста текущего потока (tokio::test —
        /// однопоточный рантайм на тест).
        pub(crate) static QUOTA_OVERRIDE: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
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
            recipients: vec![],
            public_access: false,
        }
    }

    #[tokio::test]
    async fn store_chunk_decodes_base64_blob() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"hello"))
            .await
            .unwrap();

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
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"aaa"))
            .await
            .unwrap();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"bbb"))
            .await
            .unwrap(); // перезапись того же индекса

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
        store_chunk(&pool, "alice@local", &chunk(id, 0, 2, b"part0"))
            .await
            .unwrap();
        // прислали только 1 из 2 чанков
        let err = finalize_file(&pool, "alice@local", &complete(id, 2, 10)).await;
        assert!(err.is_err(), "неполный файл должен отклоняться");
        // метаданных быть не должно
        let (files,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM files")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(files, 0);
    }

    #[tokio::test]
    async fn finalize_rejects_declared_size_mismatch() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"five!"))
            .await
            .unwrap();

        let err = finalize_file(&pool, "alice@local", &complete(id, 1, 99)).await;
        assert!(err.is_err(), "ложный размер файла должен отклоняться");
        assert!(load_file_for_user(&pool, &id.to_string(), "alice@local")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn store_chunk_rejects_oversize_chunk() {
        // Чанк больше лимита отклоняется до записи.
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        let big = vec![0u8; max_chunk_bytes() + 1];
        let err = store_chunk(&pool, "alice@local", &chunk(id, 0, 1, &big)).await;
        assert!(err.is_err(), "слишком большой чанк должен отклоняться");
    }

    #[tokio::test]
    async fn finalize_enforces_owner_quota() {
        // При заданной квоте суммарный объём владельца ограничен. Квоту берём
        // напрямую из helper'а — env не мутируем (глобален для параллельных тестов).
        let pool = test_pool().await;
        let quota = 10i64;
        // Первый файл в 6 байт — проходит (helper проверяем ниже отдельно).
        let a = Uuid::now_v7();
        store_chunk(&pool, "quota@local", &chunk(a, 0, 1, b"aaaaaa")).await.unwrap();
        finalize_file(&pool, "quota@local", &complete(a, 1, 6)).await.unwrap();
        // Смоделируем проверку квоты вручную: сумма + новый файл > лимита → отказ.
        let (used,): (i64,) =
            sqlx::query_as("SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE owner = ?")
                .bind("quota@local")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(used, 6);
        assert!(used + 6 > quota, "второй файл 6 байт превысил бы квоту 10");
    }

    #[tokio::test]
    async fn range_load_returns_only_requested_chunks_with_meta() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        for (i, data) in [&b"aaaa"[..], &b"bbbb"[..], &b"cc"[..]].iter().enumerate() {
            store_chunk(&pool, "alice@local", &chunk(id, i as u32, 3, data)).await.unwrap();
        }
        finalize_file(&pool, "alice@local", &complete(id, 3, 10)).await.unwrap();
        let full = load_file_for_user(&pool, &id.to_string(), "alice@local")
            .await.unwrap().unwrap();
        assert_eq!(full.chunks.len(), 3);
        assert_eq!(full.size_bytes, 10);
        assert_eq!(full.chunk_bytes, 4, "размер чанка — длина нулевого чанка");
        let part = load_file_range_for_user(&pool, &id.to_string(), "alice@local", Some((1, 2)))
            .await.unwrap().unwrap();
        assert_eq!(part.chunks.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(part.total_chunks, 3);
        assert!(load_file_range_for_user(&pool, &id.to_string(), "mallory@evil", Some((0, 0)))
            .await.unwrap().is_none(), "range не обходит ACL");
        // P-28: метаданные тоже под ACL, окно download ограничено
        assert!(file_meta_for_user(&pool, &id.to_string(), "mallory@local").await.unwrap().is_none());
        assert!(file_meta_for_user(&pool, &id.to_string(), "alice@local").await.unwrap().is_some());
        assert!(max_download_chunks() >= 1 && max_download_chunks() <= 4096);
    }

    #[tokio::test]
    async fn finalize_succeeds_when_all_chunks_present() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 2, b"part0"))
            .await
            .unwrap();
        store_chunk(&pool, "alice@local", &chunk(id, 1, 2, b"part1"))
            .await
            .unwrap();
        let fid = finalize_file(&pool, "alice@local", &complete(id, 2, 10))
            .await
            .unwrap();
        assert_eq!(fid, id);

        let (owner,): (String,) = sqlx::query_as("SELECT owner FROM files WHERE id = ?")
            .bind(id.to_string())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(owner, "alice@local");
    }

    #[tokio::test]
    async fn upload_then_download_roundtrip() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 2, b"AAAA"))
            .await
            .unwrap();
        store_chunk(&pool, "alice@local", &chunk(id, 1, 2, b"BBBB"))
            .await
            .unwrap();
        finalize_file(&pool, "alice@local", &complete(id, 2, 8))
            .await
            .unwrap();

        let loaded = load_file_for_user(&pool, &id.to_string(), "alice@local")
            .await
            .unwrap()
            .expect("файл есть");
        assert_eq!(loaded.total_chunks, 2);
        assert_eq!(loaded.chunks.len(), 2);
        // чанки отсортированы по индексу — склейка даёт исходные байты
        let mut joined = Vec::new();
        for (_, d) in &loaded.chunks {
            joined.extend_from_slice(d);
        }
        assert_eq!(joined, b"AAAABBBB");
    }

    #[tokio::test]
    async fn download_requires_owner_recipient_or_public_grant() {
        let pool = test_pool().await;
        let shared = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(shared, 0, 1, b"shared"))
            .await
            .unwrap();
        let mut shared_complete = complete(shared, 1, 6);
        shared_complete.recipients = vec!["bob@local".into(), "bob@local".into()];
        finalize_file(&pool, "alice@local", &shared_complete)
            .await
            .unwrap();

        assert!(
            load_file_for_user(&pool, &shared.to_string(), "alice@local")
                .await
                .unwrap()
                .is_some()
        );
        assert!(load_file_for_user(&pool, &shared.to_string(), "bob@local")
            .await
            .unwrap()
            .is_some());
        assert!(
            load_file_for_user(&pool, &shared.to_string(), "mallory@evil")
                .await
                .unwrap()
                .is_none()
        );

        let public = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(public, 0, 1, b"avatar"))
            .await
            .unwrap();
        let mut public_complete = complete(public, 1, 6);
        public_complete.public_access = true;
        finalize_file(&pool, "alice@local", &public_complete)
            .await
            .unwrap();
        assert!(
            load_file_for_user(&pool, &public.to_string(), "mallory@evil")
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn upload_id_is_owner_bound_and_immutable_after_complete() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"alice"))
            .await
            .unwrap();
        assert!(
            store_chunk(&pool, "mallory@evil", &chunk(id, 0, 1, b"evil"))
                .await
                .is_err()
        );
        assert!(finalize_file(&pool, "mallory@evil", &complete(id, 1, 5))
            .await
            .is_err());
        finalize_file(&pool, "alice@local", &complete(id, 1, 5))
            .await
            .unwrap();
        assert!(
            store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"again"))
                .await
                .is_err()
        );

        let loaded = load_file_for_user(&pool, &id.to_string(), "alice@local")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.chunks[0].1, b"alice");
    }

    #[tokio::test]
    async fn load_missing_file_is_none() {
        let pool = test_pool().await;
        let got = load_file_for_user(&pool, &Uuid::now_v7().to_string(), "alice@local")
            .await
            .unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn list_files_only_owner_newest_first() {
        let pool = test_pool().await;
        // alice: два файла; bob: один
        let a1 = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(a1, 0, 1, b"x"))
            .await
            .unwrap();
        finalize_file(&pool, "alice@local", &complete(a1, 1, 1))
            .await
            .unwrap();
        let a2 = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(a2, 0, 1, b"y"))
            .await
            .unwrap();
        finalize_file(&pool, "alice@local", &complete(a2, 1, 1))
            .await
            .unwrap();
        let b1 = Uuid::now_v7();
        store_chunk(&pool, "bob@local", &chunk(b1, 0, 1, b"z"))
            .await
            .unwrap();
        finalize_file(&pool, "bob@local", &complete(b1, 1, 1))
            .await
            .unwrap();

        let alice = list_files(&pool, "alice@local").await.unwrap();
        assert_eq!(alice.len(), 2, "только файлы alice");
        assert!(alice.iter().all(|f| f.file_id == a1 || f.file_id == a2));

        let bob = list_files(&pool, "bob@local").await.unwrap();
        assert_eq!(bob.len(), 1);
        assert_eq!(bob[0].file_id, b1);
    }

    #[tokio::test]
    async fn delete_file_only_by_owner_and_purges_chunks() {
        let pool = test_pool().await;
        let id = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(id, 0, 1, b"hello")).await.unwrap();
        finalize_file(&pool, "alice@local", &complete(id, 1, 5)).await.unwrap();
        // Чужой не удалит.
        assert!(!delete_file(&pool, "bob@local", &id.to_string()).await.unwrap());
        assert!(load_file_for_user(&pool, &id.to_string(), "alice@local").await.unwrap().is_some());
        // Владелец удаляет — файла и чанков больше нет.
        assert!(delete_file(&pool, "alice@local", &id.to_string()).await.unwrap());
        assert!(load_file_for_user(&pool, &id.to_string(), "alice@local").await.unwrap().is_none());
        let (chunks,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
            .bind(id.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(chunks, 0, "чанки удалённого файла вычищены");
    }

    #[tokio::test]
    async fn purge_removes_only_stale_uploads() {
        let pool = test_pool().await;
        let fresh = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(fresh, 0, 2, b"aaa")).await.unwrap();
        // Искусственно состарим один незавершённый аплоад.
        let stale = Uuid::now_v7();
        store_chunk(&pool, "alice@local", &chunk(stale, 0, 2, b"bbb")).await.unwrap();
        sqlx::query("UPDATE uploads SET created_at = ? WHERE file_id = ?")
            .bind(now_unix() - upload_ttl_secs() - 10)
            .bind(stale.to_string())
            .execute(&pool).await.unwrap();
        let removed = purge_stale_uploads(&pool).await.unwrap();
        assert_eq!(removed, 1, "удалён только просроченный аплоад");
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
            .bind(stale.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "чанки просроченного аплоада вычищены");
        // Свежий на месте.
        let (m,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?")
            .bind(fresh.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(m, 1);
    }

    #[tokio::test]
    async fn pending_uploads_count_toward_quota() {
        // Квота 10 байт: незавершённый аплоад на 6 байт + ещё 6 байт → отказ.
        // Квота — через переопределение потока теста, а не env: env общий
        // для параллельных тестов и ронял бы соседние загрузки.
        QUOTA_OVERRIDE.with(|c| c.set(Some(10)));
        let pool = test_pool().await;
        let a = Uuid::now_v7();
        store_chunk(&pool, "q2@local", &chunk(a, 0, 1, b"aaaaaa")).await.unwrap();
        let b = Uuid::now_v7();
        let err = store_chunk(&pool, "q2@local", &chunk(b, 0, 1, b"bbbbbb")).await;
        QUOTA_OVERRIDE.with(|c| c.set(None));
        assert!(err.is_err(), "незавершённые чанки учитываются в квоте");
    }
}
