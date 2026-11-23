//! Импорт «Здоровья» из выгрузки Health Connect (Android: «Health Connect → Экспорт данных», файл
//! `health_connect_export.db` в архиве). Разбор — на устройстве (данные здоровья не уходят на сервер открытыми),
//! записи — обычные записи домена с `source = import.health_connect`.
//!
//! Схема выгрузки — таблицы Health Connect (AOSP, модуль HealthFitness): время — мс UTC, смещение пояса — секунды;
//! вес — граммы, рост — метры, вода — литры, температура — °C, проценты — 0…100.
//!
//! Что во что: вес, давление, температура, кислород, жир, рост — запись на измерение; сон — отрезок со стадиями
//! (минуты: `deep`, `light`, `rem`, `awake`); тренировка — минуты, тип (`tag`), название; шаги и вода — итог за
//! местный день (шаги разных приложений не складываются: у дня — больший итог одного приложения); пульс — средний за
//! день, `parts` — `min` и `max`. Номер записи выводится из исходной (`hc-<uuid>`, у итогов дня — `hc-<вид>-<день>`):
//! повторный импорт того же файла даёт те же номера, а записи, которые уже есть у человека (в том числе удалённые),
//! клиент не трогает — список номеров передаётся в `known`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Map, Value as Json};

use crate::domain::health::civil_from_days;
use crate::sqlite_read::{Db, Error as DbError, Row, Value};

pub const SOURCE: &str = "import.health_connect";
const DAY_MS: i64 = 86_400_000;
/// Строк одной таблицы — не больше (защита от огромных выгрузок; пульс — минутами за годы).
const MAX_ROWS: usize = 5_000_000;
/// Предел названия записи домена «Здоровья» (байты UTF-8).
const MAX_NAME_BYTES: usize = 120;

/// Итог разбора: записи для домена и сколько чего нашлось.
pub struct Import {
    pub entries: Vec<Json>,
    pub counts: BTreeMap<&'static str, usize>,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ImportError {
    /// Не база SQLite либо не выгрузка Health Connect.
    NotExport,
    Corrupt,
}

impl From<DbError> for ImportError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::NotSqlite => Self::NotExport,
            _ => Self::Corrupt,
        }
    }
}

/// Таблицы, по которым видно выгрузку Health Connect (хотя бы одна).
const KNOWN_TABLES: &[&str] = &[
    "steps_record_table",
    "weight_record_table",
    "sleep_session_record_table",
    "heart_rate_record_table",
    "exercise_session_record_table",
    "blood_pressure_record_table",
    "hydration_record_table",
];

pub fn import(bytes: &[u8], known: &BTreeSet<String>) -> Result<Import, ImportError> {
    let db = Db::open(bytes)?;
    if !KNOWN_TABLES.iter().any(|t| db.has_table(t)) {
        return Err(ImportError::NotExport);
    }
    let mut out = Out::default();
    measurements(&db, &mut out)?;
    sleep(&db, &mut out)?;
    workouts(&db, &mut out)?;
    steps(&db, &mut out)?;
    water(&db, &mut out)?;
    pulse(&db, &mut out)?;
    let mut entries: Vec<Json> = Vec::new();
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let (mut first, mut last): (Option<i64>, Option<i64>) = (None, None);
    for (kind, entry, day) in out.entries {
        let id = entry.get("id").and_then(Json::as_str).unwrap_or("").to_string();
        if id.is_empty() || known.contains(&id) {
            continue;
        }
        *counts.entry(kind).or_default() += 1;
        first = Some(first.map_or(day, |d| d.min(day)));
        last = Some(last.map_or(day, |d| d.max(day)));
        entries.push(Json::Object(entry));
    }
    Ok(Import { entries, counts, first_day: first.map(day_text), last_day: last.map(day_text) })
}

