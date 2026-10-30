//! Методы протокола v2 в cloud (spec 007, T052 + cloud-часть T123).
//!
//! Блобы лежат в тех же v1-таблицах (`files`, `chunks`, `uploads`,
//! `file_grants`): файл, загруженный через v2, v1-клиент скачивает по
//! `file_id` — это нужно на смешанный период. Лимиты и ACL — общие с v1
//! (`store_chunk_raw`, `finalize_upload`, `file_meta_for_user`). Новое только
//! одно: SHA-256 capability вложения (D-08) — в отдельной
//! `<PARVANE_DB_PATH>-v2.db` (contracts/migration.md, «Хранение v2»).
//!
//! CALL-методы отвечают одним `ShardResponse`. STREAM-методы
//! (`cloud.blob.download`, `cloud.blob.download_cap`) шлют в reply-subject
//! последовательность: сначала `ShardResponse` (метаданные
//! `DownloadResponse`/`DownloadCapResponse` или ошибка — тогда поток на этом
//! заканчивается), затем `ShardStreamChunk{index, last, data}` по одному на
//! чанк файла (index — номер чанка в файле) до `last = true`. Сбой посреди
//! потока — последний кадр `ShardStreamChunk{last: true, error}`.
//!
//! Ссылки облака для людей без аккаунта (spec 022, `cloud.link.*`) — в
//! подмодуле `links`: копии ссылок лежат в тех же таблицах блобов, но методам
//! `cloud.blob.*` не видны (`links::is_link_blob`).
//!
//! Подписчик на каждый метод роли `cloud` — ровно один (`run`), поэтому
//! `parvane_v2rt::serve` (он отвечает только одним сообщением) здесь не
//! используется; кодирование ответов и разбор тела — из `parvane_v2rt`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use async_nats::Client;
use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::cloud::v1::{
    BlobBucket, BucketUsage, CopyRequest, CopyResponse, DeleteRequest, DeleteResponse, DownloadCapRequest,
    DownloadCapResponse, DownloadRequest, DownloadResponse, UploadChunkRequest, UploadChunkResponse,
    UploadCompleteRequest, UploadStatusRequest, UploadStatusResponse, UsageRequest, UsageResponse,
    UploadCompleteResponse, Visibility,
};
use parvane_protocol::pb::parvane::core::v2::{
    shard_response, Error, ErrorCode, MethodKind, ShardRequest, ShardResponse, ShardStreamChunk,
};
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, error_reply, ok_reply};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;
use tracing::{debug, error, info, warn};

pub(crate) mod links;

use super::{
    delete_blob_any, delete_file, file_meta_any, file_meta_for_user, finalize_upload, handler_concurrency, handler_per_user,
    max_chunk_bytes, max_download_chunks, max_file_bytes, max_total_chunks, now_unix,
    owner_quota_bytes, release_free_pages, store_chunk_raw, used_bytes, FileMeta, Finalize, RejectKind,
    Rejected, BUCKETS, BUCKET_DRIVE, BUCKET_MEDIA,
};

/// Сколько чанков копируется одной транзакцией (`cloud.blob.copy`).
const COPY_BATCH_CHUNKS: i64 = 64;

/// Предел данных одного кадра потока и чанка загрузки (`max_len` схемы).
const FRAME_DATA_MAX: usize = 716_800;
/// Длина capability и её хэша (SHA-256).
const CAP_LEN: usize = 32;
/// Метаданных имени/типа у v2-блоба нет (они внутри E2E-сообщения); v1-клиент
/// видит непрозрачный объект.
const V2_MIME: &str = "application/octet-stream";

pub(crate) struct V2Ctx {
    /// Основная (v1) БД: блобы, загрузки, гранты.
    pub pool: SqlitePool,
    /// `<PARVANE_DB_PATH>-v2.db`: хэши capability, ссылки облака.
    pub pool_v2: SqlitePool,
    /// Состояние ссылок в памяти: частота по ссылке, потоки скачивания.
    pub links: links::Runtime,
    /// Серверные копии (`cloud.blob.copy`, `cloud.link.add`) по владельцам: начало окна и скопированные байты.
    copy_budget: Mutex<HashMap<String, (Instant, u64)>>,
}

/// Окно учёта серверных копий на владельца.
const COPY_WINDOW: Duration = Duration::from_secs(3600);
/// Пауза между пакетами копии: замок записи SQLite не занят непрерывно.
const COPY_BATCH_PAUSE: Duration = Duration::from_millis(5);

/// Сколько байт серверных копий владелец может заказать за окно (CLD: копия читает и пишет столько же).
fn copy_bytes_per_hour() -> u64 {
    std::env::var("PARVANE_CLOUD_COPY_BYTES_PER_HOUR").ok().and_then(|v| v.parse().ok()).unwrap_or(20 * 1024 * 1024 * 1024)
}

impl V2Ctx {
    pub(crate) fn new(pool: SqlitePool, pool_v2: SqlitePool) -> Self {
        V2Ctx { pool, pool_v2, links: links::Runtime::new(), copy_budget: Mutex::new(HashMap::new()) }
    }

    /// Списать `size` байт из часового бюджета серверных копий владельца; сверх предела — `RATE_LIMITED`.
    fn charge_copy(&self, owner: &str, size: u64, now: Instant, limit: u64) -> Result<(), ErrorCode> {
        let mut map = self.copy_budget.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 10_000 {
            map.retain(|_, (start, _)| now.saturating_duration_since(*start) < COPY_WINDOW);
        }
        let e = map.entry(owner.to_string()).or_insert((now, 0));
        if now.saturating_duration_since(e.0) >= COPY_WINDOW {
            *e = (now, 0);
        }
        if e.1.saturating_add(size) > limit {
            return Err(ErrorCode::RateLimited);
        }
        e.1 += size;
        Ok(())
    }
}

/// Отказ обработчика: код и, для отказов по частоте, через сколько повторить.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub code: ErrorCode,
    pub retry_after_ms: u32,
}

impl From<ErrorCode> for Refusal {
    fn from(code: ErrorCode) -> Self {
        Refusal { code, retry_after_ms: 0 }
    }
}

fn refusal_reply(r: Refusal) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Error(Error { code: r.code as i32, retry_after_ms: r.retry_after_ms })) }
        .encode_to_vec()
}

/// Путь v2-БД рядом с основной.
pub(crate) fn db_path(v1_path: &str) -> String {
    format!("{v1_path}-v2.db")
}

/// Подписаться на все методы роли `cloud` из реестра и обслуживать их.
/// Смена ника (spec 026): `v2.internal.rename.cloud` от identity — владелец блобов, загрузок и ссылок — новый
/// адрес. Запрос с ответом; повтор ничего не меняет.
async fn serve_rename(nc: Client, ctx: Arc<V2Ctx>) {
    use parvane_protocol::pb::parvane::core::v2::{RenameAck, RenameNotice};
    use parvane_protocol::registry_gen::INTERNAL_RENAME_CLOUD;
    let mut sub = match nc.subscribe(INTERNAL_RENAME_CLOUD.to_string()).await {
        Ok(s) => s,
        Err(e) => {
            error!("cloud: подписка {} не удалась: {}", INTERNAL_RENAME_CLOUD, e);
            return;
        }
    };
    while let Some(msg) = sub.next().await {
        let Some(reply) = msg.reply.clone() else { continue };
        let ok = match parvane_protocol::codec::decode_checked::<RenameNotice>(&msg.payload, parvane_protocol::limits::Origin::Server) {
            Ok(n) if n.purge => match purge(&ctx, &n.old_address).await {
                Ok(()) => true,
                Err(e) => {
                    error!("cloud: стирание аккаунта: {}", e);
                    false
                }
            },
            Ok(n) => match rename(&ctx, &n.old_address, &n.new_address).await {
                Ok(()) => true,
                Err(e) => {
                    error!("cloud: перенос ника: {}", e);
                    false
                }
            },
            Err(_) => false,
        };
        let _ = nc.publish(reply, RenameAck { ok }.encode_to_vec().into()).await;
    }
}

