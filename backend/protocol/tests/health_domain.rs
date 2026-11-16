//! Домен «Здоровье» `parvane.health.v1` (spec 038): сведение не зависит от порядка и повторов, надгробия
//! устойчивы, равные метки сводятся детерминированно, чужая метка — отказ, снимок == сведение.

use parvane_protocol::domain::health::{self, HealthState};
use parvane_protocol::domain::{LamportGuard, Stamp};
use parvane_protocol::pb::parvane::core::v2::LwwStamp;
use parvane_protocol::pb::parvane::health::v1::{change, Change, Entry, Goal, HealthOp};
use parvane_protocol::ProtoError;
use proptest::prelude::*;

const T: i64 = 1_794_000_000_000;

fn st(lamport: u64, dev: &str) -> Option<LwwStamp> {
    Some(LwwStamp { lamport, device_id: dev.into() })
}

fn entry(id: &str, value: f64, lamport: u64, dev: &str) -> Change {
    Change {
        change: Some(change::Change::Entry(Entry {
            id: id.into(),
            stamp: st(lamport, dev),
            kind: "weight".into(),
            at_ms: T + lamport as i64,
            tz_min: 180,
            value,
            unit: "kg".into(),
            source: "manual".into(),
            ..Default::default()
        })),
    }
}

fn entry_del(id: &str, lamport: u64, dev: &str) -> Change {
    Change { change: Some(change::Change::Entry(Entry { id: id.into(), deleted: st(lamport, dev), ..Default::default() })) }
}

fn goal(id: &str, target: f64, lamport: u64, dev: &str) -> Change {
    Change { change: Some(change::Change::Goal(Goal { id: id.into(), stamp: st(lamport, dev), target, deleted: None })) }
}

fn goal_del(id: &str, lamport: u64, dev: &str) -> Change {
    Change { change: Some(change::Change::Goal(Goal { id: id.into(), deleted: st(lamport, dev), ..Default::default() })) }
}

fn apply_all(ops: &[(String, HealthOp)]) -> HealthState {
    let mut s = HealthState::default();
    for (dev, op) in ops {
        s.apply_op(op, dev).unwrap();
    }
    s
}

fn arb_op() -> impl Strategy<Value = (String, HealthOp)> {
    let dev = prop_oneof![Just("d1"), Just("d2"), Just("d3")];
    (dev, 1u64..40, 0usize..4, 0u8..4, 1u32..200).prop_map(|(dev, lamport, id, what, v)| {
        let ids = ["a", "b", "c", "d"];
        let goals = ["steps", "water_ml", "sleep_min", "bedtime"];
        let c = match what {
            0 => entry(ids[id], f64::from(v), lamport, dev),
            1 => entry_del(ids[id], lamport, dev),
            2 => goal(goals[id], f64::from(v), lamport, dev),
            _ => goal_del(goals[id], lamport, dev),
        };
        (dev.to_string(), HealthOp { changes: vec![c] })
    })
}

proptest! {
    #[test]
    fn merge_is_order_independent_and_idempotent(ops in proptest::collection::vec(arb_op(), 1..40), seed in any::<u64>()) {
        let straight = apply_all(&ops);
        let mut shuffled = ops.clone();
        // Детерминированная перестановка по зерну + повтор части операций
        let n = shuffled.len();
        let mut x = seed | 1;
        for i in (1..n).rev() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            shuffled.swap(i, (x % (i as u64 + 1)) as usize);
        }
        let dup: Vec<_> = shuffled.iter().take(n / 2).cloned().collect();
        shuffled.extend(dup);
        let other = apply_all(&shuffled);
        prop_assert_eq!(&straight, &other);
        // Снимок == сведение, слияние снимка с собой и с пустым состоянием ничего не меняет
        let snap = straight.to_snapshot();
        let mut from_snap = HealthState::default();
        from_snap.merge_snapshot(&snap).unwrap();
        prop_assert_eq!(&from_snap, &straight);
        let mut again = straight.clone();
        again.merge_snapshot(&snap).unwrap();
        prop_assert_eq!(&again, &straight);
    }
}

