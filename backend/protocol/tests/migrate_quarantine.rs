//! spec 035 T099 (US1, FR-065): повреждённая старая запись не теряется молча — нерасшифровываемая запись
//! замороженного журнала `state.v1`, испорченная строка истории, строка без сводимого состояния и ключ экспорта,
//! который не разбирается, кладутся как есть в карантин переноса (записи `quarantine` нового хранилища) и в отчёт
//! (`migrateStatus`), перенос остального идёт до конца.

mod migrate_common;

use migrate_common::*;
use parvane_protocol::migrate::{self, quarantine::Quarantined, state_v1, Layer, LegacyRecord};
use parvane_protocol::pb::parvane::state::v1 as v1;
use parvane_protocol::state::StateKey;
use serde_json::{json, Value};

#[test]
fn collect_quarantines_broken_records_and_keeps_the_rest() {
    let recs: Vec<LegacyRecord> = legacy_records(4).iter().map(|v| serde_json::from_value(v.clone()).unwrap()).collect();
    let mut all = recs.clone();
    all.push(LegacyRecord::new("record:m:01923a4b-5c6d-7001-8000-0000000000aa", b"{\"id\": \"x\", \"hs\": {broken".to_vec()));
    all.push(LegacyRecord::new("record:m:01923a4b-5c6d-7001-8000-0000000000ab", json!({"id": "01923a4b-5c6d-7001-8000-0000000000ab", "from": "bob@local", "to": USER, "ts": 1, "content": {"kind": "text", "text": "без hs"}}).to_string().into_bytes()));
    all.push(LegacyRecord::new("record:rm:eve@local", b"\x00\x01\x02".to_vec()));
    all.push(LegacyRecord::new("idb:unknown-db/zzz", b"?".to_vec()));
    all.push(LegacyRecord::new("strange:key", b"?".to_vec()));
    let l = migrate::collect(Layer::Web, &all, "local");
    assert_eq!(l.row_count(), 4, "целые строки перенесены");
    let q: Vec<(&str, &str)> = l.quarantine.iter().map(|q| (q.key.as_str(), q.reason.as_str())).collect();
    assert!(q.contains(&("record:m:01923a4b-5c6d-7001-8000-0000000000aa", "malformed")), "{q:?}");
    assert!(q.contains(&("record:m:01923a4b-5c6d-7001-8000-0000000000ab", "no-row-state")), "{q:?}");
    assert!(q.contains(&("record:rm:eve@local", "malformed")), "{q:?}");
    let broken = l.quarantine.iter().find(|x| x.reason == "malformed" && x.key.ends_with("aa")).unwrap();
    assert_eq!(broken.bytes, b"{\"id\": \"x\", \"hs\": {broken".to_vec(), "в карантине — байты как есть");
    assert_eq!(l.unknown, vec!["strange:key".to_string()], "незнакомый ключ — в отчёт");
    assert!(l.engine_blob.is_some() && l.engine_key.is_some());
    // Запись карантина переживает запись/чтение
    let back = Quarantined::from_bytes(&broken.to_bytes()).unwrap();
    assert_eq!(&back, broken);
}

#[test]
fn undecryptable_state_record_goes_to_quarantine() {
    let key = StateKey::from_bytes(&STATE_KEY).unwrap();
    let mut recs = v1_journal();
    // Чужой ключ и порча шифртекста
    let other = StateKey::from_bytes(&[0x77; 32]).unwrap();
    let op = v1::StateOp { op_id: vec![0x33; 16], lamport: 9, device_id: "d9".into(), ts_ms: 1, op: Some(v1::state_op::Op::QuickReaction(v1::QuickReaction { emoji: "x".into(), ..Default::default() })) };
    let a = parvane_protocol::state::seal_op(&other, USER, &op).unwrap();
    recs.push(v1::StateRecord { seq: 6, op_id: a.op_id, aead_ciphertext: a.aead_ciphertext });
    let mut bad = recs[0].clone();
    bad.seq = 7;
    bad.aead_ciphertext[20] ^= 0xff;
    recs.push(bad);
    let o = state_v1::open_records(&key, &[USER.to_string()], &recs);
    assert_eq!(o.ops.len(), 5, "остальное открылось");
    assert_eq!(o.head_seq, 7);
    let q: Vec<(&str, &str)> = o.quarantined.iter().map(|q| (q.key.as_str(), q.reason.as_str())).collect();
    assert_eq!(q, vec![("state.v1/6", "crypto"), ("state.v1/7", "crypto")]);
}

#[test]
fn engine_migration_reports_quarantine_and_finishes() {
    let mut host = Host::default();
    let mut server = Server { v1: v1_journal(), ..Default::default() };
    let mut bad = server.v1[1].clone();
    bad.seq = 6;
    bad.op_id[0] ^= 1;
    server.v1.push(bad);
    let mut recs = legacy_records(3);
    recs.push(json!({"key": "record:m:01923a4b-5c6d-7001-8000-0000000000aa", "value": b64e(b"not json at all")}));
    let mut e = run_migration(&mut host, &mut server, &recs, None, 1000).expect("перенос дошёл до конца");
    let st = call(&mut e, "migrateStatus", &json!({})).unwrap();
    assert_eq!(st["point"].as_u64(), Some(7), "{st}");
    let rep: Value = serde_json::from_str(st["report_json"].as_str().unwrap()).unwrap();
    let q = rep["quarantined"].to_string();
    assert!(q.contains("record:m:01923a4b-5c6d-7001-8000-0000000000aa") && q.contains("state.v1/6"), "отчёт: {rep}");
    assert!(!q.contains("not json"), "в отчёте нет содержимого");
    let qrecords = host.store.keys().filter(|k| k.starts_with("g1/quarantine/")).count();
    assert_eq!(qrecords, 2, "записи карантина в новом хранилище");
    let k = kinds(&reopened_dump(&mut host));
    assert_eq!(k.get("message"), Some(&3), "остальное перенесено");
}
