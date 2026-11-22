//! Разбор свободного ввода «Здоровья» (spec 038, правило HEALTH-2): строка текста → записи домена
//! `parvane.health.v1`. Один разбор на все клиенты: общий образец — `conformance/health-parse/cases.json`.
//!
//! Устройство: строка режется на лексемы (числа, время `ЧЧ:ММ`, слова, знаки), числа словами становятся числами
//! («семь», «полтора», «полвосьмого»), затем проход слева направо пробует распознаватели в текущей позиции.
//! Порядок слов свободный, формулировка — разговорная: «72 кг», «взвесился 72 и 4», «вчера вес 72,4 в 8:30»,
//! «лёг в полночь встал в семь», «пошёл спать в 23, проснулся в 7 утра», «вздремнул полчаса», «120 на 80 пульс 64»,
//! «выпил бутылку воды», «чувствую себя отлично», «в понедельник прошёл 8 000 шагов». Русский и английский
//! понимаются одновременно. Что не разобрано — возвращается в `unparsed` дословно, значение вне разумного
//! диапазона — в `problems`; молча ничего не теряется.
//!
//! Без регулярных выражений и без ИИ; времени системы и часовых поясов разбор не читает — момент «сейчас» и
//! смещение местного времени передаёт хост. Новая формулировка — слово в таблице и случай в образце.

use serde_json::{json, Value};

use crate::domain::health::{civil_from_days, days_from_civil, minute_of_day};

#[path = "health_parse_food.rs"]
mod food;
pub use food::{meal_by_minute, part_in_range, workout_tag_of, KIND_FOOD, KIND_WORKOUT};

const DAY_MS: i64 = 86_400_000;
const MIN_MS: i64 = 60_000;
/// Сколько вперёд от «сейчас» может стоять время записи без явного дня, прежде чем разбор отнесёт её к вчера.
pub const FUTURE_SLACK_MS: i64 = 30 * MIN_MS;
/// Стакан воды, мл.
pub const GLASS_ML: f64 = 250.0;
pub const MAX_INPUT: usize = 2000;

/// Одна разобранная запись (id и метки ставит домен).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub kind: &'static str,
    pub at_ms: i64,
    /// 0 — запись-момент.
    pub end_ms: i64,
    pub value: f64,
    pub value2: f64,
    pub unit: &'static str,
    /// Название: что съедено.
    pub name: String,
    /// Приём пищи либо тип тренировки.
    pub tag: &'static str,
    /// Именованные числа: БЖУ и граммы еды, километры и упражнения тренировки.
    pub parts: Vec<(&'static str, f64)>,
    /// Запись — догадка без единого числа (еда по слову приёма): строка может оказаться не про здоровье.
    pub guess: bool,
    /// Значение еды посчитано из БЖУ, а не названо.
    pub computed: bool,
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
                '-' | '–' | '—' | '→' => Some(Tok::Dash),
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

/// Число словом: «семь», «одиннадцать», «полтора», «seven».
fn numeral(word: &str) -> Option<f64> {
    const RU: &[(&str, f64)] = &[
        ("ноль", 0.0), ("один", 1.0), ("одна", 1.0), ("одну", 1.0), ("два", 2.0), ("две", 2.0), ("три", 3.0), ("четыре", 4.0), ("пять", 5.0),
        ("шесть", 6.0), ("семь", 7.0), ("восемь", 8.0), ("девять", 9.0), ("десять", 10.0), ("одиннадцать", 11.0), ("двенадцать", 12.0),
        ("тринадцать", 13.0), ("четырнадцать", 14.0), ("пятнадцать", 15.0), ("шестнадцать", 16.0), ("семнадцать", 17.0),
        ("восемнадцать", 18.0), ("девятнадцать", 19.0), ("двадцать", 20.0), ("тридцать", 30.0), ("сорок", 40.0), ("пятьдесят", 50.0),
        ("полтора", 1.5), ("полторы", 1.5),
        ("zero", 0.0), ("one", 1.0), ("two", 2.0), ("three", 3.0), ("four", 4.0), ("five", 5.0), ("six", 6.0), ("seven", 7.0), ("eight", 8.0),
        ("nine", 9.0), ("ten", 10.0), ("eleven", 11.0), ("twelve", 12.0),
    ];
    RU.iter().find(|(w, _)| *w == word).map(|(_, v)| *v)
}

/// «полвосьмого» — 7:30 (час без части суток: утро или вечер решает контекст).
fn half_hour_word(word: &str) -> Option<u32> {
    const W: &[(&str, u32)] = &[
        ("полпервого", 0), ("полвторого", 1), ("полтретьего", 2), ("полчетвертого", 3), ("полпятого", 4), ("полшестого", 5),
        ("полседьмого", 6), ("полвосьмого", 7), ("полдевятого", 8), ("полдесятого", 9), ("кполодиннадцатого", 10), ("полодиннадцатого", 10),
        ("полдвенадцатого", 11),
    ];
    W.iter().find(|(w, _)| *w == word).map(|(_, h)| if *h == 0 { 12 * 60 + 30 } else { h * 60 + 30 })
}

/// Числа словами → числовые лексемы; «двадцать три» → 23; «полчаса» → 0,5 часа; «поллитра» → 0,5 литра.
fn fold_numerals(toks: Vec<Lex>) -> Vec<Lex> {
    let mut out: Vec<Lex> = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        let Some(l) = toks.get(i) else { break };
        let Tok::Word(w) = &l.tok else {
            out.push(l.clone());
            i += 1;
            continue;
        };
        let num = |v: f64, start: usize, end: usize| Lex { tok: Tok::Num { v, raw: if v.fract() == 0.0 { format!("{}", v as i64) } else { format!("{v}") } }, start, end };
        if let Some(m) = half_hour_word(w) {
            out.push(Lex { tok: Tok::Time(m), start: l.start, end: l.end });
        } else if let Some(rest) = w.strip_prefix("пол").filter(|r| r.starts_with("час") || r.starts_with("литр")) {
            out.push(num(0.5, l.start, l.end));
            out.push(Lex { tok: Tok::Word(rest.to_string()), start: l.start, end: l.end });
        } else if w == "пол" || w == "half" {
            // «пол литра», «half an hour»; «half past ten» — время, его читает `clock`
            let next = toks.get(i + 1).and_then(|n| if let Tok::Word(x) = &n.tok { Some(x.as_str()) } else { None });
            if next == Some("past") {
                out.push(l.clone());
            } else {
                out.push(num(0.5, l.start, l.end));
            }
        } else if let Some(v) = numeral(w) {
            // Составное: «двадцать три»
            let unit = toks.get(i + 1).and_then(|n| if let Tok::Word(x) = &n.tok { numeral(x) } else { None }).filter(|u| v >= 20.0 && v.fract() == 0.0 && (1.0..=9.0).contains(u));
            match (unit, toks.get(i + 1)) {
                (Some(u), Some(n)) => {
                    out.push(num(v + u, l.start, n.end));
                    i += 1;
                }
                _ => out.push(num(v, l.start, l.end)),
            }
        } else {
            out.push(l.clone());
        }
        i += 1;
    }
    out
}

