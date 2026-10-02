//! Общие помощники тестов векторов: загрузка/перегенерация файлов
//! `proto/parvane/vectors/<suite>/*.json`.
#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::{json, Value};

pub fn vectors_dir(suite: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../proto/parvane/vectors").join(suite)
}

/// Перегенерировать векторы: `PARVANE_REGEN_VECTORS=1 cargo test -p parvane-protocol`.
pub fn regen() -> bool {
    std::env::var("PARVANE_REGEN_VECTORS").is_ok_and(|v| v == "1")
}

/// Загрузить набор; если файла нет или включена перегенерация — записать
/// `generate()` и вернуть его.
pub fn load_or_generate(suite: &str, file: &str, generate: impl FnOnce() -> Value) -> Value {
    let path = vectors_dir(suite).join(file);
    if regen() || !path.exists() {
        let v = generate();
        std::fs::create_dir_all(vectors_dir(suite)).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
        return v;
    }
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

pub fn ok() -> Value {
    json!({"ok": true})
}

pub fn err(kind: &str) -> Value {
    json!({"error": kind})
}

/// Сравнить результат с ожиданием вектора.
pub fn check<T>(name: &str, got: &Result<T, parvane_protocol::ProtoError>, expect: &Value) {
    match (got, expect.get("error").and_then(Value::as_str)) {
        (Ok(_), None) => {}
        (Err(e), Some(k)) => assert_eq!(e.kind(), k, "вектор {name}: вид ошибки"),
        (Ok(_), Some(k)) => panic!("вектор {name}: ожидалась ошибка {k}, получен успех"),
        (Err(e), None) => panic!("вектор {name}: ожидался успех, ошибка {e:?}"),
    }
}

pub fn hexs(b: &[u8]) -> String {
    hex::encode(b)
}

pub fn unhex(v: &Value, key: &str) -> Vec<u8> {
    hex::decode(v.get(key).and_then(Value::as_str).unwrap_or("")).unwrap()
}

pub fn cases(v: &Value) -> &Vec<Value> {
    v.get("cases").and_then(Value::as_array).unwrap()
}
