//! Задачи «Найти и скачать» (spec 039, этап B) и методы `music.fetch.*`, `music.added.*`.
//!
//! Ход задачи: лимиты → кандидаты из источников по порядку для этого трека → сверка (`matching`) → уверенное
//! совпадение качается само, иначе список на выбор → загрузка сервисом в папку библиотеки → проверка файла →
//! запись «кто добавил» → музыкальный сервер пересканирует библиотеку, и трек получает id.
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
use tracing::{error, info, warn};

use super::matching::{self, Candidate, Query, Ranked, Rules, Verdict};
use super::service::{FetchService, ServiceError};
use super::store::{self, Added};
use crate::now_ms;
use crate::subsonic::{list, nd_user, track_of, Subsonic, SERVICE_USER};

type Reply = Result<Vec<u8>, ErrorCode>;

const CATALOG_MAX: u32 = 10;
const CANDIDATES_PER_SOURCE: u32 = 5;
const CHOICE_MAX: usize = 10;
const JOB_KEEP_MS: i64 = 3_600_000;
const JOBS_PER_USER: usize = 50;
const DAY_MS: i64 = 86_400_000;
/// Сколько ждём, пока музыкальный сервер увидит новый файл.
const SCAN_ATTEMPTS: u32 = 20;
const SCAN_PAUSE: Duration = Duration::from_millis(1500);
/// Файл после загрузки короче этой доли эталона — отрывок, а не трек.
const MIN_LENGTH_SHARE: f32 = 0.6;

pub struct Fetch {
    pub service: FetchService,
    pub pool: SqlitePool,
    pub rules: Rules,
    /// Папка библиотеки, общая с музыкальным сервером и сервисом скачивания.
    pub library_dir: PathBuf,
    pub add_per_day: u32,
    pub quota_bytes: u64,
    /// Адреса администраторов: могут удалять чужие добавления.
    pub admins: Vec<String>,
    jobs: Mutex<HashMap<String, Job>>,
}

#[derive(Clone)]
struct Job {
    id: String,
    user: String,
    query: Query,
    year: u32,
    state: pb::FetchState,
    ranked: Vec<Ranked>,
    track_id: String,
    failure: pb::FetchFailure,
    updated_ms: i64,
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

fn query_of(t: &pb::CatalogTrack) -> Query {
    let explicit = match pb::Explicit::try_from(t.explicit) {
        Ok(pb::Explicit::Yes) => Some(true),
        Ok(pb::Explicit::No) => Some(false),
        _ => None,
    };
    Query { artist: t.artist.trim().to_string(), title: t.title.trim().to_string(), album: t.album.trim().to_string(), duration_secs: t.duration_secs, explicit }
}

fn catalog_pb(q: &Query, year: u32, library_track_id: String) -> pb::CatalogTrack {
    pb::CatalogTrack { artist: q.artist.clone(), title: q.title.clone(), album: q.album.clone(), duration_secs: q.duration_secs, explicit: explicit_pb(q.explicit), year, library_track_id }
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

impl Job {
    fn to_pb(&self) -> pb::FetchJob {
        let candidates = if self.state == pb::FetchState::NeedsChoice { self.ranked.iter().take(CHOICE_MAX).map(candidate_pb).collect() } else { Vec::new() };
        pb::FetchJob { job_id: self.id.clone(), state: self.state as i32, track: Some(catalog_pb(&self.query, self.year, String::new())), candidates, track_id: self.track_id.clone(), failure: self.failure as i32 }
    }
}

fn new_id() -> String {
    let mut id = [0u8; 8];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    id.iter().map(|b| format!("{b:02x}")).collect()
}

/// Имя файла из названия: без разделителей пути и служебных знаков, не длиннее 80 знаков.
fn file_stem(q: &Query) -> String {
    let raw = format!("{} - {}", q.artist, q.title);
    let clean: String = raw.chars().map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | ',' | '.' | '\'') { c } else { '_' }).collect();
    clean.trim_matches(|c| c == '.' || c == ' ').chars().take(80).collect()
}

/// Ник добавившего — для подписи «добавил …».
fn nick(address: &str) -> String {
    address.split('@').next().unwrap_or("").chars().take(64).collect()
}

