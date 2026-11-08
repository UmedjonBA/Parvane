//! Поддельный хост модели движка (spec 035 T062–T065): хранилище «ключ → байты» в памяти, фиксация пачек,
//! журнал того, что движок просил сделать. Через JSON-границу (`Engine::call`) — как обвязки.
#![allow(dead_code)]

use std::collections::BTreeMap;

use parvane_protocol::model::Engine;
use serde_json::{json, Value};

#[derive(Default, Clone)]
pub struct Host {
    pub store: BTreeMap<String, Vec<u8>>,
    /// Всё, что хост сделал по порядку: "batch:<id>", "commit:<id>", "req:<метод>".
    pub log: Vec<String>,
    /// Отправленные запросы (JSON `OutRequest`).
    pub sent: Vec<Value>,
}

pub fn b64d(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

pub fn b64e(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// Вызов движка с разбором JSON; ошибка — `Err(вид)`.
pub fn call(e: &mut Engine, name: &str, args: &Value) -> Result<Value, String> {
    let out: Value = serde_json::from_str(&e.call(name, &args.to_string())).unwrap();
    match out.get("error").and_then(Value::as_str) {
        Some(k) => Err(k.to_string()),
        None => Ok(out),
    }
}

/// Итог одного шага хоста: изменения, запросы, виды записей пачки.
#[derive(Default, Debug)]
pub struct Step {
    pub changes: Vec<Value>,
    pub revisions: Vec<u64>,
    pub requests: Vec<Value>,
    pub puts: Vec<String>,
    pub deletes: Vec<String>,
    pub batches: usize,
}

impl Host {
    /// Применить пачку одной транзакцией (сначала удаления, затем записи).
    pub fn apply_batch(&mut self, b: &Value) -> u64 {
        let id: u64 = b["batch_id"].as_str().map(|s| s.parse().unwrap()).or(b["batch_id"].as_u64()).unwrap_or(0);
        for d in b["deletes"].as_array().into_iter().flatten() {
            self.store.remove(d.as_str().unwrap());
        }
        for p in b["puts"].as_array().into_iter().flatten() {
            self.store.insert(p["key"].as_str().unwrap().to_string(), b64d(p["value"].as_str().unwrap_or("")));
        }
        self.log.push(format!("batch:{id}"));
        id
    }

    fn reads(&self, r: &Value) -> Value {
        let mut entries = vec![];
        for k in r["keys"].as_array().into_iter().flatten() {
            if let Some(v) = self.store.get(k.as_str().unwrap()) {
                entries.push(json!({"key": k, "value": b64e(v)}));
            }
        }
        if let Some(prefix) = r["prefix"].as_str().filter(|p| !p.is_empty()) {
            let after = r["after"].as_str().unwrap_or("");
            for (k, v) in self.store.range(prefix.to_string()..) {
                if !k.starts_with(prefix) {
                    break;
                }
                if k.as_str() > after {
                    entries.push(json!({"key": k, "value": b64e(v)}));
                }
            }
        }
        json!({"read_id": r["read_id"], "entries": entries})
    }

    /// Обработать итог движка полностью: чтения, пачку (с фиксацией и `storeCommitted`), запросы.
    /// `commit = false` — хост «умер» до фиксации пачки (пачка и её запросы теряются).
    pub fn drive(&mut self, e: &mut Engine, out: Value, commit: bool) -> Step {
        let mut st = Step::default();
        let mut queue = vec![out];
        while let Some(out) = queue.pop() {
            if let Some(d) = out.get("delta").filter(|d| !d.is_null()) {
                st.revisions.push(d["revision"].as_str().map(|s| s.parse().unwrap()).or(d["revision"].as_u64()).unwrap());
                st.changes.extend(d["changes"].as_array().cloned().unwrap_or_default());
            }
            let mut batch_id = None;
            if let Some(b) = out.get("store_batch").filter(|b| !b.is_null()) {
                if !commit {
                    return st;
                }
                for p in b["puts"].as_array().into_iter().flatten() {
                    let key = p["key"].as_str().unwrap();
                    let kind = key.split('/').nth(1).unwrap_or(key).to_string();
                    if !st.puts.contains(&kind) {
                        st.puts.push(kind);
                    }
                }
                for d in b["deletes"].as_array().into_iter().flatten() {
                    let kind = d.as_str().unwrap().split('/').nth(1).unwrap_or("").to_string();
                    if !st.deletes.contains(&kind) {
                        st.deletes.push(kind);
                    }
                }
                batch_id = Some(self.apply_batch(b));
                st.batches += 1;
            }
            // Запросы — только после фиксации пачки того же итога
            for r in out["requests"].as_array().into_iter().flatten() {
                self.log.push(format!("req:{}", r["method"].as_str().unwrap()));
                self.sent.push(r.clone());
                st.requests.push(r.clone());
            }
            for r in out["store_reads"].as_array().into_iter().flatten() {
                let loaded = self.reads(r);
                queue.push(call(e, "storeLoaded", &loaded).unwrap());
            }
            if let Some(id) = batch_id {
                self.log.push(format!("commit:{id}"));
                queue.push(call(e, "storeCommitted", &json!({"batch_id": id})).unwrap());
            }
        }
        st
    }

    /// Открыть движок над этим хранилищем (новый профиль или прежний).
    pub fn open(&mut self, cfg: &Value) -> (Engine, Step) {
        let mut cfg = cfg.clone();
        if cfg.get("device_key").is_none() {
            cfg["device_key"] = json!(b64e(&[7u8; 32]));
        }
        let mut e = Engine::open_json(&cfg.to_string()).unwrap();
        let out = call(&mut e, "start", &json!({})).unwrap();
        let st = self.drive(&mut e, out, true);
        (e, st)
    }
}

/// Ожидаемое — подмножество фактического: ключи ожидаемого объекта сравниваются, `null` — поле отсутствует
/// (proto3-JSON опускает умолчания: `false`, `0`, `""`, пустые списки), строка `"$имя"` — переменная (первое
/// вхождение связывает, следующие сравнивают).
pub fn matches(exp: &Value, act: &Value, vars: &mut BTreeMap<String, Value>, path: &str) -> Result<(), String> {
    let absent = |v: &Value| match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::String(s) => s.is_empty() || s == "0",
        Value::Array(a) => a.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::Object(o) => o.is_empty(),
    };
    match exp {
        Value::Null => {
            if absent(act) {
                Ok(())
            } else {
                Err(format!("{path}: ожидалось отсутствие, есть {act}"))
            }
        }
        Value::String(s) if s.starts_with('$') => match vars.get(s) {
            Some(v) if v == act => Ok(()),
            Some(v) => Err(format!("{path}: {s} = {v}, а здесь {act}")),
            None => {
                vars.insert(s.clone(), act.clone());
                Ok(())
            }
        },
        Value::Object(m) => {
            for (k, v) in m {
                let a = act.get(k).cloned().unwrap_or(Value::Null);
                matches(v, &a, vars, &format!("{path}.{k}"))?;
            }
            Ok(())
        }
        Value::Array(list) => {
            let a = act.as_array().cloned().unwrap_or_default();
            if a.len() != list.len() {
                return Err(format!("{path}: длина {} вместо {} — {act}", a.len(), list.len()));
            }
            for (i, (x, y)) in list.iter().zip(a.iter()).enumerate() {
                matches(x, y, vars, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Number(n) => {
            let ok = act.as_f64() == n.as_f64() || act.as_str().and_then(|s| s.parse::<f64>().ok()) == n.as_f64();
            if ok {
                Ok(())
            } else {
                Err(format!("{path}: {act} вместо {exp}"))
            }
        }
        other => {
            if other == act {
                Ok(())
            } else {
                Err(format!("{path}: {act} вместо {other}"))
            }
        }
    }
}
