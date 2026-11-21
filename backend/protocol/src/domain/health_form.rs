//! Формы «Здоровья» (spec 038, HEALTH-3): записи показателя страницами для подробного экрана и проверка
//! записи, собранной формой (правка записи, дневной сон, шкала самочувствия). Диапазоны — те же, что у
//! разбора текста (`health_parse::in_range`): строка и форма принимают одно и то же.

use serde_json::{json, Value};

use super::health::{self, HealthState};
use std::collections::BTreeMap;

use super::health_json::{entry_json, entry_of};
use super::health_stats::{self, TAG_NO_SLEEP};
use super::health_view::{day_index, day_text, entry_day_index, KIND_MOOD, KIND_SLEEP, KIND_SLEEP_END, KIND_SLEEP_START, SUM_KINDS};
use crate::health_parse;
use crate::pb::parvane::health::v1::Entry;

/// Больше записей за один запрос экран не просит.
pub const MAX_PAGE: usize = 2000;
/// Вид страницы «сон»: сон вместе с отметками «лёг» и «встал».
const SLEEP_KINDS: [&str; 3] = [KIND_SLEEP, KIND_SLEEP_START, KIND_SLEEP_END];
/// Запись формы ещё без id (id даёт `compose_changes`).
const DRAFT_ID: &str = "draft";

/// Виды, у которых запись — не число показателя: изменение к предыдущей им не считается.
const NO_DELTA_KINDS: [&str; 6] = [KIND_SLEEP, KIND_SLEEP_START, KIND_SLEEP_END, "food", "workout", KIND_MOOD];

/// Записи вида новыми первыми, не больше `limit`: `{"entries":[…], "hasMore":bool}`. Пустой вид — все записи.
/// Запись из будущего не входит, как и в сводку. У записи показателя — `delta` (к предыдущей записи того же вида),
/// у сна — `goalDelta` (минуты к цели режима), у давления — `pulse` (пульс той же минуты). У видов-сумм ещё
/// `days` — итоги дней новыми первыми с оценкой самочувствия дня и её заметкой (`hasMoreDays`).
pub fn entries_json(state: &HealthState, kind: &str, limit: usize, now_ms: i64, tz_min: i32) -> String {
    let today = day_index(now_ms, tz_min.clamp(health::TZ_MIN, health::TZ_MAX));
    let limit = limit.min(MAX_PAGE);
    let wanted = |e: &Entry| match kind {
        "" => e.kind != super::health_day::KIND_FOOD_CLOSE,
        KIND_SLEEP => SLEEP_KINDS.contains(&e.kind.as_str()),
        _ => e.kind == kind,
    };
    let mut entries: Vec<&Entry> = state.live_entries().filter(|e| wanted(e) && entry_day_index(e) <= today).collect();
    entries.sort_by(|a, b| (b.at_ms, &b.id).cmp(&(a.at_ms, &a.id)));
    let all: Vec<&Entry> = state.live_entries().filter(|e| entry_day_index(e) <= today).collect();
    let goals: BTreeMap<&str, f64> = state.live_goals().map(|g| (g.id.as_str(), g.target)).collect();
    let goal_sleep = goals.get("sleep_bed").zip(goals.get("sleep_wake")).map(|(b, w)| (*w as i64 - *b as i64).rem_euclid(1440)).filter(|m| *m > 0);
    let pulses: Vec<&Entry> = all.iter().copied().filter(|e| e.kind == "pulse").collect();
    let page: Vec<Value> = entries.iter().take(limit).map(|e| enriched(e, &all, goal_sleep, &pulses)).collect();
    let mut out = json!({"entries": page, "hasMore": entries.len() > limit});
    if SUM_KINDS.contains(&kind) {
        let (days, has_more) = day_totals(&entries, &all, limit);
        out["days"] = json!(days);
        out["hasMoreDays"] = json!(has_more);
    }
    out.to_string()
}

