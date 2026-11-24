//! «Загрузить свои файлы» (spec 041): свой аудиофайл в общую библиотеку сервера.
//!
//! `music.upload.start` проверяет лимиты (те же суточный лимит и место, что у «Найти и скачать»; предел одного файла
//! `PARVANE_MUSIC_UPLOAD_MAX_BYTES`), расширение и SHA-256 — тот же файл второй раз не принимается (задача сразу
//! FAILED / DUPLICATE с id уже лежащего трека) — и выдаёт ссылку с подписью на один приём. Байты идут мимо gateway:
//! `PUT /_parvane/music/u/<жетон>` телом файла целиком. Шард пишет поток во временный файл внутри папки библиотеки
//! (`.parvane-upload/`, скрытая — музыкальный сервер её не сканирует), сверяет длину и SHA-256, сам перечитывает
//! теги (`parvane_protocol::music_tags` — то же чтение, что у клиента; не звук — FORMAT), переносит файл в
//! `<пользователь>/uploads/` и учитывает его как добавленный («кто добавил», удаление — как у скачанного).

use std::sync::Arc;

use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use hyper::{Request, StatusCode};
use parvane_protocol::music_tags::{self, Format};
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _, AsyncWriteExt as _};
use tracing::{error, info, warn};

use crate::fetch::jobs::{file_stem, new_id, Fetch, Job};
use crate::fetch::matching::Query;
use crate::fetch::store::{self, Added};
use crate::subsonic::{nd_user, Subsonic};
use crate::token::{self, Claims, Grant};
use crate::{now_ms, Ctx};

type Reply = Result<Vec<u8>, ErrorCode>;

/// Срок ссылки на приём.
const UPLOAD_TTL_MS: i64 = 3_600_000;
const EXTENSIONS: [&str; 8] = ["mp3", "flac", "ogg", "oga", "opus", "m4a", "mp4", "wav"];
/// Сколько начала файла читается для тегов (как у клиента).
pub const TAGS_HEAD_BYTES: usize = 512 * 1024;
const TEMP_DIR: &str = crate::fetch::jobs::UPLOAD_TEMP;
const SCAN_ATTEMPTS: u32 = 20;
const SCAN_PAUSE: std::time::Duration = std::time::Duration::from_millis(1500);

