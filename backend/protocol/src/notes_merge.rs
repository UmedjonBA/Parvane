//! Сведение текста заметки, правленной на двух устройствах (spec 040 T9, правило NOTES-2): построчное
//! трёхстороннее слияние с общей версией. Правки разных мест складываются, одинаковые берутся один раз; одно
//! место, изменённое по-разному, — расхождение: его решает человек на экране «Заметку изменили на двух
//! устройствах» (оставить мою строку, их строку или обе). Общий образец — `conformance/notes-merge/cases.json`
//! (его же проверяет web). Вызовы без состояния: `notesMerge`, `notesMergeResolve`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Таблица сравнения растёт как произведение длин; больше — тексты не сравниваются построчно (одно расхождение
/// на весь текст).
const MAX_DIFF_CELLS: usize = 4_000_000;

/// Участок сведённого текста: общий либо расхождение.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Part {
    /// Строки, сведённые сами (общие и принятые правки одной стороны)
    Text { text: Vec<String> },
    /// Одно место изменено по-разному. `line` — номер первой строки в моей версии (с 1)
    Conflict { base: Vec<String>, mine: Vec<String>, theirs: Vec<String>, line: usize },
}

/// Выбор в расхождении.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Mine,
    Theirs,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    /// Сведённый текст; при расхождении — моя версия целиком (до решения человека)
    pub text: String,
    pub conflict: bool,
    /// Участки по порядку — только при расхождении
    pub parts: Vec<Part>,
    /// Сколько строк правок сведено само (для подписи «остальные правки объединены сами»)
    pub auto_lines: usize,
}

#[derive(Deserialize)]
struct Input {
    #[serde(default)]
    base: String,
    #[serde(default)]
    mine: String,
    #[serde(default)]
    theirs: String,
    #[serde(default)]
    choices: Vec<Choice>,
}

/// `notesMerge`: `{base, mine, theirs}` → `Merged`; `None` — вход не разобран.
pub fn merge_json(args: &Value) -> Option<Value> {
    let input = Input::deserialize(args).ok()?;
    serde_json::to_value(merge(&input.base, &input.mine, &input.theirs)).ok()
}

/// `notesMergeResolve`: `{base, mine, theirs, choices}` → `{text}`: расхождения решены по выбору (не задан — моя).
pub fn resolve_json(args: &Value) -> Option<Value> {
    let input = Input::deserialize(args).ok()?;
    Some(serde_json::json!({ "text": resolve(&input.base, &input.mine, &input.theirs, &input.choices) }))
}

/// Свести три версии.
pub fn merge(base: &str, mine: &str, theirs: &str) -> Merged {
    let base = normalize_eol(base);
    let mine = normalize_eol(mine);
    let theirs = normalize_eol(theirs);
    let clean = |text: &str| Merged { text: text.to_string(), conflict: false, parts: Vec::new(), auto_lines: 0 };
    if mine == theirs || theirs == base {
        return clean(&mine);
    }
    if mine == base {
        return clean(&theirs);
    }
    let parts = merge_parts(&split_lines(&base), &split_lines(&mine), &split_lines(&theirs));
    let conflict = parts.parts.iter().any(|part| matches!(part, Part::Conflict { .. }));
    if conflict {
        return Merged { text: mine.clone(), conflict, parts: parts.parts, auto_lines: parts.auto_lines };
    }
    let lines: Vec<String> = parts.parts.into_iter().flat_map(|part| match part {
        Part::Text { text } => text,
        Part::Conflict { mine, .. } => mine,
    }).collect();
    Merged { text: join_lines(&lines, mine.ends_with('\n')), conflict: false, parts: Vec::new(), auto_lines: parts.auto_lines }
}

/// Текст с решёнными расхождениями.
pub fn resolve(base: &str, mine: &str, theirs: &str, choices: &[Choice]) -> String {
    let merged = merge(base, mine, theirs);
    if !merged.conflict {
        return merged.text;
    }
    let mine = normalize_eol(mine);
    let mut at = 0;
    let mut lines = Vec::new();
    for part in merged.parts {
        match part {
            Part::Text { text } => lines.extend(text),
            Part::Conflict { mine, theirs, .. } => {
                let choice = choices.get(at).copied().unwrap_or(Choice::Mine);
                at += 1;
                match choice {
                    Choice::Mine => lines.extend(mine),
                    Choice::Theirs => lines.extend(theirs),
                    Choice::Both => {
                        lines.extend(mine);
                        lines.extend(theirs);
                    }
                }
            }
        }
    }
    join_lines(&lines, mine.ends_with('\n'))
}

struct Parts {
    parts: Vec<Part>,
    auto_lines: usize,
}

