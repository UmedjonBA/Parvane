//! Представления содержимого модели (spec 035 T066, FR-004): перенос смысла web `v2/contentMap.ts` (эталон
//! поведения) со сверкой с desktop `parvane-core/src/v2_content.cpp`.
//!
//! Три слоя:
//! - `Content` протокола → тело строки истории (`MessageRow.body`, JSON формата экспорта привязки
//!   `{"content": <WireMessageContent>, "reply_to"?: uuid}` — тот же, что пишут нынешние клиенты в журнал
//!   истории, HIST-1): [`content_to_wire`] (= `v2ToWire`), класс содержимого [`class_of`] (= `v2Class`,
//!   векторы `content/kinds.json`);
//! - намерение композера `ComposeContent` → `Content` ([`compose_to_content`], = `wireToV2`);
//! - тело строки → `ViewBody` показа ([`wire_to_body`]); вид, которого клиент не объявил в `features`,
//!   отдаётся текстом его поля `text` (FR-004, TASK-1/CLOUD-1/ARTICLE-1).

use base64::Engine as _;
use serde_json::{json, Map, Value};

use crate::error::ProtoError;

use crate::pb::parvane::engine::v1::{
    compose_content, view_body, ComposeContent, ViewArticle, ViewBody, ViewCloudInvite, ViewEntity, ViewLocation,
    ViewMedia, ViewPoll, ViewService, ViewSticker, ViewTaskOffer, ViewText,
};
use crate::pb::parvane::msg::v2::{
    content, Content, Entity, EntityType, Location, Media, MediaKind, MessageRef, Poll, PollOption, ReplyQuote, Sticker, Text,
};

/// Предел статьи при приёме (web `ARTICLE_RECV_MAX_LENGTH`).
const ARTICLE_RECV_MAX: usize = 65536;
/// QUOTE-1: предел цитаты в байтах UTF-8.
const REPLY_QUOTE_MAX_BYTES: usize = 1024;

/// Чем содержимое является для модели (векторы `content/kinds.json`, web `v2Class`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Сообщение чата — строка ленты.
    Message,
    /// Мутация или квитанция (правка, удаление, реакция, закреп, квитанция) — меняет строку.
    Mutation,
    /// Служебное движка (ключи, звонок) — показа нет.
    Service,
    /// Вид, который нельзя показать (неизвестный, пустой, контакт) — заглушка.
    Stub,
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default()
}

/// UUID-строка id сообщения (16 байт) либо hex.
pub fn uuid_of(b: &[u8]) -> String {
    crate::history::uuid_string(b)
}

fn id_of_uuid(s: &str) -> Vec<u8> {
    crate::history::parse_id(s).unwrap_or_default()
}

// ── сущности ────────────────────────────────────────────────────────────────

const ENTITY_NAMES: &[(EntityType, &str)] = &[
    (EntityType::Bold, "bold"),
    (EntityType::Italic, "italic"),
    (EntityType::Underline, "underline"),
    (EntityType::Strike, "strike"),
    (EntityType::Spoiler, "spoiler"),
    (EntityType::Code, "code"),
    (EntityType::Pre, "pre"),
    (EntityType::TextUrl, "text_url"),
    (EntityType::Url, "url"),
    (EntityType::Mention, "mention"),
    (EntityType::Blockquote, "blockquote"),
    (EntityType::CustomEmoji, "custom_emoji"),
];

fn entity_name(t: i32) -> Option<&'static str> {
    ENTITY_NAMES.iter().find(|(e, _)| *e as i32 == t).map(|(_, n)| *n)
}

fn entity_type(name: &str) -> Option<EntityType> {
    ENTITY_NAMES.iter().find(|(_, n)| *n == name).map(|(e, _)| *e)
}

fn entities_to_wire(list: &[Entity]) -> Option<Value> {
    let out: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            let ty = entity_name(e.r#type)?;
            let mut v = json!({"type": ty, "offset": e.offset, "length": e.length});
            let data = [e.url.as_str(), e.language.as_str(), e.custom_emoji_id.as_str()].into_iter().find(|s| !s.is_empty());
            if let Some(d) = data {
                v["data"] = json!(d);
            }
            Some(v)
        })
        .collect();
    (!out.is_empty()).then_some(Value::Array(out))
}

