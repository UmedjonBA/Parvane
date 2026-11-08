//! Мост личного состояния для хостов, чей показ ещё держит снимок `state.v1` (spec 035, T114 web): хост отдаёт
//! желаемое в форме `state.v1.StateSnapshot`, движок сам переводит его в объекты `state.v2` и выпускает только
//! изменившиеся поля (`Patch` с `set`/`clear`), новые объекты (`Create`), пропавшие (`Delete`, по управляемым
//! видам) и отметки (`Mark`). Сведение — только в движке (`state2`): хост не сравнивает метки и не знает
//! лампортов (ENGINE-1). Показ обратно — `state_view_v1`: сведённое состояние в форме снимка `state.v1`.
//!
//! Раскладка объектов — одна с разовым переносом журнала `state.v1` (`migrate::state_v1::objects_of` /
//! `project_v1`, фаза 10): поле верхнего уровня — регистр (списки, в том числе `Folder.include_peers`, —
//! регистром целиком: правка списка — замена значения поля, не `SetAdd`/`SetRemove`), ключи — `peer_key`, hex
//! op_id/call_id/link_id, `<домен>:<hex id>` у облака; отметки — `SCHEDULED` 1, `CHAT_CLEARED` 2.

use std::collections::{BTreeMap, BTreeSet};

use prost::Message;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{split_fields, Engine, Work};
use crate::error::{ProtoError, Result};
use crate::migrate::state_v1::{objects_of, project_v1, Obj};
use crate::pb::parvane::state::v1 as v1;
use crate::pb::parvane::state::v2::{self as s2, state_op::Op as SOp, FieldValue, ObjectKey, ObjectKind as K};
use crate::state2::MARK_SCHEDULED_SENT;

/// Виды объектов, которыми управляет имя вида хоста (`folders`, `blocked`, `notify`, `drafts`, `scheduled`,
/// `archived`, `pinned`, `unread`, `reaction`, `packs`, `contacts` — как у прежнего `diff`).
fn managed(names: &[String]) -> BTreeSet<i32> {
    let mut out = BTreeSet::new();
    for n in names {
        let ks: &[K] = match n.as_str() {
            "folders" => &[K::Folder, K::FolderOrder],
            "blocked" => &[K::Block],
            "notify" => &[K::PeerNotify, K::NotifyDefaults],
            "drafts" => &[K::Draft],
            "scheduled" => &[K::Scheduled],
            "archived" => &[K::Archive],
            "pinned" => &[K::PinList],
            "unread" => &[K::UnreadMark],
            "reaction" => &[K::QuickReaction],
            "packs" => &[K::StickerPack, K::SavedGif],
            "contacts" => &[K::Contact],
            _ => &[],
        };
        out.extend(ks.iter().map(|k| *k as i32));
    }
    out
}

/// Аргументы `stateApplyV1`.
#[derive(Debug, Default, Deserialize)]
pub struct ApplyV1 {
    /// Желаемое — `state.v1.StateSnapshot` (proto3-JSON).
    #[serde(default)]
    pub snapshot: Value,
    /// Управляемые виды (имена хоста): только их объекты сравниваются; пусто — все объекты снимка.
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Удалить объекты управляемых видов, которых нет в желаемом.
    #[serde(default)]
    pub prune: bool,
    /// Переписать объекты целиком (новый ключ личного состояния: прежние записи новым ключом не читаются).
    #[serde(default)]
    pub rewrite: bool,
    /// Что хост показывал, когда пользователь правил (`state.v1.StateSnapshot`): разница — с ним, не с сведённым.
    #[serde(default)]
    pub base: Option<Value>,
}

impl Engine {
    /// Показ личного состояния в форме снимка `state.v1` + избранные стикеры (`FAVED_STICKER`).
    pub fn state_view_v1(&self) -> Value {
        let snap = project_v1(&self.state);
        let faved: Vec<Value> = self
            .state
            .view()
            .into_iter()
            .filter(|v| v.kind == K::FavedSticker as i32)
            .filter_map(|v| s2::FavedSticker::decode(v.value.as_slice()).ok())
            .map(|f| json!({"set_id": f.set_id, "sticker_id": f.sticker_id, "added_ms": f.added_ms.to_string()}))
            .collect();
        json!({
            "snapshot": serde_json::to_value(&snap).unwrap_or(Value::Null),
            "faved_stickers": faved,
            "write_blocked": self.state.write_blocked(),
        })
    }

