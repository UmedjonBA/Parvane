//! Тексты песен. Сначала — что знает музыкальный сервер (файл `.lrc` рядом с треком либо теги); нет — поиск в LRCLIB
//! через сервис скачивания по исполнителю, названию и длительности: найденное кладётся рядом с файлом (дальше его
//! отдаёт музыкальный сервер), ненайденное помнится сутки, чтобы не спрашивать LRCLIB на каждое открытие плеера.
//! Трек не на сервере («Слушать из сети») — только поиск, по исполнителю и названию из запроса.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1 as pb;
use parvane_v2rt::Reply;
use prost::Message;
use tracing::warn;

use crate::subsonic::{list, track_of, valid_id, Subsonic};
use crate::{now_ms, Ctx};

const LINES_MAX: usize = 1000;
const LINE_MAX: usize = 1024;
// Не нашлось — сутки не ищем заново
const MISS_TTL_MS: i64 = 24 * 3_600_000;
// Найденное, пока музыкальный сервер не прочитал файл `.lrc`
const FOUND_MAX: usize = 500;

#[derive(Default)]
struct Memory {
    misses: HashMap<String, i64>,
    found: HashMap<String, String>,
}

fn memory() -> &'static Mutex<Memory> {
    static MEMORY: OnceLock<Mutex<Memory>> = OnceLock::new();
    MEMORY.get_or_init(Mutex::default)
}

pub(crate) async fn lyrics(ctx: &Ctx, sub: &Subsonic, user: &str, r: pb::LyricsRequest) -> Reply {
    if r.wrong {
        return mark_wrong(ctx, sub, r).await;
    }
    if !r.track_id.is_empty() {
        if !valid_id(&r.track_id, 64) {
            return Err(ErrorCode::Invalid);
        }
        // Текст этому треку отмечен неверным — больше не ищем и не показываем
        if marker_path(ctx, &r.track_id).await.is_some_and(|m| m.exists()) {
            return Ok(pb::LyricsResponse::default().encode_to_vec());
        }
        if let Some(found) = from_library(sub, user, &r.track_id).await {
            return Ok(found.encode_to_vec());
        }
        let Some(song) = sub.call(user, "getSong", &[("id", r.track_id.clone())]).await.ok().and_then(|v| v.get("song").and_then(track_of)) else {
            return Ok(pb::LyricsResponse::default().encode_to_vec());
        };
        let text = lookup(ctx, &r.track_id, &song.artist, &song.title, &song.album, song.duration_secs).await;
        if let Some(text) = &text {
            save_sidecar(ctx, &r.track_id, text).await;
        }
        return Ok(parse(text.as_deref().unwrap_or("")).encode_to_vec());
    }
    if r.artist.trim().is_empty() || r.title.trim().is_empty() {
        return Err(ErrorCode::Invalid);
    }
    let key = format!("{}\n{}", r.artist.trim().to_lowercase(), r.title.trim().to_lowercase());
    let text = lookup(ctx, &key, r.artist.trim(), r.title.trim(), r.album.trim(), r.duration_secs).await;
    Ok(parse(text.as_deref().unwrap_or("")).encode_to_vec())
}

/// «Текст не от этой песни»: сохранённый рядом с файлом текст стирается, рядом кладётся отметка `<имя>.nolyrics`
/// (музыкальный сервер её не читает, поиск по ней молчит), музыкальный сервер пересканирует библиотеку. Трек не на
/// сервере — отметка в памяти шарда.
async fn mark_wrong(ctx: &Ctx, sub: &Subsonic, r: pb::LyricsRequest) -> Reply {
    let key = if r.track_id.is_empty() {
        if r.artist.trim().is_empty() || r.title.trim().is_empty() {
            return Err(ErrorCode::Invalid);
        }
        format!("{}\n{}", r.artist.trim().to_lowercase(), r.title.trim().to_lowercase())
    } else {
        if !valid_id(&r.track_id, 64) {
            return Err(ErrorCode::Invalid);
        }
        r.track_id.clone()
    };
    if let Ok(mut m) = memory().lock() {
        m.found.remove(&key);
        m.misses.insert(key.clone(), i64::MAX);
    }
    if let Some(marker) = marker_path(ctx, &r.track_id).await {
        let _ = tokio::fs::remove_file(marker.with_extension("lrc")).await;
        if let Err(e) = tokio::fs::write(&marker, b"").await {
            warn!("музыка: отметка «не тот текст» не записана: {e}");
        }
        let _ = sub.call(crate::subsonic::SERVICE_USER, "startScan", &[]).await;
    }
    Ok(pb::LyricsResponse::default().encode_to_vec())
}

/// `<файл трека>.nolyrics` — для трека, добавленного через «Найти и скачать» либо своего.
async fn marker_path(ctx: &Ctx, track_id: &str) -> Option<std::path::PathBuf> {
    if track_id.is_empty() {
        return None;
    }
    let fetch = ctx.fetch.as_ref()?;
    let row = crate::fetch::store::by_track(&fetch.pool, track_id).await.ok()??;
    Some(fetch.library_path(&row.path)?.with_extension("nolyrics"))
}

