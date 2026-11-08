//! Журнал личного состояния `state.v1` → `state.v2` (spec 035, FR-018, FR-063, research.md R9, data-model.md §1
//! «Соответствие»). Старый журнал на сервере заморожен (`state.append` → `UPGRADE_REQUIRED`), `state.sync` читает
//! его до головы. Перенос сводит старые операции прежним правилом (`state::PersonalState`) и выпускает по объекту
//! операции нового журнала с детерминированным `op_id` (`state2::migration_op_id`), меткой `(max lamport + 1,
//! "migrate", op_id)` и детерминированным шифртекстом — два устройства, переносящие одно и то же, пишут одни и те же
//! байты, сервер отдаёт прежний seq. Последней — `Migrated{from_seq}`; неотправленные операции старой версии —
//! обычными новыми операциями после неё.
//!
//! Раскладка объектов: одна `Create` на видимый объект со значением сведённого объекта (поля верхнего уровня —
//! регистры; списки, в том числе `Folder.include_peers`, — регистром целиком: порядок сохраняется, выгрузка
//! сверки побайтно та же); отметки — `Mark` (`SCHEDULED` 1 «отправлено», `CHAT_CLEARED` 2 — граница очистки).
//! Надгробия старого журнала не переносятся (объекта нет).
//!
//! Обратное (`project_v1`) — снимок `state.v1` из нового состояния для выгрузки сверки (`audit.rs`).

use std::collections::BTreeMap;

use prost::Message;

use super::quarantine::Quarantined;
use crate::error::{ProtoError, Result};
use crate::pb::parvane::core::v2::{Ref, UserRef};
use crate::pb::parvane::state::v1::{self as v1, peer, state_op::Op as V1Op, Peer, PeerKey};
use crate::pb::parvane::state::v2::{self as s2, state_op::Op as V2Op, FieldValue, ObjectKey, ObjectKind as K};
use crate::state::{self, PersonalState, StateKey};
use crate::state2::{self, State2, MARK_CHAT_CLEARED, MARK_SCHEDULED_SENT};

/// Устройство в метке операций переноса (одно для всех устройств — байты одинаковы).
pub const MIGRATE_DEVICE: &str = "migrate";

/// Признак поля отметки в `migration_op_id` (поля объектов — малые номера).
const MARK_OP_FIELD: u32 = 0x8000_0000;

/// op_id записи `Migrated` пользователя: известен и серверу (статистика «аккаунты перенесли», T150) — по нему шард
/// считает перенёсших, не открывая шифртекст.
pub fn migrated_op_id(user: &str) -> [u8; 16] {
    state2::migration_op_id(user, 0, "", 0)
}

/// Открытые записи старого журнала.
#[derive(Debug, Default, Clone)]
pub struct OpenedV1 {
    pub ops: Vec<v1::StateOp>,
    /// Наибольший seq прочитанного (голова на момент чтения).
    pub head_seq: u64,
    /// Не расшифровались либо отвергнуты прежним правилом.
    pub quarantined: Vec<Quarantined>,
}

/// Открыть записи `state.sync` старого журнала ключом состояния (свой адрес и прежние — смена ника).
pub fn open_records(key: &StateKey, selves: &[String], records: &[v1::StateRecord]) -> OpenedV1 {
    let mut out = OpenedV1::default();
    let mut probe = PersonalState::new();
    for rec in records {
        out.head_seq = out.head_seq.max(rec.seq);
        let opened = selves.iter().find_map(|u| state::open_state_record(key, u, rec).ok());
        match opened {
            Some(op) => {
                if probe.apply(&op).is_ok() {
                    out.ops.push(op);
                } else {
                    out.quarantined.push(Quarantined::new(format!("state.v1/{}", rec.seq), "rejected", &rec.encode_to_vec()));
                }
            }
            None => out.quarantined.push(Quarantined::new(format!("state.v1/{}", rec.seq), "crypto", &rec.encode_to_vec())),
        }
    }
    out
}

/// Объект нового журнала, собранный из сведённого старого.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Obj {
    pub kind: i32,
    pub key: String,
    /// Поля сообщения-значения (номер → байты с тегом); у признаков пусто.
    pub fields: Vec<FieldValue>,
    /// Отметки: номер → значение (big-endian без ведущих нулей).
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
    crate::model::split_fields(&m.encode_to_vec())
}

fn pk(p: &Option<Peer>) -> Result<String> {
    state::peer_key(p.as_ref().ok_or(ProtoError::InvalidField("peer"))?)
}

fn obj(kind: K, key: String, fields: Vec<FieldValue>) -> Obj {
    Obj { kind: kind as i32, key, fields, marks: vec![] }
}

