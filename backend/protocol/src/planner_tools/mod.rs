//! Подсказки «Плана» без состояния (spec 041 E1, хвосты): подбор свободного времени, разбор расписания на неделю
//! текстом, поиск по записям, тренировки «Плана» для активности «Здоровья». Правила — здесь, один раз для всех
//! клиентов; клиент передаёт готовые данные (повторы «Плана» он раскрывает сам) и показывает ответ.
//!
//! Вызовы без состояния (`host::call::call_static`): `plannerFreeTime`, `plannerScheduleParse`, `plannerSearch`,
//! `plannerWorkouts`; вход и выход — JSON. Даты — строки `YYYY-MM-DD`, время — минуты от начала суток, дни недели
//! — как у `Date.getDay` (0 — воскресенье). Общий образец — `conformance/planner-tools/cases.json`.

mod free_time;
mod schedule;
mod search;
mod workouts;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::domain::health::{civil_from_days, days_from_civil};

/// Имена вызовов модуля.
pub const NAMES: &[&str] = &["plannerFreeTime", "plannerScheduleParse", "plannerSearch", "plannerWorkouts"];

/// Вызов по имени; негодный вход либо чужое имя — `None`.
pub fn call(name: &str, args: &Value) -> Option<Value> {
    match name {
        "plannerFreeTime" => Some(free_time::run(&input(args)?)),
        "plannerScheduleParse" => Some(schedule::run(&input(args)?)),
        "plannerSearch" => Some(search::run(&input(args)?)),
        "plannerWorkouts" => Some(workouts::run(&input(args)?)),
        _ => None,
    }
}

fn input<T: DeserializeOwned>(args: &Value) -> Option<T> {
    serde_json::from_value(args.clone()).ok()
}

/// `YYYY-MM-DD` → номер дня от 1970-01-01; негодная дата — `None`.
fn parse_day(text: &str) -> Option<i64> {
    let mut parts = text.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if text.len() != 10 {
        return None;
    }
    make_day(year, month, day)
}

/// Дата из чисел, если такая дата есть в календаре.
fn make_day(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(1..=9999).contains(&year) {
        return None;
    }
    let index = days_from_civil(year, month, day);
    (civil_from_days(index) == (year, month, day)).then_some(index)
}

fn day_text(index: i64) -> String {
    let (y, m, d) = civil_from_days(index);
    format!("{y:04}-{m:02}-{d:02}")
}

/// День недели: 0 — воскресенье (1970-01-01 — четверг).
fn weekday(index: i64) -> i64 {
    (index + 4).rem_euclid(7)
}

/// Строка для сравнения: нижний регистр, «ё» как «е», пробелы схлопнуты.
fn fold(text: &str) -> String {
    text.to_lowercase().replace('ё', "е").split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_round_trip_and_weekdays() {
        let day = parse_day("2026-11-15").expect("дата");
        assert_eq!(day_text(day), "2026-11-15");
        assert_eq!(weekday(day), 0, "15 ноября 2026 — воскресенье");
        assert!(parse_day("2026-02-30").is_none());
        assert!(parse_day("2026-1-5").is_none());
        assert_eq!(fold("  Ёлка   ЗАЛ "), "елка зал");
    }
}
