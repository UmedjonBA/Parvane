//! Векторы `legacy_v1` (T021): v1-сообщения всех трёх клиентов
//! (`specs/007-protocol-v2/v1-dialects.md`, D-1…D-26) →
//! `proto/parvane/vectors/legacy_v1/`. Ожидание — каноничный proto3-JSON.

mod common;

use common::*;
use parvane_protocol::legacy_v1::{self, LegacyBody, LegacyInner};
use serde_json::{json, Value};

/// (имя, слой, json v1)
const CASES: &[(&str, &str, &str)] = &[
    // §1.1 серверный уровень / строки БД
    ("stored-plain-text", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f80","from":"alice@x","to":"bob@x","content":{"kind":"text","text":"привет"},"ts":1727500000,"reply_to":null,"edited":false,"deleted":false}"#),
    ("stored-photo-caption-null", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f81","from":"alice@x","to":"bob@x","content":{"kind":"photo","file_id":"01923f4e-8c1a-7b2d-9e3f-0a1b2c3d4e60","width":1280,"height":960,"mime":"image/jpeg","size_bytes":201344,"caption":null},"ts":1}"#),
    ("stored-encrypted", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f82","from":"","to":"bob@x","content":{"kind":"encrypted","ciphertext":"AwogK3Jm","ctype":0,"sender_identity":"q3Zb6o0dGQJmQ5x1kC0y7aH0mXW8Qm5wTzq1P3cV9Ts","sender_signing_key":"b4mYx7N0y4Q2pC1q6d8Hk9Qm0sZ3rT5vW7xY9aB1cD2"},"ts":1,"reply_to":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f80","edited":true,"pinned":true}"#),
    ("stored-encrypted-no-ctype", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f83","from":"","to":"bob@x","content":{"kind":"encrypted","ciphertext":"AwogK3Jm","sender_identity":"q3Zb"},"ts":1}"#),
    ("stored-group", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f84","from":"alice@x","to":"01923f40-0000-7000-8000-000000000001","content":{"kind":"group_encrypted","ciphertext":"AwgAEpABm3kq0dJ6yR3vQ","group":"01923f40-0000-7000-8000-000000000001","sender_identity":"q3Zb"},"ts":1}"#),
    ("stored-deleted", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f85","from":"alice@x","to":"bob@x","content":{"kind":"encrypted","ciphertext":"AwogK3Jm","ctype":1,"sender_identity":"q3Zb"},"ts":1,"deleted":true}"#),
    ("stored-tombstone-empty-ct", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f86","from":"","to":"bob@x","content":{"kind":"encrypted","ciphertext":"","ctype":0,"sender_identity":"q3Zb"},"ts":1}"#),
    ("stored-tombstone-empty-text", "stored", r#"{"id":"01923f4e-9a00-7c11-8a22-3b4c5d6e7f87","from":"alice@x","to":"bob@x","content":{"kind":"text","text":""},"ts":1}"#),
    ("stored-no-id", "stored", r#"{"from":"alice@x","content":{"kind":"text","text":"x"}}"#),
    // §3.1 Olm: обёртка обязательна, порядок ключей любой (D-2, D-4)
    ("olm-web-order", "olm", r#"{"from":"alice@parvane.duckdns.org","content":{"kind":"text","text":"привет"}}"#),
    ("olm-nlohmann-order", "olm", r#"{"content":{"kind":"text","text":"привет"},"from":"alice@parvane.duckdns.org"}"#),
    ("olm-bare-rejected", "olm", r#"{"kind":"text","text":"привет"}"#),
    ("olm-bad-from", "olm", r#"{"from":"alice@x>","content":{"kind":"text","text":"x"}}"#),
    // §3.2 Megolm: оба формата, inner.from игнорируется (D-1)
    ("megolm-bare", "megolm", r#"{"kind":"text","text":"всем привет","entities":[{"type":"mention","offset":0,"length":4}]}"#),
    ("megolm-legacy-wrapper", "megolm", r#"{"from":"mallory@x","content":{"kind":"text","text":"всем привет","entities":[{"type":"mention","offset":0,"length":4}]}}"#),
    // §3.3 SKDM
    ("skdm", "olm", r#"{"from":"alice@x","content":{"kind":"skdm","group":"01923f40-0000-7000-8000-000000000001","session_key":"AgAAAABx","sender_identity":"q3Zb","epoch":1727500000123}}"#),
    // §3.5 text
    ("text-web-full", "megolm", r#"{"kind":"text","text":"смотри https://example.org","entities":[{"type":"bold","offset":0,"length":6},{"type":"custom_emoji","offset":7,"length":2,"data":"5368324170671202286"},{"type":"text_url","offset":7,"length":19,"data":"https://example.org"}],"webpage":{"url":"https://example.org","site_name":"example.org","title":"Example Domain","description":"This domain is for use in examples."},"ttl_secs":86400}"#),
    ("text-android-url-entity", "megolm", r#"{"kind":"text","text":"https://example.org","entities":[{"offset":0,"length":19,"type":"url"}]}"#),
    ("text-unknown-entity-dropped", "megolm", r#"{"kind":"text","text":"abc","entities":[{"type":"marquee","offset":0,"length":3}]}"#),
    // §3.6 photo: пустая подпись — опущена / null / "" (D-5)
    ("photo-web", "megolm", r#"{"kind":"photo","file_id":"01923f4e-bbbb-7000-8000-000000000001","width":1280,"height":960,"mime":"image/jpeg","size_bytes":201344,"file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi"}"#),
    ("photo-desktop", "megolm", r#"{"caption":null,"file_id":"01923f4e-bbbb-7000-8000-000000000001","file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi","height":960,"kind":"photo","mime":"image/jpeg","size_bytes":201344,"width":1280}"#),
    ("photo-android", "megolm", r#"{"kind":"photo","mime":"image/jpeg","width":1280,"height":960,"caption":"","file_id":"01923f4e-bbbb-7000-8000-000000000001","size_bytes":201344,"file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi"}"#),
    // §3.7 voice (waveform только web, D-7)
    ("voice-web", "megolm", r#"{"kind":"voice","file_id":"01923f4e-cccc-7000-8000-000000000001","duration_secs":4,"mime":"audio/ogg","size_bytes":15872,"waveform":[0,33,132,16,66,8],"file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi"}"#),
    ("voice-desktop", "megolm", r#"{"duration_secs":4,"file_id":"01923f4e-cccc-7000-8000-000000000001","file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi","kind":"voice","mime":"audio/ogg","size_bytes":15872}"#),
    // §3.8 video_note без height у android (D-9), gif (D-22)
    ("video-note-android", "megolm", r#"{"kind":"video_note","mime":"video/mp4","duration_secs":9,"width":384,"file_id":"01923f4e-dddd-7000-8000-000000000002","size_bytes":712004,"file_key":"Qm9vYmFyYmF6cXV4cXV1eHh5enp6YWFhYWJiYmJjY2M=","file_nonce":"MDEyMzQ1Njc4OWFi"}"#),
    ("gif-web", "megolm", r#"{"kind":"gif","file_id":"01923f4e-eeee-7000-8000-000000000001","filename":"pvgif-7.webm","mime":"video/webm","width":240,"height":240,"duration_secs":3,"size_bytes":88112}"#),
    // §3.9 файл-аудио (D-8)
    ("file-audio-web", "megolm", r#"{"kind":"file","file_id":"01923f4e-ffff-7000-8000-000000000001","filename":"song.mp3","mime":"audio/mpeg","size_bytes":4210000,"duration_secs":215,"audio_title":"Song","audio_performer":"Band"}"#),
    ("file-doc-desktop", "megolm", r#"{"caption":null,"file_id":"01923f4e-ffff-7000-8000-000000000002","filename":"report.pdf","kind":"file","mime":"application/pdf","size_bytes":88213}"#),
    // §3.10 sticker (D-10, D-25)
    ("sticker-web", "megolm", r#"{"kind":"sticker","file_id":"01923f4e-1111-7000-8000-000000000001","filename":"😺","mime":"image/webp","width":512,"height":512,"pack_ref":{"file_id":"01923f4e-aaaa-7000-8000-000000000010","name":"my_cats","count":12}}"#),
    // §3.11 location (D-13)
    ("location-static", "megolm", r#"{"kind":"location","lat":55.751244,"long":37.618423}"#),
    ("location-live-web", "megolm", r#"{"kind":"location","lat":55.751244,"long":37.618423,"live_period":900,"heading":270,"accuracy":12}"#),
    ("location-out-of-range", "megolm", r#"{"kind":"location","lat":123.0,"long":37.6}"#),
    // §3.12 опросы — три диалекта одного опроса (D-3)
    ("poll-web", "megolm", r#"{"kind":"poll","question":"Куда идём?","options":["Кино","Парк","Дом"],"is_public":true,"is_multiple":true}"#),
    ("poll-desktop", "megolm", r#"{"answers":["Кино","Парк","Дом"],"kind":"poll","multiple":true,"public":true,"question":"Куда идём?","quiz":false}"#),
    ("poll-android", "megolm", r#"{"kind":"poll","question":"Куда идём?","options":["Кино","Парк","Дом"],"is_public":true,"is_multiple":true,"is_quiz":false,"answers":["Кино","Парк","Дом"],"public":true,"multiple":true,"quiz":false}"#),
    ("quiz-web", "megolm", r#"{"kind":"poll","question":"2+2?","options":["3","4","5"],"is_quiz":true,"correct":[1],"solution":"Арифметика"}"#),
    ("quiz-desktop", "megolm", r#"{"answers":["3","4","5"],"correct":[1],"kind":"poll","multiple":false,"public":false,"question":"2+2?","quiz":true,"solution":"Арифметика"}"#),
    // §3.13 голоса (D-15)
    ("poll-vote", "megolm", r#"{"kind":"poll_vote","poll":"01923f4e-2222-7000-8000-000000000001","options":[0,2]}"#),
    ("poll-vote-strings", "megolm", r#"{"kind":"poll_vote","poll":"01923f4e-2222-7000-8000-000000000001","options":["0","2"]}"#),
    ("poll-vote-retract", "megolm", r#"{"kind":"poll_vote","poll":"01923f4e-2222-7000-8000-000000000001","options":[]}"#),
    ("poll-close", "megolm", r#"{"kind":"poll_close","poll":"01923f4e-2222-7000-8000-000000000001"}"#),
    // пересылка (D-6), ttl на любом виде (D-14)
    ("forward-web", "megolm", r#"{"kind":"text","text":"x","forwarded_from":"carol@x","forwarded_name":"Carol"}"#),
    ("forward-android", "megolm", r#"{"kind":"text","text":"x","forwarded_name":"carol"}"#),
    ("ttl-on-poll-android", "megolm", r#"{"kind":"poll","question":"?","options":["a","b"],"ttl_secs":60}"#),
    // неизвестный вид → заглушка
    ("unknown-kind", "megolm", r#"{"kind":"hologram","data":1}"#),
    // §3.15 ICE обоих форматов (D-21)
    ("ice-web", "ice", r#"{"candidate":"candidate:842163049 1 udp 1677729535 203.0.113.7 51234 typ srflx raddr 0.0.0.0 rport 0 generation 0","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"a1b2"}"#),
    ("ice-desktop", "ice", r#"{"idx":0,"mid":"0","sdp":"candidate:842163049 1 udp 1677729535 203.0.113.7 51234 typ srflx raddr 0.0.0.0 rport 0 generation 0"}"#),
];

fn inner_json(i: &LegacyInner) -> Value {
    match i {
        LegacyInner::Content(c) => json!({"content": serde_json::to_value(c.as_ref()).unwrap()}),
        LegacyInner::Skdm { group, session_key, sender_identity, epoch } => {
            json!({"skdm": {"group": group, "session_key": session_key, "sender_identity": sender_identity, "epoch": epoch}})
        }
        LegacyInner::Unknown(_) => json!({"unknown": true}),
    }
}

fn run(layer: &str, input: &str) -> Result<Value, parvane_protocol::ProtoError> {
    Ok(match layer {
        "stored" => {
            let s = legacy_v1::parse_stored(input.as_bytes())?;
            let body = match &s.body {
                LegacyBody::Tombstone => json!({"tombstone": true}),
                LegacyBody::Plain(c) => json!({"plain": serde_json::to_value(c.as_ref()).unwrap()}),
                LegacyBody::Olm { ciphertext, ctype, sender_identity, sender_signing_key } => json!({"olm": {
                    "ciphertext_hex": hexs(ciphertext), "ctype_candidates": legacy_v1::ctype_candidates(*ctype),
                    "sender_identity": sender_identity, "sender_signing_key": sender_signing_key}}),
                LegacyBody::Megolm { ciphertext, group, sender_identity, .. } => json!({"megolm": {
                    "ciphertext_hex": hexs(ciphertext), "group": group, "sender_identity": sender_identity}}),
            };
            json!({"id": s.id, "from": s.from, "to": s.to, "ts": s.ts, "reply_to": s.reply_to, "edited": s.edited, "deleted": s.deleted, "pinned": s.pinned, "body": body})
        }
        "olm" => {
            let (from, inner) = legacy_v1::parse_olm_plaintext(input.as_bytes())?;
            json!({"author": from, "inner": inner_json(&inner)})
        }
        "megolm" => json!({"inner": inner_json(&legacy_v1::parse_megolm_plaintext(input.as_bytes())?)}),
        "ice" => serde_json::to_value(legacy_v1::normalize_ice(input)?).unwrap(),
        l => panic!("слой {l}"),
    })
}

fn generate() -> Value {
    let cases: Vec<Value> = CASES
        .iter()
        .map(|(name, layer, input)| {
            let expect = match run(layer, input) {
                Ok(v) => json!({"ok": true, "result": v}),
                Err(e) => err(e.kind()),
            };
            json!({"name": name, "input": {"layer": layer, "json": input}, "expect": expect})
        })
        .collect();
    json!({"suite": "legacy_v1", "description": "v1-сообщения web/desktop/android → v2 (только чтение истории)", "cases": cases})
}

#[test]
fn legacy_vectors() {
    let v = load_or_generate("legacy_v1", "messages.json", generate);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        let got = run(case["input"]["layer"].as_str().unwrap(), case["input"]["json"].as_str().unwrap());
        check(name, &got, &case["expect"]);
        if let (Ok(r), Some(exp)) = (&got, case["expect"].get("result")) {
            assert_eq!(r, exp, "вектор {name}");
        }
    }
}

/// Семантика диалектов: разные клиенты → одинаковый v2.
#[test]
fn dialects_converge() {
    let res = |n: &str| {
        let (_, l, i) = CASES.iter().find(|c| c.0 == n).unwrap();
        run(l, i).unwrap()
    };
    assert_eq!(res("poll-web"), res("poll-desktop"));
    assert_eq!(res("poll-desktop"), res("poll-android"));
    assert_eq!(res("quiz-web"), res("quiz-desktop"));
    assert_eq!(res("photo-web"), res("photo-desktop"));
    assert_eq!(res("photo-desktop"), res("photo-android"));
    assert_eq!(res("megolm-bare"), res("megolm-legacy-wrapper"));
    assert_eq!(res("olm-web-order"), res("olm-nlohmann-order"));
    assert_eq!(res("poll-vote"), res("poll-vote-strings"));
    assert_eq!(res("ice-web"), res("ice-desktop"));
    // video_note android: height = width.
    let vn = res("video-note-android");
    assert_eq!(vn["inner"]["content"]["media"]["height"], json!(384));
    // Аудиофайл web — вид AUDIO.
    assert_eq!(res("file-audio-web")["inner"]["content"]["media"]["kind"], json!("MEDIA_KIND_AUDIO"));
    assert_eq!(res("unknown-kind")["inner"]["unknown"], json!(true));
}
