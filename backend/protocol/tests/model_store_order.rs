//! spec 035 T064 (SYNC-1, contracts/engine-api.md «store_batch»): порядок «на диске раньше запросов и
//! подтверждения» с поддельным хостом.
//! - исходящее, ради которого выпущен запрос, лежит в пачке того же итога (хост фиксирует её до отправки);
//! - подтверждение инбокса (`msg.inbox.ack`) выпускается только после `storeCommitted` пачки с применённым;
//! - «убили между фиксацией и отправкой»: после перезапуска ничего не потеряно — исходящее уходит снова,
//!   неподтверждённая запись приходит повторно и подтверждается без повторного применения;
//! - «убили до фиксации»: запись применяется заново.

mod model_common;

use model_common::{b64d, b64e, call, Host};
use parvane_protocol::pb::parvane::core::v2::Ref;
use parvane_protocol::pb::parvane::msg::v2::{inbox_record, GroupStateNotice, InboxAckRequest, InboxRecord};
use prost::Message;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;

fn cfg() -> Value {
    json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "device_key": b64e(&[9u8; 32])})
}

fn notice(seq: u64) -> Vec<u8> {
    InboxRecord {
        seq,
        received_ms: 0,
        item: Some(inbox_record::Item::GroupState(GroupStateNotice { group: Some(Ref { domain: "local".into(), id: vec![seq as u8; 16] }), version: 1 })),
    }
    .encode_to_vec()
}

fn ingest_record(e: &mut parvane_protocol::model::Engine, rec: &[u8]) -> Value {
    call(e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_INBOX_RECORD", "body": b64e(rec)})).unwrap()
}

fn methods(out: &Value) -> Vec<String> {
    out["requests"].as_array().into_iter().flatten().map(|r| r["method"].as_str().unwrap().to_string()).collect()
}

fn ack_seq(out: &Value) -> Option<u64> {
    out["requests"].as_array().into_iter().flatten().find(|r| r["method"] == "msg.inbox.ack").map(|r| {
        InboxAckRequest::decode(b64d(r["body"].as_str().unwrap_or("")).as_slice()).unwrap().up_to_seq
    })
}

fn batch_keys(out: &Value) -> Vec<String> {
    out["store_batch"]["puts"].as_array().into_iter().flatten().map(|p| p["key"].as_str().unwrap().to_string()).collect()
}

#[test]
fn outgoing_is_on_disk_in_the_same_outcome_as_its_request() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    let out = call(&mut e, "submit", &json!({"send": {"chat": {"user": {"address": "bob@local"}}, "content": {"text": {"text": "привет"}}}})).unwrap();
    assert!(!methods(&out).is_empty(), "запрос ушёл: {out}");
    let keys = batch_keys(&out);
    assert!(keys.iter().any(|k| k.contains("/outbox/")), "исходящее в пачке того же итога: {keys:?}");
    assert!(keys.iter().any(|k| k.contains("/history-row/")), "строка в пачке того же итога: {keys:?}");
    host.drive(&mut e, out, true);
    let first_batch = host.log.iter().position(|l| l.starts_with("batch:")).unwrap();
    let first_req = host.log.iter().position(|l| l.starts_with("req:")).unwrap();
    assert!(first_batch < first_req, "пачка раньше запросов: {:?}", host.log);
}

#[test]
fn inbox_ack_only_after_store_committed() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    let out = ingest_record(&mut e, &notice(1));
    assert!(out["store_batch"].is_object(), "применённое — в пачку: {out}");
    assert_eq!(ack_seq(&out), None, "подтверждения до фиксации нет: {:?}", methods(&out));
    let id = host.apply_batch(&out["store_batch"]);
    let after = call(&mut e, "storeCommitted", &json!({"batch_id": id})).unwrap();
    assert_eq!(ack_seq(&after), Some(1), "подтверждение после фиксации: {after}");
}

#[test]
fn killed_between_commit_and_send_loses_nothing() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    // Своё сообщение: пачка зафиксирована, запросы не ушли — «убили»
    let out = call(&mut e, "submit", &json!({"send": {"chat": {"user": {"address": "bob@local"}}, "content": {"text": {"text": "не потеряйся"}}}})).unwrap();
    host.apply_batch(&out["store_batch"]);
    // Запись инбокса: пачка зафиксирована, storeCommitted и ack не дошли — «убили»
    let out = ingest_record(&mut e, &notice(1));
    host.apply_batch(&out["store_batch"]);
    drop(e);

    let mut h2 = Host { store: host.store.clone(), ..Default::default() };
    let (mut e, st) = h2.open(&cfg());
    let open_methods: Vec<String> = st.requests.iter().map(|r| r["method"].as_str().unwrap().to_string()).collect();
    assert!(open_methods.iter().any(|m| m == "identity.device.log_sync_anon"), "исходящее снова в пути: {open_methods:?}");
    let page = call(&mut e, "historyPage", &json!({"chat": {"user": {"address": "bob@local"}}, "direction": "PAGE_DIRECTION_OLDER", "limit": 10})).unwrap();
    assert_eq!(page["rows"].as_array().map(Vec::len), Some(1), "строка пережила перезапуск: {page}");
    // Сервер отдаёт неподтверждённую запись повторно: она уже применена — подтверждение без повторного применения
    let again = ingest_record(&mut e, &notice(1));
    assert!(!methods(&again).iter().any(|m| m == "group.state.sync"), "повтор не применяется: {again}");
    let st = h2.drive(&mut e, again, true);
    let acks: Vec<u64> = st
        .requests
        .iter()
        .filter(|r| r["method"] == "msg.inbox.ack")
        .map(|r| InboxAckRequest::decode(b64d(r["body"].as_str().unwrap()).as_slice()).unwrap().up_to_seq)
        .collect();
    assert_eq!(acks, vec![1], "подтверждение повторной записи");
}

#[test]
fn killed_before_commit_reapplies() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    let out = ingest_record(&mut e, &notice(1));
    assert!(methods(&out).iter().any(|m| m == "group.state.sync"));
    // Пачка не зафиксирована — «убили»
    drop(e);
    let (mut e, _) = host.open(&cfg());
    let out = ingest_record(&mut e, &notice(1));
    assert!(methods(&out).iter().any(|m| m == "group.state.sync"), "запись применяется заново: {out}");
    assert_eq!(ack_seq(&out), None);
    let st = host.drive(&mut e, out, true);
    assert!(st.requests.iter().any(|r| r["method"] == "msg.inbox.ack"));
}
