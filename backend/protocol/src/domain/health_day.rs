//! Питание и активность «Здоровья» (spec 041 B3, HEALTH-3): итоги дня по приёмам пищи, закрытый день, неделя
//! калорий; шаги по дням, активные минуты и тренировки за семь дней. Считает движок, клиент рисует.
//!
//! Еда — запись `food` (`value` — ккал, `tag` — приём, `parts` — `protein`, `fat`, `carbs`, `fiber`, `grams`),
//! тренировка — `workout` (`value` — минуты либо отрезок, `tag` — тип, `parts` — `km`, `exercises`), закрытый
//! день питания — `food_close` с id `close-<день>` (регистр на день; `parts` — цели на момент закрытия).
//! Цели: `kcal`, `protein`, `fat`, `carbs` на день, `active_min` на неделю, `steps` на день.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::health::{self, HealthState};
use super::health_json::entry_json;
use super::health_view::{day_text, entry_day_index, round1, KIND_SLEEP, TAG_SLEEP_ASIDE};
use crate::pb::parvane::health::v1::Entry;

pub const KIND_FOOD: &str = "food";
pub const KIND_WORKOUT: &str = "workout";
pub const KIND_FOOD_CLOSE: &str = "food_close";
const KIND_STEPS: &str = "steps";
/// Приёмы пищи в порядке показа; завтрак, обед и ужин видны и пустыми («ещё не записан»).
const MEALS: [&str; 5] = ["breakfast", "lunch", "dinner", "snack", "other"];
const ALWAYS_SHOWN: usize = 3;
const MACROS: [&str; 4] = ["kcal", "protein", "fat", "carbs"];
const GOAL_ACTIVE: &str = "active_min";
const WEEK_DAYS: i64 = 7;
const DAY_MS: i64 = 86_400_000;

/// Виды со своими блоками: в общий список показателей сводки они не входят.
pub fn has_own_block(kind: &str) -> bool {
    kind == KIND_FOOD || kind == KIND_WORKOUT || kind == KIND_FOOD_CLOSE
}

fn macro_of(e: &Entry, key: &str) -> f64 {
    if key == "kcal" { e.value } else { health::part(e, key).unwrap_or(0.0) }
}

fn totals(entries: &[&&Entry]) -> Value {
    let sum = |key: &str| round1(entries.iter().map(|e| macro_of(e, key)).sum());
    json!({"kcal": sum("kcal").round(), "protein": sum("protein"), "fat": sum("fat"), "carbs": sum("carbs")})
}

fn weekday(day: i64) -> i64 {
    // 0 — понедельник (1970-01-01 — четверг)
    (day + 3).rem_euclid(7)
}

