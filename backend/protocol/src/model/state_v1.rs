//! Мост личного состояния для хостов, чей показ ещё держит снимок `state.v1` (spec 035, T114 web): хост отдаёт
//! желаемое в форме `state.v1.StateSnapshot`, движок сам переводит его в объекты `state.v2` и выпускает только
//! изменившиеся поля (`Patch` с `set`/`clear`), новые объекты (`Create`), пропавшие (`Delete`, по управляемым
//! видам) и отметки (`Mark`). Сведение — только в движке (`state2`): хост не сравнивает метки и не знает
//! лампортов (ENGINE-1). Показ обратно — `state_view_v1`: сведённое состояние в форме снимка `state.v1`.
//!
//! Раскладка объектов — та же, что у разового переноса журнала `state.v1` (`migrate/state_v1.rs`, фаза 10):
//! поле верхнего уровня — регистр (списки, в том числе `Folder.include_peers`, — регистром целиком), ключи —
//! `peer_key`, hex op_id/call_id/link_id, `<домен>:<hex id>` у облака; отметки — `SCHEDULED` 1, `CHAT_CLEARED` 2.
//! При слиянии с фазой 10 `objects_of`/`project_v1` берутся оттуда (один перевод на движок).

use std::collections::{BTreeMap, BTreeSet};

use prost::Message;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{split_fields, Engine, Work};
use crate::error::{ProtoError, Result};
use crate::pb::parvane::core::v2::{Ref, UserRef};
use crate::pb::parvane::state::v1::{self as v1, peer, state_op::Op as V1Op, Peer, PeerKey};
use crate::pb::parvane::state::v2::{self as s2, state_op::Op as SOp, FieldValue, ObjectKey, ObjectKind as K};
use crate::state::{self, PersonalState};
use crate::state2::{State2, MARK_CHAT_CLEARED, MARK_SCHEDULED_SENT};

/// Объект `state.v2`, собранный из снимка `state.v1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Obj {
    pub kind: i32,
    pub key: String,
    pub fields: Vec<FieldValue>,
    pub marks: Vec<(u32, Vec<u8>)>,
}

fn be_min(v: u64) -> Vec<u8> {
    let b = v.to_be_bytes();
    let i = b.iter().position(|x| *x != 0).unwrap_or(7);
    b[i..].to_vec()
}

fn be_val(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, x| a.wrapping_shl(8) | u64::from(*x))
}

fn fields_of<M: Message>(m: &M) -> Vec<FieldValue> {
    split_fields(&m.encode_to_vec())
}

fn pk(p: &Option<Peer>) -> Result<String> {
    state::peer_key(p.as_ref().ok_or(ProtoError::InvalidField("peer"))?)
}

fn obj(kind: K, key: String, fields: Vec<FieldValue>) -> Obj {
    Obj { kind: kind as i32, key, fields, marks: vec![] }
}

/// Объекты `state.v2` из снимка `state.v1` (порядок — по (вид, ключ)). Негодный элемент снимка пропускается.
pub fn objects_of(s: &v1::StateSnapshot) -> Vec<Obj> {
    let mut out: BTreeMap<(i32, String), Obj> = BTreeMap::new();
    let mut put = |o: Obj| {
        out.insert((o.kind, o.key.clone()), o);
    };
    for f in &s.folders {
        put(obj(K::Folder, f.id.to_string(), fields_of(f)));
    }
    if let Some(o) = &s.folder_order {
        put(obj(K::FolderOrder, String::new(), fields_of(o)));
    }
    for b in &s.blocked {
        if let Ok(k) = pk(&b.peer) {
            put(obj(K::Block, k, fields_of(b)));
        }
    }
    for n in &s.notify {
        if let Ok(k) = pk(&n.peer) {
            put(obj(K::PeerNotify, k, fields_of(n)));
        }
    }
    if let Some(d) = &s.notify_defaults {
        put(obj(K::NotifyDefaults, String::new(), fields_of(d)));
    }
    for d in &s.drafts {
        if let Ok(k) = pk(&d.peer) {
            put(obj(K::Draft, k, fields_of(d)));
        }
    }
    for m in &s.scheduled {
        put(obj(K::Scheduled, hex::encode(&m.op_id), fields_of(m)));
    }
    for p in &s.archived {
        if let Ok(k) = state::peer_key(p) {
            put(obj(K::Archive, k, vec![]));
        }
    }
    for o in &s.pinned {
        put(obj(K::PinList, o.list.to_string(), fields_of(o)));
    }
    for c in &s.calls {
        put(obj(K::Call, hex::encode(&c.call_id), fields_of(c)));
    }
    for i in &s.invites {
        put(obj(K::GroupInvite, hex::encode(&i.link_id), fields_of(i)));
    }
    if let Some(c) = &s.planner_container {
        put(obj(K::PlannerContainer, String::new(), fields_of(c)));
    }
    for c in &s.cloud_containers {
        if let Some(r) = &c.r#ref {
            put(obj(K::CloudContainer, format!("{}:{}", r.domain, hex::encode(&r.id)), fields_of(c)));
        }
    }
    for p in &s.unread_marks {
        if let Ok(k) = state::peer_key(p) {
            put(obj(K::UnreadMark, k, vec![]));
        }
    }
    if let Some(q) = &s.quick_reaction {
        put(obj(K::QuickReaction, String::new(), fields_of(q)));
    }
    for p in &s.sticker_packs {
        let kind = if p.set_id.starts_with("g:") { K::SavedGif } else { K::StickerPack };
        put(obj(kind, p.set_id.clone(), fields_of(p)));
    }
    for c in &s.contacts {
        if let Some(a) = c.user.as_ref().map(|u| u.address.clone()) {
            put(obj(K::Contact, a, fields_of(c)));
        }
    }
    let mut marks: Vec<Obj> = vec![];
    for id in &s.scheduled_sent {
        marks.push(Obj { kind: K::Scheduled as i32, key: hex::encode(id), fields: vec![], marks: vec![(MARK_SCHEDULED_SENT, vec![1])] });
    }
    for c in &s.cleared {
        if let (true, Ok(k)) = (c.cleared_until_ms > 0, pk(&c.peer)) {
            marks.push(Obj { kind: K::ChatCleared as i32, key: k, fields: vec![], marks: vec![(MARK_CHAT_CLEARED, be_min(c.cleared_until_ms as u64))] });
        }
    }
    for m in marks {
        let e = out.entry((m.kind, m.key.clone())).or_insert_with(|| Obj { fields: vec![], marks: vec![], ..m.clone() });
        e.marks.extend(m.marks);
    }
    out.into_values().collect()
}

