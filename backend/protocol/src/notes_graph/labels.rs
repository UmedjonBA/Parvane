//! Фигура узла (кружок + подпись) и выбор стороны подписи (spec 040 T4): подпись встаёт туда, где её не
//! пересекают связи самого узла; при равных — снизу, затем сверху, справа, слева. Порядок выбора — по
//! приоритету (степень, затем порядок входа); он же решает, чья подпись скрывается, если места не хватило.

/// Зазор между кружком и подписью.
pub(crate) const LABEL_GAP: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Side {
    Bottom,
    Top,
    Right,
    Left,
}

impl Side {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Side::Bottom => "bottom",
            Side::Top => "top",
            Side::Right => "right",
            Side::Left => "left",
        }
    }
}

/// Прямоугольник: левый верхний и правый нижний углы.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub(crate) fn grown(self, by: f64) -> Rect {
        Rect { x0: self.x0 - by, y0: self.y0 - by, x1: self.x1 + by, y1: self.y1 + by }
    }

    pub(crate) fn union(self, other: Rect) -> Rect {
        Rect { x0: self.x0.min(other.x0), y0: self.y0.min(other.y0), x1: self.x1.max(other.x1), y1: self.y1.max(other.y1) }
    }
}

/// Узел на поле: центр, радиус, размер подписи (чётные целые — половины остаются целыми), сторона и показ.
#[derive(Clone, Debug)]
pub(crate) struct Shape {
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub label_w: f64,
    pub label_h: f64,
    pub side: Side,
    pub show: bool,
    pub degree: usize,
}

impl Shape {
    pub(crate) fn circle(&self) -> Rect {
        Rect { x0: self.x - self.r, y0: self.y - self.r, x1: self.x + self.r, y1: self.y + self.r }
    }

    /// Прямоугольник подписи на стороне `side` (без учёта `show`).
    pub(crate) fn label_at(&self, side: Side) -> Rect {
        let (w, h, off) = (self.label_w, self.label_h, self.r + LABEL_GAP);
        match side {
            Side::Bottom => Rect { x0: self.x - w / 2.0, y0: self.y + off, x1: self.x + w / 2.0, y1: self.y + off + h },
            Side::Top => Rect { x0: self.x - w / 2.0, y0: self.y - off - h, x1: self.x + w / 2.0, y1: self.y - off },
            Side::Right => Rect { x0: self.x + off, y0: self.y - h / 2.0, x1: self.x + off + w, y1: self.y + h / 2.0 },
            Side::Left => Rect { x0: self.x - off - w, y0: self.y - h / 2.0, x1: self.x - off, y1: self.y + h / 2.0 },
        }
    }

    /// Показанная подпись.
    pub(crate) fn label(&self) -> Option<Rect> {
        (self.show && self.label_w > 0.0).then(|| self.label_at(self.side))
    }

    /// Всё место узла: кружок вместе с показанной подписью.
    pub(crate) fn bounds(&self) -> Rect {
        match self.label() {
            Some(label) => self.circle().union(label),
            None => self.circle(),
        }
    }
}

/// Отрезок пересекает прямоугольник (Лианг — Барски).
fn segment_hits(x0: f64, y0: f64, x1: f64, y1: f64, rect: &Rect) -> bool {
    let (dx, dy) = (x1 - x0, y1 - y0);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, x0 - rect.x0), (dx, rect.x1 - x0), (-dy, y0 - rect.y0), (dy, rect.y1 - y0)] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                if t > t1 {
                    return false;
                }
                t0 = t0.max(t);
            } else {
                if t < t0 {
                    return false;
                }
                t1 = t1.min(t);
            }
        }
    }
    true
}

/// Номера узлов по приоритету подписи: степень по убыванию, затем порядок входа.
pub(crate) fn priority(shapes: &[Shape]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..shapes.len()).collect();
    order.sort_by(|&a, &b| shapes[b].degree.cmp(&shapes[a].degree).then(a.cmp(&b)));
    order
}

/// Выбирает сторону подписи каждому узлу группы; `adjacency` — соседи по номерам узлов группы.
pub(crate) fn choose_sides(shapes: &mut [Shape], adjacency: &[Vec<usize>]) {
    const SIDES: [(Side, f64); 4] = [(Side::Bottom, 0.0), (Side::Top, 0.5), (Side::Right, 1.0), (Side::Left, 1.0)];
    for i in priority(shapes) {
        if shapes[i].label_w <= 0.0 {
            continue;
        }
        let mut best = (Side::Bottom, f64::MAX);
        for (side, penalty) in SIDES {
            let rect = shapes[i].label_at(side);
            let crossings = adjacency
                .get(i)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|&&j| j < shapes.len() && segment_hits(shapes[i].x, shapes[i].y, shapes[j].x, shapes[j].y, &rect))
                .count();
            let score = crossings as f64 * 2.0 + penalty;
            if score < best.1 {
                best = (side, score);
            }
        }
        shapes[i].side = best.0;
    }
}
