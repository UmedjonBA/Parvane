//! Векторы стража содержимого у получателя (T018, класс 16):
//! `proto/parvane/vectors/content_guard/`.

mod common;

use common::*;
use parvane_protocol::content_guard;
use parvane_protocol::pb::parvane::msg::v2::Content;
use serde_json::{json, Value};

/// (имя, входное Content в proto3-JSON)
fn inputs() -> Vec<(&'static str, Value)> {
    vec![
        ("text-javascript-url", json!({"text": {"text": "click", "entities": [{"type": "ENTITY_TYPE_TEXT_URL", "offset": 0, "length": 5, "url": "javascript:alert(1)"}]}})),
        ("text-tg-url", json!({"text": {"text": "open", "entities": [{"type": "ENTITY_TYPE_TEXT_URL", "offset": 0, "length": 4, "url": "tg://resolve?domain=x"}]}})),
        ("text-https-url-kept", json!({"text": {"text": "site", "entities": [{"type": "ENTITY_TYPE_TEXT_URL", "offset": 0, "length": 4, "url": "https://example.org"}]}})),
        ("entity-overflow-clamped", json!({"text": {"text": "héllo😀", "entities": [{"type": "ENTITY_TYPE_BOLD", "offset": 2, "length": 1000}, {"type": "ENTITY_TYPE_ITALIC", "offset": 50, "length": 1}]}})),
        ("media-html-mime", json!({"media": {"kind": "MEDIA_KIND_FILE", "mime": "text/html", "name": "index.html"}})),
        ("media-svg-mime", json!({"media": {"kind": "MEDIA_KIND_PHOTO", "mime": "image/svg+xml"}})),
        ("media-mime-case", json!({"media": {"kind": "MEDIA_KIND_PHOTO", "mime": "Image/JPEG; q=1"}})),
        ("media-path-traversal", json!({"media": {"kind": "MEDIA_KIND_FILE", "mime": "application/pdf", "name": "../../etc/passwd"}})),
        ("preview-data-url-dropped", json!({"text": {"text": "x", "preview": {"url": "data:text/html,<script>", "title": "t"}}})),
        ("sticker-media-sanitized", json!({"sticker": {"pack": "p", "media": {"kind": "MEDIA_KIND_PHOTO", "mime": "application/javascript"}}})),
        ("edit-entities-clamped", json!({"edit": {"text": {"text": "ab", "entities": [{"type": "ENTITY_TYPE_CODE", "offset": 0, "length": 9}]}}})),
    ]
}

fn run(input: &Value) -> Value {
    let mut c: Content = serde_json::from_value(input.clone()).unwrap();
    content_guard::sanitize_content(&mut c);
    serde_json::to_value(&c).unwrap()
}

fn generate() -> Value {
    let cases: Vec<Value> = inputs()
        .into_iter()
        .map(|(name, input)| json!({"name": name, "input": {"content": input}, "expect": {"ok": true, "content": run(&input)}}))
        .collect();
    json!({"suite": "content_guard", "description": "обезвреживание содержимого у получателя: MIME, URL-схемы, entities, имена файлов", "cases": cases})
}

#[test]
fn content_guard_vectors() {
    let v = load_or_generate("content_guard", "content.json", generate);
    for case in cases(&v) {
        let name = case["name"].as_str().unwrap();
        assert_eq!(run(&case["input"]["content"]), case["expect"]["content"], "вектор {name}");
    }
}

#[test]
fn content_guard_semantics() {
    let get = |n: &str| run(&inputs().into_iter().find(|(k, _)| *k == n).unwrap().1);
    assert!(get("text-javascript-url")["text"].get("entities").is_none());
    assert!(get("text-tg-url")["text"].get("entities").is_none());
    assert_eq!(get("text-https-url-kept")["text"]["entities"][0]["url"], json!("https://example.org"));
    assert_eq!(get("entity-overflow-clamped")["text"]["entities"][0]["length"], json!(5));
    assert_eq!(get("media-html-mime")["media"]["mime"], json!("application/octet-stream"));
    assert_eq!(get("media-svg-mime")["media"]["mime"], json!("application/octet-stream"));
    assert_eq!(get("media-mime-case")["media"]["mime"], json!("image/jpeg"));
    assert_eq!(get("media-path-traversal")["media"]["name"], json!("passwd"));
    assert!(get("preview-data-url-dropped")["text"].get("preview").is_none());
}