fn entities_from_view(list: &[ViewEntity]) -> Vec<Entity> {
    list.iter()
        .filter_map(|e| {
            let t = entity_type(&e.r#type)?;
            let mut out = Entity { r#type: t as i32, offset: e.offset, length: e.length, ..Default::default() };
            match t {
                EntityType::TextUrl => out.url = e.url.clone(),
                EntityType::Pre => out.language = e.language.clone(),
                EntityType::CustomEmoji => out.custom_emoji_id = e.custom_emoji_id.clone(),
                _ => {}
            }
            Some(out)
        })
        .collect()
}

fn entities_view(v: Option<&Value>) -> Vec<ViewEntity> {
    let Some(Value::Array(a)) = v else { return vec![] };
    a.iter()
        .filter_map(|e| {
            let ty = e.get("type")?.as_str()?.to_string();
            let data = e.get("data").and_then(Value::as_str).unwrap_or("").to_string();
            let mut out = ViewEntity {
                r#type: ty.clone(),
                offset: u32_of(e.get("offset")),
                length: u32_of(e.get("length")),
                ..Default::default()
            };
            match ty.as_str() {
                "text_url" => out.url = data,
                "pre" => out.language = data,
                "custom_emoji" => out.custom_emoji_id = data,
                _ => {}
            }
            Some(out)
        })
        .collect()
}

fn u32_of(v: Option<&Value>) -> u32 {
    v.and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0)
}

fn str_of(m: &Map<String, Value>, k: &str) -> String {
    m.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn bool_of(m: &Map<String, Value>, k: &str) -> bool {
    m.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Удалить пустое (`undefined` web): null, пустые строки, `false`, нули — как `prune` и proto3-умолчания.
fn put(m: &mut Map<String, Value>, k: &str, v: Value) {
    let empty = match &v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::Array(a) => a.is_empty(),
        Value::Object(_) => false,
    };
    if !empty {
        m.insert(k.to_string(), v);
    }
}

fn utf8_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn char_prefix(s: &str, max_units: usize) -> String {
    // web режет `slice(0, N)` по UTF-16; для BMP это символы
    s.chars().take(max_units).collect()
}

fn is_web_url(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    (l.starts_with("https://") || l.starts_with("http://")) && s.len() > l.find("://").unwrap_or(0) + 3
}

// ── медиа ───────────────────────────────────────────────────────────────────

fn media_wire_kind(k: i32) -> &'static str {
    match MediaKind::try_from(k) {
        Ok(MediaKind::Photo) => "photo",
        Ok(MediaKind::Video) => "video",
        Ok(MediaKind::Voice) => "voice",
        Ok(MediaKind::VideoNote) => "video_note",
        Ok(MediaKind::Animation) => "gif",
        _ => "file",
    }
}

fn spoiler_kind(wire_kind: &str) -> bool {
    matches!(wire_kind, "photo" | "video" | "gif")
}

fn media_to_wire(m: &Media) -> Map<String, Value> {
    let kind = media_wire_kind(m.kind);
    let mut o = Map::new();
    o.insert("kind".into(), json!(kind));
    put(&mut o, "file_id", json!(m.file_id));
    put(&mut o, "mime", json!(m.mime));
    if m.size != 0 {
        o.insert("size_bytes".into(), json!(m.size));
    }
    if m.duration_ms != 0 {
        o.insert("duration_secs".into(), json!(((m.duration_ms as f64) / 1000.0).round().max(1.0) as u64));
    }
    put(&mut o, "width", json!(m.width));
    put(&mut o, "height", json!(m.height));
    if !m.waveform.is_empty() {
        o.insert("waveform".into(), json!(m.waveform));
    }
    if !m.file_key.is_empty() {
        o.insert("file_key".into(), json!(b64(&m.file_key)));
    }
    if !m.file_nonce.is_empty() {
        o.insert("file_nonce".into(), json!(b64(&m.file_nonce)));
    }
    put(&mut o, "filename", json!(m.name));
    put(&mut o, "caption", json!(m.caption));
    if let Some(e) = entities_to_wire(&m.caption_entities) {
        o.insert("entities".into(), e);
    }
    put(&mut o, "audio_title", json!(m.title));
    put(&mut o, "audio_performer", json!(m.performer));
    if !m.thumbnail.is_empty() {
        o.insert("thumbnail".into(), json!(b64(&m.thumbnail)));
    }
    if !m.capability.is_empty() {
        o.insert("capability".into(), json!(b64(&m.capability)));
    }
    put(&mut o, "blob_domain", json!(m.blob_domain));
    if m.spoiler && spoiler_kind(kind) {
        o.insert("spoiler".into(), json!(true));
    }
    if !m.album_id.is_empty() {
        o.insert("album_id".into(), json!(b64(&m.album_id)));
    }
    o
}

fn pack_to_wire(p: &crate::pb::parvane::msg::v2::PackRef) -> Option<Value> {
    if p.file_id.is_empty() {
        return None;
    }
    let mut o = Map::new();
    o.insert("file_id".into(), json!(p.file_id));
    o.insert("name".into(), json!(p.name));
    o.insert("count".into(), json!(p.count));
    o.insert("key".into(), json!(b64(&p.key)));
    o.insert("nonce".into(), json!(b64(&p.nonce)));
    if !p.capability.is_empty() {
        o.insert("capability".into(), json!(b64(&p.capability)));
    }
    if !p.content_hash.is_empty() {
        o.insert("content_hash".into(), json!(b64(&p.content_hash)));
    }
    put(&mut o, "blob_domain", json!(p.blob_domain));
    Some(Value::Object(o))
}

/// Класс содержимого (web `v2Class`): мутация, служебное, сообщение либо заглушка.
pub fn class_of(c: &Content) -> Class {
    use content::Kind as K;
    match &c.kind {
        Some(K::Receipt(_) | K::Edit(_) | K::Delete(_) | K::Reaction(_) | K::Pin(_)) => Class::Mutation,
        Some(K::Call(_) | K::GroupKey(_) | K::DeliveryKey(_) | K::ContainerKey(_) | K::StateKey(_) | K::GroupAvatarKey(_)) => {
            Class::Service
        }
        _ => {
            if content_to_wire(c).is_some() {
                Class::Message
            } else {
                Class::Stub
            }
        }
    }
}

/// `Content` → содержимое формата экспорта (web `v2ToWire`); `None` — не сообщение (мутация, служебное,
/// неизвестное, контакт).
pub fn content_to_wire(c: &Content) -> Option<Value> {
    use content::Kind as K;
    let mut o: Map<String, Value> = match c.kind.as_ref()? {
        K::Text(t) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("text"));
            o.insert("text".into(), json!(t.text));
            if let Some(e) = entities_to_wire(&t.entities) {
                o.insert("entities".into(), e);
            }
            if let Some(p) = t.preview.as_ref().filter(|p| !p.url.is_empty() && is_web_url(&p.url)) {
                let mut w = Map::new();
                w.insert("url".into(), json!(p.url));
                put(&mut w, "site_name", json!(p.site_name));
                put(&mut w, "title", json!(p.title));
                put(&mut w, "description", json!(p.description));
                if let Some(img) = p.image.as_ref().filter(|i| !i.file_id.is_empty() && !i.file_key.is_empty() && i.kind == MediaKind::Photo as i32)
                {
                    w.insert("photo".into(), Value::Object(media_to_wire(img)));
                }
                o.insert("webpage".into(), Value::Object(w));
            }
            let packs: Vec<Value> = t.emoji_packs.iter().filter_map(pack_to_wire).collect();
            put(&mut o, "emoji_packs", Value::Array(packs));
            o
        }
        K::Media(m) => media_to_wire(m),
        K::Sticker(s) => {
            let mut o = match &s.media {
                Some(m) => media_to_wire(m),
                None => {
                    let mut o = Map::new();
                    o.insert("kind".into(), json!("photo"));
                    o
                }
            };
            o.insert("kind".into(), json!("sticker"));
            if !s.emoji.is_empty() {
                o.insert("filename".into(), json!(s.emoji));
            }
            if let Some(p) = s.pack_ref.as_ref().and_then(pack_to_wire) {
                o.insert("pack_ref".into(), p);
            }
            // FR-075: id стикера в наборе (web `v2ToWire`)
            put(&mut o, "sticker_id", json!(s.sticker_id));
            o
        }
        K::Location(l) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("location"));
            o.insert("lat".into(), json!(l.latitude));
            o.insert("long".into(), json!(l.longitude));
            put(&mut o, "live_period", json!(l.live_period_s));
            put(&mut o, "heading", json!(l.heading));
            put(&mut o, "accuracy", json!(l.accuracy_m));
            o
        }
        K::Poll(p) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("poll"));
            o.insert("question".into(), json!(p.question));
            o.insert("options".into(), json!(p.options.iter().map(|x| x.text.clone()).collect::<Vec<_>>()));
            put(&mut o, "is_public", json!(p.is_public));
            put(&mut o, "is_multiple", json!(p.is_multiple));
            put(&mut o, "is_quiz", json!(p.is_quiz));
            if !p.correct.is_empty() {
                o.insert("correct".into(), json!(p.correct));
            }
            put(&mut o, "solution", json!(p.solution));
            put(&mut o, "close_ms", json!(p.close_ms));
            put(&mut o, "no_revote", json!(p.no_revote));
            put(&mut o, "shuffle", json!(p.shuffle));
            put(&mut o, "hide_results", json!(p.hide_results));
            o
        }
        K::PollVote(v) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("poll_vote"));
            if let Some(r) = v.poll.as_ref().filter(|r| r.op_id.len() == 16) {
                o.insert("poll".into(), json!(uuid_of(&r.op_id)));
            }
            o.insert("options".into(), json!(v.option_indexes));
            if v.tally {
                o.insert("tally".into(), json!(true));
                o.insert("counts".into(), json!(v.counts));
                o.insert("voters".into(), json!(v.voters));
            }
            o
        }
        K::PollClose(p) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("poll_close"));
            if let Some(r) = p.poll.as_ref().filter(|r| r.op_id.len() == 16) {
                o.insert("poll".into(), json!(uuid_of(&r.op_id)));
            }
            o
        }
        K::ChatMode(m) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("chat_mode"));
            o.insert("l2".into(), json!(m.l2));
            o
        }
        K::TaskOffer(t) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("task_offer"));
            o.insert("name".into(), json!(t.name));
            put(&mut o, "description", json!(t.description));
            let steps: Vec<Value> = t.steps.iter().filter(|s| !s.text.is_empty()).map(|s| json!(s.text)).collect();
            if !t.steps.is_empty() {
                o.insert("steps".into(), Value::Array(steps));
            }
            put(&mut o, "day", json!(t.day));
            put(&mut o, "start", json!(t.start));
            put(&mut o, "minutes", json!(t.minutes));
            put(&mut o, "due", json!(t.due));
            put(&mut o, "text", json!(t.text));
            o
        }
        K::CloudInvite(ci) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("cloud_invite"));
            if let Some(r) = ci.container.as_ref().filter(|r| !r.id.is_empty()) {
                o.insert("container".into(), json!({"domain": r.domain, "id": b64(&r.id)}));
            }
            o.insert("name".into(), json!(ci.name));
            put(&mut o, "role", json!(ci.role));
            put(&mut o, "text", json!(ci.text));
            o
        }
        K::MusicTrack(t) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("music_track"));
            o.insert("track_id".into(), json!(t.track_id));
            put(&mut o, "track_server", json!(t.server));
            o.insert("title".into(), json!(char_prefix(&t.title, 600)));
            put(&mut o, "artist", json!(char_prefix(&t.artist, 600)));
            put(&mut o, "duration_secs", json!(t.duration_secs));
            put(&mut o, "text", json!(char_prefix(&t.text, 600)));
            o
        }
        K::Article(a) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("article"));
            o.insert("title".into(), json!(char_prefix(&a.title, ARTICLE_RECV_MAX)));
            o.insert("markdown".into(), json!(char_prefix(&a.markdown, ARTICLE_RECV_MAX)));
            put(&mut o, "text", json!(char_prefix(&a.text, ARTICLE_RECV_MAX)));
            if !a.media.is_empty() {
                o.insert("article_media".into(), Value::Array(a.media.iter().map(|m| Value::Object(media_to_wire(m))).collect()));
            }
            o
        }
        K::ModReport(r) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("mod_report"));
            if let Some(g) = r.group.as_ref().filter(|g| !g.id.is_empty()) {
                o.insert("report_group".into(), json!({"domain": g.domain, "id": b64(&g.id)}));
            }
            put(&mut o, "reason", json!(r.reason));
            put(&mut o, "comment", json!(r.comment));
            put(&mut o, "text", json!(r.text));
            let reported: Vec<Value> = r
                .messages
                .iter()
                .filter_map(|m| {
                    let author = m.author.as_ref().map(|a| a.address.clone()).unwrap_or_default();
                    if m.op_id.len() != 16 || author.is_empty() {
                        return None;
                    }
                    let mut x = Map::new();
                    x.insert("op_id".into(), json!(uuid_of(&m.op_id)));
                    x.insert("author".into(), json!(author));
                    x.insert("text".into(), json!(m.text));
                    x.insert("ts".into(), json!(m.ts_ms.div_euclid(1000)));
                    if !m.proof.is_empty() {
                        x.insert("proof".into(), json!(b64(&m.proof)));
                    }
                    Some(Value::Object(x))
                })
                .collect();
            o.insert("reported".into(), Value::Array(reported));
            o
        }
        K::TaskResponse(t) => {
            let mut o = Map::new();
            o.insert("kind".into(), json!("task_response"));
            if let Some(r) = t.offer.as_ref().filter(|r| r.op_id.len() == 16) {
                o.insert("offer".into(), json!(uuid_of(&r.op_id)));
            }
            o.insert("accepted".into(), json!(t.decision == crate::pb::parvane::msg::v2::TaskDecision::Accepted as i32));
            put(&mut o, "text", json!(t.text));
            o
        }
        // Контакт web не показывает (заглушка, векторы content/kinds.json); мутации и служебное — не сообщения
        _ => return None,
    };
    put(&mut o, "ttl_secs", json!(c.ttl_secs));
    put(&mut o, "silent", json!(c.silent));
    put(&mut o, "invert_media", json!(c.invert_media));
    if let (Some(_), Some(q)) = (&c.reply_to, c.reply_quote.as_ref().filter(|q| !q.text.is_empty())) {
        let mut x = Map::new();
        x.insert("text".into(), json!(utf8_prefix(&q.text, REPLY_QUOTE_MAX_BYTES)));
        if let Some(e) = entities_to_wire(&q.entities) {
            x.insert("entities".into(), e);
        }
        put(&mut x, "offset", json!(q.offset));
        o.insert("reply_quote".into(), Value::Object(x));
    }
    if let Some(f) = &c.forward {
        if let Some(u) = f.from_user.as_ref().filter(|u| !u.address.is_empty()) {
            o.insert("forwarded_from".into(), json!(u.address));
        }
        put(&mut o, "forwarded_name", json!(f.from_name));
    }
    Some(Value::Object(o))
}

