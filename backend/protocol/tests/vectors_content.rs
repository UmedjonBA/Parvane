//! Векторы всех видов содержимого (T085): `proto/parvane/vectors/content/`.
//!
//! Один файл на все обвязки: движок сверяет байты ↔ каноничный proto3-JSON,
//! лимиты до разбора и решение «показать / заглушка» (набор `content/kinds`
//! в `parvane_protocol::conformance`); клиенты тем же файлом сверяют свою
//! перекладку в содержимое UI (поле `client`): `class` — чем вид является для
//! клиента (`message` — сообщение чата, в том числе видимое служебное
//! сообщение вроде смены режима `chat_mode`, `mutation` — правка/квитанция,
//! `service` — служебное движка, `stub` — «не поддерживается»), `v1` —
//! поля содержимого UI, которые обязаны совпасть во всех клиентах.

mod common;

use std::collections::BTreeSet;

use common::*;
use parvane_protocol::conformance;
use parvane_protocol::pb::parvane::msg::v2::Content;
use parvane_protocol::schema;
use prost::Message;
use serde_json::{json, Value};

const OP: &str = "AQIDBAUGBwgJCgsMDQ4PEA=="; // 01 02 … 10
const OP2: &str = "EREREREREREREREREREREQ=="; // 11 × 16
const KEY32: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const NONCE24: &str = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ";
const CAP32: &str = "xcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcU=";

fn media(kind: &str, mime: &str, extra: Value) -> Value {
    let mut m = json!({"kind": kind, "file_id": "f-1", "mime": mime, "size": "1024", "file_key": KEY32, "file_nonce": NONCE24});
    if let (Some(m), Some(e)) = (m.as_object_mut(), extra.as_object()) {
        m.extend(e.clone());
    }
    m
}

