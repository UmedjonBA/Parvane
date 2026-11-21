//! Расчёты подробных экранов «Здоровья» (spec 041, HEALTH-3 п. 14): средний отбой и подъём, отклонение от
//! цели, режим сна («стабильный / плавает / сбит / мало данных»), среднее и число измерений за период, дни с
//! целью, темп изменения, связь самочувствия со сном, изменение записи к предыдущей. Экран эти значения только
//! показывает; общий образец — `conformance/health-stats/cases.json`.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::health_view::round1;
use crate::pb::parvane::health::v1::Entry;

/// Периоды подробного экрана: «Неделя / Месяц / Год» — дни до сегодняшнего включительно.
pub const PERIODS: [(&str, i64); 3] = [("week", 7), ("month", 30), ("year", 365)];
/// Метка записи «не спал»: ночь без сна — ноль минут, а не пропуск.
pub const TAG_NO_SLEEP: &str = "none";
/// «Мало спал» для связи самочувствия со сном — меньше шести часов.
pub const LOW_SLEEP_MIN: i64 = 360;
/// Режим сна: разброс отбоя за неделю не больше 45 минут — стабильный, не больше двух часов — плавает, больше — сбит.
const STABLE_SPREAD_MIN: i64 = 45;
const FLOATING_SPREAD_MIN: i64 = 120;
/// Меньше четырёх ночей за неделю — «мало данных».
const MIN_NIGHTS: usize = 4;
/// Меньше двух дней в каждой группе — связь самочувствия со сном не считается.
const MIN_MOOD_DAYS: usize = 2;
const MOOD_DAYS: i64 = 30;
/// Темп — по дням за 30 дней, если между первым и последним не меньше недели.
const PACE_DAYS: i64 = 30;
const PACE_MIN_SPAN: i64 = 7;
/// Пульс «той же минуты» у записи давления — в пределах 15 минут.
const PAIR_WINDOW_MS: i64 = 15 * 60_000;
const DAY_MIN: i64 = 1440;
const NOON_MIN: i64 = 720;

/// Ночь дня (день пробуждения): сумма сна дня и «лёг / встал» главного сна, если он отрезком.
#[derive(Clone, Copy)]
pub struct Night {
    pub total: i64,
    pub bed: Option<i64>,
    pub wake: Option<i64>,
}

/// Минуты от полуночи → минуты от полудня: отбой «23:30» и «00:10» рядом, среднее не ломается на полуночи.
fn from_noon(minute: i64) -> i64 {
    (minute - NOON_MIN).rem_euclid(DAY_MIN)
}

