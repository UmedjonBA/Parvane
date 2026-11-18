//! Узлы и связи графа из заметок и область показа (spec 040 T3).
//!
//! Ссылка на название без заметки даёт один узел `missing` на название (без учёта регистра); ссылка на
//! заметку вне области не рисуется (заметка существует — «ещё нет» про неё сказать нельзя). На пару узлов
//! одна связь в сторону первой найденной ссылки, встречная помечает её `mutual`; петель нет. Записи «Плана»
//! с одним названием — один узел. Порядок узлов и связей — порядок входа.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use super::{FolderOut, Input, Kind, NoteIn, Scope, TagOut};

pub(crate) const MISSING_PREFIX: &str = "missing:";
const MAX_DEPTH: u32 = 3;

pub(crate) struct GNode {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub group: Option<String>,
    pub degree: usize,
}

/// Связь: `a` ссылается на `b` (номера узлов).
pub(crate) struct GEdge {
    pub a: usize,
    pub b: usize,
    pub mutual: bool,
}

#[derive(Default)]
pub(crate) struct Graph {
    pub nodes: Vec<GNode>,
    pub edges: Vec<GEdge>,
}

fn title_key(title: &str) -> String {
    title.trim().to_lowercase()
}

fn tag_key(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_lowercase()
}

/// Папка `folder` — это `path` либо его подпапка.
fn in_folder(folder: &str, path: &str) -> bool {
    folder == path || folder.strip_prefix(path).is_some_and(|rest| rest.starts_with('/'))
}

fn is_visible(note: &NoteIn, input: &Input) -> bool {
    if note.is_daily {
        return input.with_days;
    }
    match &input.scope {
        Scope::Folder { folder } => in_folder(&note.folder, folder),
        Scope::Tag { tag } => {
            let wanted = tag_key(tag);
            !wanted.is_empty()
                && note.tags.iter().any(|t| {
                    let key = tag_key(t);
                    key == wanted || in_folder(&key, &wanted)
                })
        }
        Scope::All | Scope::Around { .. } => true,
    }
}

struct Builder<'a> {
    input: &'a Input,
    graph: Graph,
    by_id: BTreeMap<String, usize>,
    by_title: BTreeMap<String, usize>,
    /// Названия существующих заметок вне области.
    hidden: BTreeSet<String>,
    by_pair: BTreeMap<(usize, usize), usize>,
}

impl Builder<'_> {
    fn add(&mut self, id: &str, title: &str, kind: Kind, group: Option<String>) -> usize {
        let index = self.graph.nodes.len();
        self.graph.nodes.push(GNode { id: id.to_string(), title: title.to_string(), kind, group, degree: 0 });
        self.by_id.insert(id.to_string(), index);
        index
    }

    fn is_resolvable(&self, link: &str) -> bool {
        let key = title_key(link);
        !key.is_empty() && !self.hidden.contains(&key) && (self.by_title.contains_key(&key) || !self.input.hide_missing)
    }

    fn target(&mut self, link: &str) -> Option<usize> {
        if !self.is_resolvable(link) {
            return None;
        }
        let key = title_key(link);
        if let Some(&index) = self.by_title.get(&key) {
            return Some(index);
        }
        let id = format!("{MISSING_PREFIX}{key}");
        if let Some(&index) = self.by_id.get(&id) {
            return Some(index);
        }
        Some(self.add(&id, link.trim(), Kind::Missing, None))
    }

    fn connect(&mut self, from: usize, links: &[String]) {
        for link in links {
            let Some(to) = self.target(link) else { continue };
            if to == from {
                continue;
            }
            let pair = (from.min(to), from.max(to));
            if let Some(&known) = self.by_pair.get(&pair) {
                if let Some(edge) = self.graph.edges.get_mut(known) {
                    if edge.a == to {
                        edge.mutual = true;
                    }
                }
                continue;
            }
            self.by_pair.insert(pair, self.graph.edges.len());
            self.graph.edges.push(GEdge { a: from, b: to, mutual: false });
        }
    }
}

/// Оставляет узлы с `keep`, связи между ними — с новыми номерами.
fn retain(graph: Graph, keep: &[bool]) -> Graph {
    let mut index = vec![usize::MAX; graph.nodes.len()];
    let mut nodes = Vec::new();
    for (i, node) in graph.nodes.into_iter().enumerate() {
        if keep.get(i).copied().unwrap_or(false) {
            index[i] = nodes.len();
            nodes.push(node);
        }
    }
    let at = |i: usize| index.get(i).copied().filter(|&v| v != usize::MAX);
    let edges = graph.edges.into_iter().filter_map(|e| Some(GEdge { a: at(e.a)?, b: at(e.b)?, mutual: e.mutual })).collect();
    Graph { nodes, edges }
}

