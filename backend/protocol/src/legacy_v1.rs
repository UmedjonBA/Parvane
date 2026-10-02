//! Разбор v1-сообщений в v2-`Content` (T017, FR-053) — ТОЛЬКО чтение истории.
//! Единственное место, где живут «диалекты» v1 (инвентаризация —
//! `specs/007-protocol-v2/v1-dialects.md`, D-1…D-26):
//! - Olm-plaintext — всегда обёртка `{from, content}`, автор = `from` обёртки;
//! - Megolm-plaintext — голый content ИЛИ старая обёртка; `inner.from`
//!   игнорируется, автор = wire `from` (P-02);
//! - опросы: `options ?? answers`, флаг = OR пары (`is_public`/`public`, …);
//! - пустая подпись: отсутствует / `null` / `""`;
//! - video_note без `height` → `height = width`;
//! - `ctype` может отсутствовать (0 и 1 — пробовать оба);
//! - live-локация: `live_period` опционален; `heading` не переносится;
//! - голоса опроса: целые ≥ 0, строки-числа допустимы;
//! - ICE: web `{candidate,sdpMid,sdpMLineIndex}` и desktop `{sdp,mid,idx}`.
//!
//! LegacyV1 не может прийти содержимым v2-конверта (D-09): вход сюда — только
//! записи журнала вида `legacy_v1`.

use base64::Engine as _;
use serde_json::{Map, Value};

use crate::error::{ProtoError, Result};
use crate::pb::parvane::call::v2::IceCandidate;
use crate::pb::parvane::core::v2::UserRef;
use crate::pb::parvane::msg::v2::{
    content, Content, Entity, EntityType, ForwardInfo, LinkPreview, Location, Media, MediaKind, MessageRef, PackRef, Poll,
    PollClose, PollOption, PollVote, Sticker, Text,
};

/// Строка messenger v1 (`StoredMessage`) без расшифровки.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyStored {
    pub id: String,
    /// Wire `from`; пусто у sealed 1-на-1.
    pub from: String,
    pub to: String,
    pub ts: i64,
    pub reply_to: Option<String>,
    pub edited: bool,
    pub deleted: bool,
    pub pinned: bool,
    pub body: LegacyBody,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LegacyBody {
    /// Удалённое сообщение (надгробие).
    Tombstone,
    /// Открытое содержимое эпохи до E2E.
    Plain(Box<Content>),
    /// Olm (1-на-1).
    Olm { ciphertext: Vec<u8>, ctype: Option<u32>, sender_identity: String, sender_signing_key: String },
    /// Megolm (группа).
    Megolm { ciphertext: Vec<u8>, group: String, sender_identity: String, sender_signing_key: String },
}

/// Разобранный inner-content v1.
#[derive(Debug, Clone, PartialEq)]
pub enum LegacyInner {
    Content(Box<Content>),
    /// Раздача Megolm-ключа (не показывается в ленте).
    Skdm { group: String, session_key: String, sender_identity: String, epoch: u64 },
    /// Неизвестный вид — заглушка «не поддерживается»; сырой JSON сохранён.
    Unknown(String),
}

fn obj(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or(ProtoError::Malformed)
}

fn s<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or("")
}

