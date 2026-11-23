//! Импорт «Здоровья» из выгрузки Health Connect: тестовая база (выдуманные данные, страницы по 1 КБ — внутренние
//! страницы B-дерева и переполнение) — `tests/fixtures/make_health_connect.py`.

use std::collections::BTreeSet;

use parvane_protocol::health_import::{import, import_json, ImportError};
use serde_json::{json, Value};

const DB: &[u8] = include_bytes!("fixtures/health_connect_export.db");

fn of_kind<'a>(entries: &'a [Value], kind: &str) -> Vec<&'a Value> {
    entries.iter().filter(|e| e["kind"] == kind).collect()
}

#[test]
fn health_connect_export_becomes_health_entries() {
    let r = import(DB, &BTreeSet::new()).unwrap();
    let counts: Vec<(&str, usize)> = r.counts.iter().map(|(k, v)| (*k, *v)).collect();
    assert_eq!(counts, [("pressure", 1), ("pulse", 1), ("sleep", 1), ("steps", 30), ("water", 1), ("weight", 30), ("workout", 1)]);
    let e = &r.entries;
    assert!(e.iter().all(|x| x["source"] == "import.health_connect" && x["tzMin"] == 180));

    let weight = of_kind(e, "weight");
    assert_eq!((weight[0]["value"].clone(), weight[0]["unit"].clone()), (json!(72.4), json!("kg")), "граммы → кг");
    let bp = of_kind(e, "pressure")[0];
    assert_eq!((bp["value"].clone(), bp["value2"].clone()), (json!(121.0), json!(79.0)));

    // Два приложения пишут одни шаги: у дня больший итог одного (5000), а не сумма (9500)
    assert!(of_kind(e, "steps").iter().all(|s| s["value"] == json!(5000.0)));
    assert_eq!(of_kind(e, "steps")[0]["id"], "hc-steps-2026-10-26", "итог дня — по местному дню");

    let sleep = of_kind(e, "sleep")[0];
    assert_eq!((sleep["value"].clone(), sleep["unit"].clone()), (json!(480.0), json!("min")));
    assert_eq!(sleep["parts"], json!({"awake": 30.0, "deep": 90.0, "light": 300.0, "rem": 60.0}), "стадии сна — минуты");

    let run = of_kind(e, "workout")[0];
    assert_eq!((run["tag"].clone(), run["value"].clone()), (json!("run"), json!(45.0)));
    let name = run["name"].as_str().unwrap();
    assert!(name.starts_with("Пробежка по набережной") && name.len() <= 120 && name.len() > 100, "длинное название (переполнение страницы) прочитано и обрезано по байтам: {name}");

    assert_eq!(of_kind(e, "water")[0]["value"], json!(750.0), "три стакана по 0,25 л");
    // Отсчёты 60…100, затем 60…78: среднее 76,5 → 77
    let pulse = of_kind(e, "pulse")[0];
    assert_eq!((pulse["value"].clone(), pulse["parts"].clone()), (json!(77.0), json!({"min": 60.0, "max": 100.0})));
    assert_eq!((r.first_day.as_deref(), r.last_day.as_deref()), (Some("2026-10-26"), Some("2026-11-24")));
}

#[test]
fn reimport_skips_known_entries_and_wrong_files_are_refused() {
    let first = import(DB, &BTreeSet::new()).unwrap();
    let known: BTreeSet<String> = first.entries.iter().map(|e| e["id"].as_str().unwrap().to_string()).collect();
    assert!(import(DB, &known).unwrap().entries.is_empty(), "повторный импорт не дублирует и не воскрешает удалённое");
    assert_eq!(import(b"PK\x03\x04 zip, not a database", &BTreeSet::new()).err(), Some(ImportError::NotExport));
    let half = &DB[..DB.len() / 2];
    assert!(import(half, &BTreeSet::new()).is_err(), "обрезанная база — ошибка, а не зависание");
    assert_eq!(import_json(b"nonsense", &BTreeSet::new())["error"], "not_export");
}

#[test]
fn every_imported_entry_passes_the_domain_check() {
    use parvane_protocol::domain::{health, health_json};
    let r = import(DB, &BTreeSet::new()).unwrap();
    let changes: Vec<Value> = r.entries.iter().map(|e| json!({"entry": e})).collect();
    let op = health_json::op_from_json(&json!({ "changes": changes }).to_string()).unwrap();
    for c in &op.changes {
        if let Some(parvane_protocol::pb::parvane::health::v1::change::Change::Entry(e)) = &c.change {
            if let Err(err) = health::check_entry(e) {
                panic!("запись {} ({}): {err:?}", e.id, e.kind);
            }
        }
    }
}
