//! JSON планировщика для хостов (spec 010): компактное сведённое состояние
//! (только живые объекты, значения без меток) и разбор изменений от хоста
//! (присутствующее поле — правка регистра, `null` у числа — «не задано»,
//! `deleted: true` — надгробие). Метки хост не ставит — их проставляет движок
//! (`planner::stamp_op`). Формат — один для web (WASM) и нативных хостов (C ABI).
//!
//! Состояние:
//! `{tasks:[{id,name,description,steps:[{text,isDone}],status,listId,rank,day,start,due,minutes|null,
//!     repeat|null,occurrences:[{day,excluded,done,doneSteps}],origin|null,source|null}],
//!   events:[{id,name,start,end,weekdays:[…]|null,day,repeat|null,occurrences,origin|null,allDay,isHoliday,color}],
//!   lists:[{id,name,order,color}],
//!   nutrition:[{day,entries:[{id,name,meal,kcal,protein|null,fat|null,carbs|null,fiber|null,grams|null,per100}],
//!     isComplete,fixedGoals|null,waterMl|null}], settings|null, goals|null,
//!   goalPeriods:[{id,startDay,endDay,kcal|null,protein|null,fat|null,carbs|null,fiber|null,water|null}]}`
//! где `repeat = {kind:"daily|weekly|monthly|yearly",interval,weekdays,monthDay,startDay,endDay,count}`,
//! `origin = {seriesId,day}`, `source = {chat,opId}` (spec 011).
//! Изменения: `{changes:[{task:{…}}|{event:{…}}|{list:{…}}|{nutritionDay:{…}}|{settings:{…}}|{goals:{…}}|
//! {goalPeriod:{…}}|{migration:{…}}]}`; `occurrences` в правке — только изменённые дни.

use serde_json::{json, Map, Value};

use super::planner::PlannerState;
use crate::error::{ProtoError, Result};
use crate::pb::parvane::planner::v1::{
    change, Bool, Change, Event, FoodEntry, Goal, GoalPeriod, GoalSet, List, Migration, NutritionDay, Occurrence, Origin,
    PlannerOp, Repeat, RepeatKind, Settings, Source, Step, Steps, Str, Task, Weekdays, I32, U32,
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
    json!({
        "kcal": goal_json(&g.kcal), "protein": goal_json(&g.protein), "fat": goal_json(&g.fat), "carbs": goal_json(&g.carbs),
        "fiber": goal_json(&g.fiber), "water": goal_json(&g.water),
    })
}

fn period_goal_json(g: &Option<Goal>) -> Value {
    g.as_ref().filter(|g| g.set).map(|g| json!({"target": g.target, "tolerance": g.tolerance})).unwrap_or(Value::Null)
}

fn repeat_kind_name(kind: i32) -> Option<&'static str> {
    match RepeatKind::try_from(kind).ok()? {
        RepeatKind::Unspecified => None,
        RepeatKind::Daily => Some("daily"),
        RepeatKind::Weekly => Some("weekly"),
        RepeatKind::Monthly => Some("monthly"),
        RepeatKind::Yearly => Some("yearly"),
    }
}

fn repeat_json(r: &Option<Repeat>) -> Value {
    let Some(r) = r else { return Value::Null };
    let Some(kind) = repeat_kind_name(r.kind) else { return Value::Null };
    json!({
        "kind": kind, "interval": r.interval, "weekdays": r.weekdays, "monthDay": r.month_day,
        "startDay": r.start_day, "endDay": r.end_day, "count": r.count,
    })
}

fn occurrences_json(items: &[Occurrence]) -> Value {
    json!(items
        .iter()
        .filter(|o| o.excluded || o.done || !o.done_steps.is_empty())
        .map(|o| json!({"day": o.day, "excluded": o.excluded, "done": o.done, "doneSteps": o.done_steps}))
        .collect::<Vec<_>>())
}

fn origin_json(o: &Option<Origin>) -> Value {
    o.as_ref().filter(|o| !o.series_id.is_empty()).map(|o| json!({"seriesId": o.series_id, "day": o.day})).unwrap_or(Value::Null)
}

