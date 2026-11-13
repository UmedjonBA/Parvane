//! Строки чата и страницы истории (spec 035 T066/T068, FR-005). Строка — сведённое состояние журнала
//! истории (`RowState`, HIST-1) с местом в ленте (`order`, ORDER-1). Порядок страниц — `(order, id)`; якорь —
//! значение ключа, а не позиция, поэтому вставки и удаления между запросами не дают ни пропусков, ни повторов
//! среди строк, живших всё время обхода (`tests/model_paging.rs`).

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;

use crate::pb::parvane::engine::v1::{MsgAnchor, PageDirection};
use crate::pb::parvane::history::v1::RowState;

/// Окно «живого» сообщения ORDER-1: время отличается от «сейчас» не больше чем на 300 с.
pub const LIVE_WINDOW_MS: i64 = 300_000;
/// Наибольшая страница.
pub const MAX_PAGE: usize = 200;

pub type Id = [u8; 16];
pub type Key = (i64, Id);

/// Строка модели.
#[derive(Debug, Clone, Default)]
pub struct Row {
    pub order: i64,
    pub state: RowState,
    /// Скрыта правами группы (GROUP-2): не показывается и не считается непрочитанной.
    pub hidden: bool,
    /// Своё исходящее: состояние доставки.
    pub delivery: i32,
    /// Отпечаток последнего показанного представления (повтор не даёт изменения, FR-006).
    pub shown: Option<u64>,
    /// Входящее, которое считается непрочитанным после маркера (`history::is_unread` без маркера; кэш).
    pub counted: bool,
}

impl Row {
    /// Строка видна: есть сообщение, нет надгробия, не скрыта правами.
    pub fn visible(&self) -> bool {
        self.state.row.is_some() && self.state.gone.is_none() && !self.hidden
    }
}

/// Строки одного чата.
#[derive(Debug, Default, Clone)]
pub struct ChatRows {
    index: BTreeMap<Key, ()>,
    rows: HashMap<Id, Row>,
    max_order: i64,
}

/// Страница.
#[derive(Debug, Default)]
pub struct Page<'a> {
    pub rows: Vec<&'a Row>,
    pub older: Option<Key>,
    pub newer: Option<Key>,
    pub has_older: bool,
    pub has_newer: bool,
}

pub fn id16(b: &[u8]) -> Option<Id> {
    b.try_into().ok()
}

impl ChatRows {
    pub fn get(&self, id: &Id) -> Option<&Row> {
        self.rows.get(id)
    }

    pub fn get_mut(&mut self, id: &Id) -> Option<&mut Row> {
        self.rows.get_mut(id)
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Строки с их id (без порядка).
    pub fn iter_ids(&self) -> impl Iterator<Item = (&Id, &Row)> {
        self.rows.iter()
    }

    pub fn rows(&self) -> impl Iterator<Item = &Row> {
        self.index.keys().filter_map(|(_, id)| self.rows.get(id))
    }

    /// Место новой строки (ORDER-1): живое — после всего показанного, старое — по времени отправителя.
    pub fn place(&self, ts_ms: i64, now_ms: i64) -> i64 {
        if (ts_ms - now_ms).abs() <= LIVE_WINDOW_MS {
            ts_ms.max(self.max_order.saturating_add(1))
        } else {
            ts_ms
        }
    }

    /// Вставить или заменить строку (место прежней строки сохраняется).
    pub fn put(&mut self, id: Id, mut row: Row) {
        if let Some(prev) = self.rows.get(&id) {
            self.index.remove(&(prev.order, id));
            row.order = prev.order;
        }
        self.max_order = self.max_order.max(row.order);
        self.index.insert((row.order, id), ());
        self.rows.insert(id, row);
    }

    pub fn remove(&mut self, id: &Id) -> Option<Row> {
        let r = self.rows.remove(id)?;
        self.index.remove(&(r.order, *id));
        Some(r)
    }

    /// Строки от новых к старым.
    pub fn rows_rev(&self) -> impl Iterator<Item = &Row> {
        self.index.keys().rev().filter_map(|(_, id)| self.rows.get(id))
    }

    /// Последняя видимая строка.
    pub fn last_visible(&self) -> Option<&Row> {
        self.index.keys().rev().filter_map(|(_, id)| self.rows.get(id)).find(|r| r.visible())
    }

    fn visible_in<'a>(&'a self, range: impl DoubleEndedIterator<Item = (&'a Key, &'a ())>, rev: bool, n: usize) -> Vec<(&'a Key, &'a Row)> {
        let it = range.filter_map(|(k, _)| self.rows.get(&k.1).filter(|r| r.visible()).map(|r| (k, r)));
        if rev {
            it.rev().take(n).collect()
        } else {
            it.take(n).collect()
        }
    }

