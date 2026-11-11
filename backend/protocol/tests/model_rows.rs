//! spec 035 T114 (contracts/engine-api.md, режим `host_driven`): строками истории хоста владеет модель. Хост (web)
//! подаёт операции журнала истории (`rowsApply`): сведение (HIST-1), место в ленте (ORDER-1), маркеры (READ-2),
//! хранение и показ (`MessageView` с содержимым в виде хоста `wire`, `historyPage`, `chatList`, `rowsAll`) — модель.
//! Пачка `rowsApply` — только строки и маркеры (SYNC-1: строка на диске раньше курсора инбокса другого итога).
//! Имена и тексты — выдуманные.

mod model_common;

use model_common::{b64e, call, Host};
use parvane_protocol::model::Engine;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;
const SELF: &str = "alice@local";
const PEER: &str = "bob@local";
const ID1: &str = "01923a4b-5c6d-7001-8000-000000000001";
const ID2: &str = "01923a4b-5c6d-7001-8000-000000000002";
const ID3: &str = "01923a4b-5c6d-7001-8000-000000000003";
const OP1: &str = "01923a4b-5c6d-7001-8000-0000000000a1";
const OP2: &str = "01923a4b-5c6d-7001-8000-0000000000a2";

fn cfg() -> Value {
    json!({
        "user": SELF, "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(),
        "device_key": b64e(&[5u8; 32]), "host_driven": true, "features": ["wire_rows"],
    })
}

fn direct() -> Value {
    json!({"user": {"address": PEER}})
}

fn body(content: Value) -> String {
    b64e(json!({ "content": content }).to_string().as_bytes())
}

fn row(id: &str, from: &str, ts_ms: i64, content: Value) -> Value {
    json!({"row": {"id": id, "chat": direct(), "from": from, "ts_ms": ts_ms.to_string(), "body": body(content)}})
}

fn text(t: &str) -> Value {
    json!({"kind": "text", "text": t})
}

fn apply(host: &mut Host, e: &mut Engine, args: Value) -> model_common::Step {
    let out = call(e, "rowsApply", &args).expect("rowsApply");
    host.drive(e, out, true)
}

fn ops(host: &mut Host, e: &mut Engine, list: Value, now: i64) -> model_common::Step {
    apply(host, e, json!({"ops_json": list.to_string(), "now_ms": now.to_string()}))
}

fn upserts(st: &model_common::Step) -> Vec<Value> {
    st.changes.iter().filter_map(|c| c.get("message_upsert").cloned()).collect()
}

fn removes(st: &model_common::Step) -> usize {
    st.changes.iter().filter(|c| c.get("message_remove").is_some()).count()
}

fn wire(v: &Value) -> Value {
    serde_json::from_str(v["wire"].as_str().unwrap_or("null")).unwrap_or(Value::Null)
}

fn page(e: &mut Engine) -> Vec<Value> {
    let p = call(e, "historyPage", &json!({"chat": direct(), "limit": 50})).unwrap();
    p["rows"].as_array().cloned().unwrap_or_default()
}

fn all(e: &mut Engine, what: Value) -> Value {
    let out = call(e, "rowsAll", &what).unwrap();
    serde_json::from_str(out["result_json"].as_str().unwrap()).unwrap()
}

fn open() -> (Host, Engine) {
    let mut host = Host::default();
    let (e, _) = host.open(&cfg());
    (host, e)
}

#[test]
fn rows_live_in_model_and_survive_restart() {
    let (mut host, mut e) = open();
    let st = ops(&mut host, &mut e, json!([row(ID1, PEER, NOW - 10_000, text("привет"))]), NOW);
    let up = upserts(&st);
    assert_eq!(up.len(), 1, "строка показана: {:?}", st.changes);
    assert_eq!(wire(&up[0])["content"], text("привет"));
    assert_eq!(up[0]["from"], PEER);
    // Пачка вызова — только строки (и маркеры): ядро клиента уходит своим итогом
    assert!(st.puts.iter().all(|k| k == "history-row" || k == "history-mark"), "виды пачки: {:?}", st.puts);
    assert!(st.puts.contains(&"history-row".to_string()));
    assert!(st.changes.iter().any(|c| c.get("chat_upsert").is_some()), "чат в списке");
    // Перезапуск: строка читается из модели
    let (mut e2, _) = host.open(&cfg());
    let rows = page(&mut e2);
    assert_eq!(rows.len(), 1);
    assert_eq!(wire(&rows[0])["content"]["text"], "привет");
    let list = call(&mut e2, "chatList", &json!({"limit": 10})).unwrap();
    assert_eq!(list["chats"][0]["last"]["wire"], rows[0]["wire"]);
    // Повтор той же строки — не изменение
    let st = ops(&mut host, &mut e2, json!([row(ID1, PEER, NOW - 10_000, text("привет"))]), NOW);
    assert!(upserts(&st).is_empty() && removes(&st) == 0, "повтор без следа: {:?}", st.changes);
}

