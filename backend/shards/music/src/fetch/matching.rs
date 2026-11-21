//! Сверка и отбор найденных в сети файлов для «Найти и скачать» (spec 039, этап B).
//!
//! Эталон трека (исполнитель, название, альбом, длительность, пометка «с ненормативной лексикой») приходит из
//! каталога; кандидаты — файлы источников. Здесь решается, какой кандидат — тот самый трек:
//! - оценка = 0,5·название + 0,35·исполнитель + 0,15·бонус (длительность, альбом) − 0,2 за другую версию;
//! - отказ: караоке, минус, кавер, ремикс, изменённая скорость и подобное, если эталон сам не такой; отрывок
//!   вместо трека; исполнитель не тот; файл источника загружен после отсечки этого источника;
//! - русский трек с пометкой «с ненормативной лексикой» берётся в копии, про которую известно, что она не
//!   отредактирована: в названии «без цензуры» либо загружена до даты (`original_before`); такие — первыми;
//! - уверенное совпадение с отрывом от второго берётся само, среднее — на выбор пользователю.
//!
//! Пороги и даты — настройки сервера (`Rules`). Слова и приёмы подобраны по тому, как это устроено в проекте
//! HomeMusic (образец пользователя); код свой.

use std::collections::HashMap;

/// Эталон трека из каталога.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Query {
    pub artist: String,
    pub title: String,
    pub album: String,
    pub duration_secs: u32,
    /// Пометка каталога «с ненормативной лексикой»: `None` — каталог не знает.
    pub explicit: Option<bool>,
}

/// Файл, найденный источником.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub source: String,
    /// Название как в источнике: у видео и перезаливов — «Исполнитель - Название (пометки)».
    pub title: String,
    /// Канал либо автор загрузки.
    pub uploader: String,
    pub duration_secs: u32,
    /// День загрузки (дни от 1970-01-01); `None` — источник не сообщил.
    pub upload_day: Option<i64>,
    pub bitrate_kbps: u32,
    pub explicit: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct Rules {
    pub artist_min: f32,
    pub duration_tolerance_secs: u32,
    pub auto_threshold: f32,
    pub auto_margin: f32,
    pub confirm_threshold: f32,
    /// Загруженное раньше этого дня считается оригиналом до правок.
    pub original_before_day: i64,
    /// Источник → день: файлы источника, загруженные в этот день и позже, не берутся.
    pub uploaded_before_day: HashMap<String, i64>,
    pub reject_words: Vec<String>,
    /// Порядок источников для русской музыки и для остальной.
    pub sources_ru: Vec<String>,
    pub sources_default: Vec<String>,
}

/// 2026-03-01 и 2026-05-01 в днях от эпохи.
const DAY_2026_03_01: i64 = 20_513;
const DAY_2026_05_01: i64 = 20_574;

