//! PLANNER-2: подсказки «Плана» по общему образцу `conformance/planner-tools/cases.json` — тот же файл читают клиенты.
//! `PLANNER_TOOLS_REGEN=1` пересоздаёт ожидаемое в образце.

use parvane_protocol::host::call::call_static;
use serde_json::{json, Value};

const SAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/planner-tools/cases.json");

#[test]
fn planner_tools_follow_the_shared_sample() {
    let mut sample: Value = serde_json::from_str(&std::fs::read_to_string(SAMPLE).expect("образец")).expect("JSON образца");
    let regen = std::env::var("PLANNER_TOOLS_REGEN").is_ok_and(|v| v == "1");
    let cases = sample["cases"].as_array_mut().expect("cases");
    assert!(cases.len() >= 8, "образец урезан: {}", cases.len());
    for case in cases.iter_mut() {
        let name = case["name"].as_str().unwrap_or("?").to_string();
        let call = case["call"].as_str().expect("call").to_string();
        let out = call_static(&call, &case["args"]).unwrap_or_else(|e| panic!("{name}: {e}"));
        if regen {
            case["expect"] = out;
        } else {
            assert_eq!(out, case["expect"], "{name}");
        }
    }
    if regen {
        let text = serde_json::to_string_pretty(&sample).expect("JSON") + "\n";
        std::fs::write(SAMPLE, text).expect("запись образца");
    }
    // Негодный вход — отказ, а не пустой ответ
    assert!(call_static("plannerFreeTime", &json!({"days": "нет"})).is_err());
}