/// Объекты нового журнала из снимка старого (порядок — по (вид, ключ)).
pub fn objects_of(s: &v1::StateSnapshot) -> Result<Vec<Obj>> {
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
        put(obj(K::Block, pk(&b.peer)?, fields_of(b)));
    }
    for n in &s.notify {
        put(obj(K::PeerNotify, pk(&n.peer)?, fields_of(n)));
    }
    if let Some(d) = &s.notify_defaults {
        put(obj(K::NotifyDefaults, String::new(), fields_of(d)));
    }
    for d in &s.drafts {
        put(obj(K::Draft, pk(&d.peer)?, fields_of(d)));
    }
    for m in &s.scheduled {
        put(obj(K::Scheduled, hex::encode(&m.op_id), fields_of(m)));
    }
    for p in &s.archived {
        put(obj(K::Archive, state::peer_key(p)?, vec![]));
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
        let r = c.r#ref.as_ref().ok_or(ProtoError::InvalidField("cloud_container"))?;
        put(obj(K::CloudContainer, format!("{}:{}", r.domain, hex::encode(&r.id)), fields_of(c)));
    }
    for p in &s.unread_marks {
        put(obj(K::UnreadMark, state::peer_key(p)?, vec![]));
    }
    if let Some(q) = &s.quick_reaction {
        put(obj(K::QuickReaction, String::new(), fields_of(q)));
    }
    for p in &s.sticker_packs {
        let kind = if p.set_id.starts_with("g:") { K::SavedGif } else { K::StickerPack };
        put(obj(kind, p.set_id.clone(), fields_of(p)));
    }
    for c in &s.contacts {
        let a = c.user.as_ref().map(|u| u.address.clone()).ok_or(ProtoError::InvalidField("contact"))?;
        put(obj(K::Contact, a, fields_of(c)));
    }
    // Отметки — после объектов, чтобы отложенное «отправлено» легло в тот же объект
    let mut marks: Vec<Obj> = vec![];
    for id in &s.scheduled_sent {
        marks.push(Obj { kind: K::Scheduled as i32, key: hex::encode(id), fields: vec![], marks: vec![(MARK_SCHEDULED_SENT, vec![1])] });
    }
    for c in &s.cleared {
        if c.cleared_until_ms > 0 {
            marks.push(Obj { kind: K::ChatCleared as i32, key: pk(&c.peer)?, fields: vec![], marks: vec![(MARK_CHAT_CLEARED, be_min(c.cleared_until_ms as u64))] });
        }
    }
    for m in marks {
        let e = out.entry((m.kind, m.key.clone())).or_insert_with(|| Obj { fields: vec![], marks: vec![], ..m.clone() });
        e.marks.extend(m.marks);
    }
    Ok(out.into_values().collect())
}

/// Итог переноса журнала.
#[derive(Debug, Clone)]
pub struct Converted {
    /// Операции объектов (порядок — по (вид, ключ)), без `Migrated`.
    pub ops: Vec<s2::StateOp>,
    /// `Migrated{from_seq}` — пишется последней.
    pub migrated: s2::StateOp,
    /// Сведённый снимок старого журнала.
    pub snapshot: v1::StateSnapshot,
    /// Лампорт операций переноса.
    pub lamport: u64,
}

fn op(op_id: [u8; 16], lamport: u64, kind: V2Op) -> s2::StateOp {
    s2::StateOp { op_id: op_id.to_vec(), lamport, device_id: MIGRATE_DEVICE.into(), ts_ms: 0, op: Some(kind) }
}

fn object_key(o: &Obj) -> ObjectKey {
    ObjectKey { kind: o.kind, key: o.key.clone() }
}

/// Перенести сведённый журнал: операции объектов и `Migrated{from_seq}`.
pub fn convert(user: &str, ops: &[v1::StateOp], from_seq: u64) -> Result<Converted> {
    let mut ps = PersonalState::new();
    ps.apply_all(ops);
    let snapshot = ps.snapshot();
    let lamport = ps.max_lamport().saturating_add(1).max(1);
    if lamport > state::ACCEPT_LAMPORT_CEILING {
        return Err(ProtoError::InvalidField("lamport"));
    }
    let mut out = vec![];
    for o in objects_of(&snapshot)? {
        if !o.fields.is_empty() || o.marks.is_empty() {
            let id = state2::migration_op_id(user, o.kind, &o.key, 0);
            out.push(op(id, lamport, V2Op::Create(s2::Create { object: Some(object_key(&o)), set: o.fields.clone() })));
        }
        for (field, value) in &o.marks {
            let id = state2::migration_op_id(user, o.kind, &o.key, MARK_OP_FIELD | field);
            out.push(op(id, lamport, V2Op::Mark(s2::Mark { object: Some(object_key(&o)), field: *field, value: value.clone() })));
        }
    }
    let migrated = op(migrated_op_id(user), lamport, V2Op::Migrated(s2::Migrated { from_seq }));
    Ok(Converted { ops: out, migrated, snapshot, lamport })
}

/// Записи `state.ops.append` переноса (детерминированный шифртекст), `Migrated` — последней.
pub fn seal_all(key: &StateKey, user: &str, c: &Converted) -> Result<Vec<s2::AppendRequest>> {
    c.ops.iter().chain(std::iter::once(&c.migrated)).map(|o| state2::seal_op_deterministic(key, user, o)).collect()
}

