//! spec 035 T098 (US1, SC-002, contracts/migration.md «Точки прерывания»): разовый перенос с поддельным хостом и
//! сервером, прерванный («убит процесс») сразу после фиксации пачки в каждой точке M1–M6, — повторный запуск
//! доводит, итог тот же, что без прерывания: выгрузка нового движка (`auditDump`) побайтно та же, в новом журнале
//! состояния ни одной лишней записи, старое не тронуто. Затем — перенос поколения хранилища (смена DEK после PIN),
//! прерванный в каждой точке P1–P6, — перенесённое открывается тем же.

mod migrate_common;

use migrate_common::*;
use parvane_protocol::pb::parvane::engine::v1::{Root, StoreBatch, StoreLoaded, StorePut, StoreReads};
use parvane_protocol::store::{RotationAction, Store};
use prost::Message;
use serde_json::json;

fn reference() -> (Host, Server, String) {
    let mut host = Host::default();
    let mut server = Server { v1: v1_journal(), page: 2, ..Default::default() };
    let recs = legacy_records(9);
    run_migration(&mut host, &mut server, &recs, None, 2).expect("перенос без прерывания");
    let dump = reopened_dump(&mut host);
    (host, server, dump)
}

#[test]
fn uninterrupted_migration_keeps_everything() {
    let (_, server, dump) = reference();
    let k = kinds(&dump);
    assert_eq!(k.get("message"), Some(&9), "строки истории (очищенная до границы — нет): {dump}");
    assert_eq!(k.get("read-mark"), Some(&1));
    assert_eq!(k.get("outbox"), Some(&1));
    assert_eq!(k.get("state:folders"), Some(&1), "{dump}");
    assert_eq!(k.get("state:contacts"), Some(&1));
    assert_eq!(k.get("draft"), Some(&1));
    assert!(k.contains_key("device-log-head") && k.contains_key("key-material"));
    // Новый журнал: объекты переноса и Migrated последней
    let ops = server.v2_ops();
    assert!(matches!(ops.last().and_then(|o| o.op.as_ref()), Some(parvane_protocol::pb::parvane::state::v2::state_op::Op::Migrated(m)) if m.from_seq == 5));
    assert_eq!(ops.len(), 6, "5 объектов + Migrated: {ops:?}");
    assert!(server.calls.iter().all(|c| c != "state.append"), "старый журнал только читается");
}

#[test]
fn interrupted_at_each_point_ends_the_same() {
    let (_, ref_server, ref_dump) = reference();
    for point in 1..=6u32 {
        let mut host = Host::default();
        let mut server = Server { v1: v1_journal(), page: 2, ..Default::default() };
        let recs = legacy_records(9);
        let first = run_migration(&mut host, &mut server, &recs, Some(point), 2);
        assert!(first.is_none(), "M{point}: прерывание не случилось");
        drop(first);
        run_migration(&mut host, &mut server, &recs, None, 2).unwrap_or_else(|| panic!("M{point}: повторный запуск"));
        let dump = reopened_dump(&mut host);
        assert_eq!(dump, ref_dump, "M{point}: итог отличается от переноса без прерывания");
        assert_eq!(server.v2.len(), ref_server.v2.len(), "M{point}: в новом журнале лишние записи");
        assert_eq!(server.v2_ops(), ref_server.v2_ops(), "M{point}: записи журнала");
    }
}

#[test]
fn two_interruptions_in_a_row() {
    let (_, _, ref_dump) = reference();
    let mut host = Host::default();
    let mut server = Server { v1: v1_journal(), page: 2, ..Default::default() };
    let recs = legacy_records(9);
    assert!(run_migration(&mut host, &mut server, &recs, Some(2), 2).is_none());
    assert!(run_migration(&mut host, &mut server, &recs, Some(4), 2).is_none());
    run_migration(&mut host, &mut server, &recs, None, 2).unwrap();
    assert_eq!(reopened_dump(&mut host), ref_dump);
}

// ── перенос поколения над перенесённым профилем (P1–P6) ─────────────────────────────────────────────────

fn read(host: &Host, r: &StoreReads) -> StoreLoaded {
    let mut entries = vec![];
    for (k, v) in host.store.range(r.prefix.clone()..) {
        if !k.starts_with(&r.prefix) {
            break;
        }
        if k.as_str() > r.after.as_str() {
            entries.push(StorePut { key: k.clone(), value: v.clone() });
            if r.limit > 0 && entries.len() >= r.limit as usize {
                break;
            }
        }
    }
    StoreLoaded { read_id: r.read_id, entries }
}

fn apply(host: &mut Host, b: &StoreBatch) {
    for d in &b.deletes {
        host.store.remove(d);
    }
    for p in &b.puts {
        host.store.insert(p.key.clone(), p.value.clone());
    }
}

fn load(host: &Host) -> Store {
    let mut s = Store::load(host.store.get("root").unwrap()).unwrap();
    s.unlock_device(&[9u8; 32]).unwrap();
    s.set_batch_limit(3);
    s
}

/// Довести перенос поколения; `crash_at` — упасть, когда он дошёл до точки P. true — упали.
fn rotate(s: &mut Store, host: &mut Host, crash_at: Option<u8>) -> bool {
    for _ in 0..100_000 {
        if crash_at.is_some() && s.rotation_point() == crash_at {
            return true;
        }
        match s.rotation_next().unwrap() {
            RotationAction::Read(r) => {
                let l = read(host, &r);
                s.rotation_loaded(l).unwrap();
            }
            RotationAction::Write(b) => {
                apply(host, &b);
                s.committed(b.batch_id).unwrap();
            }
            RotationAction::Continue => {}
            RotationAction::Done => return false,
            RotationAction::Aborted(e) => panic!("перенос поколения остановлен: {e:?}"),
        }
    }
    panic!("перенос поколения не закончился")
}

#[test]
fn migrated_profile_survives_generation_rotation_interrupts() {
    let (base, _, ref_dump) = reference();
    for p in 1..=6u8 {
        let mut host = base.clone();
        let mut s = load(&host);
        let b = s.begin_rotation().unwrap();
        apply(&mut host, &b);
        s.committed(b.batch_id).unwrap();
        let crashed = rotate(&mut s, &mut host, Some(p));
        if crashed {
            let mut s = load(&host);
            assert!(!rotate(&mut s, &mut host, None), "P{p}: доводка");
        }
        let root = Root::decode(host.store["root"].as_slice()).unwrap();
        assert_eq!(root.active_generation, 2, "P{p}: поколение");
        assert!(host.store.keys().all(|k| k == "root" || k.starts_with("g2/")), "P{p}: остались записи прежнего поколения");
        assert_eq!(reopened_dump(&mut host), ref_dump, "P{p}: перенесённое после смены поколения");
    }
    let _ = json!({});
}