pub fn nutrition_view(entries: &[&Entry], goals: &BTreeMap<&str, f64>, today: i64) -> Value {
    let foods: Vec<&&Entry> = entries.iter().filter(|e| e.kind == KIND_FOOD && entry_day_index(e) <= today).collect();
    let closed_days: Vec<i64> = entries.iter().filter(|e| e.kind == KIND_FOOD_CLOSE).map(|e| entry_day_index(e)).collect();
    let of_day = |day: i64| foods.iter().copied().filter(|e| entry_day_index(e) == day).collect::<Vec<_>>();
    let today_foods = of_day(today);
    let meal_of = |e: &Entry| MEALS.iter().copied().find(|m| *m == e.tag).unwrap_or("other");
    let meals: Vec<Value> = MEALS
        .iter()
        .enumerate()
        .filter_map(|(i, meal)| {
            let list: Vec<&&Entry> = today_foods.iter().copied().filter(|e| meal_of(e) == *meal).collect();
            if list.is_empty() && i >= ALWAYS_SHOWN {
                return None;
            }
            let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).filter(|n| !n.is_empty()).collect();
            let mut out = totals(&list);
            out["meal"] = json!(meal);
            out["names"] = json!(names.join(", "));
            out["entries"] = json!(list.iter().map(|e| entry_json(e)).collect::<Vec<_>>());
            Some(out)
        })
        .collect();
    let total = totals(&today_foods);
    let goal_kcal = goals.get("kcal").copied();
    let kcal_today = total["kcal"].as_f64().unwrap_or(0.0);
    // Полный день — закрытый либо прошедший с записями: сегодняшний незакрытый в среднее не идёт
    let week: Vec<Value> = (today - WEEK_DAYS + 1..=today)
        .map(|day| {
            let list = of_day(day);
            let closed = closed_days.contains(&day);
            let kcal = if list.is_empty() && !closed { Value::Null } else { totals(&list)["kcal"].clone() };
            json!({"day": day_text(day), "weekday": weekday(day), "kcal": kcal, "closed": closed, "full": closed || (day < today && !list.is_empty())})
        })
        .collect();
    let full: Vec<f64> = week.iter().filter(|d| d["full"] == true).filter_map(|d| d["kcal"].as_f64()).collect();
    json!({
        "day": day_text(today),
        "closed": closed_days.contains(&today),
        "hasEntries": !today_foods.is_empty(),
        "total": total,
        "goals": MACROS.iter().map(|m| (m.to_string(), goals.get(m).map_or(Value::Null, |g| json!(g)))).collect::<serde_json::Map<_, _>>(),
        // Сколько осталось до цели по калориям; отрицательное — перебор
        "left": goal_kcal.map(|g| (g - kcal_today).round()),
        "meals": meals,
        "week": week,
        "weekAvg": if full.is_empty() { Value::Null } else { json!((full.iter().sum::<f64>() / full.len() as f64).round()) },
    })
}

fn workout_minutes(e: &Entry) -> f64 {
    if e.end_ms > e.at_ms { ((e.end_ms - e.at_ms) / 60_000) as f64 } else { e.value.max(0.0) }
}

pub fn activity_view(entries: &[&Entry], goals: &BTreeMap<&str, f64>, today: i64) -> Value {
    let in_week = |e: &&&Entry| (today - WEEK_DAYS + 1..=today).contains(&entry_day_index(e));
    let steps_on = |day: i64| {
        let list: Vec<f64> = entries.iter().filter(|e| e.kind == KIND_STEPS && entry_day_index(e) == day).map(|e| e.value).collect();
        (!list.is_empty()).then(|| list.iter().sum::<f64>())
    };
    let mut workouts: Vec<&&Entry> = entries.iter().filter(|e| e.kind == KIND_WORKOUT).filter(in_week).collect();
    workouts.sort_by(|a, b| (b.at_ms, &b.id).cmp(&(a.at_ms, &a.id)));
    let km: f64 = workouts.iter().filter_map(|e| health::part(e, "km")).sum();
    let list: Vec<Value> = workouts
        .iter()
        .map(|e| {
            let minutes = workout_minutes(e);
            let distance = health::part(e, "km").filter(|d| *d > 0.0);
            let mut out = entry_json(e);
            out["minutes"] = json!(minutes);
            out["weekday"] = json!(weekday(entry_day_index(e)));
            // Темп — секунд на километр
            out["paceSec"] = distance.filter(|_| minutes > 0.0).map_or(Value::Null, |d| json!((minutes * 60.0 / d).round()));
            out
        })
        .collect();
    let active: f64 = workouts.iter().map(|e| workout_minutes(e)).sum();
    json!({
        "stepsToday": steps_on(today),
        "stepsGoal": goals.get(KIND_STEPS),
        "stepsWeek": (today - WEEK_DAYS + 1..=today).map(|day| json!({"day": day_text(day), "weekday": weekday(day), "value": steps_on(day)})).collect::<Vec<_>>(),
        "activeMinutes": active.round(),
        "activeGoal": goals.get(GOAL_ACTIVE),
        "workoutCount": workouts.len(),
        "km": round1(km),
        "workouts": list,
    })
}