fn enriched(e: &Entry, all: &[&Entry], goal_sleep: Option<i64>, pulses: &[&Entry]) -> Value {
    let mut v = entry_json(e);
    if e.kind == KIND_SLEEP {
        let minutes = if e.end_ms > e.at_ms { (e.end_ms - e.at_ms) / 60_000 } else { e.value.max(0.0) as i64 };
        v["goalDelta"] = json!(goal_sleep.map(|g| minutes - g));
    } else if !NO_DELTA_KINDS.contains(&e.kind.as_str()) && !SUM_KINDS.contains(&e.kind.as_str()) {
        let previous = all.iter().filter(|p| p.kind == e.kind && (p.at_ms, &p.id) < (e.at_ms, &e.id)).max_by_key(|p| (p.at_ms, &p.id));
        v["delta"] = json!(previous.map(|p| super::health_view::round1(e.value - p.value)));
    }
    if e.kind == "pressure" {
        v["pulse"] = json!(health_stats::paired_pulse(e.at_ms, pulses).map(|p| p.value));
    }
    v
}

/// Итоги дней вида-суммы новыми первыми (не больше `limit`) с оценкой самочувствия дня и заметкой к ней.
fn day_totals(entries: &[&Entry], all: &[&Entry], limit: usize) -> (Vec<Value>, bool) {
    let mut by_day: BTreeMap<i64, (f64, usize)> = BTreeMap::new();
    for e in entries {
        let slot = by_day.entry(entry_day_index(e)).or_default();
        slot.0 += e.value;
        slot.1 += 1;
    }
    let mood_of = |day: i64| all.iter().filter(|m| m.kind == KIND_MOOD && entry_day_index(m) == day).max_by_key(|m| (m.at_ms, &m.id));
    let days = by_day
        .iter()
        .rev()
        .take(limit)
        .map(|(day, (value, count))| {
            let mood = mood_of(*day);
            json!({
                "day": day_text(*day), "weekday": (day + 3).rem_euclid(7), "value": super::health_view::round1(*value), "count": count,
                "mood": mood.map(|m| m.value), "moodNote": mood.map(|m| m.note.clone()),
            })
        })
        .collect();
    (days, by_day.len() > limit)
}

/// Проверка записи формы: `{"problem": null}` — можно сохранять, иначе код: `form` (вид, время, заметка не
/// проходят проверку домена), `future` (время позже «сейчас»), `span` (сон короче десяти минут либо длиннее
/// суток), `value` (значение вне диапазона показателя).
pub fn check_json(entry: &Value, now_ms: i64) -> Value {
    json!({ "problem": problem_of(entry, now_ms) })
}

