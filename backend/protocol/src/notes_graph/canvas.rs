//! «Холст из графа» (spec 040 T5): карточки связной группы стоят уровнями от её главной заметки (больше всего
//! связей), заметки без связей — сеткой по папкам; блоки упакованы полками. Область — та же, что у графа;
//! карточки получают только существующие заметки. Места кратны шагу сетки холста. Случайности нет.

use std::collections::BTreeMap;

use super::build::{build, pickers, Graph};
use super::layout::{components, edges_by_group, sort_singles};
use super::{int, pack, setting, BlockOut, BoundsOut, CanvasEdgeOut, CanvasOut, CardOut, Input};

/// Наименьшее число карточек в ряду уровня до переноса.
const MIN_PER_ROW: usize = 4;

fn snap(v: f64, grid: f64) -> f64 {
    (v / grid).ceil() * grid
}

struct Sizes {
    card_w: f64,
    card_h: f64,
    step_x: f64,
    step_y: f64,
    gap: f64,
    grid: f64,
}

/// Ряды карточек группы: уровни обходом в ширину от главной заметки, внутри уровня — по среднему месту
/// соседей с прошлого уровня; длинный уровень переносится. Возвращает ряды и уровень каждого узла группы.
fn rows_of(graph: &Graph, members: &[usize], group_edges: &[(usize, usize)]) -> (Vec<Vec<usize>>, Vec<usize>) {
    let n = members.len();
    let mut adj = vec![Vec::new(); n];
    for &(a, b) in group_edges {
        adj[a].push(b);
        adj[b].push(a);
    }
    let mut root = 0;
    for k in 0..n {
        if graph.nodes[members[k]].degree > graph.nodes[members[root]].degree {
            root = k;
        }
    }
    let mut level = vec![usize::MAX; n];
    // Место узла в его уровне (для среднего по соседям)
    let mut slot = vec![0.0f64; n];
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let per_row = MIN_PER_ROW.max(((n as f64).sqrt() * 1.5).ceil() as usize);
    let mut current = vec![root];
    level[root] = 0;
    let mut depth = 0;
    while !current.is_empty() {
        for (place, &k) in current.iter().enumerate() {
            slot[k] = place as f64;
        }
        for chunk in current.chunks(per_row) {
            rows.push(chunk.to_vec());
        }
        let mut next: Vec<(f64, usize)> = Vec::new();
        let mut parents: BTreeMap<usize, (f64, f64)> = BTreeMap::new();
        for &k in &current {
            for &other in &adj[k] {
                if level[other] == usize::MAX || level[other] == depth + 1 {
                    level[other] = depth + 1;
                    let sum = parents.entry(other).or_insert((0.0, 0.0));
                    *sum = (sum.0 + slot[k], sum.1 + 1.0);
                }
            }
        }
        for (other, (sum, count)) in parents {
            next.push((sum / count, other));
        }
        next.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        current = next.into_iter().map(|(_, k)| k).collect();
        depth += 1;
    }
    (rows, level)
}

