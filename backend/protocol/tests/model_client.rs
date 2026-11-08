//! spec 035 (T113, T125, T135; contracts/engine-api.md): клиентское ядро живёт в модели движка. Хост не держит
//! прежний клиент (`PvClient` / `pv_client_*`): действия клиента — вызов `clientCall` модели теми же именами и
//! аргументами, что единая точка входа нативных хостов (`host::call`), состояние клиента — в хранилище модели
//! (переживает перезапуск, корень — только в памяти), события сервера — `ingest`.
//!
//! Режим хоста (`host_driven`, переходный период T113/T125/T135): историю и показ ведёт хост, модель отдаёт ему
//! события записей инбокса (`client_events`) и нужды, которые добирает хост (`needs{kind: client}`); запись,
//! ждущая нужду, и все следующие за ней ждут (порядок ORDER-1), подтверждение инбокса — только после фиксации
//! пачки (SYNC-1).

mod mini_server;
mod model_common;

use mini_server::Server;
use model_common::{b64d, b64e, Host};
use parvane_protocol::client::{Chan, OutRequest};
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::InboxSyncResponse;
use prost::Message;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;

fn cfg(user: &str, key: u8) -> Value {
    json!({
        "user": user, "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(),
        "device_key": b64e(&[key; 32]), "host_driven": true,
    })
}

fn raw(e: &mut Engine, name: &str, args: &Value) -> Value {
    serde_json::from_str(&e.call(name, &args.to_string())).unwrap()
}

/// `clientCall`: результат (разобранный `result_json`) либо текст ошибки (`{"need":…}` / `{"error":…}`).
fn cc(e: &mut Engine, name: &str, args: Value) -> Result<Value, String> {
    let out = raw(e, "clientCall", &json!({"name": name, "args_json": args.to_string()}));
    if out.get("need").is_some() || out.get("error").is_some() {
        return Err(out.to_string());
    }
    let text = out["result_json"].as_str().unwrap_or("null");
    Ok(serde_json::from_str(text).unwrap())
}

fn out_request(v: &Value) -> OutRequest {
    let method: &'static str = Box::leak(v["method"].as_str().unwrap().to_string().into_boxed_str());
    let chan = if v["chan"] == "anon" { Chan::Anon } else { Chan::Id };
    OutRequest { chan, method, body: b64d(v["body"].as_str().unwrap_or("")), dest: None }
}

/// Выполнить запросы результата клиента на мини-сервере.
fn run_on(srv: &mut Server, user: &str, reqs: &Value) {
    let list: Vec<Value> = match reqs {
        Value::Array(a) => a.clone(),
        Value::Object(_) => vec![reqs.clone()],
        _ => vec![],
    };
    for r in list {
        srv.handle(user, "d1", &out_request(&r));
    }
}

/// Добрать нужду клиента так, как это делает хост web (`controller.ts`, `satisfy`).
fn satisfy(e: &mut Engine, srv: &mut Server, need: &Value) {
    let user = need["user"].as_str().unwrap_or("").to_string();
    match need["kind"].as_str().unwrap() {
        "peerLog" => {
            let after = cc(e, "logVersion", json!({"user": user})).unwrap().as_u64().unwrap() as usize;
            let entries = srv.logs.get(&user).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
            let resp = ipb::DeviceLogSyncResponse { entries, more: false, genesis_hash: vec![], deleted: false };
            cc(e, "ingestLog", json!({"user": user, "syncResponse": b64e(&resp.encode_to_vec())})).unwrap();
        }
        "bundle" => {
            let resp = ipb::DeviceFetchBundleAnonResponse { devices: srv.bundle(&user) };
            cc(e, "ingestBundle", json!({"user": user, "bundleResponse": b64e(&resp.encode_to_vec())})).unwrap();
        }
        other => panic!("нужда {other}"),
    }
}

/// Действие клиента с добором нужд; запросы — на мини-сервер.
fn act(e: &mut Engine, srv: &mut Server, user: &str, name: &str, args: Value) -> Value {
    for _ in 0..8 {
        match cc(e, name, args.clone()) {
            Ok(v) => {
                let reqs = v.get("requests").cloned().unwrap_or_else(|| v.clone());
                run_on(srv, user, &reqs);
                return v;
            }
            Err(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                let need = v.get("need").unwrap_or_else(|| panic!("{name}: {t}")).clone();
                satisfy(e, srv, &need);
            }
        }
    }
    panic!("{name}: не сошлось");
}

fn identity(host: &mut Host, srv: &mut Server, user: &str, key: u8) -> Engine {
    let (mut e, st) = host.open(&cfg(user, key));
    assert!(st.changes.is_empty() || st.changes.iter().all(|c| c.get("message_upsert").is_none()));
    let created = act(&mut e, srv, user, "createIdentity", json!({"otkCount": 5}));
    assert!(created["rootSecret"].as_str().is_some_and(|s| !s.is_empty()), "корень отдан хосту для копии: {created}");
    e
}

