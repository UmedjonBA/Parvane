//! Разбор свободного ввода «Здоровья» (spec 038, правило HEALTH-2): строка текста → записи домена
//! `parvane.health.v1`. Один разбор на все клиенты: общий образец — `conformance/health-parse/cases.json`.
//!
//! Устройство: строка режется на лексемы (числа, время `ЧЧ:ММ`, слова, знаки), затем проход слева направо
//! пробует распознаватели в текущей позиции. Порядок слов свободный: «72 кг», «вес 72», «вчера вес 72,4 в 8:30»,
//! «лёг в полночь встал в 7», «спал 7ч 30м», «120/80 пульс 64», «выпил 2 стакана воды». Русский и английский
//! понимаются одновременно. Что не разобрано — возвращается в `unparsed` дословно, значение вне разумного
//! диапазона — в `problems`; молча ничего не выбрасывается, кроме служебных слов («я», «и», «в»).
//!
//! Без регулярных выражений и без ИИ; времени системы и часовых поясов разбор не читает — момент «сейчас» и
//! смещение местного времени передаёт хост.

use serde_json::{json, Value};

use crate::domain::health::{civil_from_days, minute_of_day};

const DAY_MS: i64 = 86_400_000;
const MIN_MS: i64 = 60_000;
/// Сколько вперёд от «сейчас» может стоять время записи без явного дня, прежде чем разбор отнесёт её к вчера.
const FUTURE_SLACK_MS: i64 = 30 * MIN_MS;
/// Стакан воды, мл.
pub const GLASS_ML: f64 = 250.0;
pub const MAX_INPUT: usize = 2000;

/// Одна разобранная запись (id и метки ставит домен).
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub kind: &'static str,
    pub at_ms: i64,
    /// 0 — запись-момент.
    pub end_ms: i64,
    pub value: f64,
    pub value2: f64,
    pub unit: &'static str,
}

/// Значение распознано, но не принято.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub text: String,
    /// `range` — вне разумного диапазона показателя.
    pub code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParseResult {
    pub entries: Vec<Parsed>,
    pub unparsed: Vec<String>,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num { v: f64, raw: String },
    /// `ЧЧ:ММ` — минуты от полуночи.
    Time(u32),
    Word(String),
    Slash,
    Dash,
    Deg,
    Pct,
    Sep,
}

#[derive(Debug, Clone)]
struct Lex {
    tok: Tok,
    start: usize,
    end: usize,
}

fn lex(text: &str) -> Vec<Lex> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|c| c.1);
    let pos = |i: usize| chars.get(i).map(|c| c.0).unwrap_or(text.len());
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let Some(c) = at(i) else { break };
        let start = pos(i);
        if c.is_ascii_digit() {
            let mut j = i;
            while at(j).is_some_and(|d| d.is_ascii_digit()) {
                j += 1;
            }
            let int_len = j - i;
            // Время ЧЧ:ММ
            if int_len <= 2 && at(j) == Some(':') && at(j + 1).is_some_and(|d| d.is_ascii_digit()) && at(j + 2).is_some_and(|d| d.is_ascii_digit()) && !at(j + 3).is_some_and(|d| d.is_ascii_digit()) {
                let h: u32 = text.get(start..pos(j)).and_then(|s| s.parse().ok()).unwrap_or(99);
                let m: u32 = text.get(pos(j + 1)..pos(j + 3)).and_then(|s| s.parse().ok()).unwrap_or(99);
                if (h < 24 && m < 60) || (h == 24 && m == 0) {
                    out.push(Lex { tok: Tok::Time((h % 24) * 60 + m), start, end: pos(j + 3) });
                    i = j + 3;
                    continue;
                }
            }
            // Десятичная часть: точка или запятая сразу между цифрами
            if matches!(at(j), Some('.') | Some(',')) && at(j + 1).is_some_and(|d| d.is_ascii_digit()) {
                j += 1;
                while at(j).is_some_and(|d| d.is_ascii_digit()) {
                    j += 1;
                }
            }
            let raw = text.get(start..pos(j)).unwrap_or("").replace(',', ".");
            if let Ok(v) = raw.parse::<f64>() {
                out.push(Lex { tok: Tok::Num { v, raw }, start, end: pos(j) });
            }
            i = j;
        } else if c.is_alphabetic() {
            let mut j = i;
            while at(j).is_some_and(|d| d.is_alphabetic()) {
                j += 1;
            }
            let word: String = text.get(start..pos(j)).unwrap_or("").to_lowercase().replace('ё', "е");
            out.push(Lex { tok: Tok::Word(word), start, end: pos(j) });
            i = j;
        } else {
            let tok = match c {
                '/' => Some(Tok::Slash),
                '-' | '–' | '—' => Some(Tok::Dash),
                '°' => Some(Tok::Deg),
                '%' => Some(Tok::Pct),
                ',' | ';' | '\n' | '.' | '!' | '?' => Some(Tok::Sep),
                _ => None,
            };
            if let Some(tok) = tok {
                out.push(Lex { tok, start, end: pos(i + 1) });
            }
            i += 1;
        }
    }
    out
}