#[derive(Default)]
struct Out {
    entries: Vec<(&'static str, Map<String, Json>, i64)>,
}

impl Out {
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, kind: &'static str, id: String, at_ms: i64, end_ms: i64, tz_min: i32, value: f64, unit: &str, extra: &[(&str, Json)]) {
        let day_at = if end_ms > 0 { end_ms } else { at_ms };
        let day = local_day(day_at, tz_min);
        let mut e = Map::new();
        e.insert("id".into(), json!(id));
        e.insert("kind".into(), json!(kind));
        e.insert("atMs".into(), json!(at_ms));
        e.insert("endMs".into(), json!(end_ms));
        e.insert("tzMin".into(), json!(tz_min));
        e.insert("value".into(), json!(value));
        e.insert("unit".into(), json!(unit));
        e.insert("source".into(), json!(SOURCE));
        for (k, v) in extra {
            e.insert((*k).into(), v.clone());
        }
        self.entries.push((kind, e, day));
    }
}

fn local_day(ms: i64, tz_min: i32) -> i64 {
    (ms + i64::from(tz_min) * 60_000).div_euclid(DAY_MS)
}

fn day_text(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

fn tz_of(row: &Row, column: &str) -> i32 {
    row.get(column).as_i64().map_or(0, |s| i32::try_from(s / 60).unwrap_or(0)).clamp(-14 * 60, 14 * 60)
}

fn uuid_id(row: &Row) -> Option<String> {
    let hex = match row.get("uuid") {
        Value::Blob(b) if !b.is_empty() => b.iter().map(|x| format!("{x:02x}")).collect::<String>(),
        Value::Text(s) if !s.is_empty() => s.chars().filter(char::is_ascii_alphanumeric).collect(),
        _ => row.get("row_id").as_i64().map(|n| format!("row{n}"))?,
    };
    Some(format!("hc-{hex}"))
}

/// Строка не длиннее `max` байт (предел поля домена — в байтах), по границе символа, без управляющих.
fn clip(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}

fn round(v: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    (v * k).round() / k
}

fn scan(db: &Db, table: &str, each: &mut dyn FnMut(&Row)) -> Result<(), ImportError> {
    let mut seen = 0usize;
    db.scan(table, &mut |row| {
        seen += 1;
        if seen <= MAX_ROWS {
            each(row);
        }
        Ok(())
    })?;
    Ok(())
}

/// Таблица, колонка, вид, единица, множитель, знаков после запятой, допустимый диапазон в нашей единице.
type Measure = (&'static str, &'static str, &'static str, &'static str, f64, i32, f64, f64);

/// Измерения-моменты: запись на измерение.
fn measurements(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    let simple: &[Measure] = &[
        ("weight_record_table", "weight", "weight", "kg", 0.001, 2, 2.0, 500.0),
        ("body_temperature_record_table", "temperature", "temperature", "c", 1.0, 1, 30.0, 45.0),
        ("oxygen_saturation_record_table", "percentage", "spo2", "pct", 1.0, 1, 50.0, 100.0),
        ("body_fat_record_table", "percentage", "body_fat", "pct", 1.0, 1, 1.0, 80.0),
        ("height_record_table", "height", "height", "cm", 100.0, 1, 30.0, 260.0),
    ];
    for &(table, column, kind, unit, k, places, min, max) in simple {
        scan(db, table, &mut |row| {
            let (Some(at), Some(raw), Some(id)) = (row.get("time").as_i64(), row.get(column).as_f64(), uuid_id(row)) else { return };
            let value = round(raw * k, places);
            if (min..=max).contains(&value) {
                out.push(kind, id, at, 0, tz_of(row, "zone_offset"), value, unit, &[]);
            }
        })?;
    }
    scan(db, "blood_pressure_record_table", &mut |row| {
        let (Some(at), Some(up), Some(down), Some(id)) = (row.get("time").as_i64(), row.get("systolic").as_f64(), row.get("diastolic").as_f64(), uuid_id(row)) else { return };
        if (50.0..=300.0).contains(&up) && (30.0..=200.0).contains(&down) && up > down {
            out.push("pressure", id, at, 0, tz_of(row, "zone_offset"), up.round(), "mmhg", &[("value2", json!(down.round()))]);
        }
    })?;
    Ok(())
}

/// Сон: отрезок со стадиями (минуты по видам стадий Health Connect).
fn sleep(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    let mut stages: HashMap<i64, BTreeMap<&'static str, f64>> = HashMap::new();
    scan(db, "sleep_stages_table", &mut |row| {
        let (Some(parent), Some(start), Some(end), Some(t)) = (row.get("parent_key").as_i64(), row.get("stage_start_time").as_i64(), row.get("stage_end_time").as_i64(), row.get("stage_type").as_i64()) else { return };
        // 1, 3, 7 — бодрствование; 4 — лёгкий; 5 — глубокий; 6 — REM; 2 — сон без стадии
        let name = match t {
            1 | 3 | 7 => "awake",
            4 | 2 => "light",
            5 => "deep",
            6 => "rem",
            _ => return,
        };
        if end > start {
            *stages.entry(parent).or_default().entry(name).or_default() += (end - start) as f64 / 60_000.0;
        }
    })?;
    scan(db, "sleep_session_record_table", &mut |row| {
        let (Some(start), Some(end), Some(id)) = (row.get("start_time").as_i64(), row.get("end_time").as_i64(), uuid_id(row)) else { return };
        let minutes = (end - start) / 60_000;
        if !(10..=24 * 60).contains(&minutes) {
            return;
        }
        let mut parts = Map::new();
        if let Some(s) = row.get("row_id").as_i64().and_then(|r| stages.get(&r)) {
            for (k, v) in s {
                parts.insert((*k).into(), json!(v.round()));
            }
        }
        let mut extra = vec![];
        if !parts.is_empty() {
            extra.push(("parts", Json::Object(parts)));
        }
        out.push("sleep", id, start, end, tz_of(row, "end_zone_offset"), minutes as f64, "min", &extra);
    })?;
    Ok(())
}

/// Тип тренировки Health Connect → метка тренировки «Здоровья».
fn workout_tag(code: i64) -> &'static str {
    match code {
        33 | 34 => "run",
        53 | 21 => "walk",
        4 | 5 => "bike",
        48 | 49 => "swim",
        45 | 55 | 8 | 20 => "strength",
        57 | 27 | 46 => "yoga",
        _ => "other",
    }
}

