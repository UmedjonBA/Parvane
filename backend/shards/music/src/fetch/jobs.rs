//! Задачи «Найти и скачать» (spec 039, этап B; spec 041) и методы `music.fetch.*`, `music.added.*`.
//!
//! Ход задачи: лимиты → очередь сервера (не больше `parallel` задач разом, остальные — QUEUED с местом) → эталон
//! (из запроса — сам, по каталогу, `matching::pick_reference`) → кандидаты из источников по порядку для этого трека →
//! сверка (`matching`) → уверенное совпадение качается само, иначе список на выбор → загрузка сервисом в папку
//! библиотеки (ход — `/progress` сервиса либо размер файла) → проверка файла → запись «кто добавил» → музыкальный
//! сервер пересканирует библиотеку, и трек получает id. Отмена останавливает задачу и стирает недокачанное.
//! Свои файлы (`upload.rs`) — тоже задачи этого списка (`upload_name`), очереди сервера не ждут.
//! Задачи живут в памяти шарда (перезапуск их обрывает; учёт добавленного — в базе).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use parvane_protocol::domain::health::civil_from_days;
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use sqlx::SqlitePool;
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

use super::matching::{self, Candidate, Query, Ranked, Rules, Verdict};
use super::service::{FetchService, Progress, ServiceError};
use super::store::{self, Added};
use crate::now_ms;
use crate::subsonic::{list, nd_user, track_of, Subsonic, SERVICE_USER};

type Reply = Result<Vec<u8>, ErrorCode>;

const CATALOG_MAX: u32 = 10;
/// Сколько эталонов каталога смотрим, выбирая эталон по строке запроса.
const REFERENCE_CATALOG: u32 = 5;
const CANDIDATES_PER_SOURCE: u32 = 5;
/// Дозаполнение тегов — пачками по столько записей.
const BACKFILL_BATCH: u32 = 20;
/// Сколько уверенных файлов одного источника пробовать, если скачать не вышло (у SoundCloud официальные загрузки
/// лейблов под DRM — следующий в списке обычно перезалив, который скачивается)
const DOWNLOAD_TRIES: usize = 3;
const CHOICE_MAX: usize = 10;
const JOB_KEEP_MS: i64 = 3_600_000;
const JOBS_PER_USER: usize = 50;
const DAY_MS: i64 = 86_400_000;
/// Сколько ждём, пока музыкальный сервер увидит новый файл.
const SCAN_ATTEMPTS: u32 = 20;
const SCAN_PAUSE: Duration = Duration::from_millis(1500);
/// Как часто спрашиваем ход загрузки.
const PROGRESS_EVERY: Duration = Duration::from_millis(1000);
/// Файл после загрузки короче этой доли эталона — отрывок, а не трек.
const MIN_LENGTH_SHARE: f32 = 0.6;
const DETAIL_MAX: usize = 200;
/// Временная папка приёма своих файлов (внутри папки библиотеки, скрытая).
pub(crate) const UPLOAD_TEMP: &str = ".parvane-upload";

pub struct Fetch {
    /// Сервис скачивания; `None` — «Найти и скачать» выключено (свои файлы загружать можно).
    pub service: Option<FetchService>,
    pub pool: SqlitePool,
    pub rules: Rules,
    /// Папка библиотеки, общая с музыкальным сервером и сервисом скачивания.
    pub library_dir: PathBuf,
    pub add_per_day: u32,
    pub quota_bytes: u64,
    /// Предел одного своего файла.
    pub upload_max_bytes: u64,
    /// Адреса администраторов: могут удалять чужие добавления.
    pub admins: Vec<String>,
    /// Сколько задач скачивания идёт разом.
    pub parallel: usize,
    slots: Arc<Semaphore>,
    /// Очередь сервера по порядку прихода: id задач, ждущих места.
    waiting: Mutex<Vec<String>>,
    jobs: Mutex<HashMap<String, Job>>,
    tasks: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

#[derive(Clone)]
pub(crate) struct Job {
    pub id: String,
    pub user: String,
    pub query: Query,
    /// Строка запроса, по которой сервер сам выбирает эталон («Найти и скачать «запрос»»).
    pub query_text: String,
    pub year: u32,
    pub state: pb::FetchState,
    ranked: Vec<Ranked>,
    pub track_id: String,
    pub failure: pb::FetchFailure,
    pub failure_detail: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Куда пишется файл (путь в библиотеке без расширения); пусто — загрузка не начиналась.
    pub dest: String,
    pub upload_name: String,
    /// Свой файл: ожидаемая SHA-256 (hex).
    pub sha256: String,
    pub updated_ms: i64,
    /// «Вставить ссылку»: трек YouTube, SoundCloud, Bandcamp.
    pub url: String,
    /// Вторая версия трека, который уже на сервере («[v2]»).
    pub as_version: bool,
    /// Готовый трек — в «Любимое» добавившего.
    pub star: bool,
    /// Трек уже был на сервере: задача готова без скачивания.
    pub existing: bool,
}

fn day_text(day: Option<i64>) -> String {
    day.map_or_else(String::new, |d| {
        let (y, m, dd) = civil_from_days(d);
        format!("{y:04}-{m:02}-{dd:02}")
    })
}

fn explicit_pb(e: Option<bool>) -> i32 {
    (match e {
        Some(true) => pb::Explicit::Yes,
        Some(false) => pb::Explicit::No,
        None => pb::Explicit::Unspecified,
    }) as i32
}

pub(crate) fn query_of(t: &pb::CatalogTrack) -> Query {
    let explicit = match pb::Explicit::try_from(t.explicit) {
        Ok(pb::Explicit::Yes) => Some(true),
        Ok(pb::Explicit::No) => Some(false),
        _ => None,
    };
    Query {
        artist: t.artist.trim().to_string(),
        title: t.title.trim().to_string(),
        album: t.album.trim().to_string(),
        duration_secs: t.duration_secs,
        explicit,
        reference: t.r#ref.trim().to_string(),
        cover_url: t.cover_url.trim().to_string(),
        album_ref: t.album_ref.trim().to_string(),
    }
}

pub(crate) fn catalog_pb(q: &Query, year: u32, library_track_id: String) -> pb::CatalogTrack {
    pb::CatalogTrack {
        artist: q.artist.clone(),
        title: q.title.clone(),
        album: q.album.clone(),
        duration_secs: q.duration_secs,
        explicit: explicit_pb(q.explicit),
        year,
        library_track_id,
        r#ref: q.reference.clone(),
        cover_url: q.cover_url.clone(),
        album_ref: q.album_ref.clone(),
    }
}

fn candidate_pb(r: &Ranked) -> pb::FetchCandidate {
    let c: &Candidate = &r.candidate;
    pb::FetchCandidate {
        id: c.id.clone(),
        source: c.source.clone(),
        title: c.title.clone(),
        uploader: c.uploader.chars().take(256).collect(),
        duration_secs: c.duration_secs,
        uploaded: day_text(c.upload_day),
        bitrate_kbps: c.bitrate_kbps,
        score: (r.score * 1000.0).round().clamp(0.0, 1000.0) as u32,
        trusted_original: r.trusted_original,
    }
}

fn clip_bytes(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}

impl Job {
    pub(crate) fn new(id: String, user: &str, state: pb::FetchState) -> Self {
        Job {
            id,
            user: user.to_string(),
            query: Query::default(),
            query_text: String::new(),
            year: 0,
            state,
            ranked: Vec::new(),
            track_id: String::new(),
            failure: pb::FetchFailure::Unspecified,
            failure_detail: String::new(),
            bytes_done: 0,
            bytes_total: 0,
            dest: String::new(),
            upload_name: String::new(),
            sha256: String::new(),
            updated_ms: now_ms(),
            url: String::new(),
            as_version: false,
            star: false,
            existing: false,
        }
    }