/// Больше дней за один запрос календарь не просит.
pub const MAX_DAYS_SPAN: i64 = 800;

/// Здоровье по дням для календаря «Плана» (spec 041 B4): сны, приёмы пищи и тренировки каждого дня отрезка.
/// `{goals:{<имя>: число}, days:[{day, closed, sleeps:[{id, minutes, bedMin, wakeMin}], foods:[{id, minute, name,
/// tag, kcal, parts}], workouts:[{id, minute, minutes, name, tag, parts}]}]}` — только дни с записями, по
/// возрастанию. Сон «не в сумму» не входит; время — минуты от местной полуночи записи.
pub fn days_json(state: &HealthState, from_day: &str, to_day: &str) -> String {
    let empty = || json!({"goals": {}, "days": []}).to_string();
    let (Some(from), Some(to)) = (parse_day(from_day), parse_day(to_day)) else { return empty() };
    if to < from || to - from > MAX_DAYS_SPAN {
        return empty();
    }
    let mut days: BTreeMap<i64, [Vec<Value>; 3]> = BTreeMap::new();
    let mut closed: Vec<i64> = Vec::new();
    let mut entries: Vec<&Entry> = state.live_entries().collect();
    entries.sort_by(|a, b| (a.at_ms, &a.id).cmp(&(b.at_ms, &b.id)));
    for e in entries {
        let day = entry_day_index(e);
        if !(from..=to).contains(&day) {
            continue;
        }
        let minute = health::minute_of_day(e.at_ms, e.tz_min);
        let parts: serde_json::Map<String, Value> = e.parts.iter().map(|p| (p.key.clone(), json!(p.value))).collect();
        let (slot, item) = match e.kind.as_str() {
            KIND_SLEEP if e.tag != TAG_SLEEP_ASIDE => {
                let span = e.end_ms > e.at_ms;
                let minutes = if span { (e.end_ms - e.at_ms) / 60_000 } else { (e.value as i64).max(0) };
                let clock = |ms: i64| if span { json!(health::minute_of_day(ms, e.tz_min)) } else { Value::Null };
                (0, json!({"id": e.id, "minutes": minutes, "bedMin": clock(e.at_ms), "wakeMin": clock(e.end_ms)}))
            }
            KIND_FOOD => (1, json!({"id": e.id, "minute": minute, "name": e.name, "tag": e.tag, "kcal": e.value, "parts": parts})),
            KIND_WORKOUT => (2, json!({"id": e.id, "minute": minute, "minutes": workout_minutes(e), "name": e.name, "tag": e.tag, "parts": parts})),
            KIND_FOOD_CLOSE => {
                closed.push(day);
                continue;
            }
            _ => continue,
        };
        if let Some(list) = days.entry(day).or_default().get_mut(slot) {
            list.push(item);
        }
    }
    for day in &closed {
        days.entry(*day).or_default();
    }
    let goals: serde_json::Map<String, Value> = state.live_goals().map(|g| (g.id.clone(), json!(g.target))).collect();
    let list: Vec<Value> = days
        .into_iter()
        .map(|(day, [sleeps, foods, workouts])| json!({"day": day_text(day), "closed": closed.contains(&day), "sleeps": sleeps, "foods": foods, "workouts": workouts}))
        .collect();
    json!({"goals": goals, "days": list}).to_string()
}

fn parse_day(text: &str) -> Option<i64> {
    let mut it = text.split('-');
    let (y, m, d) = (it.next()?.parse::<i64>().ok()?, it.next()?.parse::<u32>().ok()?, it.next()?.parse::<u32>().ok()?);
    if it.next().is_some() || !(2000..=2200).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(health::days_from_civil(y, m, d))
}

