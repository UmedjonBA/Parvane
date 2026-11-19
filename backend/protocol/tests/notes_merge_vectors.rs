//! NOTES-2: сведение заметки с двух устройств по общему образцу `conformance/notes-merge/cases.json` — тот же
//! файл проверяет web (`notesMerge.test.ts`).

use parvane_protocol::host::call::call_static;
use serde_json::{json, Value};

const SAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/notes-merge/cases.json");

fn sample() -> Value {
    serde_json::from_str(&std::fs::read_to_string(SAMPLE).expect("образец")).expect("JSON образца")
}

fn cases<'a>(sample: &'a Value, key: &str) -> &'a [Value] {
    sample[key].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет {key}"))
}

fn three(case: &Value) -> Value {
    json!({ "base": case["base"], "mine": case["mine"], "theirs": case["theirs"] })
}

#[test]
fn merge_matches_sample() {
    let sample = sample();
    for case in cases(&sample, "merge") {
        let out = call_static("notesMerge", &three(case)).expect("сведение");
        assert_eq!(out["text"], case["text"], "{}", case["name"]);
        assert_eq!(out["conflict"], case["conflict"], "{}", case["name"]);
        // Расхождение несёт участки, без него участков нет
        assert_eq!(out["parts"].as_array().map_or(0, Vec::len) > 0, case["conflict"] == json!(true), "{}", case["name"]);
    }
}

#[test]
fn resolve_matches_sample() {
    let sample = sample();
    for case in cases(&sample, "resolve") {
        let mut args = three(case);
        args["choices"] = case["choices"].clone();
        let out = call_static("notesMergeResolve", &args).expect("решение");
        assert_eq!(out["text"], case["text"], "{}", case["name"]);
    }
}

#[test]
fn parts_match_sample() {
    let sample = sample();
    for case in cases(&sample, "parts") {
        let out = call_static("notesMerge", &three(case)).expect("сведение");
        assert_eq!(out["parts"], case["parts"], "{}", case["name"]);
        assert_eq!(out["autoLines"], case["autoLines"], "{}", case["name"]);
    }
}

#[test]
fn resolve_without_conflict_is_merge() {
    // Без расхождений выбор ни на что не влияет
    let args = json!({ "base": "а\nб\nв\n", "mine": "А\nб\nв\n", "theirs": "а\nб\nВ\n", "choices": ["theirs"] });
    assert_eq!(call_static("notesMergeResolve", &args).expect("решение")["text"], json!("А\nб\nВ\n"));
}

#[test]
fn huge_texts_conflict_as_a_whole() {
    let base: String = (0..2500).map(|n| format!("{n}\n")).collect();
    let mine: String = (0..2500).map(|n| format!("м{n}\n")).collect();
    let theirs: String = (0..2500).map(|n| format!("т{n}\n")).collect();
    let out = call_static("notesMerge", &json!({ "base": base, "mine": mine, "theirs": theirs })).expect("сведение");
    assert_eq!(out["conflict"], json!(true));
    assert_eq!(out["parts"].as_array().map(Vec::len), Some(1));
}

#[test]
fn bad_input_is_refused() {
    assert!(call_static("notesMerge", &json!({ "base": 1 })).is_err());
}
