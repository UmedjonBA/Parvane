//! Силовая раскладка одной связной группы (spec 040 T1): узел — не точка, а кружок с подписью; длина связи
//! растёт со степенью концов и шириной подписей; заметки одной папки стягиваются друг к другу (T2). Общего
//! притяжения к центру поля нет: группы раскладываются порознь и потом упаковываются.
//!
//! Только `+ − × ÷ √`; порядок пар фиксирован — результат одинаков на всех платформах.

use super::rng::Rng;

/// Отталкивание пары на расстоянии `d`: `REPULSION / d`.
const REPULSION: f64 = 1100.0;
const SPRING: f64 = 0.6;
const GRAVITY: f64 = 0.015;
const CLUSTER: f64 = 0.03;
/// Сила расталкивания наложившихся прямоугольников «кружок + подпись».
const COLLIDE: f64 = 0.6;
/// С этого числа узлов отталкивание считается по сетке и только до `CUTOFF`.
const GRID_FROM: usize = 300;
const CUTOFF: f64 = 420.0;
const MAX_CELLS: usize = 256;
const START_TEMPERATURE: f64 = 50.0;
/// Свободная часть длины связи и прибавки за степень и подписи концов.
const EDGE_BASE: f64 = 50.0;
const EDGE_PER_DEGREE: f64 = 10.0;
const EDGE_PER_LABEL: f64 = 0.2;

/// Узел в раскладке: радиус, полуразмеры места под кружок с подписью, ширина подписи, степень, папка.
pub(crate) struct Body {
    pub r: f64,
    pub half_w: f64,
    pub half_h: f64,
    pub label_w: f64,
    pub degree: usize,
    /// Номер папки внутри группы.
    pub cluster: usize,
}

fn sqrt_of(count: usize) -> f64 {
    (count as f64).sqrt()
}

/// Желаемая длина связи между центрами.
fn ideal_length(a: &Body, b: &Body) -> f64 {
    a.r + b.r + EDGE_BASE + EDGE_PER_DEGREE * (sqrt_of(a.degree) + sqrt_of(b.degree)) + EDGE_PER_LABEL * (a.label_w + b.label_w)
}

struct Sim<'a> {
    bodies: &'a [Body],
    weight: Vec<f64>,
    pos: Vec<(f64, f64)>,
    disp: Vec<(f64, f64)>,
}

impl Sim<'_> {
    /// Отталкивание и расталкивание наложений пары `i < j`.
    fn repel(&mut self, i: usize, j: usize, limited: bool) {
        let (mut dx, mut dy) = (self.pos[i].0 - self.pos[j].0, self.pos[i].1 - self.pos[j].1);
        let mut d2 = dx * dx + dy * dy;
        if d2 < 1e-4 {
            // Совпавшие узлы разводятся в сторону, заданную их номерами
            dx = 0.1 + 0.01 * ((i % 7) as f64);
            dy = 0.1 + 0.01 * ((j % 5) as f64);
            d2 = dx * dx + dy * dy;
        }
        if limited && d2 > CUTOFF * CUTOFF {
            return;
        }
        let d = d2.sqrt();
        let force = REPULSION * self.weight[i] * self.weight[j] / d;
        let (mut fx, mut fy) = (dx / d * force, dy / d * force);
        let (a, b) = (&self.bodies[i], &self.bodies[j]);
        let (over_x, over_y) = (a.half_w + b.half_w - dx.abs(), a.half_h + b.half_h - dy.abs());
        if over_x > 0.0 && over_y > 0.0 {
            if over_x < over_y {
                fx += if dx < 0.0 { -over_x } else { over_x } * COLLIDE;
            } else {
                fy += if dy < 0.0 { -over_y } else { over_y } * COLLIDE;
            }
        }
        self.disp[i].0 += fx;
        self.disp[i].1 += fy;
        self.disp[j].0 -= fx;
        self.disp[j].1 -= fy;
    }

    fn repel_all(&mut self) {
        let n = self.bodies.len();
        for i in 0..n {
            for j in (i + 1)..n {
                self.repel(i, j, false);
            }
        }
    }

    /// То же по сетке ячеек со стороной `CUTOFF`: пары внутри ячейки и с четырьмя соседними (каждая пара — раз).
    fn repel_by_grid(&mut self) {
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for &(x, y) in &self.pos {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        let cells = |span: f64| (((span / CUTOFF).floor() as usize).saturating_add(1)).clamp(1, MAX_CELLS);
        let (cols, rows) = (cells(max_x - min_x), cells(max_y - min_y));
        let cell_of = |v: f64, min: f64, count: usize| (((v - min) / CUTOFF).floor() as usize).min(count - 1);
        let mut grid: Vec<Vec<usize>> = vec![Vec::new(); cols * rows];
        for (i, &(x, y)) in self.pos.iter().enumerate() {
            grid[cell_of(y, min_y, rows) * cols + cell_of(x, min_x, cols)].push(i);
        }
        for row in 0..rows {
            for col in 0..cols {
                let here = std::mem::take(&mut grid[row * cols + col]);
                for (k, &i) in here.iter().enumerate() {
                    for &j in &here[k + 1..] {
                        self.repel(i.min(j), i.max(j), true);
                    }
                }
                let mut neighbours: Vec<usize> = Vec::with_capacity(4);
                if col + 1 < cols {
                    neighbours.push(row * cols + col + 1);
                }
                if row + 1 < rows {
                    if col > 0 {
                        neighbours.push((row + 1) * cols + col - 1);
                    }
                    neighbours.push((row + 1) * cols + col);
                    if col + 1 < cols {
                        neighbours.push((row + 1) * cols + col + 1);
                    }
                }
                for cell in neighbours {
                    for &i in &here {
                        for k in 0..grid[cell].len() {
                            let j = grid[cell][k];
                            self.repel(i.min(j), i.max(j), true);
                        }
                    }
                }
                grid[row * cols + col] = here;
            }
        }
    }
}

