//! Очередь плеера «Музыки» (spec 039, 041; правило MUSIC-1): единственная реализация порядка воспроизведения
//! для всех клиентов — что играет следующим, «вперемешку», повтор, правка очереди. Клиент хранит очередь как
//! JSON и только воспроизводит трек с номером `index`. Общий образец — `conformance/music-queue/cases.json`.
//!
//! Состояние: `{tracks:[id…], index, shuffle, repeat:"off"|"all"|"one", order:[номера tracks], seed}`.
//! `order` — порядок проигрывания (без «вперемешку» — по порядку списка); `index` — место в `order`;
//! `-1` — очередь пуста либо доиграна.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Треков в очереди: больше — отбрасывается хвост.
pub const MAX_QUEUE: usize = 2000;
const MAX_ID: usize = 64;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Queue {
    pub tracks: Vec<String>,
    pub index: i64,
    pub shuffle: bool,
    pub repeat: Repeat,
    pub order: Vec<usize>,
    pub seed: u64,
}

impl Default for Queue {
    /// Пустая очередь: ничего не играет.
    fn default() -> Self {
        Queue { tracks: Vec::new(), index: -1, shuffle: false, repeat: Repeat::Off, order: Vec::new(), seed: 0 }
    }
}

impl Queue {
    /// Приведение сохранённого: негодные id отброшены, порядок — перестановка номеров, номер — в границах.
    pub fn normalize(raw: &Value) -> Queue {
        let mut q: Queue = serde_json::from_value(raw.clone()).unwrap_or_default();
        q.tracks.retain(|id| !id.is_empty() && id.len() <= MAX_ID);
        q.tracks.truncate(MAX_QUEUE);
        let n = q.tracks.len();
        let mut seen = vec![false; n];
        let is_permutation = q.order.len() == n && q.order.iter().all(|i| *i < n && !std::mem::replace(&mut seen[*i], true));
        if !is_permutation {
            q.order = (0..n).collect();
            if q.shuffle {
                shuffle_tail(&mut q.order, 0, q.seed);
            }
        }
        if n == 0 || q.index < -1 || q.index >= n as i64 {
            q.index = -1;
        }
        q
    }

    /// Номер играющего трека в `tracks`.
    pub fn current(&self) -> Option<usize> {
        usize::try_from(self.index).ok().and_then(|i| self.order.get(i)).copied()
    }

    /// Новая очередь, играет трек с номером `start` списка.
    pub fn start(tracks: Vec<String>, start: usize, shuffle: bool, repeat: Repeat, seed: u64) -> Queue {
        let mut q = Queue { tracks, shuffle, repeat, seed, ..Default::default() };
        q.tracks.retain(|id| !id.is_empty() && id.len() <= MAX_ID);
        q.tracks.truncate(MAX_QUEUE);
        let n = q.tracks.len();
        q.order = (0..n).collect();
        if n == 0 {
            q.index = -1;
            return q;
        }
        let start = start.min(n - 1);
        if shuffle {
            // Выбранный трек — первым, остальные вперемешку
            q.order.swap(0, start);
            shuffle_tail(&mut q.order, 1, seed);
            q.index = 0;
        } else {
            q.index = start as i64;
        }
        q
    }

    /// Следующий трек. `auto` — трек доигран сам: «повтор одного» оставляет его же, конец очереди без повтора
    /// останавливает (`index` = −1). Вручную «повтор одного» не удерживает, конец очереди ведёт в начало.
    pub fn next(&mut self, auto: bool) {
        let n = self.order.len() as i64;
        if n == 0 || self.index < 0 {
            self.index = if n == 0 { -1 } else { 0 };
            return;
        }
        if auto && self.repeat == Repeat::One {
            return;
        }
        if self.index + 1 < n {
            self.index += 1;
        } else if auto && self.repeat == Repeat::Off {
            self.index = -1;
        } else {
            self.index = 0;
        }
    }

