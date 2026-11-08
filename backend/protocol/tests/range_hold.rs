//! spec 035 T051 (US5, FR-032/FR-033): отметка «диапазон нельзя заменять» (`range-hold`). Записи журнала с
//! непонятным этой версии (неизвестный вид операции, неизвестное поле в операции) дают диапазон, который
//! запрещает компактизацию/заменяющий снимок/обрезку, пересекающие его; отметка переживает перезапуск (запись
//! хранилища вида `range-hold` под DEK) и пересчитывается из исходных записей журнала, если потеряна или
//! испорчена. Критичный вид закрывает журнал для записи (`JournalWrite::BlockedCriticalUnknown`).

use parvane_protocol::hold;
use parvane_protocol::pb::parvane::engine::v1::JournalWrite;
use parvane_protocol::pb::parvane::state::v2::{state_op::Op, FieldValue, ObjectKey, ObjectKind, Patch, StateOp};
use parvane_protocol::ProtoError;
use prost::Message;

const OP: &str = "parvane.state.v2.StateOp";

fn header(id: u8, lamport: u64) -> StateOp {
    let mut op_id = vec![0u8; 16];
    op_id[15] = id;
    StateOp { op_id, lamport, device_id: "d1".into(), ts_ms: 0, op: None }
}

fn known(id: u8) -> Vec<u8> {
    let mut op = header(id, u64::from(id));
    op.op = Some(Op::Patch(Patch {
        object: Some(ObjectKey { kind: ObjectKind::Folder as i32, key: "5".into() }),
        set: vec![FieldValue { field: 2, value: vec![0x12, 0x01, b'a'] }],
        clear: vec![],
    }));
    op.encode_to_vec()
}

/// Неизвестный вид операции: обычный (900) либо критичный (1000).
fn unknown_kind(id: u8, critical: bool) -> Vec<u8> {
    let mut b = header(id, u64::from(id)).encode_to_vec();
    b.extend_from_slice(if critical { &[0xc2, 0x3e, 0x00] } else { &[0xa2, 0x38, 0x00] });
    b
}

/// Неизвестный вид объекта — не непонятное для сведения (объект хранится целиком): отметки нет.
fn unknown_object_kind(id: u8) -> Vec<u8> {
    let mut op = header(id, u64::from(id));
    op.op = Some(Op::Patch(Patch { object: Some(ObjectKey { kind: 77, key: "x".into() }), set: vec![], clear: vec![1] }));
    op.encode_to_vec()
}

fn journal() -> Vec<(u64, Vec<u8>)> {
    vec![(1, known(1)), (2, unknown_kind(2, false)), (3, known(3)), (4, unknown_object_kind(4)), (5, unknown_kind(5, false)), (6, unknown_kind(6, false)), (7, known(7))]
}

fn refs(j: &[(u64, Vec<u8>)]) -> Vec<(u64, &[u8])> {
    j.iter().map(|(s, b)| (*s, b.as_slice())).collect()
}

#[test]
fn holds_cover_records_with_unknown_and_block_compaction() {
    let j = journal();
    let holds = hold::scan("state", OP, &refs(&j)).unwrap();
    let spans: Vec<(u64, u64)> = holds.iter().map(|h| (h.from_seq, h.to_seq)).collect();
    assert_eq!(spans, vec![(2, 2), (5, 6)], "соседние записи с непонятным — один диапазон, новый вид объекта — не отметка");
    assert!(holds.iter().all(|h| h.journal == "state" && !h.paths.is_empty()));
    assert_eq!(hold::check(&holds, "state", 1, 1), Ok(()));
    assert_eq!(hold::check(&holds, "state", 3, 4), Ok(()));
    assert_eq!(hold::check(&holds, "state", 1, 3), Err(ProtoError::RangeHeld));
    assert_eq!(hold::check(&holds, "state", 6, 100), Err(ProtoError::RangeHeld));
    assert_eq!(hold::check(&holds, "history", 1, 100), Ok(()), "отметка — только своего журнала");
    assert_eq!(hold::write_state(OP, &refs(&j)).unwrap(), JournalWrite::Open);
}

#[test]
fn holds_survive_restart_and_are_recomputed_when_lost() {
    let j = journal();
    let holds = hold::scan("state", OP, &refs(&j)).unwrap();
    // Перезапуск: запись хранилища под DEK → открыть → то же.
    let dek = [7u8; 32];
    let store_id = [1u8; 16];
    let stored = hold::seal(&dek, &store_id, 1, "state", &holds).unwrap();
    let back = hold::open(&dek, &store_id, 1, "state", &stored).unwrap();
    assert_eq!(back, holds);
    // Запись под другим именем (журналом) не открывается.
    assert!(hold::open(&dek, &store_id, 1, "history", &stored).is_err());
    // Потеряна — пересчёт по исходным записям; испорчена — тоже пересчёт, не «пусто».
    assert_eq!(hold::load(None, "state", OP, &refs(&j)).unwrap(), holds);
    assert_eq!(hold::load(Some(&[0xff, 0xff][..]), "state", OP, &refs(&j)).unwrap(), holds);
    assert_eq!(hold::load(Some(&hold::encode(&holds)), "state", OP, &refs(&j)).unwrap(), holds);
}

#[test]
fn critical_kind_blocks_writes() {
    let mut j = journal();
    j.push((8, unknown_kind(8, true)));
    assert_eq!(hold::write_state(OP, &refs(&j)).unwrap(), JournalWrite::BlockedCriticalUnknown);
    let holds = hold::scan("state", OP, &refs(&j)).unwrap();
    assert_eq!(holds.last().map(|h| (h.from_seq, h.to_seq)), Some((8, 8)));
}