// ── формат экспорта → Content (web `wireToV2`, spec 035 T114) ─────────────────

/// Значение есть и «истинно» по правилам JS (`x || undefined`): не null, не пустая строка, не `false`, не 0.
fn truthy(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    })
}

/// Вставить поле, если значение «истинно» (proto3 по умолчанию — то же отсутствие поля).
fn set(o: &mut Map<String, Value>, k: &str, v: Option<&Value>) {
    if let Some(v) = truthy(v) {
        o.insert(k.to_string(), v.clone());
    }
}

fn ref_of_uuid(s: &str) -> Value {
    json!({"op_id": b64(&id_of_uuid(s))})
}

fn entities_to_v2(list: Option<&Value>) -> Option<Value> {
    let Some(Value::Array(a)) = list else { return None };
    if a.is_empty() {
        return None;
    }
    let out: Vec<Value> = a
        .iter()
        .filter_map(|e| {
            let name = e.get("type")?.as_str()?;
            let t = entity_type(name)?;
            let mut o = Map::new();
            o.insert("type".into(), json!(t.as_str_name()));
            o.insert("offset".into(), e.get("offset").cloned().unwrap_or(json!(0)));
            o.insert("length".into(), e.get("length").cloned().unwrap_or(json!(0)));
            let data = e.get("data");
            match t {
                EntityType::TextUrl => set(&mut o, "url", data),
                EntityType::Pre => set(&mut o, "language", data),
                EntityType::CustomEmoji => set(&mut o, "custom_emoji_id", data),
                _ => {}
            }
            Some(Value::Object(o))
        })
        .collect();
    Some(Value::Array(out))
}

