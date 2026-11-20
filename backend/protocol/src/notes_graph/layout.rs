//! Сборка раскладки графа: связные группы раскладываются порознь (силы → стороны подписей → снятие
//! наложений), одиночки встают отдельным рядом по папкам, блоки упаковываются полками; затем места
//! округляются до целых и считаются линии связей.

use std::collections::BTreeMap;

use super::build::{adjacency, build, pickers, GEdge, Graph};
use super::force::{self, Body};
use super::labels::{self, Rect, Shape, Side, LABEL_GAP};
use super::rng::Rng;
use super::separate::{self, PAD};
use super::{edges, int, pack, setting, BlockOut, BoundsOut, GraphOut, Input, LabelOut, NodeOut};

const MIN_RADIUS: f64 = 6.0;
const MAX_RADIUS: f64 = 28.0;
const RADIUS_PER_DEGREE: f64 = 3.2;
/// Просвет между блоками и между одиночками.
const BLOCK_GAP: f64 = 60.0;
const SINGLE_GAP: f64 = 14.0;

fn even(v: f64) -> f64 {
    (v / 2.0).ceil() * 2.0
}

/// Связные группы: узлы каждой по возрастанию номера, группы — по первому узлу.
pub(crate) fn components(count: usize, edges: &[GEdge]) -> Vec<Vec<usize>> {
    let adj = adjacency(count, edges);
    let mut seen = vec![false; count];
    let mut out = Vec::new();
    for start in 0..count {
        if seen[start] {
            continue;
        }
        seen[start] = true;
        let mut members = vec![start];
        let mut next = 0;
        while let Some(&node) = members.get(next) {
            next += 1;
            for &other in &adj[node] {
                if !seen[other] {
                    seen[other] = true;
                    members.push(other);
                }
            }
        }
        members.sort_unstable();
        out.push(members);
    }
    out
}

/// Порядок одиночек: по папке, названию, id.
pub(crate) fn sort_singles(graph: &Graph, singles: &mut [usize]) {
    singles.sort_by_cached_key(|&i| {
        let node = &graph.nodes[i];
        (node.group.clone().unwrap_or_default(), node.title.trim().to_lowercase(), node.id.clone())
    });
}

/// Связи по группам: пары номеров узлов внутри своей группы. `local[узел]` — номер узла в его группе.
pub(crate) fn edges_by_group(groups: &[Vec<usize>], count: usize, edges: &[GEdge]) -> (Vec<Vec<(usize, usize)>>, Vec<usize>) {
    let mut group_of = vec![0usize; count];
    let mut local = vec![0usize; count];
    for (g, members) in groups.iter().enumerate() {
        for (k, &node) in members.iter().enumerate() {
            group_of[node] = g;
            local[node] = k;
        }
    }
    let mut out = vec![Vec::new(); groups.len()];
    for e in edges {
        if e.a < count && e.b < count {
            out[group_of[e.a]].push((local[e.a], local[e.b]));
        }
    }
    (out, local)
}

fn union_of(shapes: &[Shape], nodes: &[usize]) -> Rect {
    let mut all: Option<Rect> = None;
    for &i in nodes {
        let b = shapes[i].bounds();
        all = Some(all.map_or(b, |a| a.union(b)));
    }
    all.unwrap_or(Rect { x0: 0.0, y0: 0.0, x1: 0.0, y1: 0.0 })
}

fn shift(shapes: &mut [Shape], nodes: &[usize], dx: f64, dy: f64) {
    for &i in nodes {
        shapes[i].x += dx;
        shapes[i].y += dy;
    }
}

/// Раскладывает одну связную группу. Без закреплённых узлов левый верхний угол занятого после неё — в нуле и
/// возвращается размер; с закреплёнными (`pins` — места по номеру узла) группа остаётся там, где её держат они,
/// и возвращается `None`.
fn place_group(
    graph: &Graph,
    shapes: &mut [Shape],
    members: &[usize],
    group_edges: &[(usize, usize)],
    pins: &BTreeMap<usize, (f64, f64)>,
    rng: &mut Rng,
) -> Option<(f64, f64)> {
    let mut clusters: BTreeMap<&str, usize> = BTreeMap::new();
    let bodies: Vec<Body> = members
        .iter()
        .map(|&i| {
            let s = &shapes[i];
            let next = clusters.len();
            let cluster = *clusters.entry(graph.nodes[i].group.as_deref().unwrap_or("")).or_insert(next);
            let label = if s.label_w > 0.0 { (LABEL_GAP + s.label_h) / 2.0 } else { 0.0 };
            Body { r: s.r, half_w: s.r.max(s.label_w / 2.0) + PAD, half_h: s.r + label + PAD, label_w: s.label_w, degree: s.degree, cluster }
        })
        .collect();
    let fixed: Vec<Option<(f64, f64)>> = members.iter().map(|i| pins.get(i).copied()).collect();
    // Закреплённая группа начинает с прежних мест (раскладки без закрепления): сдвигается только то, что тянет
    // переставленная точка
    let start: Option<Vec<(f64, f64)>> = (!pins.is_empty()).then(|| members.iter().map(|&i| (shapes[i].x, shapes[i].y)).collect());
    let places = force::run(&bodies, group_edges, &fixed, start.as_deref(), rng);
    let mut part: Vec<Shape> = members.iter().zip(&places).map(|(&i, &(x, y))| Shape { x, y, ..shapes[i].clone() }).collect();
    let mut adj = vec![Vec::new(); part.len()];
    for &(a, b) in group_edges {
        adj[a].push(b);
        adj[b].push(a);
    }
    labels::choose_sides(&mut part, &adj);
    let is_fixed: Vec<bool> = fixed.iter().map(Option::is_some).collect();
    separate::run(&mut part, &is_fixed);
    for (&i, shape) in members.iter().zip(part) {
        shapes[i] = shape;
    }
    if is_fixed.contains(&true) {
        return None;
    }
    let all = union_of(shapes, members);
    shift(shapes, members, -all.x0, -all.y0);
    Some((all.x1 - all.x0, all.y1 - all.y0))
}