pub(crate) fn canvas(input: &Input) -> CanvasOut {
    let mut scoped = input.clone();
    scoped.hide_missing = true;
    scoped.with_records = false;
    let graph = build(&scoped);
    let (folders, tags) = pickers(input);
    let count = graph.nodes.len();
    let grid = setting(input.grid, 10.0, 1.0, 100.0).round();
    let gap = snap(setting(input.gap, 60.0, 10.0, 400.0), grid);
    let card_w = snap(setting(input.card_width, 250.0, 60.0, 1000.0), grid);
    let card_h = snap(setting(input.card_height, 140.0, 40.0, 1000.0), grid);
    let sizes = Sizes { card_w, card_h, step_x: card_w + gap, step_y: card_h + gap, gap, grid };
    let aspect = setting(input.aspect, 1.5, 0.5, 4.0);

    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut singles: Vec<usize> = Vec::new();
    for members in components(count, &graph.edges) {
        match members.as_slice() {
            [one] => singles.push(*one),
            _ => groups.push(members),
        }
    }
    let (group_edges, _) = edges_by_group(&groups, count, &graph.edges);

    // Места карточек (левый верхний угол) и уровни; сначала — внутри своего блока
    let mut place = vec![(0.0f64, 0.0f64); count];
    let mut level_of = vec![0usize; count];
    let mut sized: Vec<(Vec<usize>, f64, f64)> = Vec::with_capacity(groups.len());
    for (members, own_edges) in groups.into_iter().zip(&group_edges) {
        let (rows, level) = rows_of(&graph, &members, own_edges);
        let widest = rows.iter().map(Vec::len).max().unwrap_or(1);
        for (row, cards) in rows.iter().enumerate() {
            let indent = snap((widest - cards.len()) as f64 * sizes.step_x / 2.0, sizes.grid);
            for (col, &k) in cards.iter().enumerate() {
                place[members[k]] = (indent + col as f64 * sizes.step_x, row as f64 * sizes.step_y);
                level_of[members[k]] = level[k];
            }
        }
        let w = (widest.max(1) - 1) as f64 * sizes.step_x + sizes.card_w;
        let h = (rows.len().max(1) - 1) as f64 * sizes.step_y + sizes.card_h;
        sized.push((members, w, h));
    }
    sized.sort_by(|a, b| b.2.total_cmp(&a.2));

    sort_singles(&graph, &mut singles);
    let block_gap = snap(sizes.gap * 2.0, sizes.grid);
    let group_sizes: Vec<(f64, f64)> = sized.iter().map(|g| (g.1, g.2)).collect();
    let single_sizes = vec![(sizes.card_w, sizes.card_h); singles.len()];
    let all_sizes: Vec<(f64, f64)> = group_sizes.iter().chain(&single_sizes).copied().collect();
    let width = pack::target_width(&all_sizes, block_gap, aspect);
    let (group_places, _, groups_height) = pack::shelves(&group_sizes, width, block_gap);
    let (single_places, _, _) = pack::shelves(&single_sizes, width, sizes.gap);
    let singles_top = if sized.is_empty() { 0.0 } else { groups_height + block_gap };

    let mut block_of = vec![0usize; count];
    let mut blocks = Vec::new();
    let (mut right, mut bottom) = (0.0f64, 0.0f64);
    for (b, ((nodes, w, h), &(x, y))) in sized.iter().zip(&group_places).enumerate() {
        for &i in nodes {
            place[i] = (place[i].0 + x, place[i].1 + y);
            block_of[i] = b;
        }
        blocks.push(BlockOut { kind: "group", x: int(x), y: int(y), w: int(*w), h: int(*h), nodes: nodes.len() });
        right = right.max(x + w);
        bottom = bottom.max(y + h);
    }
    if !singles.is_empty() {
        let block = blocks.len();
        let (mut w, mut h) = (0.0f64, 0.0f64);
        for (&i, &(x, y)) in singles.iter().zip(&single_places) {
            place[i] = (x, y + singles_top);
            block_of[i] = block;
            w = w.max(x + sizes.card_w);
            h = h.max(y + sizes.card_h);
        }
        blocks.push(BlockOut { kind: "singles", x: 0, y: int(singles_top), w: int(w), h: int(h), nodes: singles.len() });
        right = right.max(w);
        bottom = bottom.max(singles_top + h);
    }

    let cards = graph
        .nodes
        .iter()
        .enumerate()
        .map(|(i, node)| CardOut {
            id: node.id.clone(),
            title: node.title.clone(),
            kind: node.kind.as_str(),
            folder: node.group.clone().unwrap_or_default(),
            x: int(place[i].0),
            y: int(place[i].1),
            width: int(sizes.card_w),
            height: int(sizes.card_h),
            level: level_of[i],
            block: block_of[i],
        })
        .collect();
    let edges = graph
        .edges
        .iter()
        .filter(|e| e.a < count && e.b < count)
        .map(|e| {
            let (from, to) = (place[e.a], place[e.b]);
            let (from_side, to_side) = if from.1 < to.1 {
                ("bottom", "top")
            } else if from.1 > to.1 {
                ("top", "bottom")
            } else if from.0 <= to.0 {
                ("right", "left")
            } else {
                ("left", "right")
            };
            CanvasEdgeOut { from: graph.nodes[e.a].id.clone(), to: graph.nodes[e.b].id.clone(), mutual: e.mutual, from_side, to_side }
        })
        .collect();
    CanvasOut { cards, edges, blocks, bounds: BoundsOut { x: 0, y: 0, w: int(right), h: int(bottom) }, folders, tags }
}