fn pack_to_v2(p: &Value) -> Option<Value> {
    let p = p.as_object()?;
    let mut o = Map::new();
    for k in ["file_id", "name", "count", "key", "nonce", "capability", "content_hash", "blob_domain"] {
        set(&mut o, k, p.get(k));
    }
    Some(Value::Object(o))
}

fn wave_to_b64(w: Option<&Value>) -> Option<Value> {
    let Some(Value::Array(a)) = w else { return None };
    if a.is_empty() {
        return None;
    }
    let bytes: Vec<u8> = a.iter().map(|x| x.as_f64().unwrap_or(0.0).clamp(0.0, 255.0) as u8).collect();
    Some(json!(b64(&bytes)))
}

fn media_kind_v2(wire_kind: &str, mime: &str) -> &'static str {
    match wire_kind {
        "file" if mime.starts_with("audio/") => "MEDIA_KIND_AUDIO",
        "photo" => "MEDIA_KIND_PHOTO",
        "video" => "MEDIA_KIND_VIDEO",
        "voice" => "MEDIA_KIND_VOICE",
        "video_note" => "MEDIA_KIND_VIDEO_NOTE",
        "gif" => "MEDIA_KIND_ANIMATION",
        _ => "MEDIA_KIND_FILE",
    }
}

fn media_to_v2(c: &Map<String, Value>, kind: &str) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("kind".into(), json!(media_kind_v2(kind, &str_of(c, "mime"))));
    set(&mut o, "file_id", c.get("file_id"));
    set(&mut o, "mime", c.get("mime"));
    if let Some(n) = c.get("size_bytes").and_then(Value::as_f64) {
        set(&mut o, "size", Some(&json!((n as u64).to_string())).filter(|_| n != 0.0));
    }
    if let Some(d) = c.get("duration_secs").and_then(Value::as_f64) {
        set(&mut o, "duration_ms", Some(&json!((d * 1000.0).round() as u64)));
    }
    set(&mut o, "width", c.get("width"));
    set(&mut o, "height", c.get("height"));
    set(&mut o, "waveform", wave_to_b64(c.get("waveform")).as_ref());
    set(&mut o, "file_key", c.get("file_key"));
    set(&mut o, "file_nonce", c.get("file_nonce"));
    set(&mut o, "name", c.get("filename"));
    set(&mut o, "caption", c.get("caption"));
    set(&mut o, "caption_entities", entities_to_v2(c.get("entities")).as_ref());
    set(&mut o, "blob_domain", c.get("blob_domain"));
    set(&mut o, "title", c.get("audio_title"));
    set(&mut o, "performer", c.get("audio_performer"));
    set(&mut o, "thumbnail", c.get("thumbnail"));
    set(&mut o, "capability", c.get("capability"));
    // MEDIA-2: спойлер и альбом — только у фото/видео/GIF/файлов (не у голосовых и кружков)
    if bool_of(c, "spoiler") && spoiler_kind(kind) {
        o.insert("spoiler".into(), json!(true));
    }
    set(&mut o, "album_id", c.get("album_id"));
    o
}

fn texts(v: Option<&Value>) -> Option<Value> {
    let Some(Value::Array(a)) = v else { return None };
    Some(Value::Array(a.iter().map(|t| json!({"text": t})).collect()))
}