fn u(m: &Map<String, Value>, k: &str) -> u64 {
    match m.get(k) {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).unwrap_or(0),
        Some(Value::String(x)) => x.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn b(m: &Map<String, Value>, k: &str) -> bool {
    m.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn u32c(x: u64) -> u32 {
    u32::try_from(x).unwrap_or(u32::MAX)
}

/// base64 с padding или без (стандартный и url-алфавит).
pub fn b64(s: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let t = s.trim();
    STANDARD
        .decode(t)
        .or_else(|_| STANDARD_NO_PAD.decode(t))
        .or_else(|_| URL_SAFE.decode(t))
        .or_else(|_| URL_SAFE_NO_PAD.decode(t))
        .ok()
}

/// UUID v1-сообщения → ссылка v2 (16 байт).
pub fn uuid_ref(id: &str) -> Option<MessageRef> {
    uuid::Uuid::parse_str(id.trim()).ok().map(|u| MessageRef { op_id: u.as_bytes().to_vec() })
}

/// Разобрать `StoredMessage` (или строку БД в той же форме).
pub fn parse_stored(json: &[u8]) -> Result<LegacyStored> {
    let v: Value = serde_json::from_slice(json).map_err(|_| ProtoError::Malformed)?;
    let m = obj(&v)?;
    let id = s(m, "id").to_string();
    if id.is_empty() {
        return Err(ProtoError::InvalidField("id"));
    }
    let deleted = b(m, "deleted");
    let content = m.get("content").ok_or(ProtoError::InvalidField("content"))?;
    let body = if deleted { LegacyBody::Tombstone } else { server_content(content)? };
    let ts = match m.get("ts") {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        _ => 0,
    };
    Ok(LegacyStored {
        id,
        from: s(m, "from").to_string(),
        to: s(m, "to").to_string(),
        ts,
        reply_to: m.get("reply_to").and_then(Value::as_str).map(str::to_string),
        edited: b(m, "edited"),
        deleted,
        pinned: b(m, "pinned"),
        body,
    })
}

/// Серверный уровень `MessageContent`.
fn server_content(v: &Value) -> Result<LegacyBody> {
    let m = obj(v)?;
    match s(m, "kind") {
        "encrypted" => {
            let ct = s(m, "ciphertext");
            if ct.is_empty() {
                return Ok(LegacyBody::Tombstone);
            }
            Ok(LegacyBody::Olm {
                ciphertext: b64(ct).ok_or(ProtoError::InvalidField("ciphertext"))?,
                ctype: m.get("ctype").and_then(Value::as_u64).map(u32c),
                sender_identity: s(m, "sender_identity").to_string(),
                sender_signing_key: s(m, "sender_signing_key").to_string(),
            })
        }
        "group_encrypted" => {
            let ct = s(m, "ciphertext");
            if ct.is_empty() {
                return Ok(LegacyBody::Tombstone);
            }
            Ok(LegacyBody::Megolm {
                ciphertext: b64(ct).ok_or(ProtoError::InvalidField("ciphertext"))?,
                group: s(m, "group").to_string(),
                sender_identity: s(m, "sender_identity").to_string(),
                sender_signing_key: s(m, "sender_signing_key").to_string(),
            })
        }
        "text" if s(m, "text").is_empty() => Ok(LegacyBody::Tombstone),
        _ => match inner(v)? {
            LegacyInner::Content(c) => Ok(LegacyBody::Plain(c)),
            _ => Err(ProtoError::InvalidField("kind")),
        },
    }
}

/// Порядок пробы типа Olm-сообщения при отсутствии `ctype` (D-12).
pub fn ctype_candidates(ctype: Option<u32>) -> Vec<u32> {
    match ctype {
        Some(t) => vec![t],
        None => vec![0, 1],
    }
}

/// Olm-plaintext: обёртка `{from, content}` обязательна; автор = `from`.
pub fn parse_olm_plaintext(pt: &[u8]) -> Result<(String, LegacyInner)> {
    let v: Value = serde_json::from_slice(pt).map_err(|_| ProtoError::Malformed)?;
    let m = obj(&v)?;
    let from = s(m, "from");
    let content = m.get("content").filter(|c| c.is_object()).ok_or(ProtoError::InvalidField("content"))?;
    if !crate::address::is_valid_address(from) {
        return Err(ProtoError::BadAddress);
    }
    Ok((from.to_string(), inner(content)?))
}

/// Megolm-plaintext: голый content или старая обёртка; `inner.from`
/// игнорируется (автор — wire `from` строки).
pub fn parse_megolm_plaintext(pt: &[u8]) -> Result<LegacyInner> {
    let v: Value = serde_json::from_slice(pt).map_err(|_| ProtoError::Malformed)?;
    let m = obj(&v)?;
    match (m.get("from"), m.get("content")) {
        (Some(_), Some(c)) if c.is_object() => inner(c),
        _ => inner(&v),
    }
}

fn entity_type(t: &str) -> Option<EntityType> {
    Some(match t {
        "bold" => EntityType::Bold,
        "italic" => EntityType::Italic,
        "underline" => EntityType::Underline,
        "strike" | "strikethrough" => EntityType::Strike,
        "spoiler" => EntityType::Spoiler,
        "code" => EntityType::Code,
        "pre" => EntityType::Pre,
        "text_url" => EntityType::TextUrl,
        "url" => EntityType::Url,
        "mention" => EntityType::Mention,
        "mention_name" => EntityType::MentionName,
        "hashtag" => EntityType::Hashtag,
        "email" => EntityType::Email,
        "phone" => EntityType::Phone,
        "blockquote" => EntityType::Blockquote,
        "custom_emoji" => EntityType::CustomEmoji,
        _ => return None,
    })
}

fn entities(m: &Map<String, Value>) -> Vec<Entity> {
    let Some(arr) = m.get("entities").and_then(Value::as_array) else { return vec![] };
    arr.iter()
        .filter_map(|e| {
            let e = e.as_object()?;
            let ty = entity_type(s(e, "type"))?;
            let data = s(e, "data").to_string();
            let mut out = Entity {
                r#type: ty as i32,
                offset: u32c(u(e, "offset")),
                length: u32c(u(e, "length")),
                ..Default::default()
            };
            match ty {
                EntityType::TextUrl => out.url = data,
                EntityType::Pre => out.language = data,
                EntityType::CustomEmoji => out.custom_emoji_id = data,
                EntityType::MentionName => out.user = Some(UserRef { address: data }),
                _ => {}
            }
            Some(out)
        })
        .take(1024)
        .collect()
}

fn pack_ref(v: Option<&Value>) -> Option<PackRef> {
    let p = v?.as_object()?;
    Some(PackRef {
        file_id: s(p, "file_id").to_string(),
        name: s(p, "name").to_string(),
        count: u32c(u(p, "count")),
        key: b64(s(p, "key")).unwrap_or_default(),
        nonce: b64(s(p, "nonce")).unwrap_or_default(),
        // v1 качает наборы по гранту/публично — capability нет.
        capability: Vec::new(),
    })
}

fn caption(m: &Map<String, Value>) -> String {
    // D-5: отсутствует / null / "" — «нет подписи».
    s(m, "caption").to_string()
}

fn media(m: &Map<String, Value>, kind: MediaKind) -> Media {
    let width = u32c(u(m, "width"));
    let mut height = u32c(u(m, "height"));
    if kind == MediaKind::VideoNote && height == 0 {
        height = width; // D-9
    }
    let waveform = m
        .get("waveform")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).map(|x| x.min(255) as u8).take(256).collect())
        .unwrap_or_default();
    Media {
        kind: kind as i32,
        file_id: s(m, "file_id").to_string(),
        mime: s(m, "mime").to_string(),
        size: u(m, "size_bytes"),
        duration_ms: u32c(u(m, "duration_secs").saturating_mul(1000)),
        width,
        height,
        waveform,
        file_key: b64(s(m, "file_key")).unwrap_or_default(),
        file_nonce: b64(s(m, "file_nonce")).unwrap_or_default(),
        name: s(m, "filename").to_string(),
        caption: caption(m),
        caption_entities: entities(m),
        title: s(m, "audio_title").to_string(),
        performer: s(m, "audio_performer").to_string(),
        ..Default::default()
    }
}

