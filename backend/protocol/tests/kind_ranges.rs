//! spec 035 T013 (FR-041, R6, contracts/versioning.md «Критичность»): номера видов в oneof журналов и
//! содержимого: 1–999 — обычные, 1000–1999 — критичные. `build.rs` отказывает в сборке, если известный
//! вид вне диапазонов; здесь — что охват полон, таблица `schema::KIND_ONEOFS` сгенерирована и известные
//! виды выпуска только обычные (критичный диапазон зарезервирован), а вид ≥ 1000 есть только в тестовой
//! схеме `parvane.sample.v1` («движок будущего», T025).

use parvane_protocol::schema::{self, KindClass, KIND_ONEOFS};

/// Охват — contracts/versioning.md (state.v2 добавится в Phase 3 этой спеки).
const COVERED: &[&str] = &[
    "parvane.msg.v2.Content.kind",
    "parvane.msg.v2.InboxRecord.item",
    "parvane.history.v1.HistoryOp.op",
    "parvane.planner.v1.Change.change",
    "parvane.cloud.v1.CloudOp.op",
    "parvane.group.v2.GroupChange.change",
    "parvane.state.v1.StateOp.op",
];

#[test]
fn covered_oneofs_are_in_table() {
    let names: Vec<String> = KIND_ONEOFS.iter().map(|o| format!("{}.{}", o.message, o.oneof)).collect();
    for c in COVERED {
        assert!(names.iter().any(|n| n == c), "oneof {c} не охвачен диапазонами видов");
    }
    for o in KIND_ONEOFS {
        assert!(schema::message(o.message).is_some(), "{}: нет в схеме", o.message);
        assert!(!o.members.is_empty(), "{}.{}: пустой oneof", o.message, o.oneof);
    }
}

#[test]
fn known_kinds_are_in_ranges() {
    let mut sample_critical = 0;
    for o in KIND_ONEOFS {
        let sample = o.message.starts_with("parvane.sample.v1.");
        for &n in o.members {
            match schema::kind_class(n) {
                KindClass::Normal => {}
                KindClass::Critical if sample => sample_critical += 1,
                KindClass::Critical => panic!("{}.{} #{n}: критичный вид в схеме выпуска (диапазон зарезервирован)", o.message, o.oneof),
                KindClass::OutOfRange => panic!("{}.{} #{n}: вне диапазонов 1–999 / 1000–1999", o.message, o.oneof),
            }
        }
    }
    assert!(sample_critical >= 1, "в sample.v1 нет критичного вида — круг совместимости нечем проверять");
}

#[test]
fn kind_class_bounds() {
    assert_eq!(schema::kind_class(1), KindClass::Normal);
    assert_eq!(schema::kind_class(999), KindClass::Normal);
    assert_eq!(schema::kind_class(1000), KindClass::Critical);
    assert_eq!(schema::kind_class(1999), KindClass::Critical);
    assert_eq!(schema::kind_class(0), KindClass::OutOfRange);
    assert_eq!(schema::kind_class(2000), KindClass::OutOfRange);
}
