//! NOTES-3: сведение холста с двух устройств по общему образцу `conformance/notes-canvas-merge/cases.json` — тот же
//! файл проверяет web (`notesCanvasMerge.test.ts`).

use parvane_protocol::host::call::call_static;
use serde_json::{json, Value};

const SAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/notes-canvas-merge/cases.json");

#[test]
fn canvas_merge_matches_sample() {
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(SAMPLE).expect("образец")).expect("JSON образца");
    let cases = sample["cases"].as_array().expect("cases");
    assert!(cases.len() >= 10, "образец урезан: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let args = json!({ "base": case["base"], "mine": case["mine"], "theirs": case["theirs"] });
        let out = call_static("notesCanvasMerge", &args).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(out["doc"], case["expect"]["doc"], "{name}: холст");
        assert_eq!(out["conflicts"], case["expect"]["conflicts"], "{name}: расхождения");
    }
}

#[test]
fn canvas_merge_is_symmetric_without_conflicts() {
    // Без расхождений неважно, чья версия «моя»: набор карточек и их поля одинаковы
    let base = r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":250,"height":60}],"edges":[]}"#;
    let one = r#"{"nodes":[{"id":"a","type":"text","x":10,"y":0,"width":250,"height":60}],"edges":[]}"#;
    let two = r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":250,"height":60,"text":"Сарай"}],"edges":[]}"#;
    let ab = call_static("notesCanvasMerge", &json!({ "base": base, "mine": one, "theirs": two })).expect("а-б");
    let ba = call_static("notesCanvasMerge", &json!({ "base": base, "mine": two, "theirs": one })).expect("б-а");
    assert_eq!(ab["doc"], ba["doc"]);
    assert_eq!(ab["conflicts"], json!(0));
    // Негодный вход — отказ, а не паника
    assert!(call_static("notesCanvasMerge", &json!({ "base": 1 })).is_err());
    assert!(call_static("notesCanvasMerge", &json!({ "mine": "[1]" })).is_err());
}
