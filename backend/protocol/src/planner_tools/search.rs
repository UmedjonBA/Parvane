//! Поиск по «Плану» (доски `RpPlan`, `ZdPlanX`): записи, совпавшие со строкой, по фильтру, двумя списками —
//! «Впереди» (по возрастанию даты, записи без даты — в конце) и «Прошло» (сначала недавнее).
//!
//! Совпадение — каждое слово запроса входит подстрокой в название, описание либо группу (регистр и «ё» не
//! различаются). Фильтр: `all`; `events` — события; `tasks` — невыполненные задачи; `done` — выполненные. Запись
//! «прошла», если её день раньше `today` либо сегодня и её конец (начало, если конца нет) не позже `nowMinute`.
//! День записи — `day`, без него — `due`. Клиент сам раскрывает повторы и шлёт экземпляры ряда отдельными записями
//! с общим `series`: в «Впереди» остаётся только ближайший экземпляр ряда, в «Прошло» — каждый.
//!
//! Колонка «Слои / Что показывать» компьютера (доска `ZdPlanX`, 21 ноя 2026): `show` — набор вместо `filter`
//! (`events`, `tasks`, `done`, `offers`): вид записи включён, выполненное — только при `done`, запись из
//! чата (`fromChat`) — только при `offers`; `hiddenGroups` — выключенные слои (группы; `""` — без группы).

use serde::Deserialize;
use serde_json::{json, Value};

use super::fold;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Input {
    pub query: String,
    pub filter: String,
    pub items: Vec<Item>,
    pub today: String,
    pub now_minute: i64,
    pub ahead_limit: usize,
    pub past_limit: usize,
    pub show: Option<Vec<String>>,
    pub hidden_groups: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub key: String,
    /// `event` | `task`
    pub kind: String,
    pub name: String,
    pub description: String,
    pub group: String,
    pub day: String,
    pub due: String,
    /// Начало и конец, минуты; нет — `-1`.
    #[serde(default = "none")]
    pub start: i64,
    #[serde(default = "none")]
    pub end: i64,
    pub is_done: bool,
    /// Ряд, к которому относится экземпляр; пусто — запись сама по себе.
    pub series: String,
    /// Запись создана из задания, присланного в чат.
    pub from_chat: bool,
}

fn none() -> i64 {
    -1
}

const MAX_QUERY_CHARS: usize = 200;
const MAX_LIMIT: usize = 1000;

pub fn run(input: &Input) -> Value {
    let query = fold(&input.query.chars().take(MAX_QUERY_CHARS).collect::<String>());
    let words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return json!({"ahead": [], "past": [], "aheadTotal": 0, "pastTotal": 0});
    }
    let mut ahead: Vec<&Item> = Vec::new();
    let mut past: Vec<&Item> = Vec::new();
    for item in &input.items {
        let shown = match &input.show {
            Some(show) => passes_show(item, show),
            None => passes(item, &input.filter),
        };
        if !shown || input.hidden_groups.iter().any(|g| *g == item.group) {
            continue;
        }
        let text = fold(&format!("{} {} {}", item.name, item.description, item.group));
        if !words.iter().all(|w| text.contains(w)) {
            continue;
        }
        if is_past(item, &input.today, input.now_minute) {
            past.push(item);
        } else {
            ahead.push(item);
        }
    }
    // Без даты — после датированных: пустая строка в ключе заменяется наибольшей
    ahead.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    let mut seen = std::collections::HashSet::new();
    ahead.retain(|item| item.series.is_empty() || seen.insert(item.series.as_str()));
    past.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
    let keys = |list: &[&Item], limit: usize| list.iter().take(limit.min(MAX_LIMIT)).map(|i| i.key.clone()).collect::<Vec<_>>();
    json!({
        "ahead": keys(&ahead, input.ahead_limit),
        "past": keys(&past, input.past_limit),
        "aheadTotal": ahead.len(),
        "pastTotal": past.len(),
    })
}