#[test]
fn tombstone_is_not_resurrected_and_orphan_waits() {
    let (mut host, mut e) = open();
    ops(&mut host, &mut e, json!([row(ID1, PEER, NOW - 10_000, text("раз"))]), NOW);
    let gone = json!({"gone": {"target": ID1, "chat": direct(), "stamp": {"ts_ms": NOW.to_string(), "op_id": OP1},
        "scope": "GONE_SCOPE_EVERYONE", "by": PEER}});
    let st = ops(&mut host, &mut e, json!([gone]), NOW);
    assert_eq!(removes(&st), 1);
    let st = ops(&mut host, &mut e, json!([row(ID1, PEER, NOW - 10_000, text("раз"))]), NOW);
    assert!(upserts(&st).is_empty(), "удалённое не воскресает");
    assert!(page(&mut e).is_empty());
    // Удаление раньше сообщения: сирота — снята (не показана), строка потом не появляется
    let gone2 = json!({"gone": {"target": ID2, "chat": direct(), "stamp": {"ts_ms": NOW.to_string(), "op_id": OP2},
        "scope": "GONE_SCOPE_EVERYONE", "by": PEER}});
    let st = ops(&mut host, &mut e, json!([gone2]), NOW);
    assert_eq!((upserts(&st).len(), removes(&st)), (0, 1), "изменение сироты — снятие");
    let st = ops(&mut host, &mut e, json!([row(ID2, PEER, NOW - 5_000, text("два"))]), NOW);
    assert!(upserts(&st).is_empty());
    let states = all(&mut e, json!({"states": true}))["states"].as_array().cloned().unwrap();
    assert_eq!(states.len(), 2, "надгробия хранятся");
}

#[test]
fn live_message_goes_after_shown_and_keeps_place() {
    let (mut host, mut e) = open();
    ops(&mut host, &mut e, json!([row(ID1, SELF, NOW, text("вопрос"))]), NOW);
    // Ответ собеседника с отстающими часами (на 60 с) — после вопроса (ORDER-1)
    let st = ops(&mut host, &mut e, json!([row(ID2, PEER, NOW - 60_000, text("ответ"))]), NOW + 1_000);
    let a = upserts(&st)[0]["order"].as_str().unwrap().parse::<i64>().unwrap();
    assert!(a > NOW, "живое — после показанного: {a}");
    // Старое (догон) — по времени отправителя
    let st = ops(&mut host, &mut e, json!([row(ID3, PEER, NOW - 86_400_000, text("старое"))]), NOW + 2_000);
    assert_eq!(upserts(&st)[0]["order"], json!((NOW - 86_400_000).to_string()));
    let (mut e2, _) = host.open(&cfg());
    let texts: Vec<String> = page(&mut e2).iter().map(|r| wire(r)["content"]["text"].as_str().unwrap().to_string()).collect();
    assert_eq!(texts, vec!["старое", "вопрос", "ответ"], "место сохраняется после перезапуска");
}

#[test]
fn marks_merge_and_survive_restart() {
    let (mut host, mut e) = open();
    ops(&mut host, &mut e, json!([row(ID1, PEER, NOW - 2_000, text("1")), row(ID2, PEER, NOW - 1_000, text("2"))]), NOW);
    let mark = |ts: i64, id: &str| json!({"read": {"chat": direct(), "up_to_ts_ms": ts.to_string(), "up_to_id": id}});
    let st = ops(&mut host, &mut e, json!([mark(NOW - 1_000, ID2)]), NOW);
    assert!(st.puts.contains(&"history-mark".to_string()));
    assert!(st.changes.iter().any(|c| c["unread_changed"].is_object()), "непрочитанное от маркера");
    // Более ранний маркер не откатывает
    ops(&mut host, &mut e, json!([mark(NOW - 2_000, ID1)]), NOW);
    let (mut e2, _) = host.open(&cfg());
    let marks = all(&mut e2, json!({"marks": true}))["marks"].as_array().cloned().unwrap();
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0]["up_to_id"], ID2);
}