fn source_json(s: &Option<Source>) -> Value {
    s.as_ref().filter(|s| !s.op_id.is_empty()).map(|s| json!({"chat": s.chat, "opId": s.op_id})).unwrap_or(Value::Null)
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
                "repeat": repeat_json(&t.repeat), "occurrences": occurrences_json(&t.occurrences),
                "origin": origin_json(&t.origin), "source": source_json(&t.source),
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
                "repeat": repeat_json(&e.repeat), "occurrences": occurrences_json(&e.occurrences), "origin": origin_json(&e.origin),
                "allDay": e.all_day.as_ref().map(|b| b.value).unwrap_or(false),
                "isHoliday": e.is_holiday.as_ref().map(|b| b.value).unwrap_or(false),
                "color": e.color.as_ref().filter(|c| !c.unset).map(|c| c.value).unwrap_or(0),
            })
        })
        .collect();
    let lists: Vec<Value> = state
        .lists
        .values()
        .filter(|l| PlannerState::is_list_alive(l))
        .map(|l| {
            json!({
                "id": l.id, "name": sv(&l.name), "order": l.order.as_ref().map(|o| o.value).unwrap_or(0),
                "color": l.color.as_ref().filter(|c| !c.unset).map(|c| c.value).unwrap_or(0),
            })
        })
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
    let goal_periods: Vec<Value> = state
        .goal_periods
        .values()
        .filter(|p| PlannerState::is_goal_period_alive(p))
        .map(|p| {
            json!({
                "id": p.id, "startDay": p.start_day, "endDay": p.end_day,
                "kcal": period_goal_json(&p.kcal), "protein": period_goal_json(&p.protein), "fat": period_goal_json(&p.fat),
                "carbs": period_goal_json(&p.carbs), "fiber": period_goal_json(&p.fiber), "water": period_goal_json(&p.water),
            })
        })
        .collect();
    json!({
        "tasks": tasks, "events": events, "lists": lists, "nutrition": nutrition,
        "settings": settings.unwrap_or(Value::Null), "goals": state.goals.as_ref().map(goals_json).unwrap_or(Value::Null),
        "goalPeriods": goal_periods,
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
        Some(v) => Ok(Some(Goal { target: required_u32(v, "target")?, tolerance: required_u32(v, "tolerance")?, set: false })),
    }
}

fn goals_of(v: &Value) -> Result<GoalSet> {
    Ok(GoalSet {
        stamp: None,
        kcal: goal_of(v.get("kcal"))?,
        protein: goal_of(v.get("protein"))?,
        fat: goal_of(v.get("fat"))?,
        carbs: goal_of(v.get("carbs"))?,
        fiber: goal_of(v.get("fiber"))?,
        water: goal_of(v.get("water"))?,
    })
}

/// Цель записи: `null`/отсутствие — показатель без цели (`set = false`).
fn period_goal_of(v: Option<&Value>) -> Result<Option<Goal>> {
    Ok(goal_of(v)?.map(|g| Goal { set: true, ..g }))
}

fn goal_period_of(o: &Map<String, Value>) -> Result<GoalPeriod> {
    let id = id_of(o)?;
    if let Some(d) = deleted_of(o) {
        return Ok(GoalPeriod { id, deleted: Some(d), ..Default::default() });
    }
    let day = |key: &str| -> Result<String> {
        match o.get(key) {
            None | Some(Value::Null) => Ok(String::new()),
            Some(Value::String(s)) => Ok(s.clone()),
            Some(_) => Err(ProtoError::Malformed),
        }
    };
    Ok(GoalPeriod {
        id,
        stamp: Some(Default::default()),
        start_day: day("startDay")?,
        end_day: day("endDay")?,
        kcal: period_goal_of(o.get("kcal"))?,
        protein: period_goal_of(o.get("protein"))?,
        fat: period_goal_of(o.get("fat"))?,
        carbs: period_goal_of(o.get("carbs"))?,
        fiber: period_goal_of(o.get("fiber"))?,
        water: period_goal_of(o.get("water"))?,
        deleted: None,
    })
}

fn opt_u32(v: Option<&Value>, key: &'static str) -> Result<u32> {
    match v {
        None | Some(Value::Null) => Ok(0),
        Some(v) => v.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n <= u32::MAX as f64).map(|n| n.round() as u32).ok_or(ProtoError::InvalidField(key)),
    }
}

fn opt_str(v: Option<&Value>) -> Result<String> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(_) => Err(ProtoError::Malformed),
    }
}

