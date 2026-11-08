//! spec 035 T030 (US2, FR-010…FR-017): векторы личного состояния v2 `proto/parvane/vectors/state2/*.json`
//! (ожидания руками, FR-053) — патч по полям, множества, упорядоченные списки, «удаление против правки»,
//! отметки, неизвестное, отказы. Прогон — `conformance::run("state2/<набор>")`, тот же, что зовут обвязки
//! клиентов (WASM, C ABI): каждый случай во всех перестановках, с повторами и разбиением через снимок.

mod common;

use common::*;

const SUITES: &[(&str, usize)] = &[
    ("patch", 6),
    ("sets", 4),
    ("ordered", 3),
    ("delete_vs_edit", 5),
    ("marks", 3),
    ("unknown_fields", 6),
    ("rejected", 2),
];

#[test]
fn state2_vectors() {
    for (name, least) in SUITES {
        let path = vectors_dir("state2").join(format!("{name}.json"));
        let json = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let n = parvane_protocol::conformance::run(&format!("state2/{name}"), &json).unwrap_or_else(|e| panic!("{e}"));
        assert!(n >= *least, "state2/{name}: {n} случаев");
    }
}

/// Сломанное ожидание обязано ловиться (прогон не «зелёный всегда»).
#[test]
fn state2_runner_detects_wrong_expectation() {
    let path = vectors_dir("state2").join("patch.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    v["cases"][0]["expect"]["objects"][0]["value"]["title"] = "Другое".into();
    assert!(parvane_protocol::conformance::run("state2/patch", &v.to_string()).is_err());
    v["cases"][0]["expect"]["objects"][0]["value"]["title"] = "Дела".into();
    v["cases"][0]["expect"]["rejected"] = serde_json::json!([0]);
    assert!(parvane_protocol::conformance::run("state2/patch", &v.to_string()).is_err());
}