#[test]
fn receipt_forget_wipe() {
    let (mut host, mut e) = open();
    ops(&mut host, &mut e, json!([row(ID1, SELF, NOW - 5_000, text("моё")), row(ID2, PEER, NOW - 4_000, text("его"))]), NOW);
    let t = |id: &str| json!([{"chat": direct(), "target": id}]).to_string();
    let st = apply(&mut host, &mut e, json!({"receipts_json": t(ID1)}));
    assert_eq!(upserts(&st)[0]["delivery"], "DELIVERY_READ");
    let st = apply(&mut host, &mut e, json!({"receipts_json": t(ID1)}));
    assert!(upserts(&st).is_empty(), "повтор квитанции без следа");
    let st = apply(&mut host, &mut e, json!({"forget_json": t(ID2)}));
    assert_eq!(removes(&st), 1);
    assert!(st.deletes.contains(&"history-row".to_string()));
    assert_eq!(page(&mut e).len(), 1);
    let st = apply(&mut host, &mut e, json!({"wipe": true}));
    assert_eq!(removes(&st), 1);
    let (mut e2, _) = host.open(&cfg());
    assert!(page(&mut e2).is_empty());
    assert!(all(&mut e2, json!({"states": true, "marks": true}))["states"].as_array().unwrap().is_empty());
}

#[test]
fn edit_patch_service_rows_and_legacy_import() {
    let (mut host, mut e) = open();
    ops(&mut host, &mut e, json!([row(ID1, PEER, NOW - 5_000, text("было"))]), NOW);
    let patch = b64e(json!({"edit_patch": {"text": "стало", "webpage": {"url": "https://example.org"}}}).to_string().as_bytes());
    let edit = json!({"edit": {"target": ID1, "chat": direct(), "stamp": {"ts_ms": NOW.to_string(), "op_id": OP1}, "body": patch, "by": PEER}});
    let st = ops(&mut host, &mut e, json!([edit]), NOW);
    let w = wire(&upserts(&st)[0]);
    assert_eq!(w["content"]["text"], "стало", "правка наложена движком");
    assert_eq!(w["content"]["webpage"]["url"], "https://example.org");
    assert!(upserts(&st)[0]["edited_ts_ms"].is_string());
    // Голос опроса — служебная строка: в ленте и списке её нет, в `rowsAll` и изменениях хосту (опросы) — есть
    let st = ops(&mut host, &mut e, json!([row(ID2, PEER, NOW - 1_000, json!({"kind": "poll_vote", "poll": ID1, "options": [0]}))]), NOW);
    assert_eq!(wire(&upserts(&st)[0])["content"]["kind"], "poll_vote");
    assert_eq!(page(&mut e).len(), 1);
    let list = call(&mut e, "chatList", &json!({"limit": 10})).unwrap();
    assert_eq!(wire(&list["chats"][0]["last"])["content"]["text"], "стало");
    let views = all(&mut e, json!({"views": true}))["views"].as_array().cloned().unwrap();
    assert_eq!(views.len(), 2);
    // Строка прежнего кэша хоста: место прежнее
    let state = call(&mut e, "rowsAll", &json!({"states": true})).unwrap();
    let _ = state;
    let legacy = json!([{"hs": {"target": ID3, "chat": direct(), "row": {"id": ID3, "chat": direct(), "from": PEER,
        "ts_ms": (NOW - 3_000).to_string(), "body": body(text("из кэша"))}}, "order": NOW + 77}]);
    let st = apply(&mut host, &mut e, json!({"rows_json": legacy.to_string()}));
    assert_eq!(upserts(&st)[0]["order"], json!((NOW + 77).to_string()));
}

#[test]
fn rows_batch_does_not_carry_client_and_needs_host_mode() {
    let (mut host, mut e) = open();
    // Клиент изменён (ключ личного состояния) — его запись уходит своим итогом, не пачкой строк
    let out = call(&mut e, "clientCall", &json!({"name": "ensureStateKey", "args_json": "{}"})).unwrap();
    assert!(out.get("result_json").is_some());
    let args = json!({"ops_json": json!([row(ID1, PEER, NOW - 5_000, text("x"))]).to_string(), "now_ms": NOW.to_string()});
    let out = call(&mut e, "rowsApply", &args).unwrap();
    let kinds: Vec<String> = out["store_batch"]["puts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["key"].as_str().unwrap().split('/').nth(1).unwrap_or("").to_string())
        .collect();
    assert!(!kinds.is_empty() && kinds.iter().all(|k| k == "history-row"), "виды пачки строк: {kinds:?}");
    // Хост фиксирует её; изменённый клиент — следующим итогом (после фиксации)
    let st = host.drive(&mut e, out, true);
    assert_eq!(st.batches, 2, "клиент — отдельной пачкой после строк: {:?}", st.puts);
    // Не в режиме хоста — строки ведёт сама модель
    let mut h2 = Host::default();
    let mut c = cfg();
    c["host_driven"] = json!(false);
    let (mut e2, _) = h2.open(&c);
    assert!(call(&mut e2, "rowsApply", &json!({"ops_json": "[]"})).is_err());
}
