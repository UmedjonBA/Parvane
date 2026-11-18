//! NOTES-1: раскладка графа заметок и холста из графа по общему образцу `conformance/notes-graph/cases.json` —
//! тот же файл читают клиенты. `NOTES_GRAPH_REGEN=1` пересоздаёт ожидаемое в образце.

use std::time::Instant;

use parvane_protocol::host::call::call_static;
use serde_json::{json, Value};

const SAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/notes-graph/cases.json");

fn num(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or_else(|| panic!("нет числа {key} в {v}"))
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет списка {key}"))
}

type Rect = (i64, i64, i64, i64);

fn overlap(a: Rect, b: Rect) -> bool {
    a.0 < b.2 && b.0 < a.2 && a.1 < b.3 && b.1 < a.3
}

/// Прямоугольники узла: кружок и показанная подпись.
fn node_rects(node: &Value) -> Vec<Rect> {
    let (x, y, r) = (num(node, "x"), num(node, "y"), num(node, "r"));
    let mut out = vec![(x - r, y - r, x + r, y + r)];
    let label = &node["label"];
    if label["show"] == json!(true) {
        let (lx, ly) = (num(label, "x"), num(label, "y"));
        out.push((lx, ly, lx + num(label, "w"), ly + num(label, "h")));
    }
    out
}

/// Граф: узлы и показанные подписи не накладываются и лежат в поле, связи ведут к узлам.
fn check_graph(name: &str, out: &Value) {
    let nodes = list(out, "nodes");
    let (w, h) = (num(&out["bounds"], "w"), num(&out["bounds"], "h"));
    let rects: Vec<Vec<Rect>> = nodes.iter().map(node_rects).collect();
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| rects[i].iter().map(|r| r.0).min());
    for (at, &i) in order.iter().enumerate() {
        let right = rects[i].iter().map(|r| r.2).max().unwrap_or(0);
        for r in &rects[i] {
            assert!(r.0 >= 0 && r.1 >= 0 && r.2 <= w && r.3 <= h, "{name}: узел {} вне поля {w}×{h}: {r:?}", nodes[i]["id"]);
        }
        for &j in &order[at + 1..] {
            if rects[j].iter().map(|r| r.0).min().unwrap_or(0) >= right {
                break;
            }
            for a in &rects[i] {
                for b in &rects[j] {
                    assert!(!overlap(*a, *b), "{name}: наложение {} и {}: {a:?} {b:?}", nodes[i]["id"], nodes[j]["id"]);
                }
            }
        }
    }
    let ids: std::collections::BTreeSet<&str> = nodes.iter().filter_map(|n| n["id"].as_str()).collect();
    assert_eq!(ids.len(), nodes.len(), "{name}: id узлов повторяются");
    for edge in list(out, "edges") {
        for end in ["from", "to"] {
            assert!(ids.contains(edge[end].as_str().unwrap_or("")), "{name}: связь к неизвестному узлу {edge}");
        }
    }
    let in_blocks: i64 = list(out, "blocks").iter().map(|b| num(b, "nodes")).sum();
    assert_eq!(in_blocks as usize, nodes.len(), "{name}: блоки не покрывают узлы");
}

/// Холст: карточки не накладываются, стоят по сетке, стрелки ведут к карточкам.
fn check_canvas(name: &str, out: &Value, grid: i64) {
    let cards = list(out, "cards");
    let rects: Vec<Rect> = cards.iter().map(|c| (num(c, "x"), num(c, "y"), num(c, "x") + num(c, "width"), num(c, "y") + num(c, "height"))).collect();
    for (i, a) in rects.iter().enumerate() {
        assert!(a.0 >= 0 && a.1 >= 0 && a.0 % grid == 0 && a.1 % grid == 0, "{name}: карточка мимо сетки {a:?}");
        for b in &rects[i + 1..] {
            assert!(!overlap(*a, *b), "{name}: карточки наложились {a:?} {b:?}");
        }
    }
    let ids: std::collections::BTreeSet<&str> = cards.iter().filter_map(|c| c["id"].as_str()).collect();
    for edge in list(out, "edges") {
        assert!(ids.contains(edge["from"].as_str().unwrap_or("")) && ids.contains(edge["to"].as_str().unwrap_or("")), "{name}: {edge}");
    }
}

