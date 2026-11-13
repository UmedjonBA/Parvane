//! spec 036 (ENGINE-1, E3/E4/E7): список чатов и прочитанность — готовыми из модели. `ChatView` несёт закреп, мут,
//! черновик, папки, отметку «непрочитано» и упоминание; чат без строк, но с черновиком, — в списке; закреплённые —
//! первыми; `unread_changed` — со счётчиком, маркером и упоминаниями; `MessageView.unread` у входящего после маркера.
//! Имена и тексты — выдуманные.

mod model_common;

use model_common::{b64e, call, Host};
use parvane_protocol::pb::parvane::core::v2::UserRef;
use parvane_protocol::pb::parvane::msg::v2::Text;
use parvane_protocol::pb::parvane::state::v1::{peer, Draft, NotifySettings, Peer, PeerNotify, PinList, PinnedOrder};
use prost::Message;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;

fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

/// Поля значения объекта — каждое своим `FieldValue` (байты поля с тегом).
fn fields<M: Message>(parts: Vec<(u32, M)>) -> Value {
    Value::Array(parts.into_iter().map(|(f, m)| json!({"field": f, "value": b64e(&m.encode_to_vec())})).collect())
}

fn create(kind: &str, key: &str, set: Value) -> Value {
    json!({"state_create": {"object": {"kind": kind, "key": key}, "set": set}})
}

fn incoming(e: &mut parvane_protocol::model::Engine, host: &mut Host, from: &str, n: u8, ts: i64, text: &str) {
    let out = call(e, "vectorInput", &json!({"incoming": {"chat": {"user": {"address": from}}, "from": from,
        "id": format!("{n:02x}").repeat(16), "ts_ms": ts, "content": {"text": {"text": text}}}})).unwrap();
    host.drive(e, out, true);
}

fn chat_of(list: &Value, addr: &str) -> Value {
    list["chats"].as_array().unwrap().iter().find(|c| c["chat"]["user"]["address"] == addr).cloned().unwrap_or(Value::Null)
}

