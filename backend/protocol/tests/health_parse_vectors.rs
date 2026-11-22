//! HEALTH-2 (spec 038): разбор свободного ввода «Здоровья» сходится с общим образцом
//! `conformance/health-parse/cases.json` — его же обязаны проходить обвязки клиентов.

use parvane_protocol::health_parse::parse_json;
use serde_json::{json, Value};

fn local_to_ms(local: &str, tz_min: i64) -> i64 {
    let (date, time) = local.split_once('T').unwrap();
    let d: Vec<i64> = date.split('-').map(|x| x.parse().unwrap()).collect();
    let t: Vec<i64> = time.split(':').map(|x| x.parse().unwrap()).collect();
    let days = parvane_protocol::domain::health::days_from_civil(d[0], d[1] as u32, d[2] as u32);
    days * 86_400_000 + (t[0] * 60 + t[1] - tz_min) * 60_000
}

#[test]
fn free_text_matches_shared_cases() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/health-parse/cases.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tz = file["tzMin"].as_i64().unwrap();
    let now = local_to_ms(file["nowLocal"].as_str().unwrap(), tz);
    let mut failed = Vec::new();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 150);
    for c in cases {
        let text = c["text"].as_str().unwrap();
        let got: Value = serde_json::from_str(&parse_json(text, now, tz as i32)).unwrap();
        // Приводим итог к виду образца: только проверяемые поля, пустые `value2`/края опускаются
        let entries: Vec<Value> = got["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let mut o = json!({"kind": e["kind"], "day": e["day"], "time": e["time"], "value": e["value"], "unit": e["unit"]});
                if e["value2"].as_f64().unwrap() != 0.0 {
                    o["value2"] = e["value2"].clone();
                }
                for k in ["endDay", "endTime", "name", "tag", "parts", "guess", "computed"] {
                    if !e[k].is_null() {
                        o[k] = e[k].clone();
                    }
                }
                assert_eq!(e["source"], "text");
                assert_eq!(e["tzMin"], json!(tz));
                o
            })
            .collect();
        let norm = |v: &Value| -> Vec<Value> {
            v.as_array().cloned().unwrap_or_default().into_iter().map(|mut e| {
                // 72 и 72.0 — одно число
                for k in ["value", "value2"] {
                    if let Some(n) = e.get(k).and_then(Value::as_f64) {
                        e[k] = json!(n);
                    }
                }
                if let Some(parts) = e.get_mut("parts").and_then(Value::as_object_mut) {
                    for v in parts.values_mut() {
                        *v = json!(v.as_f64());
                    }
                }
                e
            }).collect()
        };
        let problems: Vec<Value> = got["problems"].as_array().unwrap().iter().map(|p| p["text"].clone()).collect();
        let want_unparsed = c.get("unparsed").cloned().unwrap_or(json!([]));
        let want_problems = c.get("problems").cloned().unwrap_or(json!([]));
        if norm(&json!(entries)) != norm(&c["entries"]) || got["unparsed"] != want_unparsed || json!(problems) != want_problems {
            failed.push(format!("«{text}»\n  получено: {} | unparsed {} | problems {}\n  ожидалось: {} | unparsed {} | problems {}", json!(entries), got["unparsed"], json!(problems), c["entries"], want_unparsed, want_problems));
        }
    }
    assert!(failed.is_empty(), "расхождений: {}\n{}", failed.len(), failed.join("\n"));
}
