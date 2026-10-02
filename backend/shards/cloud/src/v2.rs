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
//! Подписчик на каждый метод роли `cloud` — ровно один (`run`), поэтому
//! `parvane_v2rt::serve` (он отвечает только одним сообщением) здесь не
//! используется; кодирование ответов и разбор тела — из `parvane_v2rt`.

use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use async_nats::Client;
use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::cloud::v1::{
    DeleteRequest, DeleteResponse, DownloadCapRequest, DownloadCapResponse, DownloadRequest,
    DownloadResponse, UploadChunkRequest, UploadChunkResponse, UploadCompleteRequest,
    UploadCompleteResponse, Visibility,
};
use parvane_protocol::pb::parvane::core::v2::{Error, ErrorCode, MethodKind, ShardRequest, ShardStreamChunk};
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, error_reply, ok_reply};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;
use tracing::{debug, error, info, warn};

use super::{
    delete_file, file_meta_any, file_meta_for_user, finalize_upload, handler_concurrency,
    max_chunk_bytes, max_download_chunks, max_file_bytes, max_total_chunks, now_unix,
    store_chunk_raw, FileMeta, Finalize, RejectKind, Rejected,
};

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
    /// `<PARVANE_DB_PATH>-v2.db`: хэши capability.
    pub pool_v2: SqlitePool,
}

/// Путь v2-БД рядом с основной.
pub(crate) fn db_path(v1_path: &str) -> String {
    format!("{v1_path}-v2.db")
}

/// Подписаться на все методы роли `cloud` из реестра и обслуживать их.
pub(crate) async fn run(nc: Client, ctx: Arc<V2Ctx>) -> Result<()> {
    let methods = parvane_v2rt::methods_of("cloud");
    let mut streams = Vec::new();
    for m in &methods {
        let m: &'static MethodInfo = m;
        let sub = nc.subscribe(m.subject.to_string()).await?;
        streams.push(sub.map(move |msg| (m, msg)).boxed());
    }
    let mut all = futures::stream::select_all(streams);
    let sem = Arc::new(tokio::sync::Semaphore::new(handler_concurrency().max(1)));
    tokio::spawn(async move {
        while let Some((m, msg)) = all.next().await {
            let Some(reply) = msg.reply.clone() else {
                warn!("v2 {}: запрос без reply", m.name);
                continue;
            };
            let Ok(permit) = sem.clone().acquire_owned().await else { break };
            let (nc, ctx) = (nc.clone(), ctx.clone());
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
                if m.kind == MethodKind::Stream as i32 {
                    match plan(&ctx, m, &req).await {
                        Ok(p) => stream_blob(&ctx.pool, &p, emit).await,
                        Err(code) => {
                            emit(error_reply(code)).await;
                        }
                    }
                } else {
                    let out = match call(&ctx, m, &req).await {
                        Ok(b) => ok_reply(b),
                        Err(code) => error_reply(code),
                    };
                    emit(out).await;
                }
            });
        }
    });
    info!("cloud: методы v2 подключены ({} шт.)", methods.len());
    Ok(())
}

async fn call(ctx: &V2Ctx, m: &'static MethodInfo, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    match m.name {
        "cloud.blob.upload_chunk" => upload_chunk(ctx, req).await,
        "cloud.blob.upload_complete" => upload_complete(ctx, req).await,
        "cloud.blob.delete" => delete(ctx, req).await,
        _ => Err(ErrorCode::Unavailable),
    }
}

async fn plan(ctx: &V2Ctx, m: &'static MethodInfo, req: &ShardRequest) -> Result<Plan, ErrorCode> {
    match m.name {
        "cloud.blob.download" => plan_download(ctx, req).await,
        "cloud.blob.download_cap" => plan_download_cap(ctx, req).await,
        _ => Err(ErrorCode::Unavailable),
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

fn db_code(what: &str) -> impl FnOnce(sqlx::Error) -> ErrorCode + '_ {
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
        // Размер файла ограничен уже при загрузке: total у v2 неизвестен до
        // complete, и без этой проверки одна загрузка росла бы до квоты.
        let (others,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM chunks WHERE file_id = ? AND chunk_index != ?",
        )
        .bind(&id)
        .bind(r.index)
        .fetch_one(&ctx.pool)
        .await
        .map_err(db_code("upload_chunk"))?;
        if others + r.data.len() as i64 > max_file_bytes() {
            return Err(ErrorCode::Limit);
        }
        id
    };
    store_chunk_raw(&ctx.pool, owner, &upload_id, r.index, 0, r.data)
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
    Ok(DeleteResponse {}.encode_to_vec())
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
    use parvane_protocol::pb::parvane::core::v2::{shard_response, ShardResponse};
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

    async fn ctx() -> V2Ctx {
        V2Ctx { pool: mem_pool(false).await, pool_v2: mem_pool(true).await }
    }

    fn req(method: &str, user: &str, body: impl Message) -> ShardRequest {
        ShardRequest { method: method.into(), user: user.into(), body: body.encode_to_vec(), ..Default::default() }
    }

    async fn up_chunk(c: &V2Ctx, user: &str, upload_id: &str, index: u32, data: &[u8]) -> Result<String, ErrorCode> {
        let r = req(
            "cloud.blob.upload_chunk",
            user,
            UploadChunkRequest { upload_id: upload_id.into(), index, data: data.to_vec() },
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
    async fn upload(c: &V2Ctx, user: &str, parts: &[&[u8]], vis: Visibility, cap_hash: &[u8]) -> String {
        let id = up_chunk(c, user, "", 0, parts[0]).await.unwrap();
        for (i, p) in parts.iter().enumerate().skip(1) {
            assert_eq!(up_chunk(c, user, &id, i as u32, p).await.unwrap(), id);
        }
        let size = parts.iter().map(|p| p.len() as u64).sum();
        complete(c, user, &id, parts.len() as u32, size, vis, cap_hash).await.unwrap()
    }

    /// Прогнать поток и собрать кадры: метаданные (или ошибка) + чанки.
    async fn run_stream(c: &V2Ctx, method: &'static str, r: ShardRequest) -> (Result<Vec<u8>, i32>, Vec<ShardStreamChunk>) {
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
            Err(code) => out.lock().unwrap().push(error_reply(code)),
        }
        let frames = out.into_inner().unwrap();
        let head = match ShardResponse::decode(frames[0].as_slice()).unwrap().result.unwrap() {
            shard_response::Result::Ok(b) => Ok(b),
            shard_response::Result::Error(e) => Err(e.code),
        };
        let chunks = frames[1..].iter().map(|f| ShardStreamChunk::decode(f.as_slice()).unwrap()).collect();
        (head, chunks)
    }

    fn dl(user: &str, file_id: &str, first: u32, count: u32) -> ShardRequest {
        req("cloud.blob.download", user, DownloadRequest { file_id: file_id.into(), first_chunk: first, chunk_count: count })
    }

    fn dl_cap(file_id: &str, cap: &[u8], first: u32, count: u32) -> ShardRequest {
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
        ] {
            assert!(names.contains(&n), "{n} нет в реестре");
        }
        for m in parvane_v2rt::methods_of("cloud") {
            let stream = m.kind == MethodKind::Stream as i32;
            assert_eq!(stream, matches!(m.name, "cloud.blob.download" | "cloud.blob.download_cap"), "{}", m.name);
        }
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
        store_chunk_raw(&c.pool, "alice@local", &v1_id, 0, 2, b"v1".to_vec()).await.unwrap();
        assert_eq!(up_chunk(&c, "alice@local", &v1_id, 1, b"x").await.unwrap_err(), ErrorCode::NotFound);
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
