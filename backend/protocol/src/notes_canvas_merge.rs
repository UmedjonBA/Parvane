//! Сведение холста (файл JSON Canvas), правленного на двух устройствах (spec 040 T9, правило NOTES-3):
//! трёхстороннее слияние по id карточек и стрелок с общей версией. Правки разных карточек и разных полей одной
//! карточки складываются; одно поле, изменённое по-разному, остаётся моим (расхождение считается); удалённое на
//! одной стороне и не тронутое на другой — удаляется, удалённое на одной и изменённое на другой — остаётся
//! изменённым. Стрелки к ушедшим карточкам убираются. Незнакомые поля (узлов, стрелок, файла) сводятся так же и не
//! теряются. Общий образец — `conformance/notes-canvas-merge/cases.json` (его же проверяет web). Вызов без
//! состояния: `notesCanvasMerge`.

use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
struct Args {
    #[serde(default)]
    base: String,
    #[serde(default)]
    mine: String,
    #[serde(default)]
    theirs: String,
}

/// Документ холста как есть: узлы, стрелки и прочие поля файла. Пустой текст — пустой холст; не JSON-объект —
/// `None`.
struct Doc {
    nodes: Vec<Map<String, Value>>,
    edges: Vec<Map<String, Value>>,
    rest: Map<String, Value>,
}

fn parse(text: &str) -> Option<Doc> {
    if text.trim().is_empty() {
        return Some(Doc { nodes: Vec::new(), edges: Vec::new(), rest: Map::new() });
    }
    let Value::Object(mut root) = serde_json::from_str::<Value>(text).ok()? else { return None };
    let mut take = |key: &str| -> Option<Vec<Map<String, Value>>> {
        match root.remove(key) {
            None => Some(Vec::new()),
            Some(Value::Array(items)) => Some(
                items
                    .into_iter()
                    .filter_map(|item| match item {
                        Value::Object(map) if id_of(&map).is_some() => Some(map),
                        _ => None,
                    })
                    .collect(),
            ),
            Some(_) => None,
        }
    };
    let nodes = take("nodes")?;
    let edges = take("edges")?;
    Some(Doc { nodes, edges, rest: root })
}

fn id_of(item: &Map<String, Value>) -> Option<String> {
    match item.get("id")? {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Поле за полем: совпало у обоих — берётся; изменено одной стороной — её значение; обеими по-разному — моё,
/// с расхождением.
fn merge_fields(
    base: Option<&Map<String, Value>>,
    mine: &Map<String, Value>,
    theirs: &Map<String, Value>,
    conflicts: &mut usize,
) -> Map<String, Value> {
    let mut keys: Vec<&String> = mine.keys().collect();
    keys.extend(theirs.keys().filter(|k| !mine.contains_key(*k)));
    if let Some(base) = base {
        keys.extend(base.keys().filter(|k| !mine.contains_key(*k) && !theirs.contains_key(*k)));
    }
    let mut out = Map::new();
    for key in keys {
        let (b, m, t) = (base.and_then(|b| b.get(key)), mine.get(key), theirs.get(key));
        let chosen = if m == t {
            m
        } else if m == b {
            t
        } else if t == b {
            m
        } else {
            *conflicts += 1;
            m
        };
        if let Some(value) = chosen {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// Сведение списка по id: мой порядок, затем добавленное только с той стороны — в её порядке.
fn merge_items(
    base: &[Map<String, Value>],
    mine: &[Map<String, Value>],
    theirs: &[Map<String, Value>],
    conflicts: &mut usize,
) -> Vec<Map<String, Value>> {
    let find = |list: &[Map<String, Value>], id: &str| list.iter().find(|item| id_of(item).as_deref() == Some(id)).cloned();
    let mut ids: Vec<String> = mine.iter().filter_map(id_of).collect();
    for id in theirs.iter().filter_map(id_of) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut out = Vec::with_capacity(ids.len());
    for id in &ids {
        let (b, m, t) = (find(base, id), find(mine, id), find(theirs, id));
        let merged = match (b, m, t) {
            (b, Some(m), Some(t)) => Some(merge_fields(b.as_ref(), &m, &t, conflicts)),
            (None, Some(m), None) => Some(m),
            (None, None, Some(t)) => Some(t),
            // Удалено одной стороной: если другая его не трогала — удалено, иначе её правка остаётся
            (Some(b), Some(m), None) => (m != b).then(|| {
                *conflicts += 1;
                m
            }),
            (Some(b), None, Some(t)) => (t != b).then(|| {
                *conflicts += 1;
                t
            }),
            _ => None,
        };
        if let Some(item) = merged {
            out.push(item);
        }
    }
    out
}

/// Итог: `doc` — сведённый холст (JSON-объект; клиент пишет его своим порядком ключей), `conflicts` — число мест,
/// где обе стороны изменили одно и то же по-разному (оставлено моё). Нечитаемая чужая версия — остаётся моя;
/// нечитаемая общая — сведение как без общей версии.
pub fn merge(base: &str, mine: &str, theirs: &str) -> Option<Value> {
    let mine_doc = parse(mine)?;
    let Some(theirs_doc) = parse(theirs) else {
        return Some(json!({ "doc": to_value(mine_doc), "conflicts": 1 }));
    };
    let base_doc = parse(base).unwrap_or(Doc { nodes: Vec::new(), edges: Vec::new(), rest: Map::new() });
    let mut conflicts = 0usize;
    let nodes = merge_items(&base_doc.nodes, &mine_doc.nodes, &theirs_doc.nodes, &mut conflicts);
    let alive: std::collections::BTreeSet<String> = nodes.iter().filter_map(id_of).collect();
    let ends_alive = |edge: &Map<String, Value>| {
        ["fromNode", "toNode"].iter().all(|key| match edge.get(*key) {
            Some(Value::String(id)) => alive.contains(id),
            Some(Value::Number(n)) => alive.contains(&n.to_string()),
            _ => false,
        })
    };
    let edges: Vec<Map<String, Value>> = merge_items(&base_doc.edges, &mine_doc.edges, &theirs_doc.edges, &mut conflicts)
        .into_iter()
        .filter(|edge| ends_alive(edge))
        .collect();
    let rest = merge_fields(Some(&base_doc.rest), &mine_doc.rest, &theirs_doc.rest, &mut conflicts);
    Some(json!({ "doc": to_value(Doc { nodes, edges, rest }), "conflicts": conflicts }))
}

fn to_value(doc: Doc) -> Value {
    let mut root = doc.rest;
    root.insert("nodes".into(), Value::Array(doc.nodes.into_iter().map(Value::Object).collect()));
    root.insert("edges".into(), Value::Array(doc.edges.into_iter().map(Value::Object).collect()));
    Value::Object(root)
}

/// Вызов `notesCanvasMerge`: `{base, mine, theirs}` — тексты файла холста.
pub fn merge_json(args: &Value) -> Option<Value> {
    let args: Args = serde_json::from_value(args.clone()).ok()?;
    merge(&args.base, &args.mine, &args.theirs)
}