fn workouts(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    scan(db, "exercise_session_record_table", &mut |row| {
        let (Some(start), Some(end), Some(id)) = (row.get("start_time").as_i64(), row.get("end_time").as_i64(), uuid_id(row)) else { return };
        let minutes = (end - start) / 60_000;
        if !(1..=24 * 60).contains(&minutes) {
            return;
        }
        let tag = workout_tag(row.get("exercise_type").as_i64().unwrap_or(0));
        let title = clip(row.get("title").as_text().unwrap_or("").trim(), MAX_NAME_BYTES);
        let mut extra = vec![("tag", json!(tag))];
        if !title.is_empty() {
            extra.push(("name", json!(title)));
        }
        out.push("workout", id, start, end, tz_of(row, "end_zone_offset"), minutes as f64, "min", &extra);
    })?;
    Ok(())
}

/// Шаги: итог местного дня; приложения не складываются — у дня больший итог одного приложения.
fn steps(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    // (день, приложение) → (сумма, последний конец, пояс)
    let mut by_app: HashMap<(i64, i64), (f64, i64, i32)> = HashMap::new();
    scan(db, "steps_record_table", &mut |row| {
        let (Some(end), Some(count)) = (row.get("end_time").as_i64(), row.get("count").as_f64()) else { return };
        let tz = tz_of(row, "end_zone_offset");
        let app = row.get("app_info_id").as_i64().unwrap_or(0);
        let slot = by_app.entry((local_day(end, tz), app)).or_insert((0.0, end, tz));
        slot.0 += count.max(0.0);
        if end > slot.1 {
            slot.1 = end;
            slot.2 = tz;
        }
    })?;
    let mut by_day: BTreeMap<i64, (f64, i64, i32)> = BTreeMap::new();
    for ((day, _), v) in by_app {
        let best = by_day.entry(day).or_insert(v);
        if v.0 > best.0 {
            *best = v;
        }
    }
    for (day, (total, at, tz)) in by_day {
        if (1.0..=200_000.0).contains(&total) {
            out.push("steps", format!("hc-steps-{}", day_text(day)), at, 0, tz, total.round(), "steps", &[]);
        }
    }
    Ok(())
}

