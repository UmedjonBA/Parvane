//! Разбор еды и тренировок в строке «Здоровья» (HEALTH-2): проход до основного разбора, занятые лексемы
//! основной разбор пропускает.
//!
//! Еда: «завтрак овсянка, яйцо, кофе 430 ккал б 22 ж 14 у 48», «съел гречку с курицей 520 ккал», «на ужин паста»,
//! «творог 200 г 240 ккал». Фраза без слова приёма и без глагола — еда, только если названы калории; со словом
//! приёма хватает БЖУ (калории считаются: 4 · Б + 9 · Ж + 4 · У) либо одного названия в начале фразы; БЖУ словом
//! без названия («белки 140») — тоже еда.
//! Тренировка: «бег 35 минут 6,2 км», «зал 1:20, 6 упражнений», «плавал 40 мин» — нужна длительность либо
//! расстояние. Приём, не названный словом, определяется по времени записи.

use super::{any, fuzzy_time, keyword, stem, unit_after_number, Parser, Problem, Tok, BED, HOUR_UNIT, LEAD_IN, MIN_UNIT, NOISE, SLEEP, WAKE};

pub const KIND_FOOD: &str = "food";
pub const KIND_WORKOUT: &str = "workout";
const MAX_NAME_CHARS: usize = 120;
const MAX_KCAL: f64 = 10_000.0;
const MAX_GRAMS: f64 = 5_000.0;
const MAX_MACRO: f64 = 1_000.0;
const MAX_WORKOUT_MIN: f64 = 1_440.0;
const MAX_KM: f64 = 500.0;
const MAX_EXERCISES: f64 = 200.0;
const MILE_KM: f64 = 1.609_344;

/// Найденная еда либо тренировка: день и время доопределяет основной разбор.
#[derive(Debug, Clone)]
pub(super) struct Found {
    pub kind: &'static str,
    /// Приём пищи (пусто — определить по времени) либо тип тренировки.
    pub tag: &'static str,
    pub name: String,
    pub value: f64,
    pub unit: &'static str,
    pub parts: Vec<(&'static str, f64)>,
    pub minute: Option<u32>,
    pub day: Option<i64>,
    /// Еда без единого числа («на ужин паста»): догадка по слову приёма — чужой ввод («План») ей не верит.
    pub guess: bool,
    /// Калории не названы, а посчитаны из БЖУ: целью питания такое число не становится.
    pub computed: bool,
}

/// Значение записи еды либо тренировки в разумном диапазоне (общая проверка разбора и форм).
pub fn value_in_range(kind: &str, value: f64) -> Option<bool> {
    match kind {
        KIND_FOOD => Some((0.0..=MAX_KCAL).contains(&value)),
        KIND_WORKOUT => Some((0.0..=MAX_WORKOUT_MIN).contains(&value)),
        _ => None,
    }
}

/// Именованное число записи в разумном диапазоне; незнакомое имя диапазона не имеет.
pub fn part_in_range(key: &str, value: f64) -> bool {
    let max = match key {
        "protein" | "fat" | "carbs" | "fiber" => MAX_MACRO,
        "grams" => MAX_GRAMS,
        "km" => MAX_KM,
        "exercises" => MAX_EXERCISES,
        "kcal" => MAX_KCAL,
        _ => return true,
    };
    (0.0..=max).contains(&value)
}

/// Приём пищи по времени суток (минуты от полуночи).
pub fn meal_by_minute(minute: u32) -> &'static str {
    match minute / 60 {
        0..=10 => "breakfast",
        11..=15 => "lunch",
        16..=21 => "dinner",
        _ => "snack",
    }
}

/// Слово приёма пищи в любом падеже: «завтрак», «на обед», «после ужина».
fn meal_word(word: &str) -> Option<&'static str> {
    if stem(word, &["завтрак"]) || word == "breakfast" {
        Some("breakfast")
    } else if any(word, &["обед", "обеда", "обедом", "обеду", "lunch"]) {
        Some("lunch")
    } else if any(word, &["ужин", "ужина", "ужином", "ужину", "dinner", "supper"]) {
        Some("dinner")
    } else if stem(word, &["перекус"]) || any(word, &["snack", "полдник"]) {
        Some("snack")
    } else {
        None
    }
}

