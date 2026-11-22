//! Сводка «Здоровья» для экранов (spec 038, HEALTH-3): всё, что экран показывает числом, считает движок — день
//! записи, сон за неделю, суммы за день, отклонение от цели, изменение за неделю и месяц. Клиент только рисует.
//!
//! Результат `view_json(state, now_ms, tz_min)`:
//! `{today, sleep:{goalBedMin, goalWakeMin, goalMinutes, last, lastDeltaMinutes, week:[7 дней], avgMinutes},
//!   metrics:[{kind, unit, isSum, last, goal, toGoal, today, weekDelta, monthDelta, series:[30 дней]}],
//!   recent:[записи, новые первыми], nutrition:{…}, activity:{…}}` — питание и активность считает `health_day`.
//! У показателя ещё `year` — двенадцать месяцев `[{month, value, value2}]` (среднее значений дней), у сна —
//! `month` (30 дней, минуты) и `year` (среднее минут за ночь по месяцам). Сон с меткой `aside` («не считать в
//! сумму сна за сутки») виден в записях, но в суммы, неделю и средние не входит.
//! Цели — регистры `Goal` с именем вида (`weight`, `steps`, `water`, …) и `sleep_bed` / `sleep_wake` (минуты от
//! полуночи). Виды-суммы (`steps`, `water`): значение дня — сумма записей; остальные — последняя запись дня.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::health::{self, HealthState};
use super::health_day;
use super::health_stats::{self, DayValue, Night, TAG_NO_SLEEP};
use super::health_json::entry_json;
use crate::pb::parvane::health::v1::Entry;

pub const KIND_SLEEP: &str = "sleep";
/// Отметки «лёг» и «встал» без пары: пара сводится в один сон при записи (`compose_changes`).
pub const KIND_SLEEP_START: &str = "sleep_start";
pub const KIND_SLEEP_END: &str = "sleep_end";
/// Виды, у которых значение дня — сумма записей.
pub(super) const SUM_KINDS: [&str; 2] = ["steps", "water"];
/// Виды, у которых цель — верхняя граница: дни выше неё подсвечиваются.
const UPPER_BOUND_KINDS: [&str; 1] = ["pressure"];
pub(super) const KIND_MOOD: &str = "mood";
const GOAL_SLEEP_BED: &str = "sleep_bed";
const GOAL_SLEEP_WAKE: &str = "sleep_wake";
/// Цели, которые показывают свои блоки (сон, питание, активность), а не список показателей.
const OWN_GOALS: [&str; 7] = [GOAL_SLEEP_BED, GOAL_SLEEP_WAKE, "kcal", "protein", "fat", "carbs", "active_min"];
const WEEK_DAYS: i64 = 7;
const SERIES_DAYS: i64 = 30;
const RECENT_LIMIT: usize = 30;
const YEAR_MONTHS: i64 = 12;
/// Метка сна, который пользователь попросил не считать в сумму сна за сутки (дневной сон формой).
pub const TAG_SLEEP_ASIDE: &str = "aside";
const DAY_MIN: i64 = 1440;
const DAY_MS: i64 = 86_400_000;
/// Сон короче десяти минут не записывается (как и в проверке формы, `health_parse::sleep_in_range`).
const MIN_SLEEP_MS: i64 = 10 * 60_000;

pub(super) fn day_index(ms: i64, tz_min: i32) -> i64 {
    (ms + i64::from(tz_min) * 60_000).div_euclid(DAY_MS)
}

pub(super) fn day_text(index: i64) -> String {
    let (y, m, d) = health::civil_from_days(index);
    format!("{y:04}-{m:02}-{d:02}")
}

/// День записи как номер дня от эпохи (у отрезка — день конца: сон относится к дню пробуждения).
pub(super) fn entry_day_index(e: &Entry) -> i64 {
    day_index(if e.end_ms != 0 { e.end_ms } else { e.at_ms }, e.tz_min)
}

/// Сон отрезком («лёг — встал») либо одной длительностью («спал 7 часов»: `end_ms` = 0, минуты в `value`).
fn has_span(e: &Entry) -> bool {
    e.end_ms > e.at_ms
}

fn sleep_minutes(e: &Entry) -> i64 {
    if has_span(e) {
        (e.end_ms - e.at_ms) / 60_000
    } else {
        (e.value as i64).max(0)
    }
}