    /// Желаемое хоста → операции `state.v2`. С `base` (что хост показывал, когда пользователь правил) — разница
    /// желаемого с ним: уходят только поля, которые правил сам хост, — правки других устройств, пришедшие после
    /// `base`, не откатываются и не удаляются. Без `base` — разница с сведённым.
    pub fn state_apply_v1(&mut self, a: ApplyV1) -> Result<super::Outcome> {
        let snap: v1::StateSnapshot = serde_json::from_value(a.snapshot).map_err(|_| ProtoError::Malformed)?;
        let base: Option<BTreeMap<(i32, String), Obj>> = match a.base {
            Some(b) if !b.is_null() => {
                let bs: v1::StateSnapshot = serde_json::from_value(b).map_err(|_| ProtoError::Malformed)?;
                Some(objects_of(&bs)?.into_iter().map(|o| ((o.kind, o.key.clone()), o)).collect())
            }
            _ => None,
        };
        let want = objects_of(&snap)?;
        let kinds = managed(&a.kinds);
        let in_scope = |kind: i32| kinds.is_empty() || kinds.contains(&kind);
        let mut w = Work::default();
        let mut seen: BTreeSet<(i32, String)> = BTreeSet::new();
        let fields_map = |f: &[FieldValue]| -> BTreeMap<u32, Vec<u8>> { f.iter().map(|x| (x.field, x.value.clone())).collect() };
        for o in want.iter().filter(|o| in_scope(o.kind)) {
            seen.insert((o.kind, o.key.clone()));
            let cur = self.state.view_object(o.kind, &o.key);
            let object = Some(ObjectKey { kind: o.kind, key: o.key.clone() });
            // Отложенное уже отправлено — не трогать (как прежний diff)
            if o.kind == K::Scheduled as i32 && cur.as_ref().is_some_and(|c| c.marks.iter().any(|(f, _)| *f == MARK_SCHEDULED_SENT)) && o.marks.is_empty() {
                continue;
            }
            // Признак без полей (архив, «непрочитано») или отметка без полей — полей не трогать
            let fieldless = o.fields.is_empty() && !o.marks.is_empty();
            let wants_object = !o.fields.is_empty() || o.marks.is_empty();
            let was = base.as_ref().and_then(|b| b.get(&(o.kind, o.key.clone())));
            match (&cur, was) {
                (None, Some(b)) if !a.rewrite => {
                    // Удалён на другом устройстве после base: воскрешать, только если хост сам его правил
                    if wants_object && fields_map(&b.fields) != fields_map(&o.fields) {
                        self.try_state_op(SOp::Create(s2::Create { object: object.clone(), set: o.fields.clone() }), &mut w)?;
                    }
                }
                (None, _) if wants_object => {
                    self.try_state_op(SOp::Create(s2::Create { object: object.clone(), set: o.fields.clone() }), &mut w)?;
                }
                (Some(_), _) if a.rewrite && wants_object => {
                    self.try_state_op(SOp::Create(s2::Create { object: object.clone(), set: o.fields.clone() }), &mut w)?;
                }
                (Some(c), _) if !fieldless => {
                    let have: BTreeMap<u32, Vec<u8>> = split_fields(&c.value).into_iter().map(|f| (f.field, f.value)).collect();
                    // Отправная точка правки: base хоста, иначе сведённое
                    let from = match was {
                        Some(b) => fields_map(&b.fields),
                        None if base.is_some() => BTreeMap::new(),
                        None => have.clone(),
                    };
                    let set: Vec<FieldValue> =
                        o.fields.iter().filter(|f| from.get(&f.field) != Some(&f.value) && have.get(&f.field) != Some(&f.value)).cloned().collect();
                    let clear: Vec<u32> =
                        from.keys().copied().filter(|n| !o.fields.iter().any(|f| f.field == *n) && have.contains_key(n)).collect();
                    if !set.is_empty() || !clear.is_empty() {
                        self.try_state_op(SOp::Patch(s2::Patch { object: object.clone(), set, clear }), &mut w)?;
                    }
                }
                _ => {}
            }
            for (field, value) in &o.marks {
                let have = cur.as_ref().and_then(|c| c.marks.iter().find(|(f, _)| f == field).map(|(_, v)| v.clone()));
                let newer = have.as_ref().is_none_or(|h| (value.len(), value.as_slice()) > (h.len(), h.as_slice()));
                if newer || a.rewrite {
                    self.try_state_op(SOp::Mark(s2::Mark { object: object.clone(), field: *field, value: value.clone() }), &mut w)?;
                }
            }
        }
        if a.prune && !kinds.is_empty() {
            // С base удаляется только то, что хост видел и убрал; созданное другими устройствами после base остаётся
            let gone: Vec<(i32, String, bool)> = self
                .state
                .view()
                .into_iter()
                .filter(|v| kinds.contains(&v.kind) && !seen.contains(&(v.kind, v.key.clone())))
                .filter(|v| base.as_ref().is_none_or(|b| b.contains_key(&(v.kind, v.key.clone()))))
                .map(|v| (v.kind, v.key.clone(), !v.marks.is_empty()))
                .collect();
            for (kind, key, marked) in gone {
                // «Все чаты» и архив (0, 1) не удаляются; отправленное отложенное — только отметка
                if (kind == K::Folder as i32 && (key == "0" || key == "1")) || (kind == K::Scheduled as i32 && marked) {
                    continue;
                }
                self.try_state_op(SOp::Delete(s2::Delete { object: Some(ObjectKey { kind, key }) }), &mut w)?;
            }
        }
        self.finish(w)
    }

