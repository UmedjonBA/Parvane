//! Клиент музыкального сервера (Navidrome, API Subsonic, JSON). Пользователя называет заголовок `Remote-User`:
//! сервер доверяет ему только от шарда (`ND_EXTAUTH_TRUSTEDSOURCES`), паролей пользователей нет.

use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::music::v1::{Album, Artist, Track};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::{debug, warn};

const API_VERSION: &str = "1.16.1";
const CLIENT_NAME: &str = "parvane";
/// Служебный пользователь: первым обращается к свежему серверу и становится его администратором.
pub const SERVICE_USER: &str = "parvane-admin";
/// Ответ каталога больше этого не читаем (альбом на 1000 треков — около 1 МБ).
const MAX_JSON_BYTES: usize = 8 * 1_048_576;
const ID_MAX: usize = 64;
const COVER_MAX: usize = 96;
const TEXT_MAX: usize = 512;

#[derive(Clone)]
pub struct Subsonic {
    base: String,
    http: reqwest::Client,
}

/// Имя пользователя музыкального сервера: `<ник>.<8 hex SHA-256(адрес)>` — читаемо администратору и не
/// сталкивается у одинаковых ников разных доменов.
pub fn nd_user(address: &str) -> String {
    let nick: String = address.split('@').next().unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).take(40).collect();
    let h = Sha256::digest(address.as_bytes());
    let tag: String = h.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{nick}.{tag}")
}

/// Идентификатор из запроса клиента: непустой, без знаков, которые меняют запрос.
pub fn valid_id(id: &str, max: usize) -> bool {
    !id.is_empty() && id.len() <= max && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

impl Subsonic {
    pub fn new(base: &str) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .no_proxy()
            .build()?;
        Ok(Self { base: base.trim_end_matches('/').to_string(), http })
    }

    fn request(&self, user: &str, endpoint: &str, params: &[(&str, String)]) -> reqwest::RequestBuilder {
        self.http
            .get(format!("{}/rest/{endpoint}", self.base))
            .header("Remote-User", user)
            .query(&[("v", API_VERSION), ("c", CLIENT_NAME), ("f", "json"), ("u", user)])
            .query(params)
    }

    /// Завести пользователя на музыкальном сервере. API Subsonic незнакомого пользователя из заголовка не создаёт
    /// (отказ 40) — создаёт страница веб-интерфейса: ей достаточно того же заголовка (проверено на Navidrome
    /// 0.64). Первый созданный становится администратором, поэтому при старте шард приходит служебным именем.
    async fn ensure_user(&self, user: &str) -> Result<(), ErrorCode> {
        let resp = self
            .http
            .get(format!("{}/app/", self.base))
            .header("Remote-User", user)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|_| ErrorCode::Unavailable)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            warn!("музыка: пользователь не создан: HTTP {}", resp.status());
            Err(ErrorCode::Unavailable)
        }
    }

    /// Вызов каталога: содержимое `subsonic-response` при `status = ok`. Отказ «неверный пользователь» —
    /// пользователь ещё не заведён: заводим и повторяем один раз.
    pub async fn call(&self, user: &str, endpoint: &str, params: &[(&str, String)]) -> Result<Value, ErrorCode> {
        match self.call_once(user, endpoint, params).await {
            Err((ErrorCode::Unavailable, 40)) => {
                self.ensure_user(user).await?;
                self.call_once(user, endpoint, params).await.map_err(|(e, _)| e)
            }
            r => r.map_err(|(e, _)| e),
        }
    }

    /// Один запрос; при отказе — код для клиента и код Subsonic (0 — отказ не от API).
    async fn call_once(&self, user: &str, endpoint: &str, params: &[(&str, String)]) -> Result<Value, (ErrorCode, i64)> {
        let resp = self.request(user, endpoint, params).timeout(std::time::Duration::from_secs(20)).send().await.map_err(|e| {
            warn!("музыка: {endpoint}: сервер недоступен: {e}");
            (ErrorCode::Unavailable, 0)
        })?;
        if !resp.status().is_success() {
            warn!("музыка: {endpoint}: HTTP {}", resp.status());
            return Err((ErrorCode::Unavailable, 0));
        }
        let bytes = resp.bytes().await.map_err(|_| (ErrorCode::Unavailable, 0))?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err((ErrorCode::Unavailable, 0));
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| (ErrorCode::Unavailable, 0))?;
        let Some(r) = v.get("subsonic-response") else { return Err((ErrorCode::Unavailable, 0)) };
        if r.get("status").and_then(Value::as_str) == Some("ok") {
            return Ok(r.clone());
        }
        // 70 — «не найдено»; прочее (в т.ч. 40/50 — права) клиенту неотличимо
        let code = r.get("error").and_then(|e| e.get("code")).and_then(Value::as_i64).unwrap_or(0);
        debug!("музыка: {endpoint}: отказ сервера {code}");
        Err((if code == 70 { ErrorCode::NotFound } else { ErrorCode::Unavailable }, code))
    }

    /// Двоичный ответ (поток, обложка) без чтения тела: заголовки и поток — вызывающему.
    pub async fn raw(&self, user: &str, endpoint: &str, params: &[(&str, String)], range: Option<&str>) -> Result<reqwest::Response, ErrorCode> {
        let mut rq = self.request(user, endpoint, params);
        if let Some(r) = range {
            rq = rq.header("Range", r);
        }
        rq.send().await.map_err(|e| {
            warn!("музыка: {endpoint}: сервер недоступен: {e}");
            ErrorCode::Unavailable
        })
    }
}

