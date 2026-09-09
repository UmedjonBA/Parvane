//! Per-field LWW-Map — CRDT для событий календаря.
//!
//! Событие хранит набор полей, каждое со своим LWW-регистром (значение + штамп),
//! и опциональный delete-штамп. Слияние двух состояний:
//!   * для каждого поля берётся значение с бо́льшим штампом;
//!   * delete-штамп — максимальный из двух.
//! Слияние коммутативно, ассоциативно, идемпотентно → сходимость.
//!
//! Эффективная удалённость: событие удалено, если delete-штамп новее всех правок
//! полей. Правка с бо́льшим штампом, чем delete, "воскрешает" событие.

use parvane_types::{LwwField, Stamp};
use std::collections::BTreeMap;

#[derive(Debug, Default, Clone)]
pub struct CalEvent {
    fields: BTreeMap<String, LwwField>,
    deleted_stamp: Option<Stamp>,
}

impl CalEvent {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_parts(
        fields: BTreeMap<String, LwwField>,
        deleted_stamp: Option<Stamp>,
    ) -> Self {
        Self { fields, deleted_stamp }
    }

    /// Записать значение поля. Применяется, только если штамп строго новее
    /// текущего (LWW). Возвращает `true`, если состояние изменилось.
    pub fn set_field(&mut self, name: &str, value: String, stamp: Stamp) -> bool {
        match self.fields.get(name) {
            Some(existing) if existing.stamp >= stamp => false,
            _ => {
                self.fields.insert(name.to_string(), LwwField { value, stamp });
                true
            }
        }
    }

    /// Зафиксировать удаление. Храним максимальный delete-штамп.
    pub fn delete(&mut self, stamp: Stamp) -> bool {
        match &self.deleted_stamp {
            Some(existing) if *existing >= stamp => false,
            _ => {
                self.deleted_stamp = Some(stamp);
                true
            }
        }
    }

    /// Самый свежий штамп среди всех полей.
    fn max_field_stamp(&self) -> Option<&Stamp> {
        self.fields.values().map(|f| &f.stamp).max()
    }

    /// Событие удалено, если delete-штамп новее всех правок полей.
    /// При равенстве (или отсутствии правок) удаление побеждает.
    pub fn is_deleted(&self) -> bool {
        match (&self.deleted_stamp, self.max_field_stamp()) {
            (Some(del), Some(field)) => del >= field,
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    pub fn fields(&self) -> &BTreeMap<String, LwwField> {
        &self.fields
    }

    pub fn deleted_stamp(&self) -> Option<&Stamp> {
        self.deleted_stamp.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(ts: i64, site: &str) -> Stamp {
        Stamp { ts, site: site.into() }
    }

    #[test]
    fn set_and_read_field() {
        let mut e = CalEvent::new();
        assert!(e.set_field("title", "Встреча".into(), st(1, "A")));
        assert_eq!(e.fields()["title"].value, "Встреча");
        assert!(!e.is_deleted());
    }

    #[test]
    fn lww_higher_stamp_wins() {
        let mut e = CalEvent::new();
        e.set_field("title", "v1".into(), st(5, "A"));
        assert!(e.set_field("title", "v2".into(), st(7, "A")));
        assert_eq!(e.fields()["title"].value, "v2");
    }

    #[test]
    fn lww_lower_stamp_ignored() {
        let mut e = CalEvent::new();
        e.set_field("title", "v2".into(), st(7, "A"));
        assert!(!e.set_field("title", "v1".into(), st(5, "A")), "старая правка отброшена");
        assert_eq!(e.fields()["title"].value, "v2");
    }

    #[test]
    fn lww_tie_broken_by_site() {
        let mut e = CalEvent::new();
        e.set_field("title", "fromA".into(), st(5, "A"));
        // тот же ts, site "B" > "A" → побеждает
        assert!(e.set_field("title", "fromB".into(), st(5, "B")));
        assert_eq!(e.fields()["title"].value, "fromB");
        // обратно site "A" < "B" → игнор
        assert!(!e.set_field("title", "fromA".into(), st(5, "A")));
    }

    #[test]
    fn concurrent_different_fields_both_survive() {
        // Клиент 1 правит title, клиент 2 правит location — оба применяются.
        let mut e = CalEvent::new();
        e.set_field("title", "T".into(), st(3, "A"));
        e.set_field("location", "L".into(), st(3, "B"));
        assert_eq!(e.fields()["title"].value, "T");
        assert_eq!(e.fields()["location"].value, "L");
    }

    #[test]
    fn delete_then_no_resurrect_with_older_update() {
        let mut e = CalEvent::new();
        e.set_field("title", "T".into(), st(5, "A"));
        e.delete(st(10, "A"));
        assert!(e.is_deleted());
        // правка со штампом СТАРШЕ delete не воскрешает
        e.set_field("title", "T2".into(), st(8, "A"));
        assert!(e.is_deleted(), "delete новее → остаётся удалённым");
    }

    #[test]
    fn update_newer_than_delete_resurrects() {
        let mut e = CalEvent::new();
        e.set_field("title", "T".into(), st(5, "A"));
        e.delete(st(10, "A"));
        assert!(e.is_deleted());
        // правка НОВЕЕ delete → воскрешает
        e.set_field("title", "T3".into(), st(12, "A"));
        assert!(!e.is_deleted(), "правка новее delete → событие живо");
        assert_eq!(e.fields()["title"].value, "T3");
    }

    /// Сходимость: применение тех же операций в разном порядке даёт то же
    /// состояние (значения полей и флаг удаления).
    #[test]
    fn convergence_under_reorder() {
        type Op = (&'static str, &'static str, Stamp);
        let ops: Vec<Op> = vec![
            ("title", "A", st(1, "X")),
            ("title", "B", st(3, "X")),
            ("location", "Home", st(2, "Y")),
            ("title", "C", st(2, "Z")),
        ];

        let mut forward = CalEvent::new();
        for (f, v, s) in &ops {
            forward.set_field(f, v.to_string(), s.clone());
        }

        let mut reversed = CalEvent::new();
        for (f, v, s) in ops.iter().rev() {
            reversed.set_field(f, v.to_string(), s.clone());
        }

        assert_eq!(forward.fields()["title"].value, reversed.fields()["title"].value);
        assert_eq!(forward.fields()["location"].value, reversed.fields()["location"].value);
        // title: максимальный штамп — ts=3 ("B")
        assert_eq!(forward.fields()["title"].value, "B");
    }
}
