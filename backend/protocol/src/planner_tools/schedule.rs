//! Расписание на неделю текстом → еженедельные события (доски `ZpPlanX`, `XdPlan`).
//!
//! Кусок — строка либо часть строки между `·` и `;`. День недели открывает кусок («пн», «Понедельник:», «Mon») и
//! действует до следующего дня; строка из одного дня — заголовок. Время — «10:00-11:00», «10-11», «10.00–11.00»,
//! «с 10 до 11»; одно начало с минутами («18:30») — событие на час (`isEndGuessed`). Остаток — название (с заглавной
//! буквы), после первой запятой — описание. Срок — «до 31 декабря», «до 15.12.2026», «до 2026-12-15», «until Dec 31»
//! в любом куске; без года — ближайшая такая дата не раньше `today`. Кусок, который не удалось понять, попадает в
//! `problems` (на экране — красным, не добавляется), заголовки и пустые строки — никуда. У события и непонятого куска
//! `order` — номер непустого куска в тексте: экран ставит непонятое на его место среди понятого (доска `XdPlan`);
//! у непонятого `rest` — кусок без дня недели (на компьютере день — отдельной колонкой).

use serde::Deserialize;
use serde_json::{json, Value};

use super::{day_text, make_day, parse_day};
use crate::domain::health::civil_from_days;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub text: String,
    /// Сегодня — от него ищется год даты срока без года.
    pub today: String,
}

const MAX_TEXT: usize = 20_000;
const MAX_NAME_CHARS: usize = 200;
const GUESSED_MINUTES: i64 = 60;
const MINUTES_IN_DAY: i64 = 1440;

/// Слова дня недели (нижний регистр, «ё» → «е») → номер как у `Date.getDay`.
const WEEKDAYS: &[(&[&str], i64)] = &[
    (&["понедельник", "понедельника", "пн", "пон", "monday", "mon"], 1),
    (&["вторник", "вторника", "вт", "tuesday", "tues", "tue"], 2),
    (&["среда", "среду", "среды", "ср", "wednesday", "wed"], 3),
    (&["четверг", "четверга", "чт", "thursday", "thurs", "thu"], 4),
    (&["пятница", "пятницу", "пятницы", "пт", "friday", "fri"], 5),
    (&["суббота", "субботу", "субботы", "сб", "saturday", "sat"], 6),
    (&["воскресенье", "воскресенья", "вс", "sunday", "sun"], 0),
];

/// Остаток строки дня без времени, который значит «в этот день ничего» — заголовок, а не ошибка.
const DAY_OFF: &[&str] = &["свободна", "свободен", "свободно", "выходной", "нет", "free", "off", "none"];

const MONTHS: &[(&[&str], u32)] = &[
    (&["января", "январь", "янв", "january", "jan"], 1),
    (&["февраля", "февраль", "фев", "february", "feb"], 2),
    (&["марта", "март", "мар", "march", "mar"], 3),
    (&["апреля", "апрель", "апр", "april", "apr"], 4),
    (&["мая", "май", "may"], 5),
    (&["июня", "июнь", "июн", "june", "jun"], 6),
    (&["июля", "июль", "июл", "july", "jul"], 7),
    (&["августа", "август", "авг", "august", "aug"], 8),
    (&["сентября", "сентябрь", "сен", "сент", "september", "sept", "sep"], 9),
    (&["октября", "октябрь", "окт", "october", "oct"], 10),
    (&["ноября", "ноябрь", "ноя", "november", "nov"], 11),
    (&["декабря", "декабрь", "дек", "december", "dec"], 12),
];

const UNTIL_WORDS: &[&str] = &["до", "until", "till", "to"];