    /// Предыдущий трек; с первого — на последний.
    pub fn prev(&mut self) {
        let n = self.order.len() as i64;
        if n == 0 {
            self.index = -1;
        } else {
            self.index = if self.index <= 0 { n - 1 } else { self.index - 1 };
        }
    }

    /// Перейти к треку по его месту в порядке проигрывания.
    pub fn jump(&mut self, position: usize) {
        if position < self.order.len() {
            self.index = position as i64;
        }
    }

    /// «Вперемешку»: играющий трек остаётся, перемешивается то, что после него; выключение возвращает порядок
    /// списка с тем же играющим треком.
    pub fn set_shuffle(&mut self, on: bool, seed: u64) {
        let current = self.current();
        self.shuffle = on;
        self.seed = seed;
        let n = self.tracks.len();
        self.order = (0..n).collect();
        match (on, current) {
            (true, Some(track)) => {
                self.order.swap(0, track);
                shuffle_tail(&mut self.order, 1, seed);
                self.index = 0;
            }
            (true, None) => shuffle_tail(&mut self.order, 0, seed),
            (false, Some(track)) => self.index = track as i64,
            (false, None) => {}
        }
    }

    pub fn cycle_repeat(&mut self) {
        self.repeat = match self.repeat {
            Repeat::Off => Repeat::All,
            Repeat::All => Repeat::One,
            Repeat::One => Repeat::Off,
        };
    }

    /// Добавить треки: `next` — сразу после играющего, иначе в конец порядка.
    pub fn add(&mut self, ids: Vec<String>, next: bool) {
        let was_empty = self.order.is_empty();
        let mut at = if next { usize::try_from(self.index + 1).unwrap_or(0).min(self.order.len()) } else { self.order.len() };
        for id in ids.into_iter().filter(|id| !id.is_empty() && id.len() <= MAX_ID) {
            if self.tracks.len() >= MAX_QUEUE {
                break;
            }
            self.tracks.push(id);
            self.order.insert(at, self.tracks.len() - 1);
            at += 1;
        }
        // В пустую очередь — играть первый добавленный
        if was_empty && !self.order.is_empty() {
            self.index = 0;
        }
    }

    /// Убрать трек по месту в порядке проигрывания; играющий — играть следующий на его месте.
    pub fn remove(&mut self, position: usize) {
        if position >= self.order.len() {
            return;
        }
        let track = self.order.remove(position);
        self.tracks.remove(track);
        for i in &mut self.order {
            if *i > track {
                *i -= 1;
            }
        }
        let n = self.order.len() as i64;
        if (position as i64) < self.index {
            self.index -= 1;
        } else if self.index >= n {
            self.index = if self.repeat == Repeat::Off { -1 } else { 0 };
        }
        if n == 0 {
            self.index = -1;
        }
    }

    /// Переставить трек в порядке проигрывания; играющий остаётся играющим.
    pub fn move_to(&mut self, from: usize, to: usize) {
        let n = self.order.len();
        if from >= n {
            return;
        }
        let to = to.min(n - 1);
        let playing = self.current();
        let item = self.order.remove(from);
        self.order.insert(to, item);
        if let Some(track) = playing {
            self.index = self.order.iter().position(|i| *i == track).map_or(-1, |p| p as i64);
        }
    }

    /// Оставить только играющий трек.
    pub fn clear_rest(&mut self) {
        match self.current() {
            Some(track) => {
                self.tracks = vec![self.tracks[track].clone()];
                self.order = vec![0];
                self.index = 0;
            }
            None => *self = Queue { shuffle: self.shuffle, repeat: self.repeat, seed: self.seed, ..Default::default() },
        }
    }

    /// Для показа: состояние и готовые поля — id играющего и треки в порядке проигрывания.
    pub fn view(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        v["currentId"] = self.current().map_or(Value::Null, |i| Value::String(self.tracks[i].clone()));
        v["upcoming"] = Value::Array(self.order.iter().map(|i| Value::String(self.tracks[*i].clone())).collect());
        v
    }
}