/// Содержимое формата экспорта (внутреннее содержимое web `WireMessageContent`) → `Content` (proto3-JSON того же
/// вида, что строил web `wireToV2`; `reply_to` — UUID ответа). Неизвестный вид — `InvalidField("kind")`.
pub fn wire_to_content_json(c: &Map<String, Value>, reply_to: Option<&str>) -> Result<Value, ProtoError> {
    let kind = str_of(c, "kind");
    let mut out = Map::new();
    let inner = match kind.as_str() {
        "text" => {
            let mut t = Map::new();
            t.insert("text".into(), json!(str_of(c, "text")));
            set(&mut t, "entities", entities_to_v2(c.get("entities")).as_ref());
            if let Some(Value::Object(w)) = c.get("webpage") {
                let mut p = Map::new();
                for k in ["url", "site_name", "title", "description"] {
                    set(&mut p, k, w.get(k));
                }
                if let Some(Value::Object(ph)) = w.get("photo") {
                    p.insert("image".into(), Value::Object(media_to_v2(ph, &str_of(ph, "kind"))));
                }
                t.insert("preview".into(), Value::Object(p));
            }
            if let Some(Value::Array(packs)) = c.get("emoji_packs") {
                t.insert("emoji_packs".into(), Value::Array(packs.iter().filter_map(pack_to_v2).collect()));
            }
            ("text", Value::Object(t))
        }
        "photo" | "video" | "voice" | "video_note" | "gif" | "file" => ("media", Value::Object(media_to_v2(c, &kind))),
        "sticker" => {
            let mut s = Map::new();
            let pack = c.get("pack_ref").and_then(Value::as_object);
            set(&mut s, "pack", pack.and_then(|p| p.get("name")));
            // FR-075: id стикера в наборе (не file_id загрузки); стикер без набора — пусто
            set(&mut s, "sticker_id", c.get("sticker_id"));
            set(&mut s, "emoji", c.get("filename"));
            let mut m = media_to_v2(c, "photo");
            m.remove("caption");
            s.insert("media".into(), Value::Object(m));
            if let Some(p) = c.get("pack_ref").and_then(pack_to_v2) {
                s.insert("pack_ref".into(), p);
            }
            ("sticker", Value::Object(s))
        }
        "location" => {
            let mut l = Map::new();
            set(&mut l, "latitude", c.get("lat"));
            set(&mut l, "longitude", c.get("long"));
            set(&mut l, "live_period_s", c.get("live_period"));
            set(&mut l, "heading", c.get("heading"));
            set(&mut l, "accuracy_m", c.get("accuracy"));
            ("location", Value::Object(l))
        }
        "poll" => {
            let mut p = Map::new();
            set(&mut p, "question", c.get("question"));
            set(&mut p, "options", texts(c.get("options")).as_ref());
            for k in ["is_public", "is_multiple", "is_quiz", "correct", "solution", "no_revote", "shuffle", "hide_results"] {
                set(&mut p, k, c.get(k));
            }
            if let Some(ms) = truthy(c.get("close_ms")).and_then(Value::as_f64) {
                p.insert("close_ms".into(), json!((ms as i64).to_string()));
            }
            ("poll", Value::Object(p))
        }
        "poll_vote" => {
            let mut v = Map::new();
            if let Some(p) = truthy(c.get("poll")).and_then(Value::as_str) {
                v.insert("poll".into(), ref_of_uuid(p));
            }
            set(&mut v, "option_indexes", c.get("options"));
            // POLL-1: итоги анонимного опроса от автора
            if truthy(c.get("tally")).is_some() {
                v.insert("tally".into(), json!(true));
                v.insert("counts".into(), c.get("counts").cloned().filter(|x| !x.is_null()).unwrap_or(json!([])));
                set(&mut v, "voters", c.get("voters"));
            }
            ("poll_vote", Value::Object(v))
        }
        "poll_close" => {
            let mut v = Map::new();
            if let Some(p) = truthy(c.get("poll")).and_then(Value::as_str) {
                v.insert("poll".into(), ref_of_uuid(p));
            }
            ("poll_close", Value::Object(v))
        }
        "task_offer" => {
            let mut t = Map::new();
            set(&mut t, "name", c.get("name"));
            for k in ["description", "day", "start", "minutes", "due", "text"] {
                set(&mut t, k, c.get(k));
            }
            set(&mut t, "steps", texts(c.get("steps")).as_ref());
            ("task_offer", Value::Object(t))
        }
        "cloud_invite" => {
            let mut t = Map::new();
            set(&mut t, "container", c.get("container"));
            for k in ["name", "role", "text"] {
                set(&mut t, k, c.get(k));
            }
            ("cloud_invite", Value::Object(t))
        }
        "mod_report" => {
            let mut r = Map::new();
            set(&mut r, "group", c.get("report_group"));
            for k in ["reason", "comment", "text"] {
                set(&mut r, k, c.get(k));
            }
            if let Some(Value::Array(list)) = c.get("reported") {
                let messages: Vec<Value> = list
                    .iter()
                    .filter_map(Value::as_object)
                    .map(|m| {
                        let mut x = Map::new();
                        x.insert("op_id".into(), json!(b64(&id_of_uuid(&str_of(m, "op_id")))));
                        x.insert("author".into(), json!({"address": str_of(m, "author")}));
                        set(&mut x, "text", m.get("text"));
                        let ts = m.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
                        x.insert("ts_ms".into(), json!(((ts * 1000.0) as i64).to_string()));
                        set(&mut x, "proof", m.get("proof"));
                        Value::Object(x)
                    })
                    .collect();
                r.insert("messages".into(), Value::Array(messages));
            }
            ("mod_report", Value::Object(r))
        }
        "music_track" => {
            let mut t = Map::new();
            set(&mut t, "track_id", c.get("track_id"));
            set(&mut t, "server", c.get("track_server"));
            for k in ["title", "artist", "duration_secs", "text"] {
                set(&mut t, k, c.get(k));
            }
            ("music_track", Value::Object(t))
        }
        "article" => {
            let mut a = Map::new();
            for k in ["title", "markdown", "text"] {
                set(&mut a, k, c.get(k));
            }
            if let Some(Value::Array(media)) = c.get("article_media") {
                if !media.is_empty() {
                    let list = media.iter().filter_map(Value::as_object).map(|m| Value::Object(media_to_v2(m, &str_of(m, "kind"))));
                    a.insert("media".into(), Value::Array(list.collect()));
                }
            }
            ("article", Value::Object(a))
        }
        "task_response" => {
            let mut t = Map::new();
            if let Some(o) = truthy(c.get("offer")).and_then(Value::as_str) {
                t.insert("offer".into(), ref_of_uuid(o));
            }
            let accepted = truthy(c.get("accepted")).is_some();
            t.insert("decision".into(), json!(if accepted { "TASK_DECISION_ACCEPTED" } else { "TASK_DECISION_DECLINED" }));
            set(&mut t, "text", c.get("text"));
            ("task_response", Value::Object(t))
        }
        _ => return Err(ProtoError::InvalidField("kind")),
    };
    out.insert(inner.0.into(), inner.1);
    set(&mut out, "ttl_secs", c.get("ttl_secs"));
    if truthy(c.get("silent")).is_some() {
        out.insert("silent".into(), json!(true));
    }
    if truthy(c.get("invert_media")).is_some() {
        out.insert("invert_media".into(), json!(true));
    }
    if let Some(r) = reply_to.filter(|r| !r.is_empty()) {
        out.insert("reply_to".into(), ref_of_uuid(r));
        // QUOTE-1: цитата — только вместе с ответом
        let q = c.get("reply_quote").and_then(Value::as_object);
        let quote = utf8_prefix(q.and_then(|q| q.get("text")).and_then(Value::as_str).unwrap_or(""), REPLY_QUOTE_MAX_BYTES);
        if let (false, Some(q)) = (quote.is_empty(), q) {
            let len = quote.encode_utf16().count() as f64;
            let fits: Vec<Value> = match q.get("entities") {
                Some(Value::Array(a)) => a
                    .iter()
                    .filter(|e| {
                        let off = e.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
                        let l = e.get("length").and_then(Value::as_f64).unwrap_or(0.0);
                        off + l <= len
                    })
                    .cloned()
                    .collect(),
                _ => vec![],
            };
            let mut x = Map::new();
            x.insert("text".into(), json!(quote));
            set(&mut x, "entities", entities_to_v2(Some(&Value::Array(fits))).as_ref());
            set(&mut x, "offset", q.get("offset"));
            out.insert("reply_quote".into(), Value::Object(x));
        }
    }
    let (from, name) = (truthy(c.get("forwarded_from")), truthy(c.get("forwarded_name")));
    if from.is_some() || name.is_some() {
        let mut f = Map::new();
        if let Some(a) = from {
            f.insert("from_user".into(), json!({"address": a}));
        }
        set(&mut f, "from_name", name);
        out.insert("forward".into(), Value::Object(f));
    }
    Ok(Value::Object(out))
}

/// То же, разобранным `Content` (proto3-JSON проверяется схемой).
pub fn wire_to_content(c: &Map<String, Value>, reply_to: Option<&str>) -> Result<Content, ProtoError> {
    serde_json::from_value(wire_to_content_json(c, reply_to)?).map_err(|_| ProtoError::Malformed)
}

fn uuid16(r: Option<&MessageRef>) -> Option<String> {
    r.filter(|r| r.op_id.len() == 16).map(|r| uuid_of(&r.op_id))
}