/// Места центров узлов группы (вокруг нуля). `edges` — пары номеров узлов группы.
pub(crate) fn run(bodies: &[Body], edges: &[(usize, usize)], rng: &mut Rng) -> Vec<(f64, f64)> {
    let n = bodies.len();
    let spread = sqrt_of(n) * 110.0;
    let pos = (0..n).map(|_| ((rng.unit() - 0.5) * spread, (rng.unit() - 0.5) * spread)).collect();
    let mut sim = Sim { bodies, weight: bodies.iter().map(|b| 1.0 + 0.25 * sqrt_of(b.degree)).collect(), pos, disp: vec![(0.0, 0.0); n] };
    let edges: Vec<(usize, usize, f64)> = edges.iter().filter(|&&(a, b)| a < n && b < n).map(|&(a, b)| (a, b, ideal_length(&bodies[a], &bodies[b]))).collect();
    let cluster_count = bodies.iter().map(|b| b.cluster + 1).max().unwrap_or(0);
    // Число шагов и остывание подобраны так, чтобы температура дошла до ~0,5
    let (steps, cooling) = if n <= GRID_FROM {
        (300, 0.9848)
    } else if n <= 1500 {
        (200, 0.9772)
    } else {
        (120, 0.9624)
    };
    let mut temperature = START_TEMPERATURE;
    for _ in 0..steps {
        sim.disp.iter_mut().for_each(|d| *d = (0.0, 0.0));
        if n <= GRID_FROM {
            sim.repel_all();
        } else {
            sim.repel_by_grid();
        }
        for &(a, b, length) in &edges {
            let (dx, dy) = (sim.pos[a].0 - sim.pos[b].0, sim.pos[a].1 - sim.pos[b].1);
            let d = (dx * dx + dy * dy).sqrt();
            if d < 1e-3 {
                continue;
            }
            let pull = (d - length) * SPRING / d;
            sim.disp[a].0 -= dx * pull;
            sim.disp[a].1 -= dy * pull;
            sim.disp[b].0 += dx * pull;
            sim.disp[b].1 += dy * pull;
        }
        if cluster_count > 1 {
            let mut centres = vec![(0.0, 0.0, 0.0); cluster_count];
            for (i, body) in bodies.iter().enumerate() {
                let c = &mut centres[body.cluster];
                *c = (c.0 + sim.pos[i].0, c.1 + sim.pos[i].1, c.2 + 1.0);
            }
            for (i, body) in bodies.iter().enumerate() {
                let c = centres[body.cluster];
                if c.2 > 1.0 {
                    sim.disp[i].0 += (c.0 / c.2 - sim.pos[i].0) * CLUSTER;
                    sim.disp[i].1 += (c.1 / c.2 - sim.pos[i].1) * CLUSTER;
                }
            }
        }
        for i in 0..n {
            let (x, y) = sim.pos[i];
            let (fx, fy) = (sim.disp[i].0 - x * GRAVITY, sim.disp[i].1 - y * GRAVITY);
            let length = (fx * fx + fy * fy).sqrt();
            if length > 1e-9 && length.is_finite() {
                let step = length.min(temperature) / length;
                sim.pos[i] = (x + fx * step, y + fy * step);
            }
        }
        temperature *= cooling;
    }
    sim.pos
}