impl Default for Rules {
    fn default() -> Self {
        let words = ["караоке", "минус", "минусовка", "instrumental", "инструментал", "кавер", "cover", "remix", "ремикс", "slowed", "speed up", "sped up", "nightcore", "8d"];
        Rules {
            artist_min: 0.90,
            duration_tolerance_secs: 3,
            auto_threshold: 0.90,
            auto_margin: 0.05,
            confirm_threshold: 0.65,
            original_before_day: DAY_2026_03_01,
            uploaded_before_day: HashMap::from([("soundcloud".to_string(), DAY_2026_05_01)]),
            reject_words: words.iter().map(|w| w.to_string()).collect(),
            sources_ru: ["soundcloud", "youtube_reupload", "youtube"].iter().map(|s| s.to_string()).collect(),
            sources_default: ["youtube", "soundcloud"].iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Что делать с отобранным списком.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Первый кандидат — тот самый трек: качать без вопросов.
    Auto,
    /// Похожие есть, уверенности нет: показать список.
    Confirm,
    /// Подходящих нет.
    Nothing,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ranked {
    pub candidate: Candidate,
    pub score: f32,
    /// Копия, про которую известно, что она не отредактирована.
    pub trusted_original: bool,
}

const W_TITLE: f32 = 0.5;
const W_ARTIST: f32 = 0.35;
const W_BONUS: f32 = 0.15;
const VERSION_PENALTY: f32 = 0.2;
const SCORE_BUCKET: f32 = 0.05;
const GOOD_BITRATE_KBPS: u32 = 320;
/// Отрывок: файл короче этой доли эталона (либо короче 45 с при эталоне от полутора минут).
const PREVIEW_SHARE: f32 = 0.6;

/// Пометки в скобках, которые версию не меняют: их просто убираем из названия.
const NOISE_MARKS: [&str; 22] = [
    "official", "video", "audio", "lyrics", "lyric", "текст", "клип", "премьера", "hd", "hq", "4k", "remaster", "remastered", "ost", "album version", "original",
    "оригинал", "полная версия", "full", "explicit", "mv", "visualizer",
];
/// Пометки версии → её вид. Разные виды — разные записи одного трека.
const VERSION_KINDS: [(&str, &str); 22] = [
    ("remix", "remix"), ("ремикс", "remix"), ("mix", "remix"), ("live", "live"), ("концерт", "live"), ("лайв", "live"), ("slowed", "tempo"), ("sped up", "tempo"),
    ("speed up", "tempo"), ("nightcore", "tempo"), ("acoustic", "acoustic"), ("акустика", "acoustic"), ("instrumental", "instrumental"), ("инструментал", "instrumental"),
    ("минус", "instrumental"), ("karaoke", "instrumental"), ("караоке", "instrumental"), ("cover", "cover"), ("кавер", "cover"), ("demo", "demo"), ("демо", "demo"),
    ("8d", "tempo"),
];
const UNCENSORED_MARKS: [&str; 4] = ["без цензуры", "uncensored", "нецензур", "без купюр"];
const CENSORED_MARKS: [&str; 4] = ["цензур", "clean", "radio edit", "censored"];

/// Название, приведённое для сравнения.
#[derive(Clone, Debug, Default, PartialEq)]
struct Norm {
    text: String,
    latin: String,
    version: Option<&'static str>,
    uncensored: bool,
    censored: bool,
}

fn fold(s: &str) -> String {
    let lowered = s.to_lowercase().replace('ё', "е");
    let cleaned: String = lowered.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Кириллица латиницей — чтобы «Кино» и «Kino» сравнивались как одно.
fn to_latin(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let t = match c {
            'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'э' => "e", 'ж' => "zh", 'з' => "z", 'и' | 'й' | 'ы' => "i", 'к' => "k", 'л' => "l",
            'м' => "m", 'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t", 'у' => "u", 'ф' => "f", 'х' => "h", 'ц' => "ts", 'ч' => "ch",
            'ш' | 'щ' => "sh", 'ю' => "yu", 'я' => "ya", 'ъ' | 'ь' => "",
            other => {
                out.push(other);
                continue;
            }
        };
        out.push_str(t);
    }
    out
}

fn has_mark(folded: &str, mark: &str) -> bool {
    let padded = format!(" {folded} ");
    padded.contains(&format!(" {mark} ")) || (mark.chars().count() > 5 && folded.contains(mark))
}

fn normalize(raw: &str) -> Norm {
    // Содержимое скобок — пометки: версия, «без цензуры», шум
    let mut main = String::new();
    let mut marks: Vec<String> = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in raw.chars() {
        match c {
            '(' | '[' | '{' => {
                depth += 1;
                if depth == 1 {
                    current.clear();
                    continue;
                }
            }
            ')' | ']' | '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    marks.push(fold(&current));
                    continue;
                }
            }
            _ => {}
        }
        if depth > 0 {
            current.push(c);
        } else {
            main.push(c);
        }
    }
    let whole = fold(raw);
    let uncensored = UNCENSORED_MARKS.iter().any(|m| whole.contains(m));
    let censored = !uncensored && CENSORED_MARKS.iter().any(|m| has_mark(&whole, m));
    // Версия ищется и в скобках, и в хвосте «… - Remix»
    let version = VERSION_KINDS.iter().find(|(mark, _)| marks.iter().any(|m| has_mark(m, mark)) || has_mark(&whole, mark)).map(|(_, kind)| *kind);
    let mut text = fold(&main);
    for word in NOISE_MARKS.iter().chain(UNCENSORED_MARKS.iter()) {
        if has_mark(&text, word) {
            text = fold(&format!(" {text} ").replace(&format!(" {word} "), " "));
        }
    }
    let latin = to_latin(&text);
    Norm { text, latin, version, uncensored, censored }
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            row.push((prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(row[j] + 1));
        }
        prev = row;
    }
    prev[b.len()]
}

