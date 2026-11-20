//! JSON планировщика для хостов (spec 010): компактное сведённое состояние
//! (только живые объекты, значения без меток) и разбор изменений от хоста
//! (присутствующее поле — правка регистра, `null` у числа — «не задано»,
//! `deleted: true` — надгробие). Метки хост не ставит — их проставляет движок
//! (`planner::stamp_op`). Формат — один для web (WASM) и нативных хостов (C ABI).
//!
//! Состояние:
//! `{tasks:[{id,name,description,steps:[{text,isDone}],status,listId,rank,day,start,due,minutes|null,
//!     repeat|null,occurrences:[{day,excluded,done,doneSteps}],origin|null,source|null}],
//!   events:[{id,name,start,end,weekdays:[…]|null,day,repeat|null,occurrences,origin|null,allDay,isHoliday,color,
//!     description,listId,steps:[{text,isDone}]}],
//!   lists:[{id,name,order,color}],
//!   settings:{dayStart,dayEnd,lunchStart,lunchEnd,margin,budget}|null,
//!   learned:[{id,kind,kindCount,minutes|null,minutesCount,touched}],
//!   quickLines:[{id,text,count,touched,hidden}], reminded:[id], headSeq, sizeBytes}`
//! (`learned` — словарь правок ввода текстом, не более 200 самых свежих слов;
//! `quickLines` — история ввода текстом: не более 200 самых свежих строк и 200 забытых шаблонов (`hidden`)),
//! где `repeat = {kind:"daily|weekly|monthly|yearly",interval,weekdays,monthDay,startDay,endDay,count}`,
//! `origin = {seriesId,day}`, `source = {chat,opId}` (spec 011). С 15 окт 2026 у задачи и события ещё
//! `remind|null` (минут до начала), в состоянии — `reminded:[id]` (отметки «напоминание отправлено»,
//! `<id>@<день>@<минут>`), изменение `{reminded:{id[,deleted:true]}}`.
//! Изменения: `{changes:[{task:{…}}|{event:{…}}|{list:{…}}|{settings:{…}}|{learned:{…}}|{quickLine:{…}}|
//! {reminded:{…}}|{migration:{…}}]}`; `occurrences` в правке — только изменённые дни; `quickLine` — запись целиком.
//!
//! С 17 ноя 2026 (spec 041 B4) здоровья, питания и целей питания здесь нет — они в домене
//! `parvane.health.v1`: состояние не несёт `nutrition`, `goals`, `goalPeriods`, `health`, а изменения
//! `nutritionDay`, `goals`, `goalPeriod`, `health` отвергаются как любой неизвестный вид.

use serde_json::{json, Map, Value};

use super::planner::PlannerState;
use crate::error::{ProtoError, Result};
use crate::pb::parvane::planner::v1::{
    change, Bool, Change, Event, LearnedWord, List, Migration, Occurrence, Origin,
    PlannerOp, QuickLine, Reminded, Repeat, RepeatKind, Settings, Source, Step, Steps, Str, Task, Weekdays, I32, U32,
};

// ── состояние → JSON ────────────────────────────────────────────────────────

/// Число либо `null` («не задано»).
fn u32_json(f: &Option<U32>) -> Value {
    f.as_ref().filter(|m| !m.unset).map(|m| json!(m.value)).unwrap_or(Value::Null)
}