fn problem_of(entry: &Value, now_ms: i64) -> Option<&'static str> {
    let Some(mut fields) = entry.as_object().cloned() else { return Some("form") };
    fields.entry("id").or_insert_with(|| json!(DRAFT_ID));
    let Ok(e) = entry_of(&fields) else { return Some("form") };
    if health::check_entry(&e).is_err() {
        return Some("form");
    }
    if e.at_ms.max(e.end_ms) > now_ms + health_parse::FUTURE_SLACK_MS {
        return Some("future");
    }
    if e.kind == KIND_SLEEP && e.tag == TAG_NO_SLEEP && e.end_ms == 0 && e.value == 0.0 {
        // «Не спал»: ночь без сна — запись в ноль минут
        return None;
    }
    if e.kind == KIND_SLEEP {
        let minutes = if e.end_ms != 0 { ((e.end_ms - e.at_ms) / 60_000) as f64 } else { e.value };
        return (!health_parse::sleep_in_range(minutes)).then_some("span");
    }
    if e.parts.iter().any(|p| !health_parse::part_in_range(&p.key, p.value)) {
        return Some("value");
    }
    (!health_parse::in_range(&e.kind, e.value, e.value2)).then_some("value")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::health_json::op_from_json;
    use crate::domain::Stamp;

    const TZ: i32 = 180;
    /// 2026-11-15 12:00 местного (UTC+3).
    const NOW: i64 = 1_794_733_200_000;
    const HOUR: i64 = 3_600_000;

    fn state(entries: &[(&str, &str, i64)]) -> HealthState {
        let mut st = HealthState::default();
        for (i, (id, kind, at_ms)) in entries.iter().enumerate() {
            let change = format!(r#"{{"changes":[{{"entry":{{"id":"{id}","kind":"{kind}","atMs":{at_ms},"tzMin":{TZ},"value":70,"unit":"kg","source":"text"}}}}]}}"#);
            let mut op = op_from_json(&change).unwrap();
            health::stamp_op(&mut op, &Stamp::new(i as u64 + 1, "d1"));
            st.apply_op(&op, "d1").unwrap();
        }
        st
    }

    fn page(st: &HealthState, kind: &str, limit: usize) -> Value {
        serde_json::from_str(&entries_json(st, kind, limit, NOW, TZ)).unwrap()
    }

    fn ids(page: &Value) -> Vec<&str> {
        page["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn page_is_newest_first_of_one_kind_and_tells_about_more() {
        let st = state(&[
            ("w1", "weight", NOW - 50 * HOUR),
            ("w2", "weight", NOW - 26 * HOUR),
            ("w3", "weight", NOW - HOUR),
            ("p1", "pulse", NOW - 2 * HOUR),
            ("future", "weight", NOW + 30 * HOUR),
        ]);
        let first = page(&st, "weight", 2);
        assert_eq!(ids(&first), ["w3", "w2"]);
        assert_eq!(first["hasMore"], true);
        let all = page(&st, "weight", 10);
        assert_eq!(ids(&all), ["w3", "w2", "w1"], "запись из будущего не входит");
        assert_eq!(all["hasMore"], false);
        assert_eq!(ids(&page(&st, "", 10)), ["w3", "p1", "w2", "w1"]);
    }

    #[test]
    fn sleep_page_includes_lone_marks() {
        let st = state(&[("s", "sleep", NOW - 5 * HOUR), ("start", "sleep_start", NOW - 3 * HOUR), ("w", "weight", NOW - HOUR)]);
        assert_eq!(ids(&page(&st, "sleep", 10)), ["start", "s"]);
        assert!(ids(&page(&HealthState::default(), "sleep", 10)).is_empty());
    }

    fn check(entry: Value) -> Value {
        check_json(&entry, NOW)["problem"].clone()
    }

    #[test]
    fn form_entry_is_checked_like_parsed_text() {
        let weight = |value: f64, at_ms: i64| json!({"kind": "weight", "atMs": at_ms, "tzMin": TZ, "value": value, "unit": "kg", "source": "manual"});
        assert_eq!(check(weight(72.0, NOW)), Value::Null);
        assert_eq!(check(weight(720.0, NOW)), "value");
        assert_eq!(check(weight(72.0, NOW + 2 * HOUR)), "future");
        assert_eq!(check(json!({"kind": "pressure", "atMs": NOW, "tzMin": TZ, "value": 80, "value2": 120, "source": "manual"})), "value");
        assert_eq!(check(json!({"id": "a1", "kind": "mood", "atMs": NOW, "tzMin": TZ, "value": 4, "source": "manual", "note": "ок"})), Value::Null);
        assert_eq!(check(json!({"kind": "mood", "atMs": NOW, "tzMin": TZ, "value": 6, "source": "manual"})), "value");
        // Вид вне словаря диапазона не имеет; запись без вида — не запись
        assert_eq!(check(json!({"kind": "ferritin", "atMs": NOW, "tzMin": TZ, "value": 9000, "source": "manual"})), Value::Null);
        assert_eq!(check(json!({"kind": "", "atMs": NOW, "tzMin": TZ, "value": 1})), "form");
        assert_eq!(check(json!("вес")), "form");
    }

    #[test]
    fn sleep_span_is_checked_by_length() {
        let nap = |from: i64, to: i64| json!({"kind": "sleep", "atMs": from, "endMs": to, "tzMin": TZ, "unit": "min", "source": "manual"});
        assert_eq!(check(nap(NOW - 2 * HOUR, NOW - HOUR)), Value::Null);
        assert_eq!(check(nap(NOW - HOUR, NOW - HOUR + 5 * 60_000)), "span");
        assert_eq!(check(nap(NOW - 30 * HOUR, NOW - HOUR)), "span");
        assert_eq!(check(nap(NOW - HOUR, NOW - 2 * HOUR)), "form", "конец раньше начала");
        assert_eq!(check(json!({"kind": "sleep", "atMs": NOW - HOUR, "tzMin": TZ, "value": 420, "unit": "min", "source": "manual"})), Value::Null);
    }
}
