//! Изменения модели (spec 035 T066, FR-006, contracts/engine-api.md «ModelDelta»): ревизия растёт на 1 с
//! каждым непустым изменением; `messageUpsert` несёт представление целиком; повтор того же изменения не
//! меняет показ хоста. Внутри одного итога одно и то же место (сообщение, чат, объект) упоминается один раз —
//! последнее значение.

use crate::pb::parvane::engine::v1::{model_change::Change, ModelChange, ModelDelta};

#[derive(Debug, Default)]
pub struct DeltaBuilder {
    /// Изменения по порядку; заменённое место — `None` (без квадратичного поиска).
    changes: Vec<Option<ModelChange>>,
    places: std::collections::HashMap<String, usize>,
}

/// Ключ места изменения: одно место — одно изменение в итоге.
fn place(c: &Change) -> Option<String> {
    let peer = |p: &Option<crate::pb::parvane::state::v1::Peer>| p.as_ref().and_then(|p| crate::history::history_chat_key(p).ok()).unwrap_or_default();
    Some(match c {
        Change::ChatUpsert(v) => format!("c/{}", peer(&v.chat)),
        Change::ChatRemove(p) => format!("c/{}", crate::history::history_chat_key(p).unwrap_or_default()),
        Change::MessageUpsert(m) => format!("m/{}/{}", peer(&m.chat), hex::encode(&m.id)),
        Change::MessageRemove(m) => format!("m/{}/{}", peer(&m.chat), hex::encode(&m.id)),
        Change::StateChanged(s) => format!("s/{}", s.object.as_ref().map(|o| format!("{}:{}", o.kind, o.key)).unwrap_or_default()),
        Change::GroupChanged(g) => format!("g/{}", g.group.as_ref().map(|r| hex::encode(&r.id)).unwrap_or_default()),
        Change::UnreadChanged(u) => format!("u/{}", peer(&u.chat)),
        Change::WriteBlocked(w) => format!("w/{}", w.journal),
        Change::Notice(_) | Change::Needs(_) => return None,
    })
}

impl DeltaBuilder {
    pub fn push(&mut self, c: Change) {
        if let Some(p) = place(&c) {
            if let Some(i) = self.places.insert(p, self.changes.len()) {
                if let Some(slot) = self.changes.get_mut(i) {
                    *slot = None;
                }
            }
        }
        self.changes.push(Some(ModelChange { change: Some(c) }));
    }

    pub fn is_empty(&self) -> bool {
        self.changes.iter().all(Option::is_none)
    }

    /// Закрыть итог: пусто — `None`, иначе ревизия + 1.
    pub fn finish(self, revision: &mut u64) -> Option<ModelDelta> {
        let changes: Vec<ModelChange> = self.changes.into_iter().flatten().collect();
        if changes.is_empty() {
            return None;
        }
        *revision += 1;
        Some(ModelDelta { revision: *revision, changes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::engine::v1::{MessageRemove, MessageView};

    #[test]
    fn same_place_once_and_revision() {
        let mut d = DeltaBuilder::default();
        d.push(Change::MessageUpsert(MessageView { id: vec![1; 16], ..Default::default() }));
        d.push(Change::MessageRemove(MessageRemove { id: vec![1; 16], chat: None }));
        let mut rev = 4;
        let out = d.finish(&mut rev).unwrap();
        assert_eq!((rev, out.revision, out.changes.len()), (5, 5, 1));
        assert!(DeltaBuilder::default().finish(&mut rev).is_none());
        assert_eq!(rev, 5);
    }
}