fn poll(m: &Map<String, Value>) -> Poll {
    // D-3: options приоритетнее answers; флаг — OR пары имён.
    let list = m.get("options").and_then(Value::as_array).or_else(|| m.get("answers").and_then(Value::as_array));
    let options = list
        .map(|a| a.iter().filter_map(Value::as_str).take(12).map(|t| PollOption { text: t.to_string() }).collect())
        .unwrap_or_default();
    let flag = |a: &str, bk: &str| b(m, a) || b(m, bk);
    Poll {
        question: s(m, "question").to_string(),
        options,
        is_public: flag("is_public", "public"),
        is_multiple: flag("is_multiple", "multiple"),
        is_quiz: flag("is_quiz", "quiz"),
        correct: indexes(m.get("correct")),
        solution: s(m, "solution").to_string(),
        close_ms: 0,
    }
}

/// D-15: целые ≥ 0, строки-числа допустимы.
fn indexes(v: Option<&Value>) -> Vec<u32> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::Number(n) => n.as_u64(),
                    Value::String(s) => s.trim().parse().ok(),
                    _ => None,
                })
                .map(u32c)
                .take(12)
                .collect()
        })
        .unwrap_or_default()
}

/// Inner content v1 (любой клиент) → v2.
pub fn inner(v: &Value) -> Result<LegacyInner> {
    let m = obj(v)?;
    let kind = match s(m, "kind") {
        "text" => content::Kind::Text(Text {
            text: s(m, "text").to_string(),
            entities: entities(m),
            preview: m.get("webpage").and_then(Value::as_object).map(|w| LinkPreview {
                url: s(w, "url").to_string(),
                site_name: s(w, "site_name").to_string(),
                title: s(w, "title").to_string(),
                description: s(w, "description").to_string(),
                image: None,
            }),
            emoji_packs: m
                .get("emoji_packs")
                .and_then(Value::as_array)
                .map(|a| a.iter().take(4).filter_map(|p| pack_ref(Some(p))).collect())
                .unwrap_or_default(),
        }),
        "photo" => content::Kind::Media(media(m, MediaKind::Photo)),
        "video" => content::Kind::Media(media(m, MediaKind::Video)),
        "voice" => content::Kind::Media(media(m, MediaKind::Voice)),
        "video_note" => content::Kind::Media(media(m, MediaKind::VideoNote)),
        "gif" => content::Kind::Media(media(m, MediaKind::Animation)),
        "file" => {
            // D-8: аудиофайл — kind file с mime audio/*.
            let k = if s(m, "mime").starts_with("audio/") { MediaKind::Audio } else { MediaKind::File };
            content::Kind::Media(media(m, k))
        }
        "sticker" => {
            let pack = m.get("pack_ref").and_then(Value::as_object).map(|p| s(p, "name").to_string()).unwrap_or_default();
            content::Kind::Sticker(Sticker {
                pack,
                sticker_id: s(m, "file_id").to_string(),
                emoji: s(m, "filename").to_string(),
                media: Some(media(m, MediaKind::Photo)),
                pack_ref: pack_ref(m.get("pack_ref")),
            })
        }
        "location" => {
            let f = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let lat = f("lat");
            let long = f("long");
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&long) {
                return Err(ProtoError::InvalidField("location"));
            }
            content::Kind::Location(Location {
                latitude: lat,
                longitude: long,
                accuracy_m: u32c(u(m, "accuracy")),
                live_period_s: u32c(u(m, "live_period")),
                heading: u32c(u(m, "heading")),
                ..Default::default()
            })
        }
        "poll" => content::Kind::Poll(poll(m)),
        "poll_vote" => content::Kind::PollVote(PollVote {
            poll: uuid_ref(s(m, "poll")),
            option_indexes: indexes(m.get("options")),
        }),
        "poll_close" => content::Kind::PollClose(PollClose { poll: uuid_ref(s(m, "poll")) }),
        "skdm" => {
            return Ok(LegacyInner::Skdm {
                group: s(m, "group").to_string(),
                session_key: s(m, "session_key").to_string(),
                sender_identity: s(m, "sender_identity").to_string(),
                epoch: u(m, "epoch"),
            })
        }
        _ => return Ok(LegacyInner::Unknown(v.to_string())),
    };
    let forward = {
        let from = s(m, "forwarded_from");
        let name = s(m, "forwarded_name");
        if from.is_empty() && name.is_empty() {
            None
        } else {
            Some(ForwardInfo {
                from_user: (!from.is_empty()).then(|| UserRef { address: from.to_string() }),
                from_name: name.to_string(),
                original_ts_ms: 0,
            })
        }
    };
    Ok(LegacyInner::Content(Box::new(Content {
        kind: Some(kind),
        ttl_secs: u32c(u(m, "ttl_secs")),
        forward,
        ..Default::default()
    })))
}

