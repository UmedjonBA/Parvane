//! «Найти свободное время» (доски `ZpPlanX`, `DkPlanMore`): окна под запись длительностью `minutes` в днях,
//! которые передал клиент (обычно 7 дней от выбранного), с учётом окна дня, дневного бюджета и запаса `margin`
//! до и после каждого занятого промежутка.
//!
//! Правила: день, где запись перебрала бы бюджет (`load + minutes > budget`), пропускается; окно ищется внутри
//! `[dayStart, dayEnd]`, сужённого частью дня (`morning` — до 12:00, `evening` — с 17:00, `weekend` — только сб и
//! вс); у сегодняшнего дня окно не раньше `nowMinute`, начало округляется вверх до 5 минут. Каждый просвет даёт одно
//! окно — с его начала. Порядок ответа: сначала первые окна каждого дня (по дням), потом вторые и так далее — три
//! первых ответа приходятся на разные дни. `limit` — сколько вернуть, `total` — сколько всего нашлось.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{parse_day, weekday};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub minutes: i64,
    pub days: Vec<DayIn>,
    pub day_start: i64,
    pub day_end: i64,
    pub budget: i64,
    pub margin: i64,
    /// `any` | `morning` | `evening` | `weekend`
    pub part: String,
    pub limit: usize,
    pub today: String,
    pub now_minute: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DayIn {
    pub day: String,
    /// Занятые промежутки `[начало, конец)` в минутах; порядок любой, пересечения допустимы.
    pub busy: Vec<[i64; 2]>,
    /// Загрузка дня, минут (без самой записи, если она уже стоит в этом дне).
    pub load: i64,
}

const MINUTES_IN_DAY: i64 = 1440;
const MORNING_END: i64 = 12 * 60;
const EVENING_START: i64 = 17 * 60;
const ROUND_TO: i64 = 5;
const MAX_DAYS: usize = 62;
const MAX_LIMIT: usize = 50;
const MAX_MARGIN: i64 = 120;

pub fn run(input: &Input) -> Value {
    let minutes = input.minutes;
    if !(1..=MINUTES_IN_DAY).contains(&minutes) {
        return json!({"slots": [], "total": 0});
    }
    let margin = input.margin.clamp(0, MAX_MARGIN);
    let today = parse_day(&input.today);
    let mut per_day: Vec<Vec<Value>> = Vec::new();
    for day in input.days.iter().take(MAX_DAYS) {
        let Some(index) = parse_day(&day.day) else { continue };
        if input.part == "weekend" && !matches!(weekday(index), 0 | 6) {
            continue;
        }
        if day.load.max(0) + minutes > input.budget {
            continue;
        }
        let mut from = input.day_start.clamp(0, MINUTES_IN_DAY);
        let mut until = input.day_end.clamp(0, MINUTES_IN_DAY);
        match input.part.as_str() {
            "morning" => until = until.min(MORNING_END),
            "evening" => from = from.max(EVENING_START),
            _ => {}
        }
        if Some(index) == today {
            from = from.max(input.now_minute);
        }
        if Some(index) < today {
            continue;
        }
        per_day.push(day_slots(day, index, from, until, minutes, margin, input));
    }
    let total: usize = per_day.iter().map(Vec::len).sum();
    let limit = input.limit.clamp(1, MAX_LIMIT);
    let deepest = per_day.iter().map(Vec::len).max().unwrap_or(0);
    let slots: Vec<Value> = (0..deepest)
        .flat_map(|rank| per_day.iter().filter_map(move |slots| slots.get(rank).cloned()))
        .take(limit)
        .collect();
    json!({"slots": slots, "total": total})
}

fn day_slots(day: &DayIn, index: i64, from: i64, until: i64, minutes: i64, margin: i64, input: &Input) -> Vec<Value> {
    let mut busy: Vec<[i64; 2]> = day.busy.iter().filter(|[a, b]| a < b).copied().collect();
    busy.sort_unstable();
    // Занятое с запасом, слитое; сырое — для «до первых дел» и «после свободно»
    let mut padded: Vec<[i64; 2]> = Vec::new();
    for [a, b] in &busy {
        let (a, b) = (a - margin, b + margin);
        match padded.last_mut() {
            Some(last) if a <= last[1] => last[1] = last[1].max(b),
            _ => padded.push([a, b]),
        }
    }
    let first_busy = busy.first().map(|[a, _]| *a);
    let mut out = Vec::new();
    let mut cursor = from;
    for gap_end in padded.iter().map(|[a, _]| *a).chain([until]) {
        let start = round_up(cursor);
        let end = gap_end.min(until);
        if end - start >= minutes {
            let slot_end = start + minutes;
            let next_busy = busy.iter().map(|[a, _]| *a).find(|a| *a >= slot_end);
            out.push(json!({
                "day": day.day,
                "weekday": weekday(index),
                "start": start,
                "end": slot_end,
                "isFreeAfter": !matches!(next_busy, Some(a) if a < until),
                "isBeforeFirst": first_busy.is_some_and(|a| slot_end <= a && a < until),
                "load": day.load.max(0),
                "budget": input.budget,
            }));
        }
        if let Some(block) = padded.iter().find(|[a, _]| *a == gap_end) {
            cursor = cursor.max(block[1]);
        }
        if cursor >= until {
            break;
        }
    }
    out
}

fn round_up(minute: i64) -> i64 {
    (minute + ROUND_TO - 1).div_euclid(ROUND_TO) * ROUND_TO
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(days: Vec<DayIn>) -> Input {
        Input {
            minutes: 90,
            days,
            day_start: 540,
            day_end: 1260,
            budget: 480,
            margin: 15,
            part: "any".into(),
            limit: 3,
            today: "2026-11-16".into(),
            now_minute: 0,
        }
    }

    fn day(day: &str, busy: Vec<[i64; 2]>, load: i64) -> DayIn {
        DayIn { day: day.into(), busy, load }
    }

    #[test]
    fn first_slot_of_each_day_comes_first_and_margin_is_kept() {
        let v = run(&input(vec![
            day("2026-11-16", vec![[540, 1050]], 300),
            day("2026-11-17", vec![[600, 1200]], 300),
            day("2026-11-18", vec![], 300),
        ]));
        assert_eq!(v["total"], 2);
        let slots = v["slots"].as_array().unwrap();
        assert_eq!((slots[0]["start"].as_i64(), slots[0]["isFreeAfter"].as_bool()), (Some(1065), Some(true)), "17:30 + 15 мин запаса");
        // 9:00–10:00 свободно, но с запасом до 9:45 — 45 минут, меньше 90: окна во вторник нет
        assert_eq!(slots[1]["day"], "2026-11-18".to_string());
        assert_eq!(v["slots"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn budget_part_of_day_and_now() {
        let mut i = input(vec![day("2026-11-16", vec![], 400), day("2026-11-17", vec![], 0)]);
        assert_eq!(run(&i)["slots"][0]["day"], "2026-11-17", "16-го бюджет перебран");
        i.part = "evening".into();
        assert_eq!(run(&i)["slots"][0]["start"], 1020);
        i.part = "weekend".into();
        assert_eq!(run(&i)["total"], 0);
        i.part = "any".into();
        i.days = vec![day("2026-11-16", vec![], 0)];
        i.now_minute = 601;
        assert_eq!(run(&i)["slots"][0]["start"], 605);
    }
}
