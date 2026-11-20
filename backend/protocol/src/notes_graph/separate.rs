//! Снятие наложений внутри группы (spec 040 T1): кружки и показанные подписи разных узлов не пересекаются и
//! держат зазор. Пары ищутся по сетке, узлы раздвигаются по оси наименьшего проникновения, пока наложений не
//! останется. Если за отведённые проходы место не нашлось, подпись узла с меньшим приоритетом скрывается.

use super::labels::{Rect, Shape};

/// Половина наименьшего зазора между фигурами разных узлов.
pub(crate) const PAD: f64 = 3.0;
const PASSES: usize = 400;
const ROUNDS: usize = 4;
/// Растяжение: шаг, число шагов и доля пар с наложением (1 / `SPREAD_UNTIL` от числа узлов), при которой оно прекращается.
const SPREAD: f64 = 1.1;
const SPREAD_STEPS: usize = 12;
const SPREAD_UNTIL: usize = 8;
/// Группы меньше не растягиваются: им хватает проходов.
const SPREAD_FROM: usize = 60;

/// Наибольшее из нужных смещений пары: ось (`true` — по x) и величина; `None` — фигуры не пересекаются.
fn push_of(a: &Shape, b: &Shape) -> Option<(bool, f64, bool)> {
    let rects = |s: &Shape| [Some(s.circle().grown(PAD)), s.label().map(|l| l.grown(PAD))];
    let mut worst: Option<(bool, f64, bool)> = None;
    for ra in rects(a).into_iter().flatten() {
        for rb in rects(b).into_iter().flatten() {
            let (ox, oy) = (ra.x1.min(rb.x1) - ra.x0.max(rb.x0), ra.y1.min(rb.y1) - ra.y0.max(rb.y0));
            if ox <= 0.0 || oy <= 0.0 {
                continue;
            }
            let along_x = ox < oy;
            let amount = if along_x { ox } else { oy };
            // Куда уходит `a`: от центра прямоугольника `b`
            let a_first = if along_x { ra.x0 + ra.x1 <= rb.x0 + rb.x1 } else { ra.y0 + ra.y1 <= rb.y0 + rb.y1 };
            if worst.map_or(true, |w| amount > w.1) {
                worst = Some((along_x, amount, a_first));
            }
        }
    }
    worst
}

/// Пары узлов, чьи места (с запасом) могут пересекаться: по сетке со стороной наибольшего места.
fn candidates(shapes: &[Shape]) -> Vec<(usize, usize)> {
    let boxes: Vec<Rect> = shapes.iter().map(|s| s.bounds().grown(PAD)).collect();
    let mut cell = 1.0f64;
    let (mut min_x, mut min_y) = (f64::MAX, f64::MAX);
    for b in &boxes {
        cell = cell.max(b.x1 - b.x0).max(b.y1 - b.y0);
        min_x = min_x.min((b.x0 + b.x1) / 2.0);
        min_y = min_y.min((b.y0 + b.y1) / 2.0);
    }
    let mut keyed: Vec<(i64, i64, usize)> = boxes
        .iter()
        .enumerate()
        .map(|(i, b)| ((((b.x0 + b.x1) / 2.0 - min_x) / cell).floor() as i64, (((b.y0 + b.y1) / 2.0 - min_y) / cell).floor() as i64, i))
        .collect();
    keyed.sort_unstable();
    let find = |cx: i64, cy: i64| -> &[(i64, i64, usize)] {
        let start = keyed.partition_point(|k| (k.0, k.1) < (cx, cy));
        let end = keyed.partition_point(|k| (k.0, k.1) <= (cx, cy));
        keyed.get(start..end).unwrap_or_default()
    };
    let mut pairs = Vec::new();
    for &(cx, cy, i) in &keyed {
        for (dx, dy) in [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 0), (0, 1), (1, -1), (1, 0), (1, 1)] {
            for &(_, _, j) in find(cx + dx, cy + dy) {
                if i < j {
                    let (a, b) = (&boxes[i], &boxes[j]);
                    if a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 {
                        pairs.push((i, j));
                    }
                }
            }
        }
    }
    pairs.sort_unstable();
    pairs
}

/// Один проход: раздвигает пересекающиеся пары; возвращает оставшиеся до сдвига наложения. Закреплённый узел
/// (`fixed`) не двигается: отходит другой узел пары на весь шаг; два закреплённых остаются как есть.
fn pass(shapes: &mut [Shape], fixed: &[bool]) -> Vec<(usize, usize)> {
    let mut hits = Vec::new();
    for (i, j) in candidates(shapes) {
        let Some((along_x, amount, i_first)) = push_of(&shapes[i], &shapes[j]) else { continue };
        let (i_fixed, j_fixed) = (fixed.get(i) == Some(&true), fixed.get(j) == Some(&true));
        if i_fixed && j_fixed {
            continue;
        }
        hits.push((i, j));
        let half = amount / 2.0 + 0.25;
        let step = if i_first { -half } else { half };
        let (step_i, step_j) = if i_fixed {
            (0.0, step * 2.0)
        } else if j_fixed {
            (step * 2.0, 0.0)
        } else {
            (step, step)
        };
        if along_x {
            shapes[i].x += step_i;
            shapes[j].x -= step_j;
        } else {
            shapes[i].y += step_i;
            shapes[j].y -= step_j;
        }
    }
    hits
}

/// Раздвигает узлы группы до отсутствия наложений; закреплённые (`fixed`) стоят на месте.
pub(crate) fn run(shapes: &mut [Shape], fixed: &[bool]) {
    // Тесную раскладку сначала растягивают целиком: так сохраняется её рисунок, а проходам остаётся мелочь.
    // С закреплёнными узлами не растягивают — их места заданы
    let has_fixed = fixed.contains(&true);
    for _ in 0..SPREAD_STEPS {
        let crowded = candidates(shapes).into_iter().filter(|&(i, j)| push_of(&shapes[i], &shapes[j]).is_some()).count();
        if has_fixed || shapes.len() < SPREAD_FROM || crowded * SPREAD_UNTIL <= shapes.len() {
            break;
        }
        for s in shapes.iter_mut() {
            s.x *= SPREAD;
            s.y *= SPREAD;
        }
    }
    for round in 0..ROUNDS {
        let mut left = Vec::new();
        for _ in 0..PASSES {
            left = pass(shapes, fixed);
            if left.is_empty() {
                return;
            }
        }
        // Места не хватило: в каждой оставшейся паре скрывается подпись узла с меньшим приоритетом,
        // в последнем круге — обе
        for (i, j) in left {
            let lower = if shapes[i].degree < shapes[j].degree { i } else { j };
            shapes[lower].show = false;
            if round + 2 >= ROUNDS {
                shapes[i].show = false;
                shapes[j].show = false;
            }
        }
    }
}