/// Правило повтора: `null` — разовое дело (регистр с `kind = NONE`).
fn repeat_of(o: &Map<String, Value>) -> Result<Option<Repeat>> {
    match o.get("repeat") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Repeat { stamp: None, ..Default::default() })),
        Some(v) => {
            let kind = match v.get("kind").and_then(Value::as_str) {
                Some("daily") => RepeatKind::Daily,
                Some("weekly") => RepeatKind::Weekly,
                Some("monthly") => RepeatKind::Monthly,
                Some("yearly") => RepeatKind::Yearly,
                _ => return Err(ProtoError::InvalidField("repeat")),
            };
            let weekdays = match v.get("weekdays") {
                None | Some(Value::Null) => vec![],
                Some(Value::Array(days)) => days.iter().map(|d| d.as_u64().map(|d| d as u32).ok_or(ProtoError::Malformed)).collect::<Result<Vec<_>>>()?,
                Some(_) => return Err(ProtoError::Malformed),
            };
            Ok(Some(Repeat {
                stamp: None,
                kind: kind as i32,
                interval: opt_u32(v.get("interval"), "interval")?,
                weekdays,
                month_day: opt_u32(v.get("monthDay"), "monthDay")?,
                start_day: opt_str(v.get("startDay"))?,
                end_day: opt_str(v.get("endDay"))?,
                count: opt_u32(v.get("count"), "count")?,
            }))
        }
    }
}

fn occurrences_of(o: &Map<String, Value>) -> Result<Vec<Occurrence>> {
    match o.get("occurrences") {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| {
                let day = i.get("day").and_then(Value::as_str).ok_or(ProtoError::InvalidField("occurrence"))?.to_string();
                let done_steps = match i.get("doneSteps") {
                    None | Some(Value::Null) => vec![],
                    Some(Value::Array(steps)) => steps.iter().map(|d| d.as_u64().map(|d| d as u32).ok_or(ProtoError::Malformed)).collect::<Result<Vec<_>>>()?,
                    Some(_) => return Err(ProtoError::Malformed),
                };
                Ok(Occurrence {
                    day,
                    stamp: None,
                    excluded: i.get("excluded").and_then(Value::as_bool).unwrap_or(false),
                    done: i.get("done").and_then(Value::as_bool).unwrap_or(false),
                    done_steps,
                })
            })
            .collect(),
        Some(_) => Err(ProtoError::Malformed),
    }
}

fn origin_of(o: &Map<String, Value>) -> Result<Option<Origin>> {
    match o.get("origin") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Origin { stamp: None, ..Default::default() })),
        Some(v) => Ok(Some(Origin { stamp: None, series_id: opt_str(v.get("seriesId"))?, day: opt_str(v.get("day"))? })),
    }
}

fn source_of(o: &Map<String, Value>) -> Result<Option<Source>> {
    match o.get("source") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Source { stamp: None, ..Default::default() })),
        Some(v) => Ok(Some(Source { stamp: None, chat: opt_str(v.get("chat"))?, op_id: opt_str(v.get("opId"))? })),
    }
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
        repeat: repeat_of(o)?,
        occurrences: occurrences_of(o)?,
        origin: origin_of(o)?,
        source: source_of(o)?,
    })
}

fn event_of(o: &Map<String, Value>) -> Result<Event> {
    let weekdays = match o.get("weekdays") {
        None => None,
        Some(Value::Null) => Some(Weekdays { stamp: None, days: vec![] }),
        Some(Value::Array(days)) => Some(Weekdays { stamp: None, days: days.iter().map(|d| d.as_u64().map(|d| d as u32).ok_or(ProtoError::Malformed)).collect::<Result<Vec<_>>>()? }),
        Some(_) => return Err(ProtoError::Malformed),
    };
    Ok(Event {
        id: id_of(o)?,
        name: str_field(o, "name")?,
        start: str_field(o, "start")?,
        end: str_field(o, "end")?,
        weekdays,
        day: str_field(o, "day")?,
        deleted: deleted_of(o),
        repeat: repeat_of(o)?,
        occurrences: occurrences_of(o)?,
        origin: origin_of(o)?,
        all_day: bool_field(o, "allDay")?,
        is_holiday: bool_field(o, "isHoliday")?,
        color: u32_field(o, "color")?,
    })
}

fn bool_field(o: &Map<String, Value>, key: &str) -> Result<Option<Bool>> {
    match o.get(key) {
        None => Ok(None),
        Some(v) => Ok(Some(Bool { stamp: None, value: v.as_bool().ok_or(ProtoError::Malformed)? })),
    }
}