/// OpenSubsonic `getLyricsBySongId`: синхронный — первым; нет — `None`.
async fn from_library(sub: &Subsonic, user: &str, track_id: &str) -> Option<pb::LyricsResponse> {
    let v = sub.call(user, "getLyricsBySongId", &[("id", track_id.to_string())]).await.ok()?;
    let mut all: Vec<&serde_json::Value> = list(&v, &["lyricsList", "structuredLyrics"]).iter().collect();
    all.sort_by_key(|l| !l.get("synced").and_then(serde_json::Value::as_bool).unwrap_or(false));
    let best = all.first()?;
    let synced = best.get("synced").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let lines: Vec<pb::LyricsLine> = best
        .get("line")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .take(LINES_MAX)
        .map(|l| pb::LyricsLine {
            start_ms: if synced { l.get("start").and_then(serde_json::Value::as_u64).and_then(|s| u32::try_from(s).ok()).unwrap_or(0) } else { 0 },
            text: l.get("value").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(LINE_MAX).collect(),
        })
        .collect();
    (!lines.is_empty()).then_some(pb::LyricsResponse { synced, lines })
}

/// Поиск в LRCLIB (через сервис скачивания) с памятью о найденном и ненайденном.
async fn lookup(ctx: &Ctx, key: &str, artist: &str, title: &str, album: &str, duration_secs: u32) -> Option<String> {
    let service = ctx.fetch.as_ref()?.service().ok()?;
    let now = now_ms();
    if let Ok(m) = memory().lock() {
        if let Some(text) = m.found.get(key) {
            return Some(text.clone());
        }
        // `i64::MAX` — «не тот текст»: навсегда
        if m.misses.get(key).is_some_and(|&at| at == i64::MAX || now - at < MISS_TTL_MS) {
            return None;
        }
    }
    let text = match service.lyrics(artist, title, album, duration_secs).await {
        Ok(text) => text,
        Err(e) => {
            // Сервис недоступен — не запоминаем: в другой раз спросим снова
            warn!("музыка: текст песни не найден — сервис недоступен: {e:?}");
            return None;
        }
    };
    let mut m = memory().lock().ok()?;
    if text.trim().is_empty() {
        m.misses.insert(key.to_string(), now);
        return None;
    }
    if m.found.len() >= FOUND_MAX {
        m.found.clear();
    }
    m.found.insert(key.to_string(), text.clone());
    Some(text)
}

/// Найденный текст — рядом с файлом трека (`<имя>.lrc`), если файл добавлен через «Найти и скачать» либо свой.
async fn save_sidecar(ctx: &Ctx, track_id: &str, text: &str) {
    let Some(fetch) = ctx.fetch.as_ref() else { return };
    let Ok(Some(row)) = crate::fetch::store::by_track(&fetch.pool, track_id).await else { return };
    let Some(path) = fetch.library_path(&row.path) else { return };
    let lrc = path.with_extension("lrc");
    if tokio::fs::try_exists(&lrc).await.unwrap_or(true) {
        return;
    }
    if let Err(e) = tokio::fs::write(&lrc, format!("{}\n", text.trim())).await {
        warn!("музыка: текст песни не записан рядом с файлом: {e}");
    }
}

/// Текст LRC (`[01:23.45] строка`, у строки может быть несколько отметок) либо простой. Служебные строки (`[ar: …]`)
/// пропускаются; хоть одна отметка времени — текст синхронный, строки по времени.
pub(crate) fn parse(text: &str) -> pb::LyricsResponse {
    let mut timed: Vec<(u32, String)> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        let mut is_meta = false;
        while let Some(inner) = rest.strip_prefix('[') {
            let Some(end) = inner.find(']') else { break };
            match stamp_ms(&inner[..end]) {
                Some(ms) => stamps.push(ms),
                None => is_meta = stamps.is_empty(),
            }
            rest = inner[end + 1..].trim_start();
            if is_meta {
                break;
            }
        }
        if is_meta {
            continue;
        }
        let line: String = rest.trim().chars().take(LINE_MAX).collect();
        if stamps.is_empty() {
            plain.push(line);
        } else {
            timed.extend(stamps.into_iter().map(|ms| (ms, line.clone())));
        }
    }
    if !timed.is_empty() {
        timed.sort_by_key(|(ms, _)| *ms);
        let lines = timed.into_iter().take(LINES_MAX).map(|(start_ms, text)| pb::LyricsLine { start_ms, text }).collect();
        return pb::LyricsResponse { synced: true, lines };
    }
    while plain.last().is_some_and(String::is_empty) {
        plain.pop();
    }
    let lines = plain.into_iter().skip_while(String::is_empty).take(LINES_MAX).map(|text| pb::LyricsLine { start_ms: 0, text }).collect();
    pb::LyricsResponse { synced: false, lines }
}

/// `mm:ss`, `mm:ss.xx`, `mm:ss.xxx` → мс.
fn stamp_ms(tag: &str) -> Option<u32> {
    let (min, sec) = tag.split_once(':')?;
    let min: u32 = min.trim().parse().ok()?;
    let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
    let whole: u32 = whole.trim().parse().ok()?;
    if whole >= 60 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let frac_ms = match frac.len() {
        0 => 0,
        1 => frac.parse::<u32>().ok()? * 100,
        2 => frac.parse::<u32>().ok()? * 10,
        _ => frac[..3].parse::<u32>().ok()?,
    };
    min.checked_mul(60_000)?.checked_add(whole * 1000 + frac_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lrc_and_plain_texts() {
        let lrc = parse("[ar: Группа]\n[ti: Песня]\n[00:01.50] Первая\n[00:04.2][00:09.000]Вторая\n");
        assert!(lrc.synced);
        assert_eq!(lrc.lines.iter().map(|l| (l.start_ms, l.text.as_str())).collect::<Vec<_>>(), [(1500, "Первая"), (4200, "Вторая"), (9000, "Вторая")]);
        let plain = parse("\nПервая строка\n\nВторая строка\n\n");
        assert!(!plain.synced);
        assert_eq!(plain.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Первая строка", "", "Вторая строка"]);
        assert!(parse("").lines.is_empty());
    }
}
