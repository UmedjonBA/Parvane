//! Списки библиотеки «Музыки» на экранах (spec 041): порядок исполнителей, альбомов и треков, группы по первой
//! букве, отбор по строке, склейка страниц, найденное одним списком, «Загруженное» группами. Правила — здесь, один
//! раз для всех клиентов; клиент передаёт то, что получил от шарда `music` и что лежит на устройстве, и рисует
//! ответ. Вход и выход — JSON (`host::call::call_static`), общий образец — `conformance/music-library/cases.json`.
//!
//! Вызовы: `musicLibrarySort`, `musicLibraryGroups`, `musicLibraryFilter`, `musicPageMerge`, `musicSearchRows`,
//! `musicOfflineGroups`.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Имена вызовов модуля.
pub const NAMES: &[&str] =
    &["musicLibrarySort", "musicLibraryGroups", "musicLibraryFilter", "musicPageMerge", "musicSearchRows", "musicOfflineGroups"];

/// Подпись группы для названий, которые начинаются не с буквы.
const OTHER_LETTER: &str = "#";

/// Вызов по имени; негодный вход либо чужое имя — `None`.
pub fn call(name: &str, args: &Value) -> Option<Value> {
    match name {
        "musicLibrarySort" => sort(args),
        "musicLibraryGroups" => groups(args),
        "musicLibraryFilter" => filter(args),
        "musicPageMerge" => merge_pages(args),
        "musicSearchRows" => search_rows(args),
        "musicOfflineGroups" => offline_groups(&serde_json::from_value(args.clone()).ok()?),
        _ => None,
    }
}

fn items(args: &Value, key: &str) -> Option<Vec<Value>> {
    args.get(key)?.as_array().cloned()
}

fn text<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or("")
}

