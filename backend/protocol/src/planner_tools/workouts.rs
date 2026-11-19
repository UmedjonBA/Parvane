//! Запланированные тренировки «Плана» для «Активности» модуля «Здоровье» (доска `XdHealth`, «вс · запланировано на
//! 18:00»). Тренировка — запись «Плана», в названии которой есть слово тренировки из разбора «Здоровья»
//! (`health_parse::workout_tag_of`: «зал», «бег», «йога», «gym» …). Берутся невыполненные записи с `today` на
//! `days` дней вперёд; сегодняшняя — пока не закончилась (конец — начало + длительность, без времени — весь день).

use serde::Deserialize;
use serde_json::{json, Value};

use super::{day_text, parse_day, weekday};
use crate::health_parse::workout_tag_of;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub items: Vec<Item>,
    pub today: String,
    pub now_minute: i64,
    pub days: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub key: String,
    pub name: String,
    pub day: String,
    /// Начало, минуты; нет — `-1`.
    #[serde(default = "none")]
    pub start: i64,
    pub minutes: i64,
    pub is_done: bool,
}

fn none() -> i64 {
    -1
}

const MAX_DAYS: i64 = 31;

pub fn run(input: &Input) -> Value {
    let Some(today) = parse_day(&input.today) else { return json!([]) };
    let last = today + input.days.clamp(1, MAX_DAYS) - 1;
    let mut out: Vec<(i64, i64, Value)> = input
        .items
        .iter()
        .filter(|item| !item.is_done)
        .filter_map(|item| {
            let day = parse_day(&item.day).filter(|d| (today..=last).contains(d))?;
            let tag = workout_tag_of(&item.name)?;
            let is_over = day == today && item.start >= 0 && item.start + item.minutes.max(0) <= input.now_minute;
            (!is_over).then(|| {
                let start = (item.start >= 0).then_some(item.start);
                (day, item.start, json!({"key": item.key, "name": item.name, "day": day_text(day), "weekday": weekday(day), "start": start, "minutes": (item.minutes > 0).then_some(item.minutes), "tag": tag}))
            })
        })
        .collect();
    out.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    Value::Array(out.into_iter().map(|(_, _, v)| v).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_workouts_ahead_and_not_done() {
        let item = |key: &str, name: &str, day: &str, start: i64, is_done: bool| Item { key: key.into(), name: name.into(), day: day.into(), start, minutes: 60, is_done };
        let v = run(&Input {
            items: vec![
                item("a", "Зал · силовая", "2026-11-15", 1080, false),
                item("b", "Созвон", "2026-11-15", 1080, false),
                item("c", "Бег в парке", "2026-11-15", 420, false),
                item("d", "Йога", "2026-11-17", -1, true),
                item("e", "Утренняя пробежка", "2026-11-16", -1, false),
            ],
            today: "2026-11-15".into(),
            now_minute: 600,
            days: 7,
        });
        assert_eq!(v, json!([
            {"key": "a", "name": "Зал · силовая", "day": "2026-11-15", "weekday": 0, "start": 1080, "minutes": 60, "tag": "strength"},
            {"key": "e", "name": "Утренняя пробежка", "day": "2026-11-16", "weekday": 1, "start": null, "minutes": 60, "tag": "run"},
        ]));
    }
}