fn text(v: &Value, key: &str, max: usize) -> String {
    let mut s = match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if s.len() > max {
        let mut cut = max;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// Идентификатор из ответа сервера: длиннее схемы или с посторонними знаками — пусто.
fn id(v: &Value, key: &str, max: usize) -> String {
    let s = text(v, key, usize::MAX);
    if valid_id(&s, max) { s } else { String::new() }
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn num32(v: &Value, key: &str) -> u32 {
    u32::try_from(num(v, key)).unwrap_or(u32::MAX)
}

pub fn track_of(v: &Value) -> Option<Track> {
    let id_ = id(v, "id", ID_MAX);
    if id_.is_empty() {
        return None;
    }
    Some(Track {
        id: id_,
        title: text(v, "title", TEXT_MAX),
        artist: text(v, "artist", TEXT_MAX),
        album: text(v, "album", TEXT_MAX),
        album_id: id(v, "albumId", ID_MAX),
        artist_id: id(v, "artistId", ID_MAX),
        duration_secs: num32(v, "duration"),
        size_bytes: num(v, "size"),
        mime: text(v, "contentType", 64),
        cover_id: id(v, "coverArt", COVER_MAX),
        track_no: num32(v, "track"),
        year: num32(v, "year"),
        bitrate_kbps: num32(v, "bitRate"),
        starred: v.get("starred").is_some_and(|s| !s.is_null()),
    })
}

pub fn album_of(v: &Value) -> Option<Album> {
    let id_ = id(v, "id", ID_MAX);
    if id_.is_empty() {
        return None;
    }
    let title = if v.get("name").is_some() { text(v, "name", TEXT_MAX) } else { text(v, "title", TEXT_MAX) };
    Some(Album {
        id: id_,
        title,
        artist: text(v, "artist", TEXT_MAX),
        artist_id: id(v, "artistId", ID_MAX),
        cover_id: id(v, "coverArt", COVER_MAX),
        track_count: num32(v, "songCount"),
        duration_secs: num32(v, "duration"),
        year: num32(v, "year"),
    })
}

pub fn artist_of(v: &Value) -> Option<Artist> {
    let id_ = id(v, "id", ID_MAX);
    if id_.is_empty() {
        return None;
    }
    Some(Artist { id: id_, name: text(v, "name", TEXT_MAX), cover_id: id(v, "coverArt", COVER_MAX), album_count: num32(v, "albumCount") })
}

/// Массив по пути `a.b` (у Subsonic пустой список может отсутствовать вовсе).
pub fn list<'a>(v: &'a Value, path: &[&str]) -> &'a [Value] {
    let mut cur = v;
    for p in path {
        match cur.get(p) {
            Some(n) => cur = n,
            None => return &[],
        }
    }
    cur.as_array().map(Vec::as_slice).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_names_are_stable_and_distinct() {
        let a = nd_user("alice@one.example");
        assert_eq!(a, nd_user("alice@one.example"));
        assert!(a.starts_with("alice.") && a.len() == "alice.".len() + 8);
        assert_ne!(a, nd_user("alice@two.example"));
        assert!(valid_id(&a, 64));
    }

    #[test]
    fn foreign_ids_and_long_texts_are_contained() {
        let v = serde_json::json!({"id": "a b&c=1", "title": "x"});
        assert!(track_of(&v).is_none(), "id с посторонними знаками не проходит");
        let long = "я".repeat(400);
        let t = track_of(&serde_json::json!({"id": "t1", "title": long, "starred": "2026-11-16T00:00:00Z", "duration": 215, "albumId": "x".repeat(80)})).unwrap();
        assert!(t.title.len() <= 512 && t.title.is_char_boundary(t.title.len()));
        assert!(t.starred && t.duration_secs == 215 && t.album_id.is_empty());
        assert!(!valid_id("", 64) && !valid_id("a/b", 64) && !valid_id("a?b", 64));
    }
}
