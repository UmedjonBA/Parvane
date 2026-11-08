//! spec 035 T049/T050 (US5, FR-015, FR-032…FR-035): круг совместимости «движок будущего → движок выпуска →
//! движок будущего». Байты собирает схема будущего (`parvane.sample.v1.Future*`, cargo-feature
//! `future-schema`); движок выпуска применяет, показывает, делает снимок и перешифровывает их. Для каждой
//! уничтожающей операции допустимы ровно два исхода: выполнена и непонятное сохранено — либо явный отказ
//! (`RangeHeld`), исходные данные нетронуты (FR-034).
//!
//! `cargo test -p parvane-protocol --features future-schema --test compat_circle`
#![cfg(feature = "future-schema")]

use parvane_protocol::hold;
use parvane_protocol::history;
use parvane_protocol::pb::parvane::history::v1::{HistoryBatch, HistoryOp};
use parvane_protocol::pb::parvane::sample::v1::{future_state_op, FutureFolder, FutureLock, FutureMessageRow, FuturePatch, FutureStateOp, FutureTag};
use parvane_protocol::pb::parvane::state::v2::{Create, FieldValue, ObjectKey, ObjectKind};
use parvane_protocol::state::{new_op_id, StateKey};
use parvane_protocol::state2::{self, State2};
use parvane_protocol::ProtoError;
use prost::Message;

const USER: &str = "alice@x";

fn folder_key() -> Option<ObjectKey> {
    Some(ObjectKey { kind: ObjectKind::Folder as i32, key: "5".into() })
}

/// Байты одного поля значения папки будущего (с тегом).
fn folder_field(f: FutureFolder) -> Vec<u8> {
    f.encode_to_vec()
}

fn op(id: u8, lamport: u64, op: future_state_op::Op) -> FutureStateOp {
    let mut op_id = vec![0u8; 16];
    op_id[15] = id;
    FutureStateOp { op_id, lamport, device_id: "future".into(), ts_ms: 0, op: Some(op) }
}

/// Журнал движка будущего: папка с новым полем значения, патч с новым полем операции, новый обычный вид.
fn future_journal() -> Vec<FutureStateOp> {
    vec![
        op(
            1,
            1,
            future_state_op::Op::Create(Create {
                object: folder_key(),
                set: vec![
                    FieldValue { field: 2, value: folder_field(FutureFolder { title: "Работа".into(), ..Default::default() }) },
                    FieldValue { field: 50, value: folder_field(FutureFolder { badge: "★".into(), ..Default::default() }) },
                ],
            }),
        ),
        op(
            2,
            2,
            future_state_op::Op::Patch(FuturePatch {
                object: folder_key(),
                set: vec![FieldValue { field: 3, value: folder_field(FutureFolder { emoticon: "💼".into(), ..Default::default() }) }],
                clear: vec![],
                reason: "правка с причиной".into(),
            }),
        ),
        op(3, 3, future_state_op::Op::Tag(FutureTag { label: "метка".into() })),
    ]
}

fn release_state(records: &[Vec<u8>]) -> State2 {
    let mut st = State2::new();
    for r in records {
        st.apply_bytes(r).expect("движок выпуска принимает записи будущего");
    }
    st
}

#[test]
fn state2_new_value_field_survives_release_snapshot() {
    // Только неизвестное поле ЗНАЧЕНИЯ: движок выпуска делает заменяющий снимок, будущее видит своё.
    let only_value = vec![future_journal().remove(0).encode_to_vec()];
    let st = release_state(&only_value);
    let view = st.view();
    assert_eq!(view.len(), 1);
    let shown = parvane_protocol::pb::parvane::state::v1::Folder::decode(view[0].value.as_slice()).unwrap();
    assert_eq!(shown.title, "Работа", "показ известного");
    let snap = st.replacement_snapshot().expect("непонятного в операциях нет — снимок разрешён");
    // Движок будущего читает снимок выпуска: поле 50 — его байты целиком.
    let obj = &snap.objects[0];
    let reg = obj.fields.iter().find(|r| r.field == 50).expect("поле 50 в снимке");
    assert_eq!(FutureFolder::decode(reg.value.as_slice()).unwrap().badge, "★");
    // Снимок → движок выпуска → снимок: побайтно то же.
    let back = State2::from_snapshot(&snap).unwrap();
    assert_eq!(back.snapshot_bytes(), st.snapshot_bytes());
}

