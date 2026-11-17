//! «Мои продукты» (HEALTH-3 п. 13): еда, названная без чисел, берёт калории, БЖУ и граммы из прошлой записи еды
//! с тем же названием. Внешних справочников нет — только записи самого пользователя.
//!
//! Разбор строки (`health_parse`) состояния не читает и отдаёт такую еду догадкой (`guess`, `value` 0). Здесь —
//! шаг после разбора, которому состояние доступно: `recall_json(state, text, now_ms, tz_min)` возвращает тот же
//! итог `{entries, unparsed, problems}`, где
//! - догадка с известным названием получает числа прошлой записи, теряет `guess` и получает `recalled: true`;
//! - неразобранный кусок, равный известному названию («овсянка», «овсянка 150 г»), становится записью еды.
//!
//! Название сравнивается точно после нормализации: регистр, `ё` → `е`, крайние и повторные пробелы. Берётся самая
//! свежая запись еды с калориями. Граммы названы и у прошлой записи они есть — калории и БЖУ пересчитываются
//! пропорционально; иначе берутся как есть. Запись, где калории либо БЖУ названы в строке, не трогается.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::health::HealthState;
use super::health_day::KIND_FOOD;
use super::health_view::round1;
use crate::health_parse::{self, part_in_range};
use crate::pb::parvane::health::v1::Entry;

/// Числа еды, которые переносятся из прошлой записи (граммы — отдельно: они задают пропорцию).
const MACROS: [&str; 4] = ["protein", "fat", "carbs", "fiber"];
const GRAMS: &str = "grams";
/// Глагол, с которым разбор принимает название без чисел за еду: так перечитывается неразобранный кусок.
const EAT_LEAD: &str = "съел ";