    fn to_pb(&self, queue_ahead: u32) -> pb::FetchJob {
        let candidates = if self.state == pb::FetchState::NeedsChoice { self.ranked.iter().take(CHOICE_MAX).map(candidate_pb).collect() } else { Vec::new() };
        let track = (!self.query.title.is_empty()).then(|| catalog_pb(&self.query, self.year, String::new()));
        pb::FetchJob {
            job_id: self.id.clone(),
            state: self.state as i32,
            track,
            candidates,
            track_id: self.track_id.clone(),
            failure: self.failure as i32,
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
            queue_ahead,
            failure_detail: clip_bytes(&self.failure_detail, DETAIL_MAX),
            query: clip_bytes(&self.query_text, 256),
            updated_ms: self.updated_ms,
            upload_name: clip_bytes(&self.upload_name, 255),
            existing: self.existing,
            url: clip_bytes(&self.url, 512),
            star: self.star,
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        matches!(self.state, pb::FetchState::Queued | pb::FetchState::Searching | pb::FetchState::Downloading | pb::FetchState::NeedsChoice)
    }
}

pub(crate) fn new_id() -> String {
    let mut id = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    id.iter().map(|b| format!("{b:02x}")).collect()
}

/// Имя файла из названия: без разделителей пути и служебных знаков, не длиннее 80 знаков.
pub(crate) fn file_stem(artist: &str, title: &str) -> String {
    let raw = if artist.is_empty() { title.to_string() } else { format!("{artist} - {title}") };
    let clean: String = raw.chars().map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | ',' | '.' | '\'') { c } else { '_' }).collect();
    let stem: String = clean.trim_matches(|c| c == '.' || c == ' ').chars().take(80).collect();
    if stem.is_empty() { "track".to_string() } else { stem }
}

/// Ник добавившего — для подписи «добавил …».
fn nick(address: &str) -> String {
    address.split('@').next().unwrap_or("").chars().take(64).collect()
}

fn detail_of(e: &ServiceError) -> String {
    match e {
        ServiceError::Failed(reason) => reason.clone(),
        _ => String::new(),
    }
}

