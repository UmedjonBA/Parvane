//! spec 035 T065 (FR-006): изменения модели. Хост применяет `ModelDelta` по порядку; повтор того же изменения
//! не меняет показ; ревизия растёт ровно на 1 с каждым непустым изменением; повтор того же ввода не даёт
//! нового изменения.

mod model_common;

use std::collections::BTreeMap;

use model_common::{call, Host};
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;

/// Показ хоста: строки, чаты, счётчики, объекты состояния.
#[derive(Default, Debug, PartialEq, Clone)]
struct Shown {
    messages: BTreeMap<String, Value>,
    chats: BTreeMap<String, Value>,
    unread: BTreeMap<String, Value>,
    state: BTreeMap<String, Value>,
}

impl Shown {
    fn apply(&mut self, delta: &Value) {
        for c in delta["changes"].as_array().into_iter().flatten() {
            if let Some(m) = c.get("message_upsert") {
                self.messages.insert(m["id"].as_str().unwrap().into(), m.clone());
            } else if let Some(m) = c.get("message_remove") {
                self.messages.remove(m["id"].as_str().unwrap());
            } else if let Some(v) = c.get("chat_upsert") {
                self.chats.insert(v["chat"].to_string(), v.clone());
            } else if let Some(v) = c.get("unread_changed") {
                self.unread.insert(v["chat"].to_string(), v.get("count").cloned().unwrap_or(json!(0)));
            } else if let Some(v) = c.get("state_changed") {
                let k = v["object"].to_string();
                match v.get("view") {
                    Some(view) => self.state.insert(k, view.clone()),
                    None => self.state.remove(&k),
                };
            }
        }
    }
}

fn rev(d: &Value) -> u64 {
    d["revision"].as_str().map(|s| s.parse().unwrap()).or(d["revision"].as_u64()).unwrap()
}

#[test]
fn replayed_delta_is_idempotent_and_revision_steps_by_one() {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    let bob = json!({"user": {"address": "bob@local"}});
    let inputs = vec![
        ("vectorInput", json!({"incoming": {"chat": bob, "from": "bob@local", "id": "01".repeat(16), "ts_ms": NOW, "content": {"text": {"text": "раз"}}}})),
        ("vectorInput", json!({"incoming": {"chat": bob, "from": "bob@local", "id": "02".repeat(16), "ts_ms": NOW, "content": {"text": {"text": "два"}}}})),
        ("vectorInput", json!({"incoming": {"chat": bob, "from": "bob@local", "id": "03".repeat(16), "ts_ms": NOW, "content": {"reaction": {"target": {"op_id": model_common::b64e(&[1; 16])}, "emoji": "👍"}}}})),
        ("submit", json!({"state_create": {"object": {"kind": "OBJECT_KIND_ARCHIVE", "key": "u:bob@local"}}})),
        ("submit", json!({"delete_messages": {"chat": bob, "targets": [model_common::b64e(&[2; 16])], "scope": "DELETE_SCOPE_ME"}})),
        ("submit", json!({"state_delete": {"object": {"kind": "OBJECT_KIND_ARCHIVE", "key": "u:bob@local"}}})),
    ];
    let mut shown = Shown::default();
    let mut last_rev = e.revision();
    let mut deltas = vec![];
    for (name, args) in &inputs {
        let out = call(&mut e, name, args).unwrap();
        let st = host.drive(&mut e, out.clone(), true);
        if let Some(d) = out.get("delta").filter(|d| !d.is_null()) {
            assert_eq!(rev(d), last_rev + 1, "{name}: ревизия +1");
            last_rev = rev(d);
            shown.apply(d);
            let once = shown.clone();
            shown.apply(d);
            assert_eq!(shown, once, "{name}: повтор того же изменения не меняет показ");
            deltas.push(d.clone());
        }
        let _ = st;
    }
    assert_eq!(deltas.len(), inputs.len(), "каждый ввод дал изменение");
    assert_eq!(shown.messages.len(), 1, "осталась строка 01 (02 удалена у себя): {:?}", shown.messages.keys());
    let m = shown.messages.values().next().unwrap();
    assert_eq!(m["reactions"][0]["emoji"], json!("👍"));
    assert!(shown.state.is_empty());

    // Тот же ввод повторно — без изменений и без роста ревизии
    let before = e.revision();
    for (name, args) in inputs.iter().take(3) {
        let out = call(&mut e, name, args).unwrap();
        assert!(out.get("delta").is_none_or(Value::is_null), "{name}: повтор ввода без изменения: {out}");
    }
    assert_eq!(e.revision(), before);

    // Весь поток изменений, применённый дважды подряд, даёт тот же показ
    let mut a = Shown::default();
    let mut b = Shown::default();
    for d in &deltas {
        a.apply(d);
        b.apply(d);
        b.apply(d);
    }
    assert_eq!(a, b);
}