#[test]
fn chat_view_is_complete_and_pinned_first() {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    incoming(&mut e, &mut host, "bob@local", 1, NOW - 3_000, "старое");
    incoming(&mut e, &mut host, "carol@local", 2, NOW - 2_000, "привет, @alice, глянь");
    incoming(&mut e, &mut host, "carol@local", 3, NOW - 1_000, "и ещё");

    // Закреп bob (основной список), мут carol, черновик в чате dave без строк, отметка «непрочитано» у bob
    let pin = PinnedOrder { list: PinList::Main as i32, peers: vec![user("bob@local")] };
    let set = fields(vec![(2, PinnedOrder { peers: pin.peers.clone(), ..Default::default() })]);
    let out = call(&mut e, "submit", &create("OBJECT_KIND_PIN_LIST", "1", set)).unwrap();
    host.drive(&mut e, out, true);
    let notify = PeerNotify { peer: None, settings: Some(NotifySettings { mute_until_ms: Some(NOW + 3_600_000), ..Default::default() }) };
    let out = call(&mut e, "submit", &create("OBJECT_KIND_PEER_NOTIFY", "u:carol@local", fields(vec![
        (1, PeerNotify { peer: Some(user("carol@local")), settings: None }),
        (2, PeerNotify { peer: None, settings: notify.settings }),
    ]))).unwrap();
    host.drive(&mut e, out, true);
    let text = Text { text: "недописанное".into(), ..Default::default() }.encode_to_vec();
    let out = call(&mut e, "submit", &create("OBJECT_KIND_DRAFT", "u:dave@local", fields(vec![
        (1, Draft { peer: Some(user("dave@local")), ..Default::default() }),
        (2, Draft { text, ..Default::default() }),
        (4, Draft { date_ms: NOW - 500, ..Default::default() }),
    ]))).unwrap();
    let st = host.drive(&mut e, out, true);
    assert!(st.changes.iter().any(|c| c["chat_upsert"]["chat"]["user"]["address"] == "dave@local"), "чат с черновиком появился: {:?}", st.changes);
    let out = call(&mut e, "submit", &create("OBJECT_KIND_UNREAD_MARK", "u:bob@local", json!([]))).unwrap();
    host.drive(&mut e, out, true);

    let list = call(&mut e, "chatList", &json!({"limit": 10})).unwrap();
    let order: Vec<&str> = list["chats"].as_array().unwrap().iter().map(|c| c["chat"]["user"]["address"].as_str().unwrap()).collect();
    assert_eq!(order, vec!["bob@local", "dave@local", "carol@local"], "закреплённый первым, дальше по времени: {list}");
    let bob = chat_of(&list, "bob@local");
    assert_eq!(bob["pinned_rank"], 1);
    assert_eq!(bob["unread_mark"], true);
    let carol = chat_of(&list, "carol@local");
    assert_eq!(carol["muted_until_ms"], json!((NOW + 3_600_000).to_string()));
    assert_eq!(carol["unread"], 2);
    assert_eq!(carol["mention"], true, "упоминание своего ника");
    let dave = chat_of(&list, "dave@local");
    assert_eq!(dave["draft"], "недописанное");
    assert!(dave["last"].is_null());

    // Маркер «прочитано до» второй строки carol: остаётся 1, упоминание прочитано; строка после маркера — unread
    let up_to = json!({"ts_ms": (NOW - 2_000).to_string(), "id": b64e(&[2; 16])});
    let out = call(&mut e, "submit", &json!({"read": {"chat": {"user": {"address": "carol@local"}}, "up_to": up_to}})).unwrap();
    let st = host.drive(&mut e, out, true);
    let u = st.changes.iter().find_map(|c| c.get("unread_changed")).cloned().unwrap_or_else(|| panic!("unread_changed: {:?}", st.changes));
    assert_eq!(u["count"], 1, "{u}");
    assert_ne!(u["mention"], true, "{u}");
    assert!(u["last_read_id"].is_string(), "{u}");
    let page = call(&mut e, "historyPage", &json!({"chat": {"user": {"address": "carol@local"}}, "limit": 10})).unwrap();
    let unread: Vec<bool> = page["rows"].as_array().unwrap().iter().map(|r| r["unread"].as_bool().unwrap_or(false)).collect();
    assert_eq!(unread, vec![false, true], "{page}");
}

/// E5: личное состояние по видам JSON-значением — запись `stateSet` (разница считается движком), показ
/// `viewStateJson`, удаление; список чатов видит папку и архив.
#[test]
fn state_json_set_view_and_delete() {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    incoming(&mut e, &mut host, "bob@local", 1, NOW - 3_000, "привет");
    let folder = |title: &str| json!({"kind": "OBJECT_KIND_FOLDER", "key": "5", "value": {"id": 5, "title": title,
        "include_peers": [{"user": {"address": "bob@local"}}]}});
    let out = call(&mut e, "stateSet", &folder("Работа")).unwrap();
    let st = host.drive(&mut e, out, true);
    assert!(st.changes.iter().any(|c| c["state_changed"]["object"]["key"] == "5"), "{:?}", st.changes);
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["OBJECT_KIND_FOLDER"]})).unwrap();
    let objs = v["objects"].as_array().unwrap();
    assert_eq!(objs.len(), 1, "{v}");
    assert_eq!(objs[0]["value"]["title"], "Работа");
    assert_eq!(objs[0]["value"]["include_peers"][0]["user"]["address"], "bob@local");
    let list = call(&mut e, "chatList", &json!({"limit": 10})).unwrap();
    assert_eq!(chat_of(&list, "bob@local")["folder_ids"], json!([5]), "{list}");
    // Та же запись — без операции; правка названия — только оно
    let out = call(&mut e, "stateSet", &folder("Работа")).unwrap();
    assert!(host.drive(&mut e, out, true).changes.iter().all(|c| c.get("state_changed").is_none()), "без изменений — без операции");
    let out = call(&mut e, "stateSet", &folder("Дом")).unwrap();
    host.drive(&mut e, out, true);
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["FOLDER"]})).unwrap();
    assert_eq!(v["objects"][0]["value"]["title"], "Дом");
    // Признак архива — пустым значением
    let out = call(&mut e, "stateSet", &json!({"kind": "OBJECT_KIND_ARCHIVE", "key": "u:bob@local", "value": {}})).unwrap();
    host.drive(&mut e, out, true);
    let list = call(&mut e, "chatList", &json!({"limit": 10, "folder": 1})).unwrap();
    assert_eq!(chat_of(&list, "bob@local")["archived"], true, "{list}");
    let out = call(&mut e, "stateSet", &json!({"kind": "OBJECT_KIND_FOLDER", "key": "5", "delete": true})).unwrap();
    host.drive(&mut e, out, true);
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["OBJECT_KIND_FOLDER"]})).unwrap();
    assert!(v["objects"].as_array().unwrap().is_empty(), "{v}");
    assert!(call(&mut e, "stateSet", &json!({"kind": "NO_SUCH", "key": "x"})).is_err());
}