/// Изменение «закрыть день питания» / «открыть снова»: запись `{kind: "food_close", day, tzMin, closed}` →
/// регистр дня `close-<день>` с целями на момент закрытия либо его удаление.
pub fn close_change(src: &serde_json::Map<String, Value>, goals: &BTreeMap<&str, f64>) -> Option<Value> {
    let day = src.get("day").and_then(Value::as_str).and_then(parse_day)?;
    let tz_min = src.get("tzMin").and_then(Value::as_i64).unwrap_or(0).clamp(i64::from(health::TZ_MIN), i64::from(health::TZ_MAX));
    let id = format!("close-{}", day_text(day));
    if src.get("closed").and_then(Value::as_bool) == Some(false) {
        return Some(json!({"entry": {"id": id, "deleted": true}}));
    }
    let parts: serde_json::Map<String, Value> = MACROS.iter().filter_map(|m| goals.get(m).map(|g| (m.to_string(), json!(g)))).collect();
    // Полдень дня по местному времени: день записи не сдвинется при смене пояса на несколько часов
    let at_ms = day * DAY_MS + 720 * 60_000 - tz_min * 60_000;
    Some(json!({"entry": {"id": id, "kind": KIND_FOOD_CLOSE, "atMs": at_ms, "tzMin": tz_min, "source": "manual", "parts": parts}}))
}

#[cfg(test)]
mod tests {
    use super::super::health_json::op_from_json;
    use super::super::health_view::{compose_changes, day_index, view_json};
    use super::*;
    use crate::domain::Stamp;

    const TZ: i32 = 180;
    /// 2026-11-15 12:00 местного (UTC+3), воскресенье.
    const NOW: i64 = 1_794_733_200_000;

    fn at(day_offset: i64, hh: i64, mm: i64) -> i64 {
        (day_index(NOW, TZ) + day_offset) * DAY_MS - i64::from(TZ) * 60_000 + (hh * 60 + mm) * 60_000
    }

    fn apply(st: &mut HealthState, changes: &Value, lamport: u64) {
        let mut op = op_from_json(&changes.to_string()).unwrap();
        health::stamp_op(&mut op, &Stamp::new(lamport, "d1"));
        st.apply_op(&op, "d1").unwrap();
    }

    fn food(id: &str, meal: &str, name: &str, at_ms: i64, kcal: f64, pfc: (f64, f64, f64)) -> Value {
        json!({"entry": {"id": id, "kind": "food", "atMs": at_ms, "tzMin": TZ, "value": kcal, "unit": "kcal", "source": "text", "name": name, "tag": meal,
            "parts": {"protein": pfc.0, "fat": pfc.1, "carbs": pfc.2}}})
    }

    fn view(st: &HealthState) -> Value {
        serde_json::from_str(&view_json(st, NOW, TZ)).unwrap()
    }

