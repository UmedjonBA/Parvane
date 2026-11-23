//! Сервис скачивания (spec 039, этап B): отдельный необязательный процесс за простым HTTP-контрактом. Parvane
//! его не содержит в шарде: администратор включает его сам (`PARVANE_MUSIC_FETCH_URL`) и отвечает за источники.
//!
//! Контракт (JSON):
//! - `GET /catalog?q=&limit=` → `{"tracks":[{"artist","title","album","duration","explicit":true|false|null,"year"}]}`
//! - `GET /candidates?source=&artist=&title=&limit=` → `{"candidates":[{"id","title","uploader","duration",
//!   "uploaded":"ГГГГ-ММ-ДД"|null,"bitrate","explicit"}]}`; источник отказал — 503
//! - `POST /download {"source","id","dest"}` → `{"path","bytes","duration"}`: файл записан в папку библиотеки по
//!   пути `dest` + расширение
//! - (spec 041, необязательно) `GET /progress?dest=` → `{"bytes_done","bytes_total"}` — ход идущей загрузки; нет
//!   метода (404) — шард смотрит размер файла сам; `POST /cancel {"dest"}` — остановить загрузку
//! - отказ с телом `{"reason": "…"}` (кроме 503) — причина словами администратора: её видит пользователь
//!
//! Сервис ничего не решает: что считать тем самым треком, решает `matching`.

use std::time::Duration;

use parvane_protocol::domain::health::days_from_civil;
use serde_json::{json, Value};

use super::matching::{Candidate, Query};

const SEARCH_TIMEOUT: Duration = Duration::from_secs(40);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_JSON_BYTES: usize = 1_048_576;
const TEXT_MAX: usize = 512;

#[derive(Debug, PartialEq, Eq)]
pub enum ServiceError {
    /// Сервис не отвечает либо ответил не по контракту.
    Unavailable,
    /// Источник отказал (блокировка, «не бот»): пробуем следующий.
    SourceRefused,
    /// Сервис отказал и назвал причину (`{"reason"}`): её показывают пользователю.
    Failed(String),
}

/// Ход загрузки по словам сервиса.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub bytes_done: u64,
    pub bytes_total: u64,
}

const REASON_MAX: usize = 200;

fn reason_of(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let r: String = v.get("reason")?.as_str()?.trim().chars().filter(|c| !c.is_control()).collect();
    let mut out = String::new();
    for c in r.chars() {
        if out.len() + c.len_utf8() > REASON_MAX {
            break;
        }
        out.push(c);
    }
    (!out.is_empty()).then_some(out)
}

pub struct FetchService {
    base: String,
    http: reqwest::Client,
}

/// Файл после загрузки.
#[derive(Debug, PartialEq)]
pub struct Downloaded {
    /// Путь относительно папки библиотеки.
    pub path: String,
    pub bytes: u64,
    pub duration_secs: u32,
}

pub(crate) fn clip(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").chars().take(TEXT_MAX).collect()
}

pub(crate) fn num(v: &Value, key: &str) -> u32 {
    v.get(key).and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))).map_or(0, |n| n.min(u64::from(u32::MAX)) as u32)
}

/// `ГГГГ-ММ-ДД` либо `ГГГГММДД` → дни от 1970-01-01.
pub fn parse_day(text: &str) -> Option<i64> {
    let digits: String = text.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 8 {
        return None;
    }
    let (y, m, d) = (digits[..4].parse::<i64>().ok()?, digits[4..6].parse::<u32>().ok()?, digits[6..].parse::<u32>().ok()?);
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| days_from_civil(y, m, d))
}