impl Fetch {
    pub fn new(service: FetchService, pool: SqlitePool, rules: Rules, library_dir: PathBuf, add_per_day: u32, quota_bytes: u64, admins: Vec<String>) -> Self {
        Fetch { service, pool, rules, library_dir, add_per_day, quota_bytes, admins, jobs: Mutex::new(HashMap::new()) }
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Job>> {
        self.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Job)) {
        if let Some(job) = self.jobs().get_mut(id) {
            change(job);
            job.updated_ms = now_ms();
        }
    }

    fn fail(&self, id: &str, failure: pb::FetchFailure) {
        self.update(id, |j| {
            j.state = pb::FetchState::Failed;
            j.failure = failure;
        });
    }

    /// Расход пользователя: добавлено за сутки и занято всего.
    pub async fn usage(&self, user: &str) -> (u32, u64) {
        store::usage(&self.pool, user, now_ms() - DAY_MS).await.unwrap_or_else(|e| {
            error!("музыка: расход пользователя не прочитан: {e}");
            (u32::MAX, u64::MAX)
        })
    }

    /// Уже есть в библиотеке: тот же исполнитель и название, длительность в пределах допуска.
    async fn in_library(&self, sub: &Subsonic, user: &str, q: &Query) -> Option<pb::Track> {
        let v = sub.call(user, "search3", &[("query", format!("{} {}", q.artist, q.title)), ("songCount", "10".into()), ("albumCount", "0".into()), ("artistCount", "0".into())]).await.ok()?;
        let found: Vec<pb::Track> = list(&v, &["searchResult3", "song"]).iter().filter_map(track_of).collect();
        let as_candidates: Vec<Candidate> =
            found.iter().map(|t| Candidate { id: t.id.clone(), source: "library".into(), title: format!("{} - {}", t.artist, t.title), uploader: t.artist.clone(), duration_secs: t.duration_secs, ..Default::default() }).collect();
        let best = matching::rank(q, &as_candidates, &self.rules).into_iter().next()?;
        let exact = best.score >= self.rules.auto_threshold && (q.duration_secs == 0 || best.candidate.duration_secs.abs_diff(q.duration_secs) <= 10);
        exact.then(|| found.into_iter().find(|t| t.id == best.candidate.id)).flatten()
    }

    pub async fn catalog(&self, sub: &Subsonic, user: &str, r: pb::FetchCatalogRequest) -> Reply {
        let query = r.query.trim();
        if query.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let limit = if r.limit == 0 { CATALOG_MAX } else { r.limit.min(CATALOG_MAX) };
        let found = self.service.catalog(query, limit).await.map_err(|_| ErrorCode::Unavailable)?;
        let mut tracks = Vec::with_capacity(found.len());
        for (q, year) in found.into_iter().take(limit as usize) {
            let library_track_id = self.in_library(sub, user, &q).await.map(|t| t.id).unwrap_or_default();
            tracks.push(catalog_pb(&q, year, library_track_id));
        }
        Ok(pb::FetchCatalogResponse { tracks }.encode_to_vec())
    }