fn check(name: &str, call: &str, args: &Value, out: &Value) {
    match call {
        "notesGraphLayout" => check_graph(name, out),
        "notesGraphCanvas" => check_canvas(name, out, args["grid"].as_i64().unwrap_or(10)),
        other => panic!("{name}: неизвестный вызов {other}"),
    }
}

/// Образец с ожидаемым: случай — несколько строк, каждый узел, связь и карточка — одной строкой.
fn render(sample: &Value) -> String {
    let line = |v: &Value| serde_json::to_string(v).expect("json");
    let mut text = format!("{{\n \"rule\": {},\n \"note\": {},\n \"cases\": [\n", line(&sample["rule"]), line(&sample["note"]));
    let cases = list(sample, "cases");
    for (i, case) in cases.iter().enumerate() {
        text += &format!("  {{\n   \"name\": {},\n   \"call\": {},\n   \"args\": {},\n   \"expect\": {{\n", line(&case["name"]), line(&case["call"]), line(&case["args"]));
        let expect = case["expect"].as_object().expect("expect");
        for (k, (key, value)) in expect.iter().enumerate() {
            let comma = if k + 1 < expect.len() { "," } else { "" };
            match value.as_array().filter(|a| !a.is_empty()) {
                Some(items) => {
                    let rows: Vec<String> = items.iter().map(|item| format!("     {}", line(item))).collect();
                    text += &format!("    {}: [\n{}\n    ]{comma}\n", line(&json!(key)), rows.join(",\n"));
                }
                None => text += &format!("    {}: {}{comma}\n", line(&json!(key)), line(value)),
            }
        }
        text += &format!("   }}\n  }}{}\n", if i + 1 < cases.len() { "," } else { "" });
    }
    text + " ]\n}\n"
}

#[test]
fn layout_follows_the_shared_sample() {
    let mut sample: Value = serde_json::from_str(&std::fs::read_to_string(SAMPLE).expect("образец графа")).expect("JSON образца");
    let regen = std::env::var("NOTES_GRAPH_REGEN").is_ok();
    let cases = sample["cases"].as_array_mut().expect("cases");
    assert!(cases.len() >= 10, "образец урезан: {}", cases.len());
    for case in cases.iter_mut() {
        let name = case["name"].as_str().unwrap_or("?").to_string();
        let call = case["call"].as_str().expect("call").to_string();
        let out = call_static(&call, &case["args"]).unwrap_or_else(|e| panic!("{name}: {e}"));
        check(&name, &call, &case["args"], &out);
        assert_eq!(out, call_static(&call, &case["args"]).expect("повтор"), "{name}: повтор дал другое");
        if regen {
            case["expect"] = out;
        } else {
            assert_eq!(out, case["expect"], "{name}: ответ движка разошёлся с образцом");
        }
    }
    if regen {
        std::fs::write(SAMPLE, render(&sample)).expect("запись образца");
    }
}