fn any(word: &str, exact: &[&str]) -> bool {
    exact.contains(&word)
}

fn stem(word: &str, stems: &[&str]) -> bool {
    stems.iter().any(|s| word.starts_with(s))
}

/// Служебные слова: в `unparsed` не попадают.
const NOISE: &[&str] = &[
    "я", "и", "а", "в", "во", "на", "за", "к", "с", "со", "у", "это", "было", "был", "была", "уже", "еще", "потом", "затем", "около", "примерно", "где", "то",
    "спать", "мой", "моя", "мое", "i", "and", "at", "to", "the", "a", "of", "my", "was", "is", "then", "about", "around", "went", "fell", "got", "in",
];
const LEAD_IN: &[&str] = &["в", "во", "at", "около", "примерно", "about", "around", "где", "то", "к", "by"];
const BED: &[&str] = &["лег", "легла", "уснул", "уснула", "заснул", "заснула", "отбой", "bed", "asleep", "bedtime"];
const WAKE: &[&str] = &["встал", "встала", "проснулся", "проснулась", "подъем", "woke", "wake", "awoke", "up"];
const SLEEP: &[&str] = &["сон", "спал", "спала", "проспал", "проспала", "поспал", "поспала", "sleep", "slept"];
const HOUR_UNIT: &[&str] = &["ч", "час", "часа", "часов", "h", "hr", "hrs", "hour", "hours"];
const MIN_UNIT: &[&str] = &["м", "мин", "минут", "минуты", "минуту", "m", "min", "mins", "minute", "minutes"];
const THOUSAND: &[&str] = &["к", "k", "тыс", "тысяч", "тысячи"];

fn day_ref(word: &str) -> Option<i64> {
    match word {
        "сегодня" | "today" => Some(0),
        "вчера" | "yesterday" => Some(-1),
        "позавчера" => Some(-2),
        _ => None,
    }
}

/// Слово части суток после часа: (нужно прибавить 12, если час меньше 12; час 12 = полночь).
fn part_of_day(word: &str) -> Option<&'static str> {
    match word {
        "утра" | "am" => Some("am"),
        "дня" => Some("day"),
        "вечера" | "pm" => Some("pm"),
        "ночи" => Some("night"),
        _ => None,
    }
}

fn apply_part(h: u32, part: &str) -> u32 {
    match part {
        "am" => h % 12,
        "day" => if (1..=6).contains(&h) { h + 12 } else { h },
        "pm" => if h < 12 { h + 12 } else { h },
        // ночи: 12 → 0, 8–11 → вечер, 1–7 — как есть
        _ => if h == 12 { 0 } else if (8..=11).contains(&h) { h + 12 } else { h },
    }
}

fn fuzzy_time(word: &str) -> Option<u32> {
    match word {
        "утром" | "morning" => Some(8 * 60),
        "днем" | "afternoon" => Some(14 * 60),
        "вечером" | "evening" => Some(20 * 60),
        "ночью" | "night" => Some(23 * 60),
        _ => None,
    }
}

/// Время суток, прочитанное из текста.
#[derive(Debug, Clone, Copy)]
struct Clock {
    minute: u32,
    /// Часть суток названа явно («утра», «pm») либо время однозначно («полночь»).
    exact: bool,
    next: usize,
}

struct Parser<'a> {
    text: &'a str,
    toks: Vec<Lex>,
    used: Vec<bool>,
}

#[derive(Debug, Clone)]
struct Item {
    kind: &'static str,
    value: f64,
    value2: f64,
    unit: &'static str,
    minute: Option<u32>,
    day: Option<i64>,
    from: usize,
    to: usize,
}

impl<'a> Parser<'a> {
    fn word(&self, i: usize) -> Option<&str> {
        match self.toks.get(i).map(|l| &l.tok) {
            Some(Tok::Word(w)) => Some(w.as_str()),
            _ => None,
        }
    }

    fn num(&self, i: usize) -> Option<(f64, &str)> {
        match self.toks.get(i).map(|l| &l.tok) {
            Some(Tok::Num { v, raw }) => Some((*v, raw.as_str())),
            _ => None,
        }
    }

    fn is(&self, i: usize, tok: &Tok) -> bool {
        self.toks.get(i).map(|l| &l.tok) == Some(tok)
    }

    fn mark(&mut self, from: usize, to: usize) {
        for u in self.used.iter_mut().take(to).skip(from) {
            *u = true;
        }
    }

    fn slice(&self, from: usize, to: usize) -> String {
        let (Some(a), Some(b)) = (self.toks.get(from), to.checked_sub(1).and_then(|t| self.toks.get(t))) else { return String::new() };
        self.text.get(a.start..b.end).unwrap_or("").trim().to_string()
    }