    /// Своя операция моста: негодный объект снимка пропускается, закрытый для записи журнал — отказ целиком.
    fn try_state_op(&mut self, op: SOp, w: &mut Work) -> Result<()> {
        match self.state_op(op, w) {
            Err(ProtoError::WriteBlocked) => Err(ProtoError::WriteBlocked),
            _ => Ok(()),
        }
    }

    /// Взять ключи личного состояния у прежнего клиентского ядра хоста (переходный период web: личность и
    /// инбокс ведёт прежний клиент, личное состояние — модель). Ключи переходят внутри движка, наружу не выходят.
    pub fn adopt_state_keys(&mut self, keys: &[(&crate::state::StateKey, u32)]) -> Result<super::Outcome> {
        let c = self.client.as_mut().ok_or(ProtoError::NotFound)?;
        let same = {
            let mine = c.state_keys_all();
            mine.len() == keys.len() && mine.iter().zip(keys.iter()).all(|(a, b)| a.0.as_bytes() == b.0.as_bytes() && a.1 == b.1)
        };
        let mut w = Work::default();
        if !same {
            // Прежние — первыми, текущий — последним: `set_state_key` уводит прежний текущий в прежние
            for (k, v) in keys.iter().rev() {
                c.set_state_key((*k).clone(), *v);
            }
            self.dirty.client = true;
            self.history_session = None;
            // Неотправленное под новым ключом — снова в путь
            let unsent: Vec<(String, Vec<u8>)> = self.state_unsent.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (op_hex, pt) in unsent {
                self.send_state_raw(&op_hex, &pt, &mut w);
            }
        }
        self.finish(w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::UserRef;
    use crate::pb::parvane::state::v1::{peer, Peer};
    use crate::state2::State2;

    #[test]
    fn objects_roundtrip_through_v1_view() {
        let snap = v1::StateSnapshot {
            folders: vec![v1::Folder { id: 5, title: "Работа".into(), emoticon: "💼".into(), ..Default::default() }],
            archived: vec![Peer { kind: Some(peer::Kind::User(UserRef { address: "bob@local".into() })) }],
            ..Default::default()
        };
        let objs = objects_of(&snap).unwrap();
        assert_eq!(objs.len(), 2);
        let mut s = State2::new();
        for (i, o) in objs.iter().enumerate() {
            let op = s2::StateOp {
                op_id: vec![i as u8 + 1; 16],
                lamport: 1,
                device_id: "d1".into(),
                ts_ms: 0,
                op: Some(SOp::Create(s2::Create { object: Some(ObjectKey { kind: o.kind, key: o.key.clone() }), set: o.fields.clone() })),
            };
            s.apply(&op).unwrap();
        }
        let back = project_v1(&s);
        assert_eq!(back.folders, snap.folders);
        assert_eq!(back.archived, snap.archived);
    }
}