/// (имя, Content в proto3-JSON, ожидание клиента)
fn positive() -> Vec<(&'static str, Value, Value)> {
    let msg = |v1: Value| json!({"class": "message", "v1": v1});
    let mutation = json!({"class": "mutation"});
    let service = json!({"class": "service"});
    vec![
        ("text", json!({"text": {"text": "привет"}}), msg(json!({"kind": "text", "text": "привет"}))),
        (
            "text-entities-preview",
            json!({"text": {"text": "bold site", "entities": [
                {"type": "ENTITY_TYPE_BOLD", "length": 4},
                {"type": "ENTITY_TYPE_TEXT_URL", "offset": 5, "length": 4, "url": "https://example.org"}
            ], "preview": {"url": "https://example.org", "site_name": "Example", "title": "Заголовок", "description": "Описание"}}}),
            msg(json!({"kind": "text", "text": "bold site", "webpage": {"url": "https://example.org", "title": "Заголовок"}})),
        ),
        (
            "text-custom-emoji-pack",
            json!({"text": {"text": "😀", "entities": [{"type": "ENTITY_TYPE_CUSTOM_EMOJI", "length": 2, "custom_emoji_id": "e-7"}],
                "emoji_packs": [{"file_id": "pack-1", "name": "smiles", "count": 3, "key": KEY32, "nonce": NONCE24}]}}),
            msg(json!({"kind": "text", "text": "😀"})),
        ),
        (
            "text-reply-forward-ttl-silent",
            json!({"text": {"text": "ответ"}, "ttl_secs": 30, "reply_to": {"op_id": OP},
                "forward": {"from_user": {"address": "carol@local"}, "from_name": "Кэрол", "original_ts_ms": "1700000000000"}, "silent": true}),
            msg(json!({"kind": "text", "text": "ответ", "ttl_secs": 30, "forwarded_from": "carol@local", "forwarded_name": "Кэрол"})),
        ),
        (
            "media-photo",
            json!({"media": media("MEDIA_KIND_PHOTO", "image/jpeg", json!({"width": 1280, "height": 720, "caption": "подпись", "capability": CAP32}))}),
            msg(json!({"kind": "photo", "file_id": "f-1", "mime": "image/jpeg", "size_bytes": 1024, "width": 1280, "height": 720, "caption": "подпись",
                "file_key": KEY32, "file_nonce": NONCE24})),
        ),
        (
            "media-video",
            json!({"media": media("MEDIA_KIND_VIDEO", "video/mp4", json!({"width": 640, "height": 360, "duration_ms": 12400}))}),
            msg(json!({"kind": "video", "mime": "video/mp4", "duration_secs": 12})),
        ),
        (
            "media-voice",
            json!({"media": media("MEDIA_KIND_VOICE", "audio/ogg", json!({"duration_ms": 3500, "waveform": "AQIDBAU="}))}),
            msg(json!({"kind": "voice", "duration_secs": 4, "waveform": [1, 2, 3, 4, 5]})),
        ),
        (
            "media-video-note",
            json!({"media": media("MEDIA_KIND_VIDEO_NOTE", "video/mp4", json!({"width": 384, "height": 384, "duration_ms": 400}))}),
            msg(json!({"kind": "video_note", "duration_secs": 1})),
        ),
        (
            "media-file",
            json!({"media": media("MEDIA_KIND_FILE", "application/pdf", json!({"name": "отчёт.pdf"}))}),
            msg(json!({"kind": "file", "filename": "отчёт.pdf", "mime": "application/pdf"})),
        ),
        (
            "media-audio",
            json!({"media": media("MEDIA_KIND_AUDIO", "audio/mpeg", json!({"name": "song.mp3", "duration_ms": 180000, "title": "Песня", "performer": "Группа"}))}),
            msg(json!({"kind": "file", "mime": "audio/mpeg", "audio_title": "Песня", "audio_performer": "Группа"})),
        ),
        (
            "media-animation",
            json!({"media": media("MEDIA_KIND_ANIMATION", "video/mp4", json!({"width": 320, "height": 240}))}),
            msg(json!({"kind": "gif", "mime": "video/mp4"})),
        ),
        (
            "sticker",
            json!({"sticker": {"pack": "cats", "sticker_id": "s-3", "emoji": "😺", "media": media("MEDIA_KIND_PHOTO", "image/webp", json!({"width": 512, "height": 512})),
                "pack_ref": {"file_id": "pack-2", "name": "cats", "count": 12, "key": KEY32, "nonce": NONCE24}}}),
            msg(json!({"kind": "sticker", "file_id": "f-1", "mime": "image/webp"})),
        ),
        (
            "location",
            json!({"location": {"latitude": 55.75, "longitude": 37.625, "accuracy_m": 15}}),
            msg(json!({"kind": "location", "lat": 55.75, "long": 37.625, "accuracy": 15})),
        ),
        (
            "location-live",
            json!({"location": {"latitude": -33.5, "longitude": 151.25, "live_period_s": 900, "heading": 270}}),
            msg(json!({"kind": "location", "lat": -33.5, "long": 151.25, "live_period": 900, "heading": 270})),
        ),
        (
            "poll-quiz",
            json!({"poll": {"question": "Сколько?", "options": [{"text": "один"}, {"text": "два"}, {"text": "три"}],
                "is_public": true, "is_quiz": true, "correct": [1], "solution": "потому что"}}),
            msg(json!({"kind": "poll", "question": "Сколько?"})),
        ),
        (
            "poll-multiple",
            json!({"poll": {"question": "Что?", "options": [{"text": "a"}, {"text": "b"}], "is_multiple": true}}),
            msg(json!({"kind": "poll", "question": "Что?"})),
        ),
        ("poll-vote", json!({"poll_vote": {"poll": {"op_id": OP}, "option_indexes": [0, 2]}}), msg(json!({"kind": "poll_vote", "options": [0, 2]}))),
        ("poll-close", json!({"poll_close": {"poll": {"op_id": OP}}}), msg(json!({"kind": "poll_close"}))),
        ("contact", json!({"contact": {"first_name": "Анна", "last_name": "К", "phone": "+10000000000", "user": {"address": "anna@local"}}}), json!({"class": "stub"})),
        ("receipt-read", json!({"receipt": {"kind": "RECEIPT_KIND_READ", "messages": [{"op_id": OP}, {"op_id": OP2}]}}), mutation.clone()),
        ("receipt-delivered", json!({"receipt": {"kind": "RECEIPT_KIND_DELIVERED", "messages": [{"op_id": OP}]}}), mutation.clone()),
        ("edit-text", json!({"edit": {"target": {"op_id": OP}, "text": {"text": "исправлено"}}}), mutation.clone()),
        ("edit-location", json!({"edit": {"target": {"op_id": OP}, "location": {"latitude": 1.5, "longitude": 2.5, "live_period_s": 60}}}), mutation.clone()),
        ("delete", json!({"delete": {"targets": [{"op_id": OP}, {"op_id": OP2}], "for_everyone": true}}), mutation.clone()),
        ("reaction", json!({"reaction": {"target": {"op_id": OP}, "emoji": "👍"}}), mutation.clone()),
        ("reaction-remove", json!({"reaction": {"target": {"op_id": OP}, "emoji": "👍", "remove": true}}), mutation.clone()),
        ("pin", json!({"pin": {"target": {"op_id": OP}, "silent": true}}), mutation.clone()),
        ("unpin", json!({"pin": {"target": {"op_id": OP}, "unpin": true}}), mutation),
        ("call-offer", json!({"call": {"call_id": OP, "offer": {"sdp": "v=0\r\n", "video": true}}}), service.clone()),
        (
            "call-ice",
            json!({"call": {"call_id": OP, "ice": {"candidate": "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", "sdp_mid": "0", "sdp_mline_index": 0}}}),
            service.clone(),
        ),
        ("call-hangup", json!({"call": {"call_id": OP, "hangup": {"reason": "HANGUP_REASON_DECLINED"}}}), service.clone()),
        (
            "group-key",
            json!({"group_key": {"context": {"group": {"domain": "local", "id": OP2}, "epoch": "3", "state_version": "7", "state_head_hash": KEY32},
                "envelope_key": KEY32, "megolm_session_key": "AQIDBAU=", "send_private_key": CAP32}}),
            service.clone(),
        ),
        ("delivery-key", json!({"delivery_key": {"delivery_key": KEY32, "generation": "2"}}), service.clone()),
        (
            "container-key",
            json!({"container_key": {"container": {"domain": "local", "id": OP}, "domain": "sample", "key_epoch": "1", "key": KEY32, "grant_version": "4", "grant_head_hash": CAP32}}),
            service.clone(),
        ),
        ("state-key", json!({"state_key": {"user": {"address": "alice@local"}, "state_key": KEY32, "key_version": 2}}), service),
        // Режим «усиленная приватность» (L2-1): видимое служебное сообщение
        // чата — содержимое UI `chat_mode`, клиент рисует его нативным
        // служебным сообщением («… включил(а)/выключил(а) усиленную приватность»).
        ("chat-mode-on", json!({"chat_mode": {"l2": true}}), msg(json!({"kind": "chat_mode", "l2": true}))),
        ("chat-mode-off", json!({"chat_mode": {}}), msg(json!({"kind": "chat_mode", "l2": false}))),
        // Задание в чат (spec 011, TASK-1): видимое сообщение; клиент без
        // планировщика показывает поле `text`.
        (
            "task-offer",
            json!({"task_offer": {"name": "Отчёт", "description": "за неделю", "steps": [{"text": "собрать цифры"}],
                "day": "2026-10-20", "start": "10:00", "minutes": 60, "due": "2026-10-21", "text": "Задание: Отчёт, 2026-10-20 10:00"}}),
            msg(json!({"kind": "task_offer", "name": "Отчёт", "day": "2026-10-20", "start": "10:00", "minutes": 60,
                "text": "Задание: Отчёт, 2026-10-20 10:00"})),
        ),
        (
            "task-response-accepted",
            json!({"task_response": {"offer": {"op_id": OP}, "decision": "TASK_DECISION_ACCEPTED", "text": "Принял задание «Отчёт»"}}),
            msg(json!({"kind": "task_response", "accepted": true, "text": "Принял задание «Отчёт»"})),
        ),
        (
            "task-response-declined",
            json!({"task_response": {"offer": {"op_id": OP}, "decision": "TASK_DECISION_DECLINED"}}),
            msg(json!({"kind": "task_response", "accepted": false})),
        ),
    ]
}