    fn any_visible(&self, lo: Bound<Key>, hi: Bound<Key>) -> bool {
        self.index.range((lo, hi)).any(|(k, _)| self.rows.get(&k.1).is_some_and(Row::visible))
    }

    /// Страница видимых строк по возрастанию `(order, id)`.
    pub fn page(&self, anchor: Option<Key>, dir: PageDirection, limit: usize) -> Page<'_> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut picked: Vec<(&Key, &Row)> = match (dir, anchor) {
            (PageDirection::Newer, a) => {
                let lo = a.map_or(Bound::Unbounded, Bound::Excluded);
                self.visible_in(self.index.range((lo, Bound::Unbounded)), false, limit)
            }
            (PageDirection::Around, Some(a)) => {
                let before = limit / 2;
                let mut older = self.visible_in(self.index.range((Bound::Unbounded, Bound::Excluded(a))), true, before);
                older.reverse();
                let newer = self.visible_in(self.index.range((Bound::Included(a), Bound::Unbounded)), false, limit - older.len());
                older.into_iter().chain(newer).collect()
            }
            (_, a) => {
                let hi = a.map_or(Bound::Unbounded, Bound::Excluded);
                let mut v = self.visible_in(self.index.range((Bound::Unbounded, hi)), true, limit);
                v.reverse();
                v
            }
        };
        picked.sort_by(|x, y| x.0.cmp(y.0));
        let older = picked.first().map(|(k, _)| **k);
        let newer = picked.last().map(|(k, _)| **k);
        let has_older = match older {
            Some(k) => self.any_visible(Bound::Unbounded, Bound::Excluded(k)),
            None => match (dir, anchor) {
                (PageDirection::Newer, Some(a)) => self.any_visible(Bound::Unbounded, Bound::Included(a)),
                _ => false,
            },
        };
        let has_newer = match newer {
            Some(k) => self.any_visible(Bound::Excluded(k), Bound::Unbounded),
            None => match (dir, anchor) {
                (PageDirection::Older, Some(a)) | (PageDirection::Unspecified, Some(a)) => self.any_visible(Bound::Included(a), Bound::Unbounded),
                _ => false,
            },
        };
        Page { rows: picked.into_iter().map(|(_, r)| r).collect(), older, newer, has_older, has_newer }
    }
}

pub fn anchor_key(a: &MsgAnchor) -> Option<Key> {
    Some((a.ts_ms, id16(&a.id)?))
}

pub fn key_anchor(k: Key) -> MsgAnchor {
    MsgAnchor { ts_ms: k.0, id: k.1.to_vec() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::history::v1::MessageRow;

    fn row(order: i64, id: u8) -> Row {
        Row { order, state: RowState { target: vec![id; 16], row: Some(MessageRow { id: vec![id; 16], ..Default::default() }), ..Default::default() }, ..Default::default() }
    }

    #[test]
    fn pages_both_ways() {
        let mut c = ChatRows::default();
        for i in 1..=7u8 {
            c.put([i; 16], row(i as i64 * 10, i));
        }
        let p = c.page(None, PageDirection::Older, 3);
        assert_eq!(p.rows.iter().map(|r| r.order).collect::<Vec<_>>(), vec![50, 60, 70]);
        assert!(p.has_older && !p.has_newer);
        let p = c.page(p.older, PageDirection::Older, 3);
        assert_eq!(p.rows.iter().map(|r| r.order).collect::<Vec<_>>(), vec![20, 30, 40]);
        let p = c.page(p.older, PageDirection::Older, 3);
        assert_eq!(p.rows.iter().map(|r| r.order).collect::<Vec<_>>(), vec![10]);
        assert!(!p.has_older && p.has_newer);
        let p = c.page(Some((40, [4; 16])), PageDirection::Around, 4);
        assert_eq!(p.rows.iter().map(|r| r.order).collect::<Vec<_>>(), vec![20, 30, 40, 50]);
    }
}