/// spec 036 (desktop, T028): `stateSet` с `base` — меняются только поля, которые хост правил относительно
/// показанного; правка другого устройства, сведённая моделью после показа, не откатывается устаревшей копией хоста
/// (гонка T124). Без `base` то же значение вернуло бы прежнее название.
#[test]
fn state_set_with_base_keeps_fields_host_did_not_touch() {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    let folder = |title: &str, peers: &[&str]| json!({"id": 5, "title": title,
        "include_peers": peers.iter().map(|p| json!({"user": {"address": p}})).collect::<Vec<_>>()});
    let set = |e: &mut parvane_protocol::model::Engine, host: &mut Host, args: Value| {
        let out = call(e, "stateSet", &args).unwrap();
        host.drive(e, out, true);
    };
    let shown = folder("Работа", &["bob@local"]);
    set(&mut e, &mut host, json!({"kind": "OBJECT_KIND_FOLDER", "key": "5", "value": shown}));
    // Другое устройство переименовало папку (сведено моделью), хост ещё показывает прежнее название
    set(&mut e, &mut host, json!({"kind": "OBJECT_KIND_FOLDER", "key": "5", "value": folder("Работа+дом", &["bob@local"])}));
    // Хост добавил carol в папку, которую строил по показанному
    set(&mut e, &mut host, json!({"kind": "OBJECT_KIND_FOLDER", "key": "5",
        "value": folder("Работа", &["bob@local", "carol@local"]), "base": shown}));
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["OBJECT_KIND_FOLDER"]})).unwrap();
    let f = &v["objects"][0]["value"];
    assert_eq!(f["title"], "Работа+дом", "название другого устройства на месте: {v}");
    assert_eq!(f["include_peers"].as_array().map(Vec::len), Some(2), "добавленный чат в папке: {v}");
    // Поле, убранное хостом (было в показанном), снимается; не тронутое — остаётся
    let shown2 = json!({"id": 5, "title": "Работа+дом", "emoticon": "💼",
        "include_peers": [{"user": {"address": "bob@local"}}, {"user": {"address": "carol@local"}}]});
    set(&mut e, &mut host, json!({"kind": "OBJECT_KIND_FOLDER", "key": "5", "value": shown2}));
    set(&mut e, &mut host, json!({"kind": "OBJECT_KIND_FOLDER", "key": "5",
        "value": {"id": 5, "title": "Работа+дом", "include_peers": shown2["include_peers"]}, "base": shown2}));
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["OBJECT_KIND_FOLDER"]})).unwrap();
    assert!(v["objects"][0]["value"].get("emoticon").is_none(), "значок снят: {v}");
    assert_eq!(v["objects"][0]["value"]["include_peers"].as_array().map(Vec::len), Some(2), "{v}");
}