fn extension_ok(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn hex_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub async fn start(fetch: &Arc<Fetch>, ctx: &Ctx, address: &str, r: pb::UploadStartRequest) -> Reply {
    let name: String = r.file_name.trim().chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').collect();
    let sha = r.sha256.to_ascii_lowercase();
    if name.is_empty() || !extension_ok(&name) || !hex_ok(&sha) || r.bytes == 0 {
        return Err(ErrorCode::Invalid);
    }
    let limits = fetch.limits_for(address).await;
    // «Свои файлы» выключил администратор
    if !limits.uploads {
        return Err(ErrorCode::Forbidden);
    }
    if r.bytes > limits.upload_max_bytes {
        return Err(ErrorCode::Limit);
    }
    let mut job = Job::new(new_id(), address, pb::FetchState::Downloading);
    job.upload_name = name.clone();
    job.sha256 = sha.clone();
    job.bytes_total = r.bytes;
    job.query = Query { artist: r.artist.trim().to_string(), title: r.title.trim().to_string(), duration_secs: r.duration_secs, ..Default::default() };
    // Тот же файл уже в библиотеке: загружать не нужно
    if let Some(row) = store::by_sha256(&fetch.pool, &sha).await.map_err(|_| ErrorCode::Unavailable)? {
        job.state = pb::FetchState::Failed;
        job.failure = pb::FetchFailure::Duplicate;
        job.track_id = row.track_id;
        fetch.admit_finished(job.clone());
        return Ok(pb::UploadStartResponse { job: fetch.job_pb(&job.id), ..Default::default() }.encode_to_vec());
    }
    let (_, used) = fetch.usage(address).await;
    if used.saturating_add(r.bytes) > limits.quota_bytes {
        return Err(ErrorCode::Limit);
    }
    fetch.admit(address, job.clone(), |j| j.sha256 == sha).await?;
    let exp = now_ms() + UPLOAD_TTL_MS;
    let tok = token::sign(&ctx.key, &Claims { user: nd_user(address), exp_ms: exp, grant: Grant::Upload { job: job.id.clone() } }).ok_or(ErrorCode::Unavailable)?;
    Ok(pb::UploadStartResponse { job: fetch.job_pb(&job.id), url: format!("{}/_parvane/music/u/{tok}", ctx.public_base), expires_ms: exp }.encode_to_vec())
}

/// `PUT /_parvane/music/u/<жетон>`: принять файл задачи. Ответ — код HTTP (тело пустое); итог — в задаче.
pub async fn receive(ctx: &Ctx, token_text: &str, req: Request<Incoming>) -> StatusCode {
    let (Some(fetch), Some(sub)) = (ctx.fetch.as_ref(), ctx.sub.as_ref()) else { return StatusCode::SERVICE_UNAVAILABLE };
    let Some(Claims { grant: Grant::Upload { job: id }, .. }) = token::verify(&ctx.key, token_text, now_ms()) else { return StatusCode::FORBIDDEN };
    // Ссылка — на один приём: задача ещё ждёт байты и никто их сейчас не шлёт
    let Some(job) = fetch.claim_upload(&id) else { return StatusCode::CONFLICT };
    match store_file(fetch, &job, req.into_body()).await {
        Ok((path, tags)) => {
            info!("музыка: свой файл принят ({} байт)", job.bytes_total);
            let (fetch, sub, user, id) = (fetch.clone(), sub.clone(), job.user.clone(), job.id.clone());
            tokio::spawn(async move { finish(&fetch, &sub, &id, &user, &path, tags).await });
            StatusCode::OK
        }
        Err((code, failure)) => {
            fetch.fail_with(&job.id, failure, String::new());
            code
        }
    }
}

type Fail = (StatusCode, pb::FetchFailure);

async fn store_file(fetch: &Fetch, job: &Job, mut body: Incoming) -> Result<(String, music_tags::FileTags), Fail> {
    let source = (StatusCode::BAD_REQUEST, pb::FetchFailure::Source);
    let temp_dir = fetch.library_dir.join(TEMP_DIR);
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
    let temp = temp_dir.join(format!("{}.part", job.id));
    let result = async {
        let mut file = tokio::fs::File::create(&temp).await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
        let mut hash = Sha256::new();
        let mut got: u64 = 0;
        let mut reported: u64 = 0;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| source)?;
            let Ok(data) = frame.into_data() else { continue };
            got = got.saturating_add(data.len() as u64);
            if got > job.bytes_total {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, pb::FetchFailure::Limit));
            }
            hash.update(&data);
            file.write_all(&data).await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
            if got - reported >= 256 * 1024 {
                reported = got;
                fetch.update(&job.id, |j| j.bytes_done = got);
            }
        }
        file.flush().await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != job.bytes_total || digest != job.sha256 {
            return Err(source);
        }
        fetch.update(&job.id, |j| j.bytes_done = got);
        // Теги — сам шард, тем же чтением, что у клиента
        let mut head = vec![0u8; TAGS_HEAD_BYTES.min(got as usize)];
        let mut f = tokio::fs::File::open(&temp).await.map_err(|_| source)?;
        f.read_exact(&mut head).await.map_err(|_| source)?;
        let mut tail = vec![0u8; 128.min(got as usize)];
        f.seek(std::io::SeekFrom::End(-(tail.len() as i64))).await.map_err(|_| source)?;
        f.read_exact(&mut tail).await.map_err(|_| source)?;
        let tags = music_tags::read(&head, &tail, &job.upload_name);
        if tags.format == Format::Unknown {
            return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, pb::FetchFailure::Format));
        }
        // Пока шли байты, такой же файл мог появиться
        if let Ok(Some(row)) = store::by_sha256(&fetch.pool, &job.sha256).await {
            fetch.update(&job.id, |j| j.track_id = row.track_id);
            return Err((StatusCode::CONFLICT, pb::FetchFailure::Duplicate));
        }
        let (_, used) = fetch.usage(&job.user).await;
        if used.saturating_add(got) > fetch.limits_for(&job.user).await.quota_bytes {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, pb::FetchFailure::Limit));
        }
        // Задачу сняли, пока шли байты, — файл не берём
        if fetch.job(&job.id).is_none() {
            return Err((StatusCode::GONE, pb::FetchFailure::Source));
        }
        let relative = format!("{}/uploads/{} [{}].{}", nd_user(&job.user), file_stem(&tags.tags.artist, &tags.tags.title), job.id, tags.format.extension());
        let target = fetch.library_path(&relative).ok_or(source)?;
        if let Some(dir) = target.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
        }
        tokio::fs::rename(&temp, &target).await.map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library))?;
        let row = Added {
            path: relative.clone(),
            adder: job.user.clone(),
            bytes: got as i64,
            added_ms: now_ms(),
            track_id: String::new(),
            artist: tags.tags.artist.clone(),
            title: tags.tags.title.clone(),
            duration_secs: i64::from(tags.tags.duration_secs),
            sha256: job.sha256.clone(),
        };
        if let Err(e) = store::insert(&fetch.pool, &row).await {
            error!("музыка: свой файл не учтён: {e}");
            let _ = tokio::fs::remove_file(&target).await;
            return Err((StatusCode::SERVICE_UNAVAILABLE, pb::FetchFailure::Library));
        }
        fetch.update(&job.id, |j| j.recorded = true);
        // «Откуда файл»: свой файл с его исходным именем; тот же трек уже есть — копия той же версии
        let version = (store::next_version(&fetch.pool, &row.artist, &row.title).await.unwrap_or(1) - 1).max(1);
        if let Err(e) = store::set_origin(&fetch.pool, &relative, "upload", &job.upload_name, version).await {
            warn!("музыка: источник своего файла не записан: {e}");
        }
        Ok((relative, tags))
    }
    .await;
    if result.is_err() {
        if let Err(e) = tokio::fs::remove_file(&temp).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("музыка: временный файл загрузки не удалён: {e}");
            }
        }
    }
    result
}

