//! CALL-3: слова сверки звонка по общему образцу `conformance/call-sas/cases.json` — тот же файл читают клиенты.

use parvane_protocol::call_sas;
use serde_json::Value;

#[test]
fn call_sas_follows_the_shared_sample() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/call-sas/cases.json");
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("образец сверки")).expect("JSON образца");
    let cases = sample["cases"].as_array().expect("cases");
    assert!(cases.len() >= 6, "образец урезан: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        assert_eq!(call_sas::words_json(case), case["words"], "{name}");
    }
}