    fn skip_words(&self, mut i: usize, set: &[&str], max: usize) -> usize {
        let mut n = 0;
        while n < max && self.word(i).is_some_and(|w| any(w, set)) {
            i += 1;
            n += 1;
        }
        i
    }

    /// Время суток с позиции `i`. `bare_hour` — принимать ли голый час без минут и части суток («в 7»).
    fn clock(&self, i: usize, bare_hour: bool) -> Option<Clock> {
        if let Some(w) = self.word(i) {
            return match w {
                "полночь" | "полуночи" | "midnight" => Some(Clock { minute: 0, exact: true, next: i + 1 }),
                "полдень" | "полудня" | "noon" => Some(Clock { minute: 720, exact: true, next: i + 1 }),
                _ => None,
            };
        }
        let (h, m, mut next, has_minutes) = match self.toks.get(i).map(|l| &l.tok) {
            Some(Tok::Time(t)) => (t / 60, t % 60, i + 1, true),
            Some(Tok::Num { v, raw }) => {
                // «7.30» в контексте времени — 7:30
                if let Some((a, b)) = raw.split_once('.') {
                    let (h, m) = (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?);
                    if b.len() != 2 || h > 23 || m > 59 {
                        return None;
                    }
                    (h, m, i + 1, true)
                } else {
                    if *v > 24.0 {
                        return None;
                    }
                    ((*v as u32) % 24, 0, i + 1, false)
                }
            }
            _ => return None,
        };
        if !has_minutes && self.word(next).is_some_and(|w| any(w, HOUR_UNIT)) {
            next += 1;
        }
        if let Some(part) = self.word(next).and_then(part_of_day) {
            if h > 12 && part != "pm" && part != "night" {
                return None;
            }
            return Some(Clock { minute: apply_part(h, part) % 24 * 60 + m, exact: true, next: next + 1 });
        }
        if !has_minutes && !bare_hour {
            return None;
        }
        Some(Clock { minute: h * 60 + m, exact: h >= 13 || h == 0, next })
    }

    /// Время записи-момента: «в 8:30», «at 7 pm», «8:30», «утром».
    fn point_time(&self, i: usize) -> Option<(u32, usize)> {
        if let Some(m) = self.word(i).and_then(fuzzy_time) {
            return Some((m, i + 1));
        }
        let j = self.skip_words(i, LEAD_IN, 2);
        let c = self.clock(j, j > i)?;
        Some((c.minute, c.next))
    }

    /// Длительность: «7ч 30м», «7.5 ч», «45 мин», «7:30», «8».
    fn duration(&self, i: usize) -> Option<(f64, usize)> {
        if let Some(Tok::Time(t)) = self.toks.get(i).map(|l| &l.tok) {
            return Some((f64::from(*t), i + 1));
        }
        let (v, _) = self.num(i)?;
        match self.word(i + 1) {
            Some(w) if any(w, HOUR_UNIT) => {
                let mut total = v * 60.0;
                let mut next = i + 2;
                if let (Some((m, raw)), Some(u)) = (self.num(next), self.word(next + 1)) {
                    if any(u, MIN_UNIT) && !raw.contains('.') {
                        total += m;
                        next += 2;
                    }
                } else if let Some((m, raw)) = self.num(next) {
                    // «7ч 30» — минуты без единицы
                    if !raw.contains('.') && m < 60.0 && !self.is(next + 1, &Tok::Slash) {
                        total += m;
                        next += 1;
                    }
                }
                Some((total.round(), next))
            }
            Some(w) if any(w, MIN_UNIT) => Some((v.round(), i + 2)),
            _ if v <= 24.0 => Some(((v * 60.0).round(), i + 1)),
            _ => None,
        }
    }
}

/// Спальное время без части суток: 6–11 — вечер, 12 — полночь («лёг в 11» — это 23:00).
fn bed_minute(c: Clock) -> u32 {
    if c.exact {
        return c.minute;
    }
    let (h, m) = (c.minute / 60, c.minute % 60);
    let h = if (6..=11).contains(&h) { h + 12 } else if h == 12 { 0 } else { h };
    h * 60 + m
}

struct Kind {
    kind: &'static str,
    unit: &'static str,
    exact: &'static [&'static str],
    stems: &'static [&'static str],
    min: f64,
    max: f64,
}