/// Сходство строк 0…1: доля несовпавших знаков от длины более длинной строки.
fn ratio(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    1.0 - levenshtein(&ca, &cb) as f32 / ca.len().max(cb.len()) as f32
}

fn sorted_tokens(s: &str) -> String {
    let mut tokens: Vec<&str> = s.split(' ').collect();
    tokens.sort_unstable();
    tokens.join(" ")
}

/// Сходство 0…1: лучшее из прямого и «порядок слов не важен», по исходному написанию и по латинице.
fn similarity(a: &Norm, b: &Norm) -> f32 {
    let pair = |x: &str, y: &str| ratio(x, y).max(ratio(&sorted_tokens(x), &sorted_tokens(y)));
    pair(&a.text, &b.text).max(pair(&a.latin, &b.latin))
}

/// Исполнитель и название кандидата: «Исполнитель - Название» в названии файла либо автор загрузки.
fn split_candidate(c: &Candidate) -> (String, String) {
    for sep in [" - ", " – ", " — "] {
        if let Some((artist, title)) = c.title.split_once(sep) {
            if !artist.trim().is_empty() && !title.trim().is_empty() {
                return (artist.trim().to_string(), title.trim().to_string());
            }
        }
    }
    (c.uploader.trim_end_matches(" - Topic").to_string(), c.title.clone())
}

/// Основной исполнитель без приглашённых: «A feat. B», «A & B», «A, B» → «A».
fn main_artist(s: &str) -> String {
    let folded = fold(s);
    for sep in [" feat ", " ft ", " featuring ", " при участии ", " x ", " и "] {
        if let Some((head, _)) = folded.split_once(sep) {
            return head.to_string();
        }
    }
    s.split([',', '&']).next().map(fold).unwrap_or(folded)
}

pub fn is_russian(q: &Query) -> bool {
    let cyrillic = |s: &str| s.chars().any(|c| ('а'..='я').contains(&c) || ('А'..='Я').contains(&c) || c == 'ё' || c == 'Ё');
    cyrillic(&q.artist) || cyrillic(&q.title)
}

/// Русский трек с пометкой «с ненормативной лексикой»: новые загрузки и официальные копии могут быть отредактированы.
pub fn needs_uncensored(q: &Query) -> bool {
    q.explicit == Some(true) && is_russian(q)
}

/// Порядок источников для этого трека.
pub fn source_order<'a>(q: &Query, rules: &'a Rules) -> &'a [String] {
    if is_russian(q) {
        &rules.sources_ru
    } else {
        &rules.sources_default
    }
}

struct Scored {
    score: f32,
    trusted_original: bool,
    explicit: Option<bool>,
}

