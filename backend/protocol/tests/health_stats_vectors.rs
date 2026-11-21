//! HEALTH-3 п. 14: расчёты подробных экранов «Здоровья» по общему образцу `conformance/health-stats/cases.json`.

use parvane_protocol::domain::health::{self, HealthState};
use parvane_protocol::domain::health_form::entries_json;
use parvane_protocol::domain::health_json::op_from_json;
use parvane_protocol::domain::health_view::view_json;
use parvane_protocol::domain::Stamp;
use serde_json::{json, Value};

const DAY_MS: i64 = 86_400_000;

fn moment(at: &Value, now_ms: i64, tz_min: i32) -> i64 {
    let tz_ms = i64::from(tz_min) * 60_000;
    let midnight = (now_ms + tz_ms).div_euclid(DAY_MS) * DAY_MS - tz_ms;
    let part = |i: usize| at[i].as_i64().expect("число");
    midnight + part(0) * DAY_MS + (part(1) * 60 + part(2)) * 60_000
}

fn state_of(case: &Value, now_ms: i64, tz_min: i32) -> HealthState {
    let mut changes = Vec::new();
    for (i, e) in case["entries"].as_array().into_iter().flatten().enumerate() {
        let (at_ms, end_ms) = match (&e["from"], &e["to"]) {
            (Value::Array(_), Value::Array(_)) => (moment(&e["from"], now_ms, tz_min), moment(&e["to"], now_ms, tz_min)),
            _ => (moment(&e["at"], now_ms, tz_min), 0),
        };
        let value = if end_ms != 0 { json!((end_ms - at_ms) / 60_000) } else { e["value"].clone() };
        changes.push(json!({"entry": {
            "id": format!("e{i:03}"), "kind": e["kind"], "atMs": at_ms, "endMs": end_ms, "tzMin": tz_min, "value": value,
            "value2": e.get("value2").cloned().unwrap_or(json!(0)), "unit": "", "source": "text",
            "tag": e.get("tag").cloned().unwrap_or(json!("")), "note": e.get("note").cloned().unwrap_or(json!("")),
        }}));
    }
    for (id, target) in case["goals"].as_object().into_iter().flatten() {
        changes.push(json!({"goal": {"id": id, "target": target}}));
    }
    let mut state = HealthState::default();
    let mut op = op_from_json(&json!({ "changes": changes }).to_string()).expect("изменения образца");
    health::stamp_op(&mut op, &Stamp::new(1, "d1"));
    state.apply_op(&op, "d1").expect("применение");
    state
}

fn at_path<'a>(root: &'a Value, path: &str) -> &'a Value {
    path.split('.').fold(root, |v, key| match key.parse::<usize>() {
        Ok(i) => &v[i],
        Err(_) => &v[key],
    })
}

fn same(got: &Value, want: &Value) -> bool {
    match (got.as_f64(), want.as_f64()) {
        (Some(a), Some(b)) => (a - b).abs() < 1e-9,
        _ => got == want,
    }
}

#[test]
fn health_stats_follow_the_shared_sample() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/health-stats/cases.json");
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("образец")).expect("JSON образца");
    let now_ms = sample["nowMs"].as_i64().expect("nowMs");
    let tz_min = sample["tzMin"].as_i64().expect("tzMin") as i32;
    let cases = sample["cases"].as_array().expect("cases");
    assert!(cases.len() >= 6, "образец урезан: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let state = state_of(case, now_ms, tz_min);
        for (target, checks) in case["expect"].as_object().expect("expect") {
            let got: Value = match target.strip_prefix("entries:") {
                Some(kind) => serde_json::from_str(&entries_json(&state, kind, 30, now_ms, tz_min)).expect("страница"),
                None => serde_json::from_str(&view_json(&state, now_ms, tz_min)).expect("сводка"),
            };
            for (path, want) in checks.as_object().expect("проверки") {
                let value = at_path(&got, path);
                assert!(same(value, want), "{name}: {target} {path} = {value}, ждали {want}");
            }
        }
    }
}