fn merge_parts(base: &[String], mine: &[String], theirs: &[String]) -> Parts {
    let (Some(mine_match), Some(theirs_match)) = (match_lines(base, mine), match_lines(base, theirs)) else {
        // Слишком большие тексты: одно расхождение на всё
        let whole = Part::Conflict { base: base.to_vec(), mine: mine.to_vec(), theirs: theirs.to_vec(), line: 1 };
        return Parts { parts: vec![whole], auto_lines: 0 };
    };
    let mut parts: Vec<Part> = Vec::new();
    let mut auto_lines = 0;
    let mut push_text = |parts: &mut Vec<Part>, lines: &[String]| {
        if lines.is_empty() {
            return;
        }
        if let Some(Part::Text { text }) = parts.last_mut() {
            text.extend_from_slice(lines);
        } else {
            parts.push(Part::Text { text: lines.to_vec() });
        }
    };
    let (mut base_at, mut mine_at, mut theirs_at) = (0, 0, 0);
    while base_at < base.len() || mine_at < mine.len() || theirs_at < theirs.len() {
        // Общий участок: строки основы стоят на своих местах у обеих сторон
        let mut stable = 0;
        while base_at + stable < base.len()
            && mine_match[base_at + stable] == Some(mine_at + stable)
            && theirs_match[base_at + stable] == Some(theirs_at + stable)
        {
            stable += 1;
        }
        if stable > 0 {
            push_text(&mut parts, &base[base_at..base_at + stable]);
            base_at += stable;
            mine_at += stable;
            theirs_at += stable;
            continue;
        }
        // Изменённый участок тянется до ближайшей строки основы, уцелевшей у обеих сторон
        let mut base_end = base_at;
        while base_end < base.len() && (mine_match[base_end].is_none() || theirs_match[base_end].is_none()) {
            base_end += 1;
        }
        let (mine_end, theirs_end) = if base_end < base.len() {
            (mine_match[base_end].unwrap_or(mine.len()), theirs_match[base_end].unwrap_or(theirs.len()))
        } else {
            (mine.len(), theirs.len())
        };
        let base_part = &base[base_at..base_end];
        let mine_part = &mine[mine_at..mine_end];
        let theirs_part = &theirs[theirs_at..theirs_end];
        if theirs_part == base_part || mine_part == theirs_part {
            push_text(&mut parts, mine_part);
            if mine_part != base_part {
                auto_lines += mine_part.len().max(base_part.len());
            }
        } else if mine_part == base_part {
            push_text(&mut parts, theirs_part);
            auto_lines += theirs_part.len().max(base_part.len());
        } else {
            parts.push(Part::Conflict {
                base: base_part.to_vec(),
                mine: mine_part.to_vec(),
                theirs: theirs_part.to_vec(),
                line: mine_at + 1,
            });
        }
        base_at = base_end;
        mine_at = mine_end;
        theirs_at = theirs_end;
    }
    Parts { parts, auto_lines }
}

fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Завершающий перевод строки — не отдельная пустая строка.
fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n').unwrap_or(text).split('\n').map(str::to_string).collect()
}

fn join_lines(lines: &[String], has_final_eol: bool) -> String {
    let mut text = lines.join("\n");
    if has_final_eol && !lines.is_empty() {
        text.push('\n');
    }
    text
}

/// Наибольшая общая подпоследовательность строк: для каждой строки `from` — номер парной строки в `to`.
/// Слишком большие тексты не сравниваются — `None`.
fn match_lines(from: &[String], to: &[String]) -> Option<Vec<Option<usize>>> {
    let mut matched = vec![None; from.len()];
    let mut head = 0;
    while head < from.len() && head < to.len() && from[head] == to[head] {
        matched[head] = Some(head);
        head += 1;
    }
    let mut tail = 0;
    while tail < from.len() - head && tail < to.len() - head && from[from.len() - 1 - tail] == to[to.len() - 1 - tail] {
        matched[from.len() - 1 - tail] = Some(to.len() - 1 - tail);
        tail += 1;
    }
    let rows = from.len() - head - tail;
    let columns = to.len() - head - tail;
    if rows == 0 || columns == 0 {
        return Some(matched);
    }
    if rows.saturating_mul(columns) > MAX_DIFF_CELLS {
        return None;
    }
    // `lengths[row * width + column]` — длина общей части хвостов `from[head + row…]` и `to[head + column…]`
    let width = columns + 1;
    let mut lengths = vec![0u32; (rows + 1) * width];
    for row in (0..rows).rev() {
        for column in (0..columns).rev() {
            lengths[row * width + column] = if from[head + row] == to[head + column] {
                lengths[(row + 1) * width + column + 1] + 1
            } else {
                lengths[(row + 1) * width + column].max(lengths[row * width + column + 1])
            };
        }
    }
    let (mut row, mut column) = (0, 0);
    while row < rows && column < columns {
        if from[head + row] == to[head + column] {
            matched[head + row] = Some(head + column);
            row += 1;
            column += 1;
        } else if lengths[(row + 1) * width + column] >= lengths[row * width + column + 1] {
            row += 1;
        } else {
            column += 1;
        }
    }
    Some(matched)
}