#[test]
fn scope_and_seed_change_the_result() {
    let sample: Value = serde_json::from_str(&std::fs::read_to_string(SAMPLE).expect("образец")).expect("JSON");
    let args = sample["cases"][0]["args"].clone();
    let ids = |out: &Value, key: &str| -> Vec<String> { list(out, key).iter().filter_map(|n| n["id"].as_str().map(str::to_string)).collect() };
    let places = |out: &Value| -> Vec<(i64, i64)> { list(out, "nodes").iter().map(|n| (num(n, "x"), num(n, "y"))).collect() };
    let all = call_static("notesGraphLayout", &args).expect("все");

    let mut other_seed = args.clone();
    other_seed["seed"] = json!(99);
    let reseeded = call_static("notesGraphLayout", &other_seed).expect("зерно");
    assert_eq!(ids(&all, "nodes"), ids(&reseeded, "nodes"));
    assert_ne!(places(&all), places(&reseeded), "зерно не влияет на раскладку");

    // Порядок заметок во входе — часть входа; но набор узлов и связей от зерна не зависит
    assert_eq!(list(&all, "edges").len(), list(&reseeded, "edges").len());

    let mut around = args.clone();
    around["scope"] = json!({"kind": "around", "note": "n5", "depth": 1});
    assert_eq!(ids(&call_static("notesGraphLayout", &around).expect("вокруг"), "nodes"), ["n1", "n5"]);
    around["scope"] = json!({"kind": "around", "note": "нет такой", "depth": 2});
    assert!(list(&call_static("notesGraphLayout", &around).expect("вокруг"), "nodes").is_empty());

    let mut by_tag = args.clone();
    by_tag["scope"] = json!({"kind": "tag", "tag": "книги"});
    assert_eq!(ids(&call_static("notesGraphLayout", &by_tag).expect("метка"), "nodes"), ["n8", "n9"]);

    // Холст берёт только существующие заметки той же области
    by_tag["scope"] = json!({"kind": "folder", "folder": "Кухня"});
    let canvas = call_static("notesGraphCanvas", &by_tag).expect("холст");
    assert_eq!(ids(&canvas, "cards"), ["n6", "n7"]);
    assert_eq!(list(&canvas, "edges").len(), 1);

    // Негодный вход — отказ, а не паника
    assert!(call_static("notesGraphLayout", &json!({"notes": "не список"})).is_err());
    assert!(call_static("notesGraphCanvas", &json!({"scope": {"kind": "неизвестная"}})).is_err());
}

/// Выдуманный граф: `count` заметок в 12 папках, у каждой 25-й много ссылок, каждая десятая — одиночка.
fn big_input(count: usize) -> Value {
    let title = |i: usize| format!("Заметка номер {i} о делах");
    let notes: Vec<Value> = (0..count)
        .map(|i| {
            let mut links = Vec::new();
            if i % 10 != 9 {
                links.push(title(i / 25 * 25));
                if i % 3 == 0 {
                    links.push(title((i * 7 + 3) % count));
                }
            }
            json!({"id": format!("n{i}"), "title": title(i), "folder": format!("Папка {}", i % 12), "links": links})
        })
        .collect();
    json!({"notes": notes, "seed": 1})
}

#[test]
fn thousand_nodes_are_laid_out_without_overlaps() {
    let args = big_input(1000);
    let started = Instant::now();
    let out = call_static("notesGraphLayout", &args).expect("раскладка");
    let layout_ms = started.elapsed().as_millis();
    if let Ok(path) = std::env::var("NOTES_GRAPH_DUMP") {
        std::fs::write(path, out.to_string()).expect("выгрузка");
    }
    check_graph("1000 узлов", &out);
    let nodes = list(&out, "nodes");
    assert_eq!(nodes.len(), 1000);
    let hidden = nodes.iter().filter(|n| n["label"]["show"] != json!(true)).count();
    let started = Instant::now();
    let canvas = call_static("notesGraphCanvas", &args).expect("холст");
    let canvas_ms = started.elapsed().as_millis();
    check_canvas("1000 карточек", &canvas, 10);
    println!(
        "notes-graph 1000: раскладка {layout_ms} мс, холст {canvas_ms} мс, поле {}×{}, связей {}, скрытых подписей {hidden}",
        out["bounds"]["w"],
        out["bounds"]["h"],
        list(&out, "edges").len()
    );
    assert!(hidden * 20 <= nodes.len(), "скрыто слишком много подписей: {hidden}");
}
