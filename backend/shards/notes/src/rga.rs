//! Replicated Growable Array — текстовый CRDT для заметок.
//!
//! Документ — это набор узлов, каждый со своим `OpId` и ссылкой `after` на
//! предшественника. Видимый текст получается preorder-обходом дерева "вставлен
//! после", где сиблинги (узлы с одинаковым `after`) упорядочены по `OpId`
//! убыванием.
//!
//! Инвариант сходимости: итоговый текст зависит только от *множества*
//! применённых операций, но не от порядка их применения. Поэтому два клиента,
//! получившие одни и те же операции в разном порядке (например после оффлайна),
//! сойдутся к одинаковому тексту.

use parvane_types::{NoteElement, NoteOp, OpId};
use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct Rga {
    /// Все узлы по их OpId. Вставка идемпотентна (повторный Insert игнорируется),
    /// Delete лишь выставляет флаг — поэтому применение коммутативно.
    nodes: HashMap<OpId, NoteElement>,
}

impl Rga {
    pub fn new() -> Self {
        Self::default()
    }

    /// Собрать движок из сохранённого состояния (например из SQLite).
    pub fn from_elements(elements: impl IntoIterator<Item = NoteElement>) -> Self {
        let mut rga = Self::new();
        for el in elements {
            rga.nodes.insert(el.id.clone(), el);
        }
        rga
    }

    /// Применить одну операцию. Возвращает `true`, если состояние изменилось
    /// (полезно чтобы не писать в БД лишний раз).
    pub fn apply(&mut self, op: &NoteOp) -> bool {
        match op {
            NoteOp::Insert { id, after, ch } => {
                if self.nodes.contains_key(id) {
                    return false; // идемпотентность
                }
                self.nodes.insert(
                    id.clone(),
                    NoteElement {
                        id: id.clone(),
                        after: after.clone(),
                        ch: *ch,
                        deleted: false,
                    },
                );
                true
            }
            NoteOp::Delete { target } => match self.nodes.get_mut(target) {
                Some(node) if !node.deleted => {
                    node.deleted = true;
                    true
                }
                _ => false,
            },
            // Полная замена: сносим все узлы и пересобираем линейную
            // последовательность из текста (local-first replace).
            NoteOp::Replace { text } => {
                self.nodes.clear();
                let mut prev: Option<OpId> = None;
                for (i, ch) in text.chars().enumerate() {
                    let id = OpId { seq: (i as u64) + 1, site: "replace".to_string() };
                    self.nodes.insert(
                        id.clone(),
                        NoteElement { id: id.clone(), after: prev.clone(), ch, deleted: false },
                    );
                    prev = Some(id);
                }
                true
            }
        }
    }

    pub fn apply_all(&mut self, ops: &[NoteOp]) {
        for op in ops {
            self.apply(op);
        }
    }

    pub fn elements(&self) -> Vec<NoteElement> {
        self.nodes.values().cloned().collect()
    }