/// Слово приёма в именительном падеже: с него фраза о еде может начинаться и без калорий.
fn meal_nominative(word: &str) -> bool {
    any(word, &["завтрак", "обед", "ужин", "перекус", "полдник", "breakfast", "lunch", "dinner", "supper", "snack"])
}

/// Глагол «съел»: приём определяется по времени, кроме «позавтракал» и подобных.
fn eat_verb(word: &str) -> Option<&'static str> {
    if stem(word, &["позавтракал"]) {
        Some("breakfast")
    } else if stem(word, &["пообедал"]) {
        Some("lunch")
    } else if stem(word, &["поужинал"]) {
        Some("dinner")
    } else if stem(word, &["перекусил"]) {
        Some("snack")
    } else if any(word, &["съел", "съела", "поел", "поела", "ел", "ела", "скушал", "скушала", "ate", "eaten", "eat"]) {
        Some("")
    } else {
        None
    }
}

fn kcal_unit(word: &str) -> bool {
    any(word, &["ккал", "кал", "kcal", "cal", "cals", "calories", "calorie"]) || stem(word, &["калори", "килокалори"])
}

fn gram_unit(word: &str) -> bool {
    any(word, &["г", "гр", "g", "gr", "gram", "grams"]) || stem(word, &["грамм"])
}

fn macro_word(word: &str) -> Option<&'static str> {
    if any(word, &["б", "белок", "белка", "белки", "белков", "protein", "proteins", "p"]) {
        Some("protein")
    } else if any(word, &["ж", "жир", "жира", "жиры", "жиров", "fat", "fats", "f"]) {
        Some("fat")
    } else if any(word, &["у", "угл", "carbs", "carb", "c"]) || stem(word, &["углевод"]) {
        Some("carbs")
    } else if stem(word, &["клетчатк"]) || any(word, &["fiber", "fibre"]) {
        Some("fiber")
    } else {
        None
    }
}

/// Тип тренировки по названию записи «Плана» (spec 041 E1, «Активность» «Здоровья»): первое слово тренировки в
/// названии; регистр и «ё» не различаются.
pub fn workout_tag_of(name: &str) -> Option<&'static str> {
    name.to_lowercase().replace('ё', "е").split(|c: char| !c.is_alphanumeric()).find_map(workout_word)
}

/// Слово тренировки → тип. «walked» сюда не входит: «walked 8000 steps» — это шаги.
fn workout_word(word: &str) -> Option<&'static str> {
    if any(word, &["бег", "бегал", "бегала", "побегал", "побегала", "пробежал", "пробежала", "run", "ran", "running", "jog", "jogging", "jogged"]) || stem(word, &["пробежк"]) {
        Some("run")
    } else if stem(word, &["ходьб", "прогулк"]) || any(word, &["гулял", "гуляла", "погулял", "погуляла", "walk", "walking", "hike", "hiked", "hiking"]) {
        Some("walk")
    } else if stem(word, &["велосипед", "велик"]) || any(word, &["вело", "велотренажер", "bike", "biking", "cycling", "cycled"]) {
        Some("bike")
    } else if stem(word, &["плава", "бассейн"]) || any(word, &["плавал", "плавала", "проплыл", "проплыла", "swim", "swam", "swimming"]) {
        Some("swim")
    } else if stem(word, &["йог"]) || word == "yoga" {
        Some("yoga")
    } else if stem(word, &["качалк", "силов"]) || any(word, &["зал", "зале", "gym", "strength", "weights", "lifting"]) {
        Some("strength")
    } else if stem(word, &["трениров", "зарядк", "растяжк"]) || any(word, &["кардио", "workout", "training", "cardio", "stretching", "hiit"]) {
        Some("other")
    } else {
        None
    }
}

