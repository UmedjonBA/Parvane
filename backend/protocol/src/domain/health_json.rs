//! JSON «Здоровья» для хостов (spec 038): сведённое состояние и изменения.
//!
//! Состояние: `{headSeq, sizeBytes, entries:[{id, kind, atMs, endMs, tzMin, day, value, value2, unit, source,
//! note, name, tag, parts:{<имя>: число}}], goals:{<имя>: число}}` — только живое; `day` считает движок (`health::entry_day`), записи идут по
//! времени. Изменения: `{"changes":[{"entry":{…}}, {"entry":{"id":…, "deleted":true}}, {"goal":{"id":…,
//! "target":…}}, {"goal":{"id":…, "deleted":true}}]}` — метки ставит движок (`health::stamp_op`).

use serde_json::{json, Map, Value};

use super::health::{self, HealthState};
use crate::error::{ProtoError, Result};
use crate::pb::parvane::health::v1::{change, Change, Entry, Goal, HealthOp, Part};

pub fn entry_json(e: &Entry) -> Value {
    let parts: Map<String, Value> = e.parts.iter().map(|p| (p.key.clone(), json!(p.value))).collect();
    json!({
        "id": e.id, "kind": e.kind, "atMs": e.at_ms, "endMs": e.end_ms, "tzMin": e.tz_min, "day": health::entry_day(e),
        "value": e.value, "value2": e.value2, "unit": e.unit, "source": e.source, "note": e.note,
        "name": e.name, "tag": e.tag, "parts": parts,
    })
}

/// `parts` изменения: объект «имя → число»; `null` и отсутствие числа — «не задано». Порядок — по имени.
fn parts_of(o: &Map<String, Value>) -> Result<Vec<Part>> {
    let bad = || ProtoError::InvalidField("parts");
    match o.get("parts") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(m)) => {
            let mut parts = Vec::with_capacity(m.len());
            for (key, v) in m {
                if v.is_null() {
                    continue;
                }
                parts.push(Part { key: key.clone(), value: v.as_f64().filter(|n| n.is_finite()).ok_or_else(bad)? });
            }
            parts.sort_by(|a, b| a.key.cmp(&b.key));
            Ok(parts)
        }
        Some(_) => Err(bad()),
    }
}

pub fn state_json(state: &HealthState, head_seq: u64) -> String {
    let mut entries: Vec<&Entry> = state.live_entries().collect();
    entries.sort_by(|a, b| (a.at_ms, &a.id).cmp(&(b.at_ms, &b.id)));
    let goals: Map<String, Value> = state.live_goals().map(|g| (g.id.clone(), json!(g.target))).collect();
    json!({
        "headSeq": head_seq,
        "sizeBytes": state.snapshot_size(),
        "entries": entries.into_iter().map(entry_json).collect::<Vec<_>>(),
        "goals": goals,
    })
    .to_string()
}

fn id_of(o: &Map<String, Value>) -> Result<String> {
    o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).ok_or(ProtoError::InvalidField("id"))
}

fn is_deleted(o: &Map<String, Value>) -> bool {
    o.get("deleted").and_then(Value::as_bool).unwrap_or(false)
}

fn num(o: &Map<String, Value>, key: &'static str) -> Result<f64> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => v.as_f64().filter(|n| n.is_finite()).ok_or(ProtoError::InvalidField(key)),
    }
}

fn int(o: &Map<String, Value>, key: &'static str) -> Result<i64> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(v) => v.as_i64().or_else(|| v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0).map(|n| n as i64)).ok_or(ProtoError::InvalidField(key)),
    }
}

fn text(o: &Map<String, Value>, key: &'static str) -> Result<String> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(v) => v.as_str().map(str::to_string).ok_or(ProtoError::InvalidField(key)),
    }
}

pub fn entry_of(o: &Map<String, Value>) -> Result<Entry> {
    let id = id_of(o)?;
    if is_deleted(o) {
        return Ok(Entry { id, deleted: Some(Default::default()), ..Default::default() });
    }
    let e = Entry {
        id,
        kind: text(o, "kind")?,
        at_ms: int(o, "atMs")?,
        end_ms: int(o, "endMs")?,
        tz_min: i32::try_from(int(o, "tzMin")?).map_err(|_| ProtoError::InvalidField("tzMin"))?,
        value: num(o, "value")?,
        value2: num(o, "value2")?,
        unit: text(o, "unit")?,
        source: text(o, "source")?,
        note: text(o, "note")?,
        name: text(o, "name")?,
        tag: text(o, "tag")?,
        parts: parts_of(o)?,
        ..Default::default()
    };
    // Локальная правка проверяется сразу: негодное не уходит в журнал
    let mut probe = e.clone();
    probe.stamp = Some(crate::pb::parvane::core::v2::LwwStamp { lamport: 1, device_id: "x".into() });
    health::check_entry(&probe)?;
    Ok(e)
}