fn clock(e: &Entry, ms: i64) -> Value {
    if has_span(e) {
        json!(health::minute_of_day(ms, e.tz_min))
    } else {
        Value::Null
    }
}

/// Незакрытое «лёг»: последняя отметка `sleep_start` за сутки до `now_ms`, после которой сна и «встал» нет.
pub fn open_sleep_start<'a>(entries: &[&'a Entry], now_ms: i64) -> Option<&'a Entry> {
    let start = entries.iter().copied().filter(|e| e.kind == KIND_SLEEP_START && e.at_ms <= now_ms && now_ms - e.at_ms <= DAY_MS).max_by_key(|e| (e.at_ms, &e.id))?;
    let closed = entries.iter().any(|e| (e.kind == KIND_SLEEP && has_span(e) && e.end_ms > start.at_ms) || (e.kind == KIND_SLEEP_END && e.at_ms > start.at_ms));
    (!closed).then_some(start)
}

/// Двенадцать месяцев до месяца дня `today` включительно: `(текст ГГГГ-ММ, первый день, первый день следующего)`.
fn year_months(today: i64) -> Vec<(String, i64, i64)> {
    let (y, m, _) = health::civil_from_days(today);
    let index = y * 12 + i64::from(m) - 1;
    (index - YEAR_MONTHS + 1..=index)
        .map(|i| {
            let first = |i: i64| health::days_from_civil(i.div_euclid(12), (i.rem_euclid(12) + 1) as u32, 1);
            (format!("{:04}-{:02}", i.div_euclid(12), i.rem_euclid(12) + 1), first(i), first(i + 1))
        })
        .collect()
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

pub(super) fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn goal_of(goals: &BTreeMap<&str, f64>, id: &str) -> Value {
    goals.get(id).map_or(Value::Null, |v| json!(v))
}

/// Длительность сна по цели: от «лечь» до «встать» через полночь.
fn goal_sleep_minutes(goals: &BTreeMap<&str, f64>) -> Option<i64> {
    let bed = *goals.get(GOAL_SLEEP_BED)? as i64;
    let wake = *goals.get(GOAL_SLEEP_WAKE)? as i64;
    Some((wake - bed).rem_euclid(DAY_MIN)).filter(|m| *m > 0)
}

fn sleep_json(e: &Entry) -> Value {
    json!({
        "id": e.id, "startMs": e.at_ms, "endMs": e.end_ms, "minutes": sleep_minutes(e), "day": health::entry_day(e),
        "bedMin": clock(e, e.at_ms), "wakeMin": clock(e, e.end_ms),
    })
}

/// Сон, который входит в ночь дня: не «не в сумму» и с длительностью; «не спал» — ночь в ноль минут.
fn counts_as_sleep(e: &Entry) -> bool {
    e.kind == KIND_SLEEP && e.tag != TAG_SLEEP_ASIDE && (sleep_minutes(e) > 0 || e.tag == TAG_NO_SLEEP)
}

/// Ночи по дням пробуждения до `today`: сумма сна дня и «лёг / встал» самого длинного сна.
pub(super) fn nights_by_day(entries: &[&Entry], today: i64) -> BTreeMap<i64, Night> {
    let mut by_day: BTreeMap<i64, Vec<&Entry>> = BTreeMap::new();
    for e in entries.iter().copied().filter(|e| counts_as_sleep(e) && entry_day_index(e) <= today) {
        by_day.entry(entry_day_index(e)).or_default().push(e);
    }
    by_day
        .into_iter()
        .filter_map(|(day, list)| {
            let main = list.iter().max_by_key(|e| (sleep_minutes(e), e.at_ms))?;
            let clock_of = |ms: i64| has_span(main).then(|| i64::from(health::minute_of_day(ms, main.tz_min)));
            Some((day, Night { total: list.iter().map(|e| sleep_minutes(e)).sum(), bed: clock_of(main.at_ms), wake: clock_of(main.end_ms) }))
        })
        .collect()
}

fn sleep_view(entries: &[&Entry], goals: &BTreeMap<&str, f64>, today: i64, now_ms: i64) -> Value {
    let sleeps: Vec<&&Entry> = entries.iter().filter(|e| counts_as_sleep(e) && entry_day_index(e) <= today).collect();
    // Главный сон дня — самый длинный; дневной сон входит в сумму дня, но не в «лёг / встал»
    let main_of = |day: i64| sleeps.iter().filter(|e| entry_day_index(e) == day).max_by_key(|e| (sleep_minutes(e), e.at_ms));
    let total_of = |day: i64| sleeps.iter().filter(|e| entry_day_index(e) == day).map(|e| sleep_minutes(e)).sum::<i64>();
    let goal_minutes = goal_sleep_minutes(goals);
    let last_day = sleeps.iter().map(|e| entry_day_index(e)).max();
    let last = last_day.and_then(main_of);
    let week: Vec<Value> = (today - WEEK_DAYS + 1..=today)
        .map(|day| {
            let main = main_of(day);
            json!({
                "day": day_text(day),
                // 0 — понедельник (1970-01-01 — четверг)
                "weekday": (day + 3).rem_euclid(7),
                "minutes": if main.is_some() { json!(total_of(day)) } else { Value::Null },
                // Отклонение ночи от цели (минуты)
                "deltaMinutes": main.and(goal_minutes).map(|goal| total_of(day) - goal),
                "bedMin": main.map_or(Value::Null, |e| clock(e, e.at_ms)),
                "wakeMin": main.map_or(Value::Null, |e| clock(e, e.end_ms)),
            })
        })
        .collect();
    let nights: Vec<i64> = (today - WEEK_DAYS + 1..=today).filter(|d| main_of(*d).is_some()).map(total_of).collect();
    let avg = if nights.is_empty() { Value::Null } else { json!(nights.iter().sum::<i64>() / nights.len() as i64) };
    json!({
        "goalBedMin": goal_of(goals, GOAL_SLEEP_BED),
        "goalWakeMin": goal_of(goals, GOAL_SLEEP_WAKE),
        "goalMinutes": goal_minutes,
        "last": last.map_or(Value::Null, |e| sleep_json(e)),
        "lastTotalMinutes": last_day.map(total_of),
        "lastDeltaMinutes": last_day.zip(goal_minutes).map(|(day, goal)| total_of(day) - goal),
        "week": week,
        "avgMinutes": avg,
        // Месяц по дням: сумма сна и «лёг / встал» главного сна — режим за месяц
        "month": (today - SERIES_DAYS + 1..=today).map(|day| {
            let main = main_of(day);
            json!({
                "day": day_text(day), "weekday": (day + 3).rem_euclid(7), "minutes": main.map(|_| total_of(day)),
                "deltaMinutes": main.and(goal_minutes).map(|goal| total_of(day) - goal),
                "bedMin": main.map_or(Value::Null, |e| clock(e, e.at_ms)),
                "wakeMin": main.map_or(Value::Null, |e| clock(e, e.end_ms)),
            })
        }).collect::<Vec<_>>(),
        "year": year_months(today).into_iter().map(|(month, from, to)| {
            let nights: Vec<f64> = (from..to.min(today + 1)).filter(|d| main_of(*d).is_some()).map(|d| total_of(d) as f64).collect();
            json!({"month": month, "minutes": mean(&nights).map(f64::round)})
        }).collect::<Vec<_>>(),
        // Отмечено «лёг», а «встал» ещё нет: экран предлагает «Встал»
        "openStartMs": open_sleep_start(entries, now_ms).map(|e| e.at_ms),
        "stats": health_stats::sleep_stats(
            &nights_by_day(entries, today), today,
            goals.get(GOAL_SLEEP_BED).map(|v| *v as i64), goals.get(GOAL_SLEEP_WAKE).map(|v| *v as i64), goal_minutes,
        ),
    })
}

/// Значения дней показателя: сумма у видов-сумм, иначе последняя запись дня; и число записей дня.
fn day_values(of_kind: &[&&Entry], is_sum: bool) -> BTreeMap<i64, DayValue> {
    let mut by_day: BTreeMap<i64, Vec<&Entry>> = BTreeMap::new();
    for e in of_kind {
        by_day.entry(entry_day_index(e)).or_default().push(e);
    }
    by_day
        .into_iter()
        .filter_map(|(day, list)| {
            let refs: Vec<&&Entry> = list.iter().collect();
            day_value(&refs, is_sum).map(|(v, v2)| (day, (v, v2, list.len())))
        })
        .collect()
}

/// Значение дня: сумма записей у видов-сумм, иначе последняя запись дня.
fn day_value(of_day: &[&&Entry], is_sum: bool) -> Option<(f64, f64)> {
    if is_sum {
        return (!of_day.is_empty()).then(|| (of_day.iter().map(|e| e.value).sum(), 0.0));
    }
    of_day.iter().max_by_key(|e| (e.at_ms, &e.id)).map(|e| (e.value, e.value2))
}

fn metric_view(kind: &str, entries: &[&Entry], goals: &BTreeMap<&str, f64>, today: i64) -> Value {
    let of_kind: Vec<&&Entry> = entries.iter().filter(|e| e.kind == kind && entry_day_index(e) <= today).collect();
    let is_sum = SUM_KINDS.contains(&kind);
    let value_on = |day: i64| day_value(&of_kind.iter().copied().filter(|e| entry_day_index(e) == day).collect::<Vec<_>>(), is_sum);
    // Ближайшее значение не позже дня: для «изменилось за неделю / месяц»
    let value_before = |day: i64| of_kind.iter().map(|e| entry_day_index(e)).filter(|d| *d <= day).max().and_then(value_on);
    let last = of_kind.iter().max_by_key(|e| (e.at_ms, &e.id));
    let current = last.map(|e| entry_day_index(e)).and_then(value_on).map(|v| v.0);
    let delta = |days: i64| -> Value {
        if is_sum {
            return Value::Null;
        }
        match (current, last.map(|e| entry_day_index(e) - days).and_then(value_before)) {
            (Some(now), Some((then, _))) => json!(round1(now - then)),
            _ => Value::Null,
        }
    };
    let goal = goals.get(kind).copied();
    let is_upper_bound = UPPER_BOUND_KINDS.contains(&kind);
    let days = day_values(&of_kind, is_sum);
    // `goalMet` — у сумм набрано не меньше цели, у верхней границы (давление) — не выше; без цели — нет
    let series: Vec<Value> = days
        .range(today - SERIES_DAYS + 1..=today)
        .map(|(day, (v, v2, _))| {
            let met = goal.filter(|_| is_sum || is_upper_bound).map(|g| health_stats::goal_met(*v, g, is_upper_bound));
            json!({"day": day_text(*day), "weekday": (day + 3).rem_euclid(7), "value": round1(*v), "value2": round1(*v2), "goalMet": met})
        })
        .collect();
    let today_value = value_on(today).map(|v| round1(v.0));
    json!({
        "kind": kind,
        "unit": last.map_or("", |e| e.unit.as_str()),
        "isSum": is_sum,
        "last": last.map_or(Value::Null, |e| entry_json(e)),
        "goal": goal,
        // Сколько осталось до цели: у сумм — от сегодняшнего итога, у остальных — от последнего значения
        "toGoal": goal.and_then(|g| if is_sum { Some(round1(g - today_value.unwrap_or(0.0))) } else { current.map(|c| round1(c - g)) }),
        "today": today_value,
        "weekDelta": delta(7),
        "monthDelta": delta(30),
        "yearDelta": delta(365),
        // Темп за неделю по прямой через дни месяца (вес); у сумм — нет
        "paceWeek": if is_sum { None } else { health_stats::pace_week(&days, today) },
        "isUpperBound": is_upper_bound,
        "periods": health_stats::metric_periods(&days, today, goal, is_sum, is_upper_bound),
        "series": series,
        // Год по месяцам: среднее значений дней (у сумм — среднее дневных итогов); месяц без записей — пусто
        "year": year_months(today).into_iter().map(|(month, from, to)| {
            let days: Vec<(f64, f64)> = (from..to.min(today + 1)).filter_map(value_on).collect();
            let avg = |pick: fn(&(f64, f64)) -> f64| mean(&days.iter().map(pick).collect::<Vec<_>>()).map(round1);
            json!({"month": month, "value": avg(|d| d.0), "value2": avg(|d| d.1)})
        }).collect::<Vec<_>>(),
    })
}

pub fn view_json(state: &HealthState, now_ms: i64, tz_min: i32) -> String {
    let tz_min = tz_min.clamp(health::TZ_MIN, health::TZ_MAX);
    let today = day_index(now_ms, tz_min);
    let mut entries: Vec<&Entry> = state.live_entries().collect();
    entries.sort_by(|a, b| (a.at_ms, &a.id).cmp(&(b.at_ms, &b.id)));
    let goals: BTreeMap<&str, f64> = state.live_goals().map(|g| (g.id.as_str(), g.target)).collect();
    let is_sleep_kind = |k: &str| k == KIND_SLEEP || k == KIND_SLEEP_START || k == KIND_SLEEP_END;
    let mut kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).filter(|k| !is_sleep_kind(k) && !health_day::has_own_block(k)).collect();
    // Показатель с целью виден и без записей; цели питания и активных минут — в своих блоках
    kinds.extend(goals.keys().copied().filter(|g| !OWN_GOALS.contains(g)));
    kinds.sort_unstable();
    kinds.dedup();
    let recent: Vec<Value> = entries.iter().rev().filter(|e| entry_day_index(e) <= today && e.kind != health_day::KIND_FOOD_CLOSE).take(RECENT_LIMIT).map(|e| entry_json(e)).collect();
    json!({
        "today": day_text(today),
        "sleep": sleep_view(&entries, &goals, today, now_ms),
        "metrics": kinds.iter().map(|k| metric_view(k, &entries, &goals, today)).collect::<Vec<_>>(),
        "recent": recent,
        "moodSleep": mood_sleep_view(&entries, today),
        "nutrition": health_day::nutrition_view(&entries, &goals, today),
        "activity": health_day::activity_view(&entries, &goals, today),
    })
    .to_string()
}