    pub async fn start(self: &Arc<Self>, sub: Arc<Subsonic>, address: &str, r: pb::FetchStartRequest) -> Reply {
        // Продолжение: пользователь выбрал кандидата
        if !r.job_id.is_empty() {
            let chosen = {
                let jobs = self.jobs();
                let job = jobs.get(&r.job_id).filter(|j| j.user == address && j.state == pb::FetchState::NeedsChoice).ok_or(ErrorCode::NotFound)?;
                job.ranked.iter().find(|c| c.candidate.id == r.candidate_id).cloned().ok_or(ErrorCode::NotFound)?
            };
            self.update(&r.job_id, |j| j.state = pb::FetchState::Downloading);
            let (this, id) = (self.clone(), r.job_id.clone());
            tokio::spawn(async move { this.download(&sub, &id, chosen.candidate).await });
            return self.job_reply(&r.job_id);
        }
        let track = r.track.ok_or(ErrorCode::Invalid)?;
        let query = query_of(&track);
        if query.artist.is_empty() || query.title.is_empty() {
            return Err(ErrorCode::Invalid);
        }
        let (today, used) = self.usage(address).await;
        if self.add_per_day == 0 || today >= self.add_per_day || used >= self.quota_bytes {
            return Err(ErrorCode::Limit);
        }
        let id = new_id();
        {
            let mut jobs = self.jobs();
            let now = now_ms();
            jobs.retain(|_, j| now - j.updated_ms < JOB_KEEP_MS || matches!(j.state, pb::FetchState::Searching | pb::FetchState::Downloading));
            let mine = jobs.values().filter(|j| j.user == address);
            let active = |j: &&Job| matches!(j.state, pb::FetchState::Searching | pb::FetchState::Downloading | pb::FetchState::NeedsChoice);
            if mine.clone().filter(active).any(|j| j.query.artist == query.artist && j.query.title == query.title) {
                return Err(ErrorCode::Duplicate);
            }
            // Идущие задачи тоже расходуют суточный лимит: иначе его обходят пачкой запросов
            if mine.clone().count() >= JOBS_PER_USER || today as usize + mine.filter(active).count() >= self.add_per_day as usize {
                return Err(ErrorCode::Limit);
            }
            jobs.insert(id.clone(), Job { id: id.clone(), user: address.to_string(), query, year: track.year, state: pb::FetchState::Searching, ranked: Vec::new(), track_id: String::new(), failure: pb::FetchFailure::Unspecified, updated_ms: now });
        }
        let (this, job_id) = (self.clone(), id.clone());
        tokio::spawn(async move { this.search(&sub, &job_id).await });
        self.job_reply(&id)
    }

    fn job_reply(&self, id: &str) -> Reply {
        let job = self.jobs().get(id).map(Job::to_pb).ok_or(ErrorCode::NotFound)?;
        Ok(pb::FetchStartResponse { job: Some(job) }.encode_to_vec())
    }

    pub fn status(&self, address: &str) -> Reply {
        let now = now_ms();
        let mut jobs: Vec<Job> = self.jobs().values().filter(|j| j.user == address && now - j.updated_ms < JOB_KEEP_MS).cloned().collect();
        jobs.sort_by_key(|j| std::cmp::Reverse(j.updated_ms));
        Ok(pb::FetchStatusResponse { jobs: jobs.iter().take(JOBS_PER_USER).map(Job::to_pb).collect() }.encode_to_vec())
    }

    /// Кандидаты из источников по порядку: первый источник с уверенным совпадением заканчивает поиск.
    async fn search(self: &Arc<Self>, sub: &Subsonic, id: &str) {
        let Some(query) = self.jobs().get(id).map(|j| j.query.clone()) else { return };
        let mut all: Vec<Candidate> = Vec::new();
        for source in matching::source_order(&query, &self.rules) {
            match self.service.candidates(source, &query, CANDIDATES_PER_SOURCE).await {
                Ok(found) => all.extend(found),
                Err(ServiceError::SourceRefused) => {
                    warn!("музыка: источник {source} отказал — пробуем следующий");
                    continue;
                }
                Err(ServiceError::Unavailable) => {
                    self.fail(id, pb::FetchFailure::Source);
                    return;
                }
            }
            let ranked = matching::rank(&query, &all, &self.rules);
            if matching::verdict(&query, &ranked, &self.rules) == Verdict::Auto {
                let best = ranked[0].candidate.clone();
                self.update(id, |j| {
                    j.ranked = ranked;
                    j.state = pb::FetchState::Downloading;
                });
                self.download(sub, id, best).await;
                return;
            }
        }
        let ranked = matching::rank(&query, &all, &self.rules);
        if ranked.is_empty() {
            self.fail(id, pb::FetchFailure::NotFound);
        } else {
            self.update(id, |j| {
                j.ranked = ranked;
                j.state = pb::FetchState::NeedsChoice;
            });
        }
    }