/// Неотправленные операции старой версии → обычные новые операции (случайный op_id), лампорт выше переноса:
/// по объекту, который они меняют, — `Create` с новым значением либо `Delete`; отметки — `Mark`.
pub fn unsent_ops(base: &[v1::StateOp], unsent: &[v1::StateOp], device_id: &str, lamport_from: u64, ts_ms: i64) -> Result<Vec<s2::StateOp>> {
    let mut a = PersonalState::new();
    a.apply_all(base);
    let mut b = a.clone();
    b.apply_all(unsent);
    let before: BTreeMap<(i32, String), Obj> = objects_of(&a.snapshot())?.into_iter().map(|o| ((o.kind, o.key.clone()), o)).collect();
    let after: BTreeMap<(i32, String), Obj> = objects_of(&b.snapshot())?.into_iter().map(|o| ((o.kind, o.key.clone()), o)).collect();
    let mut lamport = lamport_from.max(b.max_lamport()).saturating_add(1);
    let mut out = vec![];
    let mut next = |k: V2Op, out: &mut Vec<s2::StateOp>| {
        out.push(s2::StateOp { op_id: state::new_op_id().to_vec(), lamport, device_id: device_id.into(), ts_ms, op: Some(k) });
        lamport += 1;
    };
    for (k, o) in &after {
        let prev = before.get(k);
        if prev.map(|p| &p.fields) != Some(&o.fields) && (!o.fields.is_empty() || o.marks.is_empty()) {
            match prev {
                // Изменённый объект — патч: новые поля и явная очистка исчезнувших
                Some(p) if !o.fields.is_empty() => {
                    let clear: Vec<u32> = p.fields.iter().map(|f| f.field).filter(|f| !o.fields.iter().any(|x| x.field == *f)).collect();
                    next(V2Op::Patch(s2::Patch { object: Some(object_key(o)), set: o.fields.clone(), clear }), &mut out);
                }
                _ => next(V2Op::Create(s2::Create { object: Some(object_key(o)), set: o.fields.clone() }), &mut out),
            }
        }
        for (field, value) in &o.marks {
            if !prev.is_some_and(|p| p.marks.contains(&(*field, value.clone()))) {
                next(V2Op::Mark(s2::Mark { object: Some(object_key(o)), field: *field, value: value.clone() }), &mut out);
            }
        }
    }
    for (k, o) in &before {
        if !after.contains_key(k) {
            next(V2Op::Delete(s2::Delete { object: Some(object_key(o)) }), &mut out);
        }
    }
    Ok(out)
}

/// Собеседник из ключа `u:<адрес>` / `g:<домен>:<hex id>`.
pub fn peer_of_key(k: &str) -> Option<Peer> {
    if let Some(a) = k.strip_prefix("u:") {
        return Some(Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) });
    }
    let (domain, id) = k.strip_prefix("g:")?.rsplit_once(':')?;
    Some(Peer { kind: Some(peer::Kind::Group(Ref { domain: domain.into(), id: hex::decode(id).ok()? })) })
}

/// Снимок `state.v1` из нового состояния (для выгрузки сверки: те же строки `state:*`, что у прежних клиентов).
/// Новые виды (`FAVED_STICKER`) в старом снимке не представимы и пропускаются.
pub fn project_v1(s: &State2) -> v1::StateSnapshot {
    let mut ps = PersonalState::new();
    let mut n: u64 = 0;
    let mut apply = |k: V1Op| {
        n += 1;
        let mut id = [0u8; 16];
        id[8..].copy_from_slice(&n.to_be_bytes());
        let o = v1::StateOp { op_id: id.to_vec(), lamport: 1, device_id: "audit".into(), ts_ms: 0, op: Some(k) };
        let _ = ps.apply(&o);
    };
    for v in s.view() {
        let val = v.value.as_slice();
        let mark = |f: u32| v.marks.iter().find(|(x, _)| *x == f).map(|(_, b)| be_val(b));
        let peer = || peer_of_key(&v.key).map(|p| PeerKey { peer: Some(p) });
        let k = match K::try_from(v.kind) {
            Ok(K::Folder) => v1::Folder::decode(val).ok().map(V1Op::FolderSet),
            Ok(K::FolderOrder) => v1::FolderOrder::decode(val).ok().map(V1Op::FolderOrder),
            Ok(K::Block) => v1::BlockEntry::decode(val).ok().map(V1Op::BlockSet),
            Ok(K::PeerNotify) => v1::PeerNotify::decode(val).ok().map(V1Op::NotifySet),
            Ok(K::NotifyDefaults) => v1::NotifyDefaults::decode(val).ok().map(V1Op::NotifyDefaults),
            Ok(K::Draft) => v1::Draft::decode(val).ok().map(V1Op::DraftSet),
            Ok(K::Scheduled) => {
                if mark(MARK_SCHEDULED_SENT).is_some() {
                    hex::decode(&v.key).ok().map(|id| V1Op::ScheduledSent(v1::ScheduledRef { op_id: id }))
                } else {
                    v1::ScheduledMessage::decode(val).ok().map(V1Op::ScheduledSet)
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

/// Состояние нового журнала из операций (проверка «view нового = snapshot старого»).
pub fn apply_v2(ops: &[s2::StateOp]) -> State2 {
    let mut s = State2::new();
    for o in ops {
        let _ = s.apply(o);
    }
    s
}