fn goal_of(o: &Map<String, Value>) -> Result<Goal> {
    let id = id_of(o)?;
    if is_deleted(o) {
        return Ok(Goal { id, deleted: Some(Default::default()), ..Default::default() });
    }
    let g = Goal { id, target: num(o, "target")?, ..Default::default() };
    let mut probe = g.clone();
    probe.stamp = Some(crate::pb::parvane::core::v2::LwwStamp { lamport: 1, device_id: "x".into() });
    health::check_goal(&probe)?;
    Ok(g)
}

pub fn op_from_json(text: &str) -> Result<HealthOp> {
    let v: Value = serde_json::from_str(text).map_err(|_| ProtoError::Malformed)?;
    let items = v.get("changes").and_then(Value::as_array).ok_or(ProtoError::InvalidField("changes"))?;
    if items.is_empty() || items.len() > 500 {
        return Err(ProtoError::InvalidField("changes"));
    }
    let mut changes = Vec::with_capacity(items.len());
    for item in items {
        let o = item.as_object().ok_or(ProtoError::Malformed)?;
        let (kind, body) = o.iter().next().ok_or(ProtoError::Malformed)?;
        let body = body.as_object().ok_or(ProtoError::Malformed)?;
        let c = match kind.as_str() {
            "entry" => change::Change::Entry(entry_of(body)?),
            "goal" => change::Change::Goal(goal_of(body)?),
            _ => return Err(ProtoError::InvalidField("changes")),
        };
        changes.push(Change { change: Some(c) });
    }
    Ok(HealthOp { changes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Stamp;

    const T: i64 = 1_794_000_000_000;

    fn apply(st: &mut HealthState, text: &str, lamport: u64, dev: &str) {
        let mut op = op_from_json(text).unwrap();
        health::stamp_op(&mut op, &Stamp::new(lamport, dev));
        st.apply_op(&op, dev).unwrap();
    }

    #[test]
    fn entries_goals_and_tombstones_roundtrip() {
        let mut st = HealthState::default();
        apply(
            &mut st,
            &format!(
                r#"{{"changes":[{{"entry":{{"id":"a1","kind":"weight","atMs":{T},"tzMin":180,"value":72.4,"unit":"kg","source":"text"}}}},
                {{"entry":{{"id":"w1","kind":"water","atMs":{},"tzMin":180,"value":250,"unit":"ml","source":"manual"}}}},
                {{"goal":{{"id":"water_ml","target":2000}}}}]}}"#,
                T + 1000
            ),
            1,
            "d1",
        );
        // Вторая прибавка воды с другого устройства — отдельная запись, ничего не затирает
        apply(&mut st, &format!(r#"{{"changes":[{{"entry":{{"id":"w2","kind":"water","atMs":{},"tzMin":180,"value":300,"unit":"ml"}}}}]}}"#, T + 2000), 1, "d2");
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["entries"].as_array().unwrap().len(), 3);
        assert_eq!(out["entries"][0]["kind"], "weight");
        assert_eq!(out["entries"][0]["day"], health::day_of(T, 180));
        assert_eq!(out["goals"]["water_ml"], json!(2000.0));
        let water: f64 = out["entries"].as_array().unwrap().iter().filter(|e| e["kind"] == "water").map(|e| e["value"].as_f64().unwrap()).sum();
        assert_eq!(water, 550.0);
        // Удаление записи и цели
        apply(&mut st, r#"{"changes":[{"entry":{"id":"w1","deleted":true}},{"goal":{"id":"water_ml","deleted":true}}]}"#, 2, "d1");
        let out: Value = serde_json::from_str(&state_json(&st, 3)).unwrap();
        assert_eq!(out["entries"].as_array().unwrap().len(), 2);
        assert!(out["goals"].as_object().unwrap().is_empty());
        assert_eq!(st.entries.len(), 3, "надгробие хранится");
    }

    #[test]
    fn bad_local_changes_are_refused() {
        for bad in [
            r#"{"changes":[]}"#,
            r#"{"changes":[{"entry":{"id":"a","kind":"Weight","atMs":1794000000000}}]}"#,
            r#"{"changes":[{"entry":{"id":"a","kind":"weight","atMs":1794000000}}]}"#,
            r#"{"changes":[{"entry":{"id":"a","kind":"sleep","atMs":1794000000000,"endMs":1793000000000}}]}"#,
            r#"{"changes":[{"entry":{"id":"a","kind":"weight","atMs":1794000000000,"tzMin":900}}]}"#,
            r#"{"changes":[{"goal":{"id":"steps","target":-1}}]}"#,
            r#"{"changes":[{"food":{"id":"a"}}]}"#,
        ] {
            assert!(op_from_json(bad).is_err(), "{bad}");
        }
    }
}