pub fn run(input: &Input) -> Value {
    let today = parse_day(&input.today);
    let text: String = input.text.chars().take(MAX_TEXT).collect();
    let mut items = Vec::new();
    let mut problems = Vec::new();
    let mut until: Option<i64> = None;
    let mut current: Option<i64> = None;
    let mut order = 0usize;
    for piece in text.split(['\n', '·', ';']) {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        order += 1;
        let order = order - 1;
        let (piece, found) = cut_until(piece, today);
        if let Some(day) = found {
            until = Some(day);
        }
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let (weekday, rest) = match take_weekday(piece) {
            Some((day, rest)) => (Some(day), rest),
            None => (None, piece),
        };
        if weekday.is_some() {
            current = weekday;
        }
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || ":,.—–-".contains(c));
        let Some((start, end, guessed, name_part)) = take_times(rest) else {
            let lower = super::fold(rest);
            let is_header = weekday.is_some() && (lower.is_empty() || DAY_OFF.contains(&lower.trim_matches(|c: char| !c.is_alphanumeric())));
            if !is_header {
                problems.push(json!({"text": piece, "weekday": weekday, "order": order, "rest": rest}));
            }
            continue;
        };
        let (name, description) = split_name(name_part);
        match current {
            Some(day) if !name.is_empty() && end > start => items.push(json!({
                "weekday": day,
                "start": clock(start),
                "end": clock(end),
                "name": name,
                "description": description,
                "isEndGuessed": guessed,
                "order": order,
            })),
            _ => problems.push(json!({"text": piece, "weekday": current, "order": order, "rest": rest})),
        }
    }
    json!({"items": items, "problems": problems, "until": until.map(day_text)})
}

/// Срок «до …» внутри куска: кусок без него и дата.
fn cut_until(piece: &str, today: Option<i64>) -> (String, Option<i64>) {
    let words: Vec<&str> = piece.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        if !UNTIL_WORDS.contains(&super::fold(word).as_str()) {
            continue;
        }
        if let Some((day, used)) = read_date(&words[i + 1..], today) {
            let mut left: Vec<&str> = words[..i].to_vec();
            left.extend_from_slice(&words[i + 1 + used..]);
            return (left.join(" "), Some(day));
        }
    }
    (piece.to_string(), None)
}

/// Дата в начале слов: `15.12.2026`, `15.12`, `2026-12-15`, `31 декабря [2026]`, `Dec 31 [2026]`. Число слов — второе.
fn read_date(words: &[&str], today: Option<i64>) -> Option<(i64, usize)> {
    let first = words.first()?.trim_end_matches([',', '.', ')']);
    if let Some(day) = parse_day(first) {
        return Some((day, 1));
    }
    let parts: Vec<&str> = first.split('.').collect();
    if (2..=3).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        let day: u32 = parts[0].parse().ok()?;
        let month: u32 = parts[1].parse().ok()?;
        let year = parts.get(2).and_then(|y| y.parse::<i64>().ok());
        return Some((resolve_year(year, month, day, today)?, 1));
    }
    let number = |w: &str| w.trim_end_matches([',', '.']).parse::<u32>().ok();
    let month_of = |w: &str| {
        let w = super::fold(w.trim_end_matches([',', '.']));
        MONTHS.iter().find(|(names, _)| names.contains(&w.as_str())).map(|(_, m)| *m)
    };
    let (day, month) = match (number(first), words.get(1)) {
        (Some(day), Some(next)) => (day, month_of(next)?),
        _ => (number(words.get(1)?)?, month_of(first)?),
    };
    let year = words.get(2).and_then(|w| w.trim_end_matches([',', '.']).parse::<i64>().ok()).filter(|y| *y >= 1000);
    Some((resolve_year(year, month, day, today)?, if year.is_some() { 3 } else { 2 }))
}

fn resolve_year(year: Option<i64>, month: u32, day: u32, today: Option<i64>) -> Option<i64> {
    if let Some(year) = year {
        return make_day(year, month, day);
    }
    let today = today?;
    let (this_year, _, _) = civil_from_days(today);
    match make_day(this_year, month, day) {
        Some(date) if date >= today => Some(date),
        _ => make_day(this_year + 1, month, day),
    }
}

/// День недели первым словом: номер и остаток куска.
fn take_weekday(piece: &str) -> Option<(i64, &str)> {
    let end = piece.find(|c: char| !c.is_alphabetic()).unwrap_or(piece.len());
    let word = super::fold(&piece[..end]);
    let day = WEEKDAYS.iter().find(|(names, _)| names.contains(&word.as_str()))?.1;
    Some((day, &piece[end..]))
}