/// Показатели по ключевому слову. Диапазоны — «разумные для человека»: защита от опечаток, не медицина.
const KINDS: &[Kind] = &[
    Kind { kind: "weight", unit: "kg", exact: &["вес", "weight", "вешу", "весил", "весила"], stems: &[], min: 2.0, max: 500.0 },
    Kind { kind: "pressure", unit: "mmhg", exact: &["ад", "bp", "pressure"], stems: &["давлени"], min: 50.0, max: 300.0 },
    Kind { kind: "pulse", unit: "bpm", exact: &["чсс", "hr", "pulse"], stems: &["пульс"], min: 20.0, max: 250.0 },
    Kind { kind: "steps", unit: "steps", exact: &["steps"], stems: &["шаг"], min: 0.0, max: 200_000.0 },
    Kind { kind: "water", unit: "ml", exact: &["water", "drank", "drink", "выпил", "выпила"], stems: &["вод"], min: 1.0, max: 10_000.0 },
    Kind { kind: "mood", unit: "score", exact: &["mood"], stems: &["настроени"], min: 1.0, max: 5.0 },
    Kind { kind: "temperature", unit: "c", exact: &["temp", "temperature"], stems: &["температур"], min: 30.0, max: 45.0 },
    Kind { kind: "glucose", unit: "mmol_l", exact: &["сахар", "glucose", "sugar"], stems: &["глюкоз"], min: 1.0, max: 40.0 },
    Kind { kind: "height", unit: "cm", exact: &["рост", "height"], stems: &[], min: 30.0, max: 260.0 },
    Kind { kind: "waist", unit: "cm", exact: &["талия", "талии", "waist"], stems: &[], min: 20.0, max: 300.0 },
    Kind { kind: "body_fat", unit: "pct", exact: &["жир", "жира", "fat"], stems: &[], min: 1.0, max: 75.0 },
];

fn kind_of(kind: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| k.kind == kind)
}

fn keyword(word: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| any(word, k.exact) || stem(word, k.stems))
}

/// Единица после числа → (вид, множитель к единице хранения).
fn unit_after_number(word: &str) -> Option<(&'static str, f64)> {
    if any(word, &["кг", "kg", "кило"]) || stem(word, &["килограмм"]) {
        Some(("weight", 1.0))
    } else if any(word, &["lb", "lbs"]) || stem(word, &["фунт"]) {
        Some(("weight", 0.453_592_37))
    } else if any(word, &["мл", "ml"]) {
        Some(("water", 1.0))
    } else if any(word, &["л", "l"]) || stem(word, &["литр"]) {
        Some(("water", 1000.0))
    } else if stem(word, &["стакан"]) || any(word, &["glass", "glasses", "cup", "cups"]) {
        Some(("water", GLASS_ML))
    } else if stem(word, &["шаг"]) || any(word, &["steps", "step"]) {
        Some(("steps", 1.0))
    } else if any(word, &["уд", "bpm"]) || stem(word, &["удар"]) {
        Some(("pulse", 1.0))
    } else if stem(word, &["градус"]) {
        Some(("temperature", 1.0))
    } else if stem(word, &["ммоль"]) || word == "mmol" {
        Some(("glucose", 1.0))
    } else {
        None
    }
}

