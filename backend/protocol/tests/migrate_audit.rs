//! spec 035 T102 (contracts/migration.md «Видимые значения»): выгрузка сверки движка (`migrate::audit`) побайтно
//! совпадает с выгрузкой прежних клиентов на общем образце `conformance/audit/` (вход `dump-input.json`, ожидаемое
//! `dump-expected.jsonl` — то же, что сверяют web `auditDump.test.ts` и ядро `audit_dump_tests.cpp`), поэтому
//! `audit-after.jsonl` нового движка сравним с эталоном `audit-before.jsonl`.

use parvane_protocol::migrate::audit::{self, ValueSources};
use serde_json::Value;

fn conformance(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../conformance/audit/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn parse_maybe(v: &Value) -> Option<Value> {
    match v {
        Value::String(s) => serde_json::from_str(s).ok(),
        Value::Null => None,
        other => Some(other.clone()),
    }
}

#[test]
fn engine_dump_matches_shared_sample() {
    let input: Value = serde_json::from_str(&conformance("dump-input.json")).unwrap();
    let mut src = ValueSources::default();
    for r in input["rows"].as_array().unwrap() {
        src.views.push((r["view"].clone(), None, r["target"].as_str().unwrap().to_string()));
    }
    for m in input["marks"].as_array().unwrap() {
        src.marks.push((m["chatKey"].as_str().unwrap().to_string(), m.clone()));
    }
    src.own_journal = input["ownJournal"].as_array().unwrap().clone();
    src.state_snapshot = parse_maybe(&input["stateSnapshot"]);
    src.planner = parse_maybe(&input["plannerState"]);
    for c in input["cloud"].as_array().unwrap() {
        src.cloud.push((c["container"].clone(), parse_maybe(&c["state"])));
    }
    for g in input["groups"].as_array().unwrap() {
        src.groups.push((g["hex"].as_str().unwrap().to_string(), g["info"].clone()));
    }
    for d in input["deviceLogs"].as_array().unwrap() {
        src.device_logs.push((d["user"].as_str().unwrap().to_string(), d["version"].clone(), d["devices"].clone()));
    }
    src.account_keys = input["accountKeys"].clone();
    let got = audit::jsonl(&audit::build_values(&src));
    assert_eq!(got, conformance("dump-expected.jsonl"), "выгрузка движка ≠ общему образцу");
}

#[test]
fn diff_reports_lost_changed_added() {
    let l = |k: &str, key: &str, d: &str| audit::AuditLine { kind: k.into(), key: key.into(), digest: d.into() };
    let before = vec![l("message", "u:a/1", "aa"), l("message", "u:a/2", "bb"), l("chat", "u:a", "cc")];
    let after = vec![l("message", "u:a/1", "aa"), l("message", "u:a/2", "b2"), l("chat", "u:a", "cc"), l("note", "c/1", "dd")];
    let d = audit::diff(&before, &after);
    assert!(d.lost.is_empty());
    assert_eq!(d.changed, vec![("message".to_string(), "u:a/2".to_string())]);
    assert_eq!(d.added, vec![("note".to_string(), "c/1".to_string())]);
    assert!(!d.clean());
    let d = audit::diff(&after, &before);
    assert_eq!(d.lost, vec![("note".to_string(), "c/1".to_string())]);
    // JSONL — тот же порядок полей, что у web и ядра
    assert_eq!(audit::jsonl(&before[..1]), "{\"kind\":\"message\",\"key\":\"u:a/1\",\"digest\":\"aa\"}\n");
    assert_eq!(audit::parse_jsonl(&audit::jsonl(&before)), before);
}