#[test]
fn state2_unknown_in_ops_refuses_replacement_and_keeps_bytes() {
    let journal: Vec<Vec<u8>> = future_journal().iter().map(Message::encode_to_vec).collect();
    let st = release_state(&journal);
    // Показ известного: название и значок применены (известная часть патча).
    let shown = parvane_protocol::pb::parvane::state::v1::Folder::decode(st.view()[0].value.as_slice()).unwrap();
    assert_eq!((shown.title.as_str(), shown.emoticon.as_str()), ("Работа", "💼"));
    assert!(!st.write_blocked(), "обычные виды запись не закрывают");
    // Исход 2: заменяющий снимок явно отклонён.
    assert_eq!(st.replacement_snapshot().unwrap_err(), ProtoError::RangeHeld);
    // Отметка диапазона — из исходных записей.
    let recs: Vec<(u64, &[u8])> = journal.iter().enumerate().map(|(i, b)| (i as u64 + 1, b.as_slice())).collect();
    let holds = hold::scan(hold::STATE, state2::OP_TYPE, &recs).unwrap();
    assert_eq!(holds.iter().map(|h| (h.from_seq, h.to_seq)).collect::<Vec<_>>(), vec![(2, 3)]);
    assert_eq!(hold::check(&holds, hold::STATE, 1, 3), Err(ProtoError::RangeHeld));
    // Снимок без потерь хранит исходные байты: будущее видит свою причину правки и свой вид.
    let held: Vec<FutureStateOp> = st.snapshot().held.iter().map(|b| FutureStateOp::decode(b.as_slice()).unwrap()).collect();
    assert!(held.iter().any(|o| matches!(&o.op, Some(future_state_op::Op::Patch(p)) if p.reason == "правка с причиной")));
    assert!(held.iter().any(|o| matches!(&o.op, Some(future_state_op::Op::Tag(t)) if t.label == "метка")));
}

#[test]
fn state2_reseal_under_new_key_keeps_future_bytes() {
    let (old, new) = (StateKey::generate(), StateKey::generate());
    for f in future_journal() {
        let pt = f.encode_to_vec();
        let rec = state2::seal_raw_deterministic(&old, USER, &f.op_id, &pt).unwrap();
        // Движок выпуска перешифровывает, не разбирая.
        let moved = state2::reseal(&old, &new, USER, &rec.op_id, &rec.aead_ciphertext).unwrap();
        let opened = state2::open(&new, USER, &moved.op_id, &moved.aead_ciphertext).unwrap();
        assert_eq!(opened, pt, "те же байты");
        assert_eq!(FutureStateOp::decode(opened.as_slice()).unwrap(), f, "будущее видит своё");
    }
}

#[test]
fn state2_critical_kind_blocks_writes_and_leaves_data() {
    let mut journal: Vec<Vec<u8>> = future_journal().iter().map(Message::encode_to_vec).collect();
    journal.push(op(4, 4, future_state_op::Op::Lock(FutureLock { rule: vec![1, 2, 3] })).encode_to_vec());
    let st = release_state(&journal);
    assert!(st.write_blocked());
    let key = StateKey::generate();
    let mine = parvane_protocol::pb::parvane::state::v2::StateOp {
        op_id: new_op_id().to_vec(),
        lamport: 9,
        device_id: "d1".into(),
        ts_ms: 0,
        op: Some(parvane_protocol::pb::parvane::state::v2::state_op::Op::Delete(parvane_protocol::pb::parvane::state::v2::Delete { object: folder_key() })),
    };
    assert_eq!(st.seal_local(&key, USER, &mine).unwrap_err(), ProtoError::WriteBlocked);
    assert_eq!(st.view().len(), 1, "показ известного работает");
    assert_eq!(st.replacement_snapshot().unwrap_err(), ProtoError::RangeHeld);
    let snap = State2::from_snapshot(&st.snapshot()).unwrap();
    assert!(snap.write_blocked(), "закрытие переживает снимок и загрузку");
}

// ── T050: журнал истории ──────────────────────────────────────────────────────────────────────────────