fn passes(item: &Item, filter: &str) -> bool {
    match filter {
        "events" => item.kind == "event",
        "tasks" => item.kind == "task" && !item.is_done,
        "done" => item.is_done,
        _ => true,
    }
}

fn passes_show(item: &Item, show: &[String]) -> bool {
    let has = |what: &str| show.iter().any(|s| s == what);
    let kind = if item.kind == "event" { "events" } else { "tasks" };
    has(kind) && (!item.is_done || has("done")) && (!item.from_chat || has("offers"))
}

fn when(item: &Item) -> &str {
    if item.day.is_empty() { &item.due } else { &item.day }
}

fn is_past(item: &Item, today: &str, now_minute: i64) -> bool {
    let day = when(item);
    if day.is_empty() {
        return false;
    }
    let edge = if item.end >= 0 { item.end } else { item.start };
    day < today || (day == today && edge >= 0 && edge <= now_minute)
}

fn sort_key(item: &Item) -> (&str, i64, String, &str) {
    let day = when(item);
    (if day.is_empty() { "~" } else { day }, item.start, fold(&item.name), &item.key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, kind: &str, name: &str, day: &str, start: i64, is_done: bool) -> Item {
        Item { key: key.into(), kind: kind.into(), name: name.into(), day: day.into(), start, end: start + 60, is_done, ..Item::default() }
    }

    #[test]
    fn splits_ahead_and_past_and_filters() {
        let items = vec![
            item("a", "event", "Зал", "2026-11-18", 1080, false),
            item("b", "task", "Продлить абонемент в зал", "", -1, false),
            item("c", "event", "Зал", "2026-11-15", 600, false),
            item("d", "task", "Зал", "2026-11-11", 1080, true),
            item("e", "event", "Созвон", "2026-11-16", 600, false),
            item("f", "event", "ЗАЛ", "2026-11-15", 1200, false),
            Item { series: "s".into(), ..item("g1", "event", "Зал по средам", "2026-11-25", 600, false) },
            Item { series: "s".into(), ..item("g0", "event", "Зал по средам", "2026-11-18", 600, false) },
        ];
        let mut input = Input { query: "зал".into(), filter: "all".into(), items, today: "2026-11-15".into(), now_minute: 700, ahead_limit: 10, past_limit: 1, ..Input::default() };
        assert_eq!(run(&input), json!({"ahead": ["f", "g0", "a", "b"], "past": ["c"], "aheadTotal": 4, "pastTotal": 2}));
        input.filter = "done".into();
        assert_eq!(run(&input)["past"], json!(["d"]));
        input.filter = "tasks".into();
        assert_eq!(run(&input)["ahead"], json!(["b"]));
        input.query = "  ".into();
        assert_eq!(run(&input)["aheadTotal"], 0);
    }

    #[test]
    fn show_set_and_hidden_groups() {
        let items = vec![
            Item { group: "Спорт".into(), ..item("a", "event", "Зал", "2026-11-18", 1080, false) },
            Item { group: "Учёба".into(), ..item("b", "event", "Зал лекций", "2026-11-19", 600, false) },
            Item { from_chat: true, ..item("c", "task", "Зал: продлить", "2026-11-20", -1, false) },
            item("d", "task", "Зал", "2026-11-21", 1080, true),
        ];
        let show = |list: &[&str]| Some(list.iter().map(|s| s.to_string()).collect());
        let mut input = Input { query: "зал".into(), items, today: "2026-11-15".into(), ahead_limit: 10, past_limit: 10, show: show(&["events", "tasks", "offers"]), ..Input::default() };
        assert_eq!(run(&input)["ahead"], json!(["a", "b", "c"]));
        input.hidden_groups = vec!["Учёба".into()];
        input.show = show(&["events", "tasks", "done"]);
        assert_eq!(run(&input)["ahead"], json!(["a", "d"]));
    }
}