/// Закреплённые узлы входа по номеру узла графа: только узлы этого графа и только конечные места.
fn pins_of(input: &Input, graph: &Graph) -> BTreeMap<usize, (f64, f64)> {
    let index: BTreeMap<&str, usize> = graph.nodes.iter().enumerate().map(|(i, node)| (node.id.as_str(), i)).collect();
    input
        .pinned
        .iter()
        .filter(|pin| pin.x.is_finite() && pin.y.is_finite())
        .filter_map(|pin| index.get(pin.id.as_str()).map(|&i| (i, (pin.x.round(), pin.y.round()))))
        .collect()
}

pub(crate) fn layout(input: &Input) -> GraphOut {
    let graph = build(input);
    let (folders, tags) = pickers(input);
    let count = graph.nodes.len();
    let char_width = setting(input.char_width, 7.0, 3.0, 20.0);
    let label_max = setting(input.label_max_width, 150.0, 40.0, 400.0);
    let label_height = even(setting(input.label_height, 16.0, 8.0, 40.0));
    let aspect = setting(input.aspect, 1.5, 0.5, 4.0);

    let mut shapes: Vec<Shape> = graph
        .nodes
        .iter()
        .map(|node| {
            let chars = node.title.trim().chars().count() as f64;
            let label_w = if chars > 0.0 { even((chars * char_width).min(label_max)) } else { 0.0 };
            let r = (MIN_RADIUS + (node.degree as f64).sqrt() * RADIUS_PER_DEGREE).min(MAX_RADIUS).round();
            Shape { x: 0.0, y: 0.0, r, label_w, label_h: label_height, side: Side::Bottom, show: label_w > 0.0, degree: node.degree }
        })
        .collect();

    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut singles: Vec<usize> = Vec::new();
    for members in components(count, &graph.edges) {
        match members.as_slice() {
            [one] => singles.push(*one),
            _ => groups.push(members),
        }
    }
    let (group_edges, _) = edges_by_group(&groups, count, &graph.edges);
    let mut rng = Rng::new(if input.seed.is_finite() && input.seed > 0.0 { input.seed as u64 } else { 0 });
    let pins = pins_of(input, &graph);
    // Сначала — раскладка без закрепления: она задаёт систему координат (ту, в которой клиент ставил точки) и места
    // свободных блоков, которые поэтому остаются там, где их видели
    let no_pins = BTreeMap::new();
    let mut sized: Vec<(Vec<usize>, f64, f64, usize)> = Vec::with_capacity(groups.len());
    for (g, (members, own_edges)) in groups.into_iter().zip(&group_edges).enumerate() {
        let (w, h) = place_group(&graph, &mut shapes, &members, own_edges, &no_pins, &mut rng).unwrap_or((0.0, 0.0));
        sized.push((members, w, h, g));
    }
    // Высокие группы первыми: полки выходят плотнее; при равных — порядок входа
    sized.sort_by(|a, b| b.2.total_cmp(&a.2));

    sort_singles(&graph, &mut singles);
    let single_sizes: Vec<(f64, f64)> = singles
        .iter()
        .map(|&i| {
            let b = shapes[i].bounds();
            shift(&mut shapes, &[i], -b.x0, -b.y0);
            (b.x1 - b.x0, b.y1 - b.y0)
        })
        .collect();

    let group_sizes: Vec<(f64, f64)> = sized.iter().map(|g| (g.1, g.2)).collect();
    let all_sizes: Vec<(f64, f64)> = group_sizes.iter().chain(&single_sizes).copied().collect();
    let width = pack::target_width(&all_sizes, BLOCK_GAP, aspect);
    let (group_places, _, groups_height) = pack::shelves(&group_sizes, width, BLOCK_GAP);
    let (single_places, _, _) = pack::shelves(&single_sizes, width, SINGLE_GAP);
    let singles_top = if sized.is_empty() { 0.0 } else { groups_height + BLOCK_GAP };

    let mut members: Vec<Vec<usize>> = Vec::with_capacity(sized.len() + 2);
    let mut group_ids: Vec<usize> = Vec::with_capacity(sized.len());
    for ((nodes, _, _, g), &(x, y)) in sized.into_iter().zip(&group_places) {
        shift(&mut shapes, &nodes, x, y);
        members.push(nodes);
        group_ids.push(g);
    }
    for (&i, &(x, y)) in singles.iter().zip(&single_places) {
        shift(&mut shapes, &[i], x, y + singles_top);
    }
    // Целые места; левый верхний угол всего поля — в нуле
    for s in &mut shapes {
        s.x = s.x.round();
        s.y = s.y.round();
    }
    let everything: Vec<usize> = (0..count).collect();
    let all = union_of(&shapes, &everything);
    shift(&mut shapes, &everything, -all.x0.floor(), -all.y0.floor());

    // Закреплённые: группа с закреплёнными узлами раскладывается заново вокруг них, закреплённая одиночка встаёт на
    // своё место отдельным блоком. Свободный блок, на который они легли, уходит под всё занятое
    let mut anchored: Vec<usize> = Vec::new();
    if !pins.is_empty() {
        let mut pinned_rng = Rng::new(if input.seed.is_finite() && input.seed > 0.0 { input.seed as u64 } else { 0 });
        for (b, nodes) in members.iter().enumerate() {
            if nodes.iter().any(|i| pins.contains_key(i)) {
                let own_edges = &group_edges[group_ids[b]];
                place_group(&graph, &mut shapes, nodes, own_edges, &pins, &mut pinned_rng);
                anchored.push(b);
            }
        }
        singles.retain(|&i| match pins.get(&i) {
            Some(&(x, y)) => {
                shapes[i].x = x;
                shapes[i].y = y;
                anchored.push(members.len());
                members.push(vec![i]);
                false
            }
            None => true,
        });
        for s in &mut shapes {
            s.x = s.x.round();
            s.y = s.y.round();
        }
    }
    let group_blocks = members.len();
    if !singles.is_empty() {
        members.push(singles);
    }
    if !anchored.is_empty() {
        // Свободный блок, на чьи узлы легли закреплённые, не уезжает целиком: его узлы отходят от закреплённых тем же
        // снятием наложений (закреплённые стоят), остальное — на прежних местах
        let pinned_nodes: Vec<usize> = anchored.iter().flat_map(|&b| members[b].iter().copied()).collect();
        let taken: Vec<Rect> = pinned_nodes.iter().map(|&i| shapes[i].bounds()).collect();
        for b in 0..members.len() {
            if anchored.contains(&b) {
                continue;
            }
            let hit = members[b].iter().any(|&i| {
                let r = shapes[i].bounds();
                taken.iter().any(|t| r.x0 < t.x1 && t.x0 < r.x1 && r.y0 < t.y1 && t.y0 < r.y1)
            });
            if !hit {
                continue;
            }
            let nodes: Vec<usize> = members[b].iter().chain(&pinned_nodes).copied().collect();
            let mut part: Vec<Shape> = nodes.iter().map(|&i| shapes[i].clone()).collect();
            let fixed: Vec<bool> = (0..nodes.len()).map(|k| k >= members[b].len()).collect();
            separate::run(&mut part, &fixed);
            for (&i, shape) in members[b].iter().zip(part) {
                shapes[i] = Shape { x: shape.x.round(), y: shape.y.round(), ..shape };
            }
        }
    }
    // С закреплёнными угол поля — где придётся (`bounds.x`, `bounds.y`): места заданы клиентом
    let all = union_of(&shapes, &everything);
    let (left, top) = (all.x0.floor(), all.y0.floor());

    let mut block_of = vec![0usize; count];
    let mut blocks = Vec::with_capacity(members.len());
    for (b, nodes) in members.iter().enumerate() {
        for &i in nodes {
            block_of[i] = b;
        }
        let r = union_of(&shapes, nodes);
        blocks.push(BlockOut { kind: if b < group_blocks { "group" } else { "singles" }, x: int(r.x0), y: int(r.y0), w: int(r.x1 - r.x0), h: int(r.y1 - r.y0), nodes: nodes.len() });
    }
    let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    let edges = edges::shape(&ids, &shapes, &graph.edges, &block_of, &members);
    let nodes = graph
        .nodes
        .iter()
        .zip(&shapes)
        .zip(&block_of)
        .map(|((node, s), &block)| {
            let rect = s.label_at(s.side);
            NodeOut {
                id: node.id.clone(),
                title: node.title.clone(),
                kind: node.kind.as_str(),
                group: node.group.clone(),
                degree: node.degree,
                x: int(s.x),
                y: int(s.y),
                r: int(s.r),
                label: LabelOut { x: int(rect.x0), y: int(rect.y0), w: int(s.label_w), h: int(s.label_h), side: s.side.as_str(), show: s.show },
                block,
            }
        })
        .collect();
    GraphOut { nodes, edges, blocks, bounds: BoundsOut { x: int(left), y: int(top), w: int(all.x1.ceil() - left), h: int(all.y1.ceil() - top) }, folders, tags }
}