async fn rename(ctx: &V2Ctx, old: &str, new: &str) -> Result<(), sqlx::Error> {
    let mut tx = ctx.pool.begin().await?;
    sqlx::query("UPDATE files SET owner = ? WHERE owner = ?").bind(new).bind(old).execute(&mut *tx).await?;
    sqlx::query("UPDATE uploads SET owner = ? WHERE owner = ?").bind(new).bind(old).execute(&mut *tx).await?;
    sqlx::query("UPDATE OR IGNORE file_grants SET principal = ? WHERE principal = ?").bind(new).bind(old).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM file_grants WHERE principal = ?").bind(old).execute(&mut *tx).await?;
    tx.commit().await?;
    sqlx::query("UPDATE links SET owner = ? WHERE owner = ?").bind(new).bind(old).execute(&ctx.pool_v2).await?;
    info!("cloud: ник перенесён");
    Ok(())
}

/// Удаление аккаунта (spec 027): его блобы (медиа чатов, облако, копии ссылок) с чанками, незавершённые загрузки,
/// ссылки и его гранты на чужие файлы. Место возвращается диску ежечасным `incremental_vacuum`.
async fn purge(ctx: &V2Ctx, address: &str) -> Result<(), sqlx::Error> {
    let files: Vec<(String,)> = sqlx::query_as("SELECT id FROM files WHERE owner = ? UNION SELECT file_id FROM uploads WHERE owner = ?")
        .bind(address)
        .bind(address)
        .fetch_all(&ctx.pool)
        .await?;
    let mut tx = ctx.pool.begin().await?;
    for (id,) in &files {
        sqlx::query("DELETE FROM chunks WHERE file_id = ?").bind(id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM file_grants WHERE file_id = ?").bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM uploads WHERE owner = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM files WHERE owner = ?").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM file_grants WHERE principal = ?").bind(address).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut tx = ctx.pool_v2.begin().await?;
    for (id,) in &files {
        sqlx::query("DELETE FROM blob_caps WHERE file_id = ?").bind(id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM link_blobs WHERE link_key IN (SELECT key FROM links WHERE owner = ?)").bind(address).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM links WHERE owner = ?").bind(address).execute(&mut *tx).await?;
    tx.commit().await?;
    info!("cloud: аккаунт стёрт ({} файлов)", files.len());
    Ok(())
}

pub(crate) async fn run(nc: Client, ctx: Arc<V2Ctx>) -> Result<()> {
    tokio::spawn(serve_rename(nc.clone(), ctx.clone()));
    let methods = parvane_v2rt::methods_of("cloud");
    let mut streams = Vec::new();
    for m in &methods {
        let m: &'static MethodInfo = m;
        let sub = nc.subscribe(m.subject.to_string()).await?;
        streams.push(sub.map(move |msg| (m, msg)).boxed());
    }
    let mut all = futures::stream::select_all(streams);
    let sem = Arc::new(tokio::sync::Semaphore::new(handler_concurrency().max(1)));
    // CLD-05: доля одного аккаунта — загрузка идёт окном в три чанка на файл, несколько файлов разом
    let owner_slots = parvane_v2rt::OwnerSlots::new(handler_per_user());
    tokio::spawn(async move {
        while let Some((m, msg)) = all.next().await {
            let Some(reply) = msg.reply.clone() else {
                warn!("v2 {}: запрос без reply", m.name);
                continue;
            };
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let (nc, ctx, owner_slots) = (nc.clone(), ctx.clone(), owner_slots.clone());
            tokio::spawn(async move {
                let _permit = permit;
                let emit = |bytes: Vec<u8>| {
                    let (nc, reply) = (nc.clone(), reply.clone());
                    async move {
                        match nc.publish(reply, bytes.into()).await {
                            Ok(()) => true,
                            Err(e) => {
                                error!("v2 {}: ответ не отправлен: {e}", m.name);
                                false
                            }
                        }
                    }
                };
                let req = match decode_checked::<ShardRequest>(&msg.payload, Origin::Server) {
                    Ok(req) if req.method == m.name => req,
                    Ok(_) => {
                        emit(error_reply(ErrorCode::Invalid)).await;
                        return;
                    }
                    Err(e) => {
                        warn!("v2 {}: битый ShardRequest: {e}", m.name);
                        emit(error_reply(ErrorCode::Invalid)).await;
                        return;
                    }
                };
                let Some(_owner_slot) = owner_slots.try_acquire(&req.user) else {
                    emit(parvane_v2rt::rate_limited_reply(parvane_v2rt::OWNER_BUSY_RETRY_MS)).await;
                    return;
                };
                if m.kind == MethodKind::Stream as i32 {
                    // Анонимные скачивания по ссылкам — не больше своего числа
                    // потоков разом, иначе они заняли бы все обработчики шарда.
                    let _link_stream = if m.name == links::DOWNLOAD || (m.name == "cloud.blob.download_cap" && req.user.is_empty()) {
                        match ctx.links.stream_slot() {
                            Ok(slot) => Some(slot),
                            Err(r) => {
                                emit(refusal_reply(r)).await;
                                return;
                            }
                        }
                    } else {
                        None
                    };
                    match plan(&ctx, m, &req).await {
                        Ok(p) => stream_blob(&ctx.pool, &p, emit).await,
                        Err(r) => {
                            emit(refusal_reply(r)).await;
                        }
                    }
                } else {
                    let out = match call(&ctx, m, &req).await {
                        Ok(b) => ok_reply(b),
                        Err(r) => refusal_reply(r),
                    };
                    emit(out).await;
                }
            });
        }
    });
    info!("cloud: методы v2 подключены ({} шт.)", methods.len());
    Ok(())
}

async fn call(ctx: &V2Ctx, m: &'static MethodInfo, req: &ShardRequest) -> Result<Vec<u8>, Refusal> {
    let out = match m.name {
        "cloud.blob.upload_chunk" => upload_chunk(ctx, req).await,
        "cloud.blob.upload_complete" => upload_complete(ctx, req).await,
        "cloud.blob.delete" => delete(ctx, req).await,
        "cloud.blob.usage" => usage(ctx, req).await,
        "cloud.blob.upload_status" => upload_status(ctx, req).await,
        "cloud.blob.copy" => copy(ctx, req).await,
        "cloud.link.create" => links::create(ctx, req).await,
        "cloud.link.add" => links::add(ctx, req).await,
        "cloud.link.publish" => links::publish(ctx, req).await,
        "cloud.link.list" => links::list(ctx, req).await,
        "cloud.link.revoke" => links::revoke(ctx, req).await,
        "cloud.link.extend" => links::extend(ctx, req).await,
        "cloud.link.get" => return links::get(ctx, req).await,
        _ => Err(ErrorCode::Unavailable),
    };
    out.map_err(Refusal::from)
}

async fn plan(ctx: &V2Ctx, m: &'static MethodInfo, req: &ShardRequest) -> Result<Plan, Refusal> {
    match m.name {
        "cloud.blob.download" => plan_download(ctx, req).await.map_err(Refusal::from),
        "cloud.blob.download_cap" => plan_download_cap(ctx, req).await.map_err(Refusal::from),
        links::DOWNLOAD => links::plan_download(ctx, req).await,
        _ => Err(ErrorCode::Unavailable.into()),
    }
}

// ── общие помощники ──────────────────────────────────────────────────────────

/// Владелец ID-метода — пользователь сессии (JWT проверил gateway).
fn owner(req: &ShardRequest) -> Result<&str, ErrorCode> {
    if req.user.is_empty() {
        return Err(ErrorCode::Forbidden);
    }
    Ok(&req.user)
}

/// id загрузки/файла — UUID; в БД — каноническая строка (как пишет v1).
fn parse_id(s: &str) -> Result<String, ErrorCode> {
    uuid::Uuid::parse_str(s).map(|u| u.to_string()).map_err(|_| ErrorCode::Invalid)
}

/// Ошибка хранилища → код клиенту. Отказы по правилам (`Rejected`) — в debug,
/// сбои БД — в error и наружу только `UNAVAILABLE`.
fn store_code(what: &str, e: anyhow::Error) -> ErrorCode {
    match e.downcast_ref::<Rejected>() {
        Some(r) => {
            debug!("v2 {what}: отказ: {r}");
            match r.kind {
                RejectKind::Invalid => ErrorCode::Invalid,
                RejectKind::Forbidden => ErrorCode::Forbidden,
                RejectKind::NotFound => ErrorCode::NotFound,
                RejectKind::Limit => ErrorCode::Limit,
            }
        }
        None => {
            error!("v2 {what}: {e:#}");
            ErrorCode::Unavailable
        }
    }
}

fn db_code(what: &'static str) -> impl FnOnce(sqlx::Error) -> ErrorCode {
    move |e| {
        error!("v2 {what}: {e}");
        ErrorCode::Unavailable
    }
}

// ── cloud.blob.upload_chunk ──────────────────────────────────────────────────

async fn upload_chunk(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: UploadChunkRequest = body(req)?;
    if r.data.len() > max_chunk_bytes().min(FRAME_DATA_MAX) {
        return Err(ErrorCode::Limit);
    }
    if r.index >= max_total_chunks() {
        return Err(ErrorCode::Limit);
    }
    let bucket = bucket_of(r.bucket)?;
    let upload_id = if r.upload_id.is_empty() {
        // Новая загрузка начинается с нулевого чанка; id выдаёт сервер.
        if r.index != 0 {
            return Err(ErrorCode::Invalid);
        }
        uuid::Uuid::now_v7().to_string()
    } else {
        let id = parse_id(&r.upload_id)?;
        // Продолжать можно только свою незавершённую v2-загрузку
        // (total_chunks = 0). Чужая, завершённая или просроченная — NOT_FOUND.
        let claim: Option<(String, i64)> =
            sqlx::query_as("SELECT owner, total_chunks FROM uploads WHERE file_id = ?")
                .bind(&id)
                .fetch_optional(&ctx.pool)
                .await
                .map_err(db_code("upload_chunk"))?;
        match claim {
            Some((o, 0)) if o == owner => {}
            _ => return Err(ErrorCode::NotFound),
        }
        id
    };
    // Bucket существующей загрузки задан её первым чанком; здесь он не меняется.
    store_chunk_raw(&ctx.pool, owner, &upload_id, r.index, 0, r.data, bucket)
        .await
        .map_err(|e| store_code("upload_chunk", e))?;
    Ok(UploadChunkResponse { upload_id }.encode_to_vec())
}

// ── cloud.blob.upload_complete ───────────────────────────────────────────────

async fn upload_complete(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: UploadCompleteRequest = body(req)?;
    let file_id = parse_id(&r.upload_id)?;
    if !r.capability_hash.is_empty() && r.capability_hash.len() != CAP_LEN {
        return Err(ErrorCode::Invalid);
    }
    let public_access = match Visibility::try_from(r.visibility) {
        Ok(Visibility::Public) => true,
        Ok(Visibility::Private | Visibility::Unspecified) => false,
        Err(_) => return Err(ErrorCode::Invalid),
    };
    finalize_upload(
        &ctx.pool,
        owner,
        &Finalize {
            file_id: file_id.clone(),
            claimed_total: 0,
            total_chunks: r.chunks,
            size_bytes: r.size,
            filename: "",
            mime_type: V2_MIME,
            recipients: &[],
            public_access,
        },
    )
    .await
    .map_err(|e| store_code("upload_complete", e))?;
    if !r.capability_hash.is_empty() {
        if let Err(e) = put_cap(&ctx.pool_v2, &file_id, &r.capability_hash).await {
            error!("v2 upload_complete: capability не сохранена: {e}");
            // Компенсация: вложение без capability получателю не выдать, а
            // клиент повторит загрузку — файл-сироту не оставляем.
            if let Err(e) = delete_file(&ctx.pool, owner, &file_id).await {
                error!("v2 upload_complete: откат файла не удался: {e:#}");
            }
            return Err(ErrorCode::Unavailable);
        }
    }
    debug!("v2: файл завершён {} ({} байт)", file_id, r.size);
    Ok(UploadCompleteResponse { file_id }.encode_to_vec())
}

pub(crate) async fn put_cap(pool_v2: &SqlitePool, file_id: &str, cap_hash: &[u8]) -> sqlx::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO blob_caps (file_id, cap_hash, created_at) VALUES (?, ?, ?)")
        .bind(file_id)
        .bind(cap_hash)
        .bind(now_unix())
        .execute(pool_v2)
        .await?;
    Ok(())
}

/// Совпадает ли capability с сохранённым хэшем (сравнение постоянного времени;
/// при отсутствии записи сравнение всё равно выполняется).
pub(crate) async fn cap_matches(pool_v2: &SqlitePool, file_id: &str, capability: &[u8]) -> sqlx::Result<bool> {
    let stored: Option<Vec<u8>> = sqlx::query_scalar("SELECT cap_hash FROM blob_caps WHERE file_id = ?")
        .bind(file_id)
        .fetch_optional(pool_v2)
        .await?;
    let got = Sha256::digest(capability);
    let (expected, present) = match stored {
        Some(h) if h.len() == CAP_LEN => (h, true),
        _ => (vec![0u8; CAP_LEN], false),
    };
    let eq: bool = expected.as_slice().ct_eq(got.as_slice()).into();
    Ok(eq & present)
}

// ── cloud.blob.delete ────────────────────────────────────────────────────────

async fn delete(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: DeleteRequest = body(req)?;
    let file_id = parse_id(&r.file_id)?;
    // Копия ссылки живёт и умирает вместе со ссылкой (`cloud.link.revoke`):
    // удалённая отдельно, она оставила бы ссылку с битым списком.
    if links::is_link_blob(&ctx.pool_v2, &file_id).await.map_err(db_code("delete"))? {
        return Err(ErrorCode::NotFound);
    }
    // Удаляет только владелец; чужой и несуществующий — одинаково NOT_FOUND.
    match delete_file(&ctx.pool, owner, &file_id).await {
        Ok(true) => {}
        Ok(false) => return Err(ErrorCode::NotFound),
        Err(e) => return Err(store_code("delete", e)),
    }
    // Сирота в blob_caps безвредна (download_cap требует строку files), но
    // хэш удалённого файла не держим.
    if let Err(e) = sqlx::query("DELETE FROM blob_caps WHERE file_id = ?")
        .bind(&file_id)
        .execute(&ctx.pool_v2)
        .await
    {
        error!("v2 delete: capability не удалена: {e}");
    }
    release_free_pages(&ctx.pool).await;
    Ok(DeleteResponse {}.encode_to_vec())
}

// ── cloud.blob.usage / upload_status / copy (spec 016) ───────────────────────

fn bucket_of(raw: i32) -> Result<i64, ErrorCode> {
    match BlobBucket::try_from(raw) {
        Ok(BlobBucket::Unspecified) => Ok(BUCKET_MEDIA),
        Ok(BlobBucket::Drive) => Ok(BUCKET_DRIVE),
        Err(_) => Err(ErrorCode::Invalid),
    }
}

async fn usage(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let _: UsageRequest = body(req)?;
    let mut buckets = Vec::new();
    for bucket in BUCKETS {
        let used = used_bytes(&ctx.pool, owner, bucket).await.map_err(db_code("usage"))?;
        buckets.push(BucketUsage {
            bucket: bucket as i32,
            used: used.max(0) as u64,
            quota: owner_quota_bytes(bucket).max(0) as u64,
            max_file: max_file_bytes(bucket).max(0) as u64,
        });
    }
    let links_bytes = links::owner_bytes(&ctx.pool_v2, owner).await.map_err(db_code("usage"))?;
    Ok(UsageResponse { buckets, links_bytes }.encode_to_vec())
}

async fn upload_status(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: UploadStatusRequest = body(req)?;
    let id = parse_id(&r.upload_id)?;
    // Только своя незавершённая v2-загрузка; иначе NOT_FOUND.
    let claim: Option<(String, i64, i64)> =
        sqlx::query_as("SELECT owner, total_chunks, chunks FROM uploads WHERE file_id = ?")
            .bind(&id)
            .fetch_optional(&ctx.pool)
            .await
            .map_err(db_code("upload_status"))?;
    let count = match claim {
        Some((o, 0, count)) if o == owner => count,
        _ => return Err(ErrorCode::NotFound),
    };
    // Клиент шлёт чанки окном, поэтому в середине возможны пропуски: отдаём
    // длину непрерывного начала 0..n-1.
    let (max_index,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(chunk_index), -1) FROM chunks WHERE file_id = ?")
        .bind(&id)
        .fetch_one(&ctx.pool)
        .await
        .map_err(db_code("upload_status"))?;
    let contiguous = if max_index + 1 == count {
        count
    } else {
        let first_gap: Option<i64> = sqlx::query_scalar(
            "SELECT MIN(c.chunk_index + 1) FROM chunks c WHERE c.file_id = ?1
             AND NOT EXISTS (SELECT 1 FROM chunks d WHERE d.file_id = ?1 AND d.chunk_index = c.chunk_index + 1)",
        )
        .bind(&id)
        .fetch_one(&ctx.pool)
        .await
        .map_err(db_code("upload_status"))?;
        let has_zero: Option<i64> = sqlx::query_scalar("SELECT 1 FROM chunks WHERE file_id = ? AND chunk_index = 0")
            .bind(&id)
            .fetch_optional(&ctx.pool)
            .await
            .map_err(db_code("upload_status"))?;
        if has_zero.is_some() { first_gap.unwrap_or(0) } else { 0 }
    };
    let (bytes,): (i64,) =
        sqlx::query_as("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM chunks WHERE file_id = ? AND chunk_index < ?")
            .bind(&id)
            .bind(contiguous)
            .fetch_one(&ctx.pool)
            .await
            .map_err(db_code("upload_status"))?;
    Ok(UploadStatusResponse { chunks: u32::try_from(contiguous).unwrap_or(0), bytes: bytes.max(0) as u64 }.encode_to_vec())
}

/// Копия блоба: новый блоб вызывающего с тем же шифртекстом (ключ и nonce у
/// клиента прежние) и своим секретом доступа. Источник — свой файл либо любой
/// файл, к которому предъявлен секрет. Копия заводится как незавершённая
/// загрузка (место в квоте занято сразу, брошенная — уберётся сборщиком) и
/// завершается обычным путём.
async fn copy(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: CopyRequest = body(req)?;
    let source = parse_id(&r.file_id)?;
    let bucket = bucket_of(r.bucket)?;
    if r.capability_hash.len() != CAP_LEN {
        return Err(ErrorCode::Invalid);
    }
    let (size, total) = copy_source(ctx, "copy", owner, &source, &r.capability).await?;
    let file_id = begin_copy(ctx, "copy", owner, bucket, size, total).await?;
    if let Err(code) = copy_chunks(ctx, "copy", owner, &source, &file_id, size, total).await {
        // Источник удалили посреди копии либо сбой базы: недокопированное убираем.
        abort_copy(ctx, "copy", &file_id).await;
        return Err(code);
    }
    if let Err(e) = put_cap(&ctx.pool_v2, &file_id, &r.capability_hash).await {
        error!("v2 copy: capability не сохранена: {e}");
        abort_copy(ctx, "copy", &file_id).await;
        return Err(ErrorCode::Unavailable);
    }
    debug!("v2: файл {source} скопирован в {file_id} ({size} байт)");
    Ok(CopyResponse { file_id, size: size.max(0) as u64, chunks: u32::try_from(total).unwrap_or(0) }.encode_to_vec())
}

/// Источник копии: свой файл либо любой файл, к которому предъявлен секрет.
/// Возвращает (размер, число чанков). Копия ссылки источником не бывает.
async fn copy_source(ctx: &V2Ctx, what: &'static str, owner: &str, source: &str, capability: &[u8]) -> Result<(i64, i64), ErrorCode> {
    if links::is_link_blob(&ctx.pool_v2, source).await.map_err(db_code(what))? {
        return Err(ErrorCode::NotFound);
    }
    if capability.is_empty() {
        let own: Option<(i64, i64)> = sqlx::query_as("SELECT size_bytes, total_chunks FROM files WHERE id = ? AND owner = ?")
            .bind(source)
            .bind(owner)
            .fetch_optional(&ctx.pool)
            .await
            .map_err(db_code(what))?;
        return own.ok_or(ErrorCode::NotFound);
    }
    if capability.len() != CAP_LEN {
        return Err(ErrorCode::Invalid);
    }
    if !cap_matches(&ctx.pool_v2, source, capability).await.map_err(db_code(what))? {
        return Err(ErrorCode::NotFound);
    }
    let m = file_meta_any(&ctx.pool, source).await.map_err(|e| store_code(what, e))?.ok_or(ErrorCode::NotFound)?;
    Ok((m.size_bytes, m.total_chunks))
}

/// Завести копию как незавершённую загрузку владельца: предел файла и квота
/// bucket'а проверяются в одной транзакции с записью, место занято сразу.
async fn begin_copy(ctx: &V2Ctx, what: &'static str, owner: &str, bucket: i64, size: i64, total: i64) -> Result<String, ErrorCode> {
    if size > max_file_bytes(bucket) {
        return Err(ErrorCode::Limit);
    }
    let quota = owner_quota_bytes(bucket);
    let file_id = uuid::Uuid::now_v7().to_string();
    let mut tx = parvane_db::begin_write(&ctx.pool).await.map_err(db_code(what))?;
    if quota > 0 && used_bytes(&mut *tx, owner, bucket).await.map_err(db_code(what))? + size > quota {
        return Err(ErrorCode::Limit);
    }
    sqlx::query(
        "INSERT INTO uploads (file_id, owner, total_chunks, created_at, bucket, bytes, chunks, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)",
    )
    .bind(&file_id)
    .bind(owner)
    .bind(now_unix())
    .bind(bucket)
    .bind(size)
    .bind(total)
    .bind(now_unix())
    .execute(&mut *tx)
    .await
    .map_err(db_code(what))?;
    tx.commit().await.map_err(db_code(what))?;
    Ok(file_id)
}

/// Убрать копию целиком — и недокопированную, и уже завершённую.
async fn abort_copy(ctx: &V2Ctx, what: &'static str, file_id: &str) {
    if let Err(e) = delete_blob_any(&ctx.pool, file_id).await {
        error!("v2 {what}: откат копии не удался: {e:#}");
    }
}

/// Перенести чанки источника пакетами и завершить загрузку обычным путём.
async fn copy_chunks(ctx: &V2Ctx, what: &'static str, owner: &str, source: &str, file_id: &str, size: i64, total: i64) -> Result<(), ErrorCode> {
    ctx.charge_copy(owner, size.max(0) as u64, Instant::now(), copy_bytes_per_hour())?;
    let mut from = 0;
    while from < total {
        if from > 0 {
            tokio::time::sleep(COPY_BATCH_PAUSE).await;
        }
        sqlx::query(
            "INSERT INTO chunks (file_id, chunk_index, data)
             SELECT ?, chunk_index, data FROM chunks WHERE file_id = ? AND chunk_index >= ? AND chunk_index < ?",
        )
        .bind(file_id)
        .bind(source)
        .bind(from)
        .bind(from + COPY_BATCH_CHUNKS)
        .execute(&ctx.pool)
        .await
        .map_err(db_code(what))?;
        from += COPY_BATCH_CHUNKS;
    }
    finalize_upload(
        &ctx.pool,
        owner,
        &Finalize {
            file_id: file_id.to_string(),
            claimed_total: 0,
            total_chunks: u32::try_from(total).map_err(|_| ErrorCode::Invalid)?,
            size_bytes: size.max(0) as u64,
            filename: "",
            mime_type: V2_MIME,
            recipients: &[],
            public_access: false,
        },
    )
    .await
    .map_err(|e| store_code(what, e))
}

// ── cloud.blob.download / cloud.blob.download_cap (STREAM) ───────────────────

/// Что отдавать потоком: закодированные метаданные и окно чанков.
#[derive(Debug)]
pub(crate) struct Plan {
    file_id: String,
    meta: Vec<u8>,
    from: u32,
    /// Включительно.
    to: u32,
}

/// Окно чанков: `first_chunk` внутри файла, не больше
/// `PARVANE_CLOUD_MAX_DOWNLOAD_CHUNKS` (P-28) за запрос; 0 — «сколько можно».
fn window(meta: &FileMeta, first: u32, count: u32) -> Result<(u32, u32, u32), ErrorCode> {
    let total = u32::try_from(meta.total_chunks).unwrap_or(0);
    if total == 0 {
        return Err(ErrorCode::NotFound);
    }
    if first >= total {
        return Err(ErrorCode::Invalid);
    }
    let max = max_download_chunks().max(1);
    let count = if count == 0 { max } else { count.min(max) };
    let to = first.saturating_add(count - 1).min(total - 1);
    Ok((total, first, to))
}

async fn plan_download(ctx: &V2Ctx, req: &ShardRequest) -> Result<Plan, ErrorCode> {
    let user = owner(req)?;
    let r: DownloadRequest = body(req)?;
    let file_id = parse_id(&r.file_id)?;
    // Копия ссылки читается только через ссылку (срок и отзыв проверяются там).
    if links::is_link_blob(&ctx.pool_v2, &file_id).await.map_err(db_code("download"))? {
        return Err(ErrorCode::NotFound);
    }
    // ACL v1: владелец, грант получателю или публичный объект.
    let meta = file_meta_for_user(&ctx.pool, &file_id, user)
        .await
        .map_err(|e| store_code("download", e))?
        .ok_or(ErrorCode::NotFound)?;
    let (total, from, to) = window(&meta, r.first_chunk, r.chunk_count)?;
    let meta = DownloadResponse { size: meta.size_bytes.max(0) as u64, chunks: total }.encode_to_vec();
    Ok(Plan { file_id, meta, from, to })
}

async fn plan_download_cap(ctx: &V2Ctx, req: &ShardRequest) -> Result<Plan, ErrorCode> {
    // Анонимный канал: личности нет и она не нужна — доступ по секрету.
    let r: DownloadCapRequest = body(req)?;
    let file_id = parse_id(&r.file_id)?;
    if r.capability.len() != CAP_LEN {
        return Err(ErrorCode::Invalid);
    }
    if !cap_matches(&ctx.pool_v2, &file_id, &r.capability)
        .await
        .map_err(db_code("download_cap"))?
    {
        // Нет файла и неверный секрет неразличимы.
        return Err(ErrorCode::NotFound);
    }
    // У копии ссылки секрета нет; проверка — на случай посторонней строки blob_caps.
    if links::is_link_blob(&ctx.pool_v2, &file_id).await.map_err(db_code("download_cap"))? {
        return Err(ErrorCode::NotFound);
    }
    let meta = file_meta_any(&ctx.pool, &file_id)
        .await
        .map_err(|e| store_code("download_cap", e))?
        .ok_or(ErrorCode::NotFound)?;
    let (total, from, to) = window(&meta, r.first_chunk, r.chunk_count)?;
    let meta = DownloadCapResponse { size: meta.size_bytes.max(0) as u64, chunks: total }.encode_to_vec();
    Ok(Plan { file_id, meta, from, to })
}

fn stream_error(index: u32, code: ErrorCode) -> Vec<u8> {
    ShardStreamChunk {
        index,
        last: true,
        data: Vec::new(),
        error: Some(Error { code: code as i32, retry_after_ms: 0 }),
    }
    .encode_to_vec()
}

/// Отдать поток: `ShardResponse(ok = метаданные)`, затем чанки окна по
/// одному (из БД читается по чанку — память ограничена одним чанком).
/// `emit` → false — отправка не удалась, поток прерывается.
pub(crate) async fn stream_blob<F, Fut>(pool: &SqlitePool, p: &Plan, emit: F)
where
    F: Fn(Vec<u8>) -> Fut,
    Fut: Future<Output = bool>,
{
    if !emit(ok_reply(p.meta.clone())).await {
        return;
    }
    for idx in p.from..=p.to {
        let data: sqlx::Result<Option<Vec<u8>>> =
            sqlx::query_scalar("SELECT data FROM chunks WHERE file_id = ? AND chunk_index = ?")
                .bind(&p.file_id)
                .bind(idx as i64)
                .fetch_optional(pool)
                .await;
        let is_last = idx == p.to;
        let (frame, failed) = match data {
            Ok(Some(data)) if data.len() <= FRAME_DATA_MAX => {
                (ShardStreamChunk { index: idx, last: is_last, data, error: None }.encode_to_vec(), false)
            }
            Ok(Some(data)) => {
                error!("v2 download {}: чанк {idx} ({} байт) больше кадра", p.file_id, data.len());
                (stream_error(idx, ErrorCode::Unavailable), true)
            }
            Ok(None) => {
                error!("v2 download {}: нет чанка {idx}", p.file_id);
                (stream_error(idx, ErrorCode::Unavailable), true)
            }
            Err(e) => {
                error!("v2 download {}: {e}", p.file_id);
                (stream_error(idx, ErrorCode::Unavailable), true)
            }
        };
        if !emit(frame).await || is_last || failed {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_protocol::pb::parvane::core::v2::MethodChannel;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::sync::Mutex;

    async fn mem_pool(v2: bool) -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        if v2 {
            sqlx::migrate!("./migrations_v2").run(&pool).await.unwrap();
        } else {
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        }
        pool
    }

    pub(super) async fn ctx() -> V2Ctx {
        V2Ctx::new(mem_pool(false).await, mem_pool(true).await)
    }

    pub(super) fn req(method: &str, user: &str, body: impl Message) -> ShardRequest {
        ShardRequest { method: method.into(), user: user.into(), body: body.encode_to_vec(), ..Default::default() }
    }

    async fn up_chunk(c: &V2Ctx, user: &str, upload_id: &str, index: u32, data: &[u8]) -> Result<String, ErrorCode> {
        let r = req(
            "cloud.blob.upload_chunk",
            user,
            UploadChunkRequest { upload_id: upload_id.into(), index, data: data.to_vec(), bucket: 0 },
        );
        upload_chunk(c, &r).await.map(|b| UploadChunkResponse::decode(b.as_slice()).unwrap().upload_id)
    }

    async fn complete(
        c: &V2Ctx,
        user: &str,
        upload_id: &str,
        chunks: u32,
        size: u64,
        vis: Visibility,
        cap_hash: &[u8],
    ) -> Result<String, ErrorCode> {
        let r = req(
            "cloud.blob.upload_complete",
            user,
            UploadCompleteRequest {
                upload_id: upload_id.into(),
                chunks,
                size,
                visibility: vis as i32,
                capability_hash: cap_hash.to_vec(),
            },
        );
        upload_complete(c, &r).await.map(|b| UploadCompleteResponse::decode(b.as_slice()).unwrap().file_id)
    }

    /// Загрузить файл из частей, вернуть file_id.
    pub(super) async fn upload(c: &V2Ctx, user: &str, parts: &[&[u8]], vis: Visibility, cap_hash: &[u8]) -> String {
        let id = up_chunk(c, user, "", 0, parts[0]).await.unwrap();
        for (i, p) in parts.iter().enumerate().skip(1) {
            assert_eq!(up_chunk(c, user, &id, i as u32, p).await.unwrap(), id);
        }
        let size = parts.iter().map(|p| p.len() as u64).sum();
        complete(c, user, &id, parts.len() as u32, size, vis, cap_hash).await.unwrap()
    }

    /// Прогнать поток и собрать кадры: метаданные (или ошибка) + чанки.
    pub(super) async fn run_stream(c: &V2Ctx, method: &'static str, r: ShardRequest) -> (Result<Vec<u8>, i32>, Vec<ShardStreamChunk>) {
        let m = parvane_protocol::schema::method(method).unwrap();
        let out: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
        match plan(c, m, &r).await {
            Ok(p) => {
                stream_blob(&c.pool, &p, |b| {
                    out.lock().unwrap().push(b);
                    async { true }
                })
                .await
            }
            Err(r) => out.lock().unwrap().push(refusal_reply(r)),
        }
        let frames = out.into_inner().unwrap();
        let head = match ShardResponse::decode(frames[0].as_slice()).unwrap().result.unwrap() {
            shard_response::Result::Ok(b) => Ok(b),
            shard_response::Result::Error(e) => Err(e.code),
        };
        let chunks = frames[1..].iter().map(|f| ShardStreamChunk::decode(f.as_slice()).unwrap()).collect();
        (head, chunks)
    }

    pub(super) fn dl(user: &str, file_id: &str, first: u32, count: u32) -> ShardRequest {
        req("cloud.blob.download", user, DownloadRequest { file_id: file_id.into(), first_chunk: first, chunk_count: count })
    }

    pub(super) fn dl_cap(file_id: &str, cap: &[u8], first: u32, count: u32) -> ShardRequest {
        req(
            "cloud.blob.download_cap",
            "",
            DownloadCapRequest { file_id: file_id.into(), capability: cap.to_vec(), first_chunk: first, chunk_count: count },
        )
    }

    #[test]
    fn registry_methods_are_known() {
        let names: Vec<_> = parvane_v2rt::methods_of("cloud").iter().map(|m| m.name).collect();
        for n in [
            "cloud.blob.upload_chunk",
            "cloud.blob.upload_complete",
            "cloud.blob.download",
            "cloud.blob.download_cap",
            "cloud.blob.delete",
            "cloud.blob.usage",
            "cloud.blob.upload_status",
            "cloud.blob.copy",
            "cloud.link.create",
            "cloud.link.add",
            "cloud.link.publish",
            "cloud.link.list",
            "cloud.link.revoke",
            "cloud.link.extend",
            "cloud.link.get",
            "cloud.link.download",
        ] {
            assert!(names.contains(&n), "{n} нет в реестре");
        }
        for m in parvane_v2rt::methods_of("cloud") {
            let stream = m.kind == MethodKind::Stream as i32;
            assert_eq!(
                stream,
                matches!(m.name, "cloud.blob.download" | "cloud.blob.download_cap" | "cloud.link.download"),
                "{}",
                m.name
            );
            // Без личности — только чтение по секрету и чтение по ссылке.
            let anon = m.channel == MethodChannel::Anon as i32;
            assert_eq!(anon, matches!(m.name, "cloud.blob.download_cap" | "cloud.link.get" | "cloud.link.download"), "{}", m.name);
        }
        assert_eq!(parvane_v2rt::methods_of("cloud").len(), 16);
        assert_eq!(db_path("/data/cloud.db"), "/data/cloud.db-v2.db");
    }

    #[tokio::test]
    async fn upload_download_roundtrip_and_v1_visibility() {
        let c = ctx().await;
        let id = upload(&c, "alice@local", &[b"AAAA", b"BBBB", b"CC"], Visibility::Private, &[]).await;
        let (head, chunks) = run_stream(&c, "cloud.blob.download", dl("alice@local", &id, 0, 0)).await;
        let meta = DownloadResponse::decode(head.unwrap().as_slice()).unwrap();
        assert_eq!((meta.size, meta.chunks), (10, 3));
        assert_eq!(chunks.iter().map(|c| (c.index, c.last)).collect::<Vec<_>>(), vec![(0, false), (1, false), (2, true)]);
        assert_eq!(chunks.iter().flat_map(|c| c.data.clone()).collect::<Vec<_>>(), b"AAAABBBBCC");
        // Файл из v2 виден v1-пути (общие таблицы).
        let v1 = super::super::load_file_for_user(&c.pool, &id, "alice@local").await.unwrap().unwrap();
        assert_eq!(v1.chunks.len(), 3);
        // Окно: со второго чанка, один чанк.
        let (_, part) = run_stream(&c, "cloud.blob.download", dl("alice@local", &id, 1, 1)).await;
        assert_eq!(part.len(), 1);
        assert_eq!((part[0].index, part[0].last, part[0].data.as_slice()), (1, true, &b"BBBB"[..]));
        // Начало за концом файла.
        let (head, _) = run_stream(&c, "cloud.blob.download", dl("alice@local", &id, 3, 1)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::Invalid as i32);
    }

    #[tokio::test]
    async fn download_window_is_capped() {
        let c = ctx().await;
        let n = max_download_chunks() as usize + 3;
        let parts: Vec<Vec<u8>> = (0..n).map(|i| vec![i as u8]).collect();
        let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
        let id = upload(&c, "alice@local", &refs, Visibility::Private, &[]).await;
        let (_, chunks) = run_stream(&c, "cloud.blob.download", dl("alice@local", &id, 0, 100_000)).await;
        assert_eq!(chunks.len(), max_download_chunks() as usize, "≤ окна за запрос");
        assert!(chunks.last().unwrap().last);
    }

    #[tokio::test]
    async fn acl_owner_grant_public() {
        let c = ctx().await;
        let private = upload(&c, "alice@local", &[b"secret"], Visibility::Private, &[]).await;
        let (head, _) = run_stream(&c, "cloud.blob.download", dl("mallory@local", &private, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        // Грант v1 (получатель) открывает и v2-скачивание.
        sqlx::query("INSERT INTO file_grants (file_id, principal, granted_at) VALUES (?, 'bob@local', 0)")
            .bind(&private)
            .execute(&c.pool)
            .await
            .unwrap();
        let (head, _) = run_stream(&c, "cloud.blob.download", dl("bob@local", &private, 0, 0)).await;
        assert!(head.is_ok());
        let public = upload(&c, "alice@local", &[b"avatar"], Visibility::Public, &[]).await;
        let (head, chunks) = run_stream(&c, "cloud.blob.download", dl("mallory@local", &public, 0, 0)).await;
        assert!(head.is_ok());
        assert_eq!(chunks[0].data, b"avatar");
        // Пустой user у ID-метода — FORBIDDEN.
        let (head, _) = run_stream(&c, "cloud.blob.download", dl("", &public, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::Forbidden as i32);
        assert_eq!(up_chunk(&c, "", "", 0, b"x").await.unwrap_err(), ErrorCode::Forbidden);
        let r = req("cloud.blob.delete", "", DeleteRequest { file_id: public.clone() });
        assert_eq!(delete(&c, &r).await.unwrap_err(), ErrorCode::Forbidden);
    }

    #[tokio::test]
    async fn upload_rules() {
        let c = ctx().await;
        // Первый чанк без upload_id — только index 0.
        assert_eq!(up_chunk(&c, "alice@local", "", 1, b"x").await.unwrap_err(), ErrorCode::Invalid);
        // Чанк больше кадра отсекает уже схема (max_len) — INVALID.
        assert_eq!(up_chunk(&c, "alice@local", "", 0, &vec![0u8; FRAME_DATA_MAX + 1]).await.unwrap_err(), ErrorCode::Invalid);
        // Индекс за пределом числа чанков — LIMIT.
        let id = up_chunk(&c, "alice@local", "", 0, b"a").await.unwrap();
        assert_eq!(up_chunk(&c, "alice@local", &id, max_total_chunks(), b"b").await.unwrap_err(), ErrorCode::Limit);
        // Чужой, неизвестный и кривой upload_id.
        assert_eq!(up_chunk(&c, "mallory@local", &id, 1, b"b").await.unwrap_err(), ErrorCode::NotFound);
        let unknown = uuid::Uuid::now_v7().to_string();
        assert_eq!(up_chunk(&c, "alice@local", &unknown, 1, b"b").await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(up_chunk(&c, "alice@local", "nope", 1, b"b").await.unwrap_err(), ErrorCode::Invalid);
        assert_eq!(
            complete(&c, "mallory@local", &id, 1, 1, Visibility::Private, &[]).await.unwrap_err(),
            ErrorCode::Forbidden
        );
        // Дырка в индексах: чанки 0 и 2 при заявленных двух — INVALID.
        up_chunk(&c, "alice@local", &id, 2, b"c").await.unwrap();
        assert_eq!(complete(&c, "alice@local", &id, 2, 2, Visibility::Private, &[]).await.unwrap_err(), ErrorCode::Invalid);
        // Ложный размер — INVALID; кривой хэш capability — INVALID.
        up_chunk(&c, "alice@local", &id, 1, b"b").await.unwrap();
        assert_eq!(complete(&c, "alice@local", &id, 3, 99, Visibility::Private, &[]).await.unwrap_err(), ErrorCode::Invalid);
        assert_eq!(
            complete(&c, "alice@local", &id, 3, 3, Visibility::Private, &[1u8; 5]).await.unwrap_err(),
            ErrorCode::Invalid
        );
        let fid = complete(&c, "alice@local", &id, 3, 3, Visibility::Private, &[]).await.unwrap();
        assert_eq!(fid, id);
        // Завершённый файл не дописать.
        assert_eq!(up_chunk(&c, "alice@local", &id, 0, b"z").await.unwrap_err(), ErrorCode::NotFound);
        // v1-загрузка (total ≠ 0) через v2 не продолжается.
        let v1_id = uuid::Uuid::now_v7().to_string();
        store_chunk_raw(&c.pool, "alice@local", &v1_id, 0, 2, b"v1".to_vec(), BUCKET_MEDIA).await.unwrap();
        assert_eq!(up_chunk(&c, "alice@local", &v1_id, 1, b"x").await.unwrap_err(), ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn empty_chunks_are_rejected() {
        let c = ctx().await;
        // Пустой единственный чанк (пустой файл) допустим, пустые чанки с индексом > 0 — нет.
        let id = up_chunk(&c, "e@local", "", 0, b"").await.unwrap();
        assert_eq!(up_chunk(&c, "e@local", &id, 1, b"").await.unwrap_err(), ErrorCode::Invalid);
    }

    #[tokio::test]
    async fn copy_budget_is_per_owner_and_hourly() {
        let c = ctx().await;
        let t0 = Instant::now();
        assert_eq!(c.charge_copy("a@local", 60, t0, 100), Ok(()));
        assert_eq!(c.charge_copy("a@local", 60, t0, 100), Err(ErrorCode::RateLimited));
        assert_eq!(c.charge_copy("b@local", 60, t0, 100), Ok(()), "бюджет у каждого владельца свой");
        assert_eq!(c.charge_copy("a@local", 60, t0 + COPY_WINDOW, 100), Ok(()), "окно истекло");
    }

    #[tokio::test]
    async fn pending_uploads_limit() {
        let c = ctx().await;
        let limit = super::super::max_pending_uploads();
        for _ in 0..limit {
            up_chunk(&c, "p@local", "", 0, b"x").await.unwrap();
        }
        assert_eq!(up_chunk(&c, "p@local", "", 0, b"x").await.unwrap_err(), ErrorCode::Limit);
        // Другому владельцу лимит не мешает.
        up_chunk(&c, "q@local", "", 0, b"x").await.unwrap();
    }

    #[tokio::test]
    async fn owner_quota_applies_to_v2() {
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(Some(10)));
        let c = ctx().await;
        let first = up_chunk(&c, "q@local", "", 0, b"aaaaaa").await;
        let second = up_chunk(&c, "q@local", "", 0, b"bbbbbb").await;
        let done = match &first {
            Ok(id) => complete(&c, "q@local", id, 1, 6, Visibility::Private, &[]).await,
            Err(e) => Err(*e),
        };
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(None));
        assert!(done.is_ok());
        assert_eq!(second.unwrap_err(), ErrorCode::Limit, "незавершённые чанки в квоте");
    }

    pub(super) async fn up_drive(c: &V2Ctx, user: &str, upload_id: &str, index: u32, data: &[u8]) -> Result<String, ErrorCode> {
        let r = req(
            "cloud.blob.upload_chunk",
            user,
            UploadChunkRequest { upload_id: upload_id.into(), index, data: data.to_vec(), bucket: BlobBucket::Drive as i32 },
        );
        upload_chunk(c, &r).await.map(|b| UploadChunkResponse::decode(b.as_slice()).unwrap().upload_id)
    }

    pub(super) async fn usage_of(c: &V2Ctx, user: &str) -> Vec<(i32, u64, u64, u64)> {
        let b = usage(c, &req("cloud.blob.usage", user, UsageRequest {})).await.unwrap();
        UsageResponse::decode(b.as_slice()).unwrap().buckets.iter().map(|u| (u.bucket, u.used, u.quota, u.max_file)).collect()
    }

    async fn status_of(c: &V2Ctx, user: &str, id: &str) -> Result<(u32, u64), ErrorCode> {
        let r = req("cloud.blob.upload_status", user, UploadStatusRequest { upload_id: id.into() });
        upload_status(c, &r).await.map(|b| {
            let s = UploadStatusResponse::decode(b.as_slice()).unwrap();
            (s.chunks, s.bytes)
        })
    }

    pub(super) async fn copy_of(c: &V2Ctx, user: &str, source: &str, cap: &[u8], bucket: BlobBucket, new_hash: &[u8]) -> Result<CopyResponse, ErrorCode> {
        let r = req(
            "cloud.blob.copy",
            user,
            CopyRequest { file_id: source.into(), capability: cap.to_vec(), bucket: bucket as i32, capability_hash: new_hash.to_vec() },
        );
        copy(c, &r).await.map(|b| CopyResponse::decode(b.as_slice()).unwrap())
    }

    #[tokio::test]
    async fn buckets_have_separate_quotas_and_usage() {
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(Some(10)));
        let c = ctx().await;
        // По 6 байт в каждом bucket'е проходят (квота 10 на каждый), вторые 6 в облаке — нет.
        let media = up_chunk(&c, "q@local", "", 0, b"mmmmmm").await;
        let drive = up_drive(&c, "q@local", "", 0, b"dddddd").await;
        let over = up_drive(&c, "q@local", "", 0, b"dddddd").await;
        let done = match &drive {
            Ok(id) => complete(&c, "q@local", id, 1, 6, Visibility::Private, &[]).await,
            Err(e) => Err(*e),
        };
        let used = usage_of(&c, "q@local").await;
        // Удаление освобождает квоту.
        let freed = match &done {
            Ok(id) => delete(&c, &req("cloud.blob.delete", "q@local", DeleteRequest { file_id: id.clone() })).await.map(|_| ()),
            Err(e) => Err(*e),
        };
        let again = up_drive(&c, "q@local", "", 0, b"dddddd").await;
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(None));
        assert!(media.is_ok() && done.is_ok() && freed.is_ok() && again.is_ok());
        assert_eq!(over.unwrap_err(), ErrorCode::Limit);
        // Готовый файл облака и незавершённая загрузка медиа — в счёте своих bucket'ов.
        assert_eq!(used.iter().map(|u| (u.0, u.1, u.2)).collect::<Vec<_>>(), vec![(0, 6, 10), (1, 6, 10)]);
        let real = usage_of(&c, "nobody@local").await;
        assert_eq!(real[1].2, 10 * 1024 * 1024 * 1024);
        assert!(real[1].3 > real[0].3, "предел файла облака выше предела медиа");
        // Bucket не из схемы — отказ.
        let bad = req("cloud.blob.upload_chunk", "q@local", UploadChunkRequest { upload_id: String::new(), index: 0, data: vec![1], bucket: 9 });
        assert_eq!(upload_chunk(&c, &bad).await.unwrap_err(), ErrorCode::Invalid);
    }

    #[tokio::test]
    async fn file_limit_counts_running_bytes_and_repeat_does_not_double() {
        super::super::tests::FILE_MAX_OVERRIDE.with(|q| q.set(Some(10)));
        let c = ctx().await;
        let id = up_drive(&c, "a@local", "", 0, b"aaaa").await.unwrap();
        // Повтор того же чанка (и замена на более длинный) счёт не удваивает.
        let repeat = up_drive(&c, "a@local", &id, 0, b"aaaa").await;
        let longer = up_drive(&c, "a@local", &id, 0, b"aaaaaa").await;
        let second = up_drive(&c, "a@local", &id, 1, b"bbbb").await;
        let over = up_drive(&c, "a@local", &id, 2, b"c").await;
        let status = status_of(&c, "a@local", &id).await;
        let used = usage_of(&c, "a@local").await;
        super::super::tests::FILE_MAX_OVERRIDE.with(|q| q.set(None));
        assert!(repeat.is_ok() && longer.is_ok() && second.is_ok());
        assert_eq!(over.unwrap_err(), ErrorCode::Limit);
        assert_eq!(status.unwrap(), (2, 10));
        assert_eq!(used[1].1, 10);
    }

    #[tokio::test]
    async fn upload_status_reports_contiguous_prefix() {
        let c = ctx().await;
        let id = up_drive(&c, "a@local", "", 0, b"00").await.unwrap();
        // Чанки пришли окном: 0, 1, 3, 4 — принято подряд два.
        for i in [1u32, 3, 4] {
            up_drive(&c, "a@local", &id, i, b"xx").await.unwrap();
        }
        assert_eq!(status_of(&c, "a@local", &id).await.unwrap(), (2, 4));
        up_drive(&c, "a@local", &id, 2, b"xx").await.unwrap();
        assert_eq!(status_of(&c, "a@local", &id).await.unwrap(), (5, 10));
        // Чужая, неизвестная и завершённая загрузка — NOT_FOUND.
        assert_eq!(status_of(&c, "bob@local", &id).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(status_of(&c, "a@local", &uuid::Uuid::now_v7().to_string()).await.unwrap_err(), ErrorCode::NotFound);
        complete(&c, "a@local", &id, 5, 10, Visibility::Private, &[]).await.unwrap();
        assert_eq!(status_of(&c, "a@local", &id).await.unwrap_err(), ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn stale_upload_is_measured_from_last_activity() {
        let c = ctx().await;
        let id = up_drive(&c, "a@local", "", 0, b"00").await.unwrap();
        let old = now_unix() - 48 * 3600;
        // Начата давно, но чанк приходил недавно — живёт.
        sqlx::query("UPDATE uploads SET created_at = ? WHERE file_id = ?").bind(old).bind(&id).execute(&c.pool).await.unwrap();
        assert_eq!(super::super::purge_stale_uploads(&c.pool).await.unwrap(), 0);
        sqlx::query("UPDATE uploads SET updated_at = ? WHERE file_id = ?").bind(old).bind(&id).execute(&c.pool).await.unwrap();
        assert_eq!(super::super::purge_stale_uploads(&c.pool).await.unwrap(), 1);
        assert_eq!(usage_of(&c, "a@local").await[1].1, 0);
    }

    #[tokio::test]
    async fn copy_makes_an_independent_blob() {
        let c = ctx().await;
        let cap = [7u8; 32];
        let hash = Sha256::digest(cap);
        let parts: Vec<Vec<u8>> = (0..150u32).map(|i| format!("part-{i:03}").into_bytes()).collect();
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        let all: Vec<u8> = parts.concat();
        let source = upload(&c, "alice@local", &refs, Visibility::Private, &hash).await;
        // Боб знает секрет: копия в его облако, со своим секретом.
        let cap_b = [9u8; 32];
        let hash_b = Sha256::digest(cap_b);
        let made = copy_of(&c, "bob@local", &source, &cap, BlobBucket::Drive, &hash_b).await.unwrap();
        assert_eq!((made.size, made.chunks), (all.len() as u64, 150));
        assert_ne!(made.file_id, source);
        assert_eq!(usage_of(&c, "bob@local").await[1].1, all.len() as u64);
        assert_eq!(usage_of(&c, "bob@local").await[0].1, 0);
        // Источник удалён — копия читается (и секретом, и владельцем).
        delete(&c, &req("cloud.blob.delete", "alice@local", DeleteRequest { file_id: source.clone() })).await.unwrap();
        let (head, chunks) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&made.file_id, &cap_b, 0, 0)).await;
        assert!(head.is_ok());
        assert_eq!(chunks.iter().flat_map(|c| c.data.clone()).collect::<Vec<_>>(), all);
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&made.file_id, &cap, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32, "секрет источника к копии не подходит");
        // Свой файл копируется без секрета (в медиа — для отправки в чат).
        let own = copy_of(&c, "bob@local", &made.file_id, &[], BlobBucket::Unspecified, &hash).await.unwrap();
        assert_eq!(usage_of(&c, "bob@local").await[0].1, all.len() as u64);
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&own.file_id, &cap, 0, 1)).await;
        assert!(head.is_ok());
        // Отказы: чужой файл без секрета, неверный секрет, нет хэша нового секрета, удалённый источник.
        assert_eq!(copy_of(&c, "carol@local", &made.file_id, &[], BlobBucket::Drive, &hash).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(copy_of(&c, "carol@local", &made.file_id, &[1u8; 32], BlobBucket::Drive, &hash).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(copy_of(&c, "bob@local", &made.file_id, &[], BlobBucket::Drive, &[]).await.unwrap_err(), ErrorCode::Invalid);
        assert_eq!(copy_of(&c, "alice@local", &source, &[], BlobBucket::Drive, &hash).await.unwrap_err(), ErrorCode::NotFound);
        // Незавершённых загрузок копии не оставляют.
        let (pending,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM uploads").fetch_one(&c.pool).await.unwrap();
        assert_eq!(pending, 0);
    }

    #[tokio::test]
    async fn copy_respects_destination_quota() {
        let c = ctx().await;
        let cap = [7u8; 32];
        let source = upload(&c, "alice@local", &[b"0123456789ab"], Visibility::Private, &Sha256::digest(cap)).await;
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(Some(10)));
        let refused = copy_of(&c, "bob@local", &source, &cap, BlobBucket::Drive, &[1u8; 32]).await;
        super::super::tests::QUOTA_OVERRIDE.with(|q| q.set(None));
        assert_eq!(refused.unwrap_err(), ErrorCode::Limit);
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks").fetch_one(&c.pool).await.unwrap();
        assert_eq!(rows, 1, "отказанная копия чанков не оставила");
    }

    #[tokio::test]
    async fn capability_download_without_identity() {
        let c = ctx().await;
        let cap = [7u8; 32];
        let hash = Sha256::digest(cap);
        let id = upload(&c, "alice@local", &[b"att-0", b"att-1"], Visibility::Private, &hash).await;
        // Анонимно по верному секрету.
        let (head, chunks) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&id, &cap, 0, 0)).await;
        let meta = DownloadCapResponse::decode(head.unwrap().as_slice()).unwrap();
        assert_eq!((meta.size, meta.chunks), (10, 2));
        assert_eq!(chunks.iter().flat_map(|c| c.data.clone()).collect::<Vec<_>>(), b"att-0att-1");
        // Неверный секрет, неизвестный файл, файл без capability — NOT_FOUND.
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&id, &[8u8; 32], 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        let other = uuid::Uuid::now_v7().to_string();
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&other, &cap, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        let plain = upload(&c, "alice@local", &[b"p"], Visibility::Private, &[]).await;
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&plain, &[0u8; 32], 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        // Секрет не той длины — INVALID; сам хэш вместо секрета не подходит.
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&id, &cap[..16], 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::Invalid as i32);
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&id, hash.as_slice(), 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        // Хранится только хэш.
        let (stored,): (Vec<u8>,) = sqlx::query_as("SELECT cap_hash FROM blob_caps WHERE file_id = ?")
            .bind(&id)
            .fetch_one(&c.pool_v2)
            .await
            .unwrap();
        assert_eq!(stored, hash.as_slice());
        // Без гранта получатель по ID-каналу файл не видит (D-08: грантов нет).
        let (head, _) = run_stream(&c, "cloud.blob.download", dl("bob@local", &id, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        // Удаление владельцем убирает и файл, и хэш.
        let r = req("cloud.blob.delete", "bob@local", DeleteRequest { file_id: id.clone() });
        assert_eq!(delete(&c, &r).await.unwrap_err(), ErrorCode::NotFound);
        let r = req("cloud.blob.delete", "alice@local", DeleteRequest { file_id: id.clone() });
        delete(&c, &r).await.unwrap();
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&id, &cap, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blob_caps").fetch_one(&c.pool_v2).await.unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn stream_reports_missing_chunk_as_error_frame() {
        let c = ctx().await;
        let id = upload(&c, "alice@local", &[b"a", b"b", b"c"], Visibility::Private, &[]).await;
        sqlx::query("DELETE FROM chunks WHERE file_id = ? AND chunk_index = 1").bind(&id).execute(&c.pool).await.unwrap();
        let (head, chunks) = run_stream(&c, "cloud.blob.download", dl("alice@local", &id, 0, 0)).await;
        assert!(head.is_ok());
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].error.is_none());
        assert!(chunks[1].last);
        assert_eq!(chunks[1].error.as_ref().unwrap().code, ErrorCode::Unavailable as i32);
    }
}