/// Связь самочувствия со сном за месяц (`health_stats::mood_sleep`): оценка дня — последняя запись дня.
fn mood_sleep_view(entries: &[&Entry], today: i64) -> Value {
    let moods: Vec<&&Entry> = entries.iter().filter(|e| e.kind == KIND_MOOD && entry_day_index(e) <= today).collect();
    let mood_days: BTreeMap<i64, f64> = day_values(&moods, false).into_iter().map(|(d, v)| (d, v.0)).collect();
    health_stats::mood_sleep(&mood_days, &nights_by_day(entries, today), today)
}

/// Изменения для записи разобранного ввода (`health_parse::parse_json` → поле `entries`): каждой записи —
/// случайный id; «встал» после незакрытого «лёг» сводится в один сон (отметка «лёг» удаляется); сон отрезком
/// закрывает незакрытое «лёг»; `food_close` — закрыть либо открыть день питания (`health_day::close_change`).
/// Результат — `{"changes":[…]}` для `op_from_json`.
pub fn compose_changes(state: &HealthState, parsed: &[Value], now_ms: i64) -> Value {
    let entries: Vec<&Entry> = state.live_entries().collect();
    let mut open = open_sleep_start(&entries, now_ms).map(|e| (e.id.clone(), e.at_ms, e.tz_min));
    let goals: BTreeMap<&str, f64> = state.live_goals().map(|g| (g.id.as_str(), g.target)).collect();
    let mut changes = Vec::new();
    for item in parsed {
        let Some(src) = item.as_object() else { continue };
        let field = |k: &str| src.get(k).cloned().unwrap_or(Value::Null);
        let kind = src.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind == health_day::KIND_FOOD_CLOSE {
            changes.extend(health_day::close_change(src, &goals));
            continue;
        }
        let at_ms = src.get("atMs").and_then(Value::as_i64).unwrap_or(0);
        let end_ms = src.get("endMs").and_then(Value::as_i64).unwrap_or(0);
        let mut entry = json!({
            "id": new_id(), "kind": kind, "atMs": at_ms, "endMs": end_ms, "tzMin": field("tzMin"), "value": field("value"),
            "value2": field("value2"), "unit": field("unit"), "source": field("source"), "note": field("note"),
            "name": field("name"), "tag": field("tag"), "parts": field("parts"), "createdMs": now_ms,
        });
        let closes = match &open {
            Some((_, start_ms, _)) if kind == KIND_SLEEP_END && at_ms > *start_ms && at_ms - *start_ms <= health::MAX_SPAN_MS => true,
            Some((_, start_ms, _)) => kind == KIND_SLEEP && end_ms > *start_ms,
            None => false,
        };
        if closes {
            let (id, start_ms, _) = open.take().unwrap_or_default();
            changes.push(json!({"entry": {"id": id, "deleted": true}}));
            // «Встал» через минуты после «лёг» — передумал ложиться: отметка снимается, сна нет
            if kind == KIND_SLEEP_END && at_ms - start_ms < MIN_SLEEP_MS {
                continue;
            }
            if kind == KIND_SLEEP_END {
                entry["kind"] = json!(KIND_SLEEP);
                entry["atMs"] = json!(start_ms);
                entry["endMs"] = json!(at_ms);
                entry["value"] = json!((at_ms - start_ms) / 60_000);
                entry["unit"] = json!("min");
            }
        }
        changes.push(json!({"entry": entry}));
    }
    json!({"changes": changes})
}