impl Parser<'_> {
    fn free(&self, i: usize) -> bool {
        i < self.toks.len() && !self.used.get(i).copied().unwrap_or(true)
    }

    /// Разделитель в позиции: `Some(true)` — запятая (перечисление внутри названия), `Some(false)` — конец фразы.
    fn sep(&self, i: usize) -> Option<bool> {
        let l = self.toks.get(i).filter(|l| l.tok == Tok::Sep)?;
        Some(self.text.get(l.start..l.end) == Some(","))
    }

    /// Целое с разделителем тысяч пробелом: «1 420».
    fn amount(&self, i: usize) -> Option<(f64, usize)> {
        let (v, raw) = self.num(i)?;
        if let Some((g, graw)) = self.num(i + 1) {
            if graw.len() == 3 && !graw.contains('.') && !raw.contains('.') && (1.0..1000.0).contains(&v) {
                return Some((v * 1000.0 + g, i + 2));
            }
        }
        Some((v, i + 1))
    }

    /// «430 ккал» либо «ккал 430» с позиции `i`.
    fn kcal_at(&self, i: usize) -> Option<(f64, usize)> {
        if let Some((v, next)) = self.amount(i) {
            return self.word(next).filter(|w| kcal_unit(w)).map(|_| (v, next + 1));
        }
        let (v, next) = self.word(i).filter(|w| kcal_unit(w)).and_then(|_| self.amount(i + 1))?;
        Some((v, next))
    }

    /// «б 22», «белки 22 г», «22 г белка» с позиции `i`.
    fn macro_at(&self, i: usize) -> Option<(&'static str, f64, usize)> {
        if let Some(key) = self.word(i).and_then(macro_word) {
            let (v, _) = self.num(i + 1)?;
            let next = if self.word(i + 2).is_some_and(gram_unit) { i + 3 } else { i + 2 };
            return Some((key, v, next));
        }
        let (v, _) = self.num(i)?;
        let at = if self.word(i + 1).is_some_and(gram_unit) { i + 2 } else { i + 1 };
        // Одна буква после числа — не БЖУ («22 у» ничего не значит, «5 c» — градусы)
        let key = self.word(at).filter(|w| w.chars().count() > 1).and_then(macro_word)?;
        Some((key, v, at + 1))
    }

    /// «200 г» — вес порции.
    fn grams_at(&self, i: usize) -> Option<(f64, usize)> {
        let (v, _) = self.num(i)?;
        self.word(i + 1).filter(|w| gram_unit(w)).map(|_| (v, i + 2))
    }

    /// Показатель с числом («вес 72», «пульс 64»): такое слово названием еды не бывает.
    fn measurement_at(&self, i: usize) -> bool {
        let Some(w) = self.word(i) else { return false };
        if any(w, BED) || any(w, WAKE) || any(w, SLEEP) {
            return true;
        }
        keyword(w).is_some() && self.num(i + 1).is_some() && self.kcal_at(i + 1).is_none()
    }

    /// Время записи «в 8:30» с позиции `i`.
    fn at_clock(&self, i: usize) -> Option<(u32, usize)> {
        if !self.is_word(i, &["в", "во", "at"]) {
            return None;
        }
        self.clock(i + 1, true).map(|c| (c.minute, c.next))
    }

    /// День и время, сказанные прямо перед фразой: «вчера вечером», «в 8:30», «утром». Возвращает начало куска.
    fn lead_before(&self, from: usize, today: i64) -> (usize, Option<i64>, Option<u32>) {
        let (mut start, mut day, mut minute) = (from, None, None);
        for _ in 0..3 {
            let mut moved = false;
            for back in 1..=3 {
                let Some(k) = start.checked_sub(back).filter(|k| self.free(*k)) else { break };
                if day.is_none() {
                    if let Some((d, next)) = self.day_at(k, today).filter(|(_, next)| *next == start) {
                        (day, start, moved) = (Some(d), k, true);
                        let _ = next;
                        break;
                    }
                }
                if minute.is_none() {
                    let time = self.at_clock(k).or_else(|| match self.toks.get(k).map(|l| &l.tok) {
                        Some(Tok::Time(t)) => Some((*t, k + 1)),
                        Some(Tok::Word(w)) if meal_word(w).is_none() => fuzzy_time(w).map(|m| (m, k + 1)),
                        _ => None,
                    });
                    if let Some((m, _)) = time.filter(|(_, next)| *next == start) {
                        (minute, start, moved) = (Some(m), k, true);
                        break;
                    }
                }
            }
            if !moved {
                break;
            }
        }
        (start, day, minute)
    }

    fn food_at(&self, i: usize, today: i64, problems: &mut Vec<Problem>) -> Option<(Found, usize, usize)> {
        // Фраза может начинаться и с числа: «1 420 ккал»
        let first = self.word(i).unwrap_or("");
        // Предлог перед словом приёма: «на завтрак» — еда, «после обеда» — время
        let lead_end = self.skip_words(i, &["на", "в", "во", "за", "после", "перед", "до", "к", "for", "at", "after", "before"], 2);
        let soft_lead = (i..lead_end).any(|k| !self.is_word(k, &["на", "за", "for"]));
        let trigger = self.word(lead_end).and_then(|w| meal_word(w).map(|tag| (tag, meal_nominative(w))).or_else(|| eat_verb(w).map(|tag| (tag, true))));
        let (mut j, tag, strong) = match trigger {
            Some((tag, nominative)) => (lead_end + 1, tag, nominative && !soft_lead),
            None if lead_end > i => return None,
            None => (i, "", false),
        };
        if trigger.is_none() && (self.measurement_at(i) || fuzzy_time(first).is_some() || workout_word(first).is_some() || self.day_at(i, today).is_some()) {
            return None;
        }
        let mut minute = None;
        if let Some((m, next)) = self.at_clock(j) {
            (minute, j) = (Some(m), next);
        }
        // ── название: слова и перечисление через запятую до калорий, БЖУ либо другого факта ──
        let name_from = j;
        let mut name_to = j;
        while self.free(j) {
            if self.kcal_at(j).is_some() || self.macro_at(j).is_some() || self.grams_at(j).is_some() || self.at_clock(j).is_some() {
                break;
            }
            let keep = match self.toks.get(j).map(|l| &l.tok) {
                Some(Tok::Word(w)) => !self.measurement_at(j) && meal_word(w).is_none() && eat_verb(w).is_none() && workout_word(w).is_none() && self.day_at(j, today).is_none(),
                Some(Tok::Num { .. }) => self.word(j + 1).and_then(unit_after_number).is_none() && !self.is(j + 1, &Tok::Slash) && self.day_at(j, today).is_none(),
                Some(Tok::Dash) => true,
                // Запятая — перечисление, если за ней снова название
                Some(Tok::Sep) => self.sep(j) == Some(true) && self.word(j + 1).is_some_and(|w| !self.measurement_at(j + 1) && meal_word(w).is_none() && workout_word(w).is_none() && self.day_at(j + 1, today).is_none()),
                _ => false,
            };
            if !keep {
                break;
            }
            j += 1;
            if !matches!(self.toks.get(j - 1).map(|l| &l.tok), Some(Tok::Sep | Tok::Dash)) {
                name_to = j;
            }
        }
        j = name_to.max(name_from);
        // ── калории, БЖУ, граммы в любом порядке ──
        let (mut kcal, mut grams): (Option<f64>, Option<f64>) = (None, None);
        let mut parts: Vec<(&'static str, f64)> = Vec::new();
        loop {
            let at = if self.sep(j) == Some(true) { j + 1 } else { j };
            if !self.free(at) {
                break;
            }
            if let Some((v, next)) = self.kcal_at(at).filter(|_| kcal.is_none()) {
                (kcal, j) = (Some(v), next);
            } else if let Some((key, v, next)) = self.macro_at(at).filter(|(key, ..)| parts.iter().all(|p| p.0 != *key)) {
                parts.push((key, v));
                j = next;
            } else if let Some((v, next)) = self.grams_at(at).filter(|_| grams.is_none()) {
                (grams, j) = (Some(v), next);
            } else if let Some((m, next)) = self.at_clock(at).filter(|_| minute.is_none()) {
                (minute, j) = (Some(m), next);
            } else {
                break;
            }
        }
        // Служебные слова по краям названия не нужны: «съел я гречку», «а потом гречка»
        let (mut a, mut b) = (name_from, name_to);
        while a < b && self.is_word(a, NOISE) {
            a += 1;
        }
        while b > a && self.is_word(b - 1, NOISE) {
            b -= 1;
        }
        let name: String = self.slice(a, b).chars().take(MAX_NAME_CHARS).collect();
        let has_macros = parts.iter().any(|p| p.0 != "fiber");
        let at_start = i == 0 || !self.free(i - 1) || self.sep(i - 1).is_some();
        // «белки 140», «140 г белка» без названия и слова приёма — тоже еда (и цель питания в строке целей); одна
        // буква в начале («б 22») без слова приёма ничего не значит
        let bare_macros = name.is_empty() && has_macros && first.chars().count() != 1 && self.macro_at(i).is_some();
        let accepted = kcal.is_some() || (trigger.is_some() && has_macros) || bare_macros || (strong && at_start && !name.is_empty());
        if !accepted || (trigger.is_none() && name.is_empty() && kcal.is_none() && !bare_macros) {
            return None;
        }
        let (start, day, lead_minute) = self.lead_before(i, today);
        let mut end = j;
        let mut day = day;
        if day.is_none() {
            if let Some((d, next)) = self.day_at(end, today) {
                (day, end) = (Some(d), next);
            }
        }
        let macro_of = |key: &str| parts.iter().find(|p| p.0 == key).map_or(0.0, |p| p.1);
        let value = kcal.unwrap_or_else(|| (macro_of("protein") * 4.0 + macro_of("fat") * 9.0 + macro_of("carbs") * 4.0).round());
        if let Some(g) = grams {
            parts.push(("grams", g));
        }
        if !(1.0..=MAX_KCAL).contains(&value) && (kcal.is_some() || has_macros) || parts.iter().any(|p| !part_in_range(p.0, p.1)) {
            problems.push(Problem { text: self.slice(start, end), code: "range" });
            return Some((Found { kind: "", tag: "", name: String::new(), value: 0.0, unit: "", parts: Vec::new(), minute: None, day: None, guess: false, computed: false }, start, end));
        }
        parts.sort_by(|x, y| x.0.cmp(y.0));
        let guess = kcal.is_none() && !has_macros;
        Some((Found { kind: KIND_FOOD, tag, name, value, unit: "kcal", parts, minute: minute.or(lead_minute), day, guess, computed: kcal.is_none() && has_macros }, start, end))
    }

    /// Длительность тренировки: единица обязательна («35 минут», «1 ч 20», «1:20», «час»).
    fn workout_minutes(&self, i: usize) -> Option<(f64, usize)> {
        let unit_follows = self.num(i).is_some() && self.word(self.skip_words(i + 1, &["a", "an"], 1)).is_some_and(|w| any(w, HOUR_UNIT) || any(w, MIN_UNIT));
        let spoken = matches!(self.toks.get(i).map(|l| &l.tok), Some(Tok::Time(_))) || self.is_word(i, &["час", "часа", "часик", "hour"]);
        if !unit_follows && !spoken {
            // «полтора часа», «7 с половиной часов» — число словами с единицей дальше
            let (_, after) = self.number(i)?;
            if !self.word(after).is_some_and(|w| any(w, HOUR_UNIT) || any(w, MIN_UNIT)) {
                return None;
            }
        }
        self.duration(i)
    }

    fn distance_at(&self, i: usize) -> Option<(f64, usize)> {
        let (v, after) = self.number(i)?;
        let w = self.word(after)?;
        let km = if any(w, &["км", "km", "kms"]) || stem(w, &["километр", "kilomet"]) {
            v
        } else if any(w, &["mi", "mile", "miles"]) || stem(w, &["мил"]) {
            v * MILE_KM
        } else if stem(w, &["метр"]) || any(w, &["meters", "metres"]) {
            v / 1000.0
        } else {
            return None;
        };
        Some(((km * 100.0).round() / 100.0, after + 1))
    }

    fn workout_at(&self, i: usize, today: i64, problems: &mut Vec<Problem>) -> Option<(Found, usize, usize)> {
        let mut tag = self.word(i).and_then(workout_word)?;
        let (mut minutes, mut km, mut exercises, mut minute): (Option<f64>, Option<f64>, Option<f64>, Option<u32>) = (None, None, None, None);
        let mut j = i + 1;
        let mut end = j;
        for _ in 0..16 {
            let at = if self.sep(j) == Some(true) { j + 1 } else { j };
            if !self.free(at) {
                break;
            }
            if let Some((km_value, next)) = self.distance_at(at).filter(|_| km.is_none()) {
                (km, j) = (Some(km_value), next);
            } else if let Some((v, next)) = self.num(at).filter(|_| exercises.is_none()).and_then(|(v, _)| self.word(at + 1).filter(|w| stem(w, &["упражнен", "exercise"])).map(|_| (v, at + 2))) {
                (exercises, j) = (Some(v), next);
            } else if stem(self.word(at).unwrap_or(""), &["упражнен", "exercise"]) && self.num(at + 1).is_some() && exercises.is_none() {
                (exercises, j) = (self.num(at + 1).map(|n| n.0), at + 2);
            } else if self.is_word(at, &["темп", "pace"]) && matches!(self.toks.get(at + 1).map(|l| &l.tok), Some(Tok::Time(_))) {
                // Темп считается из расстояния и времени
                j = at + 2;
            } else if let Some((m, next)) = self.at_clock(at).filter(|_| minute.is_none()) {
                (minute, j) = (Some(m), next);
            } else if let Some((v, next)) = self.workout_minutes(at).filter(|_| minutes.is_none()) {
                (minutes, j) = (Some(v), next);
            } else if let Some((v, next)) = self.workout_minutes(at + 1).filter(|_| minutes.is_none() && self.is_word(at, &["за", "in", "for"])) {
                // «пробежал 5 км за 28 минут»
                (minutes, j) = (Some(v), next);
            } else if let Some(more) = self.word(at).and_then(workout_word).filter(|_| at == j) {
                // «зал силовая», «тренировка бег»: уточнение типа
                if tag == "other" || (tag == "strength" && more != "other") {
                    tag = more;
                }
                j = at + 1;
            } else if at == j && self.word(at).is_some_and(|w| any(w, NOISE) && !any(w, LEAD_IN)) {
                j = at + 1;
                continue;
            } else {
                break;
            }
            end = j;
        }
        if minutes.is_none() && km.is_none() {
            return None;
        }
        let (start, day, lead_minute) = self.lead_before(i, today);
        let mut day = day;
        if day.is_none() {
            if let Some((d, next)) = self.day_at(end, today) {
                (day, end) = (Some(d), next);
            }
        }
        let value = minutes.unwrap_or(0.0);
        let mut parts: Vec<(&'static str, f64)> = Vec::new();
        if let Some(n) = exercises {
            parts.push(("exercises", n));
        }
        if let Some(d) = km {
            parts.push(("km", d));
        }
        let km_ok = km.map_or(true, |d| d > 0.0);
        if !(0.0..=MAX_WORKOUT_MIN).contains(&value) || !km_ok || parts.iter().any(|p| !part_in_range(p.0, p.1)) {
            problems.push(Problem { text: self.slice(start, end), code: "range" });
            return Some((Found { kind: "", tag: "", name: String::new(), value: 0.0, unit: "", parts: Vec::new(), minute: None, day: None, guess: false, computed: false }, start, end));
        }
        Some((Found { kind: KIND_WORKOUT, tag, name: String::new(), value, unit: "min", parts, minute: minute.or(lead_minute), day, guess: false, computed: false }, start, end))
    }
}

/// Найти еду и тренировки и занять их лексемы. Запись с пустым видом — значение вне диапазона (уже в `problems`).
pub(super) fn scan(p: &mut Parser, today: i64, problems: &mut Vec<Problem>) -> Vec<Found> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < p.toks.len() {
        if !p.free(i) || (p.word(i).is_none() && p.kcal_at(i).is_none() && p.macro_at(i).is_none()) {
            i += 1;
            continue;
        }
        let found = p.workout_at(i, today, problems).or_else(|| p.food_at(i, today, problems));
        match found {
            Some((f, from, to)) => {
                p.mark(from, to);
                if !f.kind.is_empty() {
                    out.push(f);
                }
                i = to.max(i + 1);
            }
            None => i += 1,
        }
    }
    out
}