fn score_one(q: &Query, qn: &Norm, c: &Candidate, rules: &Rules) -> Option<Scored> {
    let (cand_artist, cand_title) = split_candidate(c);
    let cn = normalize(&cand_title);
    let whole = fold(&c.title);
    // Слова-отказы: только если их нет в самом эталоне (ремикс ищут — ремикс и берут)
    let query_whole = fold(&format!("{} {}", q.artist, q.title));
    if rules.reject_words.iter().any(|w| has_mark(&whole, w) && !has_mark(&query_whole, w)) {
        return None;
    }
    // Отрывок вместо трека
    if q.duration_secs >= 90 && c.duration_secs > 0 && (c.duration_secs < 45 || (c.duration_secs as f32) < q.duration_secs as f32 * PREVIEW_SHARE) {
        return None;
    }
    if let (Some(day), Some(cutoff)) = (c.upload_day, rules.uploaded_before_day.get(&c.source)) {
        if day >= *cutoff {
            return None;
        }
    }
    let title = similarity(qn, &cn);
    let artist = {
        let (a, b) = (normalize(&main_artist(&q.artist)), normalize(&main_artist(&cand_artist)));
        // Исполнитель может стоять и в названии файла целиком («Название — Исполнитель», канал-сборник)
        let in_title = if !a.text.is_empty() && (whole.contains(&a.text) || to_latin(&whole).contains(&a.latin)) { 1.0 } else { 0.0 };
        similarity(&a, &b).max(in_title)
    };
    if artist < rules.artist_min {
        return None;
    }
    let bonus = if q.duration_secs > 0 && c.duration_secs > 0 {
        let diff = q.duration_secs.abs_diff(c.duration_secs);
        if diff <= rules.duration_tolerance_secs {
            1.0
        } else if diff <= 10 {
            0.5
        } else {
            0.0
        }
    } else {
        0.5
    };
    let penalty = if qn.version != cn.version { VERSION_PENALTY } else { 0.0 };
    let score = (W_TITLE * title + W_ARTIST * artist + W_BONUS * bonus - penalty).max(0.0);
    let explicit = c.explicit.or(if cn.uncensored { Some(true) } else if cn.censored { Some(false) } else { None });
    let before_law = c.upload_day.is_some_and(|d| d < rules.original_before_day);
    let trusted_original = cn.uncensored || (explicit != Some(false) && c.source != "youtube_music" && before_law);
    Some(Scored { score, trusted_original, explicit })
}

/// Отобрать и упорядочить кандидатов: лучшие первыми.
pub fn rank(q: &Query, candidates: &[Candidate], rules: &Rules) -> Vec<Ranked> {
    let qn = normalize(&q.title);
    let want_original = needs_uncensored(q);
    let order = source_order(q, rules);
    let mut ranked: Vec<(Ranked, (i64, u8, u8, u8, (u8, i64), usize, usize))> = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, c)| {
            let s = score_one(q, &qn, c, rules)?;
            if s.score < rules.confirm_threshold {
                return None;
            }
            let bucket = -((s.score / SCORE_BUCKET).floor() as i64);
            let original = u8::from(want_original && !s.trusted_original);
            // Чистую версию просят только явно (эталон «без ненормативной лексики»), иначе — исходную
            let explicit = match (q.explicit, s.explicit) {
                (Some(false), Some(false)) | (Some(true) | None, Some(true)) => 0,
                (_, None) => 1,
                _ => 2,
            };
            let bitrate = u8::from(c.bitrate_kbps < GOOD_BITRATE_KBPS);
            let upload = match c.upload_day {
                Some(day) if day < rules.original_before_day => (0, day),
                None => (1, 0),
                Some(day) => (2, day),
            };
            let source = order.iter().position(|s| *s == c.source).unwrap_or(order.len());
            Some((Ranked { candidate: c.clone(), score: (s.score * 1000.0).round() / 1000.0, trusted_original: s.trusted_original }, (bucket, original, explicit, bitrate, upload, source, index)))
        })
        .collect();
    ranked.sort_by(|a, b| a.1.cmp(&b.1));
    ranked.into_iter().map(|(r, _)| r).collect()
}

/// Брать первого без вопросов, показать список либо сказать «не найдено».
pub fn verdict(q: &Query, ranked: &[Ranked], rules: &Rules) -> Verdict {
    let Some(best) = ranked.first() else { return Verdict::Nothing };
    let margin_ok = ranked.get(1).is_none_or(|second| best.score - second.score >= rules.auto_margin || second.candidate.duration_secs.abs_diff(best.candidate.duration_secs) <= rules.duration_tolerance_secs);
    // Нужна копия без правок, а известной такой нет — пусть решает человек
    let original_ok = !needs_uncensored(q) || best.trusted_original;
    if best.score >= rules.auto_threshold && margin_ok && original_ok {
        Verdict::Auto
    } else {
        Verdict::Confirm
    }
}

/// Порог сходства запроса с эталоном, ниже которого «Найти и скачать «запрос»» эталон не берёт.
pub const REFERENCE_MIN: f32 = 0.6;