fn to_clock(from_noon: f64) -> i64 {
    (from_noon.round() as i64 + NOON_MIN).rem_euclid(DAY_MIN)
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// Отклонение времени от цели со знаком (минуты; плюс — позже цели).
pub fn clock_delta(minute: i64, goal: i64) -> i64 {
    from_noon(minute) - from_noon(goal)
}

fn spread(minutes: &[i64]) -> Option<i64> {
    let shifted: Vec<i64> = minutes.iter().map(|m| from_noon(*m)).collect();
    Some(shifted.iter().max()? - shifted.iter().min()?)
}

/// Сон за период: ночей, средняя ночь, средние отбой и подъём, их отклонение от цели.
fn sleep_period(nights: &[Night], goal_bed: Option<i64>, goal_wake: Option<i64>, goal_minutes: Option<i64>) -> Value {
    let beds: Vec<i64> = nights.iter().filter_map(|n| n.bed).collect();
    let wakes: Vec<i64> = nights.iter().filter_map(|n| n.wake).collect();
    let avg_minutes = mean(&nights.iter().map(|n| n.total as f64).collect::<Vec<_>>()).map(|m| m.round() as i64);
    let avg_clock = |list: &[i64]| mean(&list.iter().map(|m| from_noon(*m) as f64).collect::<Vec<_>>()).map(to_clock);
    let avg_bed = avg_clock(&beds);
    let avg_wake = avg_clock(&wakes);
    json!({
        "nights": nights.len(),
        "avgMinutes": avg_minutes,
        "avgBedMin": avg_bed,
        "avgWakeMin": avg_wake,
        "bedDeltaMin": avg_bed.zip(goal_bed).map(|(m, g)| clock_delta(m, g)),
        "wakeDeltaMin": avg_wake.zip(goal_wake).map(|(m, g)| clock_delta(m, g)),
        "goalDeltaMin": avg_minutes.zip(goal_minutes).map(|(m, g)| m - g),
    })
}

/// Режим сна за неделю по разбросу отбоя: `stable`, `floating`, `off` либо `few` (меньше четырёх ночей).
fn regime(week: &[Night]) -> Value {
    let beds: Vec<i64> = week.iter().filter_map(|n| n.bed).collect();
    let wakes: Vec<i64> = week.iter().filter_map(|n| n.wake).collect();
    let bed_spread = spread(&beds);
    let wake_spread = spread(&wakes);
    let state = match bed_spread {
        _ if beds.len() < MIN_NIGHTS => "few",
        Some(s) if s <= STABLE_SPREAD_MIN => "stable",
        Some(s) if s <= FLOATING_SPREAD_MIN => "floating",
        _ => "off",
    };
    json!({
        "state": state,
        "bedSpreadMin": bed_spread,
        "wakeSpreadMin": wake_spread,
        "isWakeStable": wakes.len() >= MIN_NIGHTS && wake_spread.is_some_and(|s| s <= STABLE_SPREAD_MIN),
    })
}

/// Дополнение сводки сна: периоды, режим недели и отклонение отбоя последней ночи от цели.
pub fn sleep_stats(nights: &BTreeMap<i64, Night>, today: i64, goal_bed: Option<i64>, goal_wake: Option<i64>, goal_minutes: Option<i64>) -> Value {
    let within = |days: i64| -> Vec<Night> { nights.range(today - days + 1..=today).map(|(_, n)| *n).collect() };
    let mut periods = serde_json::Map::new();
    for (name, days) in PERIODS {
        periods.insert(name.to_string(), sleep_period(&within(days), goal_bed, goal_wake, goal_minutes));
    }
    let last_bed = nights.range(..=today).next_back().and_then(|(_, n)| n.bed);
    json!({
        "periods": periods,
        "regime": regime(&within(7)),
        "lastBedDeltaMin": last_bed.zip(goal_bed).map(|(m, g)| clock_delta(m, g)),
    })
}

/// Значение дня показателя: `(значение, второе значение, записей за день)`.
pub type DayValue = (f64, f64, usize);

/// Показатель за периоды: среднее значений дней, число измерений, дни с записями, дни с целью.
pub fn metric_periods(days: &BTreeMap<i64, DayValue>, today: i64, goal: Option<f64>, is_sum: bool, is_upper_bound: bool) -> Value {
    let mut periods = serde_json::Map::new();
    for (name, span) in PERIODS {
        let list: Vec<&DayValue> = days.range(today - span + 1..=today).map(|(_, v)| v).collect();
        let avg = |pick: fn(&DayValue) -> f64| mean(&list.iter().map(|v| pick(v)).collect::<Vec<_>>()).map(round1);
        let goal_days = goal.filter(|_| is_sum || is_upper_bound).map(|g| list.iter().filter(|v| goal_met(v.0, g, is_upper_bound)).count());
        periods.insert(
            name.to_string(),
            json!({
                "avg": avg(|v| v.0),
                "avg2": avg(|v| v.1),
                "days": list.len(),
                "count": list.iter().map(|v| v.2).sum::<usize>(),
                "goalDays": goal_days,
                "spanDays": span,
            }),
        );
    }
    Value::Object(periods)
}

/// Цель дня выполнена: у сумм — набрано не меньше цели, у верхней границы (давление) — не выше её.
pub fn goal_met(value: f64, goal: f64, is_upper_bound: bool) -> bool {
    if is_upper_bound {
        value <= goal
    } else {
        value >= goal
    }
}

/// Темп за неделю: наклон прямой по значениям дней за 30 дней × 7; меньше недели между точками — нет темпа.
pub fn pace_week(days: &BTreeMap<i64, DayValue>, today: i64) -> Option<f64> {
    let points: Vec<(f64, f64)> = days.range(today - PACE_DAYS + 1..=today).map(|(d, v)| (*d as f64, v.0)).collect();
    let (first, last) = (points.first()?.0, points.last()?.0);
    if last - first < PACE_MIN_SPAN as f64 {
        return None;
    }
    let n = points.len() as f64;
    let mx = points.iter().map(|p| p.0).sum::<f64>() / n;
    let my = points.iter().map(|p| p.1).sum::<f64>() / n;
    let sxx: f64 = points.iter().map(|p| (p.0 - mx).powi(2)).sum();
    let sxy: f64 = points.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    (sxx > 0.0).then(|| round1(sxy / sxx * 7.0))
}

/// Связь самочувствия со сном за 30 дней: насколько оценка в дни со сном меньше шести часов отличается от
/// остальных дней (`delta` < 0 — ниже). Дней в группе меньше двух — `delta` нет.
pub fn mood_sleep(mood_days: &BTreeMap<i64, f64>, nights: &BTreeMap<i64, Night>, today: i64) -> Value {
    let (mut low, mut other) = (Vec::new(), Vec::new());
    for (day, mood) in mood_days.range(today - MOOD_DAYS + 1..=today) {
        match nights.get(day) {
            Some(n) if n.total < LOW_SLEEP_MIN => low.push(*mood),
            Some(_) => other.push(*mood),
            None => {}
        }
    }
    let delta = (low.len() >= MIN_MOOD_DAYS && other.len() >= MIN_MOOD_DAYS)
        .then(|| mean(&low).zip(mean(&other)).map(|(l, o)| round1(l - o)))
        .flatten();
    json!({"lowSleepMin": LOW_SLEEP_MIN, "lowDays": low.len(), "otherDays": other.len(), "delta": delta})
}

/// Пульс той же минуты для записи давления: ближайшая запись пульса в пределах 15 минут.
pub fn paired_pulse<'a>(at_ms: i64, pulses: &[&'a Entry]) -> Option<&'a Entry> {
    pulses.iter().copied().filter(|p| (p.at_ms - at_ms).abs() <= PAIR_WINDOW_MS).min_by_key(|p| (p.at_ms - at_ms).abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn night(total: i64, bed: i64, wake: i64) -> Night {
        Night { total, bed: Some(bed), wake: Some(wake) }
    }

    #[test]
    fn bedtime_mean_crosses_midnight() {
        let nights: BTreeMap<i64, Night> = [(1, night(420, 1410, 420)), (2, night(420, 30, 450))].into_iter().collect();
        let v = sleep_stats(&nights, 2, Some(1410), Some(420), Some(450));
        assert_eq!(v["periods"]["week"]["avgBedMin"], 0, "23:30 и 00:30 — в среднем полночь, а не полдень");
        assert_eq!(v["periods"]["week"]["bedDeltaMin"], 30);
        assert_eq!(v["periods"]["week"]["goalDeltaMin"], -30);
        assert_eq!(v["lastBedDeltaMin"], 60);
        assert_eq!(v["regime"]["state"], "few");
    }

    #[test]
    fn regime_by_bedtime_spread() {
        let week = |beds: &[i64]| -> BTreeMap<i64, Night> { beds.iter().enumerate().map(|(i, b)| (i as i64, night(420, *b, 420))).collect() };
        assert_eq!(sleep_stats(&week(&[1400, 1410, 1420, 1430]), 6, None, None, None)["regime"]["state"], "stable");
        assert_eq!(sleep_stats(&week(&[1380, 1410, 20, 60]), 6, None, None, None)["regime"]["state"], "floating");
        let off = sleep_stats(&week(&[1320, 1410, 60, 120]), 6, None, None, None);
        assert_eq!(off["regime"]["state"], "off");
        assert_eq!(off["regime"]["bedSpreadMin"], 240);
        assert_eq!(off["regime"]["isWakeStable"], true);
    }

    #[test]
    fn pace_needs_a_week_between_points() {
        let days: BTreeMap<i64, DayValue> = [(0, (73.0, 0.0, 1)), (14, (72.4, 0.0, 1)), (28, (71.8, 0.0, 1))].into_iter().collect();
        assert_eq!(pace_week(&days, 28), Some(-0.3));
        let near: BTreeMap<i64, DayValue> = [(0, (73.0, 0.0, 1)), (3, (72.0, 0.0, 1))].into_iter().collect();
        assert_eq!(pace_week(&near, 3), None);
    }

    #[test]
    fn mood_is_lower_after_short_nights() {
        let nights: BTreeMap<i64, Night> = (0..6).map(|d| (d, night(if d < 3 { 300 } else { 480 }, 0, 300))).collect();
        let moods: BTreeMap<i64, f64> = (0..6).map(|d| (d, if d < 3 { 2.0 } else { 3.5 })).collect();
        assert_eq!(mood_sleep(&moods, &nights, 5)["delta"], -1.5);
        let few: BTreeMap<i64, f64> = [(0, 2.0), (4, 3.0)].into_iter().collect();
        assert_eq!(mood_sleep(&few, &nights, 5)["delta"], Value::Null);
    }
}