fn encode(content: &Value) -> Vec<u8> {
    let c: Content = serde_json::from_value(content.clone()).unwrap();
    c.encode_to_vec()
}

fn canonical(bytes: &[u8]) -> Value {
    serde_json::to_value(Content::decode(bytes).unwrap()).unwrap()
}

/// Длина как varint (для ручной сборки байтов сверх лимита).
fn varint(mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}

/// Поле длиной `len` с тегом `tag` (wire type 2) из байта `fill`.
fn field(tag: u8, len: usize, fill: u8) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(varint(len));
    out.extend(std::iter::repeat_n(fill, len));
    out
}

fn wrap(tag: u8, inner: Vec<u8>) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(varint(inner.len()));
    out.extend(inner);
    out
}

fn generate() -> Value {
    let mut cases: Vec<Value> = positive()
        .into_iter()
        .map(|(name, content, client)| {
            let bytes = encode(&content);
            json!({"name": name, "input": {"content_hex": hexs(&bytes)},
                "expect": {"ok": true, "content": canonical(&bytes), "disposition": "show"}, "client": client})
        })
        .collect();

    let text = encode(&json!({"text": {"text": "x"}}));
    // Вид из будущей версии: поле 50 вместо известного oneof → заглушка.
    let future = vec![0x92, 0x03, 0x02, 0x08, 0x01];
    cases.push(json!({"name": "unknown-kind-stub", "input": {"content_hex": hexs(&future)},
        "expect": {"ok": true, "content": canonical(&future), "disposition": "stub", "reencode": false}, "client": {"class": "stub"}}));
    // Известный вид + незнакомое поле, объявленное автором критичным → заглушка.
    cases.push(json!({"name": "critical-unknown-field-stub", "input": {"content_hex": hexs(&text), "critical_fields": [77]},
        "expect": {"ok": true, "content": canonical(&text), "disposition": "stub"}, "client": {"class": "stub"}}));
    // Критичное поле, которое клиент знает, показу не мешает.
    cases.push(json!({"name": "critical-known-field-show", "input": {"content_hex": hexs(&text), "critical_fields": [1, 100]},
        "expect": {"ok": true, "content": canonical(&text), "disposition": "show"}, "client": {"class": "message", "v1": {"kind": "text", "text": "x"}}}));
    cases.push(json!({"name": "empty-content-stub", "input": {"content_hex": ""},
        "expect": {"ok": true, "content": {}, "disposition": "stub"}, "client": {"class": "stub"}}));

    // Превышение лимитов схемы — отказ до разбора.
    let too_long_text = wrap(0x0a, field(0x0a, 65537, b'a'));
    let waveform = wrap(0x12, field(0x42, 257, 1));
    let thirteen: Vec<u8> = (0..13).flat_map(|_| wrap(0x12, field(0x0a, 1, b'o'))).collect();
    let poll = wrap(0x2a, thirteen);
    let reaction = wrap(0x5a, field(0x12, 65, b'e'));
    let op_id = wrap(0x52, wrap(0x0a, field(0x0a, 17, 1)));
    // task_offer = поле 20: тег (20 << 3) | 2 = 0xa2 0x01 (varint)
    let hundred_one: Vec<u8> = (0..101).flat_map(|_| wrap(0x1a, field(0x0a, 1, b's'))).collect();
    let mut task_offer = vec![0xa2, 0x01];
    task_offer.extend(varint(hundred_one.len()));
    task_offer.extend(hundred_one);
    for (name, bytes) in [
        ("limit-text-65537", too_long_text),
        ("limit-waveform-257", waveform),
        ("limit-poll-13-options", poll),
        ("limit-reaction-emoji-65", reaction),
        ("limit-op-id-17", op_id),
        ("limit-task-offer-101-steps", task_offer),
    ] {
        cases.push(json!({"name": name, "input": {"content_hex": hexs(&bytes)}, "expect": err("FieldLimit")}));
    }
    // Обрезанные байты — не разбираются.
    cases.push(json!({"name": "malformed-truncated", "input": {"content_hex": "0a05616263"}, "expect": err("Malformed")}));

    json!({"suite": "content", "description": "все виды Content: байты ↔ каноничный proto3-JSON, лимиты до разбора, показ/заглушка, перекладка в содержимое UI клиентов", "cases": cases})
}