/// Время в начале остатка: начало, конец (минуты), «конец подставлен», остаток.
fn take_times(rest: &str) -> Option<(i64, i64, bool, &str)> {
    let mut s = rest;
    if let Some(after) = strip_word(s, &["с", "from"]) {
        s = after.trim_start();
    }
    let (start, has_minutes, after_start) = read_clock(s)?;
    let after_start = after_start.trim_start();
    let range_rest = after_start
        .strip_prefix(['-', '–', '—'])
        .or_else(|| strip_word(after_start, &["до", "to", "till", "until"]));
    if let Some(range_rest) = range_rest {
        if let Some((end, _, after_end)) = read_clock(range_rest.trim_start()) {
            return Some((start, end, false, after_end));
        }
        return None;
    }
    // Одно начало — только с минутами: «пн 10 созвон» не время, а «18:30 зал» — событие на час
    has_minutes.then(|| (start, (start + GUESSED_MINUTES).min(MINUTES_IN_DAY - 1), true, after_start))
}

fn strip_word<'a>(s: &'a str, words: &[&str]) -> Option<&'a str> {
    let end = s.find(char::is_whitespace)?;
    words.contains(&super::fold(&s[..end]).as_str()).then(|| &s[end..])
}

/// Часы `H`, `HH`, `H:MM`, `H.MM`: минуты от начала суток, были ли минуты, остаток.
fn read_clock(s: &str) -> Option<(i64, bool, &str)> {
    let digits = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    if digits == 0 || digits > 2 {
        return None;
    }
    let hours: i64 = s[..digits].parse().ok()?;
    let mut rest = &s[digits..];
    let mut minutes = 0;
    let mut has_minutes = false;
    if let Some(tail) = rest.strip_prefix([':', '.']) {
        let two = tail.get(..2).filter(|t| t.chars().all(|c| c.is_ascii_digit()))?;
        minutes = two.parse().ok()?;
        has_minutes = true;
        rest = &tail[2..];
    }
    if rest.starts_with(|c: char| c.is_alphanumeric()) || hours > 24 || minutes > 59 || (hours == 24 && minutes > 0) {
        return None;
    }
    // «24:00» — конец суток
    Some(((hours * 60 + minutes).min(MINUTES_IN_DAY - 1), has_minutes, rest))
}

/// Название до первой запятой (с заглавной буквы) и описание после неё.
fn split_name(text: &str) -> (String, Option<String>) {
    let text = text.trim().trim_start_matches(|c: char| ":,—–-".contains(c)).trim();
    let (name, description) = match text.split_once(',') {
        Some((name, rest)) => (name.trim(), Some(rest.trim()).filter(|d| !d.is_empty())),
        None => (text, None),
    };
    let mut chars = name.chars();
    let name: String = match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).take(MAX_NAME_CHARS).collect(),
        None => String::new(),
    };
    (name, description.map(str::to_string))
}

fn clock(minutes: i64) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        run(&Input { text: text.into(), today: "2026-11-15".into() })
    }

    #[test]
    fn one_line_with_short_hours_and_guessed_end() {
        let v = parse("пн 10-11 созвон · вт 14-16 сервер · ср 18:30 зал");
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0], json!({"weekday": 1, "start": "10:00", "end": "11:00", "name": "Созвон", "description": null, "isEndGuessed": false, "order": 0}));
        assert_eq!(items[2]["end"], "19:30");
        assert_eq!(items[2]["isEndGuessed"], true);
        assert_eq!(v["until"], Value::Null);
    }

    #[test]
    fn headers_until_and_problems() {
        let v = parse("Понедельник:\n10:00–11:30 Лекция, корпус Б\nВторник — свободна\nчт вечер ???\nдо 31 декабря");
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["description"], "корпус Б");
        assert_eq!(v["problems"], json!([{"text": "чт вечер ???", "weekday": 4, "order": 3, "rest": "вечер ???"}]));
        assert_eq!(v["until"], "2026-12-31");
        assert_eq!(parse("до 10 ноября")["until"], "2027-11-10", "прошедшая дата без года — следующий год");
        assert_eq!(parse("пн 9:00-10:00 a до 15.12.2026")["until"], "2026-12-15");
    }
}
