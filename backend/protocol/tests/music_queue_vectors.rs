//! MUSIC-1: очередь плеера по общему образцу `conformance/music-queue/cases.json` — тот же файл читают клиенты.

use parvane_protocol::host::call::call_static;
use serde_json::{json, Value};

#[test]
fn player_queue_follows_the_shared_sample() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/music-queue/cases.json");
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("образец очереди")).expect("JSON образца");
    let cases = sample["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5, "образец урезан: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let mut queue = Value::Null;
        for (i, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let call = step["call"].as_str().expect("call");
            let mut args = step["args"].clone();
            if args.get("queue").is_none() {
                args["queue"] = queue.clone();
            }
            let view = call_static(call, &args).unwrap_or_else(|e| panic!("{name}, шаг {i} ({call}): {e}"));
            for field in ["currentId", "upcoming", "repeat", "added"] {
                if let Some(expected) = step.get(field) {
                    assert_eq!(&view[field], expected, "{name}, шаг {i} ({call}): {field}");
                }
            }
            queue = view;
        }
    }
    // Неизвестное действие очереди — отказ, а не молчаливое «ничего»
    assert!(call_static("musicQueueFly", &json!({})).is_err());
}
