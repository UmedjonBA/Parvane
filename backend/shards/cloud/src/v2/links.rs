//! Ссылки облака для людей без аккаунта (spec 022, `cloud.link.*`).
//!
//! Ссылка — снимок: владелец заводит её (`create`, состояние «готовится»),
//! сервер копирует в неё блобы (`add` — тем же путём, что `cloud.blob.copy`,
//! копии в bucket'е облака и в квоте владельца), затем владелец кладёт
//! зашифрованный ключом ссылки список и запись для себя (`publish`) — с этого
//! момента ссылка действует и идёт срок. Ключа ссылки у сервера нет: он во
//! фрагменте адреса и на сервер не приходит.
//!
//! Получатель ходит анонимным каналом (`get`, `download`): ни личности, ни IP
//! шард не видит, поэтому частота считается здесь по ссылке, а на адрес — в
//! gateway. Срок и состояние проверяются при каждом чтении; отсутствующая,
//! отозванная и готовящаяся ссылки неразличимы (`NOT_FOUND`).
//!
//! Копия ссылки — обычный блоб владельца в `files`/`chunks`, но секрета
//! capability у неё нет, а методам `cloud.blob.*` она не видна
//! (`is_link_blob`): прочитать её можно только через действующую ссылку,
//! удалить — только отзывом.
//!
//! Таблицы — `links`, `link_blobs` в `<PARVANE_DB_PATH>-v2.db`; блобы — в
//! основной базе. Общей транзакции у двух баз нет, поэтому порядок записи
//! везде такой, чтобы обрыв оставлял только то, что уберёт `purge`: копию без
//! ссылки, а не ссылку без копии.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use parvane_protocol::pb::parvane::cloud::v1::{
    LinkAddRequest, LinkAddResponse, LinkCreateRequest, LinkCreateResponse, LinkDownloadRequest, LinkDownloadResponse,
    LinkExtendRequest, LinkExtendResponse, LinkGetRequest, LinkGetResponse, LinkInfo, LinkListRequest, LinkListResponse,
    LinkPublishRequest, LinkPublishResponse, LinkRevokeRequest, LinkRevokeResponse, LinkState,
};
use parvane_protocol::pb::parvane::core::v2::{ErrorCode, ShardRequest};
use parvane_v2rt::body;
use prost::Message;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::{debug, error};

use super::super::{delete_blob_any, env_usize, file_meta_any, now_unix, release_free_pages, BUCKET_DRIVE};
use super::{abort_copy, begin_copy, copy_chunks, copy_source, db_code, owner, parse_id, store_code, window, Plan, Refusal, V2Ctx};

pub(crate) const DOWNLOAD: &str = "cloud.link.download";

const STATE_PREPARING: i64 = 1;
const STATE_ACTIVE: i64 = 2;
const BLOB_COPYING: i64 = 0;
const BLOB_READY: i64 = 1;

/// Идентификатор ссылки: 16 байт из CSPRNG, base64url без `=`.
const ID_BYTES: usize = 16;
const ID_CHARS: usize = 22;
const DAY_SECS: i64 = 24 * 3600;
/// Готовящаяся ссылка старше этого считается брошенной.
const PREPARING_TTL_SECS: i64 = 24 * 3600;
/// Потолок списка `cloud.link.list` (`max_items` схемы) и числа ссылок владельца.
const LIST_MAX: i64 = 256;
/// Окно счёта обращений по одной ссылке.
const RATE_WINDOW: Duration = Duration::from_secs(60);
/// Сколько ссылок отслеживает счётчик частоты (память шарда ограничена).
const RATE_TRACKED_MAX: usize = 10_000;
/// Через сколько повторить, когда заняты все потоки скачивания либо счётчик полон.
const BUSY_RETRY_MS: u32 = 1000;

// ── пределы и выключатель (окружение шарда) ─────────────────────────────────