impl Fetch {
    #[allow(clippy::too_many_arguments)]
    pub fn new(service: Option<FetchService>, pool: SqlitePool, rules: Rules, library_dir: PathBuf, add_per_day: u32, quota_bytes: u64, upload_max_bytes: u64, admins: Vec<String>, parallel: usize) -> Self {
        Fetch {
            service,
            pool,
            rules,
            library_dir,
            add_per_day,
            quota_bytes,
            upload_max_bytes,
            admins,
            parallel: parallel.max(1),
            slots: Arc::new(Semaphore::new(parallel.max(1))),
            waiting: Mutex::new(Vec::new()),
            jobs: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn service(&self) -> Result<&FetchService, ErrorCode> {
        self.service.as_ref().ok_or(ErrorCode::Unavailable)
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Job>> {
        self.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn waiting(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.waiting.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn tasks(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::task::AbortHandle>> {
        self.tasks.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn update(&self, id: &str, change: impl FnOnce(&mut Job)) {
        if let Some(job) = self.jobs().get_mut(id) {
            change(job);
            job.updated_ms = now_ms();
        }
    }

    pub(crate) fn job(&self, id: &str) -> Option<Job> {
        self.jobs().get(id).cloned()
    }

    fn fail(&self, id: &str, failure: pb::FetchFailure) {
        self.fail_with(id, failure, String::new());
    }

    pub(crate) fn fail_with(&self, id: &str, failure: pb::FetchFailure, detail: String) {
        self.update(id, |j| {
            j.state = pb::FetchState::Failed;
            j.failure = failure;
            j.failure_detail = detail;
        });
    }

    /// Расход пользователя: добавлено за сутки и занято всего.
    pub async fn usage(&self, user: &str) -> (u32, u64) {
        store::usage(&self.pool, user, now_ms() - DAY_MS).await.unwrap_or_else(|e| {
            error!("музыка: расход пользователя не прочитан: {e}");
            (u32::MAX, u64::MAX)
        })
    }

    /// Новая задача пользователя, если лимиты позволяют: суточный (идущие задачи тоже расходуют его — иначе его
    /// обходят пачкой запросов), место и число задач. `same` — такая же задача уже идёт (`DUPLICATE`).
    pub(crate) async fn admit(&self, address: &str, job: Job, same: impl Fn(&Job) -> bool) -> Result<(), ErrorCode> {
        let (today, used) = self.usage(address).await;
        if self.add_per_day == 0 || today >= self.add_per_day || used >= self.quota_bytes {
            return Err(ErrorCode::Limit);
        }
        self.sweep();
        let mut jobs = self.jobs();
        let now = now_ms();
        jobs.retain(|_, j| now - j.updated_ms < JOB_KEEP_MS || j.is_active());
        let mine: Vec<&Job> = jobs.values().filter(|j| j.user == address).collect();
        if mine.iter().any(|j| j.is_active() && same(j)) {
            return Err(ErrorCode::Duplicate);
        }
        if mine.len() >= JOBS_PER_USER || today as usize + mine.iter().filter(|j| j.is_active()).count() >= self.add_per_day as usize {
            return Err(ErrorCode::Limit);
        }
        jobs.insert(job.id.clone(), job);
        Ok(())
    }

    /// Законченная сразу задача (свой файл уже в библиотеке) — в список без лимитов.
    pub(crate) fn admit_finished(&self, job: Job) {
        self.jobs().insert(job.id.clone(), job);
    }

    /// Свой файл: задача ждёт байты и их ещё никто не шлёт — занять приём (ссылка на один раз).
    pub(crate) fn claim_upload(&self, id: &str) -> Option<Job> {
        let mut jobs = self.jobs();
        let job = jobs.get_mut(id).filter(|j| j.state == pb::FetchState::Downloading && !j.upload_name.is_empty() && j.dest.is_empty())?;
        job.dest = format!("{UPLOAD_TEMP}/{id}");
        job.updated_ms = now_ms();
        Some(job.clone())
    }

    /// Задачу ведёт отдельная задача tokio: её можно остановить отменой.
    pub(crate) fn spawn(self: &Arc<Self>, id: &str, work: impl std::future::Future<Output = ()> + Send + 'static) {
        let (this, job_id) = (self.clone(), id.to_string());
        let handle = tokio::spawn(async move {
            work.await;
            this.tasks().remove(&job_id);
        });
        if !handle.is_finished() {
            self.tasks().insert(id.to_string(), handle.abort_handle());
        }
    }

    /// Уже есть в библиотеке: тот же исполнитель и название, длительность в пределах допуска.
    pub(crate) async fn in_library(&self, sub: &Subsonic, user: &str, q: &Query) -> Option<pb::Track> {
        let v = sub.call(user, "search3", &[("query", format!("{} {}", q.artist, q.title)), ("songCount", "10".into()), ("albumCount", "0".into()), ("artistCount", "0".into())]).await.ok()?;
        let found: Vec<pb::Track> = list(&v, &["searchResult3", "song"]).iter().filter_map(track_of).collect();
        let as_candidates: Vec<Candidate> =
            found.iter().map(|t| Candidate { id: t.id.clone(), source: "library".into(), title: format!("{} - {}", t.artist, t.title), uploader: t.artist.clone(), duration_secs: t.duration_secs, ..Default::default() }).collect();
        let best = matching::rank(q, &as_candidates, &self.rules).into_iter().next()?;
        let exact = best.score >= self.rules.auto_threshold && (q.duration_secs == 0 || best.candidate.duration_secs.abs_diff(q.duration_secs) <= 10);
        exact.then(|| found.into_iter().find(|t| t.id == best.candidate.id)).flatten()
    }

    pub async fn catalog(&self, sub: &Subsonic, user: &str, r: pb::FetchCatalogRequest) -> Reply {
        let service = self.service()?;
        let query = r.query.trim();
        if query.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let limit = if r.limit == 0 { CATALOG_MAX } else { r.limit.min(CATALOG_MAX) };
        let found = service.catalog(query, limit).await.map_err(|_| ErrorCode::Unavailable)?;
        let mut tracks = Vec::with_capacity(found.len());
        for (q, year) in found.into_iter().take(limit as usize) {
            let library_track_id = self.in_library(sub, user, &q).await.map(|t| t.id).unwrap_or_default();
            tracks.push(catalog_pb(&q, year, library_track_id));
        }
        Ok(pb::FetchCatalogResponse { tracks }.encode_to_vec())
    }

    pub async fn start(self: &Arc<Self>, sub: Arc<Subsonic>, address: &str, r: pb::FetchStartRequest) -> Reply {
        self.service()?;
        // Продолжение: пользователь выбрал кандидата
        if !r.job_id.is_empty() {
            let chosen = {
                let jobs = self.jobs();
                let job = jobs.get(&r.job_id).filter(|j| j.user == address && j.state == pb::FetchState::NeedsChoice).ok_or(ErrorCode::NotFound)?;
                job.ranked.iter().find(|c| c.candidate.id == r.candidate_id).cloned().ok_or(ErrorCode::NotFound)?
            };
            self.update(&r.job_id, |j| j.state = pb::FetchState::Queued);
            let (this, id) = (self.clone(), r.job_id.clone());
            self.spawn(&r.job_id, async move {
                let Some(_slot) = this.take_slot(&id).await else { return };
                this.update(&id, |j| j.state = pb::FetchState::Downloading);
                if let Err(e) = this.download(&sub, &id, chosen.candidate).await {
                    this.fail_with(&id, pb::FetchFailure::Source, detail_of(&e));
                }
            });
            return self.job_reply(&r.job_id);
        }
        if !r.album_ref.trim().is_empty() {
            return self.start_album(sub, address, r.album_ref.trim()).await;
        }
        let query_text = r.query.trim().to_string();
        let url = r.url.trim().to_string();
        let mut job = Job::new(new_id(), address, pb::FetchState::Queued);
        job.as_version = r.as_version;
        job.star = r.star;
        if !url.is_empty() {
            if !url.starts_with("https://") || url.len() > 512 {
                return Err(ErrorCode::Invalid);
            }
            job.url = url.clone();
            self.admit(address, job.clone(), |j| j.url == url).await?;
            let (this, id) = (self.clone(), job.id.clone());
            self.spawn(&job.id, async move { this.run(&sub, &id).await });
            return self.job_reply(&job.id);
        }
        if let Some(track) = r.track.filter(|_| query_text.is_empty()) {
            job.query = query_of(&track);
            job.year = track.year;
            if job.query.artist.is_empty() || job.query.title.is_empty() {
                return Err(ErrorCode::Invalid);
            }
        } else if query_text.is_empty() {
            return Err(ErrorCode::Invalid);
        } else {
            job.query_text = query_text;
        }
        let (q, text) = (job.query.clone(), job.query_text.clone());
        self.admit(address, job.clone(), |j| if text.is_empty() { j.query.artist == q.artist && j.query.title == q.title } else { j.query_text == text }).await?;
        let (this, id) = (self.clone(), job.id.clone());
        self.spawn(&job.id, async move { this.run(&sub, &id).await });
        self.job_reply(&job.id)
    }

    /// «Скачать альбом»: по задаче на каждый трек альбома каталога, которого ещё нет в библиотеке. Трек уже качается —
    /// пропускается; лимит кончился посреди альбома — поставленные остаются, ответ — что успело (ничего — LIMIT).
    async fn start_album(self: &Arc<Self>, sub: Arc<Subsonic>, address: &str, album_ref: &str) -> Reply {
        let tracks = self.album_references(&sub, &nd_user(address), album_ref).await?;
        let mut started: Vec<pb::FetchJob> = Vec::new();
        for track in tracks.iter().filter(|t| t.library_track_id.is_empty()) {
            let mut job = Job::new(new_id(), address, pb::FetchState::Queued);
            job.query = query_of(track);
            job.year = track.year;
            if job.query.artist.is_empty() || job.query.title.is_empty() {
                continue;
            }
            let q = job.query.clone();
            match self.admit(address, job.clone(), |j| j.query.artist == q.artist && j.query.title == q.title).await {
                Ok(()) => {}
                Err(ErrorCode::Duplicate) => continue,
                Err(ErrorCode::Limit) => break,
                Err(e) => return Err(e),
            }
            let (this, id, sub) = (self.clone(), job.id.clone(), sub.clone());
            self.spawn(&job.id, async move { this.run(&sub, &id).await });
            if let Some(job) = self.job_pb(&job.id) {
                started.push(job);
            }
        }
        if started.is_empty() && tracks.iter().any(|t| t.library_track_id.is_empty()) {
            return Err(ErrorCode::Limit);
        }
        Ok(pb::FetchStartResponse { job: started.first().cloned(), jobs: started }.encode_to_vec())
    }

    /// Место в очереди сервера: ждём своей очереди; `None` — задачу сняли.
    async fn take_slot(&self, id: &str) -> Option<tokio::sync::OwnedSemaphorePermit> {
        if let Ok(permit) = self.slots.clone().try_acquire_owned() {
            return Some(permit);
        }
        self.update(id, |j| j.state = pb::FetchState::Queued);
        self.waiting().push(id.to_string());
        let permit = self.slots.clone().acquire_owned().await.ok();
        self.waiting().retain(|w| w != id);
        permit.filter(|_| self.jobs().contains_key(id))
    }

    async fn run(self: &Arc<Self>, sub: &Subsonic, id: &str) {
        let Some(_slot) = self.take_slot(id).await else { return };
        self.update(id, |j| j.state = pb::FetchState::Searching);
        let Some(job) = self.job(id) else { return };
        if !job.url.is_empty() {
            self.fetch_link(sub, &job).await;
            return;
        }
        if !job.query_text.is_empty() && !self.resolve_reference(sub, &job).await {
            return;
        }
        self.search(sub, id).await;
    }

    /// «Вставить ссылку»: что за ссылкой — у сервиса; трек нашёлся в каталоге — теги оттуда; уже на сервере (и не
    /// просили вторую версию) — задача готова с тем треком; иначе файл качается прямо по ссылке.
    async fn fetch_link(self: &Arc<Self>, sub: &Subsonic, job: &Job) {
        let Ok(service) = self.service() else { return };
        let info = match service.resolve(&job.url).await {
            Ok(v) => v,
            Err(e) => {
                self.fail_with(&job.id, pb::FetchFailure::Source, detail_of(&e));
                return;
            }
        };
        let text = |k: &str| info.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let mut query = Query { artist: text("artist"), title: text("title"), album: text("album"), duration_secs: info.get("duration").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32, ..Default::default() };
        let mut year = 0;
        // Эталон каталога — теги и обложка; не нашёлся — как назвал источник
        if let Ok(found) = service.catalog(&format!("{} {}", query.artist, query.title), REFERENCE_CATALOG).await {
            let queries: Vec<Query> = found.iter().map(|(q, _)| q.clone()).collect();
            if let Some(i) = matching::pick_reference(&format!("{} {}", query.artist, query.title), &queries) {
                (query, year) = found[i].clone();
            }
        }
        if query.title.is_empty() {
            self.fail(&job.id, pb::FetchFailure::NotFound);
            return;
        }
        if !job.as_version {
            if let Some(track) = self.in_library(sub, &nd_user(&job.user), &query).await {
                self.finish_existing(sub, &job.id, &job.user, query, year, &track.id).await;
                return;
            }
        }
        self.update(&job.id, |j| {
            j.query = query;
            j.year = year;
            j.state = pb::FetchState::Downloading;
        });
        let candidate = Candidate { id: job.url.clone(), source: text("source"), ..Default::default() };
        if let Err(e) = self.download(sub, &job.id, candidate).await {
            self.fail_with(&job.id, pb::FetchFailure::Source, detail_of(&e));
        }
    }

    /// Трек уже на сервере: задача готова с ним (`existing`); просили «Любимое» — отмечается.
    async fn finish_existing(&self, sub: &Subsonic, id: &str, user: &str, query: Query, year: u32, track_id: &str) {
        let star = self.job(id).is_some_and(|j| j.star);
        if star {
            let _ = sub.call(&nd_user(user), "star", &[("id", track_id.to_string())]).await;
        }
        self.update(id, |j| {
            j.query = query;
            j.year = year;
            j.track_id = track_id.to_string();
            j.existing = true;
            j.state = pb::FetchState::Done;
        });
    }

    /// Эталон по строке запроса: лучшее совпадение каталога. Трек уже в библиотеке — задача сразу готова.
    async fn resolve_reference(&self, sub: &Subsonic, job: &Job) -> bool {
        let Ok(service) = self.service() else { return false };
        let found = match service.catalog(&job.query_text, REFERENCE_CATALOG).await {
            Ok(f) => f,
            Err(e) => {
                self.fail_with(&job.id, pb::FetchFailure::Source, detail_of(&e));
                return false;
            }
        };
        let queries: Vec<Query> = found.iter().map(|(q, _)| q.clone()).collect();
        let Some(i) = matching::pick_reference(&job.query_text, &queries) else {
            self.fail(&job.id, pb::FetchFailure::NotFound);
            return false;
        };
        let (q, year) = found[i].clone();
        if !job.as_version {
            if let Some(track) = self.in_library(sub, &nd_user(&job.user), &q).await {
                self.finish_existing(sub, &job.id, &job.user, q, year, &track.id).await;
                return false;
            }
        }
        self.update(&job.id, |j| {
            j.query = q;
            j.year = year;
        });
        true
    }

    fn job_reply(&self, id: &str) -> Reply {
        let job = self.job_pb(id).ok_or(ErrorCode::NotFound)?;
        Ok(pb::FetchStartResponse { job: Some(job), ..Default::default() }.encode_to_vec())
    }

    pub(crate) fn job_pb(&self, id: &str) -> Option<pb::FetchJob> {
        let ahead = self.waiting().iter().position(|w| w == id).unwrap_or(0) as u32;
        self.jobs().get(id).map(|j| j.to_pb(ahead))
    }

    /// Свой файл, байты которого так и не пришли за срок ссылки, — не удался (иначе держал бы суточный лимит).
    fn sweep(&self) {
        let now = now_ms();
        for j in self.jobs().values_mut() {
            if !j.upload_name.is_empty() && j.dest.is_empty() && j.state == pb::FetchState::Downloading && now - j.updated_ms > JOB_KEEP_MS {
                j.state = pb::FetchState::Failed;
                j.failure = pb::FetchFailure::Source;
                j.updated_ms = now;
            }
        }
    }

    pub fn status(&self, address: &str) -> Reply {
        self.sweep();
        let now = now_ms();
        let waiting = self.waiting().clone();
        let mut jobs: Vec<Job> = self.jobs().values().filter(|j| j.user == address && (now - j.updated_ms < JOB_KEEP_MS || j.is_active())).cloned().collect();
        jobs.sort_by_key(|j| std::cmp::Reverse(j.updated_ms));
        let ahead = |id: &str| waiting.iter().position(|w| w == id).unwrap_or(0) as u32;
        Ok(pb::FetchStatusResponse { jobs: jobs.iter().take(JOBS_PER_USER).map(|j| j.to_pb(ahead(&j.id))).collect() }.encode_to_vec())
    }

    /// Отмена: идущая задача останавливается, недокачанное стирается; законченная — убирается из списка.
    pub async fn cancel(&self, address: &str, r: pb::FetchCancelRequest) -> Reply {
        let job = self.job(&r.job_id).filter(|j| j.user == address).ok_or(ErrorCode::NotFound)?;
        if job.is_active() {
            if let Some(task) = self.tasks().remove(&job.id) {
                task.abort();
            }
            self.waiting().retain(|w| w != &job.id);
            if !job.dest.is_empty() {
                if let Some(service) = &self.service {
                    if job.upload_name.is_empty() {
                        service.cancel(&job.dest).await;
                    }
                }
                self.remove_partial(&job.dest).await;
            }
            info!("музыка: задача снята пользователем");
        }
        self.jobs().remove(&job.id);
        Ok(pb::FetchCancelResponse {}.encode_to_vec())
    }

    /// Файлы недокачанной загрузки: всё в папке `dest`, чьё имя начинается с имени `dest`.
    async fn remove_partial(&self, dest: &str) {
        let Some(path) = self.library_path(dest) else { return };
        let (Some(dir), Some(stem)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return };
        let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
        while let Ok(Some(e)) = entries.next_entry().await {
            if e.file_name().to_str().is_some_and(|n| n.starts_with(stem)) {
                let _ = tokio::fs::remove_file(e.path()).await;
            }
        }
    }

    /// Сколько байт файлов `dest` уже на диске (ход, если сервис его не сообщает).
    async fn bytes_on_disk(&self, dest: &str) -> u64 {
        let Some(path) = self.library_path(dest) else { return 0 };
        let (Some(dir), Some(stem)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return 0 };
        let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return 0 };
        let mut total = 0u64;
        while let Ok(Some(e)) = entries.next_entry().await {
            if e.file_name().to_str().is_some_and(|n| n.starts_with(stem)) {
                total = total.saturating_add(e.metadata().await.map(|m| m.len()).unwrap_or(0));
            }
        }
        total
    }

    /// Кандидаты из источников по порядку: первый источник с уверенным совпадением заканчивает поиск. Уверенный файл не
    /// скачался (DRM, удалён, источник оборвал) — следующий уверенный того же источника, затем следующий источник;
    /// не скачалось ничего — выбор человеку из оставшихся либо отказ с причиной последней неудачи.
    async fn search(self: &Arc<Self>, sub: &Subsonic, id: &str) {
        let Ok(service) = self.service() else { return };
        let Some(query) = self.job(id).map(|j| j.query) else { return };
        let mut all: Vec<Candidate> = Vec::new();
        let mut tried: Vec<String> = Vec::new();
        let mut last_error: Option<ServiceError> = None;
        for source in matching::source_order(&query, &self.rules) {
            match service.candidates(source, &query, CANDIDATES_PER_SOURCE).await {
                Ok(found) => all.extend(found),
                Err(ServiceError::SourceRefused) => {
                    warn!("музыка: источник {source} отказал — пробуем следующий");
                    continue;
                }
                // Сбой одного источника не закрывает задачу: следующий может найти; причина — если не найдёт никто
                Err(e) => {
                    warn!("музыка: поиск в {source} не удался: {e:?} — пробуем следующий");
                    last_error = Some(e);
                    continue;
                }
            }
            all.retain(|c| !tried.contains(&c.id));
            let ranked = matching::rank(&query, &all, &self.rules);
            if matching::verdict(&query, &ranked, &self.rules) != Verdict::Auto {
                continue;
            }
            let sure: Vec<Candidate> = ranked
                .iter()
                .filter(|r| r.score >= self.rules.auto_threshold && (!matching::needs_uncensored(&query) || r.trusted_original))
                .take(DOWNLOAD_TRIES)
                .map(|r| r.candidate.clone())
                .collect();
            self.update(id, |j| {
                j.ranked = ranked;
                j.state = pb::FetchState::Downloading;
            });
            for candidate in sure {
                tried.push(candidate.id.clone());
                match self.download(sub, id, candidate).await {
                    Ok(()) => return,
                    Err(e) => last_error = Some(e),
                }
            }
            all.retain(|c| !tried.contains(&c.id));
        }
        let ranked = matching::rank(&query, &all, &self.rules);
        if ranked.is_empty() {
            match last_error {
                Some(e) => self.fail_with(id, pb::FetchFailure::Source, detail_of(&e)),
                None => self.fail(id, pb::FetchFailure::NotFound),
            }
        } else {
            self.update(id, |j| {
                j.ranked = ranked;
                j.state = pb::FetchState::NeedsChoice;
            });
        }
    }

    async fn progress_of(&self, service: &FetchService, dest: &str) -> Progress {
        match service.progress(dest).await {
            Some(p) => p,
            None => Progress { bytes_done: self.bytes_on_disk(dest).await, bytes_total: 0 },
        }
    }

    /// Скачать файл в библиотеку. `Err` — источник файл не отдал (недокачанное убрано, задача не закрыта: вызывающий
    /// пробует другой файл либо закрывает её сам); остальные исходы задача получает здесь же.
    async fn download(self: &Arc<Self>, sub: &Subsonic, id: &str, candidate: Candidate) -> Result<(), ServiceError> {
        let Ok(service) = self.service() else { return Ok(()) };
        let Some((user, query)) = self.job(id).map(|j| (j.user, j.query)) else { return Ok(()) };
        let dest = format!("{}/{} [{}]", nd_user(&user), file_stem(&query.artist, &query.title), id);
        self.update(id, |j| j.dest = dest.clone());
        let fetched = {
            let job = service.download(&candidate.source, &candidate.id, &dest, &query);
            tokio::pin!(job);
            let mut tick = tokio::time::interval(PROGRESS_EVERY);
            tick.tick().await;
            loop {
                tokio::select! {
                    r = &mut job => break r,
                    _ = tick.tick() => {
                        let p = self.progress_of(service, &dest).await;
                        self.update(id, |j| {
                            j.bytes_done = p.bytes_done;
                            j.bytes_total = p.bytes_total.max(j.bytes_total);
                        });
                    }
                }
            }
        };
        let file = match fetched {
            Ok(f) => f,
            Err(e) => {
                warn!("музыка: загрузка из {} не удалась: {e:?}", candidate.source);
                self.remove_partial(&dest).await;
                return Err(e);
            }
        };
        self.update(id, |j| {
            j.bytes_done = file.bytes;
            j.bytes_total = file.bytes;
        });
        // Проверка после загрузки: отрывок вместо трека и выход за отведённое место — файл убирается
        let too_short = query.duration_secs >= 90 && file.duration_secs > 0 && (file.duration_secs as f32) < query.duration_secs as f32 * MIN_LENGTH_SHARE;
        let (_, used) = self.usage(&user).await;
        let over_quota = used.saturating_add(file.bytes) > self.quota_bytes;
        if too_short || over_quota {
            self.remove_file(&file.path).await;
            self.fail(id, if over_quota { pb::FetchFailure::Limit } else { pb::FetchFailure::Source });
            return Ok(());
        }
        let row = Added {
            path: file.path.clone(),
            adder: user.clone(),
            bytes: file.bytes as i64,
            added_ms: now_ms(),
            track_id: String::new(),
            artist: query.artist.clone(),
            title: query.title.clone(),
            duration_secs: i64::from(file.duration_secs),
            sha256: String::new(),
        };
        if let Err(e) = store::insert(&self.pool, &row).await {
            error!("музыка: добавленный трек не записан: {e}");
            self.remove_file(&file.path).await;
            self.fail(id, pb::FetchFailure::Library);
            return Ok(());
        }
        // Теги и обложку сервис уже переписал при скачивании
        let _ = store::mark_tagged(&self.pool, &file.path, &file.path, 1).await;
        // Откуда файл и какая версия: вторая версия — следующий номер, иначе та же, что у уже лежащего (копия)
        let as_version = self.job(id).is_some_and(|j| j.as_version);
        let next = store::next_version(&self.pool, &query.artist, &query.title).await.unwrap_or(1);
        let version = if as_version { next } else { (next - 1).max(1) };
        if let Err(e) = store::set_origin(&self.pool, &file.path, &candidate.source, &candidate.id, version).await {
            warn!("музыка: источник файла не записан: {e}");
        }
        info!("музыка: трек скачан ({} байт, источник {})", file.bytes, candidate.source);
        self.finish_in_library(sub, id, &user, &file.path, &query).await;
        Ok(())
    }

    /// Файл записан и учтён: ждём, пока музыкальный сервер его увидит, и отмечаем задачу готовой.
    pub(crate) async fn finish_in_library(&self, sub: &Subsonic, id: &str, user: &str, path: &str, query: &Query) {
        match self.await_in_library(sub, user, query, path).await {
            Some(track_id) => {
                let _ = store::set_track_id(&self.pool, path, &track_id).await;
                if self.job(id).is_some_and(|j| j.star) {
                    let _ = sub.call(&nd_user(user), "star", &[("id", track_id.clone())]).await;
                }
                self.update(id, |j| {
                    j.track_id = track_id;
                    j.state = pb::FetchState::Done;
                });
            }
            // Файл на месте и учтён: музыкальный сервер увидит его при следующем сканировании
            None => self.fail(id, pb::FetchFailure::Library),
        }
    }

    /// Попросить музыкальный сервер пересканировать библиотеку и дождаться трека этого файла.
    async fn await_in_library(&self, sub: &Subsonic, user: &str, q: &Query, path: &str) -> Option<String> {
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        for _ in 0..SCAN_ATTEMPTS {
            tokio::time::sleep(SCAN_PAUSE).await;
            if let Some(track_id) = self.track_of_file(sub, &nd_user(user), q, path).await {
                return Some(track_id);
            }
        }
        None
    }

    /// Трек музыкального сервера для файла `path` (относительно папки библиотеки). Сервер, сообщающий настоящий путь
    /// (`ND_SUBSONIC_DEFAULTREPORTREALPATH`), находит именно этот файл — у двух одинаковых треков разные пути, и номер
    /// одного не достаётся другому; не сообщающий — прежнее совпадение по исполнителю, названию и длительности.
    pub(crate) async fn track_of_file(&self, sub: &Subsonic, user: &str, q: &Query, path: &str) -> Option<String> {
        let v = sub.call(user, "search3", &[("query", format!("{} {}", q.artist, q.title)), ("songCount", "20".into()), ("albumCount", "0".into()), ("artistCount", "0".into())]).await.ok()?;
        let songs = list(&v, &["searchResult3", "song"]);
        let real_path = |s: &serde_json::Value| s.get("path").and_then(serde_json::Value::as_str).filter(|p| p.starts_with('/')).map(str::to_string);
        if songs.iter().any(|s| real_path(s).is_some()) {
            let wanted = format!("/{}", path.trim_start_matches('/'));
            return songs
                .iter()
                .find(|s| real_path(s).is_some_and(|p| p.ends_with(&wanted)))
                .and_then(|s| s.get("id").and_then(serde_json::Value::as_str))
                .map(str::to_string);
        }
        self.in_library(sub, user, q).await.map(|t| t.id)
    }

    pub(crate) fn library_path(&self, relative: &str) -> Option<PathBuf> {
        let rel = Path::new(relative);
        // Только внутри папки библиотеки: без `..` и абсолютных путей
        let inside = rel.components().all(|c| matches!(c, std::path::Component::Normal(_)));
        inside.then(|| self.library_dir.join(rel))
    }

    async fn remove_file(&self, relative: &str) {
        if let Some(path) = self.library_path(relative) {
            if let Err(e) = tokio::fs::remove_file(&path).await {
                warn!("музыка: файл не удалён: {e}");
            }
            // Текст песни рядом с файлом (`<имя>.lrc`) — вместе с ним
            let _ = tokio::fs::remove_file(path.with_extension("lrc")).await;
        }
    }

    /// Дозаполнение: скачанное до того, как сервис стал переписывать теги по каталогу, — теги и обложка из каталога
    /// по исполнителю и названию. Пачками; изменилось хоть что-то — музыкальный сервер пересканирует библиотеку.
    pub async fn backfill_tags(&self, sub: &Subsonic) {
        let Ok(service) = self.service() else { return };
        let mut changed = 0;
        loop {
            let rows = match store::untagged(&self.pool, BACKFILL_BATCH).await {
                Ok(rows) if !rows.is_empty() => rows,
                Ok(_) => break,
                Err(e) => {
                    error!("музыка: дозаполнение тегов: {e}");
                    return;
                }
            };
            for row in rows {
                let outcome = match service.retag(&row.path, &row.artist, &row.title).await {
                    Ok((new_path, true)) if !new_path.is_empty() => (new_path, 1),
                    Ok(_) => (row.path.clone(), 2),
                    Err(e) => {
                        // Сервис недоступен — в другой раз
                        warn!("музыка: дозаполнение тегов отложено: {e:?}");
                        return;
                    }
                };
                if outcome.1 == 1 {
                    changed += 1;
                }
                if let Err(e) = store::mark_tagged(&self.pool, &row.path, &outcome.0, outcome.1).await {
                    error!("музыка: дозаполнение тегов не записано: {e}");
                    return;
                }
            }
        }
        if changed > 0 {
            let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
            info!("музыка: теги и обложки дозаполнены у {changed} треков");
        }
    }

    pub async fn added_list(&self, sub: &Subsonic, address: &str, r: pb::AddedListRequest) -> Reply {
        let limit = if r.limit == 0 { 20 } else { r.limit.min(50) };
        let rows = store::list(&self.pool, r.mine.then_some(address), r.offset, limit).await.map_err(|e| {
            error!("музыка: добавленное не прочитано: {e}");
            ErrorCode::Unavailable
        })?;
        let user = nd_user(address);
        let mut tracks = Vec::with_capacity(rows.len());
        for mut row in rows {
            // Номер трека не узнан при скачивании (сервер не успел пересканировать) — узнать сейчас и запомнить:
            // без номера трек нельзя ни сыграть из списка, ни удалить
            if row.track_id.is_empty() {
                let q = Query { artist: row.artist.clone(), title: row.title.clone(), duration_secs: row.duration_secs.max(0) as u32, ..Default::default() };
                if let Some(track_id) = self.track_of_file(sub, &nd_user(&row.adder), &q, &row.path).await {
                    let _ = store::set_track_id(&self.pool, &row.path, &track_id).await;
                    row.track_id = track_id;
                }
            }
            // Трек, которого музыкальный сервер ещё не увидел, показывается по записи: название и исполнитель
            let known = if row.track_id.is_empty() { None } else { sub.call(&user, "getSong", &[("id", row.track_id.clone())]).await.ok().and_then(|v| v.get("song").and_then(track_of)) };
            let track = known.unwrap_or_else(|| pb::Track { title: row.title.clone(), artist: row.artist.clone(), duration_secs: row.duration_secs.max(0) as u32, ..Default::default() });
            tracks.push(pb::AddedTrack { track: Some(track), added_ms: row.added_ms, bytes: row.bytes.max(0) as u64, adder: nick(&row.adder) });
        }
        let mut plain: Vec<pb::Track> = tracks.iter_mut().filter_map(|t| t.track.take()).collect();
        crate::files::annotate(&self.pool, &mut plain).await;
        for (t, track) in tracks.iter_mut().zip(plain) {
            t.track = Some(track);
        }
        Ok(pb::AddedListResponse { tracks }.encode_to_vec())
    }

    pub async fn added_delete(&self, sub: &Subsonic, address: &str, r: pb::AddedDeleteRequest) -> Reply {
        let row = store::by_track(&self.pool, &r.track_id).await.map_err(|_| ErrorCode::Unavailable)?.ok_or(ErrorCode::NotFound)?;
        if row.adder != address && !self.admins.iter().any(|a| a == address) {
            return Err(ErrorCode::Forbidden);
        }
        // В корзину на 30 дней (макет 23 ноя): вернуть может добавивший, удаливший и администратор
        self.trash(sub, address, &row).await?;
        info!("музыка: добавленный трек — в корзине");
        Ok(pb::AddedDeleteResponse {}.encode_to_vec())
    }
}