    #[test]
    fn meals_totals_goals_and_closed_day() {
        let mut st = HealthState::default();
        apply(
            &mut st,
            &json!({"changes": [
                food("b1", "breakfast", "овсянка", at(0, 8, 0), 300.0, (12.0, 6.0, 40.0)),
                food("b2", "breakfast", "яйцо", at(0, 8, 5), 130.0, (10.0, 8.0, 8.0)),
                food("l1", "lunch", "гречка с курицей", at(0, 11, 30), 520.0, (42.0, 16.0, 52.0)),
                food("y1", "dinner", "паста", at(-1, 19, 0), 2000.0, (60.0, 70.0, 250.0)),
                food("tomorrow", "lunch", "из будущего", at(1, 13, 0), 900.0, (0.0, 0.0, 0.0)),
                {"goal": {"id": "kcal", "target": 2200}},
                {"goal": {"id": "protein", "target": 140}},
            ]}),
            1,
        );
        let n = view(&st)["nutrition"].clone();
        assert_eq!(n["day"], "2026-11-15");
        assert_eq!(n["total"], json!({"kcal": 950.0, "protein": 64.0, "fat": 30.0, "carbs": 100.0}));
        assert_eq!(n["goals"]["kcal"], 2200.0);
        assert_eq!(n["goals"]["fat"], Value::Null);
        assert_eq!(n["left"], 1250.0);
        let meals = n["meals"].as_array().unwrap();
        assert_eq!(meals.iter().map(|m| m["meal"].as_str().unwrap()).collect::<Vec<_>>(), ["breakfast", "lunch", "dinner"], "пустой перекус не показывается");
        assert_eq!(meals[0]["names"], "овсянка, яйцо");
        assert_eq!(meals[0]["kcal"], 430.0);
        assert_eq!(meals[2]["entries"].as_array().unwrap().len(), 0, "ужин ещё не записан");
        assert_eq!(n["closed"], false);
        // Среднее — по полным дням: вчера (прошёл, с записями); сегодня не закрыт
        assert_eq!(n["weekAvg"], 2000.0);
        assert!(view(&st)["metrics"].as_array().unwrap().iter().all(|m| m["kind"] != "food" && m["kind"] != "kcal"), "еда — не показатель сводки");

        // Закрыть день: регистр дня с целями; сегодня входит в среднее
        let close = compose_changes(&st, &[json!({"kind": "food_close", "day": "2026-11-15", "tzMin": TZ})], NOW);
        assert_eq!(close["changes"][0]["entry"]["id"], "close-2026-11-15");
        assert_eq!(close["changes"][0]["entry"]["parts"], json!({"kcal": 2200.0, "protein": 140.0}));
        apply(&mut st, &close, 2);
        let n = view(&st)["nutrition"].clone();
        assert_eq!(n["closed"], true);
        assert_eq!(n["weekAvg"], (2000.0 + 950.0) / 2.0);
        assert!(view(&st)["recent"].as_array().unwrap().iter().all(|e| e["kind"] != "food_close"));
        // Открыть снова и закрыть ещё раз — тот же регистр
        let reopen = compose_changes(&st, &[json!({"kind": "food_close", "day": "2026-11-15", "tzMin": TZ, "closed": false})], NOW);
        apply(&mut st, &reopen, 3);
        assert_eq!(view(&st)["nutrition"]["closed"], false);
        apply(&mut st, &close, 4);
        assert_eq!(view(&st)["nutrition"]["closed"], true);
        assert!(compose_changes(&st, &[json!({"kind": "food_close", "day": "15.11.2026"})], NOW)["changes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn days_for_calendar_carry_sleep_food_and_workouts() {
        let mut st = HealthState::default();
        let sleep = |id: &str, from: i64, to: i64, tag: &str| json!({"entry": {"id": id, "kind": "sleep", "atMs": from, "endMs": to, "tzMin": TZ, "unit": "min", "tag": tag}});
        apply(
            &mut st,
            &json!({"changes": [
                sleep("night", at(-1, 23, 30), at(0, 7, 0), ""),
                sleep("nap", at(0, 14, 0), at(0, 15, 0), "aside"),
                {"entry": {"id": "dur", "kind": "sleep", "atMs": at(-2, 0, 0), "tzMin": TZ, "value": 420, "unit": "min"}},
                food("l1", "lunch", "гречка", at(0, 13, 15), 520.0, (42.0, 16.0, 52.0)),
                {"entry": {"id": "run", "kind": "workout", "atMs": at(-1, 9, 0), "tzMin": TZ, "value": 35, "unit": "min", "tag": "run", "parts": {"km": 6.2}}},
                {"entry": {"id": "w", "kind": "weight", "atMs": at(0, 8, 0), "tzMin": TZ, "value": 72, "unit": "kg"}},
                {"goal": {"id": "kcal", "target": 2200}},
            ]}),
            1,
        );
        let close = compose_changes(&st, &[json!({"kind": "food_close", "day": "2026-11-10", "tzMin": TZ})], NOW);
        apply(&mut st, &close, 2);
        let v: Value = serde_json::from_str(&days_json(&st, "2026-11-01", "2026-11-15")).unwrap();
        assert_eq!(v["goals"]["kcal"], 2200.0);
        let days = v["days"].as_array().unwrap();
        assert_eq!(days.iter().map(|d| d["day"].as_str().unwrap()).collect::<Vec<_>>(), ["2026-11-10", "2026-11-13", "2026-11-14", "2026-11-15"]);
        assert_eq!(days[0]["closed"], true);
        assert_eq!(days[1]["sleeps"][0], json!({"id": "dur", "minutes": 420, "bedMin": null, "wakeMin": null}));
        assert_eq!(days[2]["workouts"][0]["minutes"], 35.0);
        assert_eq!(days[2]["workouts"][0]["parts"]["km"], 6.2);
        let today = &days[3];
        assert_eq!(today["sleeps"], json!([{"id": "night", "minutes": 450, "bedMin": 1410, "wakeMin": 420}]), "сон «не в сумму» не входит");
        assert_eq!(today["foods"][0]["minute"], 13 * 60 + 15);
        assert_eq!(today["foods"][0]["kcal"], 520.0);
        // Отрезок вне записей и негодный отрезок — пусто
        assert!(serde_json::from_str::<Value>(&days_json(&st, "2026-12-01", "2026-12-31")).unwrap()["days"].as_array().unwrap().is_empty());
        assert_eq!(days_json(&st, "2026-11-15", "2026-11-01"), days_json(&st, "x", "y"));
    }

    #[test]
    fn activity_sums_week_of_workouts_and_steps() {
        let mut st = HealthState::default();
        let workout = |id: &str, tag: &str, at_ms: i64, minutes: f64, parts: Value| json!({"entry": {"id": id, "kind": "workout", "atMs": at_ms, "tzMin": TZ, "value": minutes, "unit": "min", "source": "text", "tag": tag, "parts": parts}});
        let steps = |id: &str, at_ms: i64, v: f64| json!({"entry": {"id": id, "kind": "steps", "atMs": at_ms, "tzMin": TZ, "value": v, "unit": "steps"}});
        apply(
            &mut st,
            &json!({"changes": [
                workout("gym", "strength", at(-4, 18, 0), 80.0, json!({"exercises": 6})),
                workout("run", "run", at(-1, 9, 0), 35.0, json!({"km": 6.2})),
                workout("old", "run", at(-9, 9, 0), 50.0, json!({"km": 10})),
                steps("s1", at(0, 9, 0), 3000.0), steps("s2", at(0, 11, 0), 5400.0), steps("s3", at(-2, 20, 0), 7000.0),
                {"goal": {"id": "active_min", "target": 150}},
                {"goal": {"id": "steps", "target": 10000}},
            ]}),
            1,
        );
        let v = view(&st);
        let a = &v["activity"];
        assert_eq!(a["stepsToday"], 8400.0);
        assert_eq!(a["stepsGoal"], 10000.0);
        assert_eq!(a["stepsWeek"][4]["value"], 7000.0);
        assert_eq!(a["stepsWeek"][5]["value"], Value::Null);
        assert_eq!(a["activeMinutes"], 115.0);
        assert_eq!(a["activeGoal"], 150.0);
        assert_eq!(a["workoutCount"], 2);
        assert_eq!(a["km"], 6.2);
        assert_eq!(a["workouts"][0]["id"], "run", "новые первыми");
        assert_eq!(a["workouts"][0]["paceSec"], 339.0, "35 мин на 6,2 км — 5:39 на километр");
        assert_eq!(a["workouts"][1]["paceSec"], Value::Null);
        assert!(v["metrics"].as_array().unwrap().iter().all(|m| m["kind"] != "workout" && m["kind"] != "active_min"));
        assert!(v["metrics"].as_array().unwrap().iter().any(|m| m["kind"] == "steps"));
    }
}
