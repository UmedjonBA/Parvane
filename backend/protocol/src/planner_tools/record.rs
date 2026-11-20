//! Действия над одной записью «Плана» из меню по правой кнопке и перетаскивания (доски `ZdPlanX`, `RdPlan`):
//! «Перенести на завтра», «Дублировать», задача, брошенная на шкалу дня. Движок говорит, что сделать с записью;
//! клиент применяет это своей моделью (разовая запись правится на месте, день ряда отделяется).
//!
//! - `tomorrow`: день — следующий за днём записи, но не раньше завтрашнего (просроченное переезжает на завтра);
//!   задача без даты — на завтра. Срок задачи раньше нового дня сдвигается на новый день. Шаблон ряда без дня
//!   экземпляра не переносится (`mode: none`).
//! - `place`: задача либо событие на день и минуту шкалы; минута — вниз с шагом `step` (15 по умолчанию);
//!   длительность — своя, без неё — час; начало сдвигается так, чтобы запись кончалась до полуночи.
//! - `duplicate`: копия записи `record` (JSON клиента) без `id`, состояния дней ряда, отделения и источника; копия
//!   дня ряда — разовая запись на этот день, копия шаблона — такой же ряд; задача копируется невыполненной, с
//!   неотмеченными шагами.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{day_text, parse_day};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub action: String,
    pub today: String,
    /// Хранимый день записи; нет — пусто.
    pub day: String,
    /// День показанного экземпляра ряда; нет — пусто.
    pub instance_day: String,
    pub is_series: bool,
    pub due: String,
    /// Длительность, минуты; нет — `-1`.
    #[serde(default = "none")]
    pub minutes: i64,
    pub drop_day: String,
    #[serde(default = "none")]
    pub drop_minute: i64,
    pub step: i64,
    pub record: Value,
}

fn none() -> i64 {
    -1
}

const MINUTES_IN_DAY: i64 = 1440;
const DEFAULT_STEP: i64 = 15;
const DEFAULT_MINUTES: i64 = 60;
/// Поля, которые копия не наследует: личность, состояние дней ряда, отделение, источник, день показа.
const NOT_COPIED: &[&str] = &["id", "occurrences", "origin", "source", "instanceDay"];

pub fn run(input: &Input) -> Value {
    match input.action.as_str() {
        "tomorrow" => tomorrow(input),
        "place" => place(input),
        "duplicate" => duplicate(input),
        _ => json!({"mode": "none"}),
    }
}

/// Правка ряда: день экземпляра отделяется; разовая запись правится сама.
fn mode_of(input: &Input) -> Option<&'static str> {
    if !input.is_series {
        return Some("move");
    }
    parse_day(&input.instance_day).map(|_| "detach")
}

/// Срок задачи не может быть раньше её дня.
fn due_after(input: &Input, day: i64) -> Option<String> {
    parse_day(&input.due).filter(|due| *due < day).map(|_| day_text(day))
}

fn tomorrow(input: &Input) -> Value {
    let (Some(today), Some(mode)) = (parse_day(&input.today), mode_of(input)) else { return json!({"mode": "none"}) };
    let base = parse_day(&input.instance_day).or_else(|| parse_day(&input.day)).unwrap_or(today);
    let day = base.max(today) + 1;
    json!({"mode": mode, "day": day_text(day), "due": due_after(input, day)})
}

fn place(input: &Input) -> Value {
    let (Some(day), Some(mode)) = (parse_day(&input.drop_day), mode_of(input)) else { return json!({"mode": "none"}) };
    let step = if input.step > 0 { input.step } else { DEFAULT_STEP };
    let minutes = if input.minutes > 0 { input.minutes.min(MINUTES_IN_DAY) } else { DEFAULT_MINUTES };
    let dropped = input.drop_minute.clamp(0, MINUTES_IN_DAY - 1);
    let start = ((dropped / step) * step).min(MINUTES_IN_DAY - minutes);
    json!({
        "mode": mode,
        "day": day_text(day),
        "start": format!("{:02}:{:02}", start / 60, start % 60),
        "minutes": minutes,
        "due": due_after(input, day),
    })
}

fn duplicate(input: &Input) -> Value {
    let Some(source) = input.record.as_object() else { return json!({"mode": "none"}) };
    let mut copy: Map<String, Value> =
        source.iter().filter(|(key, _)| !NOT_COPIED.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let is_series = copy.get("repeat").is_some_and(|repeat| !repeat.is_null());
    if let Some(day) = parse_day(&input.instance_day).filter(|_| is_series) {
        copy.remove("repeat");
        copy.insert("day".into(), json!(day_text(day)));
        if let Some(due) = due_after(input, day) {
            copy.insert("due".into(), json!(due));
        }
    }
    if copy.get("status").and_then(Value::as_str) == Some("done") {
        copy.insert("status".into(), json!("queue"));
    }
    if let Some(Value::Array(steps)) = copy.get_mut("steps") {
        for step in steps.iter_mut().filter_map(Value::as_object_mut) {
            step.insert("isDone".into(), json!(false));
        }
    }
    json!({"mode": "copy", "record": copy})
}