fn new_id() -> String {
    let mut id = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    hex::encode(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::health_json::op_from_json;
    use crate::domain::Stamp;

    const TZ: i32 = 180;
    /// 2026-11-15 12:00 местного (UTC+3), воскресенье.
    const NOW: i64 = 1_794_733_200_000;

    fn at(day_offset: i64, hh: i64, mm: i64) -> i64 {
        let midnight = (day_index(NOW, TZ) + day_offset) * DAY_MS - i64::from(TZ) * 60_000;
        midnight + (hh * 60 + mm) * 60_000
    }

    fn state(changes: &[String]) -> HealthState {
        let mut st = HealthState::default();
        for (i, change) in changes.iter().enumerate() {
            let mut op = op_from_json(&format!(r#"{{"changes":[{change}]}}"#)).unwrap();
            health::stamp_op(&mut op, &Stamp::new(i as u64 + 1, "d1"));
            st.apply_op(&op, "d1").unwrap();
        }
        st
    }

    fn entry(id: &str, kind: &str, at_ms: i64, end_ms: i64, value: f64, value2: f64) -> String {
        format!(r#"{{"entry":{{"id":"{id}","kind":"{kind}","atMs":{at_ms},"endMs":{end_ms},"tzMin":{TZ},"value":{value},"value2":{value2},"unit":"u","source":"text"}}}}"#)
    }

    fn goal(id: &str, target: f64) -> String {
        format!(r#"{{"goal":{{"id":"{id}","target":{target}}}}}"#)
    }

    #[test]
    fn sleep_belongs_to_wake_day_and_compares_with_goal() {
        let st = state(&[
            entry("s1", "sleep", at(0, 0, 10), at(0, 7, 5), 0.0, 0.0),
            entry("s2", "sleep", at(-2, 23, 30), at(-1, 6, 50), 0.0, 0.0),
            entry("nap", "sleep", at(-1, 14, 0), at(-1, 15, 10), 0.0, 0.0),
            goal("sleep_bed", 1410.0),
            goal("sleep_wake", 420.0),
        ]);
        let v: Value = serde_json::from_str(&view_json(&st, NOW, TZ)).unwrap();
        assert_eq!(v["today"], "2026-11-15");
        assert_eq!(v["sleep"]["goalMinutes"], 450);
        assert_eq!(v["sleep"]["last"]["id"], "s1");
        assert_eq!(v["sleep"]["last"]["minutes"], 415);
        assert_eq!(v["sleep"]["last"]["bedMin"], 10);
        assert_eq!(v["sleep"]["last"]["wakeMin"], 425);
        assert_eq!(v["sleep"]["lastDeltaMinutes"], -35);
        let week = v["sleep"]["week"].as_array().unwrap();
        assert_eq!(week.len(), 7);
        assert_eq!(week[6]["day"], "2026-11-15");
        assert_eq!(week[6]["weekday"], 6, "15 ноября 2026 — воскресенье");
        // Вчера: ночной сон 7 ч 20 мин + дневной 1 ч 10 мин; «лёг / встал» — у ночного
        assert_eq!(week[5]["minutes"], 510);
        assert_eq!(week[5]["bedMin"], 1410);
        assert_eq!(week[4]["minutes"], Value::Null);
        assert_eq!(v["sleep"]["avgMinutes"], (415 + 510) / 2);
    }

    #[test]
    fn metrics_last_value_sums_goals_and_deltas() {
        let st = state(&[
            entry("w0", "weight", at(-30, 8, 0), 0, 73.4, 0.0),
            entry("w1", "weight", at(-7, 8, 0), 0, 72.6, 0.0),
            entry("w2", "weight", at(0, 7, 20), 0, 72.0, 0.0),
            entry("p1", "pressure", at(-1, 21, 40), 0, 120.0, 80.0),
            entry("st1", "steps", at(0, 9, 0), 0, 3000.0, 0.0),
            entry("st2", "steps", at(0, 11, 0), 0, 5400.0, 0.0),
            entry("future", "weight", at(2, 8, 0), 0, 60.0, 0.0),
            goal("weight", 70.0),
            goal("steps", 10000.0),
            goal("water", 2000.0),
        ]);
        let v: Value = serde_json::from_str(&view_json(&st, NOW, TZ)).unwrap();
        let metric = |kind: &str| v["metrics"].as_array().unwrap().iter().find(|m| m["kind"] == kind).cloned().unwrap();
        let weight = metric("weight");
        assert_eq!(weight["last"]["id"], "w2", "запись из будущего в сводку не входит");
        assert_eq!(weight["toGoal"], 2.0);
        assert_eq!(weight["weekDelta"], -0.6);
        assert_eq!(weight["monthDelta"], -1.4);
        assert_eq!(weight["series"].as_array().unwrap().len(), 2, "ряд — за 30 дней, запись 30-дневной давности вне окна");
        let steps = metric("steps");
        assert_eq!(steps["isSum"], true);
        assert_eq!(steps["today"], 8400.0);
        assert_eq!(steps["toGoal"], 1600.0);
        assert_eq!(steps["weekDelta"], Value::Null);
        assert_eq!(metric("pressure")["last"]["value2"], 80.0);
        // Цель без записей: показатель виден, до цели — вся цель
        let water = metric("water");
        assert_eq!(water["last"], Value::Null);
        assert_eq!(water["toGoal"], 2000.0);
        assert_eq!(v["recent"][0]["id"], "st2");
        assert!(v["recent"].as_array().unwrap().iter().all(|e| e["id"] != "future"));
    }

    #[test]
    fn lone_marks_pair_into_one_sleep() {
        let st = state(&[entry("start", "sleep_start", at(-1, 23, 40), 0, 0.0, 0.0), entry("w", "weight", at(0, 7, 0), 0, 72.0, 0.0)]);
        let v: Value = serde_json::from_str(&view_json(&st, at(0, 7, 30), TZ)).unwrap();
        assert_eq!(v["sleep"]["openStartMs"], at(-1, 23, 40));
        assert!(v["metrics"].as_array().unwrap().iter().all(|m| m["kind"] != "sleep_start"), "отметка — не показатель");
        let woke = json!({"kind": "sleep_end", "atMs": at(0, 7, 20), "endMs": 0, "tzMin": TZ, "value": 0, "value2": 0, "unit": "", "source": "text"});
        let composed = compose_changes(&st, &[woke.clone()], at(0, 7, 30));
        let changes = composed["changes"].as_array().unwrap();
        assert_eq!(changes[0], json!({"entry": {"id": "start", "deleted": true}}));
        assert_eq!(changes[1]["entry"]["kind"], "sleep");
        assert_eq!(changes[1]["entry"]["atMs"], at(-1, 23, 40));
        assert_eq!(changes[1]["entry"]["endMs"], at(0, 7, 20));
        assert_eq!(changes[1]["entry"]["value"], 460);
        // Применённое: один сон, отметки «лёг» больше нет
        let mut next = st.clone();
        let mut op = op_from_json(&composed.to_string()).unwrap();
        health::stamp_op(&mut op, &Stamp::new(50, "d1"));
        next.apply_op(&op, "d1").unwrap();
        let after: Value = serde_json::from_str(&view_json(&next, at(0, 7, 30), TZ)).unwrap();
        assert_eq!(after["sleep"]["openStartMs"], Value::Null);
        assert_eq!(after["sleep"]["last"]["minutes"], 460);
        // «Встал» через пять минут после «лёг» — отметка снята, сна нет
        let quick = json!({"kind": "sleep_end", "atMs": at(-1, 23, 45), "endMs": 0, "tzMin": TZ, "value": 0, "value2": 0, "unit": "", "source": "button"});
        let cancelled = compose_changes(&st, &[quick], at(-1, 23, 46));
        assert_eq!(cancelled["changes"], json!([{"entry": {"id": "start", "deleted": true}}]));
        // Без незакрытого «лёг» отметка «встал» остаётся отметкой; у каждой записи свой id
        let lone = compose_changes(&HealthState::default(), &[woke.clone(), woke], at(0, 7, 30));
        assert_eq!(lone["changes"][0]["entry"]["kind"], "sleep_end");
        assert_ne!(lone["changes"][0]["entry"]["id"], lone["changes"][1]["entry"]["id"]);
    }

    #[test]
    fn year_by_months_and_sleep_set_aside() {
        let mut nap = entry("nap", "sleep", at(0, 14, 0), at(0, 15, 0), 0.0, 0.0);
        nap = nap.replace(r#""unit":"u""#, r#""unit":"u","tag":"aside""#);
        let st = state(&[
            entry("w1", "weight", at(-40, 8, 0), 0, 74.0, 0.0),
            entry("w2", "weight", at(-10, 8, 0), 0, 73.0, 0.0),
            entry("w3", "weight", at(0, 8, 0), 0, 72.0, 0.0),
            entry("st1", "steps", at(-1, 9, 0), 0, 4000.0, 0.0),
            entry("st2", "steps", at(-1, 19, 0), 0, 2000.0, 0.0),
            entry("st3", "steps", at(0, 9, 0), 0, 8000.0, 0.0),
            entry("s1", "sleep", at(-1, 23, 0), at(0, 7, 0), 0.0, 0.0),
            nap,
        ]);
        let v: Value = serde_json::from_str(&view_json(&st, NOW, TZ)).unwrap();
        let metric = |kind: &str| v["metrics"].as_array().unwrap().iter().find(|m| m["kind"] == kind).cloned().unwrap();
        let year = metric("weight")["year"].clone();
        assert_eq!(year.as_array().unwrap().len(), 12);
        assert_eq!(year[11], json!({"month": "2026-11", "value": 72.5, "value2": 0.0}), "ноябрь: 73 и 72");
        assert_eq!(year[10]["value"], 74.0);
        assert_eq!(year[0], json!({"month": "2025-12", "value": null, "value2": null}));
        assert_eq!(metric("steps")["year"][11]["value"], 7000.0, "среднее дневных итогов: 6000 и 8000");
        // Сон «не в сумму» виден в записях, но ночь остаётся 8 часов
        assert_eq!(v["sleep"]["lastTotalMinutes"], 480);
        assert_eq!(v["sleep"]["month"].as_array().unwrap().len(), 30);
        assert_eq!(v["sleep"]["month"][29]["day"], "2026-11-15");
        assert_eq!(v["sleep"]["month"][29]["minutes"], 480);
        assert_eq!(v["sleep"]["month"][29]["bedMin"], 1380, "режим за месяц — «лёг» главного сна");
        assert_eq!(v["sleep"]["year"][11], json!({"month": "2026-11", "minutes": 480.0}));
        assert!(v["recent"].as_array().unwrap().iter().any(|e| e["id"] == "nap"));
    }

    #[test]
    fn sleep_by_duration_counts_without_clock() {
        let st = state(&[entry("d", "sleep", at(0, 0, 0), 0, 420.0, 0.0)]);
        let v: Value = serde_json::from_str(&view_json(&st, NOW, TZ)).unwrap();
        assert_eq!(v["sleep"]["last"]["minutes"], 420);
        assert_eq!(v["sleep"]["last"]["bedMin"], Value::Null);
        assert_eq!(v["sleep"]["week"][6]["minutes"], 420);
    }

    #[test]
    fn empty_state_gives_empty_view() {
        let v: Value = serde_json::from_str(&view_json(&HealthState::default(), NOW, TZ)).unwrap();
        assert_eq!(v["sleep"]["last"], Value::Null);
        assert_eq!(v["sleep"]["week"].as_array().unwrap().len(), 7);
        assert!(v["metrics"].as_array().unwrap().is_empty());
        assert!(v["recent"].as_array().unwrap().is_empty());
    }
}