async fn finish(fetch: &Fetch, sub: &Subsonic, id: &str, user: &str, path: &str, tags: music_tags::FileTags) {
    if repair_file_tags(fetch, path).await {
        let _ = store::mark_upload_checked(&fetch.pool, path, &fix_text(&tags.tags.artist), &fix_text(&tags.tags.title)).await;
    }
    let query = Query { artist: tags.tags.artist, title: tags.tags.title, album: tags.tags.album, duration_secs: tags.tags.duration_secs, explicit: None, ..Default::default() };
    fetch.update(id, |j| j.query = query.clone());
    match find_uploaded(sub, &nd_user(user), &query, id).await {
        Some(track_id) => {
            let _ = store::set_track_id(&fetch.pool, path, &track_id).await;
            fetch.update(id, |j| {
                j.track_id = track_id;
                j.state = pb::FetchState::Done;
            });
        }
        None => fetch.fail_with(id, pb::FetchFailure::Library, String::new()),
    }
}

/// Русские теги в Windows-1251 (ID3 «Latin-1»): музыкальный сервер показал бы «Ýíäøïèëü» — до пересканирования
/// файл переписывается в UTF-8. Сбой — файл остаётся как был.
/// `false` — сервис недоступен (проверить в другой раз).
pub(crate) async fn repair_file_tags(fetch: &Fetch, path: &str) -> bool {
    let Ok(service) = fetch.service() else { return false };
    let Ok(v) = service.read_tags(path).await else { return false };
    let Some(tags) = v.get("tags").and_then(serde_json::Value::as_object) else { return true };
    let fixed: serde_json::Map<String, serde_json::Value> = ["title", "artist", "album", "album_artist", "genre"]
        .into_iter()
        .filter_map(|key| tags.get(key).and_then(serde_json::Value::as_str).and_then(music_tags::repair_cp1251).map(|text| (key.to_string(), text.into())))
        .collect();
    if fixed.is_empty() {
        return true;
    }
    match service.write_tags(path, &serde_json::Value::Object(fixed), "", "").await {
        Ok(_) => {
            info!("музыка: теги своего файла переписаны из Windows-1251");
            true
        }
        Err(_) => {
            warn!("музыка: теги своего файла не переписаны");
            false
        }
    }
}

fn fix_text(text: &str) -> String {
    music_tags::repair_cp1251(text).unwrap_or_else(|| text.to_string())
}

/// Свои файлы, загруженные до проверки кодировки: теги в Windows-1251 переписываются (раз на файл).
pub(crate) async fn repair_uploaded(fetch: &Fetch, sub: &Subsonic) {
    let mut checked = 0;
    loop {
        let rows = match store::unchecked_uploads(&fetch.pool, 20).await {
            Ok(rows) if !rows.is_empty() => rows,
            _ => break,
        };
        for row in rows {
            if !repair_file_tags(fetch, &row.path).await {
                return;
            }
            if store::mark_upload_checked(&fetch.pool, &row.path, &fix_text(&row.artist), &fix_text(&row.title)).await.is_err() {
                return;
            }
            checked += 1;
        }
    }
    if checked > 0 {
        let _ = sub.call(crate::subsonic::SERVICE_USER, "startScan", &[]).await;
    }
}

fn fold(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Свой файл в библиотеке: без тегов музыкальный сервер называет трек по имени файла (в нём id задачи), с тегами —
/// по ним. Ищем по названию и берём трек, чьё название содержит искомое (либо id задачи); при нескольких — ближе по
/// длительности.
async fn find_uploaded(sub: &Subsonic, user: &str, q: &Query, id: &str) -> Option<String> {
    let _ = sub.call(crate::subsonic::SERVICE_USER, "startScan", &[]).await;
    let want = fold(&q.title);
    for _ in 0..SCAN_ATTEMPTS {
        tokio::time::sleep(SCAN_PAUSE).await;
        let Ok(v) = sub.call(user, "search3", &[("query", q.title.clone()), ("songCount", "20".into()), ("albumCount", "0".into()), ("artistCount", "0".into())]).await else { continue };
        let mut found: Vec<pb::Track> = crate::subsonic::list(&v, &["searchResult3", "song"])
            .iter()
            .filter_map(crate::subsonic::track_of)
            .filter(|t| t.title.contains(id) || (!want.is_empty() && fold(&t.title).contains(&want) && (q.artist.is_empty() || fold(&t.artist).contains(&fold(&q.artist)) || t.title.contains(id))))
            .collect();
        found.sort_by_key(|t| (!t.title.contains(id), if q.duration_secs == 0 { 0 } else { t.duration_secs.abs_diff(q.duration_secs) }));
        if let Some(t) = found.into_iter().next() {
            return Some(t.id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_hashes() {
        assert!(extension_ok("Берег.MP3") && extension_ok("a.flac") && !extension_ok("a.exe") && !extension_ok("mp3"));
        assert!(hex_ok(&"ab".repeat(32)) && !hex_ok(&"AB".repeat(32)) && !hex_ok("ab"));
    }
}