fn list_of(o: &Map<String, Value>) -> Result<List> {
    Ok(List { id: id_of(o)?, name: str_field(o, "name")?, order: i32_field(o, "order")?, deleted: deleted_of(o), color: u32_field(o, "color")? })
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
    let is_complete = bool_field(o, "isComplete")?;
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
            "goalPeriod" => change::Change::GoalPeriod(goal_period_of(obj()?)?),
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
          {"list":{"id":"l1","name":"Работа","order":1,"color":4}},
          {"event":{"id":"e3","name":"Новый год","start":"00:00","end":"23:59","day":"2027-01-01","allDay":true,"isHoliday":true,"color":3}},
          {"nutritionDay":{"day":"2026-10-08","entries":[{"id":"f1","name":"Суп","meal":"lunch","kcal":300,"protein":12}],"isComplete":true,"waterMl":500}},
          {"settings":{"dayStart":480,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10,"budget":480}},
          {"goals":{"kcal":{"target":2000,"tolerance":100},"protein":{"target":120,"tolerance":20},"water":{"target":2000,"tolerance":300}}},
          {"task":{"id":"t3","name":"Зарядка","repeat":{"kind":"daily","interval":1,"startDay":"2026-10-01","count":10},
            "occurrences":[{"day":"2026-10-02","done":true,"doneSteps":[0]}],"source":{"chat":"bob@local","opId":"0192abcd"}}},
          {"event":{"id":"e2","name":"Бассейн","start":"19:00","end":"20:00","repeat":{"kind":"weekly","interval":1,"weekdays":[1,3],"startDay":"2026-10-12"},
            "occurrences":[{"day":"2026-10-14","excluded":true}],"origin":null}},
          {"goalPeriod":{"id":"g1","startDay":"2026-10-15","endDay":"2026-10-15","kcal":{"target":1500,"tolerance":100},"water":null}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 11);
        let parsed: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(parsed["lists"][0]["color"], json!(4));
        let e3 = parsed["events"].as_array().unwrap().iter().find(|e| e["id"] == "e3").unwrap();
        assert_eq!(e3["allDay"], json!(true));
        assert_eq!(e3["isHoliday"], json!(true));
        assert_eq!(e3["color"], json!(3));
        let e1 = parsed["events"].as_array().unwrap().iter().find(|e| e["id"] == "e1").unwrap();
        assert_eq!(e1["allDay"], json!(false));
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 3);
        let t2 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t2").unwrap();
        assert!(t2["minutes"].is_null());
        assert_eq!(out["events"][0]["weekdays"], json!([1, 2, 3, 4, 5]));
        let f = &out["nutrition"][0]["entries"][0];
        assert_eq!(f["protein"], json!(12.0));
        assert!(f["fat"].is_null());
        assert_eq!(out["settings"]["budget"], json!(480));
        assert_eq!(out["goals"]["protein"]["tolerance"], json!(20));
        assert_eq!(out["goals"]["water"]["target"], json!(2000));
        assert_eq!(out["headSeq"], json!(1));
        let t3 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t3").unwrap();
        assert_eq!(t3["repeat"]["kind"], json!("daily"));
        assert_eq!(t3["repeat"]["count"], json!(10));
        assert_eq!(t3["occurrences"], json!([{"day": "2026-10-02", "excluded": false, "done": true, "doneSteps": [0]}]));
        assert_eq!(t3["source"]["opId"], json!("0192abcd"));
        assert!(t2["repeat"].is_null());
        let e2 = out["events"].as_array().unwrap().iter().find(|e| e["id"] == "e2").unwrap();
        assert_eq!(e2["repeat"]["weekdays"], json!([1, 3]));
        assert_eq!(e2["occurrences"][0]["excluded"], json!(true));
        assert!(e2["origin"].is_null());
        assert_eq!(out["goalPeriods"][0]["kcal"]["target"], json!(1500));
        assert!(out["goalPeriods"][0]["water"].is_null());
        assert_eq!(out["goalPeriods"][0]["endDay"], json!("2026-10-15"));

        // Удаление задачи и записи питания.
        let mut del = op_from_json(r#"{"changes":[{"task":{"id":"t1","deleted":true}},{"nutritionDay":{"day":"2026-10-08","entries":[{"id":"f1","deleted":true}]}},{"goalPeriod":{"id":"g1","deleted":true}},{"task":{"id":"t3","repeat":null}}]}"#).unwrap();
        planner::stamp_op(&mut del, &Stamp::new(2, "d1"));
        st.apply_op(&del, "d1").unwrap();
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(out["nutrition"][0]["entries"].as_array().unwrap().len(), 0);
        assert_eq!(out["goalPeriods"].as_array().unwrap().len(), 0);
        let t3 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t3").unwrap();
        assert!(t3["repeat"].is_null());
    }

    #[test]
    fn malformed_json_is_rejected() {
        assert!(op_from_json("{}").is_err());
        assert!(op_from_json(r#"{"changes":[]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"name":"без id"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"wat":{}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"id":"x","minutes":"many"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"id":"x","repeat":{"kind":"hourly"}}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"goalPeriod":{"startDay":"2026-01-01"}}]}"#).is_err());
    }
}
