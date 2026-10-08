//! JSON планировщика для хостов (spec 010): компактное сведённое состояние
//! (только живые объекты, значения без меток) и разбор изменений от хоста
//! (присутствующее поле — правка регистра, `null` у числа — «не задано»,
//! `deleted: true` — надгробие). Метки хост не ставит — их проставляет движок
//! (`planner::stamp_op`). Формат — один для web (WASM) и нативных хостов (C ABI).
//!
//! Состояние:
//! `{tasks:[{id,name,description,steps:[{text,isDone}],status,listId,rank,day,start,due,minutes|null}],
//!   events:[{id,name,start,end,weekdays:[…]|null,day}], lists:[{id,name,order}],
//!   nutrition:[{day,entries:[{id,name,meal,kcal,protein|null,fat|null,carbs|null,fiber|null,grams|null,per100}],
//!     isComplete,fixedGoals|null,waterMl|null}], settings|null, goals|null}`
//! Изменения: `{changes:[{task:{…}}|{event:{…}}|{list:{…}}|{nutritionDay:{…}}|{settings:{…}}|{goals:{…}}|{migration:{…}}]}`.

use serde_json::{json, Map, Value};

use super::planner::PlannerState;
use crate::error::{ProtoError, Result};
use crate::pb::parvane::planner::v1::{
    change, Bool, Change, Event, FoodEntry, Goal, GoalSet, List, Migration, NutritionDay, PlannerOp, Settings, Step, Steps,
    Str, Task, Weekdays, I32, U32,
};

const KNOWN_KCAL: u32 = 1;
const KNOWN_PROTEIN: u32 = 2;
const KNOWN_FAT: u32 = 4;
const KNOWN_CARBS: u32 = 8;
const KNOWN_FIBER: u32 = 16;
const KNOWN_GRAMS: u32 = 32;

// ── состояние → JSON ────────────────────────────────────────────────────────

fn sv(f: &Option<Str>) -> Value {
    Value::String(f.as_ref().map(|s| s.value.clone()).unwrap_or_default())
}

fn goal_json(g: &Option<Goal>) -> Value {
    g.as_ref().map(|g| json!({"target": g.target, "tolerance": g.tolerance})).unwrap_or(Value::Null)
}

fn goals_json(g: &GoalSet) -> Value {
    json!({"kcal": goal_json(&g.kcal), "protein": goal_json(&g.protein), "fat": goal_json(&g.fat), "carbs": goal_json(&g.carbs)})
}

fn entry_json(e: &FoodEntry) -> Value {
    let num = |bit: u32, v: f64| if e.known & bit != 0 { json!(v) } else { Value::Null };
    json!({
        "id": e.id, "name": e.name, "meal": e.meal,
        "kcal": if e.known & KNOWN_KCAL != 0 { e.kcal } else { 0.0 },
        "protein": num(KNOWN_PROTEIN, e.protein), "fat": num(KNOWN_FAT, e.fat), "carbs": num(KNOWN_CARBS, e.carbs),
        "fiber": num(KNOWN_FIBER, e.fiber), "grams": num(KNOWN_GRAMS, e.grams), "per100": e.per100,
    })
}