/// Что содержимое значит для клиента (spec 035 T114, ENGINE-1): класс, содержимое строки формата экспорта
/// (сообщение), ответ и разобранная мутация — клиенты больше не разбирают виды сами. JSON:
/// `{"class": "message"|"mutation"|"service"|"stub", "wire"?, "replyTo"?, "mutation"?: {"kind": "edit", "target",
/// "patch": {text?, entities?, webpage?, fields?}} | {"kind": "delete", "targets", "forEveryone"} | {"kind":
/// "reaction", "target", "emoji"} | {"kind": "pin", "target", "pinned"} | {"kind": "receipt", "read", "targets"}}`.
pub fn content_view(c: &Content) -> Value {
    use content::Kind as K;
    let class = match class_of(c) {
        Class::Message => "message",
        Class::Mutation => "mutation",
        Class::Service => "service",
        Class::Stub => "stub",
    };
    let mut o = Map::new();
    o.insert("class".into(), json!(class));
    if let Some(w) = content_to_wire(c) {
        o.insert("wire".into(), w);
    }
    if let Some(r) = uuid16(c.reply_to.as_ref()) {
        o.insert("replyTo".into(), json!(r));
    }
    let targets = |list: &[MessageRef]| -> Value { Value::Array(list.iter().filter_map(|r| uuid16(Some(r))).map(Value::String).collect()) };
    let mutation = match &c.kind {
        Some(K::Edit(e)) => {
            let mut patch = Map::new();
            if let Some(t) = &e.text {
                let only = Content { kind: Some(K::Text(t.clone())), ..Default::default() };
                if let Some(Value::Object(w)) = content_to_wire(&only) {
                    for k in ["text", "entities", "webpage"] {
                        if let Some(v) = w.get(k) {
                            patch.insert(k.into(), v.clone());
                        }
                    }
                }
            }
            if let Some(l) = &e.location {
                let only = Content { kind: Some(K::Location(l.clone())), ..Default::default() };
                if let Some(w) = content_to_wire(&only) {
                    patch.insert("fields".into(), w);
                }
            }
            uuid16(e.target.as_ref()).map(|t| json!({"kind": "edit", "target": t, "patch": patch}))
        }
        Some(K::Delete(d)) => Some(json!({"kind": "delete", "targets": targets(&d.targets), "forEveryone": d.for_everyone})),
        Some(K::Reaction(r)) => {
            let emoji = if r.remove { "" } else { r.emoji.as_str() };
            uuid16(r.target.as_ref()).map(|t| json!({"kind": "reaction", "target": t, "emoji": emoji}))
        }
        Some(K::Pin(p)) => uuid16(p.target.as_ref()).map(|t| json!({"kind": "pin", "target": t, "pinned": !p.unpin})),
        Some(K::Receipt(r)) => Some(json!({
            "kind": "receipt",
            "read": r.kind == crate::pb::parvane::msg::v2::ReceiptKind::Read as i32,
            "targets": targets(&r.messages),
        })),
        _ => None,
    };
    if let Some(m) = mutation {
        o.insert("mutation".into(), m);
    }
    Value::Object(o)
}

/// Тело строки истории: `{"content": …, "reply_to"?: uuid}` (ключи по алфавиту — каноничный JSON).
pub fn row_body(wire: Value, reply_to: Option<&[u8]>) -> Vec<u8> {
    let mut m = Map::new();
    m.insert("content".into(), wire);
    if let Some(r) = reply_to.filter(|r| r.len() == 16) {
        m.insert("reply_to".into(), json!(uuid_of(r)));
    }
    serde_json::to_vec(&crate::history::sorted_json(Value::Object(m))).unwrap_or_default()
}

/// Тело строки с доказательством автора (`proof`, base64) — как строка хоста web.
pub fn row_body_proof(wire: Value, reply_to: Option<&[u8]>, proof: &[u8]) -> Vec<u8> {
    if proof.is_empty() {
        return row_body(wire, reply_to);
    }
    let mut m = Map::new();
    m.insert("content".into(), wire);
    if let Some(r) = reply_to.filter(|r| r.len() == 16) {
        m.insert("reply_to".into(), json!(uuid_of(r)));
    }
    m.insert("proof".into(), json!(b64(proof)));
    serde_json::to_vec(&crate::history::sorted_json(Value::Object(m))).unwrap_or_default()
}

/// Тело заглушки (неизвестный вид): web хранит `{"kind":"unsupported"}`; критичность — отдельным признаком.
pub fn stub_body(critical: bool) -> Vec<u8> {
    let mut c = json!({"kind": "unsupported"});
    if critical {
        c["critical"] = json!(true);
    }
    row_body(c, None)
}

/// Тело правки (web `EditPatch`): текст правки известной строки — `edit_patch.text`, геопозиция — `fields`.
pub fn edit_body(e: &crate::pb::parvane::msg::v2::Edit) -> Vec<u8> {
    let mut patch = Map::new();
    if let Some(t) = &e.text {
        patch.insert("text".into(), json!(t.text));
        if let Some(en) = entities_to_wire(&t.entities) {
            patch.insert("entities".into(), en);
        }
    }
    if let Some(l) = &e.location {
        let mut f = Map::new();
        f.insert("lat".into(), json!(l.latitude));
        f.insert("long".into(), json!(l.longitude));
        put(&mut f, "live_period", json!(l.live_period_s));
        put(&mut f, "heading", json!(l.heading));
        put(&mut f, "accuracy", json!(l.accuracy_m));
        patch.insert("fields".into(), Value::Object(f));
    }
    serde_json::to_vec(&crate::history::sorted_json(json!({"edit_patch": Value::Object(patch)}))).unwrap_or_default()
}

