//! MODULES-1: список модулей по общему образцу `conformance/modules/cases.json` — тот же файл читают клиенты.

use parvane_protocol::modules;
use serde_json::Value;

#[test]
fn modules_follow_the_shared_sample() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/modules/cases.json");
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("образец модулей")).expect("JSON образца");
    let cases = sample["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5, "образец урезан: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let view = modules::view(&case["prefs"], &case["serverOff"], &case["available"]);
        let got = serde_json::to_value(&view).expect("view");
        assert_eq!(got["prefs"]["order"], case["order"], "{name}: порядок");
        assert_eq!(got["prefs"]["off"], case["off"], "{name}: выключенные");
        assert_eq!(got["prefs"]["healthBlocks"], case["healthBlocks"], "{name}: блоки");
        assert_eq!(got["enabled"], case["enabled"], "{name}: включённые");
        let ids = |flag: &str| -> Vec<Value> {
            got["modules"].as_array().unwrap().iter().filter(|m| m[flag] == true).map(|m| m["id"].clone()).collect()
        };
        assert_eq!(Value::Array(ids("isServerOff")), case["serverOffModules"], "{name}: выключено сервером");
        assert_eq!(Value::Array(ids("isUnavailable")), case["unavailable"], "{name}: нет экранов");
        // Приведённое — неподвижная точка: повторное приведение ничего не меняет
        assert_eq!(serde_json::to_value(modules::normalize(&got["prefs"])).unwrap(), got["prefs"], "{name}: повтор");
    }
}