/// Сведённое состояние → JSON для хоста (только живые объекты).
pub fn state_json(state: &PlannerState, head_seq: u64) -> String {
    let tasks: Vec<Value> = state
        .tasks
        .values()
        .filter(|t| PlannerState::is_task_alive(t))
        .map(|t| {
            json!({
                "id": t.id, "name": sv(&t.name), "description": sv(&t.description),
                "steps": t.steps.as_ref().map(|s| s.items.iter().map(|i| json!({"text": i.text, "isDone": i.is_done})).collect::<Vec<_>>()).unwrap_or_default(),
                "status": t.status.as_ref().map(|s| s.value.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "queue".into()),
                "listId": sv(&t.list_id), "rank": t.rank.as_ref().map(|r| r.value).unwrap_or(0),
                "day": sv(&t.day), "start": sv(&t.start), "due": sv(&t.due),
                "minutes": t.minutes.as_ref().filter(|m| !m.unset).map(|m| json!(m.value)).unwrap_or(Value::Null),
            })
        })
        .collect();
    let events: Vec<Value> = state
        .events
        .values()
        .filter(|e| PlannerState::is_event_alive(e))
        .map(|e| {
            json!({
                "id": e.id, "name": sv(&e.name), "start": sv(&e.start), "end": sv(&e.end),
                "weekdays": e.weekdays.as_ref().map(|w| json!(w.days)).unwrap_or(Value::Null), "day": sv(&e.day),
            })
        })
        .collect();
    let lists: Vec<Value> = state
        .lists
        .values()
        .filter(|l| PlannerState::is_list_alive(l))
        .map(|l| json!({"id": l.id, "name": sv(&l.name), "order": l.order.as_ref().map(|o| o.value).unwrap_or(0)}))
        .collect();
    let nutrition: Vec<Value> = state
        .nutrition
        .values()
        .map(|d| {
            json!({
                "day": d.day,
                "entries": d.entries.iter().filter(|e| PlannerState::is_entry_alive(e)).map(entry_json).collect::<Vec<_>>(),
                "isComplete": d.is_complete.as_ref().map(|b| b.value).unwrap_or(false),
                "fixedGoals": d.fixed_goals.as_ref().map(goals_json).unwrap_or(Value::Null),
                "waterMl": d.water_ml.as_ref().filter(|w| !w.unset).map(|w| json!(w.value)).unwrap_or(Value::Null),
            })
        })
        .collect();
    let settings = state.settings.as_ref().map(|s| {
        json!({"dayStart": s.day_start, "dayEnd": s.day_end, "lunchStart": s.lunch_start, "lunchEnd": s.lunch_end, "margin": s.margin, "budget": s.budget})
    });
    json!({
        "tasks": tasks, "events": events, "lists": lists, "nutrition": nutrition,
        "settings": settings.unwrap_or(Value::Null), "goals": state.goals.as_ref().map(goals_json).unwrap_or(Value::Null),
        "headSeq": head_seq, "sizeBytes": state.size_estimate(),
    })
    .to_string()
}

// ── JSON → изменения ────────────────────────────────────────────────────────

fn str_field(o: &Map<String, Value>, key: &str) -> Result<Option<Str>> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(Str { stamp: None, value: s.clone() })),
        Some(Value::Null) => Ok(Some(Str { stamp: None, value: String::new() })),
        Some(_) => Err(ProtoError::Malformed),
    }
}

fn u32_field(o: &Map<String, Value>, key: &str) -> Result<Option<U32>> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(U32 { stamp: None, value: 0, unset: true })),
        Some(v) => {
            let n = v.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= u32::MAX as f64).ok_or(ProtoError::Malformed)?;
            Ok(Some(U32 { stamp: None, value: n.round() as u32, unset: false }))
        }
    }
}

fn i32_field(o: &Map<String, Value>, key: &str) -> Result<Option<I32>> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(I32 { stamp: None, value: v.as_i64().ok_or(ProtoError::Malformed)?.clamp(i32::MIN as i64, i32::MAX as i64) as i32 })),
    }
}

fn required_u32(v: &Value, key: &str) -> Result<u32> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n.round() as u32).ok_or(ProtoError::InvalidField("settings"))
}

fn id_of(o: &Map<String, Value>) -> Result<String> {
    o.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).ok_or(ProtoError::InvalidField("id"))
}

fn deleted_of(o: &Map<String, Value>) -> Option<crate::pb::parvane::core::v2::LwwStamp> {
    o.get("deleted").and_then(Value::as_bool).filter(|d| *d).map(|_| Default::default())
}

fn goal_of(v: Option<&Value>) -> Result<Option<Goal>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(Goal { target: required_u32(v, "target")?, tolerance: required_u32(v, "tolerance")? })),
    }
}

fn goals_of(v: &Value) -> Result<GoalSet> {
    Ok(GoalSet { stamp: None, kcal: goal_of(v.get("kcal"))?, protein: goal_of(v.get("protein"))?, fat: goal_of(v.get("fat"))?, carbs: goal_of(v.get("carbs"))? })
}

