//! spec 035 T062: векторы модели движка `proto/parvane/vectors/model/*.json` (contracts/engine-api.md «Векторы»)
//! через JSON-границу `Engine::call` — так же их прогоняют обвязки (web `modelVectors.test.ts`, ядро
//! `model_vectors_tests.cpp`, android `ModelVectorsTest.kt`). Ожидания написаны руками.
//!
//! Шаг вектора — одно из `submit` (намерение), `input` (ввод векторов: входящее, операции истории, группа),
//! `historyPage`/`chatList`/`capabilities`/`viewState`/`viewGroup` (чтение). Ожидания шага: `changes` — изменения
//! модели по порядку (каждое — подмножество фактического), `requests` — методы запросов по порядку (включая
//! выпущенные после фиксации пачки), `puts` — виды записей, которые обязаны быть в пачке, `error` — вид ошибки,
//! `result` — подмножество ответа чтения. Ревизия растёт на 1 с каждым непустым изменением.

mod model_common;

use std::collections::BTreeMap;

use model_common::{call, matches, Host};
use serde_json::{json, Value};

const SUITES: &[&str] = &[
    "send_direct",
    "delete_everyone_direct",
    "delete_me",
    "edit_before_row",
    "state_patch_folder",
    "group_perms_media",
    "unknown_content_stub",
    "features_text_fallback",
    "history_paging",
    "fave_sticker",
];

fn load(name: &str) -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/parvane/vectors/model").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("нет {}", p.display()))).unwrap()
}

fn run_case(suite: &str, case: &Value) {
    let cname = format!("{suite} / {}", case["name"].as_str().unwrap());
    let mut cfg = case["config"].clone();
    cfg["vectors"] = json!(true);
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg);
    let mut vars = BTreeMap::new();
    let mut revision = e.revision();
    for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{cname} шаг {i}");
        let exp = &step["expect"];
        let (name, args) = step
            .as_object()
            .unwrap()
            .iter()
            .find(|(k, _)| k.as_str() != "expect")
            .map(|(k, v)| (k.as_str(), v.clone()))
            .unwrap();
        let call_name = match name {
            "input" => "vectorInput",
            n => n,
        };
        let out = call(&mut e, call_name, &args);
        if let Some(err) = exp.get("error").and_then(Value::as_str) {
            assert_eq!(out.as_ref().err().map(String::as_str), Some(err), "{at}: ожидалась ошибка");
            continue;
        }
        let out = out.unwrap_or_else(|k| panic!("{at}: ошибка {k}"));
        if let Some(res) = exp.get("result") {
            matches(res, &out, &mut vars, &at).unwrap_or_else(|m| panic!("{m}\nответ: {out}"));
            continue;
        }
        let st = host.drive(&mut e, out, true);
        for r in &st.revisions {
            assert_eq!(*r, revision + 1, "{at}: ревизия растёт на 1");
            revision = *r;
        }
        if let Some(ch) = exp.get("changes") {
            matches(ch, &Value::Array(st.changes.clone()), &mut vars, &format!("{at} changes"))
                .unwrap_or_else(|m| panic!("{m}\nизменения: {}", serde_json::to_string_pretty(&st.changes).unwrap()));
        }
        if let Some(rq) = exp.get("requests") {
            let methods: Vec<Value> = st.requests.iter().map(|r| r["method"].clone()).collect();
            assert_eq!(&Value::Array(methods), rq, "{at}: запросы");
        }
        if let Some(Value::Array(puts)) = exp.get("puts") {
            for p in puts {
                assert!(st.puts.iter().any(|k| Some(k.as_str()) == p.as_str()), "{at}: в пачке нет {p}: {:?}", st.puts);
            }
        }
    }
}

#[test]
fn model_vectors() {
    let mut n = 0;
    for s in SUITES {
        let v = load(s);
        assert_eq!(v["suite"], json!(format!("model/{s}")));
        for case in v["cases"].as_array().unwrap() {
            run_case(s, case);
            n += 1;
        }
    }
    assert!(n >= 13, "векторов модели: {n}");
}

/// Перенос `contentMap.ts` (класс содержимого и формат строки) сверяется с общими векторами `content/kinds.json`
/// (`client.v1` — подмножество строки web).
#[test]
fn content_kinds_match_web_mapping() {
    use parvane_protocol::model::views;
    use parvane_protocol::pb::parvane::msg::v2::Content;
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto/parvane/vectors/content/kinds.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let mut checked = 0;
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = hex::decode(case["input"]["content_hex"].as_str().unwrap()).unwrap();
        let Ok(c) = parvane_protocol::codec::decode_checked::<Content>(&bytes, parvane_protocol::limits::Origin::Client) else { continue };
        let critical: Vec<u32> = case["input"]["critical_fields"].as_array().into_iter().flatten().map(|n| n.as_u64().unwrap() as u32).collect();
        let shown = parvane_protocol::unknown::content_disposition(&c, &critical) == parvane_protocol::unknown::Disposition::Show;
        let class = match views::class_of(&c) {
            _ if !shown => "stub",
            views::Class::Message => "message",
            views::Class::Mutation => "mutation",
            views::Class::Service => "service",
            views::Class::Stub => "stub",
        };
        if let Some(want) = case["client"]["class"].as_str() {
            assert_eq!(class, want, "{name}: класс");
        }
        if let Some(want) = case["client"].get("v1").filter(|_| shown) {
            let got = views::content_to_wire(&c).unwrap();
            let mut vars = BTreeMap::new();
            matches(want, &got, &mut vars, name).unwrap_or_else(|m| panic!("{m}\nстрока: {got}"));
        }
        checked += 1;
    }
    assert!(checked > 30, "сверено {checked}");
}
