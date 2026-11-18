//! Форма связей (spec 040 T4): линия идёт от края кружка до края кружка; если прямая задевает чужой кружок
//! той же группы, связь становится дугой в обход него (квадратичная кривая с одной опорной точкой).

use super::build::GEdge;
use super::labels::Shape;
use super::{int, EdgeOut};

/// Зазор между линией и кружком на концах и просвет до обходимого кружка.
const END_GAP: f64 = 3.0;
const CLEARANCE: f64 = 6.0;
/// В группах крупнее обход не считается (число проверок растёт как связи × узлы).
const BEND_MAX_NODES: usize = 400;

/// Линии связей по готовым (целым) местам узлов. `block_of` — номер блока узла, `members` — узлы блоков.
pub(crate) fn shape(ids: &[&str], shapes: &[Shape], edges: &[GEdge], block_of: &[usize], members: &[Vec<usize>]) -> Vec<EdgeOut> {
    let mut out = Vec::with_capacity(edges.len());
    for e in edges {
        let (Some(a), Some(b), Some(from), Some(to)) = (shapes.get(e.a), shapes.get(e.b), ids.get(e.a), ids.get(e.b)) else { continue };
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let length = (dx * dx + dy * dy).sqrt();
        let mut edge = EdgeOut {
            from: (*from).to_string(),
            to: (*to).to_string(),
            mutual: e.mutual,
            x1: int(a.x),
            y1: int(a.y),
            cx: int((a.x + b.x) / 2.0),
            cy: int((a.y + b.y) / 2.0),
            x2: int(b.x),
            y2: int(b.y),
            curved: false,
        };
        if length > a.r + b.r + END_GAP * 2.0 + 1.0 {
            let (ux, uy) = (dx / length, dy / length);
            edge.x1 = int(a.x + ux * (a.r + END_GAP));
            edge.y1 = int(a.y + uy * (a.r + END_GAP));
            edge.x2 = int(b.x - ux * (b.r + END_GAP));
            edge.y2 = int(b.y - uy * (b.r + END_GAP));
            let group = block_of.get(e.a).and_then(|&block| members.get(block)).map(Vec::as_slice).unwrap_or_default();
            // Самый задетый чужой кружок: (проникновение, место вдоль связи, сторона)
            let mut worst: Option<(f64, f64, f64)> = None;
            if group.len() <= BEND_MAX_NODES {
                for &k in group {
                    let Some(other) = shapes.get(k).filter(|_| k != e.a && k != e.b) else { continue };
                    let (px, py) = (other.x - a.x, other.y - a.y);
                    let along = px * ux + py * uy;
                    if along <= 0.0 || along >= length {
                        continue;
                    }
                    let across = ux * py - uy * px;
                    let depth = other.r + CLEARANCE - across.abs();
                    if depth > 0.0 && worst.map_or(true, |w| depth > w.0) {
                        worst = Some((depth, along, across));
                    }
                }
            }
            if let Some((depth, along, across)) = worst {
                // Смещение кривой в точке t равно 2t(1 − t) × вынос опорной точки
                let t = (along / length).clamp(0.2, 0.8);
                let offset = ((depth + CLEARANCE) / (2.0 * t * (1.0 - t))).min(length * 0.5 + 40.0);
                let away = if across > 0.0 { -offset } else { offset };
                edge.cx = int((a.x + b.x) / 2.0 - uy * away);
                edge.cy = int((a.y + b.y) / 2.0 + ux * away);
                edge.curved = true;
            }
        }
        out.push(edge);
    }
    out
}