/// Перемешать `order[from..]` (Фишер — Йетс на xorshift): один и тот же `seed` даёт один порядок на всех клиентах.
fn shuffle_tail(order: &mut [usize], from: usize, seed: u64) {
    let mut state = seed ^ 0x9E37_79B9_7F4A_7C15;
    if state == 0 {
        state = 0x9E37_79B9_7F4A_7C15;
    }
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let n = order.len();
    for i in (from + 1..n).rev() {
        let j = from + (next() % (i - from + 1) as u64) as usize;
        order.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("t{i}")).collect()
    }

    #[test]
    fn plain_order_next_prev_and_repeat() {
        let mut q = Queue::start(ids(3), 1, false, Repeat::Off, 0);
        assert_eq!(q.view()["currentId"], "t1");
        q.next(true);
        assert_eq!(q.current(), Some(2));
        q.next(true);
        assert_eq!(q.index, -1, "конец очереди без повтора останавливает");
        q.next(false);
        assert_eq!(q.current(), Some(0), "вручную из остановки — с начала");
        q.prev();
        assert_eq!(q.current(), Some(2));
        q.repeat = Repeat::One;
        q.next(true);
        assert_eq!(q.current(), Some(2), "повтор одного держит трек, когда он доигран сам");
        q.next(false);
        assert_eq!(q.current(), Some(0), "вручную повтор одного не держит");
        q.repeat = Repeat::All;
        q.jump(2);
        q.next(true);
        assert_eq!(q.current(), Some(0));
    }

    #[test]
    fn shuffle_keeps_current_and_is_deterministic() {
        let a = Queue::start(ids(20), 7, true, Repeat::Off, 42);
        let b = Queue::start(ids(20), 7, true, Repeat::Off, 42);
        assert_eq!(a, b);
        assert_eq!(a.current(), Some(7));
        let mut sorted = a.order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..20).collect::<Vec<_>>());
        assert_ne!(a.order, Queue::start(ids(20), 7, true, Repeat::Off, 43).order);
        let mut q = a;
        q.next(false);
        let playing = q.current();
        q.set_shuffle(false, 0);
        assert_eq!(q.current(), playing, "выключение «вперемешку» играющий трек не меняет");
        assert_eq!(q.order, (0..20).collect::<Vec<_>>());
        q.set_shuffle(true, 5);
        assert_eq!(q.current(), playing);
        assert_eq!(q.index, 0);
    }

    #[test]
    fn edits_keep_the_playing_track() {
        let mut q = Queue::start(ids(4), 1, false, Repeat::Off, 0);
        q.add(vec!["n1".into(), "n2".into()], true);
        assert_eq!(q.view()["upcoming"], json!(["t0", "t1", "n1", "n2", "t2", "t3"]));
        q.add(vec!["last".into()], false);
        q.move_to(5, 0);
        assert_eq!(q.view()["currentId"], "t1");
        assert_eq!(q.view()["upcoming"], json!(["t3", "t0", "t1", "n1", "n2", "t2", "last"]));
        q.remove(0);
        assert_eq!(q.view()["currentId"], "t1");
        q.remove(1);
        assert_eq!(q.view()["currentId"], "n1", "убран играющий — играет следующий на его месте");
        q.clear_rest();
        assert_eq!(q.view()["upcoming"], json!(["n1"]));
        q.remove(0);
        assert_eq!(q.index, -1);
        assert!(q.tracks.is_empty());
    }

    #[test]
    fn normalize_repairs_saved_state() {
        let q = Queue::normalize(&json!({"tracks": ["a", "", "b"], "index": 9, "order": [0, 0], "repeat": "all"}));
        assert_eq!(q.tracks, ["a", "b"]);
        assert_eq!(q.order, [0, 1]);
        assert_eq!(q.index, -1);
        assert_eq!(q.repeat, Repeat::All);
        assert_eq!(Queue::normalize(&json!("мусор")), Queue::default());
        let kept = Queue::start(ids(5), 2, true, Repeat::One, 9);
        assert_eq!(Queue::normalize(&serde_json::to_value(&kept).unwrap()), kept, "годное состояние не меняется");
    }
}