/// Название для сравнения: без регистра, `ё` как `е`, без крайних и повторных пробелов.
pub fn normalize_name(name: &str) -> String {
    name.to_lowercase().replace('ё', "е").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Известные продукты: нормализованное название → самая свежая запись еды с калориями.
fn known_foods(state: &HealthState) -> BTreeMap<String, &Entry> {
    let mut known: BTreeMap<String, &Entry> = BTreeMap::new();
    for e in state.live_entries().filter(|e| e.kind == KIND_FOOD && e.value > 0.0) {
        let name = normalize_name(&e.name);
        if name.is_empty() {
            continue;
        }
        let newer = known.get(&name).map_or(true, |old| (e.at_ms, &e.id) > (old.at_ms, &old.id));
        if newer {
            known.insert(name, e);
        }
    }
    known
}

fn part_of(e: &Entry, key: &str) -> Option<f64> {
    super::health::part(e, key)
}

fn is_guess_food(entry: &Value) -> bool {
    entry["kind"] == KIND_FOOD && entry["guess"] == true
}

fn name_of(entry: &Value) -> String {
    normalize_name(entry["name"].as_str().unwrap_or(""))
}

/// Подставить числа прошлой записи в догадку. `false` — подставлять нельзя (пересчёт вышел за разумные пределы).
fn fill(entry: &mut Map<String, Value>, past: &Entry) -> bool {
    let grams = entry.get("parts").and_then(|p| p.get(GRAMS)).and_then(Value::as_f64).filter(|g| *g > 0.0);
    let past_grams = part_of(past, GRAMS).filter(|g| *g > 0.0);
    let factor = match (grams, past_grams) {
        (Some(now), Some(then)) => now / then,
        _ => 1.0,
    };
    let kcal = (past.value * factor).round();
    if kcal < 1.0 || !part_in_range("kcal", kcal) {
        return false;
    }
    let mut parts = Map::new();
    for key in MACROS {
        if let Some(v) = part_of(past, key) {
            let v = round1(v * factor);
            if !part_in_range(key, v) {
                return false;
            }
            parts.insert(key.to_string(), json!(v));
        }
    }
    if let Some(g) = grams.or(past_grams) {
        parts.insert(GRAMS.to_string(), json!(g));
    }
    entry.insert("value".into(), json!(kcal));
    if parts.is_empty() {
        entry.remove("parts");
    } else {
        entry.insert("parts".into(), Value::Object(parts));
    }
    entry.remove("guess");
    entry.insert("recalled".into(), json!(true));
    true
}

fn known_guesses(parsed: &Value, known: &BTreeMap<String, &Entry>) -> usize {
    parsed["entries"].as_array().map_or(0, |list| list.iter().filter(|e| is_guess_food(e) && known.contains_key(&name_of(e))).count())
}

fn len_of(parsed: &Value, key: &str) -> usize {
    parsed[key].as_array().map_or(0, Vec::len)
}

/// Неразобранный кусок с известным названием перечитывается как еда: строка разбирается заново с глаголом перед
/// куском. Новый разбор принимается, только если он отличается ровно этим: кусок ушёл из неразобранного и стал
/// одной записью еды с известным названием.
fn recall_unparsed(parsed: Value, text: &str, now_ms: i64, tz_min: i32, known: &BTreeMap<String, &Entry>) -> Value {
    let mut parsed = parsed;
    let mut text = text.to_string();
    let pieces: Vec<String> = parsed["unparsed"].as_array().map(|l| l.iter().filter_map(|p| p.as_str().map(str::to_string)).collect()).unwrap_or_default();
    for piece in pieces {
        let Some(at) = text.find(&piece) else { continue };
        let mut candidate = text.clone();
        candidate.insert_str(at, EAT_LEAD);
        let Ok(next) = serde_json::from_str::<Value>(&health_parse::parse_json(&candidate, now_ms, tz_min)) else { continue };
        let mut rest: Vec<Value> = parsed["unparsed"].as_array().cloned().unwrap_or_default();
        if let Some(i) = rest.iter().position(|p| p.as_str() == Some(piece.as_str())) {
            rest.remove(i);
        }
        let accepted = next["unparsed"] == Value::Array(rest)
            && next["problems"] == parsed["problems"]
            && len_of(&next, "entries") == len_of(&parsed, "entries") + 1
            && known_guesses(&next, known) == known_guesses(&parsed, known) + 1;
        if accepted {
            // Запись из одного названия без слова приёма помечается `bare`: чужой ввод («План») такой строке не
            // верит — «кофе» там остаётся задачей
            let mut before: Vec<String> = parsed["entries"].as_array().map(|l| l.iter().filter(|e| is_guess_food(e)).map(name_of).collect()).unwrap_or_default();
            let mut next = next;
            if let Some(entries) = next["entries"].as_array_mut() {
                for entry in entries.iter_mut().filter(|e| is_guess_food(e) && known.contains_key(&name_of(e)) && e["bare"].is_null()) {
                    match before.iter().position(|n| *n == name_of(entry)) {
                        Some(i) => {
                            before.remove(i);
                        }
                        None => entry["bare"] = json!(true),
                    }
                }
            }
            parsed = next;
            text = candidate;
        }
    }
    parsed
}

/// Разбор строки с подстановкой «моих продуктов»: итог того же вида, что у `health_parse::parse_json`.
pub fn recall_json(state: &HealthState, text: &str, now_ms: i64, tz_min: i32) -> String {
    let raw = health_parse::parse_json(text, now_ms, tz_min);
    let known = known_foods(state);
    if known.is_empty() {
        return raw;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else { return raw };
    let mut parsed = recall_unparsed(parsed, text, now_ms, tz_min, &known);
    if let Some(entries) = parsed["entries"].as_array_mut() {
        for entry in entries.iter_mut().filter(|e| is_guess_food(e)) {
            let Some(past) = known.get(&name_of(entry)) else { continue };
            if let Some(o) = entry.as_object_mut() {
                fill(o, past);
            }
        }
    }
    parsed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::health::{self, day_of};
    use crate::domain::health_json::op_from_json;
    use crate::domain::health_view::{compose_changes, view_json};
    use crate::domain::Stamp;

    const TZ: i32 = 180;
    /// 2026-11-15 12:00 местного (UTC+3).
    const NOW: i64 = 1_794_733_200_000;
    const HOUR: i64 = 3_600_000;

    fn apply(st: &mut HealthState, changes: &Value, lamport: u64) {
        let mut op = op_from_json(&changes.to_string()).unwrap();
        health::stamp_op(&mut op, &Stamp::new(lamport, "d1"));
        st.apply_op(&op, "d1").unwrap();
    }

    fn food(id: &str, name: &str, at_ms: i64, kcal: f64, parts: Value) -> Value {
        json!({"entry": {"id": id, "kind": "food", "atMs": at_ms, "tzMin": TZ, "value": kcal, "unit": "kcal", "source": "text", "name": name, "tag": "breakfast", "parts": parts}})
    }

    fn state(foods: &[Value]) -> HealthState {
        let mut st = HealthState::default();
        for (i, f) in foods.iter().enumerate() {
            apply(&mut st, &json!({"changes": [f]}), i as u64 + 1);
        }
        st
    }

    fn recall(st: &HealthState, text: &str) -> Value {
        serde_json::from_str(&recall_json(st, text, NOW, TZ)).unwrap()
    }

    fn oatmeal() -> HealthState {
        state(&[food("o1", "овсянка", NOW - 24 * HOUR, 430.0, json!({"protein": 22, "fat": 14, "carbs": 48, "grams": 200}))])
    }

    #[test]
    fn name_alone_takes_numbers_of_last_entry() {
        let st = oatmeal();
        for text in ["завтрак овсянка", "овсянка", "съел овсянку"] {
            let v = recall(&st, text);
            if text == "съел овсянку" {
                // Другой падеж — другое название: совпадение точное, не нечёткое
                assert_eq!(v["entries"][0]["guess"], true, "{text}");
                assert_eq!(v["entries"][0]["value"], 0.0);
                assert!(v["entries"][0]["recalled"].is_null());
                continue;
            }
            assert_eq!(v["entries"].as_array().unwrap().len(), 1, "{text}: {v}");
            let e = &v["entries"][0];
            assert_eq!(e["kind"], "food", "{text}");
            assert_eq!(e["name"], "овсянка");
            assert_eq!(e["value"], 430.0);
            assert_eq!(e["parts"], json!({"protein": 22.0, "fat": 14.0, "carbs": 48.0, "grams": 200.0}));
            assert_eq!(e["recalled"], true);
            assert!(e["guess"].is_null(), "подставленное — не догадка");
            assert_eq!(e["bare"].as_bool().unwrap_or(false), text == "овсянка", "одно название без слова приёма: {text}");
            assert!(v["unparsed"].as_array().unwrap().is_empty(), "{text}: {v}");
            assert_eq!(e["day"], day_of(NOW, TZ));
        }
        // Слово приёма сохраняется; без него приём — по времени записи (полдень — обед)
        assert_eq!(recall(&st, "завтрак овсянка")["entries"][0]["tag"], "breakfast");
        assert_eq!(recall(&st, "овсянка")["entries"][0]["tag"], "lunch");
    }

    #[test]
    fn grams_scale_calories_and_macros() {
        let st = oatmeal();
        for text in ["завтрак овсянка 150 г", "овсянка 150 г"] {
            let v = recall(&st, text);
            let e = &v["entries"][0];
            assert_eq!(e["value"], 323.0, "{text}: {v}");
            assert_eq!(e["parts"], json!({"protein": 16.5, "fat": 10.5, "carbs": 36.0, "grams": 150.0}), "{text}");
            assert_eq!(e["recalled"], true);
            assert!(v["unparsed"].as_array().unwrap().is_empty(), "{text}: {v}");
        }
        // У прошлой записи граммов нет — числа берутся как есть, названные граммы остаются
        let plain = state(&[food("s1", "суп", NOW - HOUR, 300.0, json!({"protein": 10}))]);
        let e = recall(&plain, "обед суп 400 г")["entries"][0].clone();
        assert_eq!(e["value"], 300.0);
        assert_eq!(e["parts"], json!({"protein": 10.0, "grams": 400.0}));
    }

    #[test]
    fn freshest_entry_with_calories_wins() {
        let st = state(&[
            food("old", "кофе", NOW - 72 * HOUR, 5.0, json!({})),
            food("new", "кофе", NOW - 2 * HOUR, 120.0, json!({"fat": 6})),
            // Свежее, но без калорий — не образец
            food("empty", "кофе", NOW - HOUR, 0.0, json!({})),
        ]);
        let e = recall(&st, "перекус кофе")["entries"][0].clone();
        assert_eq!(e["value"], 120.0);
        assert_eq!(e["parts"], json!({"fat": 6.0}));
        // Удалённая запись образцом не служит
        let mut st = st;
        apply(&mut st, &json!({"changes": [{"entry": {"id": "new", "deleted": true}}]}), 10);
        assert_eq!(recall(&st, "перекус кофе")["entries"][0]["value"], 5.0);
    }

    #[test]
    fn name_is_matched_without_case_yo_and_extra_spaces() {
        let st = state(&[food("t1", "  Творог   со Сметаной ", NOW - HOUR, 240.0, json!({})), food("y1", "Ёжик", NOW - HOUR, 90.0, json!({}))]);
        assert_eq!(normalize_name("  Творог   со Сметаной "), "творог со сметаной");
        assert_eq!(recall(&st, "ужин творог со сметаной")["entries"][0]["value"], 240.0);
        assert_eq!(recall(&st, "ужин ТВОРОГ со сметаной")["entries"][0]["value"], 240.0);
        assert_eq!(recall(&st, "ужин ежик")["entries"][0]["value"], 90.0);
        // Часть названия — не совпадение
        let part = recall(&st, "ужин творог");
        assert_eq!(part["entries"][0]["guess"], true);
        assert_eq!(part["entries"][0]["value"], 0.0);
    }

    #[test]
    fn explicit_numbers_are_kept() {
        let st = oatmeal();
        let v = recall(&st, "завтрак овсянка 500 ккал");
        let e = &v["entries"][0];
        assert_eq!(e["value"], 500.0);
        assert!(e["parts"].is_null(), "БЖУ к названным калориям не дописываются: {v}");
        assert!(e["recalled"].is_null());
        // Названы только БЖУ — калории считает разбор, подстановки нет
        let e = recall(&st, "завтрак овсянка б 10 ж 10 у 10")["entries"][0].clone();
        assert_eq!(e["value"], 170.0);
        assert!(e["recalled"].is_null());
        assert_eq!(e["parts"], json!({"protein": 10.0, "fat": 10.0, "carbs": 10.0}));
    }

    #[test]
    fn unknown_name_stays_guess_and_parse_is_untouched() {
        let st = oatmeal();
        for text in ["на ужин паста", "купить хлеб", "вес 72,4", "обед гречка 650 ккал", "овсянка вес 72"] {
            let plain: Value = serde_json::from_str(&health_parse::parse_json(text, NOW, TZ)).unwrap();
            if text == "овсянка вес 72" {
                // Известное название рядом с другим фактом: еда записана, вес остался весом
                let v = recall(&st, text);
                assert_eq!(v["entries"].as_array().unwrap().len(), 2, "{v}");
                assert!(v["entries"].as_array().unwrap().iter().any(|e| e["kind"] == "weight" && e["value"] == 72.0));
                assert!(v["entries"].as_array().unwrap().iter().any(|e| e["kind"] == "food" && e["value"] == 430.0));
                continue;
            }
            assert_eq!(recall(&st, text), plain, "{text}");
        }
        assert_eq!(recall(&st, "на ужин паста")["entries"][0]["guess"], true);
        // Пустое состояние — итог разбора дословно
        assert_eq!(recall_json(&HealthState::default(), "завтрак овсянка", NOW, TZ), health_parse::parse_json("завтрак овсянка", NOW, TZ));
    }

    #[test]
    fn recalled_entry_is_saved_as_shown() {
        let mut st = oatmeal();
        let v = recall(&st, "овсянка 100 г");
        let composed = compose_changes(&st, v["entries"].as_array().unwrap(), NOW);
        apply(&mut st, &composed, 20);
        let saved = st.live_entries().find(|e| e.at_ms == NOW).unwrap();
        assert_eq!(saved.value, 215.0);
        assert_eq!(part_of(saved, "protein"), Some(11.0));
        assert_eq!(part_of(saved, GRAMS), Some(100.0));
        let view: Value = serde_json::from_str(&view_json(&st, NOW, TZ)).unwrap();
        assert_eq!(view["nutrition"]["total"]["kcal"], 215.0, "{}", view["nutrition"]);
        // Пересчёт за разумные пределы не подставляется
        let e = recall(&st, "завтрак овсянка 5000 г")["entries"][0].clone();
        assert_eq!(e["guess"], true);
    }
}