#[test]
fn content_vectors() {
    let v = load_or_generate("content", "kinds.json", generate);
    let n = conformance::run("content/kinds", &v.to_string()).unwrap();
    assert!(n >= 40, "случаев: {n}");
}

/// Каждый вид `Content` (поле oneof 1..=99 схемы) имеет хотя бы один вектор:
/// новый вид без вектора роняет тест.
#[test]
fn every_kind_has_a_vector() {
    let v = load_or_generate("content", "kinds.json", generate);
    let spec = schema::message("parvane.msg.v2.Content").unwrap();
    let covered: BTreeSet<String> = cases(&v)
        .iter()
        .filter_map(|c| c["expect"].get("content").and_then(Value::as_object))
        .flat_map(|o| o.keys().cloned())
        .collect();
    for f in spec.fields.iter().filter(|f| f.number < 100) {
        assert!(covered.contains(f.name), "вид {} без вектора в content/kinds.json", f.name);
    }
    // общие поля (ttl, ответ, пересылка, без звука) тоже покрыты
    for name in ["ttl_secs", "reply_to", "forward", "silent"] {
        assert!(covered.contains(name), "поле {name} без вектора");
    }
}

/// Файл на диске совпадает с генератором: правка схемы или генератора без
/// перегенерации (`PARVANE_REGEN_VECTORS=1`) ловится здесь.
#[test]
fn file_matches_generator() {
    let v = load_or_generate("content", "kinds.json", generate);
    assert_eq!(v, generate(), "proto/parvane/vectors/content/kinds.json устарел — PARVANE_REGEN_VECTORS=1");
}