#[test]
fn two_measurements_a_day_and_water_increments_survive() {
    let mut s = HealthState::default();
    s.apply_op(&HealthOp { changes: vec![entry("m1", 72.4, 1, "d1"), entry("m2", 71.9, 2, "d1")] }, "d1").unwrap();
    s.apply_op(&HealthOp { changes: vec![entry("m3", 72.0, 1, "d2")] }, "d2").unwrap();
    assert_eq!(s.live_entries().count(), 3);
}

#[test]
fn tombstone_wins_over_older_edit_and_loses_to_newer() {
    let mut s = HealthState::default();
    s.apply_op(&HealthOp { changes: vec![entry("a", 70.0, 5, "d1")] }, "d1").unwrap();
    s.apply_op(&HealthOp { changes: vec![entry_del("a", 6, "d2")] }, "d2").unwrap();
    assert_eq!(s.live_entries().count(), 0);
    // Старая правка после удаления не воскрешает
    s.apply_op(&HealthOp { changes: vec![entry("a", 71.0, 4, "d1")] }, "d1").unwrap();
    assert_eq!(s.live_entries().count(), 0);
    // Новая — воскрешает
    s.apply_op(&HealthOp { changes: vec![entry("a", 72.0, 7, "d1")] }, "d1").unwrap();
    assert_eq!(s.live_entries().map(|e| e.value).collect::<Vec<_>>(), vec![72.0]);
    // Надгробие первым, правка потом — тот же итог, без «попутных» полей
    let mut t = HealthState::default();
    t.apply_op(&HealthOp { changes: vec![entry_del("a", 6, "d2")] }, "d2").unwrap();
    assert!(t.entries["a"].kind.is_empty());
    t.apply_op(&HealthOp { changes: vec![entry("a", 70.0, 5, "d1"), entry("a", 71.0, 4, "d1"), entry("a", 72.0, 7, "d1")] }, "d1").unwrap();
    assert_eq!(t, s);
}

#[test]
fn foreign_stamp_refuses_whole_op_and_bad_change_is_skipped() {
    let mut s = HealthState::default();
    let op = HealthOp { changes: vec![entry("a", 70.0, 1, "d1"), entry("b", 70.0, 1, "d2")] };
    assert_eq!(s.apply_op(&op, "d1"), Err(ProtoError::ContextMismatch));
    assert!(s.entries.is_empty());
    let mut bad = entry("b", f64::NAN, 1, "d1");
    if let Some(change::Change::Entry(e)) = &mut bad.change {
        e.kind = "Вес".into();
    }
    assert_eq!(s.apply_op(&HealthOp { changes: vec![entry("a", 70.0, 1, "d1"), bad] }, "d1"), Ok(1));
    assert_eq!(s.apply_op(&HealthOp { changes: vec![] }, "d1"), Err(ProtoError::InvalidField("changes")));
}

#[test]
fn lamport_guard_rejects_eternal_winner() {
    let mut g = LamportGuard::default();
    health::guard_op(&mut g, &HealthOp { changes: vec![entry("a", 1.0, 5, "d1")] }).unwrap();
    assert!(health::guard_op(&mut g, &HealthOp { changes: vec![entry("a", 1.0, u64::MAX, "d1")] }).is_err());
    let mut op = HealthOp { changes: vec![entry("a", 1.0, 1, "x"), entry_del("b", 1, "x"), goal("steps", 8000.0, 1, "x")] };
    health::stamp_op(&mut op, &Stamp::new(9, "d1"));
    assert!(health::op_stamps(&op).unwrap().iter().all(|s| s.lamport == 9 && s.device_id == "d1"));
}

#[test]
fn sleep_belongs_to_wake_day() {
    // Лёг 16 ноя 23:30 местного (UTC+3), встал 17 ноя 07:10
    let start = health::days_from_civil(2026, 11, 16) * 86_400_000 + (20 * 60 + 30) * 60_000;
    let e = Entry { id: "s".into(), kind: "sleep".into(), at_ms: start, end_ms: start + (7 * 60 + 40) * 60_000, tz_min: 180, ..Default::default() };
    assert_eq!(health::entry_day(&e), "2026-11-17");
    assert_eq!(health::minute_of_day(e.at_ms, e.tz_min), 23 * 60 + 30);
}