fn any(word: &str, exact: &[&str]) -> bool {
    exact.contains(&word)
}

fn stem(word: &str, stems: &[&str]) -> bool {
    stems.iter().any(|s| word.starts_with(s))
}

/// Служебные слова: сами по себе в `unparsed` не попадают (внутри неразобранного куска сохраняются).
const NOISE: &[&str] = &[
    "я", "и", "а", "в", "во", "на", "за", "к", "с", "со", "у", "о", "это", "было", "был", "была", "были", "стало", "стал", "уже", "еще", "потом", "затем",
    "около", "примерно", "где", "то", "почти", "ровно", "всего", "только", "целых", "итого", "мне", "меня", "мой", "моя", "мое", "мои", "себя", "сейчас",
    "очень", "довольно", "вполне", "пошел", "пошла", "ушел", "ушла", "отправился", "отправилась", "завалился", "завалилась", "прошел", "прошла",
    "прошагал", "прошагала", "сделал", "сделала", "нашагал", "нашагала", "намерил", "намерила", "измерил", "измерила", "померил", "померила",
    "замерил", "замерила", "показал", "показала", "показало", "показали", "составил", "составила", "составило", "составляет", "равно", "результат",
    "перед", "после", "день", "сутки", "прошлой", "этой", "крови", "обхват", "процент", "уровень",
    "i", "and", "at", "to", "the", "a", "an", "of", "my", "was", "is", "then", "about", "around", "went", "fell", "got", "in", "by", "for", "had", "have",
    "did", "took", "walked", "now", "just", "roughly", "approximately", "almost", "exactly", "total", "this", "last", "out", "me", "it", "blood", "body",
    "heart", "per", "day", "pretty", "very", "on",
];
const LEAD_IN: &[&str] = &["в", "во", "at", "около", "примерно", "about", "around", "где", "то", "к", "by", "this", "in", "the", "с", "после", "перед"];
const BED: &[&str] = &[
    "лег", "легла", "легли", "лягу", "ложусь", "уснул", "уснула", "заснул", "заснула", "отбой", "отрубился", "отрубилась", "вырубился", "вырубилась",
    "задремал", "задремала", "прилег", "прилегла", "спать", "bed", "asleep", "bedtime",
];
const WAKE: &[&str] = &[
    "встал", "встала", "проснулся", "проснулась", "подъем", "пробудился", "пробудилась", "очнулся", "очнулась", "поднялся", "поднялась", "вскочил",
    "вскочила", "разбудили", "woke", "wake", "awoke", "awake", "wakeup", "up",
];
const SLEEP: &[&str] = &[
    "сон", "сна", "спал", "спала", "проспал", "проспала", "поспал", "поспала", "выспался", "выспалась", "дремал", "дремала", "вздремнул", "вздремнула",
    "подремал", "подремала", "sleep", "slept", "nap", "napped",
];
const HOUR_UNIT: &[&str] = &["ч", "час", "часа", "часов", "часик", "часика", "часиков", "h", "hr", "hrs", "hour", "hours"];
const MIN_UNIT: &[&str] = &["м", "мин", "минут", "минуты", "минуту", "минута", "минуток", "минутки", "m", "min", "mins", "minute", "minutes"];
const THOUSAND: &[&str] = &["к", "k", "тыс", "тысяч", "тысячи", "тысяча"];
const WATER_NOUN: &[&str] = &["воды", "вода", "воду", "водички", "water", "of"];
const WEEKDAYS: &[(&str, i64)] = &[
    ("воскресень", 0), ("понедельник", 1), ("вторник", 2), ("сред", 3), ("четверг", 4), ("пятниц", 5), ("суббот", 6),
    ("sunday", 0), ("monday", 1), ("tuesday", 2), ("wednesday", 3), ("thursday", 4), ("friday", 5), ("saturday", 6),
];
const MONTHS: &[(&str, u32)] = &[
    ("январ", 1), ("феврал", 2), ("март", 3), ("апрел", 4), ("мая", 5), ("май", 5), ("июн", 6), ("июл", 7), ("август", 8), ("сентябр", 9), ("октябр", 10),
    ("ноябр", 11), ("декабр", 12), ("january", 1), ("february", 2), ("march", 3), ("april", 4), ("june", 6), ("july", 7), ("august", 8), ("september", 9),
    ("october", 10), ("november", 11), ("december", 12),
];
const MONTHS_SHORT: &[(&str, u32)] = &[("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4), ("may", 5), ("jun", 6), ("jul", 7), ("aug", 8), ("sep", 9), ("sept", 9), ("oct", 10), ("nov", 11), ("dec", 12)];

fn month_of(word: &str) -> Option<u32> {
    MONTHS.iter().find(|(s, _)| word.starts_with(s)).or_else(|| MONTHS_SHORT.iter().find(|(s, _)| *s == word)).map(|(_, m)| *m)
}

/// Слово части суток после часа.
fn part_of_day(word: &str) -> Option<&'static str> {
    match word {
        "утра" | "утром" | "am" => Some("am"),
        "дня" | "днем" => Some("day"),
        "вечера" | "вечером" | "pm" => Some("pm"),
        "ночи" | "ночью" => Some("night"),
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

/// Время суток словом: «утром», «в обед», «перед сном», «after dinner».
fn fuzzy_time(word: &str) -> Option<u32> {
    match word {
        "утром" | "утречком" | "утра" | "morning" => Some(8 * 60),
        "завтрака" | "завтраком" | "breakfast" => Some(9 * 60),
        "обед" | "обеда" | "обедом" | "lunch" => Some(13 * 60),
        "днем" | "afternoon" => Some(14 * 60),
        "вечером" | "вечерком" | "evening" | "ужина" | "ужином" | "dinner" => Some(20 * 60),
        "ночью" | "ночь" | "night" | "tonight" | "сном" => Some(23 * 60),
        _ => None,
    }
}

/// Время суток, прочитанное из текста.
#[derive(Debug, Clone, Copy)]
struct Clock {
    minute: u32,
    /// Часть суток названа явно («утра», «pm») либо время однозначно («полночь», «23:30»).
    exact: bool,
    next: usize,
}

struct Parser<'a> {
    text: &'a str,
    toks: Vec<Lex>,
    used: Vec<bool>,
    /// Служебное слово: само в `unparsed` не идёт, но внутри неразобранного куска остаётся.
    noise: Vec<bool>,
}

#[derive(Debug, Clone)]
struct Item {
    kind: &'static str,
    value: f64,
    value2: f64,
    unit: &'static str,
    minute: Option<u32>,
    /// Время, сказанное в начале фразы до разделителя: «вчера вечером давление 140/95 пульс 88».
    lead: Option<u32>,
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

    fn is_word(&self, i: usize, set: &[&str]) -> bool {
        self.word(i).is_some_and(|w| any(w, set))
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
        while n < max && self.is_word(i, set) {
            i += 1;
            n += 1;
        }
        i
    }

    /// Число показателя: «72,4», «72 и 4» (десятые голосом), «7 с половиной», «seven and a half».
    fn number(&self, i: usize) -> Option<(f64, usize)> {
        let (v, raw) = self.num(i)?;
        let whole = !raw.contains('.');
        if whole && self.is_word(i + 1, &["и", "and"]) {
            // «seven and a half»: «half» уже стало числом 0,5
            if self.is_word(i + 2, &["a"]) && self.num(i + 3).is_some_and(|(h, _)| h == 0.5) {
                return Some((v + 0.5, i + 4));
            }
            if let Some((d, draw)) = self.num(i + 2) {
                // Десятые: одна цифра и дальше не единица измерения другого показателя
                if draw.len() == 1 && self.word(i + 3).and_then(unit_after_number).is_none() && !self.is(i + 3, &Tok::Slash) {
                    return Some((v + d / 10.0, i + 3));
                }
            }
        }
        if whole && self.is_word(i + 1, &["с", "со"]) && self.is_word(i + 2, &["половиной"]) {
            return Some((v + 0.5, i + 3));
        }
        Some((v, i + 1))
    }

    /// Время суток с позиции `i`. `bare_hour` — принимать ли голый час без минут и части суток («в 7», «в час»).
    fn clock(&self, i: usize, bare_hour: bool) -> Option<Clock> {
        if let Some(w) = self.word(i) {
            let fixed = match w {
                "полночь" | "полуночи" | "midnight" => Some(0),
                "полдень" | "полудня" | "noon" => Some(720),
                _ => None,
            };
            if let Some(minute) = fixed {
                return Some(Clock { minute, exact: true, next: i + 1 });
            }
            // «half past ten», «quarter past seven», «quarter to eight»
            if matches!(w, "half" | "quarter") {
                let (h, _) = self.num(i + 2).filter(|(h, raw)| !raw.contains('.') && (1.0..=12.0).contains(h))?;
                let h = h as u32;
                let (h, m) = match (w, self.word(i + 1)?) {
                    ("half", "past") => (h, 30),
                    ("quarter", "past") => (h, 15),
                    ("quarter", "to") => ((h + 11) % 12, 45),
                    _ => return None,
                };
                return Some(self.with_part(h, m, i + 3, true));
            }
            // «в час», «в час ночи»
            if matches!(w, "час" | "часа") && bare_hour {
                return Some(self.with_part(1, 0, i + 1, true));
            }
            return None;
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
        if !has_minutes && self.is_word(next, HOUR_UNIT) {
            next += 1;
        }
        let has_part = self.word(next).and_then(part_of_day).is_some();
        if !has_minutes && !bare_hour && !has_part {
            return None;
        }
        if has_part && h > 12 && !matches!(self.word(next).and_then(part_of_day), Some("pm") | Some("night")) {
            return None;
        }
        Some(self.with_part(h, m, next, false))
    }

    /// Час и минуты с необязательной частью суток за ними.
    fn with_part(&self, h: u32, m: u32, next: usize, _spoken: bool) -> Clock {
        match self.word(next).and_then(part_of_day) {
            Some(part) => Clock { minute: apply_part(h, part) % 24 * 60 + m, exact: true, next: next + 1 },
            None => Clock { minute: (h % 24) * 60 + m, exact: h >= 13 || h == 0, next },
        }
    }

    /// Время записи-момента: «в 8:30», «at 7 pm», «8:30», «утром», «после обеда», «this morning».
    fn point_time(&self, i: usize) -> Option<(u32, usize)> {
        let j = self.skip_words(i, LEAD_IN, 3);
        if let Some(m) = self.word(j).and_then(fuzzy_time) {
            return Some((m, j + 1));
        }
        let c = self.clock(j, j > i)?;
        Some((c.minute, c.next))
    }

    /// Длительность: «7ч 30м», «7.5 ч», «45 мин», «7:30», «8», «полтора часа», «7 с половиной часов».
    fn duration(&self, i: usize) -> Option<(f64, usize)> {
        if let Some(Tok::Time(t)) = self.toks.get(i).map(|l| &l.tok) {
            return Some((f64::from(*t), i + 1));
        }
        if self.is_word(i, &["час", "часа", "часик", "hour"]) {
            return Some((60.0, i + 1));
        }
        let (v, after) = self.number(i)?;
        let unit_at = self.skip_words(after, &["a", "an"], 1);
        match self.word(unit_at) {
            Some(w) if any(w, HOUR_UNIT) => {
                let mut total = v * 60.0;
                let mut next = unit_at + 1;
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
            Some(w) if any(w, MIN_UNIT) => Some((v.round(), unit_at + 1)),
            _ if v <= 24.0 => Some(((v * 60.0).round(), after)),
            _ => None,
        }
    }

    /// День словами с позиции `i`: «вчера», «3 дня назад», «в понедельник», «12 ноября», «nov 12».
    fn day_at(&self, i: usize, today: i64) -> Option<(i64, usize)> {
        if let Some(w) = self.word(i) {
            let off = match w {
                "сегодня" | "today" => Some(0),
                "вчера" | "yesterday" => Some(-1),
                "позавчера" => Some(-2),
                _ => None,
            };
            if let Some(o) = off {
                return Some((today + o, i + 1));
            }
            if let Some((_, wd)) = WEEKDAYS.iter().find(|(s, _)| w.starts_with(s)) {
                // Ближайший такой день не позже сегодня (1970-01-01 — четверг)
                let today_wd = (today + 4).rem_euclid(7);
                return Some((today - (today_wd - wd).rem_euclid(7), i + 1));
            }
            if let (Some(m), Some((d, raw))) = (month_of(w), self.num(i + 1)) {
                if !raw.contains('.') && (1.0..=31.0).contains(&d) {
                    return Some((date_near(today, m, d as u32), i + 2));
                }
            }
            return None;
        }
        let (n, raw) = self.num(i)?;
        if raw.contains('.') {
            return None;
        }
        if (1.0..=60.0).contains(&n) && self.is_word(i + 1, &["день", "дня", "дней", "day", "days"]) && self.is_word(i + 2, &["назад", "ago"]) {
            return Some((today - n as i64, i + 3));
        }
        if (1.0..=31.0).contains(&n) {
            if let Some(m) = self.word(i + 1).and_then(month_of) {
                return Some((date_near(today, m, n as u32), i + 2));
            }
        }
        None
    }

    /// Количество с тысячами: «8к», «8 тыс», «8 000», «8,000» — когда дальше единица шагов (`steps`).
    fn count(&self, i: usize, steps: bool) -> Option<(f64, usize)> {
        let (mut v, raw) = self.num(i)?;
        let mut next = i + 1;
        if steps {
            // «8,000» / «8.000» — разделитель тысяч
            if raw.split_once('.').is_some_and(|(_, f)| f.len() == 3) {
                v = (v * 1000.0).round();
            }
            // «8 000»
            if let Some((g, graw)) = self.num(next) {
                if graw.len() == 3 && !graw.contains('.') && !raw.contains('.') && v < 1000.0 {
                    v = v * 1000.0 + g;
                    next += 1;
                }
            }
        }
        if self.is_word(next, THOUSAND) {
            v *= 1000.0;
            next += 1;
        }
        Some((v, next))
    }
}

/// День месяца ближайшего прошлого: дата в этом году, а если она ещё не наступила — в прошлом.
fn date_near(today: i64, month: u32, day: u32) -> i64 {
    let (y, ..) = civil_from_days(today);
    let d = days_from_civil(y, month, day);
    if d > today { days_from_civil(y - 1, month, day) } else { d }
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
    Kind { kind: "weight", unit: "kg", exact: &["вес", "weight", "вешу", "весил", "весила", "весы", "весах", "масса", "weigh", "weighed", "weighing", "weighs"], stems: &["взвесил"], min: 2.0, max: 500.0 },
    Kind { kind: "pressure", unit: "mmhg", exact: &["ад", "bp", "pressure", "давл", "тонометр"], stems: &["давлени"], min: 50.0, max: 300.0 },
    Kind { kind: "pulse", unit: "bpm", exact: &["чсс", "hr", "pulse", "rate", "bpm"], stems: &["пульс", "сердцебиени"], min: 20.0, max: 250.0 },
    Kind { kind: "steps", unit: "steps", exact: &["steps"], stems: &["шаг"], min: 0.0, max: 200_000.0 },
    Kind { kind: "water", unit: "ml", exact: &["water", "drank", "drink", "выпил", "выпила", "попил", "попила"], stems: &["вод"], min: 1.0, max: 10_000.0 },
    Kind { kind: "mood", unit: "score", exact: &["mood", "настр", "чувствую", "feeling", "feel"], stems: &["настроени", "самочувстви"], min: 1.0, max: 5.0 },
    Kind { kind: "temperature", unit: "c", exact: &["temp", "temperature", "темп"], stems: &["температур"], min: 30.0, max: 45.0 },
    Kind { kind: "glucose", unit: "mmol_l", exact: &["сахар", "glucose", "sugar"], stems: &["глюкоз"], min: 1.0, max: 40.0 },
    Kind { kind: "height", unit: "cm", exact: &["рост", "height"], stems: &[], min: 30.0, max: 260.0 },
    Kind { kind: "waist", unit: "cm", exact: &["талия", "талии", "талию", "waist"], stems: &[], min: 20.0, max: 300.0 },
    Kind { kind: "hips", unit: "cm", exact: &["бедра", "бедер", "hips"], stems: &[], min: 20.0, max: 300.0 },
    Kind { kind: "chest", unit: "cm", exact: &["грудь", "груди", "chest"], stems: &[], min: 20.0, max: 300.0 },
    Kind { kind: "body_fat", unit: "pct", exact: &["жир", "жира", "fat"], stems: &[], min: 1.0, max: 75.0 },
    Kind { kind: "spo2", unit: "pct", exact: &["spo", "кислород", "oxygen"], stems: &["сатураци"], min: 50.0, max: 100.0 },
];

fn kind_of(kind: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| k.kind == kind)
}

/// Значение показателя в разумном диапазоне; у вида вне словаря диапазона нет. Общая проверка разбора и форм.
pub fn in_range(kind: &str, value: f64, value2: f64) -> bool {
    if let Some(ok) = food::value_in_range(kind, value) {
        return ok;
    }
    let Some(k) = kind_of(kind) else { return true };
    value >= k.min && value <= k.max && (kind != "pressure" || (value2 >= 30.0 && value2 <= 200.0 && value > value2))
}

/// Длительность сна в минутах: от десяти минут до суток.
pub fn sleep_in_range(minutes: f64) -> bool {
    (10.0..=1440.0).contains(&minutes)
}

fn keyword(word: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| any(word, k.exact) || stem(word, k.stems))
}

/// Единица после числа → (вид, множитель к единице хранения).
fn unit_after_number(word: &str) -> Option<(&'static str, f64)> {
    if any(word, &["кг", "kg", "kgs", "кило", "kilo", "kilos"]) || stem(word, &["килограмм"]) {
        Some(("weight", 1.0))
    } else if any(word, &["lb", "lbs", "pound", "pounds"]) || stem(word, &["фунт"]) {
        Some(("weight", 0.453_592_37))
    } else if any(word, &["мл", "ml"]) || stem(word, &["миллилитр"]) {
        Some(("water", 1.0))
    } else if any(word, &["л", "l", "liter", "liters", "litre", "litres"]) || stem(word, &["литр"]) {
        Some(("water", 1000.0))
    } else if stem(word, &["стакан", "чашк", "чашеч"]) || any(word, &["glass", "glasses", "cup", "cups"]) {
        Some(("water", GLASS_ML))
    } else if stem(word, &["кружк", "кружеч"]) || any(word, &["mug", "mugs"]) {
        Some(("water", 300.0))
    } else if stem(word, &["бутыл"]) || any(word, &["bottle", "bottles"]) {
        Some(("water", 500.0))
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

/// Слова, на которых фраза показателя кончается: дальше начинается другой факт («выпил воды и прошёл 6к шагов»).
const FACT_BREAK: &[&str] = &[
    "и", "and", "а", "потом", "затем", "then", "прошел", "прошла", "прошагал", "прошагала", "сделал", "сделала", "нашагал", "нашагала", "walked", "did",
    "took", "had", "пошел", "пошла", "ушел", "ушла", "went",
];

/// Ёмкость без числа — одна штука: «стакан воды», «выпил бутылку», «выпил литр».
fn container(word: &str) -> Option<f64> {
    unit_after_number(word).filter(|(k, mul)| *k == "water" && *mul >= GLASS_ML).map(|(_, mul)| mul)
}

fn mood_word(word: &str) -> Option<f64> {
    if stem(word, &["отличн", "прекрасн", "супер", "замечательн", "великолепн", "шикарн", "огонь", "бодр"]) || any(word, &["great", "excellent", "awesome", "amazing", "fantastic"]) {
        Some(5.0)
    } else if stem(word, &["хорош", "неплох"]) || any(word, &["good", "nice", "well"]) {
        Some(4.0)
    } else if stem(word, &["норм", "средн", "обычн", "терпим"]) || any(word, &["ok", "okay", "fine", "ок", "meh", "average"]) {
        Some(3.0)
    } else if stem(word, &["плох", "неважн", "грустн", "устал", "вял", "разбит"]) || any(word, &["bad", "tired", "sad", "low"]) {
        Some(2.0)
    } else if stem(word, &["ужасн", "отвратительн", "кошмар", "паршив"]) || any(word, &["terrible", "awful", "horrible"]) {
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

/// Привести значение к единице хранения: градусы Фаренгейта, мг/дл, метры, шкала настроения.
fn normalize(kind: &str, v: f64) -> f64 {
    match kind {
        "weight" => round1(v),
        // 86–113 — это Фаренгейт
        "temperature" if (86.0..=113.0).contains(&v) => round1((v - 32.0) * 5.0 / 9.0),
        // Больше 40 — мг/дл
        "glucose" if v > 40.0 && v <= 720.0 => round1(v / 18.016),
        "height" if v < 3.0 => (v * 100.0).round(),
        _ => v,
    }
}

/// Разобрать строку. `now_ms` — момент ввода, `tz_min` — смещение местного времени от UTC в минутах.
pub fn parse(text: &str, now_ms: i64, tz_min: i32) -> ParseResult {
    let mut res = ParseResult::default();
    if text.len() > MAX_INPUT {
        res.unparsed.push(text.chars().take(80).collect());
        return res;
    }
    // «a.m.» / «p.m.» — одним словом (длина сохраняется: срезы неразобранного берутся из этой строки)
    let text = &text.replace("a.m.", "am  ").replace("p.m.", "pm  ").replace("A.M.", "am  ").replace("P.M.", "pm  ");
    let toks = fold_numerals(lex(text));
    let n = toks.len();
    let mut p = Parser { text, used: vec![false; n], noise: vec![false; n], toks };
    let today = (now_ms + i64::from(tz_min) * MIN_MS).div_euclid(DAY_MS);

    // Еда и тренировки — отдельным проходом: их лексемы основной разбор пропускает
    let found = food::scan(&mut p, today, &mut res.problems);

    let mut items: Vec<Item> = Vec::new();
    let mut cur_day: Option<i64> = None;
    let mut pending_time: Option<(u32, usize, usize)> = None;
    let (mut bed, mut wake): (Option<u32>, Option<u32>) = (None, None);
    let mut sleep_dur: Option<f64> = None;
    let mut sleep_marks: Vec<usize> = Vec::new();
    // День, названный к моменту «лёг» и «встал», и что из них сказано первым
    let (mut bed_ref, mut wake_ref, mut bed_first): (Option<i64>, Option<i64>, bool) = (None, None, false);
    let mut sleep_span: Option<(usize, usize)> = None;
    // «верхнее 120, нижнее 80»
    let (mut sys, mut dia): (Option<(f64, usize, usize)>, Option<(f64, usize, usize)>) = (None, None);

    // Запись-момент готова: пометить лексемы и прочитать время сразу за ней
    macro_rules! push_item {
        ($kind:expr, $v:expr, $v2:expr, $from:expr, $next:expr) => {{
            let kind: &'static str = $kind;
            let unit = kind_of(kind).map_or("", |k| k.unit);
            let mut to = $next;
            let mut minute = None;
            if let Some((m, after)) = p.point_time(to) {
                minute = Some(m);
                to = after;
            }
            items.push(Item { kind, value: normalize(kind, $v), value2: $v2, unit, minute, lead: pending_time.map(|(m, ..)| m), day: cur_day, from: $from, to });
            p.mark($from, to);
            to
        }};
    }

    let mut i = 0;
    while i < n {
        if p.used.get(i).copied().unwrap_or(false) {
            i += 1;
            continue;
        }
        // Разделитель: время, сказанное до него, к следующей записи не относится
        if p.is(i, &Tok::Sep) {
            p.used[i] = true;
            pending_time = None;
            i += 1;
            continue;
        }
        // ── день: «вчера», «в понедельник», «12 ноября», «3 дня назад» ──
        if let Some((day, next)) = p.day_at(i, today) {
            cur_day = Some(day);
            // «вес 72 вчера» — день относится и к уже сказанному без дня
            for it in items.iter_mut().filter(|it| it.day.is_none()) {
                it.day = Some(day);
            }
            p.mark(i, next);
            i = next;
            continue;
        }
        let word = p.word(i).map(str::to_string);
        if let Some(w) = word.as_deref() {
            // «прошлой ночью», «last night» — это не время записи
            if matches!(w, "ночью" | "night") && i > 0 && p.is_word(i - 1, &["прошлой", "этой", "last", "сегодня", "today"]) {
                p.noise[i] = true;
                p.used[i] = true;
                i += 1;
                continue;
            }
            // ── сон: лёг / встал ──
            let out_of_bed = w == "bed" && i >= 2 && p.is_word(i - 1, &["of"]) && p.is_word(i - 2, &["out"]);
            if any(w, BED) || any(w, WAKE) {
                let is_bed = any(w, BED) && !out_of_bed;
                // «лёг вчера вечером где-то в 11»
                let mut j = i + 1;
                for _ in 0..5 {
                    if let Some((day, next)) = p.day_at(j, today).filter(|_| p.num(j).is_none()) {
                        cur_day = Some(day);
                        j = next;
                        continue;
                    }
                    match p.word(j) {
                        Some(x) if any(x, NOISE) || fuzzy_time(x).is_some() => j += 1,
                        _ if p.is(j, &Tok::Dash) => j += 1,
                        _ => break,
                    }
                }
                if let Some(c) = p.clock(j, true) {
                    if is_bed {
                        bed = Some(bed_minute(c));
                        bed_ref = cur_day;
                        bed_first = wake.is_none();
                    } else {
                        wake = Some(c.minute);
                        wake_ref = cur_day;
                    }
                    p.mark(i, c.next);
                    widen(&mut sleep_span, i, c.next);
                    i = c.next;
                    continue;
                }
                sleep_marks.push(i);
                p.used[i] = true;
                i += 1;
                continue;
            }
            // ── сон: длительность и «с … до …» ──
            if any(w, SLEEP) {
                let at_word = p.is_word(i + 1, &["в", "во", "at"]);
                // «спал прошлой ночью 6 часов», «поспал днём часик»
                let mut j = i + 1;
                for _ in 0..4 {
                    match p.word(j) {
                        Some(x) if (any(x, NOISE) && !any(x, &["с", "со"])) || fuzzy_time(x).is_some() => j += 1,
                        _ => break,
                    }
                }
                // «спал с 23 до 7», «сон 23:30–7:10», «slept from 11pm to 7am»
                let from_j = if p.is_word(j, &["с", "со", "от", "from", "c"]) { j + 1 } else { j };
                if let Some(a) = p.clock(from_j, true) {
                    let sep = a.next;
                    if p.is(sep, &Tok::Dash) || p.is_word(sep, &["до", "по", "to", "until", "till"]) {
                        if let Some(b) = p.clock(sep + 1, true) {
                            bed = Some(bed_minute(a));
                            wake = Some(b.minute);
                            (bed_ref, wake_ref, bed_first) = (cur_day, cur_day, true);
                            p.mark(i, b.next);
                            widen(&mut sleep_span, i, b.next);
                            i = b.next;
                            continue;
                        }
                    }
                    // «went to sleep at 11» — это время отбоя, не длительность
                    if at_word {
                        bed = Some(bed_minute(a));
                        bed_ref = cur_day;
                        bed_first = wake.is_none();
                        p.mark(i, a.next);
                        widen(&mut sleep_span, i, a.next);
                        i = a.next;
                        continue;
                    }
                }
                if let Some((d, next)) = p.duration(j) {
                    sleep_dur = Some(d);
                    p.mark(i, next);
                    widen(&mut sleep_span, i, next);
                    i = next;
                    continue;
                }
                sleep_marks.push(i);
                p.used[i] = true;
                i += 1;
                continue;
            }
            // ── давление по частям: «верхнее 120 нижнее 80» ──
            let part = if stem(w, &["верхн", "систолич"]) || any(w, &["sys", "systolic"]) { Some(true) } else if stem(w, &["нижн", "диастолич"]) || any(w, &["dia", "diastolic"]) { Some(false) } else { None };
            if let (Some(upper), Some((v, _))) = (part, p.num(i + 1)) {
                if upper {
                    sys = Some((v, i, i + 2));
                } else {
                    dia = Some((v, i, i + 2));
                }
                p.mark(i, i + 2);
                i += 2;
                continue;
            }
            // ── показатель по ключевому слову ──
            if let Some(k) = keyword(w) {
                let mut j = i + 1;
                let mut kw_minute: Option<u32> = None;
                // «spo2» режется на слово и цифру
                if k.kind == "spo2" && p.toks.get(i).map(|l| l.end) == p.toks.get(j).map(|l| l.start) && p.num(j).is_some_and(|(v, _)| v == 2.0) {
                    j += 1;
                }
                // «вес сегодня утром 72», «давление было 120/80»
                for _ in 0..4 {
                    if let Some((day, next)) = p.day_at(j, today).filter(|_| p.num(j).is_none()) {
                        cur_day = Some(day);
                        j = next;
                    } else if p.word(j).is_some_and(|x| any(x, NOISE) && !any(x, FACT_BREAK)) || p.is(j, &Tok::Dash) {
                        j += 1;
                    } else if p.word(j).and_then(fuzzy_time).is_some() && p.num(j + 1).is_some() {
                        kw_minute = p.word(j).and_then(fuzzy_time);
                        j += 1;
                    } else {
                        break;
                    }
                }
                let got: Option<(f64, f64, usize)> = match k.kind {
                    "pressure" => p.num(j).and_then(|(a, _)| {
                        let k2 = if p.is(j + 1, &Tok::Slash) || p.is(j + 1, &Tok::Dash) || p.is_word(j + 1, &["на", "over", "x", "х", "и"]) { j + 2 } else { j + 1 };
                        p.num(k2).map(|(b, _)| (a, b, k2 + 1))
                    }),
                    "mood" => {
                        // «настроение 4», «4 из 5», «8/10», «чувствую себя хорошо», «так себе»
                        if let Some((v, _)) = p.num(j) {
                            let scale = if p.is(j + 1, &Tok::Slash) || p.is_word(j + 1, &["из", "of"]) { p.num(j + 2).map(|(s, _)| s) } else { None };
                            match scale {
                                Some(s) if s == 10.0 => Some(((v / 2.0).round().max(1.0), 0.0, j + 3)),
                                Some(s) if s == 5.0 => Some((v, 0.0, j + 3)),
                                _ => Some((v, 0.0, j + 1)),
                            }
                        } else if p.is_word(j, &["так"]) && p.is_word(j + 1, &["себе"]) {
                            Some((3.0, 0.0, j + 2))
                        } else {
                            p.word(j).and_then(mood_word).map(|v| (v, 0.0, j + 1))
                        }
                    }
                    "water" => match p.number(j) {
                        Some((v, after)) => match p.word(after).and_then(unit_after_number) {
                            Some(("water", mul)) => Some((v * mul, 0.0, after + 1)),
                            // Без единицы: до 10 — литры, больше — миллилитры
                            _ => Some((if v <= 10.0 { v * 1000.0 } else { v }, 0.0, after)),
                        },
                        None => match p.word(j).and_then(container) {
                            Some(ml) => Some((ml, 0.0, j + 1)),
                            // «выпил воды», «попила водички» — стакан
                            None if !stem(w, &["вод"]) && w != "water" && p.is_word(j, WATER_NOUN) && p.num(j + 1).is_none() => Some((GLASS_ML, 0.0, j + 1)),
                            None => None,
                        },
                    },
                    "steps" => p.count(j, true).map(|(v, next)| (v, 0.0, if p.word(next).and_then(unit_after_number).is_some_and(|(k, _)| k == "steps") { next + 1 } else { next })),
                    _ => p.number(j).map(|(v, after)| {
                        let mut v = v;
                        let mut next = after;
                        match p.word(next).and_then(unit_after_number) {
                            Some((kind, mul)) if kind == k.kind => {
                                v *= mul;
                                next += 1;
                            }
                            _ => {}
                        }
                        if matches!(k.kind, "height" | "waist" | "hips" | "chest") {
                            if p.is_word(next, &["см", "cm", "сантиметров", "сантиметра"]) {
                                next += 1;
                            } else if p.is_word(next, &["м", "m", "метр", "метра"]) {
                                v *= 100.0;
                                next += 1;
                            }
                        }
                        if p.is(next, &Tok::Pct) && matches!(k.kind, "body_fat" | "spo2") {
                            next += 1;
                        }
                        if k.kind == "pulse" {
                            if p.is(next, &Tok::Slash) && p.is_word(next + 1, &["мин", "min"]) {
                                next += 2;
                            } else if p.is_word(next, &["в", "per", "a"]) && p.is_word(next + 1, &["минуту", "minute"]) {
                                next += 2;
                            }
                        }
                        if k.kind == "temperature" {
                            if p.is(next, &Tok::Deg) {
                                next += 1;
                            }
                            if p.is_word(next, &["c", "с", "цельсия", "celsius"]) {
                                next += 1;
                            } else if p.is_word(next, &["f", "fahrenheit", "фаренгейта"]) {
                                v = (v - 32.0) * 5.0 / 9.0;
                                next += 1;
                            }
                        }
                        (v, 0.0, next)
                    }),
                };
                if let Some((v, v2, mut next)) = got {
                    if k.kind == "water" {
                        next = p.skip_words(next, WATER_NOUN, 2);
                    }
                    let end = push_item!(k.kind, v, v2, i, next);
                    if let (Some(m), Some(it)) = (kw_minute, items.last_mut()) {
                        if it.minute.is_none() {
                            it.minute = Some(m);
                        }
                    }
                    // «120/80/65», «120 на 80, пульс не назван»: третье число через косую — пульс
                    if k.kind == "pressure" && end == next && p.is(next, &Tok::Slash) {
                        if let Some((pulse, _)) = p.num(next + 1) {
                            let _ = push_item!("pulse", pulse, 0.0, next, next + 2);
                            i = next + 2;
                            continue;
                        }
                    }
                    i = end;
                    continue;
                }
                // «выпила воды 300 мл», «чувствую…» без оценки: слово-глагол не мусор, значение возьмёт следующее
                if any(w, &["выпил", "выпила", "попил", "попила", "drank", "drink", "чувствую", "feeling", "feel", "rate", "bpm"]) {
                    p.noise[i] = true;
                }
                i += 1;
                continue;
            }
            // «стакан воды», «бутылку воды» без числа и глагола
            if let Some(ml) = container(w) {
                let next = p.skip_words(i + 1, WATER_NOUN, 2);
                if next > i + 1 {
                    i = push_item!("water", ml, 0.0, i, next);
                    continue;
                }
            }
            // Время словом перед записью: «утром вес 72», «после обеда 120/80»
            if let Some(m) = fuzzy_time(w) {
                pending_time = Some((m, i, i + 1));
                i += 1;
                continue;
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
                p.noise[i] = true;
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
        // ── число без ключевого слова ──
        if let Some(a) = p.num(i).map(|(v, _)| v) {
            // давление «120/80» и «120/80/65»
            if p.is(i + 1, &Tok::Slash) {
                if let Some((b, _)) = p.num(i + 2) {
                    let third = if p.is(i + 3, &Tok::Slash) { p.num(i + 4).map(|(v, _)| v) } else { None };
                    let end = push_item!("pressure", a, b, i, i + 3);
                    if let (Some(pulse), true) = (third, end == i + 3) {
                        i = push_item!("pulse", pulse, 0.0, i + 3, i + 5);
                    } else {
                        i = end;
                    }
                    continue;
                }
            }
            // «125 на 82», «120 over 80» — давление без ключевого слова, если числа на него похожи
            if p.is_word(i + 1, &["на", "over"]) {
                if let Some((b, _)) = p.num(i + 2).filter(|(b, _)| (70.0..=260.0).contains(&a) && (40.0..=150.0).contains(b) && a > *b) {
                    i = push_item!("pressure", a, b, i, i + 3);
                    continue;
                }
            }
            // «18% жира», «97% кислорода»
            if p.is(i + 1, &Tok::Pct) {
                if let Some(k) = p.word(i + 2).and_then(keyword).filter(|k| k.unit == "pct") {
                    i = push_item!(k.kind, a, 0.0, i, i + 3);
                    continue;
                }
            }
            // «36,6°», «98.6°F»
            if p.is(i + 1, &Tok::Deg) {
                let (v, next) = if p.is_word(i + 2, &["f"]) { ((a - 32.0) * 5.0 / 9.0, i + 3) } else if p.is_word(i + 2, &["c", "с"]) { (a, i + 3) } else { (a, i + 2) };
                i = push_item!("temperature", v, 0.0, i, next);
                continue;
            }
            // «8 000 шагов», «8к шагов», «72 кг», «2 стакана воды», «72 и 4 кг»
            let steps_ahead = |from: usize| p.word(from).and_then(unit_after_number).is_some_and(|(k, _)| k == "steps");
            let (v, j) = match p.count(i, true).filter(|(_, next)| steps_ahead(*next)) {
                Some(c) => c,
                None => p.number(i).unwrap_or((a, i + 1)),
            };
            if let Some((kind, mul)) = p.word(j).and_then(unit_after_number) {
                let mut next = j + 1;
                if kind == "water" {
                    next = p.skip_words(next, WATER_NOUN, 2);
                }
                if kind == "pulse" {
                    if p.is(next, &Tok::Slash) && p.is_word(next + 1, &["мин", "min"]) {
                        next += 2;
                    } else if p.is_word(next, &["в", "per", "a"]) && p.is_word(next + 1, &["минуту", "minute"]) {
                        next += 2;
                    }
                }
                let value = if kind == "weight" { v * mul } else { (v * mul * 10.0).round() / 10.0 };
                i = push_item!(kind, value, 0.0, i, next);
                continue;
            }
        }
        i += 1;
    }

    // «верхнее 120, нижнее 80» — одна запись давления
    match (sys, dia) {
        (Some((a, from, _)), Some((b, _, to))) => items.push(Item { kind: "pressure", value: a, value2: b, unit: "mmhg", minute: None, lead: None, day: cur_day, from: from.min(to), to: to.max(from + 2) }),
        (Some((_, from, to)), None) | (None, Some((_, from, to))) => {
            for u in p.used.iter_mut().take(to).skip(from) {
                *u = false;
            }
        }
        (None, None) => {}
    }

    // Время, сказанное перед записью, — первой записи без времени после него
    if let Some((m, from, to)) = pending_time {
        if let Some(it) = items.iter_mut().find(|it| it.minute.is_none() && it.from >= from) {
            it.minute = Some(m);
            p.mark(from, to);
        }
    }
    // Время прямо перед записью («в 8:30 вес 72, утром пульс 60»): привязка по соседству
    for idx in 0..items.len() {
        let Some(it) = items.get(idx) else { continue };
        if it.minute.is_some() {
            continue;
        }
        let from = it.from;
        let mut k = from;
        while k > 0 && p.toks.get(k - 1).is_some_and(|l| !matches!(l.tok, Tok::Sep)) && !p.used.get(k - 1).copied().unwrap_or(true) {
            k -= 1;
        }
        // Самое близкое к записи время: пробуем от ближайшей лексемы к дальней
        for start in (k..from).rev() {
            if let Some((m, after)) = p.point_time(start).or_else(|| p.clock(start, false).map(|c| (c.minute, c.next))) {
                if after == from {
                    if let Some(it) = items.get_mut(idx) {
                        it.minute = Some(m);
                    }
                    p.mark(start, from);
                    break;
                }
            }
        }
    }

    // ── записи-моменты ──
    for it in &items {
        if kind_of(it.kind).is_none() {
            continue;
        }
        if !in_range(it.kind, it.value, it.value2) {
            res.problems.push(Problem { text: p.slice(it.from, it.to), code: "range" });
            continue;
        }
        let day = it.day.unwrap_or(today);
        let at_ms = match it.minute.or(it.lead) {
            // «вес 72 в 23:00», сказанное утром, — это вчерашний вечер
            Some(m) if it.day.is_none() && local_ms(day, m, tz_min) > now_ms + FUTURE_SLACK_MS => local_ms(day - 1, m, tz_min),
            Some(m) => local_ms(day, m, tz_min),
            None if day == today => now_ms,
            None => local_ms(day, 720, tz_min),
        };
        res.entries.push(Parsed { kind: it.kind, at_ms, end_ms: 0, value: it.value, value2: it.value2, unit: it.unit, ..Default::default() });
    }

    // ── еда и тренировки: день — названный во фразе, иначе общий для строки ──
    for f in found {
        let day = f.day.or(cur_day).unwrap_or(today);
        let at_ms = match f.minute {
            Some(m) if f.day.or(cur_day).is_none() && local_ms(day, m, tz_min) > now_ms + FUTURE_SLACK_MS => local_ms(day - 1, m, tz_min),
            Some(m) => local_ms(day, m, tz_min),
            None if day == today => now_ms,
            None => local_ms(day, 720, tz_min),
        };
        let tag = if f.kind == KIND_FOOD && f.tag.is_empty() { meal_by_minute(minute_of_day(at_ms, tz_min)) } else { f.tag };
        res.entries.push(Parsed { kind: f.kind, at_ms, value: f.value, unit: f.unit, name: f.name, tag, parts: f.parts, guess: f.guess, computed: f.computed, ..Default::default() });
    }

    // ── сон ──
    let sleep_day = cur_day.filter(|_| sleep_span.is_some());
    let day = sleep_day.unwrap_or(today);
    let span_text = sleep_span.map(|(a, b)| p.slice(a, b)).unwrap_or_default();
    let late = |t: i64| sleep_day.is_none() && t > now_ms + FUTURE_SLACK_MS;
    match (bed, wake, sleep_dur) {
        (Some(b), Some(w), _) => {
            // «лёг вчера в 23, встал в 7»: день назван для «лёг», а встал — на следующий
            let day = match (bed_ref, wake_ref) {
                (Some(x), Some(y)) if x == y && bed_first && b >= w => x + 1,
                (_, Some(y)) => y,
                (Some(x), None) => if b >= w { x + 1 } else { x },
                (None, None) => today,
            };
            let mut end = local_ms(day, w, tz_min);
            let mut start = if b >= w { local_ms(day - 1, b, tz_min) } else { local_ms(day, b, tz_min) };
            if late(end) {
                end -= DAY_MS;
                start -= DAY_MS;
            }
            let minutes = ((end - start) / MIN_MS) as f64;
            if sleep_in_range(minutes) {
                res.entries.push(Parsed { kind: "sleep", at_ms: start, end_ms: end, value: minutes, value2: 0.0, unit: "min", ..Default::default() });
            } else {
                res.problems.push(Problem { text: span_text, code: "range" });
            }
        }
        (Some(b), None, None) => {
            let mut t = local_ms(day, b, tz_min);
            if late(t) {
                t -= DAY_MS;
            }
            res.entries.push(Parsed { kind: "sleep_start", at_ms: t, end_ms: 0, value: 0.0, value2: 0.0, unit: "", ..Default::default() });
        }
        (None, Some(w), None) => {
            let mut t = local_ms(day, w, tz_min);
            if late(t) {
                t -= DAY_MS;
            }
            res.entries.push(Parsed { kind: "sleep_end", at_ms: t, end_ms: 0, value: 0.0, value2: 0.0, unit: "", ..Default::default() });
        }
        (bed_only, wake_only, Some(d)) => {
            if sleep_in_range(d) {
                match (bed_only, wake_only) {
                    // Длительность и один край: второй край считается
                    (Some(b), None) => {
                        let mut start = local_ms(day, b, tz_min);
                        if b >= 12 * 60 || late(start) {
                            start -= DAY_MS;
                        }
                        res.entries.push(Parsed { kind: "sleep", at_ms: start, end_ms: start + (d as i64) * MIN_MS, value: d, value2: 0.0, unit: "min", ..Default::default() });
                    }
                    (None, Some(w)) => {
                        let mut end = local_ms(day, w, tz_min);
                        if late(end) {
                            end -= DAY_MS;
                        }
                        res.entries.push(Parsed { kind: "sleep", at_ms: end - (d as i64) * MIN_MS, end_ms: end, value: d, value2: 0.0, unit: "min", ..Default::default() });
                    }
                    // Только длительность: запись-момент на начало дня, время сна неизвестно
                    _ => res.entries.push(Parsed { kind: "sleep", at_ms: local_ms(day, 0, tz_min), end_ms: 0, value: d, value2: 0.0, unit: "min", ..Default::default() }),
                }
            } else {
                res.problems.push(Problem { text: span_text, code: "range" });
            }
        }
        (None, None, None) => {
            // Слово о сне без времени — неразобранное
            for a in &sleep_marks {
                if let Some(u) = p.used.get_mut(*a) {
                    *u = false;
                }
            }
        }
    }
    res.entries.sort_by(|a, b| a.at_ms.cmp(&b.at_ms).then(a.kind.cmp(b.kind)));

    // ── неразобранное: подряд идущие неиспользованные лексемы одним куском; служебные слова внутри куска
    //    сохраняются, по краям — отбрасываются ──
    let free = |k: usize| !p.used.get(k).copied().unwrap_or(true) && !p.is(k, &Tok::Sep);
    let solid = |k: usize| free(k) && !p.noise.get(k).copied().unwrap_or(false);
    let mut k = 0;
    while k < n {
        if !solid(k) {
            k += 1;
            continue;
        }
        let from = k;
        let mut last = k;
        while k < n && free(k) {
            if solid(k) {
                last = k;
            }
            k += 1;
        }
        let piece = p.slice(from, last + 1);
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
            if e.guess {
                o["guess"] = json!(true);
            }
            if e.computed {
                o["computed"] = json!(true);
            }
            if !e.name.is_empty() {
                o["name"] = json!(e.name);
            }
            if !e.tag.is_empty() {
                o["tag"] = json!(e.tag);
            }
            if !e.parts.is_empty() {
                o["parts"] = Value::Object(e.parts.iter().map(|(k, v)| (k.to_string(), json!(v))).collect());
            }
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