fn task_of(o: &Map<String, Value>) -> Result<Task> {
    let steps = match o.get("steps") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(Steps {
            stamp: None,
            items: items
                .iter()
                .map(|i| Ok(Step { text: i.get("text").and_then(Value::as_str).ok_or(ProtoError::Malformed)?.to_string(), is_done: i.get("isDone").and_then(Value::as_bool).unwrap_or(false) }))
                .collect::<Result<Vec<_>>>()?,
        }),
        Some(_) => return Err(ProtoError::Malformed),
    };
    Ok(Task {
        id: id_of(o)?,
        name: str_field(o, "name")?,
        description: str_field(o, "description")?,
        steps,
        status: str_field(o, "status")?,
        list_id: str_field(o, "listId")?,
        rank: i32_field(o, "rank")?,
        day: str_field(o, "day")?,
        start: str_field(o, "start")?,
        due: str_field(o, "due")?,
        minutes: u32_field(o, "minutes")?,
        deleted: deleted_of(o),
    })
}

fn event_of(o: &Map<String, Value>) -> Result<Event> {
    let weekdays = match o.get("weekdays") {
        None => None,
        Some(Value::Null) => Some(Weekdays { stamp: None, days: vec![] }),
        Some(Value::Array(days)) => Some(Weekdays { stamp: None, days: days.iter().map(|d| d.as_u64().map(|d| d as u32).ok_or(ProtoError::Malformed)).collect::<Result<Vec<_>>>()? }),
        Some(_) => return Err(ProtoError::Malformed),
    };
    Ok(Event { id: id_of(o)?, name: str_field(o, "name")?, start: str_field(o, "start")?, end: str_field(o, "end")?, weekdays, day: str_field(o, "day")?, deleted: deleted_of(o) })
}

fn list_of(o: &Map<String, Value>) -> Result<List> {
    Ok(List { id: id_of(o)?, name: str_field(o, "name")?, order: i32_field(o, "order")?, deleted: deleted_of(o) })
}

fn entry_of(o: &Map<String, Value>) -> Result<FoodEntry> {
    let id = id_of(o)?;
    if let Some(d) = deleted_of(o) {
        return Ok(FoodEntry { id, deleted: Some(d), ..Default::default() });
    }
    let mut known = 0;
    let mut num = |key: &str, bit: u32| -> Result<f64> {
        match o.get(key) {
            None | Some(Value::Null) => Ok(0.0),
            Some(v) => {
                let n = v.as_f64().filter(|n| n.is_finite() && *n >= 0.0).ok_or(ProtoError::Malformed)?;
                known |= bit;
                Ok(n)
            }
        }
    };
    let kcal = num("kcal", KNOWN_KCAL)?;
    let protein = num("protein", KNOWN_PROTEIN)?;
    let fat = num("fat", KNOWN_FAT)?;
    let carbs = num("carbs", KNOWN_CARBS)?;
    let fiber = num("fiber", KNOWN_FIBER)?;
    let grams = num("grams", KNOWN_GRAMS)?;
    Ok(FoodEntry {
        id,
        stamp: Some(Default::default()),
        name: o.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        meal: o.get("meal").and_then(Value::as_str).unwrap_or("other").to_string(),
        kcal,
        protein,
        fat,
        carbs,
        fiber,
        grams,
        known,
        per100: o.get("per100").and_then(Value::as_bool).unwrap_or(false),
        deleted: None,
    })
}

fn day_of(o: &Map<String, Value>) -> Result<NutritionDay> {
    let day = o.get("day").and_then(Value::as_str).ok_or(ProtoError::InvalidField("day"))?.to_string();
    let entries = match o.get("entries") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => items.iter().map(|i| i.as_object().ok_or(ProtoError::Malformed).and_then(entry_of)).collect::<Result<Vec<_>>>()?,
        Some(_) => return Err(ProtoError::Malformed),
    };
    let is_complete = match o.get("isComplete") {
        None => None,
        Some(v) => Some(Bool { stamp: None, value: v.as_bool().ok_or(ProtoError::Malformed)? }),
    };
    let fixed_goals = match o.get("fixedGoals") {
        None => None,
        Some(Value::Null) => Some(GoalSet { stamp: None, ..Default::default() }),
        Some(v) => Some(goals_of(v)?),
    };
    Ok(NutritionDay { day, entries, is_complete, fixed_goals, water_ml: u32_field(o, "waterMl")? })
}