/// Ключ доступа владельца — собеседнику «вне полосы» (как профиль): из материала гранта линковки владельца.
fn share_key(owner: &mut Engine, owner_addr: &str, to: &mut Engine) {
    let mat = cc(owner, "linkGrantMaterial", json!({})).unwrap();
    let m: Value = serde_json::from_slice(&b64d(mat.as_str().unwrap())).unwrap();
    let dk = hex::decode(m["dk"].as_str().unwrap()).unwrap();
    cc(to, "setPeerDeliveryKey", json!({"user": owner_addr, "key": b64e(&dk), "generation": m["gen"]})).unwrap();
}

fn flush(host: &mut Host, e: &mut Engine) -> model_common::Step {
    let out = raw(e, "flush", &json!({}));
    assert!(out.get("error").is_none(), "flush: {out}");
    host.drive(e, out, true)
}

fn send_text(e: &mut Engine, srv: &mut Server, from: &str, to: &str, text: &str, op_id: &str) {
    let content = json!({"text": {"text": text}});
    act(e, srv, from, "prepareDirect", json!({"peer": to, "contentJson": content.to_string(), "opId": op_id}));
}

fn record_bytes(srv: &Server, user: &str, i: usize) -> Vec<u8> {
    srv.inbox.get(&(user.to_string(), "d1".to_string())).expect("инбокс")[i].encode_to_vec()
}

fn ingest_record(e: &mut Engine, rec: &[u8]) -> Value {
    raw(e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_INBOX_RECORD", "body": b64e(rec)}))
}

/// Тексты событий `client_events` итога, по порядку.
fn event_texts(changes: &[Value]) -> Vec<String> {
    let mut out = vec![];
    for c in changes {
        let Some(ev) = c.get("client_events") else { continue };
        let list: Value = serde_json::from_str(ev["json"].as_str().unwrap()).unwrap();
        for e in list.as_array().into_iter().flatten() {
            if let Some(t) = e["content"]["text"]["text"].as_str() {
                out.push(t.to_string());
            }
        }
    }
    out
}

fn client_needs(changes: &[Value]) -> Vec<Value> {
    changes
        .iter()
        .filter_map(|c| c.get("needs"))
        .filter(|n| n["kind"] == "client")
        .map(|n| serde_json::from_str(n["detail"].as_str().unwrap()).unwrap())
        .collect()
}

fn methods(out: &Value) -> Vec<String> {
    out["requests"].as_array().into_iter().flatten().map(|r| r["method"].as_str().unwrap().to_string()).collect()
}

#[test]
fn client_lives_in_the_model_and_survives_reopen() {
    let mut srv = Server::default();
    let mut host = Host::default();
    let mut e = identity(&mut host, &mut srv, "alice@local", 3);
    let v = cc(&mut e, "logVersion", json!({"user": "alice@local"})).unwrap().as_u64().unwrap();
    assert!(v > 0, "журнал своих устройств в модели");
    assert_eq!(cc(&mut e, "hasRoot", json!({})).unwrap(), json!(true));
    assert_eq!(cc(&mut e, "selfAddress", json!({})).unwrap(), json!("alice@local"));
    let st = flush(&mut host, &mut e);
    assert!(st.puts.contains(&"engine-core".to_string()), "состояние клиента — в пачке хранилища модели: {:?}", st.puts);
    // Перезапуск над тем же хранилищем: личность та же, корень на диск не попал (C1-06)
    let (mut e2, _) = host.open(&cfg("alice@local", 3));
    assert_eq!(cc(&mut e2, "logVersion", json!({"user": "alice@local"})).unwrap().as_u64().unwrap(), v);
    assert_eq!(cc(&mut e2, "hasRoot", json!({})).unwrap(), json!(false), "корень — только в памяти");
    // Чтение клиента состояние не меняет — пачки нет
    let st = flush(&mut host, &mut e2);
    assert_eq!(st.batches, 0, "чтение не пишет на диск: {:?}", st.puts);
    // Действие меняет — пачка есть
    cc(&mut e2, "ensureStateKey", json!({})).unwrap();
    let st = flush(&mut host, &mut e2);
    assert!(st.puts.contains(&"engine-core".to_string()));
}

#[test]
fn unknown_client_call_is_reported() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg("alice@local", 3));
    let out = raw(&mut e, "clientCall", &json!({"name": "noSuchCall", "args_json": "{}"}));
    assert_eq!(out["error"], "UnknownCall", "{out}");
}