fn mood_word(word: &str) -> Option<f64> {
    if stem(word, &["отличн", "прекрасн", "супер"]) || any(word, &["great", "excellent", "awesome"]) {
        Some(5.0)
    } else if stem(word, &["хорош"]) || word == "good" {
        Some(4.0)
    } else if stem(word, &["норм", "средн"]) || any(word, &["ok", "okay", "fine", "ок"]) {
        Some(3.0)
    } else if stem(word, &["плох"]) || word == "bad" {
        Some(2.0)
    } else if stem(word, &["ужасн", "отвратительн"]) || any(word, &["terrible", "awful"]) {
        Some(1.0)
    } else {
        None
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn local_ms(day: i64, minute: u32, tz_min: i32) -> i64 {
    day * DAY_MS + i64::from(minute) * MIN_MS - i64::from(tz_min) * MIN_MS
}

/// Разобрать строку. `now_ms` — момент ввода, `tz_min` — смещение местного времени от UTC в минутах.
pub fn parse(text: &str, now_ms: i64, tz_min: i32) -> ParseResult {
    let mut res = ParseResult::default();
    if text.len() > MAX_INPUT {
        res.unparsed.push(text.chars().take(80).collect());
        return res;
    }
    let toks = lex(text);
    let n = toks.len();
    let mut p = Parser { text, used: vec![false; n], toks };
    let today = (now_ms + i64::from(tz_min) * MIN_MS).div_euclid(DAY_MS);

    let mut items: Vec<Item> = Vec::new();
    let mut cur_day: Option<i64> = None;
    let mut pending_time: Option<(u32, usize, usize)> = None;
    let (mut bed, mut wake): (Option<u32>, Option<u32>) = (None, None);
    let mut sleep_dur: Option<f64> = None;
    let mut sleep_marks: Vec<(usize, usize)> = Vec::new();
    let mut sleep_span: Option<(usize, usize)> = None;

    let mut i = 0;
    while i < n {
        // Разделитель: время, сказанное до него, к следующей записи не относится
        if p.is(i, &Tok::Sep) {
            p.used[i] = true;
            pending_time = None;
            i += 1;
            continue;
        }
        let word = p.word(i).map(str::to_string);
        if let Some(w) = word.as_deref() {
            if let Some(off) = day_ref(w) {
                let day = today + off;
                cur_day = Some(day);
                // «вес 72 вчера» — день относится и к уже сказанному без дня
                for it in items.iter_mut().filter(|it| it.day.is_none()) {
                    it.day = Some(day);
                }
                p.used[i] = true;
                i += 1;
                continue;
            }
            // ── сон ──
            if any(w, BED) || any(w, WAKE) {
                let is_bed = any(w, BED);
                let j = p.skip_words(i + 1, NOISE, 3);
                let j = if p.word(j).and_then(fuzzy_time).is_some() { j + 1 } else { j };
                let j = p.skip_words(j, NOISE, 2);
                if let Some(c) = p.clock(j, true) {
                    if is_bed {
                        bed = Some(bed_minute(c));
                    } else {
                        wake = Some(c.minute);
                    }
                    p.mark(i, c.next);
                    widen(&mut sleep_span, i, c.next);
                    i = c.next;
                    continue;
                }
                sleep_marks.push((i, i + 1));
                p.used[i] = true;
                i += 1;
                continue;
            }
            if any(w, SLEEP) {
                let j = p.skip_words(i + 1, NOISE, 2);
                // «спал с 23 до 7», «сон 23:30–7:10», «slept from 11pm to 7am»
                let from_j = if p.word(j).is_some_and(|x| any(x, &["с", "со", "from"])) { j + 1 } else { j };
                if let Some(a) = p.clock(from_j, true) {
                    let sep = a.next;
                    let is_sep = p.is(sep, &Tok::Dash) || p.word(sep).is_some_and(|x| any(x, &["до", "по", "to", "until", "till"]));
                    if is_sep {
                        if let Some(b) = p.clock(sep + 1, true) {
                            bed = Some(bed_minute(a));
                            wake = Some(b.minute);
                            p.mark(i, b.next);
                            widen(&mut sleep_span, i, b.next);
                            i = b.next;
                            continue;
                        }
                    }
                }
                if let Some((d, next)) = p.duration(j) {
                    sleep_dur = Some(d);
                    p.mark(i, next);
                    widen(&mut sleep_span, i, next);
                    i = next;
                    continue;
                }
                sleep_marks.push((i, i + 1));
                p.used[i] = true;
                i += 1;
                continue;
            }
            // ── показатель по ключевому слову ──
            if let Some(k) = keyword(w) {
                let mut j = i + 1;
                // «вес сегодня 72», «давление утром 120/80»
                for _ in 0..3 {
                    match p.word(j) {
                        Some(x) if day_ref(x).is_some() => {
                            cur_day = day_ref(x).map(|o| today + o);
                            j += 1;
                        }
                        Some(x) if any(x, NOISE) => j += 1,
                        _ => break,
                    }
                }
                let got: Option<(f64, f64, usize)> = match k.kind {
                    "pressure" => p.num(j).and_then(|(a, _)| {
                        let k2 = if p.is(j + 1, &Tok::Slash) || p.word(j + 1).is_some_and(|x| any(x, &["на", "over", "x", "х"])) { j + 2 } else { j + 1 };
                        p.num(k2).map(|(b, _)| (a, b, k2 + 1))
                    }),
                    "mood" => match (p.num(j), p.word(j).and_then(mood_word)) {
                        (Some((v, _)), _) => Some((v, 0.0, j + 1)),
                        (None, Some(v)) => Some((v, 0.0, j + 1)),
                        _ => None,
                    },
                    "water" => match p.num(j) {
                        Some((v, _)) => match p.word(j + 1).and_then(unit_after_number) {
                            Some(("water", mul)) => Some((v * mul, 0.0, j + 2)),
                            // Без единицы: до 10 — литры, больше — миллилитры
                            _ => Some((if v <= 10.0 { v * 1000.0 } else { v }, 0.0, j + 1)),
                        },
                        None => match p.word(j).and_then(unit_after_number) {
                            Some(("water", mul)) if mul == GLASS_ML => Some((GLASS_ML, 0.0, j + 1)),
                            _ => None,
                        },
                    },
                    _ => p.num(j).map(|(v, _)| {
                        let mut v = v;
                        let mut next = j + 1;
                        if k.kind == "steps" && p.word(next).is_some_and(|x| any(x, THOUSAND)) {
                            v *= 1000.0;
                            next += 1;
                        }
                        match p.word(next).and_then(unit_after_number) {
                            Some((kind, mul)) if kind == k.kind => {
                                v *= mul;
                                next += 1;
                            }
                            _ => {}
                        }
                        if p.word(next).is_some_and(|x| any(x, &["см", "cm"])) && matches!(k.kind, "height" | "waist") {
                            next += 1;
                        }
                        if p.is(next, &Tok::Pct) && k.kind == "body_fat" {
                            next += 1;
                        }
                        if p.is(next, &Tok::Deg) && k.kind == "temperature" {
                            next += 1;
                            if p.word(next).is_some_and(|x| any(x, &["c", "с"])) {
                                next += 1;
                            }
                        }
                        (v, 0.0, next)
                    }),
                };
                if let Some((v, v2, mut next)) = got {
                    if k.kind == "water" {
                        next = p.skip_words(next, &["воды", "вода", "воду", "water", "of"], 2);
                    }
                    let v = if k.kind == "weight" { round1(v) } else { v };
                    items.push(Item { kind: k.kind, value: v, value2: v2, unit: k.unit, minute: None, day: cur_day, from: i, to: next });
                    p.mark(i, next);
                    i = next;
                    if let Some((m, after)) = p.point_time(i) {
                        if let Some(it) = items.last_mut() {
                            it.minute = Some(m);
                            it.to = after;
                        }
                        p.mark(i, after);
                        i = after;
                    }
                    continue;
                }
                // «выпила воды 300 мл»: глагол без числа — не мусор, число возьмёт следующее слово
                if k.kind == "water" && !any(w, &["water"]) && !stem(w, &["вод"]) {
                    p.used[i] = true;
                }
                i += 1;
                continue;
            }
            // «стакан воды» без числа
            if unit_after_number(w) == Some(("water", GLASS_ML)) {
                let next = p.skip_words(i + 1, &["воды", "вода", "воду", "water", "of"], 2);
                if next > i + 1 {
                    items.push(Item { kind: "water", value: GLASS_ML, value2: 0.0, unit: "ml", minute: None, day: cur_day, from: i, to: next });
                    p.mark(i, next);
                    i = next;
                    continue;
                }
            }
            if any(w, NOISE) {
                // Вводное слово перед временем: «в 8:30 вес 72»
                if any(w, LEAD_IN) {
                    if let Some((m, after)) = p.point_time(i) {
                        pending_time = Some((m, i, after));
                        i = after;
                        continue;
                    }
                }
                p.used[i] = true;
                i += 1;
                continue;
            }
            if let Some(m) = fuzzy_time(w) {
                pending_time = Some((m, i, i + 1));
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        // ── время записи, сказанное до неё: «8:30 вес 72» ──
        if let Some(Tok::Time(t)) = p.toks.get(i).map(|l| l.tok.clone()) {
            let c = p.clock(i, false);
            let (m, after) = c.map_or((t, i + 1), |c| (c.minute, c.next));
            pending_time = Some((m, i, after));
            i = after;
            continue;
        }
        // ── число ──
        if let Some(a) = p.num(i).map(|(v, _)| v) {
            // давление «120/80»
            if p.is(i + 1, &Tok::Slash) {
                if let Some((b, _)) = p.num(i + 2) {
                    items.push(Item { kind: "pressure", value: a, value2: b, unit: "mmhg", minute: None, day: cur_day, from: i, to: i + 3 });
                    p.mark(i, i + 3);
                    i += 3;
                    if let Some((m, after)) = p.point_time(i) {
                        if let Some(it) = items.last_mut() {
                            it.minute = Some(m);
                            it.to = after;
                        }
                        p.mark(i, after);
                        i = after;
                    }
                    continue;
                }
            }
            let mut v = a;
            let mut j = i + 1;
            if p.word(j).is_some_and(|x| any(x, THOUSAND)) && p.word(j + 1).and_then(unit_after_number).is_some_and(|(k, _)| k == "steps") {
                v *= 1000.0;
                j += 1;
            }
            let by_unit = if p.is(j, &Tok::Deg) {
                let after = if p.word(j + 1).is_some_and(|x| any(x, &["c", "с"])) { j + 2 } else { j + 1 };
                Some(("temperature", 1.0, after))
            } else {
                p.word(j).and_then(unit_after_number).map(|(k, mul)| (k, mul, j + 1))
            };
            if let Some((kind, mul, mut next)) = by_unit {
                // «2 часа» и прочее сюда не попадает: единиц времени в таблице нет
                let unit = kind_of(kind).map_or("", |k| k.unit);
                if kind == "water" {
                    next = p.skip_words(next, &["воды", "вода", "воду", "water", "of"], 2);
                }
                if kind == "pulse" && p.is(next, &Tok::Slash) && p.word(next + 1).is_some_and(|x| any(x, &["мин", "min"])) {
                    next += 2;
                }
                let value = if kind == "weight" { round1(v * mul) } else { (v * mul * 10.0).round() / 10.0 };
                items.push(Item { kind, value, value2: 0.0, unit, minute: None, day: cur_day, from: i, to: next });
                p.mark(i, next);
                i = next;
                if let Some((m, after)) = p.point_time(i) {
                    if let Some(it) = items.last_mut() {
                        it.minute = Some(m);
                        it.to = after;
                    }
                    p.mark(i, after);
                    i = after;
                }
                continue;
            }
        }
        i += 1;
    }

    // Время, сказанное перед записью, — первой записи без времени после него; иначе остаётся неразобранным
    if let Some((m, from, to)) = pending_time {
        if let Some(it) = items.iter_mut().find(|it| it.minute.is_none() && it.from >= to) {
            it.minute = Some(m);
            p.mark(from, to);
        }
    }
    // Время перед записью внутри строки («в 8:30 вес 72, пульс 60»): привязка по соседству
    for idx in 0..items.len() {
        let Some(it) = items.get(idx) else { continue };
        if it.minute.is_some() {
            continue;
        }
        let from = it.from;
        // Ищем неиспользованное время прямо перед записью
        let mut k = from;
        while k > 0 && p.toks.get(k - 1).is_some_and(|l| !matches!(l.tok, Tok::Sep)) && !p.used.get(k - 1).copied().unwrap_or(true) {
            k -= 1;
        }
        if k < from {
            if let Some((m, after)) = p.point_time(k).or_else(|| p.clock(k, false).map(|c| (c.minute, c.next))) {
                if after == from {
                    if let Some(it) = items.get_mut(idx) {
                        it.minute = Some(m);
                    }
                    p.mark(k, from);
                }
            }
        }
    }

    // ── записи-моменты ──
    for it in &items {
        let Some(k) = kind_of(it.kind) else { continue };
        let ok = it.value >= k.min && it.value <= k.max && (it.kind != "pressure" || (it.value2 >= 30.0 && it.value2 <= 200.0 && it.value > it.value2));
        if !ok {
            res.problems.push(Problem { text: p.slice(it.from, it.to), code: "range" });
            continue;
        }
        let day = it.day.unwrap_or(today);
        let at_ms = match it.minute {
            Some(m) => local_ms(day, m, tz_min),
            None if day == today => now_ms,
            None => local_ms(day, 720, tz_min),
        };
        res.entries.push(Parsed { kind: it.kind, at_ms, end_ms: 0, value: it.value, value2: it.value2, unit: it.unit });
    }

    // ── сон ──
    let sleep_day = cur_day.filter(|_| sleep_span.is_some());
    let day = sleep_day.unwrap_or(today);
    let span_text = sleep_span.map(|(a, b)| p.slice(a, b)).unwrap_or_default();
    let late = |t: i64| sleep_day.is_none() && t > now_ms + FUTURE_SLACK_MS;
    match (bed, wake, sleep_dur) {
        (Some(b), Some(w), _) => {
            let mut end = local_ms(day, w, tz_min);
            let mut start = if b >= w { local_ms(day - 1, b, tz_min) } else { local_ms(day, b, tz_min) };
            if late(end) {
                end -= DAY_MS;
                start -= DAY_MS;
            }
            let minutes = ((end - start) / MIN_MS) as f64;
            if (10.0..=1440.0).contains(&minutes) {
                res.entries.push(Parsed { kind: "sleep", at_ms: start, end_ms: end, value: minutes, value2: 0.0, unit: "min" });
            } else {
                res.problems.push(Problem { text: span_text, code: "range" });
            }
        }
        (Some(b), None, None) => {
            let mut t = local_ms(day, b, tz_min);
            if late(t) {
                t -= DAY_MS;
            }
            res.entries.push(Parsed { kind: "sleep_start", at_ms: t, end_ms: 0, value: 0.0, value2: 0.0, unit: "" });
        }
        (None, Some(w), None) => {
            let mut t = local_ms(day, w, tz_min);
            if late(t) {
                t -= DAY_MS;
            }
            res.entries.push(Parsed { kind: "sleep_end", at_ms: t, end_ms: 0, value: 0.0, value2: 0.0, unit: "" });
        }
        (bed_only, wake_only, Some(d)) => {
            if (10.0..=1440.0).contains(&d) {
                match (bed_only, wake_only) {
                    // Длительность и один край: второй край считается
                    (Some(b), None) => {
                        let mut start = local_ms(day, b, tz_min);
                        if b >= 12 * 60 || late(start) {
                            start -= DAY_MS;
                        }
                        res.entries.push(Parsed { kind: "sleep", at_ms: start, end_ms: start + (d as i64) * MIN_MS, value: d, value2: 0.0, unit: "min" });
                    }
                    (None, Some(w)) => {
                        let mut end = local_ms(day, w, tz_min);
                        if late(end) {
                            end -= DAY_MS;
                        }
                        res.entries.push(Parsed { kind: "sleep", at_ms: end - (d as i64) * MIN_MS, end_ms: end, value: d, value2: 0.0, unit: "min" });
                    }
                    // Только длительность: запись-момент на начало дня, время сна неизвестно
                    _ => res.entries.push(Parsed { kind: "sleep", at_ms: local_ms(day, 0, tz_min), end_ms: 0, value: d, value2: 0.0, unit: "min" }),
                }
            } else {
                res.problems.push(Problem { text: span_text, code: "range" });
            }
        }
        (None, None, None) => {
            // Слово о сне без времени — неразобранное
            for (a, b) in &sleep_marks {
                for u in p.used.iter_mut().take(*b).skip(*a) {
                    *u = false;
                }
            }
        }
    }
    res.entries.sort_by(|a, b| a.at_ms.cmp(&b.at_ms).then(a.kind.cmp(b.kind)));

    // ── неразобранное: подряд идущие неиспользованные лексемы одним куском ──
    let mut k = 0;
    while k < n {
        if p.used.get(k).copied().unwrap_or(true) || p.is(k, &Tok::Sep) {
            k += 1;
            continue;
        }
        let from = k;
        while k < n && !p.used.get(k).copied().unwrap_or(true) && !p.is(k, &Tok::Sep) {
            k += 1;
        }
        let piece = p.slice(from, k);
        if !piece.is_empty() {
            res.unparsed.push(piece);
        }
    }
    res
}

fn widen(span: &mut Option<(usize, usize)>, from: usize, to: usize) {
    *span = Some(span.map_or((from, to), |(a, b)| (a.min(from), b.max(to))));
}

fn hhmm(minute: u32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn day_text(ms: i64, tz_min: i32) -> String {
    let (y, m, d) = civil_from_days((ms + i64::from(tz_min) * MIN_MS).div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Итог разбора для хоста: записи в виде изменений домена (без id) и то же человекочитаемо (`day`, `time`).
pub fn parse_json(text: &str, now_ms: i64, tz_min: i32) -> String {
    let r = parse(text, now_ms, tz_min);
    let entries: Vec<Value> = r
        .entries
        .iter()
        .map(|e| {
            let mut o = json!({
                "kind": e.kind, "atMs": e.at_ms, "endMs": e.end_ms, "tzMin": tz_min, "value": e.value, "value2": e.value2, "unit": e.unit,
                "source": "text", "day": day_text(e.at_ms, tz_min), "time": hhmm(minute_of_day(e.at_ms, tz_min)),
            });
            if e.end_ms != 0 {
                o["endDay"] = json!(day_text(e.end_ms, tz_min));
                o["endTime"] = json!(hhmm(minute_of_day(e.end_ms, tz_min)));
            }
            o
        })
        .collect();
    json!({
        "entries": entries,
        "unparsed": r.unparsed,
        "problems": r.problems.iter().map(|p| json!({"text": p.text, "code": p.code})).collect::<Vec<_>>(),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::health::days_from_civil;

    /// Понедельник 16 ноя 2026, 10:00 местного времени (UTC+3).
    const TZ: i32 = 180;
    fn now() -> i64 {
        local_ms(days_from_civil(2026, 11, 16), 10 * 60, TZ)
    }

    fn one(text: &str) -> Parsed {
        let r = parse(text, now(), TZ);
        assert_eq!(r.entries.len(), 1, "{text}: {r:?}");
        assert!(r.unparsed.is_empty() && r.problems.is_empty(), "{text}: {r:?}");
        r.entries[0].clone()
    }

    #[test]
    fn lexer_keeps_decimals_times_and_glued_units() {
        let kinds: Vec<Tok> = lex("72,4кг 23:30 120/80").into_iter().map(|l| l.tok).collect();
        assert_eq!(
            kinds,
            vec![
                Tok::Num { v: 72.4, raw: "72.4".into() },
                Tok::Word("кг".into()),
                Tok::Time(23 * 60 + 30),
                Tok::Num { v: 120.0, raw: "120".into() },
                Tok::Slash,
                Tok::Num { v: 80.0, raw: "80".into() },
            ]
        );
    }

    #[test]
    fn number_with_unit_needs_no_keyword() {
        let e = one("72 кг");
        assert_eq!((e.kind, e.value, e.unit, e.at_ms), ("weight", 72.0, "kg", now()));
        assert_eq!(one("вес 72,4").value, 72.4);
        assert_eq!(one("160 lbs").value, 72.6);
        assert_eq!(one("8к шагов").value, 8000.0);
        assert_eq!(one("36,6°").kind, "temperature");
    }

    #[test]
    fn sleep_across_midnight() {
        let e = one("лёг в полночь встал в 7");
        assert_eq!(e.kind, "sleep");
        assert_eq!((day_text(e.at_ms, TZ), minute_of_day(e.at_ms, TZ)), ("2026-11-16".to_string(), 0));
        assert_eq!(e.value, 420.0);
        let e = one("лег в 11 встал в 7:10");
        assert_eq!((day_text(e.at_ms, TZ), minute_of_day(e.at_ms, TZ)), ("2026-11-15".to_string(), 23 * 60));
        assert_eq!(e.value, 490.0);
    }

    #[test]
    fn out_of_range_is_a_problem_and_leftovers_are_returned() {
        let r = parse("вес 720, купить хлеб", now(), TZ);
        assert!(r.entries.is_empty());
        assert_eq!(r.problems, vec![Problem { text: "вес 720".into(), code: "range" }]);
        assert_eq!(r.unparsed, vec!["купить хлеб".to_string()]);
    }
}