fn future_history_batch() -> Vec<u8> {
    let row = FutureMessageRow {
        id: new_op_id().to_vec(),
        chat: Some(parvane_protocol::pb::parvane::state::v1::Peer {
            kind: Some(parvane_protocol::pb::parvane::state::v1::peer::Kind::User(parvane_protocol::pb::parvane::core::v2::UserRef { address: "bob@x".into() })),
        }),
        from: USER.into(),
        ts_ms: 1_700_000_000_000,
        body: br#"{"content":{"kind":"text","text":"hi"}}"#.to_vec(),
        future_mood: "радость".into(),
    };
    // HistoryBatch{device_id, ops: [HistoryOp{row: <байты FutureMessageRow>}]} — собрано вручную, как у будущего.
    let mut op = Vec::new();
    prost::encoding::bytes::encode(1, &row.encode_to_vec(), &mut op);
    let mut batch = HistoryBatch { device_id: "future".into(), ts_ms: 1, ..Default::default() }.encode_to_vec();
    prost::encoding::bytes::encode(3, &op, &mut batch);
    batch
}

#[test]
fn history_parsed_path_loses_future_field() {
    // Фиксация проблемы: разобранная пачка, собранная заново, теряет поле будущего (prost его не хранит).
    let pt = future_history_batch();
    let parsed = HistoryBatch::decode(pt.as_slice()).unwrap();
    let again = parsed.encode_to_vec();
    assert_ne!(again, pt);
    let row = match &parsed.ops[0].op {
        Some(parvane_protocol::pb::parvane::history::v1::history_op::Op::Row(r)) => r.encode_to_vec(),
        _ => panic!("строка"),
    };
    assert_eq!(FutureMessageRow::decode(row.as_slice()).unwrap().future_mood, "", "поле будущего потеряно разбором");
    let _ = HistoryOp::default();
}

#[test]
fn history_checkpoint_refused_and_reseal_keeps_bytes() {
    let state_key = StateKey::generate();
    let (old, new) = (history::HistoryKey::derive(&state_key, USER), history::HistoryKey::derive(&StateKey::generate(), USER));
    let pt = future_history_batch();
    let op_id = new_op_id();
    let rec = history::seal_raw_with_nonce(&old, USER, &op_id, false, &pt, [3; 12]).unwrap();
    // Движок выпуска: исходные байты записи и отметка диапазона.
    let raw = history::open_record_raw(&old, USER, &op_id, false, &rec.aead_ciphertext).unwrap();
    assert_eq!(raw, pt);
    let holds = hold::scan(hold::HISTORY, hold::HISTORY_TYPE, &[(1, raw.as_slice())]).unwrap();
    assert_eq!(holds.len(), 1);
    // Исход 2: контрольная точка, накрывающая запись, явно отклонена.
    let states = vec![];
    assert_eq!(history::compact_checked(&states, 0, &holds, 1).unwrap_err(), ProtoError::RangeHeld);
    assert!(history::compact_checked(&states, 0, &[], 1).is_ok(), "без непонятного точка разрешена");
    // Перешифровка без разбора: будущее видит своё поле.
    let moved = history::reseal_raw(&old, &new, USER, &op_id, false, &rec.aead_ciphertext).unwrap();
    assert_eq!(moved, history::reseal_raw(&old, &new, USER, &op_id, false, &rec.aead_ciphertext).unwrap(), "детерминированно");
    let opened = history::open_record_raw(&new, USER, &op_id, false, &moved.aead_ciphertext).unwrap();
    assert_eq!(opened, pt);
}

// ── T050: домены ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn domain_snapshot_refused_over_unknown_ops() {
    use parvane_protocol::domain::planner;
    // Операция «Плана» будущего: известное изменение с новым полем верхнего уровня операции (поле 9).
    let mut fut = parvane_protocol::pb::parvane::planner::v1::PlannerOp { changes: vec![] }.encode_to_vec();
    prost::encoding::string::encode(9, &"новое".to_string(), &mut fut);
    // Разбор движком выпуска теряет поле — снимок из разобранного его уже не содержит.
    let parsed = planner::decode_op(&fut).unwrap();
    assert_ne!(parsed.encode_to_vec(), fut);
    // Поэтому снимок, накрывающий такую операцию, запрещён (исход 2); без неё — разрешён.
    let known = parvane_protocol::pb::parvane::planner::v1::PlannerOp { changes: vec![] }.encode_to_vec();
    let recs = [(1u64, known.as_slice()), (2u64, fut.as_slice())];
    let holds = hold::scan("domain:00", hold::PLANNER_TYPE, &recs).unwrap();
    assert_eq!(holds.iter().map(|h| (h.from_seq, h.to_seq)).collect::<Vec<_>>(), vec![(2, 2)]);
    assert_eq!(hold::check(&holds, "domain:00", 1, 2), Err(ProtoError::RangeHeld));
    assert_eq!(hold::check(&holds, "domain:00", 1, 1), Ok(()));
}