#[test]
fn inbox_records_go_through_ingest_in_order_and_ack_after_commit() {
    let mut srv = Server::default();
    let (mut ha, mut hb) = (Host::default(), Host::default());
    let mut alice = identity(&mut ha, &mut srv, "alice@local", 3);
    let mut bob = identity(&mut hb, &mut srv, "bob@local", 4);
    flush(&mut hb, &mut bob);
    share_key(&mut bob, "bob@local", &mut alice);
    send_text(&mut alice, &mut srv, "alice@local", "bob@local", "первое", "");
    send_text(&mut alice, &mut srv, "alice@local", "bob@local", "второе", "");
    let count = srv.inbox[&("bob@local".to_string(), "d1".to_string())].len();
    assert!(count >= 2, "две записи у получателя");
    let first = record_bytes(&srv, "bob@local", 0);

    // Первая запись ждёт журнал отправителя: нужда — хосту, событий нет, подтверждения нет
    let out = ingest_record(&mut bob, &first);
    assert!(methods(&out).iter().all(|m| m != "msg.inbox.ack"), "без применённого — без ack: {out}");
    let st = hb.drive(&mut bob, out, true);
    let needs = client_needs(&st.changes);
    assert_eq!(needs.len(), 1, "нужда клиента — хосту: {:?}", st.changes);
    assert!(event_texts(&st.changes).is_empty());
    // Следующие записи стоят за первой (ORDER-1), даже если им самим ничего не нужно
    for i in 1..count {
        let out = ingest_record(&mut bob, &record_bytes(&srv, "bob@local", i));
        let st = hb.drive(&mut bob, out, true);
        assert!(event_texts(&st.changes).is_empty(), "запись {i} не обгоняет первую: {:?}", st.changes);
    }

    // Хост добрал нужду и просит повторить — обе записи по порядку, ack — после фиксации пачки
    satisfy(&mut bob, &mut srv, &needs[0]);
    let out = raw(&mut bob, "ingest", &json!({"kind": "SERVER_INPUT_KIND_EVENT", "method": "retry"}));
    assert!(out["store_batch"].is_object(), "применённое — на диск: {out}");
    assert!(methods(&out).iter().all(|m| m != "msg.inbox.ack"), "ack — не раньше фиксации: {out}");
    hb.log.clear();
    let mut st = hb.drive(&mut bob, out, true);
    let mut texts = event_texts(&st.changes);
    // Хост добирает, пока модель просит (как web `satisfy`)
    for _ in 0..4 {
        let more = client_needs(&st.changes);
        if more.is_empty() {
            break;
        }
        eprintln!("ещё нужды: {more:?}");
        for n in &more {
            satisfy(&mut bob, &mut srv, n);
        }
        let out = raw(&mut bob, "ingest", &json!({"kind": "SERVER_INPUT_KIND_EVENT", "method": "retry"}));
        st = hb.drive(&mut bob, out, true);
        texts.extend(event_texts(&st.changes));
    }
    assert_eq!(texts, vec!["первое".to_string(), "второе".to_string()]);
    let commit = hb.log.iter().position(|l| l.starts_with("commit:")).expect("фиксация");
    let ack = hb.log.iter().position(|l| l == "req:msg.inbox.ack").expect("ack после фиксации");
    assert!(commit < ack, "{:?}", hb.log);
    // Повтор той же записи (сервер отдал её снова до ack) — без повторного события
    let out = ingest_record(&mut bob, &first);
    let st = hb.drive(&mut bob, out, true);
    assert!(event_texts(&st.changes).is_empty(), "повтор не показывается дважды: {:?}", st.changes);
}