#[cfg(test)]
thread_local! {
    /// Переопределения для теста текущего потока: (файлов на ссылку, ссылок
    /// на владельца) и выключатель. Окружение общее для параллельных тестов.
    pub(crate) static LIMITS_OVERRIDE: std::cell::Cell<Option<(i64, i64)>> = const { std::cell::Cell::new(None) };
    pub(crate) static DISABLED_OVERRIDE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// PARVANE_CLOUD_LINKS_ENABLED (по умолчанию включено): `0` запрещает создавать
/// новые ссылки. Уже созданные продолжают работать до срока либо отзыва.
fn enabled() -> bool {
    #[cfg(test)]
    if DISABLED_OVERRIDE.with(|c| c.get()) {
        return false;
    }
    !matches!(std::env::var("PARVANE_CLOUD_LINKS_ENABLED").as_deref(), Ok("0" | "false" | "off"))
}

/// PARVANE_CLOUD_LINK_MAX_FILES — файлов в одной ссылке (500).
fn max_files() -> i64 {
    #[cfg(test)]
    if let Some((files, _)) = LIMITS_OVERRIDE.with(|c| c.get()) {
        return files;
    }
    env_usize("PARVANE_CLOUD_LINK_MAX_FILES", 500) as i64
}

/// PARVANE_CLOUD_LINKS_PER_OWNER — ссылок на аккаунт (100): готовящиеся,
/// действующие и истёкшие, пока не удалены. Не больше потолка списка.
fn max_links() -> i64 {
    #[cfg(test)]
    if let Some((_, links)) = LIMITS_OVERRIDE.with(|c| c.get()) {
        return links;
    }
    (env_usize("PARVANE_CLOUD_LINKS_PER_OWNER", 100) as i64).min(LIST_MAX)
}

/// PARVANE_CLOUD_LINK_GRACE_DAYS — сколько истёкшая ссылка ждёт продления (30).
fn grace_secs() -> i64 {
    env_usize("PARVANE_CLOUD_LINK_GRACE_DAYS", 30) as i64 * DAY_SECS
}

/// Срок из схемы: 0 (без срока), 1, 7 или 30 дней.
fn ttl_days(raw: u32) -> Result<i64, ErrorCode> {
    match raw {
        0 | 1 | 7 | 30 => Ok(i64::from(raw)),
        _ => Err(ErrorCode::Invalid),
    }
}

fn expiry(now: i64, ttl_days: i64) -> i64 {
    if ttl_days == 0 {
        0
    } else {
        now + ttl_days * DAY_SECS
    }
}

fn is_expired(expires_at: i64, now: i64) -> bool {
    expires_at != 0 && now >= expires_at
}

/// Истекла так давно, что продлить уже нельзя (копии ждут сборщика).
fn past_grace(expires_at: i64, now: i64) -> bool {
    expires_at != 0 && now > expires_at + grace_secs()
}

// ── идентификатор ───────────────────────────────────────────────────────────

fn new_id() -> String {
    let mut raw = [0u8; ID_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

/// Ключ строки по идентификатору: SHA-256. `None` — не идентификатор ссылки.
fn id_key(id: &str) -> Option<[u8; 32]> {
    if id.len() != ID_CHARS {
        return None;
    }
    let raw = URL_SAFE_NO_PAD.decode(id).ok()?;
    (raw.len() == ID_BYTES).then(|| Sha256::digest(id.as_bytes()).into())
}

/// Идентификатор — половина доступа: в журнал идёт только начало.
fn short(id: &str) -> &str {
    id.get(..6).unwrap_or("")
}

// ── состояние в памяти: частота по ссылке и потоки скачивания ───────────────

struct RateWindow {
    start: Instant,
    count: u32,
}

pub(crate) struct Runtime {
    rate: Mutex<HashMap<[u8; 32], RateWindow>>,
    /// Обращений (`get` + `download`) к одной ссылке за окно.
    rate_limit: u32,
    streams: Arc<Semaphore>,
}

impl Runtime {
    /// PARVANE_CLOUD_LINK_RATE_PER_MIN (120) и PARVANE_CLOUD_LINK_STREAMS (8).
    pub(crate) fn new() -> Self {
        Self::with_limits(env_usize("PARVANE_CLOUD_LINK_RATE_PER_MIN", 120) as u32, env_usize("PARVANE_CLOUD_LINK_STREAMS", 8))
    }

    pub(crate) fn with_limits(rate_limit: u32, streams: usize) -> Self {
        Runtime { rate: Mutex::new(HashMap::new()), rate_limit: rate_limit.max(1), streams: Arc::new(Semaphore::new(streams.max(1))) }
    }

    /// Занять поток анонимного скачивания. Мест нет — отказ сразу: ждать
    /// значило бы держать общий обработчик шарда.
    pub(crate) fn stream_slot(&self) -> Result<OwnedSemaphorePermit, Refusal> {
        self.streams.clone().try_acquire_owned().map_err(|_| Refusal { code: ErrorCode::RateLimited, retry_after_ms: BUSY_RETRY_MS })
    }

    /// Учесть обращение к ссылке; сверх предела — `RATE_LIMITED` с временем до конца окна.
    fn hit(&self, key: &[u8; 32], now: Instant) -> Result<(), Refusal> {
        // Отравленный замок — счётчик остаётся годным: в нём только числа.
        let mut map = self.rate.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = map.get_mut(key) {
            let age = now.saturating_duration_since(w.start);
            if age < RATE_WINDOW {
                if w.count >= self.rate_limit {
                    let left = (RATE_WINDOW - age).as_millis().clamp(1, u128::from(u32::MAX)) as u32;
                    return Err(Refusal { code: ErrorCode::RateLimited, retry_after_ms: left });
                }
                w.count += 1;
                return Ok(());
            }
            *w = RateWindow { start: now, count: 1 };
            return Ok(());
        }
        if map.len() >= RATE_TRACKED_MAX {
            map.retain(|_, w| now.saturating_duration_since(w.start) < RATE_WINDOW);
            if map.len() >= RATE_TRACKED_MAX {
                return Err(Refusal { code: ErrorCode::RateLimited, retry_after_ms: BUSY_RETRY_MS });
            }
        }
        map.insert(*key, RateWindow { start: now, count: 1 });
        Ok(())
    }

    fn forget(&self, key: &[u8; 32]) {
        self.rate.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

// ── общие запросы ───────────────────────────────────────────────────────────

/// Блоб — копия ссылки (готовая либо копируемая)? Такой блоб методам
/// `cloud.blob.*` не виден.
pub(crate) async fn is_link_blob(pool_v2: &SqlitePool, file_id: &str) -> sqlx::Result<bool> {
    let row: Option<i64> = sqlx::query_scalar("SELECT 1 FROM link_blobs WHERE file_id = ?").bind(file_id).fetch_optional(pool_v2).await?;
    Ok(row.is_some())
}

/// Байты копий всех ссылок владельца (они же — в `used` bucket'а облака).
pub(crate) async fn owner_bytes(pool_v2: &SqlitePool, owner: &str) -> sqlx::Result<u64> {
    let (bytes,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(b.size), 0) FROM link_blobs b JOIN links l ON l.key = b.link_key WHERE l.owner = ?",
    )
    .bind(owner)
    .fetch_one(pool_v2)
    .await?;
    Ok(bytes.max(0) as u64)
}

/// Состояние своей ссылки: (состояние, срок). Чужая и несуществующая —
/// одинаково `NOT_FOUND`; не идентификатор — `INVALID`.
async fn own_link(ctx: &V2Ctx, what: &'static str, link_id: &str, owner: &str) -> Result<([u8; 32], i64, i64), ErrorCode> {
    let key = id_key(link_id).ok_or(ErrorCode::Invalid)?;
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT state, expires_at FROM links WHERE key = ? AND owner = ?")
        .bind(&key[..])
        .bind(owner)
        .fetch_optional(&ctx.pool_v2)
        .await
        .map_err(db_code(what))?;
    let (state, expires_at) = row.ok_or(ErrorCode::NotFound)?;
    Ok((key, state, expires_at))
}

/// Удалить копии ссылки (готовые и недокопированные) и их строки. Сама
/// строка ссылки к этому моменту уже удалена: читать её больше нельзя.
async fn drop_blobs(ctx: &V2Ctx, key: &[u8; 32]) -> Result<u64> {
    let files: Vec<(String,)> =
        sqlx::query_as("SELECT file_id FROM link_blobs WHERE link_key = ?").bind(&key[..]).fetch_all(&ctx.pool_v2).await?;
    for (file_id,) in &files {
        delete_blob_any(&ctx.pool, file_id).await?;
    }
    sqlx::query("DELETE FROM link_blobs WHERE link_key = ?").bind(&key[..]).execute(&ctx.pool_v2).await?;
    Ok(files.len() as u64)
}

// ── cloud.link.create ───────────────────────────────────────────────────────

pub(crate) async fn create(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let r: LinkCreateRequest = body(req)?;
    if !enabled() {
        return Err(ErrorCode::Forbidden);
    }
    let ttl = ttl_days(r.ttl_days)?;
    let link_id = new_id();
    let key: [u8; 32] = Sha256::digest(link_id.as_bytes()).into();
    // Предел числа ссылок владельца — одним запросом с вставкой.
    let done = sqlx::query(
        "INSERT INTO links (key, link_id, owner, state, ttl_days, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM links WHERE owner = ?) < ?",
    )
    .bind(&key[..])
    .bind(&link_id)
    .bind(owner)
    .bind(STATE_PREPARING)
    .bind(ttl)
    .bind(now_unix())
    .bind(owner)
    .bind(max_links())
    .execute(&ctx.pool_v2)
    .await
    .map_err(db_code("link.create"))?;
    if done.rows_affected() == 0 {
        return Err(ErrorCode::Limit);
    }
    debug!("v2: ссылка {}… заведена (срок {ttl} дн.)", short(&link_id));
    Ok(LinkCreateResponse { link_id }.encode_to_vec())
}

// ── cloud.link.add ──────────────────────────────────────────────────────────

/// Копия блоба в готовящуюся ссылку. Место в квоте облака занимается сразу
/// (копия заводится как незавершённая загрузка); при отказе не остаётся ни
/// чанков, ни строки.
pub(crate) async fn add(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    const WHAT: &str = "link.add";
    let owner = owner(req)?;
    let r: LinkAddRequest = body(req)?;
    let source = parse_id(&r.file_id)?;
    let (key, state, _) = own_link(ctx, WHAT, &r.link_id, owner).await?;
    if state != STATE_PREPARING {
        return Err(ErrorCode::Invalid);
    }
    if let Some(done) = existing_copy(ctx, &key, &source).await? {
        return Ok(done);
    }
    if blob_count(ctx, &key).await? >= max_files() {
        return Err(ErrorCode::Limit);
    }
    let (size, total) = copy_source(ctx, WHAT, owner, &source, &r.capability).await?;
    let file_id = begin_copy(ctx, WHAT, owner, BUCKET_DRIVE, size, total).await?;
    // Строка копии появляется, только пока ссылка своя и готовится и в ней
    // есть место: гонка с публикацией, отзывом и вторым add решается здесь.
    let reserved = sqlx::query(
        "INSERT OR IGNORE INTO link_blobs (link_key, source_id, file_id, state, size, chunks, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM links WHERE key = ?1 AND owner = ?8 AND state = ?9)
           AND (SELECT COUNT(*) FROM link_blobs WHERE link_key = ?1) < ?10",
    )
    .bind(&key[..])
    .bind(&source)
    .bind(&file_id)
    .bind(BLOB_COPYING)
    .bind(size)
    .bind(total)
    .bind(now_unix())
    .bind(owner)
    .bind(STATE_PREPARING)
    .bind(max_files())
    .execute(&ctx.pool_v2)
    .await;
    match reserved {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => {
            abort_copy(ctx, WHAT, &file_id).await;
            // Кто-то успел раньше: тот же источник, последнее место либо отзыв.
            if let Some(done) = existing_copy(ctx, &key, &source).await? {
                return Ok(done);
            }
            return Err(if blob_count(ctx, &key).await? >= max_files() { ErrorCode::Limit } else { ErrorCode::NotFound });
        }
        Err(e) => {
            abort_copy(ctx, WHAT, &file_id).await;
            return Err(db_code(WHAT)(e));
        }
    }
    if let Err(code) = copy_chunks(ctx, WHAT, owner, &source, &file_id, size, total).await {
        // Источник удалили посреди копии, ссылку отозвали либо сбой базы.
        forget_copy(ctx, &file_id).await;
        return Err(code);
    }
    let ready = sqlx::query("UPDATE link_blobs SET state = ? WHERE file_id = ?").bind(BLOB_READY).bind(&file_id).execute(&ctx.pool_v2).await;
    match ready {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => {
            // Ссылку отозвали, пока шла копия.
            abort_copy(ctx, WHAT, &file_id).await;
            return Err(ErrorCode::NotFound);
        }
        Err(e) => {
            forget_copy(ctx, &file_id).await;
            return Err(db_code(WHAT)(e));
        }
    }
    debug!("v2: в ссылку {}… скопирован файл {source} → {file_id} ({size} байт)", short(&r.link_id));
    Ok(LinkAddResponse { file_id, size: size.max(0) as u64, chunks: u32::try_from(total).unwrap_or(0) }.encode_to_vec())
}

/// Уже сделанная копия источника в ссылке: готовая — ответ, ещё идёт — `UNAVAILABLE`.
async fn existing_copy(ctx: &V2Ctx, key: &[u8; 32], source: &str) -> Result<Option<Vec<u8>>, ErrorCode> {
    let row: Option<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT file_id, state, size, chunks FROM link_blobs WHERE link_key = ? AND source_id = ?")
            .bind(&key[..])
            .bind(source)
            .fetch_optional(&ctx.pool_v2)
            .await
            .map_err(db_code("link.add"))?;
    match row {
        None => Ok(None),
        Some((file_id, BLOB_READY, size, chunks)) => {
            Ok(Some(LinkAddResponse { file_id, size: size.max(0) as u64, chunks: u32::try_from(chunks).unwrap_or(0) }.encode_to_vec()))
        }
        Some(_) => Err(ErrorCode::Unavailable),
    }
}

async fn blob_count(ctx: &V2Ctx, key: &[u8; 32]) -> Result<i64, ErrorCode> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM link_blobs WHERE link_key = ?")
        .bind(&key[..])
        .fetch_one(&ctx.pool_v2)
        .await
        .map_err(db_code("link.add"))?;
    Ok(n)
}

/// Убрать несостоявшуюся копию: блоб и её строку.
async fn forget_copy(ctx: &V2Ctx, file_id: &str) {
    abort_copy(ctx, "link.add", file_id).await;
    if let Err(e) = sqlx::query("DELETE FROM link_blobs WHERE file_id = ?").bind(file_id).execute(&ctx.pool_v2).await {
        error!("v2 link.add: строка копии не удалена: {e}");
    }
}

// ── cloud.link.publish ──────────────────────────────────────────────────────

pub(crate) async fn publish(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    const WHAT: &str = "link.publish";
    let owner = owner(req)?;
    let r: LinkPublishRequest = body(req)?;
    if r.manifest.is_empty() {
        return Err(ErrorCode::Invalid);
    }
    let key = id_key(&r.link_id).ok_or(ErrorCode::Invalid)?;
    let row: Option<(i64, i64, i64, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT state, ttl_days, expires_at, manifest FROM links WHERE key = ? AND owner = ?")
            .bind(&key[..])
            .bind(owner)
            .fetch_optional(&ctx.pool_v2)
            .await
            .map_err(db_code(WHAT))?;
    let (state, ttl, expires_at, stored) = row.ok_or(ErrorCode::NotFound)?;
    if state != STATE_PREPARING {
        // Повтор публикации с тем же списком (ответ первого вызова потерян) — не ошибка.
        return if stored.as_deref() == Some(r.manifest.as_slice()) {
            Ok(LinkPublishResponse { expires_at: expires_at.max(0) as u64 }.encode_to_vec())
        } else {
            Err(ErrorCode::Invalid)
        };
    }
    let expires_at = expiry(now_unix(), ttl);
    // Публикуется только ссылка без недокопированных файлов — одним запросом,
    // чтобы add не успел вклиниться между проверкой и сменой состояния.
    let done = sqlx::query(
        "UPDATE links SET state = ?1, manifest = ?2, owner_record = ?3, expires_at = ?4
         WHERE key = ?5 AND owner = ?6 AND state = ?7
           AND NOT EXISTS (SELECT 1 FROM link_blobs WHERE link_key = ?5 AND state = ?8)",
    )
    .bind(STATE_ACTIVE)
    .bind(&r.manifest)
    .bind(&r.owner_record)
    .bind(expires_at)
    .bind(&key[..])
    .bind(owner)
    .bind(STATE_PREPARING)
    .bind(BLOB_COPYING)
    .execute(&ctx.pool_v2)
    .await
    .map_err(db_code(WHAT))?;
    if done.rows_affected() == 0 {
        // Копия ещё идёт (либо ссылку только что отозвали — повтор это покажет).
        return Err(ErrorCode::Unavailable);
    }
    debug!("v2: ссылка {}… опубликована, срок до {expires_at}", short(&r.link_id));
    Ok(LinkPublishResponse { expires_at: expires_at.max(0) as u64 }.encode_to_vec())
}

// ── cloud.link.list ─────────────────────────────────────────────────────────

pub(crate) async fn list(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    let owner = owner(req)?;
    let _: LinkListRequest = body(req)?;
    let rows: Vec<(String, i64, i64, i64, Option<Vec<u8>>, i64, i64)> = sqlx::query_as(
        "SELECT l.link_id, l.state, l.created_at, l.expires_at, l.owner_record,
                (SELECT COALESCE(SUM(b.size), 0) FROM link_blobs b WHERE b.link_key = l.key),
                (SELECT COUNT(*) FROM link_blobs b WHERE b.link_key = l.key)
         FROM links l WHERE l.owner = ? ORDER BY l.created_at DESC, l.link_id LIMIT ?",
    )
    .bind(owner)
    .bind(LIST_MAX)
    .fetch_all(&ctx.pool_v2)
    .await
    .map_err(db_code("link.list"))?;
    let now = now_unix();
    let links = rows
        .into_iter()
        .map(|(link_id, state, created_at, expires_at, owner_record, bytes, files)| LinkInfo {
            link_id,
            state: match state {
                STATE_PREPARING => LinkState::Preparing,
                _ if is_expired(expires_at, now) => LinkState::Expired,
                _ => LinkState::Active,
            } as i32,
            created_at: created_at.max(0) as u64,
            expires_at: expires_at.max(0) as u64,
            bytes: bytes.max(0) as u64,
            files: u32::try_from(files).unwrap_or(0),
            owner_record: owner_record.unwrap_or_default(),
        })
        .collect();
    Ok(LinkListResponse { links }.encode_to_vec())
}

// ── cloud.link.revoke ───────────────────────────────────────────────────────

pub(crate) async fn revoke(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    const WHAT: &str = "link.revoke";
    let owner = owner(req)?;
    let r: LinkRevokeRequest = body(req)?;
    let key = id_key(&r.link_id).ok_or(ErrorCode::Invalid)?;
    // Сначала строка ссылки: с этого запроса получателю не отдаётся ничего.
    let done = sqlx::query("DELETE FROM links WHERE key = ? AND owner = ?")
        .bind(&key[..])
        .bind(owner)
        .execute(&ctx.pool_v2)
        .await
        .map_err(db_code(WHAT))?;
    if done.rows_affected() == 0 {
        return Err(ErrorCode::NotFound);
    }
    ctx.links.forget(&key);
    match drop_blobs(ctx, &key).await {
        Ok(n) => debug!("v2: ссылка {}… отозвана, копий удалено: {n}", short(&r.link_id)),
        // Ссылка уже закрыта; оставшиеся без неё копии уберёт purge.
        Err(e) => error!("v2 {WHAT}: копии ссылки {}… удалены не все: {e:#}", short(&r.link_id)),
    }
    release_free_pages(&ctx.pool).await;
    Ok(LinkRevokeResponse {}.encode_to_vec())
}

// ── cloud.link.extend ───────────────────────────────────────────────────────

pub(crate) async fn extend(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, ErrorCode> {
    const WHAT: &str = "link.extend";
    let owner = owner(req)?;
    let r: LinkExtendRequest = body(req)?;
    let ttl = ttl_days(r.ttl_days)?;
    let (key, state, expires_at) = own_link(ctx, WHAT, &r.link_id, owner).await?;
    if state != STATE_ACTIVE {
        return Err(ErrorCode::Invalid);
    }
    let now = now_unix();
    // Истёкшая дольше срока льготы — уже ничья: её копии ждут сборщика.
    if past_grace(expires_at, now) {
        return Err(ErrorCode::NotFound);
    }
    let new_expiry = expiry(now, ttl);
    let done = sqlx::query("UPDATE links SET ttl_days = ?, expires_at = ? WHERE key = ? AND owner = ? AND state = ?")
        .bind(ttl)
        .bind(new_expiry)
        .bind(&key[..])
        .bind(owner)
        .bind(STATE_ACTIVE)
        .execute(&ctx.pool_v2)
        .await
        .map_err(db_code(WHAT))?;
    if done.rows_affected() == 0 {
        return Err(ErrorCode::NotFound);
    }
    debug!("v2: ссылка {}… продлена до {new_expiry}", short(&r.link_id));
    Ok(LinkExtendResponse { expires_at: new_expiry.max(0) as u64 }.encode_to_vec())
}

// ── cloud.link.get / cloud.link.download (анонимный канал) ──────────────────

/// Ссылка, которую можно показывать получателю.
struct Served {
    key: [u8; 32],
    expires_at: i64,
    expired: bool,
}

/// Найти ссылку для получателя и учесть обращение. Нет такой, отозвана,
/// готовится, истекла дольше срока льготы, не идентификатор — одинаково
/// `NOT_FOUND`, и в счёт частоты такие обращения не идут (счётчик держит
/// только существующие ссылки).
async fn served(ctx: &V2Ctx, what: &'static str, link_id: &str) -> Result<Served, Refusal> {
    let key = id_key(link_id).ok_or(ErrorCode::NotFound)?;
    let row: Option<(String, i64, i64)> = sqlx::query_as("SELECT link_id, state, expires_at FROM links WHERE key = ?")
        .bind(&key[..])
        .fetch_optional(&ctx.pool_v2)
        .await
        .map_err(db_code(what))?;
    let (stored, state, expires_at) = row.ok_or(ErrorCode::NotFound)?;
    let same: bool = stored.as_bytes().ct_eq(link_id.as_bytes()).into();
    let now = now_unix();
    if !same || state != STATE_ACTIVE || past_grace(expires_at, now) {
        return Err(ErrorCode::NotFound.into());
    }
    ctx.links.hit(&key, Instant::now())?;
    Ok(Served { key, expires_at, expired: is_expired(expires_at, now) })
}

pub(crate) async fn get(ctx: &V2Ctx, req: &ShardRequest) -> Result<Vec<u8>, Refusal> {
    const WHAT: &str = "link.get";
    // Личности нет и она не нужна: доступ — по идентификатору, чтение — ключом из адреса.
    let r: LinkGetRequest = body(req)?;
    let link = served(ctx, WHAT, &r.link_id).await?;
    let expires_at = link.expires_at.max(0) as u64;
    if link.expired {
        return Ok(LinkGetResponse { manifest: Vec::new(), expires_at, expired: true }.encode_to_vec());
    }
    let manifest: Option<Option<Vec<u8>>> = sqlx::query_scalar("SELECT manifest FROM links WHERE key = ? AND state = ?")
        .bind(&link.key[..])
        .bind(STATE_ACTIVE)
        .fetch_optional(&ctx.pool_v2)
        .await
        .map_err(db_code(WHAT))?;
    // Отозвали между двумя запросами — как будто её не было.
    let manifest = manifest.flatten().ok_or(ErrorCode::NotFound)?;
    Ok(LinkGetResponse { manifest, expires_at, expired: false }.encode_to_vec())
}

pub(crate) async fn plan_download(ctx: &V2Ctx, req: &ShardRequest) -> Result<Plan, Refusal> {
    const WHAT: &str = "link.download";
    let r: LinkDownloadRequest = body(req)?;
    let link = served(ctx, WHAT, &r.link_id).await?;
    if link.expired {
        return Err(ErrorCode::Expired.into());
    }
    let file_id = parse_id(&r.file_id)?;
    // Право — файл входит в эту действующую ссылку; блоб не из ссылки, из
    // чужой ссылки и недокопированный неразличимы.
    let row: Option<(Vec<u8>, i64)> = sqlx::query_as("SELECT link_key, state FROM link_blobs WHERE file_id = ?")
        .bind(&file_id)
        .fetch_optional(&ctx.pool_v2)
        .await
        .map_err(db_code(WHAT))?;
    let (of_link, state) = row.ok_or(ErrorCode::NotFound)?;
    let same: bool = of_link.as_slice().ct_eq(&link.key[..]).into();
    if !same || state != BLOB_READY {
        return Err(ErrorCode::NotFound.into());
    }
    let meta = file_meta_any(&ctx.pool, &file_id).await.map_err(|e| store_code(WHAT, e))?.ok_or(ErrorCode::NotFound)?;
    let (total, from, to) = window(&meta, r.first_chunk, r.chunk_count)?;
    let meta = LinkDownloadResponse { size: meta.size_bytes.max(0) as u64, chunks: total }.encode_to_vec();
    Ok(Plan { file_id, meta, from, to })
}

// ── сборщик ─────────────────────────────────────────────────────────────────

/// Убрать брошенное: готовящиеся ссылки старше суток, истёкшие дольше срока
/// льготы и копии, оставшиеся без ссылки (обрыв посреди отзыва). Возвращает
/// число удалённых ссылок. Вызывается при старте и раз в час.
pub(crate) async fn purge(ctx: &V2Ctx) -> Result<u64> {
    let now = now_unix();
    let (stale, dead) = (now - PREPARING_TTL_SECS, now - grace_secs());
    const DUE: &str = "((state = ?1 AND created_at < ?2) OR (state = ?3 AND expires_at != 0 AND expires_at < ?4))";
    let due: Vec<(Vec<u8>,)> = sqlx::query_as(&format!("SELECT key FROM links WHERE {DUE}"))
        .bind(STATE_PREPARING)
        .bind(stale)
        .bind(STATE_ACTIVE)
        .bind(dead)
        .fetch_all(&ctx.pool_v2)
        .await?;
    let mut removed = 0;
    for (key,) in due {
        let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) else { continue };
        // Условие повторяется: ссылку могли продлить после выборки.
        let done = sqlx::query(&format!("DELETE FROM links WHERE {DUE} AND key = ?5"))
            .bind(STATE_PREPARING)
            .bind(stale)
            .bind(STATE_ACTIVE)
            .bind(dead)
            .bind(&key[..])
            .execute(&ctx.pool_v2)
            .await?;
        if done.rows_affected() == 1 {
            ctx.links.forget(&key);
            drop_blobs(ctx, &key).await?;
            removed += 1;
        }
    }
    let orphans: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT DISTINCT link_key FROM link_blobs WHERE link_key NOT IN (SELECT key FROM links)")
            .fetch_all(&ctx.pool_v2)
            .await?;
    for (key,) in orphans {
        if let Ok(key) = <[u8; 32]>::try_from(key.as_slice()) {
            drop_blobs(ctx, &key).await?;
        }
    }
    Ok(removed)
}

/// При старте шарда: копии, которые копировались в момент остановки, уже
/// никто не докопирует — убираем их (иначе повтор add вечно отвечал бы
/// «ещё идёт»), затем обычная чистка.
pub(crate) async fn recover(ctx: &V2Ctx) -> Result<u64> {
    let stuck: Vec<(String,)> =
        sqlx::query_as("SELECT file_id FROM link_blobs WHERE state = ?").bind(BLOB_COPYING).fetch_all(&ctx.pool_v2).await?;
    for (file_id,) in stuck {
        delete_blob_any(&ctx.pool, &file_id).await?;
        sqlx::query("DELETE FROM link_blobs WHERE file_id = ?").bind(&file_id).execute(&ctx.pool_v2).await?;
    }
    purge(ctx).await
}

#[cfg(test)]
mod tests {
    use super::super::tests::{copy_of, ctx, dl, dl_cap, req, run_stream, up_drive, upload, usage_of};
    use super::*;
    use crate::tests::QUOTA_OVERRIDE;
    use parvane_protocol::pb::parvane::cloud::v1::{
        BlobBucket, DeleteRequest, UploadCompleteRequest, Visibility,
    };

    const ALICE: &str = "alice@local";
    const MALLORY: &str = "mallory@local";

    async fn create_of(c: &V2Ctx, user: &str, ttl: u32) -> Result<String, ErrorCode> {
        create(c, &req("cloud.link.create", user, LinkCreateRequest { ttl_days: ttl })).await.map(|b| LinkCreateResponse::decode(b.as_slice()).unwrap().link_id)
    }

    async fn add_of(c: &V2Ctx, user: &str, link: &str, source: &str, cap: &[u8]) -> Result<LinkAddResponse, ErrorCode> {
        let r = req("cloud.link.add", user, LinkAddRequest { link_id: link.into(), file_id: source.into(), capability: cap.to_vec() });
        add(c, &r).await.map(|b| LinkAddResponse::decode(b.as_slice()).unwrap())
    }

    async fn publish_of(c: &V2Ctx, user: &str, link: &str, manifest: &[u8]) -> Result<u64, ErrorCode> {
        let r = req(
            "cloud.link.publish",
            user,
            LinkPublishRequest { link_id: link.into(), manifest: manifest.to_vec(), owner_record: b"owner-record".to_vec() },
        );
        publish(c, &r).await.map(|b| LinkPublishResponse::decode(b.as_slice()).unwrap().expires_at)
    }

    async fn list_of(c: &V2Ctx, user: &str) -> Vec<LinkInfo> {
        let b = list(c, &req("cloud.link.list", user, LinkListRequest {})).await.unwrap();
        LinkListResponse::decode(b.as_slice()).unwrap().links
    }

    async fn revoke_of(c: &V2Ctx, user: &str, link: &str) -> Result<(), ErrorCode> {
        revoke(c, &req("cloud.link.revoke", user, LinkRevokeRequest { link_id: link.into() })).await.map(|_| ())
    }

    async fn extend_of(c: &V2Ctx, user: &str, link: &str, ttl: u32) -> Result<u64, ErrorCode> {
        let r = req("cloud.link.extend", user, LinkExtendRequest { link_id: link.into(), ttl_days: ttl });
        extend(c, &r).await.map(|b| LinkExtendResponse::decode(b.as_slice()).unwrap().expires_at)
    }

    /// Запрос получателя: без личности.
    async fn get_of(c: &V2Ctx, link: &str) -> Result<LinkGetResponse, Refusal> {
        get(c, &req("cloud.link.get", "", LinkGetRequest { link_id: link.into() })).await.map(|b| LinkGetResponse::decode(b.as_slice()).unwrap())
    }

    fn dl_link(link: &str, file_id: &str, first: u32, count: u32) -> ShardRequest {
        req(DOWNLOAD, "", LinkDownloadRequest { link_id: link.into(), file_id: file_id.into(), first_chunk: first, chunk_count: count })
    }

    async fn fetch(c: &V2Ctx, link: &str, file_id: &str) -> Result<Vec<u8>, i32> {
        let (head, chunks) = run_stream(c, DOWNLOAD, dl_link(link, file_id, 0, 0)).await;
        head.map(|_| chunks.iter().flat_map(|c| c.data.clone()).collect())
    }

    /// Файл облака владельца (bucket DRIVE) из частей.
    async fn drive_file(c: &V2Ctx, user: &str, parts: &[&[u8]]) -> String {
        let id = up_drive(c, user, "", 0, parts[0]).await.unwrap();
        for (i, p) in parts.iter().enumerate().skip(1) {
            up_drive(c, user, &id, i as u32, p).await.unwrap();
        }
        let r = req(
            "cloud.blob.upload_complete",
            user,
            UploadCompleteRequest {
                upload_id: id.clone(),
                chunks: parts.len() as u32,
                size: parts.iter().map(|p| p.len() as u64).sum(),
                visibility: Visibility::Private as i32,
                capability_hash: Vec::new(),
            },
        );
        super::super::upload_complete(c, &r).await.unwrap();
        id
    }

    /// Действующая ссылка на один файл: (ссылка, копия).
    async fn published(c: &V2Ctx, user: &str, parts: &[&[u8]], ttl: u32) -> (String, String) {
        let source = drive_file(c, user, parts).await;
        let link = create_of(c, user, ttl).await.unwrap();
        let copy = add_of(c, user, &link, &source, &[]).await.unwrap().file_id;
        publish_of(c, user, &link, b"manifest-ciphertext").await.unwrap();
        (link, copy)
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.unwrap();
        n
    }

    async fn set_expiry(c: &V2Ctx, link: &str, expires_at: i64) {
        sqlx::query("UPDATE links SET expires_at = ? WHERE link_id = ?").bind(expires_at).bind(link).execute(&c.pool_v2).await.unwrap();
    }

    #[tokio::test]
    async fn link_lifecycle_for_anonymous_reader() {
        let c = ctx().await;
        let source = drive_file(&c, ALICE, &[b"AAAA", b"BBBB", b"CC"]).await;
        let link = create_of(&c, ALICE, 7).await.unwrap();
        assert_eq!(link.len(), 22);
        assert!(link.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(create_of(&c, ALICE, 7).await.unwrap(), link, "идентификаторы случайны");
        // Готовящаяся ссылка получателю не видна — как несуществующая.
        assert_eq!(get_of(&c, &link).await.unwrap_err().code, ErrorCode::NotFound);
        let made = add_of(&c, ALICE, &link, &source, &[]).await.unwrap();
        assert_eq!((made.size, made.chunks), (10, 3));
        assert_ne!(made.file_id, source);
        // Повтор с тем же источником — та же копия, место не удваивается.
        assert_eq!(add_of(&c, ALICE, &link, &source, &[]).await.unwrap(), made);
        assert_eq!(usage_of(&c, ALICE).await[1].1, 20, "источник и копия — в квоте облака");
        assert_eq!(links_bytes(&c, ALICE).await, 10);
        assert_eq!(fetch(&c, &link, &made.file_id).await.unwrap_err(), ErrorCode::NotFound as i32, "до публикации файл не отдаётся");
        let before = now_unix() as u64;
        let expires = publish_of(&c, ALICE, &link, b"manifest-ciphertext").await.unwrap();
        assert!(expires >= before + 7 * 86400 && expires <= before + 7 * 86400 + 5);
        // Получатель: список и файл — без личности.
        let got = get_of(&c, &link).await.unwrap();
        assert_eq!((got.manifest.as_slice(), got.expires_at, got.expired), (&b"manifest-ciphertext"[..], expires, false));
        let (head, chunks) = run_stream(&c, DOWNLOAD, dl_link(&link, &made.file_id, 0, 0)).await;
        let meta = LinkDownloadResponse::decode(head.unwrap().as_slice()).unwrap();
        assert_eq!((meta.size, meta.chunks), (10, 3));
        assert_eq!(chunks.iter().flat_map(|c| c.data.clone()).collect::<Vec<_>>(), b"AAAABBBBCC");
        let (_, part) = run_stream(&c, DOWNLOAD, dl_link(&link, &made.file_id, 1, 1)).await;
        assert_eq!((part.len(), part[0].index, part[0].last, part[0].data.as_slice()), (1, 1, true, &b"BBBB"[..]));
        // Снимок: источник удалён — ссылка отдаёт прежнее.
        super::super::delete(&c, &req("cloud.blob.delete", ALICE, DeleteRequest { file_id: source.clone() })).await.unwrap();
        assert_eq!(fetch(&c, &link, &made.file_id).await.unwrap(), b"AAAABBBBCC");
        // Владелец видит ссылку в списке (вторая — ещё готовится).
        let mine = list_of(&c, ALICE).await;
        assert_eq!(mine.len(), 2);
        let info = mine.iter().find(|l| l.link_id == link).unwrap();
        assert_eq!((info.state, info.bytes, info.files, info.expires_at), (LinkState::Active as i32, 10, 1, expires));
        assert_eq!(info.owner_record, b"owner-record");
        assert!(info.created_at >= before - 5 && info.created_at <= before + 5);
        let other = mine.iter().find(|l| l.link_id != link).unwrap();
        assert_eq!((other.state, other.files, other.expires_at), (LinkState::Preparing as i32, 0, 0));
        // Повтор публикации с тем же списком — прежний ответ; с другим и add после публикации — отказ.
        assert_eq!(publish_of(&c, ALICE, &link, b"manifest-ciphertext").await.unwrap(), expires);
        assert_eq!(publish_of(&c, ALICE, &link, b"other").await.unwrap_err(), ErrorCode::Invalid);
        let more = drive_file(&c, ALICE, &[b"x"]).await;
        assert_eq!(add_of(&c, ALICE, &link, &more, &[]).await.unwrap_err(), ErrorCode::Invalid);
        // Без срока.
        let forever = create_of(&c, ALICE, 0).await.unwrap();
        assert_eq!(publish_of(&c, ALICE, &forever, b"m").await.unwrap(), 0);
        assert_eq!(get_of(&c, &forever).await.unwrap().expires_at, 0);
    }

    async fn links_bytes(c: &V2Ctx, user: &str) -> u64 {
        owner_bytes(&c.pool_v2, user).await.unwrap()
    }

    #[tokio::test]
    async fn source_by_capability_and_usage_field() {
        use parvane_protocol::pb::parvane::cloud::v1::{UsageRequest, UsageResponse};
        let c = ctx().await;
        let cap = [7u8; 32];
        // Файл совместной папки: чужой блоб, известен его секрет.
        let shared = upload(&c, "bob@local", &[b"shared-file"], Visibility::Private, &Sha256::digest(cap)).await;
        let link = create_of(&c, ALICE, 1).await.unwrap();
        assert_eq!(add_of(&c, ALICE, &link, &shared, &[]).await.unwrap_err(), ErrorCode::NotFound, "чужой файл без секрета");
        assert_eq!(add_of(&c, ALICE, &link, &shared, &[1u8; 32]).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(add_of(&c, ALICE, &link, &shared, &cap[..8]).await.unwrap_err(), ErrorCode::Invalid);
        let made = add_of(&c, ALICE, &link, &shared, &cap).await.unwrap();
        assert_eq!(made.size, 11);
        // Копия — в квоте того, кто создал ссылку, в bucket'е облака.
        let b = super::super::usage(&c, &req("cloud.blob.usage", ALICE, UsageRequest {})).await.unwrap();
        let u = UsageResponse::decode(b.as_slice()).unwrap();
        assert_eq!((u.buckets[0].used, u.buckets[1].used, u.links_bytes), (0, 11, 11));
        let b = super::super::usage(&c, &req("cloud.blob.usage", "bob@local", UsageRequest {})).await.unwrap();
        assert_eq!(UsageResponse::decode(b.as_slice()).unwrap().links_bytes, 0);
        publish_of(&c, ALICE, &link, b"m").await.unwrap();
        assert_eq!(fetch(&c, &link, &made.file_id).await.unwrap(), b"shared-file");
    }

    #[tokio::test]
    async fn link_copy_is_invisible_to_blob_methods() {
        let c = ctx().await;
        let (link, copy) = published(&c, ALICE, &[b"secret-bytes"], 7).await;
        // Секрета у копии нет: по capability не читается никаким значением.
        assert_eq!(count(&c.pool_v2, "blob_caps").await, 0);
        for cap in [[0u8; 32], [7u8; 32]] {
            let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&copy, &cap, 0, 0)).await;
            assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        }
        // Даже с посторонней строкой blob_caps копия по секрету не отдаётся.
        super::super::put_cap(&c.pool_v2, &copy, &Sha256::digest([9u8; 32])).await.unwrap();
        let (head, _) = run_stream(&c, "cloud.blob.download_cap", dl_cap(&copy, &[9u8; 32], 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        assert_eq!(copy_of(&c, MALLORY, &copy, &[9u8; 32], BlobBucket::Drive, &[1u8; 32]).await.unwrap_err(), ErrorCode::NotFound);
        // Владелец обычными методами копию не читает, не копирует и не удаляет.
        let (head, _) = run_stream(&c, "cloud.blob.download", dl(ALICE, &copy, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        assert_eq!(copy_of(&c, ALICE, &copy, &[], BlobBucket::Drive, &[1u8; 32]).await.unwrap_err(), ErrorCode::NotFound);
        let del = super::super::delete(&c, &req("cloud.blob.delete", ALICE, DeleteRequest { file_id: copy.clone() })).await;
        assert_eq!(del.unwrap_err(), ErrorCode::NotFound);
        let other_link = create_of(&c, ALICE, 7).await.unwrap();
        assert_eq!(add_of(&c, ALICE, &other_link, &copy, &[]).await.unwrap_err(), ErrorCode::NotFound, "копия — не источник");
        // Ссылка цела.
        assert_eq!(fetch(&c, &link, &copy).await.unwrap(), b"secret-bytes");
    }

    #[tokio::test]
    async fn download_serves_only_files_of_that_link() {
        let c = ctx().await;
        let (link, copy) = published(&c, ALICE, &[b"first"], 7).await;
        let (other, other_copy) = published(&c, ALICE, &[b"second"], 7).await;
        // Обычный блоб владельца (в том числе публичный) через ссылку не читается.
        let plain = drive_file(&c, ALICE, &[b"private"]).await;
        let public = upload(&c, ALICE, &[b"avatar"], Visibility::Public, &[]).await;
        for file in [&plain, &public, &other_copy, &uuid::Uuid::now_v7().to_string()] {
            assert_eq!(fetch(&c, &link, file).await.unwrap_err(), ErrorCode::NotFound as i32);
        }
        assert_eq!(fetch(&c, &other, &copy).await.unwrap_err(), ErrorCode::NotFound as i32);
        // Нет такой ссылки, не идентификатор, идентификатор не той длины — NOT_FOUND.
        for bad in [new_id(), "nope".to_string(), String::new(), format!("{link}A"), "!".repeat(22)] {
            assert_eq!(fetch(&c, &bad, &copy).await.unwrap_err(), ErrorCode::NotFound as i32, "{bad}");
            assert_eq!(get_of(&c, &bad).await.unwrap_err().code, ErrorCode::NotFound, "{bad}");
        }
        // Кривой file_id в существующей ссылке — INVALID; окно за концом файла — тоже.
        assert_eq!(fetch(&c, &link, "nope").await.unwrap_err(), ErrorCode::Invalid as i32);
        let (head, _) = run_stream(&c, DOWNLOAD, dl_link(&link, &copy, 5, 1)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::Invalid as i32);
        assert_eq!(fetch(&c, &link, &copy).await.unwrap(), b"first");
        assert_eq!(fetch(&c, &other, &other_copy).await.unwrap(), b"second");
    }

    #[tokio::test]
    async fn only_owner_manages_link() {
        let c = ctx().await;
        let source = drive_file(&c, ALICE, &[b"data"]).await;
        let theirs = drive_file(&c, MALLORY, &[b"evil"]).await;
        let link = create_of(&c, ALICE, 7).await.unwrap();
        // Чужая ссылка — как несуществующая.
        assert_eq!(add_of(&c, MALLORY, &link, &theirs, &[]).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(publish_of(&c, MALLORY, &link, b"m").await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(revoke_of(&c, MALLORY, &link).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(extend_of(&c, MALLORY, &link, 7).await.unwrap_err(), ErrorCode::NotFound);
        assert!(list_of(&c, MALLORY).await.is_empty());
        let copy = add_of(&c, ALICE, &link, &source, &[]).await.unwrap().file_id;
        publish_of(&c, ALICE, &link, b"m").await.unwrap();
        assert_eq!(revoke_of(&c, MALLORY, &link).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(extend_of(&c, MALLORY, &link, 0).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(fetch(&c, &link, &copy).await.unwrap(), b"data");
        // Без личности ID-методы не работают; кривой идентификатор — INVALID.
        assert_eq!(create_of(&c, "", 7).await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(add_of(&c, "", &link, &source, &[]).await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(publish_of(&c, "", &link, b"m").await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(revoke_of(&c, "", &link).await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(extend_of(&c, "", &link, 7).await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(list(&c, &req("cloud.link.list", "", LinkListRequest {})).await.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(revoke_of(&c, ALICE, "nope").await.unwrap_err(), ErrorCode::Invalid);
        assert_eq!(add_of(&c, ALICE, "nope", &source, &[]).await.unwrap_err(), ErrorCode::Invalid);
        assert_eq!(revoke_of(&c, ALICE, &new_id()).await.unwrap_err(), ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn limits_and_switch() {
        let c = ctx().await;
        // Срок — только 0, 1, 7, 30 дней.
        for bad in [2u32, 31, 365] {
            assert_eq!(create_of(&c, ALICE, bad).await.unwrap_err(), ErrorCode::Invalid);
        }
        let link = create_of(&c, ALICE, 30).await.unwrap();
        assert_eq!(extend_of(&c, ALICE, &link, 7).await.unwrap_err(), ErrorCode::Invalid, "готовящуюся не продлить");
        assert_eq!(publish_of(&c, ALICE, &link, b"").await.unwrap_err(), ErrorCode::Invalid, "пустой список");
        // Предел файлов на ссылку и ссылок на владельца.
        LIMITS_OVERRIDE.with(|l| l.set(Some((2, 2))));
        let a = drive_file(&c, ALICE, &[b"a"]).await;
        let b = drive_file(&c, ALICE, &[b"b"]).await;
        let third = drive_file(&c, ALICE, &[b"c"]).await;
        let first = add_of(&c, ALICE, &link, &a, &[]).await;
        let second = add_of(&c, ALICE, &link, &b, &[]).await;
        let over = add_of(&c, ALICE, &link, &third, &[]).await;
        let repeat = add_of(&c, ALICE, &link, &a, &[]).await;
        let link2 = create_of(&c, ALICE, 7).await;
        let link3 = create_of(&c, ALICE, 7).await;
        let other_owner = create_of(&c, MALLORY, 7).await;
        // Отзыв освобождает место в пределе ссылок.
        let freed = revoke_of(&c, ALICE, &link).await;
        let again = create_of(&c, ALICE, 7).await;
        LIMITS_OVERRIDE.with(|l| l.set(None));
        assert!(first.is_ok() && second.is_ok() && link2.is_ok() && other_owner.is_ok() && freed.is_ok() && again.is_ok());
        assert_eq!(over.unwrap_err(), ErrorCode::Limit);
        assert_eq!(repeat.unwrap(), first.unwrap(), "повтор в полной ссылке — прежняя копия");
        assert_eq!(link3.unwrap_err(), ErrorCode::Limit);
        // Выключатель: новые ссылки создавать нельзя, прежние работают.
        let (live, copy) = published(&c, ALICE, &[b"live"], 7).await;
        DISABLED_OVERRIDE.with(|d| d.set(true));
        let refused = create_of(&c, ALICE, 7).await;
        let still = fetch(&c, &live, &copy).await;
        let revoked = revoke_of(&c, ALICE, &live).await;
        DISABLED_OVERRIDE.with(|d| d.set(false));
        assert_eq!(refused.unwrap_err(), ErrorCode::Forbidden);
        assert_eq!(still.unwrap(), b"live");
        assert!(revoked.is_ok());
    }

    #[tokio::test]
    async fn quota_refusal_leaves_no_partial_copy() {
        let c = ctx().await;
        let source = drive_file(&c, ALICE, &[b"0123", b"4567"]).await;
        let link = create_of(&c, ALICE, 7).await.unwrap();
        // Занято 8 из 12: копия в 8 байт не помещается.
        QUOTA_OVERRIDE.with(|q| q.set(Some(12)));
        let refused = add_of(&c, ALICE, &link, &source, &[]).await;
        QUOTA_OVERRIDE.with(|q| q.set(None));
        assert_eq!(refused.unwrap_err(), ErrorCode::Limit);
        assert_eq!((count(&c.pool, "chunks").await, count(&c.pool, "uploads").await, count(&c.pool, "files").await), (2, 0, 1));
        assert_eq!(count(&c.pool_v2, "link_blobs").await, 0);
        assert_eq!(links_bytes(&c, ALICE).await, 0);
        // Место есть — тот же вызов проходит.
        assert!(add_of(&c, ALICE, &link, &source, &[]).await.is_ok());
        // Источник исчез — ни копии, ни строки.
        let gone = uuid::Uuid::now_v7().to_string();
        assert_eq!(add_of(&c, ALICE, &link, &gone, &[]).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(count(&c.pool_v2, "link_blobs").await, 1);
    }

    #[tokio::test]
    async fn copy_in_progress_blocks_repeat_and_publish() {
        let c = ctx().await;
        let source = drive_file(&c, ALICE, &[b"data"]).await;
        let link = create_of(&c, ALICE, 7).await.unwrap();
        let key = id_key(&link).unwrap();
        // Копия этого источника ещё идёт (другой запрос).
        sqlx::query("INSERT INTO link_blobs (link_key, source_id, file_id, state, size, chunks, created_at) VALUES (?, ?, 'copying', 0, 4, 1, 0)")
            .bind(&key[..])
            .bind(&source)
            .execute(&c.pool_v2)
            .await
            .unwrap();
        assert_eq!(add_of(&c, ALICE, &link, &source, &[]).await.unwrap_err(), ErrorCode::Unavailable);
        assert_eq!(publish_of(&c, ALICE, &link, b"m").await.unwrap_err(), ErrorCode::Unavailable);
        assert_eq!(get_of(&c, &link).await.unwrap_err().code, ErrorCode::NotFound);
        // После перезапуска шарда зависшая копия убрана — повтор проходит.
        assert_eq!(recover(&c).await.unwrap(), 0);
        let made = add_of(&c, ALICE, &link, &source, &[]).await.unwrap();
        publish_of(&c, ALICE, &link, b"m").await.unwrap();
        assert_eq!(fetch(&c, &link, &made.file_id).await.unwrap(), b"data");
    }

    #[tokio::test]
    async fn expired_link_serves_nothing_until_extended() {
        let c = ctx().await;
        let (link, copy) = published(&c, ALICE, &[b"payload"], 1).await;
        let now = now_unix();
        set_expiry(&c, &link, now - 10).await;
        // Истёкшая: списка нет, файл не отдаётся; место по-прежнему занято.
        let got = get_of(&c, &link).await.unwrap();
        assert!(got.expired && got.manifest.is_empty());
        assert_eq!(got.expires_at, (now - 10) as u64);
        assert_eq!(fetch(&c, &link, &copy).await.unwrap_err(), ErrorCode::Expired as i32);
        assert_eq!(list_of(&c, ALICE).await[0].state, LinkState::Expired as i32);
        assert_eq!(links_bytes(&c, ALICE).await, 7);
        assert_eq!(purge(&c).await.unwrap(), 0, "в срок льготы копии остаются");
        // Продление возвращает ту же ссылку.
        assert_eq!(extend_of(&c, ALICE, &link, 5).await.unwrap_err(), ErrorCode::Invalid);
        let until = extend_of(&c, ALICE, &link, 7).await.unwrap();
        assert!(until >= now as u64 + 7 * 86400);
        assert_eq!(get_of(&c, &link).await.unwrap().manifest, b"manifest-ciphertext");
        assert_eq!(fetch(&c, &link, &copy).await.unwrap(), b"payload");
        assert_eq!(list_of(&c, ALICE).await[0].state, LinkState::Active as i32);
        // Продление «без срока».
        assert_eq!(extend_of(&c, ALICE, &link, 0).await.unwrap(), 0);
        assert!(!get_of(&c, &link).await.unwrap().expired);
        // Истекла дольше срока льготы: не продлить, получателю — как не было, сборщик удаляет.
        set_expiry(&c, &link, now - grace_secs() - 10).await;
        assert_eq!(extend_of(&c, ALICE, &link, 7).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(get_of(&c, &link).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(fetch(&c, &link, &copy).await.unwrap_err(), ErrorCode::NotFound as i32);
        assert_eq!(purge(&c).await.unwrap(), 1);
        assert!(list_of(&c, ALICE).await.is_empty());
        assert_eq!((links_bytes(&c, ALICE).await, usage_of(&c, ALICE).await[1].1), (0, 7), "остался только источник");
        assert_eq!(count(&c.pool_v2, "link_blobs").await, 0);
    }

    #[tokio::test]
    async fn revoke_closes_link_and_returns_space() {
        let c = ctx().await;
        let (link, copy) = published(&c, ALICE, &[b"0123456789", b"abcdef"], 0).await;
        let (keep, keep_copy) = published(&c, ALICE, &[b"keep"], 7).await;
        assert_eq!((links_bytes(&c, ALICE).await, usage_of(&c, ALICE).await[1].1), (20, 40));
        revoke_of(&c, ALICE, &link).await.unwrap();
        // Сразу: ни списка, ни файла — как несуществующая; место вернулось.
        assert_eq!(get_of(&c, &link).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(fetch(&c, &link, &copy).await.unwrap_err(), ErrorCode::NotFound as i32);
        assert_eq!((links_bytes(&c, ALICE).await, usage_of(&c, ALICE).await[1].1), (4, 24));
        let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM chunks WHERE file_id = ?").bind(&copy).fetch_one(&c.pool).await.unwrap();
        assert_eq!(left, 0, "чанки копии удалены");
        assert_eq!(list_of(&c, ALICE).await.iter().map(|l| l.link_id.clone()).collect::<Vec<_>>(), vec![keep.clone()]);
        // Повторный отзыв и действия с отозванной — NOT_FOUND.
        assert_eq!(revoke_of(&c, ALICE, &link).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(extend_of(&c, ALICE, &link, 7).await.unwrap_err(), ErrorCode::NotFound);
        assert_eq!(publish_of(&c, ALICE, &link, b"manifest-ciphertext").await.unwrap_err(), ErrorCode::NotFound);
        // Удалённая копия перестала быть копией ссылки, но блоба уже нет.
        let (head, _) = run_stream(&c, "cloud.blob.download", dl(ALICE, &copy, 0, 0)).await;
        assert_eq!(head.unwrap_err(), ErrorCode::NotFound as i32);
        // Соседняя ссылка не задета; отзыв готовящейся убирает её копии.
        assert_eq!(fetch(&c, &keep, &keep_copy).await.unwrap(), b"keep");
        let draft = create_of(&c, ALICE, 7).await.unwrap();
        let source = drive_file(&c, ALICE, &[b"draft"]).await;
        add_of(&c, ALICE, &draft, &source, &[]).await.unwrap();
        assert_eq!(links_bytes(&c, ALICE).await, 9);
        revoke_of(&c, ALICE, &draft).await.unwrap();
        assert_eq!(links_bytes(&c, ALICE).await, 4);
    }

    #[tokio::test]
    async fn rate_limit_is_per_link() {
        let mut c = ctx().await;
        c.links = Runtime::with_limits(3, 8);
        let (link, copy) = published(&c, ALICE, &[b"x"], 7).await;
        let (other, _) = published(&c, ALICE, &[b"y"], 7).await;
        // Несуществующие и готовящиеся ссылки счётчик не занимают.
        let draft = create_of(&c, ALICE, 7).await.unwrap();
        for _ in 0..10 {
            assert_eq!(get_of(&c, &draft).await.unwrap_err(), Refusal::from(ErrorCode::NotFound));
            assert_eq!(get_of(&c, &new_id()).await.unwrap_err(), Refusal::from(ErrorCode::NotFound));
        }
        // get и download — в одном счёте: три обращения проходят, четвёртое нет.
        assert!(get_of(&c, &link).await.is_ok());
        assert!(fetch(&c, &link, &copy).await.is_ok());
        assert!(get_of(&c, &link).await.is_ok());
        let refused = get_of(&c, &link).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::RateLimited);
        assert!(refused.retry_after_ms > 0 && refused.retry_after_ms <= 60_000, "{}", refused.retry_after_ms);
        let refused = plan_download(&c, &dl_link(&link, &copy, 0, 0)).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::RateLimited);
        assert!(refused.retry_after_ms > 0);
        // Другая ссылка не задета; отказ не раскрывает файлы чужой ссылки.
        assert!(get_of(&c, &other).await.is_ok());
        // Окно прошло — счёт начинается заново.
        let key = id_key(&link).unwrap();
        let later = Instant::now() + RATE_WINDOW;
        assert!(c.links.hit(&key, later).is_ok());
        assert!(c.links.hit(&key, later).is_ok());
        assert!(c.links.hit(&key, later).is_ok());
        assert_eq!(c.links.hit(&key, later).unwrap_err().retry_after_ms, 60_000);
    }

    #[test]
    fn rate_tracker_is_bounded() {
        let rt = Runtime::with_limits(2, 8);
        let t0 = Instant::now();
        let key = |i: u32| -> [u8; 32] { Sha256::digest(i.to_be_bytes()).into() };
        for i in 0..RATE_TRACKED_MAX as u32 {
            assert!(rt.hit(&key(i), t0).is_ok());
        }
        // Счётчик полон живыми окнами: новая ссылка получает отказ, память не растёт.
        let full = rt.hit(&key(u32::MAX), t0).unwrap_err();
        assert_eq!((full.code, full.retry_after_ms), (ErrorCode::RateLimited, BUSY_RETRY_MS));
        assert_eq!(rt.rate.lock().unwrap().len(), RATE_TRACKED_MAX);
        // Уже отслеживаемая — обслуживается.
        assert!(rt.hit(&key(0), t0).is_ok());
        // Окна истекли — место освобождается.
        assert!(rt.hit(&key(u32::MAX), t0 + RATE_WINDOW).is_ok());
        assert_eq!(rt.rate.lock().unwrap().len(), 1);
    }

    #[test]
    fn stream_slots_are_limited() {
        let rt = Runtime::with_limits(120, 2);
        let a = rt.stream_slot().unwrap();
        let _b = rt.stream_slot().unwrap();
        let busy = rt.stream_slot().unwrap_err();
        assert_eq!((busy.code, busy.retry_after_ms), (ErrorCode::RateLimited, BUSY_RETRY_MS));
        drop(a);
        assert!(rt.stream_slot().is_ok());
    }

    #[tokio::test]
    async fn purge_removes_abandoned_and_orphans() {
        let c = ctx().await;
        let source = drive_file(&c, ALICE, &[b"source"]).await;
        // Брошенная готовящаяся ссылка с копией и свежая.
        let stale = create_of(&c, ALICE, 7).await.unwrap();
        add_of(&c, ALICE, &stale, &source, &[]).await.unwrap();
        let fresh = create_of(&c, ALICE, 7).await.unwrap();
        let fresh_copy = add_of(&c, ALICE, &fresh, &source, &[]).await.unwrap().file_id;
        sqlx::query("UPDATE links SET created_at = ? WHERE link_id = ?")
            .bind(now_unix() - PREPARING_TTL_SECS - 10)
            .bind(&stale)
            .execute(&c.pool_v2)
            .await
            .unwrap();
        // Действующая давно созданная ссылка без срока — не трогается.
        let (old, old_copy) = published(&c, ALICE, &[b"old"], 0).await;
        sqlx::query("UPDATE links SET created_at = 1 WHERE link_id = ?").bind(&old).execute(&c.pool_v2).await.unwrap();
        // Копии без ссылки: отзыв оборвался после удаления строки ссылки.
        let (torn, torn_copy) = published(&c, ALICE, &[b"torn"], 7).await;
        sqlx::query("DELETE FROM links WHERE link_id = ?").bind(&torn).execute(&c.pool_v2).await.unwrap();
        assert_eq!(fetch(&c, &torn, &torn_copy).await.unwrap_err(), ErrorCode::NotFound as i32);
        assert_eq!(purge(&c).await.unwrap(), 1);
        let left: Vec<String> = list_of(&c, ALICE).await.into_iter().map(|l| l.link_id).collect();
        assert_eq!(left.len(), 2);
        assert!(left.contains(&fresh) && left.contains(&old));
        assert_eq!(count(&c.pool_v2, "link_blobs").await, 2);
        // Три источника и по копии у свежей и у давней ссылки.
        assert_eq!(count(&c.pool, "files").await, 3 + 2);
        assert_eq!(links_bytes(&c, ALICE).await, 6 + 3);
        assert_eq!(fetch(&c, &old, &old_copy).await.unwrap(), b"old");
        assert!(is_link_blob(&c.pool_v2, &fresh_copy).await.unwrap());
        assert!(!is_link_blob(&c.pool_v2, &torn_copy).await.unwrap());
        assert_eq!(purge(&c).await.unwrap(), 0);
    }

    #[test]
    fn id_is_validated_and_logged_short() {
        let id = new_id();
        assert!(id_key(&id).is_some());
        assert_ne!(id_key(&id), id_key(&new_id()));
        for bad in ["", "short", &id[..21], &format!("{id}A"), &"=".repeat(22), &"я".repeat(11)] {
            assert!(id_key(bad).is_none(), "{bad}");
        }
        assert_eq!(short(&id).len(), 6);
        assert_eq!(short("яя"), "");
        assert_eq!((ttl_days(0), ttl_days(1), ttl_days(7), ttl_days(30)), (Ok(0), Ok(1), Ok(7), Ok(30)));
        assert_eq!(expiry(100, 0), 0);
        assert_eq!(expiry(100, 1), 100 + 86400);
        assert!(!is_expired(0, i64::MAX) && is_expired(100, 100) && !is_expired(101, 100));
    }
}