fn settings_of(v: &Value) -> Result<Settings> {
    Ok(Settings {
        stamp: None,
        day_start: required_u32(v, "dayStart")?,
        day_end: required_u32(v, "dayEnd")?,
        lunch_start: required_u32(v, "lunchStart")?,
        lunch_end: required_u32(v, "lunchEnd")?,
        margin: required_u32(v, "margin")?,
        budget: required_u32(v, "budget")?,
    })
}

/// Изменения хоста → операция без меток (метки ставит `planner::stamp_op`).
pub fn op_from_json(text: &str) -> Result<PlannerOp> {
    let v: Value = serde_json::from_str(text).map_err(|_| ProtoError::Malformed)?;
    let items = v.get("changes").and_then(Value::as_array).ok_or(ProtoError::InvalidField("changes"))?;
    if items.is_empty() || items.len() > 500 {
        return Err(ProtoError::InvalidField("changes"));
    }
    let mut changes = Vec::with_capacity(items.len());
    for item in items {
        let o = item.as_object().ok_or(ProtoError::Malformed)?;
        let (kind, body) = o.iter().next().ok_or(ProtoError::Malformed)?;
        let obj = || body.as_object().ok_or(ProtoError::Malformed);
        let c = match kind.as_str() {
            "task" => change::Change::Task(task_of(obj()?)?),
            "event" => change::Change::Event(event_of(obj()?)?),
            "list" => change::Change::List(list_of(obj()?)?),
            "nutritionDay" => change::Change::NutritionDay(day_of(obj()?)?),
            "settings" => change::Change::Settings(settings_of(body)?),
            "goals" => change::Change::Goals(goals_of(body)?),
            "migration" => change::Change::Migration(Migration {
                source_device: body.get("sourceDevice").and_then(Value::as_str).unwrap_or_default().to_string(),
                count: body.get("count").and_then(Value::as_u64).unwrap_or(0) as u32,
            }),
            _ => return Err(ProtoError::InvalidField("change")),
        };
        changes.push(Change { change: Some(c) });
    }
    Ok(PlannerOp { changes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::planner::{self, PlannerState};
    use crate::domain::Stamp;

    #[test]
    fn json_roundtrip_through_state() {
        let text = r#"{"changes":[
          {"task":{"id":"t1","name":"Задача","status":"queue","listId":"","rank":0,"day":"2026-10-08","start":"10:00","minutes":60,"steps":[{"text":"a","isDone":true}]}},
          {"task":{"id":"t2","name":"Без оценки","minutes":null}},
          {"event":{"id":"e1","name":"Стендап","start":"09:30","end":"09:45","weekdays":[1,2,3,4,5],"day":""}},
          {"list":{"id":"l1","name":"Работа","order":1}},
          {"nutritionDay":{"day":"2026-10-08","entries":[{"id":"f1","name":"Суп","meal":"lunch","kcal":300,"protein":12}],"isComplete":true,"waterMl":500}},
          {"settings":{"dayStart":480,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10,"budget":480}},
          {"goals":{"kcal":{"target":2000,"tolerance":100},"protein":{"target":120,"tolerance":20}}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 7);
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 2);
        let t2 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t2").unwrap();
        assert!(t2["minutes"].is_null());
        assert_eq!(out["events"][0]["weekdays"], json!([1, 2, 3, 4, 5]));
        let f = &out["nutrition"][0]["entries"][0];
        assert_eq!(f["protein"], json!(12.0));
        assert!(f["fat"].is_null());
        assert_eq!(out["settings"]["budget"], json!(480));
        assert_eq!(out["goals"]["protein"]["tolerance"], json!(20));
        assert_eq!(out["headSeq"], json!(1));

        // Удаление задачи и записи питания.
        let mut del = op_from_json(r#"{"changes":[{"task":{"id":"t1","deleted":true}},{"nutritionDay":{"day":"2026-10-08","entries":[{"id":"f1","deleted":true}]}}]}"#).unwrap();
        planner::stamp_op(&mut del, &Stamp::new(2, "d1"));
        st.apply_op(&del, "d1").unwrap();
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(out["nutrition"][0]["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn malformed_json_is_rejected() {
        assert!(op_from_json("{}").is_err());
        assert!(op_from_json(r#"{"changes":[]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"name":"без id"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"wat":{}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"id":"x","minutes":"many"}}]}"#).is_err());
    }
}