#[test]
fn poll_in_host_mode_syncs_inbox_but_not_history() {
    let mut srv = Server::default();
    let (mut ha, mut hb) = (Host::default(), Host::default());
    let mut alice = identity(&mut ha, &mut srv, "alice@local", 3);
    let mut bob = identity(&mut hb, &mut srv, "bob@local", 4);
    cc(&mut bob, "ensureStateKey", json!({})).unwrap();
    // Журнал отправителя уже известен получателю — запись открывается сразу
    let resp = ipb::DeviceLogSyncResponse { entries: srv.logs["alice@local"].clone(), more: false, genesis_hash: vec![], deleted: false };
    cc(&mut bob, "ingestLog", json!({"user": "alice@local", "syncResponse": b64e(&resp.encode_to_vec())})).unwrap();
    flush(&mut hb, &mut bob);
    share_key(&mut bob, "bob@local", &mut alice);
    send_text(&mut alice, &mut srv, "alice@local", "bob@local", "по опросу", "");

    let out = raw(&mut bob, "tick", &json!({"now_ms": (NOW + 120_000).to_string()}));
    let ms = methods(&out);
    assert!(ms.contains(&"msg.inbox.sync".to_string()), "инбокс опрашивает модель: {ms:?}");
    assert!(!ms.iter().any(|m| m.starts_with("history.")), "историю в режиме хоста ведёт хост: {ms:?}");
    let sync = out["requests"].as_array().unwrap().iter().find(|r| r["method"] == "msg.inbox.sync").unwrap().clone();
    hb.drive(&mut bob, out, true);
    let records = srv.inbox[&("bob@local".to_string(), "d1".to_string())].clone();
    let body = InboxSyncResponse { records, more: false }.encode_to_vec();
    let resp = raw(&mut bob, "ingest", &json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": sync["req_id"], "body": b64e(&body)}));
    let st = hb.drive(&mut bob, resp, true);
    assert_eq!(event_texts(&st.changes), vec!["по опросу".to_string()]);
    assert!(hb.log.iter().any(|l| l == "req:msg.inbox.ack"));
}

#[test]
fn history_call_uses_the_model_session() {
    let mut srv = Server::default();
    let mut host = Host::default();
    let mut e = identity(&mut host, &mut srv, "alice@local", 3);
    let no_key = raw(&mut e, "historyCall", &json!({"name": "headRequest", "args_json": "{}"}));
    assert_eq!(no_key["error"], "NotFound", "без ключа состояния сессии нет: {no_key}");
    cc(&mut e, "ensureStateKey", json!({})).unwrap();
    let out = raw(&mut e, "historyCall", &json!({"name": "headRequest", "args_json": "{}"}));
    let body: Value = serde_json::from_str(out["result_json"].as_str().expect("результат")).unwrap();
    assert!(body.is_string(), "тело запроса — base64: {body}");
}

#[test]
fn client_replace_starts_a_fresh_device() {
    let mut srv = Server::default();
    let mut host = Host::default();
    let mut e = identity(&mut host, &mut srv, "alice@local", 3);
    let blob = cc(&mut e, "export", json!({"key": b64e(&[5u8; 32])})).unwrap();
    let out = raw(&mut e, "clientReplace", &json!({"mode": "new"}));
    assert!(out.get("error").is_none(), "{out}");
    assert_eq!(cc(&mut e, "logVersion", json!({"user": "alice@local"})).unwrap().as_u64().unwrap(), 0);
    assert_eq!(cc(&mut e, "hasRoot", json!({})).unwrap(), json!(false));
    // Прежнее состояние — обратно из экспорта (копия устройства, пауза привязки)
    let out = raw(&mut e, "clientReplace", &json!({"mode": "import", "blob": blob, "key": b64e(&[5u8; 32])}));
    assert!(out.get("error").is_none(), "{out}");
    assert!(cc(&mut e, "logVersion", json!({"user": "alice@local"})).unwrap().as_u64().unwrap() > 0);
    let st = flush(&mut host, &mut e);
    assert!(st.puts.contains(&"engine-core".to_string()));
}

#[test]
fn skipped_record_lets_the_following_ones_through() {
    let mut srv = Server::default();
    let (mut ha, mut hb) = (Host::default(), Host::default());
    let mut alice = identity(&mut ha, &mut srv, "alice@local", 3);
    let mut bob = identity(&mut hb, &mut srv, "bob@local", 4);
    flush(&mut hb, &mut bob);
    share_key(&mut bob, "bob@local", &mut alice);
    send_text(&mut alice, &mut srv, "alice@local", "bob@local", "первое", "");
    let first = record_bytes(&srv, "bob@local", 0);
    let out = ingest_record(&mut bob, &first);
    let st = hb.drive(&mut bob, out, true);
    assert_eq!(client_needs(&st.changes).len(), 1);
    // Хост сдался: запись пропущена, подтверждения её нет (сервер отдаст снова)
    let out = raw(&mut bob, "ingest", &json!({"kind": "SERVER_INPUT_KIND_EVENT", "method": "skip"}));
    assert!(methods(&out).iter().all(|m| m != "msg.inbox.ack"), "{out}");
    let st = hb.drive(&mut bob, out, true);
    assert!(event_texts(&st.changes).is_empty());
    // Пропущенная больше не держит очередь: повтор после добора открывается
    let resp = ipb::DeviceLogSyncResponse { entries: srv.logs["alice@local"].clone(), more: false, genesis_hash: vec![], deleted: false };
    cc(&mut bob, "ingestLog", json!({"user": "alice@local", "syncResponse": b64e(&resp.encode_to_vec())})).unwrap();
    let count = srv.inbox[&("bob@local".to_string(), "d1".to_string())].len();
    let mut texts = vec![];
    for i in 0..count {
        let out = ingest_record(&mut bob, &record_bytes(&srv, "bob@local", i));
        texts.extend(event_texts(&hb.drive(&mut bob, out, true).changes));
    }
    assert_eq!(texts, vec!["первое".to_string()], "повтор пропущенной открывается");
}