/// «Найти и скачать «запрос»» (spec 041): какой эталон каталога — то, что человек искал. Сходство строки запроса с
/// «исполнитель название» (порядок слов не важен) либо с одним названием; другая версия (ремикс, live, караоке…),
/// которой в запросе нет, отбрасывается; при равных — порядок каталога. Ниже `REFERENCE_MIN` — эталона нет.
pub fn pick_reference(query: &str, catalog: &[Query]) -> Option<usize> {
    let qn = normalize(query);
    if qn.text.is_empty() {
        return None;
    }
    let mut best: Option<(usize, f32)> = None;
    for (i, c) in catalog.iter().enumerate() {
        let whole = normalize(&format!("{} {}", c.artist, c.title));
        let title = normalize(&c.title);
        if whole.version.is_some() && whole.version != qn.version {
            continue;
        }
        let score = similarity(&qn, &whole).max(similarity(&qn, &title) - 0.05);
        if score >= REFERENCE_MIN && best.is_none_or(|(_, s)| score > s + 1e-6) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_query_picks_reference_from_catalog() {
        let cat = vec![
            query("Lampa", "Ночной автобус (Remix)", 200, None),
            query("Lampa", "Ночной автобус", 222, None),
            query("Другой", "Автобус", 100, None),
        ];
        assert_eq!(pick_reference("lampa ночной автобус", &cat), Some(1), "ремикс без слова «ремикс» в запросе не берётся");
        assert_eq!(pick_reference("ночной автобус", &cat), Some(1), "одно название тоже находит");
        assert_eq!(pick_reference("ночной автобус remix", &cat), Some(0));
        assert_eq!(pick_reference("совсем другое", &cat), None);
        assert_eq!(pick_reference("", &cat), None);
        assert_eq!(pick_reference("kino zvezda", &[query("Кино", "Звезда", 0, None)]), Some(0), "латиница и кириллица — одно");
    }

    fn query(artist: &str, title: &str, secs: u32, explicit: Option<bool>) -> Query {
        Query { artist: artist.into(), title: title.into(), album: String::new(), duration_secs: secs, explicit }
    }

    fn cand(id: &str, source: &str, title: &str, uploader: &str, secs: u32, upload_day: Option<i64>) -> Candidate {
        Candidate { id: id.into(), source: source.into(), title: title.into(), uploader: uploader.into(), duration_secs: secs, upload_day, bitrate_kbps: 128, explicit: None }
    }

    fn ids(ranked: &[Ranked]) -> Vec<&str> {
        ranked.iter().map(|r| r.candidate.id.as_str()).collect()
    }

    #[test]
    fn exact_track_wins_and_is_taken_automatically() {
        let q = query("Kora Mesh", "Glass Harbor", 197, None);
        let rules = Rules::default();
        let ranked = rank(
            &q,
            &[
                cand("live", "youtube", "Kora Mesh - Glass Harbor (Live at Home)", "Kora Mesh", 240, None),
                cand("exact", "youtube", "Kora Mesh - Glass Harbor (Official Audio)", "Kora Mesh", 198, None),
                cand("topic", "youtube", "Glass Harbor", "Kora Mesh - Topic", 197, None),
                cand("other", "youtube", "Some Band - Glass House", "Some Band", 197, None),
            ],
            &rules,
        );
        assert_eq!(ids(&ranked)[..2], ["exact", "topic"], "пометка «Official Audio» версию не меняет; канал «- Topic» — исполнитель");
        assert!(!ids(&ranked).contains(&"other"), "чужой исполнитель отброшен");
        assert!(ranked.iter().find(|r| r.candidate.id == "live").is_none_or(|live| live.score < ranked[0].score - 0.15), "другая версия — со штрафом");
        assert_eq!(verdict(&q, &ranked, &rules), Verdict::Auto);
    }

    #[test]
    fn rejects_covers_remixes_previews_and_late_uploads() {
        let q = query("Тихий порт", "Северный ветер", 245, None);
        let rules = Rules::default();
        let ranked = rank(
            &q,
            &[
                cand("karaoke", "youtube", "Тихий порт - Северный ветер (караоке)", "Караоке клуб", 245, None),
                cand("cover", "youtube", "Северный ветер - кавер на Тихий порт", "Вася", 240, None),
                cand("slowed", "soundcloud", "Тихий порт - Северный ветер slowed", "dj", 300, Some(20_000)),
                cand("preview", "youtube", "Тихий порт - Северный ветер", "Тихий порт", 30, None),
                cand("late", "soundcloud", "Тихий порт - Северный ветер", "Тихий порт", 245, Some(DAY_2026_05_01)),
                cand("ok", "soundcloud", "Тихий порт - Северный ветер", "Тихий порт", 245, Some(DAY_2026_05_01 - 1)),
            ],
            &rules,
        );
        assert_eq!(ids(&ranked), ["ok"]);
        // Ремикс ищут — ремикс и берут
        let remix = query("Тихий порт", "Северный ветер (Remix)", 200, None);
        let found = rank(&remix, &[cand("r", "youtube", "Тихий порт - Северный ветер (Remix)", "x", 200, None)], &rules);
        assert_eq!(ids(&found), ["r"]);
        assert_eq!(verdict(&q, &[], &rules), Verdict::Nothing);
    }

    #[test]
    fn explicit_russian_track_prefers_copies_known_to_be_unedited() {
        let q = query("Полдень", "Первый снег", 178, Some(true));
        let rules = Rules::default();
        assert!(needs_uncensored(&q));
        let ranked = rank(
            &q,
            &[
                cand("official_new", "youtube", "Полдень - Первый снег", "Полдень", 178, Some(DAY_2026_03_01 + 30)),
                cand("clean", "youtube", "Полдень - Первый снег (radio edit)", "Полдень", 178, Some(DAY_2026_03_01 - 400)),
                cand("reupload", "youtube_reupload", "Полдень - Первый снег (без цензуры)", "архив", 178, Some(DAY_2026_03_01 + 60)),
                cand("old", "soundcloud", "Полдень - Первый снег", "Полдень", 178, Some(DAY_2026_03_01 - 200)),
            ],
            &rules,
        );
        // Сначала перезалив с явной пометкой «без цензуры», затем загруженная до даты; новая официальная и
        // «radio edit» — после
        assert_eq!(ids(&ranked)[..2], ["reupload", "old"]);
        assert!(ranked[0].trusted_original && ranked[1].trusted_original);
        assert!(!ranked.iter().find(|r| r.candidate.id == "official_new").unwrap().trusted_original);
        assert!(!ranked.iter().find(|r| r.candidate.id == "clean").unwrap().trusted_original);
        assert_eq!(verdict(&q, &ranked, &rules), Verdict::Auto);
        // Известной неотредактированной копии нет — не качаем молча, спрашиваем
        let only_new = rank(&q, &[cand("official_new", "youtube", "Полдень - Первый снег", "Полдень", 178, Some(DAY_2026_03_01 + 30))], &rules);
        assert_eq!(verdict(&q, &only_new, &rules), Verdict::Confirm);
        // Не русский либо без пометки — правило не действует
        assert!(!needs_uncensored(&query("Kora Mesh", "Static", 100, Some(true))));
        assert!(!needs_uncensored(&query("Полдень", "Первый снег", 178, None)));
    }

    #[test]
    fn source_order_and_transliteration() {
        let rules = Rules::default();
        assert_eq!(source_order(&query("Кино", "Пачка", 0, None), &rules)[0], "soundcloud", "у русской музыки официальный YouTube последний");
        assert_eq!(source_order(&query("Lampa", "Night Bus", 0, None), &rules)[0], "youtube");
        let q = query("Кино", "Звезда", 0, None);
        let ranked = rank(&q, &[cand("lat", "youtube", "Kino - Zvezda", "Kino", 0, None)], &rules);
        assert_eq!(ids(&ranked), ["lat"], "латиница и кириллица сравниваются как одно");
        // Неуверенное совпадение — на выбор
        let fuzzy = rank(&query("Lampa", "Night Bus", 222, None), &[cand("f", "youtube", "Lampa - Night Bus Stop", "Lampa", 260, None)], &rules);
        assert_eq!(verdict(&query("Lampa", "Night Bus", 222, None), &fuzzy, &rules), if fuzzy.is_empty() { Verdict::Nothing } else { Verdict::Confirm });
    }
}