/// spec 036 T019 (web): `rewrite` переписывает объект целиком, даже если модель держит то же значение (новый ключ
/// личного состояния — прежние записи новым ключом не читаются); без него та же запись — без операции. Показ
/// `viewStateJson` несёт `write_blocked`.
#[test]
fn state_set_rewrite_and_view_write_blocked() {
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    let args = json!({"kind": "OBJECT_KIND_QUICK_REACTION", "key": "", "value": {"emoji": "👍"}});
    let out = call(&mut e, "stateSet", &args).unwrap();
    assert!(host.drive(&mut e, out, true).batches > 0, "первая запись");
    let out = call(&mut e, "stateSet", &args).unwrap();
    let st = host.drive(&mut e, out, true);
    assert_eq!(st.batches, 0, "то же значение без rewrite — без записи: {:?}", st.changes);
    let mut again = args.clone();
    again["rewrite"] = json!(true);
    let out = call(&mut e, "stateSet", &again).unwrap();
    assert!(host.drive(&mut e, out, true).batches > 0, "rewrite — запись целиком");
    let v = call(&mut e, "viewStateJson", &json!({"kinds": ["QUICK_REACTION"]})).unwrap();
    assert_eq!(v["objects"][0]["value"]["emoji"], "👍", "{v}");
    assert_eq!(v["write_blocked"], false, "{v}");
}

/// PACK-1: id набора — общий вектор `vectors/clients/pack-set-id.json` (его же читают клиенты).
#[test]
fn pack_set_id_vector() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../proto/parvane/vectors/clients/pack-set-id.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for c in v["cases"].as_array().unwrap() {
        let id = parvane_protocol::model::views::pack_set_id(c["content_hash"].as_str().unwrap(), c["pack_name"].as_str().unwrap());
        assert_eq!(id, c["set_id"].as_str().unwrap(), "{}", c["name"]);
        assert_eq!(format!("{id}/{}", c["sticker"].as_str().unwrap()), c["faved_key"].as_str().unwrap(), "{}", c["name"]);
    }
}

/// PACK-1 (spec 036, найдено сценарием tgx_pack_set_flow): «В избранное» стикер набора, чей отпечаток содержит «/»
/// (base64), — принимается; ключ объекта — `set_id/sticker_id` из вектора. Прежде отпечаток с «/» отвергался
/// (`InvalidField("sticker")`), а стикер с «/» в имени файла — отвергается и теперь.
#[test]
fn fave_sticker_accepts_shared_set_id_with_slash() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../proto/parvane/vectors/clients/pack-set-id.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut host = Host::default();
    let cfg = json!({"user": "alice@local", "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "vectors": true});
    let (mut e, _) = host.open(&cfg);
    let mut want = vec![];
    for c in v["cases"].as_array().unwrap() {
        let intent = json!({"fave_sticker": {"set_id": c["set_id"], "sticker_id": c["sticker"], "on": true}});
        let out = call(&mut e, "submit", &intent).unwrap_or_else(|err| panic!("{}: {err:?}", c["name"]));
        host.drive(&mut e, out, true);
        want.push(c["faved_key"].as_str().unwrap().to_string());
    }
    let view = call(&mut e, "viewStateJson", &json!({"kinds": ["OBJECT_KIND_FAVED_STICKER"]})).unwrap();
    let mut keys: Vec<String> = view["objects"].as_array().unwrap().iter().map(|o| o["key"].as_str().unwrap().to_string()).collect();
    keys.sort();
    want.sort();
    assert_eq!(keys, want, "{view}");
    let bad = json!({"fave_sticker": {"set_id": "h:ab/cd==", "sticker_id": "x/y.png", "on": true}});
    assert!(call(&mut e, "submit", &bad).is_err(), "стикер с «/» в имени — отказ");
}