/// Содержимое строки с наложенной правкой (web `applyEditPatch`) — JSON-объект содержимого.
pub fn effective_content(body: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut c = body.get("content")?.as_object()?.clone();
    if let Some(Value::Object(p)) = body.get("edit_patch") {
        if let Some(t) = p.get("text") {
            if c.get("kind").and_then(Value::as_str) == Some("text") {
                c.insert("text".into(), t.clone());
                match p.get("entities") {
                    Some(e) => c.insert("entities".into(), e.clone()),
                    None => c.remove("entities"),
                };
                c.remove("webpage");
                if let Some(wp) = p.get("webpage").filter(|w| !w.is_null()) {
                    c.insert("webpage".into(), wp.clone());
                }
            } else {
                c.insert("caption".into(), t.clone());
                match p.get("entities") {
                    Some(e) => c.insert("entities".into(), e.clone()),
                    None => c.remove("entities"),
                };
            }
        }
        if let Some(Value::Object(f)) = p.get("fields") {
            for (k, v) in f {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    Some(c)
}

/// Строка в виде содержимого хоста (возможность `wire_rows`, spec 035 T114): тело строки с наложенной правкой —
/// `{content, reply_to?, proof?, …прочие поля тела, reactors?: [{user, emoji, ts}]}`; невидимая строка — `None`.
pub fn wire_row(s: &crate::pb::parvane::history::v1::RowState) -> Option<Value> {
    let body = crate::history::view_body(s)?;
    let content = effective_content(&body)?;
    let mut out: Map<String, Value> = body.into_iter().filter(|(k, _)| k != "content" && k != "edit_patch").collect();
    out.insert("content".into(), Value::Object(content));
    let reactors: Vec<Value> = s
        .reacts
        .iter()
        .filter(|r| !r.emoji.is_empty())
        .map(|r| json!({"user": r.user, "emoji": r.emoji, "ts": r.stamp.as_ref().map(|st| st.ts_ms.div_euclid(1000)).unwrap_or(0)}))
        .collect();
    if !reactors.is_empty() {
        out.insert("reactors".into(), Value::Array(reactors));
    }
    Some(Value::Object(out))
}

// ── показ ───────────────────────────────────────────────────────────────────

fn view_media(c: &Map<String, Value>) -> ViewMedia {
    let wire = str_of(c, "kind");
    let mime = str_of(c, "mime");
    let kind = match wire.as_str() {
        "video_note" => "round".to_string(),
        "file" if mime.starts_with("audio/") => "audio".to_string(),
        "sticker" => "photo".to_string(),
        k => k.to_string(),
    };
    let caption = str_of(c, "caption");
    ViewMedia {
        kind,
        file_id: str_of(c, "file_id"),
        blob_domain: str_of(c, "blob_domain"),
        key: unb64(&str_of(c, "file_key")),
        nonce: unb64(&str_of(c, "file_nonce")),
        capability: unb64(&str_of(c, "capability")),
        mime,
        name: str_of(c, "filename"),
        size: c.get("size_bytes").and_then(Value::as_u64).unwrap_or(0),
        width: u32_of(c.get("width")),
        height: u32_of(c.get("height")),
        duration_s: u32_of(c.get("duration_secs")),
        thumb: unb64(&str_of(c, "thumbnail")),
        caption: (!caption.is_empty()).then(|| ViewText { text: caption, entities: entities_view(c.get("entities")) }),
        spoiler: bool_of(c, "spoiler"),
        caption_above: bool_of(c, "invert_media"),
        waveform: match c.get("waveform") {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_u64).map(|x| x.min(255) as u8).collect(),
            _ => vec![],
        },
        album_id: unb64(&str_of(c, "album_id")),
        title: str_of(c, "audio_title"),
        performer: str_of(c, "audio_performer"),
    }
}

fn text_body(text: String) -> ViewBody {
    ViewBody { kind: Some(view_body::Kind::Text(ViewText { text, entities: vec![] })) }
}

/// Тело строки → вид показа. `features` — возможности интерфейса устройства: вид без возможности — его `text`.
pub fn wire_to_body(c: &Map<String, Value>, has: &dyn Fn(&str) -> bool) -> Option<ViewBody> {
    use view_body::Kind as V;
    let kind = str_of(c, "kind");
    let k = match kind.as_str() {
        "text" => V::Text(ViewText { text: str_of(c, "text"), entities: entities_view(c.get("entities")) }),
        "photo" | "video" | "voice" | "video_note" | "gif" | "file" => V::Media(view_media(c)),
        "sticker" => {
            let pack = c.get("pack_ref").and_then(Value::as_object).map(|p| str_of(p, "name")).unwrap_or_default();
            V::Sticker(ViewSticker { pack, sticker_id: str_of(c, "sticker_id"), emoji: str_of(c, "filename"), media: Some(view_media(c)) })
        }
        "location" => V::Location(ViewLocation {
            lat: c.get("lat").and_then(Value::as_f64).unwrap_or(0.0),
            lon: c.get("long").and_then(Value::as_f64).unwrap_or(0.0),
            title: str_of(c, "title"),
        }),
        "poll" => V::Poll(ViewPoll {
            question: str_of(c, "question"),
            options: match c.get("options") {
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                _ => vec![],
            },
            multiple: bool_of(c, "is_multiple"),
            quiz: bool_of(c, "is_quiz"),
            my_votes: vec![],
            votes: vec![],
        }),
        "task_offer" if has("task_offer") => V::TaskOffer(ViewTaskOffer {
            title: str_of(c, "name"),
            text: str_of(c, "description"),
            task_id: vec![],
        }),
        "cloud_invite" if has("cloud_invite") => V::CloudInvite(ViewCloudInvite {
            title: str_of(c, "name"),
            owner: String::new(),
            role: match c.get("role").and_then(Value::as_u64) {
                Some(2) => "editor".into(),
                _ => "reader".into(),
            },
        }),
        "article" if has("article") => V::Article(ViewArticle { title: str_of(c, "title"), markdown: str_of(c, "markdown") }),
        // Без возможности — текст для клиентов без раздела (TASK-1, CLOUD-1, ARTICLE-1); жалоба — текстом
        // Трек «Музыки» (TRACK-1): клиентам без раздела — текстом; свой вид показа появится вместе с «Музыкой» там
        "task_offer" | "cloud_invite" | "article" | "mod_report" | "music_track" => return Some(text_body(str_of(c, "text"))),
        "task_response" => V::Service(ViewService {
            kind: if bool_of(c, "accepted") { "task_accepted".into() } else { "task_declined".into() },
            text: str_of(c, "text"),
            ..Default::default()
        }),
        "chat_mode" => V::Service(ViewService {
            kind: if bool_of(c, "l2") { "chat_mode_l2_on".into() } else { "chat_mode_l2_off".into() },
            ..Default::default()
        }),
        _ => return None,
    };
    Some(ViewBody { kind: Some(k) })
}

// ── композер ────────────────────────────────────────────────────────────────

fn media_from_view(m: &ViewMedia) -> Media {
    let kind = match m.kind.as_str() {
        "photo" => MediaKind::Photo,
        "video" => MediaKind::Video,
        "voice" => MediaKind::Voice,
        "round" => MediaKind::VideoNote,
        "gif" => MediaKind::Animation,
        "audio" => MediaKind::Audio,
        _ => MediaKind::File,
    };
    let (caption, caption_entities) = match &m.caption {
        Some(t) => (t.text.clone(), entities_from_view(&t.entities)),
        None => (String::new(), vec![]),
    };
    Media {
        kind: kind as i32,
        file_id: m.file_id.clone(),
        mime: m.mime.clone(),
        size: m.size,
        duration_ms: m.duration_s.saturating_mul(1000),
        width: m.width,
        height: m.height,
        waveform: m.waveform.clone(),
        file_key: m.key.clone(),
        file_nonce: m.nonce.clone(),
        name: m.name.clone(),
        caption,
        caption_entities,
        thumbnail: m.thumb.clone(),
        // MEDIA-2: спойлер — только у фото, видео и GIF
        spoiler: m.spoiler && matches!(kind, MediaKind::Photo | MediaKind::Video | MediaKind::Animation),
        album_id: m.album_id.clone(),
        title: m.title.clone(),
        performer: m.performer.clone(),
        capability: m.capability.clone(),
        blob_domain: m.blob_domain.clone(),
    }
}

/// Намерение композера → `Content` (web `wireToV2`). `None` — пустое намерение.
pub fn compose_to_content(cc: &ComposeContent, reply_quote: Option<&ViewText>) -> Option<Content> {
    use compose_content::Kind as C;
    let kind = match cc.kind.as_ref()? {
        C::Text(t) => content::Kind::Text(Text { text: t.text.clone(), entities: entities_from_view(&t.entities), ..Default::default() }),
        C::Media(m) => content::Kind::Media(media_from_view(m)),
        C::Sticker(s) => {
            let mut media = s.media.as_ref().map(media_from_view).unwrap_or_default();
            media.kind = MediaKind::Photo as i32;
            media.caption.clear();
            content::Kind::Sticker(Sticker {
                pack: s.pack.clone(),
                sticker_id: s.sticker_id.clone(),
                emoji: s.emoji.clone(),
                media: Some(media),
                pack_ref: None,
            })
        }
        C::Poll(p) => content::Kind::Poll(Poll {
            question: p.question.clone(),
            options: p.options.iter().map(|t| PollOption { text: t.clone() }).collect(),
            is_multiple: p.multiple,
            is_quiz: p.quiz,
            ..Default::default()
        }),
        C::Location(l) => content::Kind::Location(Location { latitude: l.lat, longitude: l.lon, title: l.title.clone(), ..Default::default() }),
        C::Contact(c) => content::Kind::Contact(crate::pb::parvane::msg::v2::Contact {
            first_name: c.first_name.clone(),
            last_name: c.last_name.clone(),
            phone: String::new(),
            user: (!c.user.is_empty()).then(|| crate::pb::parvane::core::v2::UserRef { address: c.user.clone() }),
        }),
        C::Article(a) => content::Kind::Article(crate::pb::parvane::msg::v2::Article {
            title: a.title.clone(),
            markdown: a.markdown.clone(),
            text: char_prefix(&a.markdown, 600),
            media: vec![],
        }),
    };
    let reply_to = (cc.reply_to.len() == 16).then(|| MessageRef { op_id: cc.reply_to.clone() });
    let reply_quote = match (&reply_to, reply_quote) {
        (Some(_), Some(q)) if !q.text.is_empty() => {
            let text = utf8_prefix(&q.text, REPLY_QUOTE_MAX_BYTES).to_string();
            let len = text.encode_utf16().count() as u32;
            Some(ReplyQuote {
                entities: entities_from_view(&q.entities).into_iter().filter(|e| e.offset.saturating_add(e.length) <= len).collect(),
                text,
                offset: 0,
            })
        }
        _ => None,
    };
    Some(Content { kind: Some(kind), reply_to, silent: cc.silent, reply_quote, ..Default::default() })
}

/// Есть ли в содержимом ссылка (GROUP-2 `embed_links`: превью либо URL-сущность; `sync-rules.json contentKinds`).
pub fn has_link(c: &Content) -> bool {
    match &c.kind {
        Some(content::Kind::Text(t)) => {
            t.preview.is_some() || t.entities.iter().any(|e| e.r#type == EntityType::Url as i32 || e.r#type == EntityType::TextUrl as i32)
        }
        Some(content::Kind::Media(m)) => {
            m.caption_entities.iter().any(|e| e.r#type == EntityType::Url as i32 || e.r#type == EntityType::TextUrl as i32)
        }
        _ => false,
    }
}

/// id сообщения из UUID-строки тела (`reply_to`).
pub fn body_reply_to(body: &Map<String, Value>) -> Vec<u8> {
    body.get("reply_to").and_then(Value::as_str).map(id_of_uuid).unwrap_or_default()
}

/// Нормализованное имя набора (PACK-1): буквы, цифры, пробел, `-`, `_`; без пробелов по краям; не длиннее 32 знаков;
/// пусто — `Pack`. Совпадает с прежними web `sanitizePackName`, ядром `pack::sanitizeName`, android `EmojiDocId`.
pub fn sanitize_pack_name(name: &str) -> String {
    let kept: String = name.chars().filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_')).collect();
    let trimmed: String = kept.trim().chars().take(32).collect();
    let out = trimmed.trim_end().to_string();
    if out.is_empty() {
        "Pack".to_string()
    } else {
        out
    }
}

/// Id набора стикеров (PACK-1): ключ объекта STICKER_PACK — `h:<content_hash как на проводе>` либо `n:<имя>`.
pub fn pack_set_id(content_hash: &str, name: &str) -> String {
    if content_hash.is_empty() {
        format!("n:{}", sanitize_pack_name(if name.is_empty() { "Pack" } else { name }))
    } else {
        format!("h:{content_hash}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_roundtrip_and_fallback() {
        let c = Content { kind: Some(content::Kind::Text(Text { text: "привет".into(), ..Default::default() })), ..Default::default() };
        let w = content_to_wire(&c).unwrap();
        assert_eq!(w, json!({"kind": "text", "text": "привет"}));
        let offer = json!({"kind": "task_offer", "name": "Дело", "text": "Задание: Дело"});
        let b = wire_to_body(offer.as_object().unwrap(), &|_| false).unwrap();
        assert_eq!(b, text_body("Задание: Дело".into()));
        let b = wire_to_body(offer.as_object().unwrap(), &|f| f == "task_offer").unwrap();
        assert!(matches!(b.kind, Some(view_body::Kind::TaskOffer(_))));
    }

    /// TRACK-1: трек «Музыки» проходит туда и обратно; клиент без раздела получает текст.
    #[test]
    fn music_track_roundtrip_and_text_fallback() {
        let wire = json!({
            "kind": "music_track", "track_id": "t42", "track_server": "music.example", "title": "Ночной автобус",
            "artist": "Lampa", "duration_secs": 215, "text": "Lampa — Ночной автобус",
        });
        let content = wire_to_content(wire.as_object().unwrap(), None).unwrap();
        let Some(content::Kind::MusicTrack(t)) = &content.kind else { panic!("не трек: {content:?}") };
        assert_eq!((t.track_id.as_str(), t.server.as_str(), t.duration_secs), ("t42", "music.example", 215));
        assert_eq!(content_to_wire(&content).unwrap(), wire);
        assert_eq!(class_of(&content), Class::Message);
        assert!(crate::msg::is_trackable(&content));
        let body = wire_to_body(wire.as_object().unwrap(), &|_| true).unwrap();
        let Some(view_body::Kind::Text(text)) = body.kind else { panic!("не текст") };
        assert_eq!(text.text, "Lampa — Ночной автобус");
    }
}