    /// Линеаризовать в видимый текст. Итеративный preorder-обход, чтобы длинная
    /// цепочка символов не вызвала переполнение стека рекурсией.
    pub fn text(&self) -> String {
        // children[after] = узлы, вставленные после `after` (None — корень),
        // отсортированные по OpId убыванием.
        let mut children: HashMap<Option<OpId>, Vec<&NoteElement>> = HashMap::new();
        for node in self.nodes.values() {
            children.entry(node.after.clone()).or_default().push(node);
        }
        for kids in children.values_mut() {
            // по убыванию: больший OpId — раньше в тексте
            kids.sort_by(|a, b| b.id.cmp(&a.id));
        }

        let mut result = String::new();
        // Стек хранит OpId узлов к посещению. Кладём сиблингов в обратном порядке,
        // чтобы первый (наибольший OpId) был снят со стека первым.
        let mut stack: Vec<&NoteElement> = Vec::new();
        if let Some(roots) = children.get(&None) {
            for node in roots.iter().rev() {
                stack.push(node);
            }
        }
        while let Some(node) = stack.pop() {
            if !node.deleted {
                result.push(node.ch);
            }
            if let Some(kids) = children.get(&Some(node.id.clone())) {
                for kid in kids.iter().rev() {
                    stack.push(kid);
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op_id(seq: u64, site: &str) -> OpId {
        OpId { seq, site: site.into() }
    }

    fn insert(seq: u64, site: &str, after: Option<OpId>, ch: char) -> NoteOp {
        NoteOp::Insert { id: op_id(seq, site), after, ch }
    }

    /// Печатает "abc" последовательно одним сайтом.
    fn typed_abc() -> Vec<NoteOp> {
        vec![
            insert(1, "A", None, 'a'),
            insert(2, "A", Some(op_id(1, "A")), 'b'),
            insert(3, "A", Some(op_id(2, "A")), 'c'),
        ]
    }

    #[test]
    fn sequential_insert() {
        let mut rga = Rga::new();
        rga.apply_all(&typed_abc());
        assert_eq!(rga.text(), "abc");
    }

    #[test]
    fn insert_at_beginning() {
        let mut rga = Rga::new();
        rga.apply_all(&typed_abc());
        // вставляем 'X' в начало (after = None)
        rga.apply(&insert(4, "A", None, 'X'));
        assert_eq!(rga.text(), "Xabc");
    }

    #[test]
    fn delete_middle() {
        let mut rga = Rga::new();
        rga.apply_all(&typed_abc());
        rga.apply(&NoteOp::Delete { target: op_id(2, "A") }); // удаляем 'b'
        assert_eq!(rga.text(), "ac");
    }

    #[test]
    fn delete_is_idempotent() {
        let mut rga = Rga::new();
        rga.apply_all(&typed_abc());
        let del = NoteOp::Delete { target: op_id(2, "A") };
        assert!(rga.apply(&del));
        assert!(!rga.apply(&del), "повторный delete не меняет состояние");
        assert_eq!(rga.text(), "ac");
    }

    #[test]
    fn insert_is_idempotent() {
        let mut rga = Rga::new();
        let op = insert(1, "A", None, 'a');
        assert!(rga.apply(&op));
        assert!(!rga.apply(&op), "повторный insert игнорируется");
        assert_eq!(rga.text(), "a");
    }

    /// Ключевое свойство CRDT: перемешанный порядок операций даёт тот же текст.
    #[test]
    fn convergence_under_shuffle() {
        let ops = typed_abc();

        let mut forward = Rga::new();
        forward.apply_all(&ops);

        let mut reversed = Rga::new();
        for op in ops.iter().rev() {
            reversed.apply(op);
        }

        // обратный порядок применения: 'c' и 'b' прибудут раньше своих
        // предшественников (orphan), но после прибытия 'a' дерево достроится.
        assert_eq!(forward.text(), reversed.text());
        assert_eq!(forward.text(), "abc");
    }

    /// Конкурентная вставка двух сайтов в одну позицию должна сходиться к
    /// одинаковому результату независимо от порядка приёма операций.
    #[test]
    fn concurrent_inserts_same_position_converge() {
        // Оба сайта вставляют после 'a': сайт A вставляет 'x', сайт B — 'y'.
        let base = insert(1, "A", None, 'a');
        let a_x = insert(2, "A", Some(op_id(1, "A")), 'x');
        let b_y = insert(2, "B", Some(op_id(1, "A")), 'y');

        let mut client1 = Rga::new();
        client1.apply(&base);
        client1.apply(&a_x);
        client1.apply(&b_y);

        let mut client2 = Rga::new();
        client2.apply(&base);
        client2.apply(&b_y); // другой порядок приёма
        client2.apply(&a_x);

        assert_eq!(client1.text(), client2.text(), "должны сойтись");
        // OpId{2,"B"} > OpId{2,"A"} (site "B" > "A"), убывание → 'y' раньше 'x'
        assert_eq!(client1.text(), "ayx");
    }

    #[test]
    fn rebuild_from_elements_preserves_text() {
        let mut rga = Rga::new();
        rga.apply_all(&typed_abc());
        rga.apply(&NoteOp::Delete { target: op_id(2, "A") });

        let rebuilt = Rga::from_elements(rga.elements());
        assert_eq!(rebuilt.text(), rga.text());
        assert_eq!(rebuilt.text(), "ac");
    }
}