/// Вода: итог местного дня, мл.
fn water(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    let mut by_day: BTreeMap<i64, (f64, i64, i32)> = BTreeMap::new();
    scan(db, "hydration_record_table", &mut |row| {
        let (Some(end), Some(liters)) = (row.get("end_time").as_i64(), row.get("volume").as_f64()) else { return };
        let tz = tz_of(row, "end_zone_offset");
        let slot = by_day.entry(local_day(end, tz)).or_insert((0.0, end, tz));
        slot.0 += liters.max(0.0) * 1000.0;
        slot.1 = slot.1.max(end);
    })?;
    for (day, (ml, at, tz)) in by_day {
        if (1.0..=10_000.0).contains(&ml) {
            out.push("water", format!("hc-water-{}", day_text(day)), at, 0, tz, ml.round(), "ml", &[]);
        }
    }
    Ok(())
}

/// Пульс: средний за местный день, `min` и `max` — в `parts`.
fn pulse(db: &Db, out: &mut Out) -> Result<(), ImportError> {
    let mut tz_by_record: HashMap<i64, i32> = HashMap::new();
    scan(db, "heart_rate_record_table", &mut |row| {
        if let Some(r) = row.get("row_id").as_i64() {
            tz_by_record.insert(r, tz_of(row, "start_zone_offset"));
        }
    })?;
    // день → (сумма, число, мин, макс, последний момент, пояс)
    let mut by_day: BTreeMap<i64, (f64, u32, f64, f64, i64, i32)> = BTreeMap::new();
    scan(db, "heart_rate_record_series_table", &mut |row| {
        let (Some(parent), Some(bpm), Some(at)) = (row.get("parent_key").as_i64(), row.get("beats_per_minute").as_f64(), row.get("epoch_millis").as_i64()) else { return };
        if !(20.0..=250.0).contains(&bpm) {
            return;
        }
        let tz = tz_by_record.get(&parent).copied().unwrap_or(0);
        let slot = by_day.entry(local_day(at, tz)).or_insert((0.0, 0, f64::MAX, f64::MIN, at, tz));
        slot.0 += bpm;
        slot.1 += 1;
        slot.2 = slot.2.min(bpm);
        slot.3 = slot.3.max(bpm);
        slot.4 = slot.4.max(at);
    })?;
    for (day, (sum, n, min, max, at, tz)) in by_day {
        if n > 0 {
            let parts = json!({"min": min.round(), "max": max.round()});
            out.push("pulse", format!("hc-pulse-{}", day_text(day)), at, 0, tz, (sum / f64::from(n)).round(), "bpm", &[("parts", parts)]);
        }
    }
    Ok(())
}

/// Вызов из обвязок: байты базы и номера уже известных записей → `{entries, counts, firstDay, lastDay}` либо
/// `{error: "not_export" | "corrupt"}`.
pub fn import_json(bytes: &[u8], known: &BTreeSet<String>) -> Json {
    match import(bytes, known) {
        Ok(r) => json!({"entries": r.entries, "counts": r.counts, "firstDay": r.first_day, "lastDay": r.last_day}),
        Err(ImportError::NotExport) => json!({"error": "not_export"}),
        Err(ImportError::Corrupt) => json!({"error": "corrupt"}),
    }
}