/// Соседи узлов (без повторов: связь на пару одна).
pub(crate) fn adjacency(count: usize, edges: &[GEdge]) -> Vec<Vec<usize>> {
    let mut out = vec![Vec::new(); count];
    for e in edges {
        if e.a < count && e.b < count {
            out[e.a].push(e.b);
            out[e.b].push(e.a);
        }
    }
    out
}

/// Узлы не дальше `depth` связей от `start`.
fn around(graph: &Graph, start: usize, depth: u32) -> Vec<bool> {
    let adj = adjacency(graph.nodes.len(), &graph.edges);
    let mut keep = vec![false; graph.nodes.len()];
    let mut queue = VecDeque::from([(start, 0u32)]);
    if let Some(k) = keep.get_mut(start) {
        *k = true;
    }
    while let Some((node, dist)) = queue.pop_front() {
        if dist >= depth {
            continue;
        }
        for &next in adj.get(node).map(Vec::as_slice).unwrap_or_default() {
            if !keep[next] {
                keep[next] = true;
                queue.push_back((next, dist + 1));
            }
        }
    }
    keep
}

pub(crate) fn build(input: &Input) -> Graph {
    let mut b = Builder { input, graph: Graph::default(), by_id: BTreeMap::new(), by_title: BTreeMap::new(), hidden: BTreeSet::new(), by_pair: BTreeMap::new() };
    let mut shown: Vec<(usize, &NoteIn)> = Vec::new();
    for note in &input.notes {
        if !is_visible(note, input) || b.by_id.contains_key(&note.id) {
            continue;
        }
        let index = b.add(&note.id, &note.title, if note.is_daily { Kind::Day } else { Kind::Note }, Some(note.folder.clone()));
        shown.push((index, note));
        // Заметки с одним названием: ссылка ведёт на первую
        let key = title_key(&note.title);
        if !key.is_empty() {
            b.by_title.entry(key).or_insert(index);
        }
    }
    for note in &input.notes {
        let key = title_key(&note.title);
        if !is_visible(note, input) && !key.is_empty() && !b.by_title.contains_key(&key) {
            b.hidden.insert(key);
        }
    }
    for (index, note) in shown {
        b.connect(index, &note.links);
    }
    if input.with_records {
        let mut by_title: BTreeMap<String, usize> = BTreeMap::new();
        for record in &input.records {
            let key = title_key(&record.title);
            let index = match by_title.get(&key) {
                Some(&index) => index,
                None => {
                    // Запись без показанных ссылок на графе не нужна; id занятого узла — пропуск
                    if !record.links.iter().any(|l| b.is_resolvable(l)) || b.by_id.contains_key(&record.id) {
                        continue;
                    }
                    let group = (!record.kind.is_empty()).then(|| record.kind.clone());
                    let index = b.add(&record.id, &record.title, Kind::Record, group);
                    by_title.insert(key, index);
                    index
                }
            };
            b.connect(index, &record.links);
        }
    }
    let mut graph = b.graph;
    if let Scope::Around { note, depth } = &input.scope {
        let keep = match graph.nodes.iter().position(|n| n.kind != Kind::Missing && &n.id == note) {
            Some(start) => around(&graph, start, (*depth).clamp(1, MAX_DEPTH)),
            None => vec![false; graph.nodes.len()],
        };
        graph = retain(graph, &keep);
    }
    count_degrees(&mut graph);
    if input.hide_orphans {
        let keep: Vec<bool> = graph.nodes.iter().map(|n| n.degree > 0).collect();
        graph = retain(graph, &keep);
        count_degrees(&mut graph);
    }
    graph
}

fn count_degrees(graph: &mut Graph) {
    for node in &mut graph.nodes {
        node.degree = 0;
    }
    for i in 0..graph.edges.len() {
        let (a, b) = (graph.edges[i].a, graph.edges[i].b);
        for end in [a, b] {
            if let Some(node) = graph.nodes.get_mut(end) {
                node.degree += 1;
            }
        }
    }
}

/// Папки с обычными заметками (корень первым, дальше по пути) и метки (по названию) — для выбора области.
pub(crate) fn pickers(input: &Input) -> (Vec<FolderOut>, Vec<TagOut>) {
    let mut folders: BTreeMap<&str, usize> = BTreeMap::new();
    let mut tags: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for note in input.notes.iter().filter(|n| !n.is_daily) {
        *folders.entry(note.folder.as_str()).or_insert(0) += 1;
        let mut seen = BTreeSet::new();
        for tag in &note.tags {
            let key = tag_key(tag);
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            let shown = tag.trim().trim_start_matches('#').to_string();
            tags.entry(key).or_insert((shown, 0)).1 += 1;
        }
    }
    (
        folders.into_iter().map(|(path, count)| FolderOut { path: path.to_string(), count }).collect(),
        tags.into_values().map(|(tag, count)| TagOut { tag, count }).collect(),
    )
}