    async fn download(self: &Arc<Self>, sub: &Subsonic, id: &str, candidate: Candidate) {
        let Some((user, query)) = self.jobs().get(id).map(|j| (j.user.clone(), j.query.clone())) else { return };
        let dest = format!("{}/{} [{}]", nd_user(&user), file_stem(&query), id);
        let file = match self.service.download(&candidate.source, &candidate.id, &dest).await {
            Ok(f) => f,
            Err(e) => {
                warn!("музыка: загрузка из {} не удалась: {e:?}", candidate.source);
                self.fail(id, pb::FetchFailure::Source);
                return;
            }
        };
        // Проверка после загрузки: отрывок вместо трека и выход за отведённое место — файл убирается
        let too_short = query.duration_secs >= 90 && file.duration_secs > 0 && (file.duration_secs as f32) < query.duration_secs as f32 * MIN_LENGTH_SHARE;
        let (_, used) = self.usage(&user).await;
        let over_quota = used.saturating_add(file.bytes) > self.quota_bytes;
        if too_short || over_quota {
            self.remove_file(&file.path).await;
            self.fail(id, if over_quota { pb::FetchFailure::Limit } else { pb::FetchFailure::Source });
            return;
        }
        let row = Added { path: file.path.clone(), adder: user.clone(), bytes: file.bytes as i64, added_ms: now_ms(), track_id: String::new(), artist: query.artist.clone(), title: query.title.clone(), duration_secs: i64::from(file.duration_secs) };
        if let Err(e) = store::insert(&self.pool, &row).await {
            error!("музыка: добавленный трек не записан: {e}");
            self.remove_file(&file.path).await;
            self.fail(id, pb::FetchFailure::Library);
            return;
        }
        info!("музыка: трек скачан ({} байт, источник {})", file.bytes, candidate.source);
        match self.await_in_library(sub, &user, &query).await {
            Some(track_id) => {
                let _ = store::set_track_id(&self.pool, &file.path, &track_id).await;
                self.update(id, |j| {
                    j.track_id = track_id;
                    j.state = pb::FetchState::Done;
                });
            }
            // Файл на месте и учтён: музыкальный сервер увидит его при следующем сканировании
            None => self.fail(id, pb::FetchFailure::Library),
        }
    }

    /// Попросить музыкальный сервер пересканировать библиотеку и дождаться трека в поиске.
    async fn await_in_library(&self, sub: &Subsonic, user: &str, q: &Query) -> Option<String> {
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        for _ in 0..SCAN_ATTEMPTS {
            tokio::time::sleep(SCAN_PAUSE).await;
            if let Some(track) = self.in_library(sub, &nd_user(user), q).await {
                return Some(track.id);
            }
        }
        None
    }

    fn library_path(&self, relative: &str) -> Option<PathBuf> {
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
        for row in rows {
            // Трек, которого музыкальный сервер ещё не увидел, показывается по записи: название и исполнитель
            let known = if row.track_id.is_empty() { None } else { sub.call(&user, "getSong", &[("id", row.track_id.clone())]).await.ok().and_then(|v| v.get("song").and_then(track_of)) };
            let track = known.unwrap_or_else(|| pb::Track { title: row.title.clone(), artist: row.artist.clone(), duration_secs: row.duration_secs.max(0) as u32, ..Default::default() });
            tracks.push(pb::AddedTrack { track: Some(track), added_ms: row.added_ms, bytes: row.bytes.max(0) as u64, adder: nick(&row.adder) });
        }
        Ok(pb::AddedListResponse { tracks }.encode_to_vec())
    }

    pub async fn added_delete(&self, sub: &Subsonic, address: &str, r: pb::AddedDeleteRequest) -> Reply {
        let row = store::by_track(&self.pool, &r.track_id).await.map_err(|_| ErrorCode::Unavailable)?.ok_or(ErrorCode::NotFound)?;
        if row.adder != address && !self.admins.iter().any(|a| a == address) {
            return Err(ErrorCode::Forbidden);
        }
        self.remove_file(&row.path).await;
        store::delete(&self.pool, &row.path).await.map_err(|_| ErrorCode::Unavailable)?;
        let _ = sub.call(SERVICE_USER, "startScan", &[]).await;
        info!("музыка: добавленный трек удалён");
        Ok(pb::AddedDeleteResponse {}.encode_to_vec())
    }
}