fn num(item: &Value, key: &str) -> u64 {
    item.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// Ключ сравнения названий: без регистра и начальных артиклей не трогаем — как у музыкального сервера.
fn fold(s: &str) -> String {
    s.trim().to_lowercase()
}

fn by_text(a: &Value, b: &Value, key: &str) -> Ordering {
    fold(text(a, key)).cmp(&fold(text(b, key)))
}

/// Порядок списка: `kind` — `artists` (`by`: `name` | `tracks`), `albums` (`artist` | `title` | `year`),
/// `tracks` (`artist` | `title`). Равные — по `id`, чтобы порядок не зависел от ответа сервера.
fn sort(args: &Value) -> Option<Value> {
    let mut list = items(args, "items")?;
    let by = args.get("by").and_then(Value::as_str).unwrap_or("");
    let kind = args.get("kind").and_then(Value::as_str)?;
    list.sort_by(|a, b| {
        let order = match (kind, by) {
            ("artists", "tracks") => num(b, "trackCount").cmp(&num(a, "trackCount")).then_with(|| by_text(a, b, "name")),
            ("artists", _) => by_text(a, b, "name"),
            ("albums", "title") => by_text(a, b, "title"),
            ("albums", "year") => num(b, "year").cmp(&num(a, "year")).then_with(|| by_text(a, b, "title")),
            ("albums", _) => by_text(a, b, "artist").then_with(|| num(a, "year").cmp(&num(b, "year"))).then_with(|| by_text(a, b, "title")),
            ("tracks", "title") => by_text(a, b, "title").then_with(|| by_text(a, b, "artist")),
            (_, _) => by_text(a, b, "artist")
                .then_with(|| by_text(a, b, "album"))
                .then_with(|| num(a, "trackNo").cmp(&num(b, "trackNo")))
                .then_with(|| by_text(a, b, "title")),
        };
        order.then_with(|| text(a, "id").cmp(text(b, "id")))
    });
    Some(Value::Array(list))
}

/// Буква группы: первая буква или цифра названия заглавной; прочее — `#`.
fn letter_of(name: &str) -> String {
    match name.trim().chars().next() {
        Some(c) if c.is_alphabetic() => c.to_uppercase().collect(),
        _ => OTHER_LETTER.to_string(),
    }
}

/// Группы по первой букве названия (`key`, по умолчанию `name`) в порядке названий: `[{letter, ids}]`.
fn groups(args: &Value) -> Option<Value> {
    let key = args.get("key").and_then(Value::as_str).unwrap_or("name");
    let mut list = items(args, "items")?;
    list.sort_by(|a, b| by_text(a, b, key).then_with(|| text(a, "id").cmp(text(b, "id"))));
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for item in &list {
        let letter = letter_of(text(item, key));
        let id = text(item, "id").to_string();
        match out.iter_mut().find(|(l, _)| *l == letter) {
            Some((_, ids)) => ids.push(id),
            None => out.push((letter, vec![id])),
        }
    }
    // «#» — в конце, как в указателе
    out.sort_by_key(|(l, _)| l == OTHER_LETTER);
    Some(Value::Array(out.into_iter().map(|(letter, ids)| json!({"letter": letter, "ids": ids})).collect()))
}

/// Отбор по строке: каждое слово запроса есть в одном из полей `fields` (как поиск музыкального сервера).
/// Пустой запрос — всё. Ответ — элементы в прежнем порядке.
fn filter(args: &Value) -> Option<Value> {
    let list = items(args, "items")?;
    let query = fold(args.get("query").and_then(Value::as_str).unwrap_or(""));
    let fields: Vec<String> = args.get("fields")?.as_array()?.iter().filter_map(Value::as_str).map(str::to_string).collect();
    let words: Vec<&str> = query.split_whitespace().collect();
    Some(Value::Array(
        list.into_iter()
            .filter(|item| {
                let haystack = fields.iter().map(|f| fold(text(item, f))).collect::<Vec<_>>().join(" ");
                words.iter().all(|w| haystack.contains(w))
            })
            .collect(),
    ))
}

/// Следующая страница к уже показанному: повтор по `id` не добавляется (сервер мог сдвинуть страницы).
fn merge_pages(args: &Value) -> Option<Value> {
    let mut list = items(args, "items")?;
    let page = items(args, "page")?;
    let mut seen: HashSet<String> = list.iter().map(|i| text(i, "id").to_string()).collect();
    for item in page {
        if seen.insert(text(&item, "id").to_string()) {
            list.push(item);
        }
    }
    Some(Value::Array(list))
}

/// Найденное на сервере одним списком по названию (доски `MusicSearch`, `DeskMusicMore`): `[{kind, id}]`;
/// `filter` — `all` | `tracks` | `artists` | `albums`.
fn search_rows(args: &Value) -> Option<Value> {
    let filter = args.get("filter").and_then(Value::as_str).unwrap_or("all");
    let mut rows: Vec<(String, &'static str, String)> = Vec::new();
    for (key, kind, name) in [("tracks", "track", "title"), ("albums", "album", "title"), ("artists", "artist", "name")] {
        if filter != "all" && filter != key {
            continue;
        }
        for item in args.get(key).and_then(Value::as_array).into_iter().flatten() {
            rows.push((fold(text(item, name)), kind, text(item, "id").to_string()));
        }
    }
    rows.sort();
    Some(Value::Array(rows.into_iter().map(|(_, kind, id)| json!({"kind": kind, "id": id})).collect()))
}

#[derive(Deserialize)]
struct OfflineEntry {
    id: String,
    #[serde(default)]
    bytes: u64,
}

#[derive(Deserialize, Default)]
struct OfflineHolds {
    #[serde(default)]
    playlists: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    albums: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineInput {
    entries: Vec<OfflineEntry>,
    #[serde(default)]
    holds: OfflineHolds,
    /// Порядок плейлистов (как у пользователя); плейлисты вне списка — после, по id.
    #[serde(default)]
    playlist_order: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineGroup {
    kind: &'static str,
    id: String,
    track_ids: Vec<String>,
    bytes: u64,
}

/// «Загруженное» группами (доски `XpMusic`, `RdMusic`): загруженные плейлисты, затем альбомы, затем отдельные
/// треки. Трек попадает в первую группу, которая его держит; в группе — только треки, лежащие на устройстве.
fn offline_groups(input: &OfflineInput) -> Option<Value> {
    let bytes: HashMap<&str, u64> = input.entries.iter().map(|e| (e.id.as_str(), e.bytes)).collect();
    let mut placed: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    let ordered = input.playlist_order.iter().filter_map(|id| input.holds.playlists.get_key_value(id));
    let unordered = input.holds.playlists.iter().filter(|(id, _)| !input.playlist_order.contains(id));
    let holders = ordered
        .chain(unordered)
        .map(|(id, ids)| ("playlist", id, ids))
        .chain(input.holds.albums.iter().map(|(id, ids)| ("album", id, ids)));
    for (kind, id, ids) in holders {
        let mut group = OfflineGroup { kind, id: id.clone(), track_ids: vec![], bytes: 0 };
        for track in ids {
            if let Some(size) = bytes.get(track.as_str()) {
                if placed.insert(track.as_str()) {
                    group.track_ids.push(track.clone());
                    group.bytes = group.bytes.saturating_add(*size);
                }
            }
        }
        if !group.track_ids.is_empty() {
            out.push(group);
        }
    }
    let mut rest = OfflineGroup { kind: "tracks", id: String::new(), track_ids: vec![], bytes: 0 };
    for e in &input.entries {
        if !placed.contains(e.id.as_str()) {
            rest.track_ids.push(e.id.clone());
            rest.bytes = rest.bytes.saturating_add(e.bytes);
        }
    }
    if !rest.track_ids.is_empty() {
        out.push(rest);
    }
    serde_json::to_value(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Общий образец для всех клиентов: вызов, вход и ожидаемый ответ.
    #[test]
    fn conformance_cases() {
        let raw = include_str!("../../../conformance/music-library/cases.json");
        let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["call"].as_str().unwrap();
            assert_eq!(call(name, &case["args"]), Some(case["expect"].clone()), "{}", case["title"]);
        }
    }

    #[test]
    fn letters_and_other() {
        assert_eq!(letter_of("lampa"), "L");
        assert_eq!(letter_of("пятый этаж"), "П");
        assert_eq!(letter_of("5 этаж"), OTHER_LETTER);
        assert_eq!(letter_of(""), OTHER_LETTER);
    }

    #[test]
    fn bad_input_is_none() {
        assert_eq!(call("musicLibrarySort", &json!({"items": 1})), None);
        assert_eq!(call("musicOfflineGroups", &json!({})), None);
        assert_eq!(call("musicNope", &json!({})), None);
    }
}