fn sv(f: &Option<Str>) -> Value {
    Value::String(f.as_ref().map(|s| s.value.clone()).unwrap_or_default())
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

fn steps_json(steps: &Option<Steps>) -> Value {
    json!(steps.as_ref().map(|s| s.items.iter().map(|i| json!({"text": i.text, "isDone": i.is_done})).collect::<Vec<_>>()).unwrap_or_default())
}

fn origin_json(o: &Option<Origin>) -> Value {
    o.as_ref().filter(|o| !o.series_id.is_empty()).map(|o| json!({"seriesId": o.series_id, "day": o.day})).unwrap_or(Value::Null)
}

fn source_json(s: &Option<Source>) -> Value {
    s.as_ref().filter(|s| !s.op_id.is_empty()).map(|s| json!({"chat": s.chat, "opId": s.op_id})).unwrap_or(Value::Null)
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
                "steps": steps_json(&t.steps),
                "status": t.status.as_ref().map(|s| s.value.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| "queue".into()),
                "listId": sv(&t.list_id), "rank": t.rank.as_ref().map(|r| r.value).unwrap_or(0),
                "day": sv(&t.day), "start": sv(&t.start), "due": sv(&t.due),
                "minutes": t.minutes.as_ref().filter(|m| !m.unset).map(|m| json!(m.value)).unwrap_or(Value::Null),
                "repeat": repeat_json(&t.repeat), "occurrences": occurrences_json(&t.occurrences),
                "origin": origin_json(&t.origin), "source": source_json(&t.source),
                "remind": u32_json(&t.remind),
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
                "description": sv(&e.description),
                "remind": u32_json(&e.remind),
                "listId": sv(&e.list_id),
                "steps": steps_json(&e.steps),
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
    let settings = state.settings.as_ref().map(|s| {
        json!({"dayStart": s.day_start, "dayEnd": s.day_end, "lunchStart": s.lunch_start, "lunchEnd": s.lunch_end, "margin": s.margin, "budget": s.budget})
    });
    let count = |c: &Option<U32>| c.as_ref().map(|c| c.value).unwrap_or(0);
    let learned: Vec<Value> = state
        .learned_live()
        .into_iter()
        .map(|w| {
            json!({
                "id": w.id, "kind": sv(&w.kind), "kindCount": count(&w.kind_count),
                "minutes": w.minutes.as_ref().filter(|m| !m.unset).map(|m| json!(m.value)).unwrap_or(Value::Null),
                "minutesCount": count(&w.minutes_count), "touched": count(&w.touched),
            })
        })
        .collect();
    let quick_lines: Vec<Value> = state
        .quick_live()
        .into_iter()
        .map(|l| json!({"id": l.id, "text": l.text, "count": l.count, "touched": l.touched, "hidden": l.hidden}))
        .collect();
    let reminded: Vec<Value> = state
        .reminded
        .values()
        .filter(|r| PlannerState::is_reminded_alive(r))
        .map(|r| json!(r.id))
        .collect();
    json!({
        "tasks": tasks, "events": events, "lists": lists, "reminded": reminded,
        "settings": settings.unwrap_or(Value::Null), "learned": learned, "quickLines": quick_lines,
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

/// Шаги задачи либо события: присутствующий список — правка регистра целиком.
fn steps_of(o: &Map<String, Value>) -> Result<Option<Steps>> {
    match o.get("steps") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => Ok(Some(Steps {
            stamp: None,
            items: items
                .iter()
                .map(|i| Ok(Step { text: i.get("text").and_then(Value::as_str).ok_or(ProtoError::Malformed)?.to_string(), is_done: i.get("isDone").and_then(Value::as_bool).unwrap_or(false) }))
                .collect::<Result<Vec<_>>>()?,
        })),
        Some(_) => Err(ProtoError::Malformed),
    }
}

fn task_of(o: &Map<String, Value>) -> Result<Task> {
    let steps = steps_of(o)?;
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
        remind: u32_field(o, "remind")?,
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
        description: str_field(o, "description")?,
        remind: u32_field(o, "remind")?,
        list_id: str_field(o, "listId")?,
        steps: steps_of(o)?,
    })
}

/// Отметка «напомнено»: `{id}` либо `{id, deleted: true}`.
fn reminded_of(o: &Map<String, Value>) -> Result<Reminded> {
    let id = id_of(o)?;
    Ok(match deleted_of(o) {
        Some(d) => Reminded { id, stamp: None, deleted: Some(d) },
        None => Reminded { id, stamp: Some(Default::default()), deleted: None },
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

/// Слово словаря правок: присутствующее поле — правка регистра; `minutes: null` — длительность не
/// выучена, `kind: null` либо пустая строка — тип не выучен.
fn learned_of(o: &Map<String, Value>) -> Result<LearnedWord> {
    Ok(LearnedWord {
        id: id_of(o)?,
        kind: str_field(o, "kind")?,
        kind_count: u32_field(o, "kindCount")?,
        minutes: u32_field(o, "minutes")?,
        minutes_count: u32_field(o, "minutesCount")?,
        touched: u32_field(o, "touched")?,
        deleted: deleted_of(o),
    })
}

/// Строка истории ввода текстом — регистр целиком: отсутствующее число — ноль, `hidden` — ложь.
fn quick_line_of(o: &Map<String, Value>) -> Result<QuickLine> {
    let id = id_of(o)?;
    if let Some(d) = deleted_of(o) {
        return Ok(QuickLine { id, deleted: Some(d), ..Default::default() });
    }
    let num = |key: &str| -> Result<u32> {
        match o.get(key) {
            None | Some(Value::Null) => Ok(0),
            Some(v) => v.as_u64().and_then(|n| u32::try_from(n).ok()).ok_or(ProtoError::Malformed),
        }
    };
    Ok(QuickLine {
        id,
        stamp: Some(Default::default()),
        text: o.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
        count: num("count")?,
        touched: num("touched")?,
        hidden: o.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        deleted: None,
    })
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
            "settings" => change::Change::Settings(settings_of(body)?),
            "learned" => change::Change::Learned(learned_of(obj()?)?),
            "quickLine" => change::Change::QuickLine(quick_line_of(obj()?)?),
            "reminded" => change::Change::Reminded(reminded_of(obj()?)?),
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

    /// C1: размер снимка считается один раз на ревизию — `state_json` и
    /// `size_estimate` после неё не делают вторую protobuf-копию; правка
    /// сбрасывает кэш.
    #[test]
    fn snapshot_size_is_computed_once_per_revision() {
        let text = r#"{"changes":[{"task":{"id":"t1","title":"Хлеб","day":"2026-10-01","minutes":10}}]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 1);
        assert_eq!(st.size_cached(), None, "после правки кэша нет");
        let rev = st.rev();
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        let size = st.size_cached().expect("state_json посчитал размер");
        assert_eq!(out["sizeBytes"], json!(size));
        assert_eq!(size, prost::Message::encoded_len(&st.to_snapshot()));
        assert_eq!(st.size_estimate(), size);
        assert_eq!(st.rev(), rev, "чтение ревизию не меняет");
        let text2 = r#"{"changes":[{"task":{"id":"t2","title":"Молоко","day":"2026-10-01"}}]}"#;
        let mut op2 = op_from_json(text2).unwrap();
        planner::stamp_op(&mut op2, &Stamp::new(2, "d1"));
        st.apply_op(&op2, "d1").unwrap();
        assert_ne!(st.rev(), rev);
        assert_eq!(st.size_cached(), None, "правка сбрасывает кэш");
        assert!(st.size_estimate() > size);
    }

    #[test]
    fn reminders_roundtrip_and_marks_merge_across_devices() {
        // «Напомнить за» у задачи и события; отметка «напомнено» с двух устройств — одна, надгробие её снимает
        let text = r#"{"changes":[
          {"task":{"id":"t1","name":"Отчёт","day":"2026-10-20","start":"10:00","remind":15}},
          {"event":{"id":"e1","name":"Созвон","start":"16:00","end":"16:30","day":"2026-10-20","remind":60}},
          {"task":{"id":"t2","name":"Без напоминания","remind":null}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut a = PlannerState::default();
        a.apply_op(&op, "d1").unwrap();
        let mut b = a.clone();
        let mark = |device: &str, at: u64, body: &str| {
            let mut op = op_from_json(body).unwrap();
            planner::stamp_op(&mut op, &Stamp::new(at, device));
            op
        };
        a.apply_op(&mark("d1", 2, r#"{"changes":[{"reminded":{"id":"t1@2026-10-20@15"}}]}"#), "d1").unwrap();
        let from_b = mark("d2", 3, r#"{"changes":[{"reminded":{"id":"t1@2026-10-20@15"}}]}"#);
        b.apply_op(&from_b, "d2").unwrap();
        a.apply_op(&from_b, "d2").unwrap();
        let parsed: Value = serde_json::from_str(&state_json(&a, 0)).unwrap();
        assert_eq!(parsed["reminded"], json!(["t1@2026-10-20@15"]));
        let task = parsed["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t1").unwrap();
        assert_eq!(task["remind"], json!(15));
        let free = parsed["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t2").unwrap();
        assert_eq!(free["remind"], Value::Null);
        assert_eq!(parsed["events"][0]["remind"], json!(60));
        a.apply_op(&mark("d1", 4, r#"{"changes":[{"reminded":{"id":"t1@2026-10-20@15","deleted":true}}]}"#), "d1").unwrap();
        let parsed: Value = serde_json::from_str(&state_json(&a, 0)).unwrap();
        assert_eq!(parsed["reminded"], json!([]));
        // Снимок переносит отметки и поля
        let restored = PlannerState::from_snapshot(&b.to_snapshot()).unwrap();
        assert_eq!(restored.reminded.len(), 1);
        // Негодный ключ отметки и напоминание дальше недели — отказ
        for bad in [r#"{"changes":[{"reminded":{"id":"t1@2026-10-20"}}]}"#, r#"{"changes":[{"reminded":{"id":"t1@день@15"}}]}"#,
            r#"{"changes":[{"task":{"id":"t3","name":"x","remind":20000}}]}"#] {
            assert_eq!(PlannerState::default().apply_op(&mark("d1", 5, bad), "d1").unwrap(), 0, "{bad}");
        }
    }

    #[test]
    fn json_roundtrip_through_state() {
        let text = r#"{"changes":[
          {"task":{"id":"t1","name":"Задача","status":"queue","listId":"","rank":0,"day":"2026-10-08","start":"10:00","minutes":60,"steps":[{"text":"a","isDone":true}]}},
          {"task":{"id":"t2","name":"Без оценки","minutes":null}},
          {"event":{"id":"e1","name":"Стендап","start":"09:30","end":"09:45","weekdays":[1,2,3,4,5],"day":""}},
          {"list":{"id":"l1","name":"Работа","order":1,"color":4}},
          {"event":{"id":"e3","name":"Новый год","start":"00:00","end":"23:59","day":"2027-01-01","allDay":true,"isHoliday":true,"color":3,"description":"Ёлка\nи подарки","listId":"l1"}},
          {"settings":{"dayStart":480,"dayEnd":1200,"lunchStart":0,"lunchEnd":0,"margin":10,"budget":480}},
          {"task":{"id":"t3","name":"Зарядка","repeat":{"kind":"daily","interval":1,"startDay":"2026-10-01","count":10},
            "occurrences":[{"day":"2026-10-02","done":true,"doneSteps":[0]}],"source":{"chat":"bob@local","opId":"0192abcd"}}},
          {"event":{"id":"e2","name":"Бассейн","start":"19:00","end":"20:00","repeat":{"kind":"weekly","interval":1,"weekdays":[1,3],"startDay":"2026-10-12"},
            "occurrences":[{"day":"2026-10-14","excluded":true}],"origin":null}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 8);
        let parsed: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(parsed["lists"][0]["color"], json!(4));
        let e3 = parsed["events"].as_array().unwrap().iter().find(|e| e["id"] == "e3").unwrap();
        assert_eq!(e3["allDay"], json!(true));
        assert_eq!(e3["isHoliday"], json!(true));
        assert_eq!(e3["color"], json!(3));
        assert_eq!(e3["description"], json!("Ёлка\nи подарки"));
        assert_eq!(e3["listId"], json!("l1"));
        let e1 = parsed["events"].as_array().unwrap().iter().find(|e| e["id"] == "e1").unwrap();
        assert_eq!(e1["allDay"], json!(false));
        assert_eq!(e1["description"], json!(""));
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 3);
        let t2 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t2").unwrap();
        assert!(t2["minutes"].is_null());
        assert_eq!(out["events"][0]["weekdays"], json!([1, 2, 3, 4, 5]));
        assert_eq!(out["settings"]["budget"], json!(480));
        // Здоровья, питания и целей питания в состоянии нет (spec 041 B4): только эти ключи.
        let mut keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["events", "headSeq", "learned", "lists", "quickLines", "reminded", "settings", "sizeBytes", "tasks"]);
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

        // Удаление задачи и снятие повтора.
        let mut del = op_from_json(r#"{"changes":[{"task":{"id":"t1","deleted":true}},{"task":{"id":"t3","repeat":null}}]}"#).unwrap();
        planner::stamp_op(&mut del, &Stamp::new(2, "d1"));
        st.apply_op(&del, "d1").unwrap();
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["tasks"].as_array().unwrap().len(), 2);
        let t3 = out["tasks"].as_array().unwrap().iter().find(|t| t["id"] == "t3").unwrap();
        assert!(t3["repeat"].is_null());
    }

    /// Шаги события (20 ноя 2026): регистр списка целиком, как у задачи; отметки шагов ряда — по дню;
    /// правка шагов с другого устройства не трогает время, а пустой шаг — негодное изменение.
    #[test]
    fn event_steps_roundtrip_and_merge_per_field() {
        let apply = |st: &mut PlannerState, at: u64, device: &str, body: &str| {
            let mut op = op_from_json(body).unwrap();
            planner::stamp_op(&mut op, &Stamp::new(at, device));
            st.apply_op(&op, device).unwrap()
        };
        let mut a = PlannerState::default();
        let created = r#"{"changes":[{"event":{"id":"e1","name":"Зал","start":"18:00","end":"19:30",
          "repeat":{"kind":"weekly","interval":1,"weekdays":[0],"startDay":"2026-11-15"},
          "steps":[{"text":"Собрать сумку","isDone":false},{"text":"Разминка","isDone":false}]}}]}"#;
        assert_eq!(apply(&mut a, 1, "d1", created), 1);
        let mut b = a.clone();
        // A отмечает первый шаг дня ряда, B переносит время: обе правки сходятся
        apply(&mut a, 2, "d1", r#"{"changes":[{"event":{"id":"e1","occurrences":[{"day":"2026-11-15","doneSteps":[0]}]}}]}"#);
        apply(&mut b, 2, "d2", r#"{"changes":[{"event":{"id":"e1","start":"18:30","end":"20:00"}}]}"#);
        a.merge_snapshot(&b.to_snapshot()).unwrap();
        let out: Value = serde_json::from_str(&state_json(&a, 2)).unwrap();
        let e1 = &out["events"][0];
        assert_eq!(e1["steps"], json!([{"text": "Собрать сумку", "isDone": false}, {"text": "Разминка", "isDone": false}]));
        assert_eq!(e1["occurrences"][0]["doneSteps"], json!([0]));
        assert_eq!(e1["start"], json!("18:30"));
        // Список шагов заменяется целиком; событие без шагов отдаёт пустой список
        apply(&mut a, 3, "d1", r#"{"changes":[{"event":{"id":"e1","steps":[{"text":"Взять воду","isDone":true}]}},
          {"event":{"id":"e2","name":"Созвон","start":"10:00","end":"10:30","day":"2026-11-16"}}]}"#);
        let out: Value = serde_json::from_str(&state_json(&a, 3)).unwrap();
        let find = |id: &str| out["events"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
        assert_eq!(find("e1")["steps"], json!([{"text": "Взять воду", "isDone": true}]));
        assert_eq!(find("e2")["steps"], json!([]));
        // Пустой шаг и больше 100 шагов — негодные изменения
        let many: Vec<Value> = (0..101).map(|i| json!({"text": format!("шаг {i}")})).collect();
        let too_many = json!({"changes": [{"event": {"id": "e1", "steps": many}}]}).to_string();
        for bad in [r#"{"changes":[{"event":{"id":"e1","steps":[{"text":""}]}}]}"#, too_many.as_str()] {
            assert_eq!(apply(&mut a, 4, "d1", bad), 0);
        }
        // Шаги — правка события: новее надгробия и возвращает его
        apply(&mut a, 5, "d1", r#"{"changes":[{"event":{"id":"e2","deleted":true}}]}"#);
        apply(&mut a, 6, "d2", r#"{"changes":[{"event":{"id":"e2","steps":[{"text":"Повестка"}]}}]}"#);
        assert!(PlannerState::is_event_alive(&a.events["e2"]));
    }

    /// Словарь правок ввода текстом: слова проходят через состояние, правка несёт только присланные
    /// регистры, `null` у длительности — «не выучена», надгробие убирает слово из вывода.
    #[test]
    fn learned_words_roundtrip() {
        let text = r#"{"changes":[
          {"learned":{"id":"пара","kind":"event","kindCount":1,"minutes":105,"minutesCount":3,"touched":1}},
          {"learned":{"id":"созвон","kind":"","kindCount":0,"minutes":20,"minutesCount":2,"touched":2}},
          {"task":{"id":"t1","name":"Задача"}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 3);
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(
            out["learned"],
            json!([
                {"id": "пара", "kind": "event", "kindCount": 1, "minutes": 105, "minutesCount": 3, "touched": 1},
                {"id": "созвон", "kind": "", "kindCount": 0, "minutes": 20, "minutesCount": 2, "touched": 2},
            ])
        );

        // Другое устройство правит только длительность: тип остаётся; `null` снимает длительность.
        let mut edit = op_from_json(r#"{"changes":[{"learned":{"id":"пара","minutes":null,"minutesCount":0,"touched":3}}]}"#).unwrap();
        planner::stamp_op(&mut edit, &Stamp::new(2, "d2"));
        st.apply_op(&edit, "d2").unwrap();
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["learned"][0], json!({"id": "пара", "kind": "event", "kindCount": 1, "minutes": null, "minutesCount": 0, "touched": 3}));

        // Надгробие и снимок.
        let mut del = op_from_json(r#"{"changes":[{"learned":{"id":"созвон","deleted":true}}]}"#).unwrap();
        planner::stamp_op(&mut del, &Stamp::new(3, "d1"));
        st.apply_op(&del, "d1").unwrap();
        let restored = PlannerState::from_snapshot(&st.to_snapshot()).unwrap();
        let out: Value = serde_json::from_str(&state_json(&restored, 3)).unwrap();
        assert_eq!(out["learned"].as_array().unwrap().len(), 1);
        assert_eq!(out["learned"][0]["id"], json!("пара"));

        // Негодные слова пропускаются; пустое состояние отдаёт пустой словарь.
        for bad in [
            r#"{"changes":[{"learned":{"id":"x","kind":"food","kindCount":1}}]}"#,
            r#"{"changes":[{"learned":{"id":"x","minutes":2,"minutesCount":1}}]}"#,
            r#"{"changes":[{"learned":{"id":"x","kind":"task","kindCount":9}}]}"#,
            r#"{"changes":[{"learned":{"id":"X","kind":"task","kindCount":1}}]}"#,
        ] {
            let mut op = op_from_json(bad).unwrap();
            planner::stamp_op(&mut op, &Stamp::new(9, "d1"));
            assert_eq!(PlannerState::default().apply_op(&op, "d1").unwrap(), 0, "{bad}");
        }
        let empty: Value = serde_json::from_str(&state_json(&PlannerState::default(), 0)).unwrap();
        assert_eq!(empty["learned"], json!([]));
        assert!(op_from_json(r#"{"changes":[{"learned":{"kind":"task"}}]}"#).is_err());
    }

    /// История ввода текстом: строки и забытые шаблоны проходят через состояние; правка — запись
    /// целиком; надгробие убирает строку из вывода и переживает снимок; новое использование её возвращает.
    #[test]
    fn quick_lines_roundtrip() {
        let text = r#"{"changes":[
          {"quickLine":{"id":"qa1","text":"Созвон завтра 16:00","count":2,"touched":1}},
          {"quickLine":{"id":"hb2","text":"созвон 16:00","touched":2,"hidden":true}},
          {"task":{"id":"t1","name":"Задача"}}
        ]}"#;
        let mut op = op_from_json(text).unwrap();
        planner::stamp_op(&mut op, &Stamp::new(1, "d1"));
        let mut st = PlannerState::default();
        assert_eq!(st.apply_op(&op, "d1").unwrap(), 3);
        let out: Value = serde_json::from_str(&state_json(&st, 1)).unwrap();
        assert_eq!(
            out["quickLines"],
            json!([
                {"id": "hb2", "text": "созвон 16:00", "count": 0, "touched": 2, "hidden": true},
                {"id": "qa1", "text": "Созвон завтра 16:00", "count": 2, "touched": 1, "hidden": false},
            ])
        );

        // Та же строка с другого устройства позже: запись заменяется целиком.
        let mut edit = op_from_json(r#"{"changes":[{"quickLine":{"id":"qa1","text":"созвон завтра 16:00","count":3,"touched":5}}]}"#).unwrap();
        planner::stamp_op(&mut edit, &Stamp::new(2, "d2"));
        st.apply_op(&edit, "d2").unwrap();
        let out: Value = serde_json::from_str(&state_json(&st, 2)).unwrap();
        assert_eq!(out["quickLines"][1], json!({"id": "qa1", "text": "созвон завтра 16:00", "count": 3, "touched": 5, "hidden": false}));

        // Надгробие и снимок; использование новее надгробия возвращает строку.
        let mut del = op_from_json(r#"{"changes":[{"quickLine":{"id":"qa1","deleted":true}}]}"#).unwrap();
        planner::stamp_op(&mut del, &Stamp::new(3, "d1"));
        st.apply_op(&del, "d1").unwrap();
        let mut restored = PlannerState::from_snapshot(&st.to_snapshot()).unwrap();
        let out: Value = serde_json::from_str(&state_json(&restored, 3)).unwrap();
        assert_eq!(out["quickLines"].as_array().unwrap().len(), 1);
        assert_eq!(out["quickLines"][0]["id"], json!("hb2"));
        let mut again = op_from_json(r#"{"changes":[{"quickLine":{"id":"qa1","text":"созвон завтра 16:00","count":1,"touched":6}}]}"#).unwrap();
        planner::stamp_op(&mut again, &Stamp::new(4, "d2"));
        restored.apply_op(&again, "d2").unwrap();
        let out: Value = serde_json::from_str(&state_json(&restored, 4)).unwrap();
        assert_eq!(out["quickLines"].as_array().unwrap().len(), 2);

        // Негодные строки пропускаются; пустое состояние отдаёт пустую историю.
        let long = format!(r#"{{"changes":[{{"quickLine":{{"id":"q1","text":"{}"}}}}]}}"#, "я".repeat(601));
        for bad in [
            r#"{"changes":[{"quickLine":{"id":"q1","text":""}}]}"#,
            r#"{"changes":[{"quickLine":{"id":"q1","text":"   "}}]}"#,
            r#"{"changes":[{"quickLine":{"id":"q1","text":"две\nстроки"}}]}"#,
            r#"{"changes":[{"quickLine":{"id":"с пробелом","text":"строка"}}]}"#,
            long.as_str(),
        ] {
            let mut op = op_from_json(bad).unwrap();
            planner::stamp_op(&mut op, &Stamp::new(9, "d1"));
            assert_eq!(PlannerState::default().apply_op(&op, "d1").unwrap(), 0, "{bad}");
        }
        let empty: Value = serde_json::from_str(&state_json(&PlannerState::default(), 0)).unwrap();
        assert_eq!(empty["quickLines"], json!([]));
        assert!(op_from_json(r#"{"changes":[{"quickLine":{"text":"без id"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"quickLine":{"id":"q1","text":"x","count":-1}}]}"#).is_err());
    }

    #[test]
    fn malformed_json_is_rejected() {
        assert!(op_from_json("{}").is_err());
        assert!(op_from_json(r#"{"changes":[]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"name":"без id"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"wat":{}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"id":"x","minutes":"many"}}]}"#).is_err());
        assert!(op_from_json(r#"{"changes":[{"task":{"id":"x","repeat":{"kind":"hourly"}}}]}"#).is_err());
        // spec 041 B4: здоровье, питание и цели питания переехали в `health.v1` — здесь это неизвестные виды.
        for gone in [
            r#"{"changes":[{"nutritionDay":{"day":"2026-10-08","entries":[]}}]}"#,
            r#"{"changes":[{"goals":{"kcal":{"target":2000,"tolerance":100}}}]}"#,
            r#"{"changes":[{"goalPeriod":{"id":"g1","startDay":"2026-01-01"}}]}"#,
            r#"{"changes":[{"health":{"id":"h1","day":"2026-10-11","kind":"weight","value":74.7}}]}"#,
        ] {
            assert_eq!(op_from_json(gone).err(), Some(ProtoError::InvalidField("change")), "{gone}");
        }
    }
}