/// Собеседник из ключа `u:<адрес>` / `g:<домен>:<hex id>`.
pub fn peer_of_key(k: &str) -> Option<Peer> {
    if let Some(a) = k.strip_prefix("u:") {
        return Some(Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) });
    }
    let (domain, id) = k.strip_prefix("g:")?.rsplit_once(':')?;
    Some(Peer { kind: Some(peer::Kind::Group(Ref { domain: domain.into(), id: hex::decode(id).ok()? })) })
}

/// Снимок `state.v1` из сведённого `state.v2` (только известное и видимое). `FAVED_STICKER` в старом снимке не
/// представим — его показ отдельно (`faved_stickers` в `state_view_v1`).
pub fn project_v1(s: &State2) -> v1::StateSnapshot {
    let mut ps = PersonalState::new();
    let mut n: u64 = 0;
    let mut apply = |k: V1Op| {
        n += 1;
        let mut id = [0u8; 16];
        id[8..].copy_from_slice(&n.to_be_bytes());
        let o = v1::StateOp { op_id: id.to_vec(), lamport: 1, device_id: "view".into(), ts_ms: 0, op: Some(k) };
        let _ = ps.apply(&o);
    };
    for v in s.view() {
        let val = v.value.as_slice();
        let mark = |f: u32| v.marks.iter().find(|(x, _)| *x == f).map(|(_, b)| be_val(b));
        let peer = || peer_of_key(&v.key).map(|p| PeerKey { peer: Some(p) });
        let k = match K::try_from(v.kind) {
            Ok(K::Folder) => v1::Folder::decode(val).ok().map(|mut f| {
                f.id = v.key.parse().unwrap_or(f.id);
                V1Op::FolderSet(f)
            }),
            Ok(K::FolderOrder) => v1::FolderOrder::decode(val).ok().map(V1Op::FolderOrder),
            Ok(K::Block) => v1::BlockEntry::decode(val).ok().map(V1Op::BlockSet),
            Ok(K::PeerNotify) => v1::PeerNotify::decode(val).ok().map(V1Op::NotifySet),
            Ok(K::NotifyDefaults) => v1::NotifyDefaults::decode(val).ok().map(V1Op::NotifyDefaults),
            Ok(K::Draft) => v1::Draft::decode(val).ok().map(V1Op::DraftSet),
            Ok(K::Scheduled) => {
                if mark(MARK_SCHEDULED_SENT).is_some() {
                    hex::decode(&v.key).ok().map(|id| V1Op::ScheduledSent(v1::ScheduledRef { op_id: id }))
                } else {
                    v1::ScheduledMessage::decode(val).ok().filter(|m| !m.op_id.is_empty()).map(V1Op::ScheduledSet)
                }
            }
            Ok(K::Archive) => peer().map(V1Op::ArchiveSet),
            Ok(K::PinList) => v1::PinnedOrder::decode(val).ok().map(V1Op::PinnedOrder),
            Ok(K::Call) => v1::CallRecord::decode(val).ok().map(V1Op::CallSet),
            Ok(K::GroupInvite) => v1::GroupInvite::decode(val).ok().map(V1Op::GroupInviteSet),
            Ok(K::PlannerContainer) => v1::PlannerContainer::decode(val).ok().map(V1Op::PlannerContainerSet),
            Ok(K::CloudContainer) => v1::CloudContainer::decode(val).ok().map(V1Op::CloudContainerSet),
            Ok(K::UnreadMark) => peer().map(V1Op::UnreadMarkSet),
            Ok(K::QuickReaction) => v1::QuickReaction::decode(val).ok().map(V1Op::QuickReaction),
            Ok(K::StickerPack | K::SavedGif) => v1::StickerPack::decode(val).ok().map(V1Op::StickerPackSet),
            Ok(K::Contact) => v1::Contact::decode(val).ok().map(V1Op::ContactSet),
            Ok(K::ChatCleared) => mark(MARK_CHAT_CLEARED)
                .and_then(|ms| Some(V1Op::ChatCleared(v1::ChatCleared { peer: peer_of_key(&v.key), cleared_until_ms: i64::try_from(ms).ok()? }))),
            _ => None,
        };
        if let Some(k) = k {
            apply(k);
        }
    }
    ps.snapshot()
}

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
                Some(objects_of(&bs).into_iter().map(|o| ((o.kind, o.key.clone()), o)).collect())
            }
            _ => None,
        };
        let want = objects_of(&snap);
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

    #[test]
    fn objects_roundtrip_through_v1_view() {
        let snap = v1::StateSnapshot {
            folders: vec![v1::Folder { id: 5, title: "Работа".into(), emoticon: "💼".into(), ..Default::default() }],
            archived: vec![Peer { kind: Some(peer::Kind::User(UserRef { address: "bob@local".into() })) }],
            ..Default::default()
        };
        let objs = objects_of(&snap);
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