impl FetchService {
    pub fn new(base: &str) -> Option<Self> {
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).build().ok()?;
        Some(FetchService { base: base.trim_end_matches('/').to_string(), http })
    }

    async fn json(&self, rq: reqwest::RequestBuilder, timeout: Duration) -> Result<Value, ServiceError> {
        let resp = rq.timeout(timeout).send().await.map_err(|_| ServiceError::Unavailable)?;
        if resp.status().as_u16() == 503 {
            return Err(ServiceError::SourceRefused);
        }
        if !resp.status().is_success() {
            let body = resp.bytes().await.unwrap_or_default();
            return Err(reason_of(&body).map_or(ServiceError::Unavailable, ServiceError::Failed));
        }
        let bytes = resp.bytes().await.map_err(|_| ServiceError::Unavailable)?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err(ServiceError::Unavailable);
        }
        serde_json::from_slice(&bytes).map_err(|_| ServiceError::Unavailable)
    }

    pub async fn health(&self) -> bool {
        self.http.get(format!("{}/health", self.base)).timeout(Duration::from_secs(5)).send().await.is_ok_and(|r| r.status().is_success())
    }

    /// Эталоны треков по строке поиска.
    pub async fn catalog(&self, query: &str, limit: u32) -> Result<Vec<(Query, u32)>, ServiceError> {
        let rq = self.http.get(format!("{}/catalog", self.base)).query(&[("q", query.to_string()), ("limit", limit.to_string())]);
        let v = self.json(rq, SEARCH_TIMEOUT).await?;
        let tracks = v.get("tracks").and_then(Value::as_array).ok_or(ServiceError::Unavailable)?;
        Ok(tracks
            .iter()
            .map(|t| (query_of_json(t), num(t, "year")))
            .filter(|(q, _)| !q.artist.is_empty() && !q.title.is_empty())
            .collect())
    }

    /// Эталоны треков по строке как есть (с `ref`, обложкой и альбомом) — для «Микса дня».
    pub async fn catalog_raw(&self, query: &str, limit: u32) -> Result<Vec<Value>, ServiceError> {
        let rq = self.http.get(format!("{}/catalog", self.base)).query(&[("q", query.to_string()), ("limit", limit.to_string())]);
        let v = self.json(rq, SEARCH_TIMEOUT).await?;
        Ok(v.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// Дозаполнить теги и обложку уже скачанного файла: новый путь (Opus из WebM переезжает) и нашёлся ли трек.
    pub async fn retag(&self, path: &str, artist: &str, title: &str) -> Result<(String, bool), ServiceError> {
        let rq = self.http.post(format!("{}/retag", self.base)).json(&json!({"path": path, "tags": {"artist": artist, "title": title}}));
        let v = self.json(rq, DOWNLOAD_TIMEOUT).await?;
        Ok((clip(&v, "path"), v.get("matched").and_then(Value::as_bool).unwrap_or(false)))
    }

    /// Теги и сведения файла библиотеки: `{tags, file: {codec, bitrate, sample_rate, bits, duration, bytes}, has_cover}`.
    pub async fn read_tags(&self, path: &str) -> Result<Value, ServiceError> {
        let rq = self.http.get(format!("{}/tags", self.base)).query(&[("path", path)]);
        self.json(rq, SEARCH_TIMEOUT).await
    }

    /// Переписать переданные поля тегов (обложка — ссылкой каталога либо картинкой base64); ответ — как `read_tags`.
    pub async fn write_tags(&self, path: &str, tags: &Value, cover_url: &str, cover_b64: &str) -> Result<Value, ServiceError> {
        let body = json!({"path": path, "tags": tags, "cover_url": cover_url, "cover_b64": cover_b64});
        let rq = self.http.post(format!("{}/tags", self.base)).json(&body);
        self.json(rq, DOWNLOAD_TIMEOUT).await
    }

    /// Что за ссылкой (YouTube, SoundCloud, Bandcamp): `{source, id, artist, title, album, duration}`.
    pub async fn resolve(&self, url: &str) -> Result<Value, ServiceError> {
        let rq = self.http.post(format!("{}/resolve", self.base)).json(&json!({"url": url}));
        self.json(rq, SEARCH_TIMEOUT).await
    }

    /// Маршрут каталога сервиса (`/catalog/search`, `/catalog/artist`, …) — ответ как есть.
    pub async fn catalog_call(&self, path: &str, params: &[(&str, String)]) -> Result<Value, ServiceError> {
        let rq = self.http.get(format!("{}/catalog/{path}", self.base)).query(params);
        self.json(rq, SEARCH_TIMEOUT).await
    }

    /// Файлы источника, похожие на трек.
    pub async fn candidates(&self, source: &str, q: &Query, limit: u32) -> Result<Vec<Candidate>, ServiceError> {
        let rq = self.http.get(format!("{}/candidates", self.base)).query(&[("source", source.to_string()), ("artist", q.artist.clone()), ("title", q.title.clone()), ("limit", limit.to_string())]);
        let v = self.json(rq, SEARCH_TIMEOUT).await?;
        let list = v.get("candidates").and_then(Value::as_array).ok_or(ServiceError::Unavailable)?;
        Ok(list
            .iter()
            .map(|c| Candidate {
                id: clip(c, "id"),
                source: source.to_string(),
                title: clip(c, "title"),
                uploader: clip(c, "uploader"),
                duration_secs: num(c, "duration"),
                upload_day: c.get("uploaded").and_then(Value::as_str).and_then(parse_day),
                bitrate_kbps: num(c, "bitrate"),
                explicit: c.get("explicit").and_then(Value::as_bool),
            })
            .filter(|c| !c.id.is_empty() && c.id.len() <= 256)
            .collect())
    }

    /// Скачать файл в папку библиотеки; `dest` — путь без расширения.
    /// Скачать файл в `dest`; `tags` — эталон каталога: сервис пишет его в теги файла вместо тегов перезаливщика.
    pub async fn download(&self, source: &str, id: &str, dest: &str, tags: &Query) -> Result<Downloaded, ServiceError> {
        let tags = json!({"artist": tags.artist, "title": tags.title, "album": tags.album, "ref": tags.reference});
        let rq = self.http.post(format!("{}/download", self.base)).json(&json!({"source": source, "id": id, "dest": dest, "tags": tags}));
        let v = self.json(rq, DOWNLOAD_TIMEOUT).await?;
        let path = v.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let bytes = v.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        // Сервис пишет только туда, куда просили: чужой путь — отказ
        if path.is_empty() || bytes == 0 || !path.starts_with(dest) || path.contains("..") {
            return Err(ServiceError::Unavailable);
        }
        Ok(Downloaded { path, bytes, duration_secs: num(&v, "duration") })
    }

    /// Ход загрузки в `dest`; `None` — сервис не знает (метода нет либо загрузка не началась).
    pub async fn progress(&self, dest: &str) -> Option<Progress> {
        let rq = self.http.get(format!("{}/progress", self.base)).query(&[("dest", dest)]);
        let v = self.json(rq, Duration::from_secs(5)).await.ok()?;
        let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        Some(Progress { bytes_done: n("bytes_done"), bytes_total: n("bytes_total") })
    }

    /// Остановить загрузку в `dest` (сбой не важен: недокачанное шард сотрёт сам).
    pub async fn cancel(&self, dest: &str) {
        let _ = self.http.post(format!("{}/cancel", self.base)).json(&json!({"dest": dest})).timeout(Duration::from_secs(5)).send().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_is_trimmed_and_capped() {
        assert_eq!(reason_of(br#"{"reason":"  YouTube banned this server  "}"#).as_deref(), Some("YouTube banned this server"));
        assert_eq!(reason_of(br#"{"reason":""}"#), None);
        assert_eq!(reason_of(b"not json"), None);
        let long = format!(r#"{{"reason":"{}"}}"#, "я".repeat(300));
        assert!(reason_of(long.as_bytes()).unwrap().len() <= REASON_MAX);
    }
}

/// Трек каталога из ответа сервиса (`artist`, `title`, `album`, `duration`, `explicit`, `ref`, `cover`, `album_ref`).
pub fn query_of_json(t: &Value) -> Query {
    Query {
        artist: clip(t, "artist"),
        title: clip(t, "title"),
        album: clip(t, "album"),
        duration_secs: num(t, "duration"),
        explicit: t.get("explicit").and_then(Value::as_bool),
        reference: clip(t, "ref"),
        cover_url: clip(t, "cover"),
        preview_url: clip(t, "preview"),
        album_ref: clip(t, "album_ref"),
    }
}