/// ICE-кандидат v1 (строка с вложенным JSON) → единый формат CALL-1 (D-21).
pub fn normalize_ice(candidate: &str) -> Result<IceCandidate> {
    let v: Value = serde_json::from_str(candidate).map_err(|_| ProtoError::Malformed)?;
    let m = obj(&v)?;
    let (cand, mid, idx) = if m.contains_key("candidate") {
        (s(m, "candidate"), s(m, "sdpMid"), u(m, "sdpMLineIndex"))
    } else {
        (s(m, "sdp"), s(m, "mid"), u(m, "idx"))
    };
    if cand.len() > 4096 || mid.len() > 64 {
        return Err(ProtoError::FieldLimit("candidate"));
    }
    Ok(IceCandidate { candidate: cand.to_string(), sdp_mid: mid.to_string(), sdp_mline_index: u32c(idx) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content_of(i: LegacyInner) -> Content {
        match i {
            LegacyInner::Content(c) => *c,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn poll_dialects_agree() {
        let web = br#"{"kind":"poll","question":"Q","options":["a","b"],"is_public":true,"is_multiple":true}"#;
        let desk = br#"{"answers":["a","b"],"kind":"poll","multiple":true,"public":true,"question":"Q","quiz":false}"#;
        let andr = br#"{"kind":"poll","question":"Q","options":["a","b"],"is_public":true,"is_multiple":true,"is_quiz":false,"answers":["a","b"],"public":true,"multiple":true,"quiz":false}"#;
        let a = content_of(parse_megolm_plaintext(web).unwrap());
        let b = content_of(parse_megolm_plaintext(desk).unwrap());
        let c = content_of(parse_megolm_plaintext(andr).unwrap());
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn megolm_wrapper_ignores_inner_from() {
        let wrapped = br#"{"from":"mallory@x","content":{"kind":"text","text":"hi"}}"#;
        let bare = br#"{"kind":"text","text":"hi"}"#;
        assert_eq!(parse_megolm_plaintext(wrapped).unwrap(), parse_megolm_plaintext(bare).unwrap());
    }

    #[test]
    fn olm_requires_wrapper() {
        assert!(parse_olm_plaintext(br#"{"kind":"text","text":"hi"}"#).is_err());
        let (from, _) = parse_olm_plaintext(br#"{"content":{"kind":"text","text":"hi"},"from":"alice@x"}"#).unwrap();
        assert_eq!(from, "alice@x");
    }

    #[test]
    fn ice_both_formats() {
        let w = normalize_ice(r#"{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"a"}"#).unwrap();
        let d = normalize_ice(r#"{"idx":0,"mid":"0","sdp":"candidate:1 1 udp 1 1.2.3.4 5 typ host"}"#).unwrap();
        assert_eq!(w, d);
    }
}
