//! spec 035 T110/T114 (US2): мост личного состояния модели для хоста со снимком `state.v1` (web в переходный
//! период): желаемое → только изменившиеся поля. Два устройства одного аккаунта (общий ключ личного состояния,
//! взятый у прежнего клиента `adopt_state_keys`), без связи правят РАЗНЫЕ поля одной папки и одного контакта —
//! после обмена записями через сервер оба изменения есть на обоих и на третьем устройстве (прежний `diff`
//! писал объект целиком — последнее устройство затирало правку первого).

mod model_common;

use model_common::{b64d, b64e, call, Host};
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::state::v2::{AppendRequest, StateRecord, SyncResponse};
use parvane_protocol::state::StateKey;
use prost::Message;
use serde_json::{json, Value};

/// Сервер журнала: записи по порядку (seq с 1), повтор op_id — прежний seq.
#[derive(Default)]
struct Server {
    records: Vec<StateRecord>,
}

impl Server {
    fn append(&mut self, body: &[u8]) {
        let r = AppendRequest::decode(body).unwrap();
        if self.records.iter().any(|x| x.op_id == r.op_id) {
            return;
        }
        let seq = self.records.len() as u64 + 1;
        self.records.push(StateRecord { seq, op_id: r.op_id, aead_ciphertext: r.aead_ciphertext });
    }
    fn after(&self, seq: u64) -> Vec<u8> {
        SyncResponse { records: self.records.iter().filter(|r| r.seq > seq).cloned().collect(), more: false }.encode_to_vec()
    }
}

struct Device {
    host: Host,
    e: Engine,
    sent: usize,
}

impl Device {
    fn open(user: &str, dev: &str, key: &StateKey) -> Device {
        let mut host = Host::default();
        let cfg = json!({"user": user, "device_id": dev, "domain": "local", "now_ms": "1800000000000"});
        let (mut e, _) = host.open(&cfg);
        let out = serde_json::from_str::<Value>(&serde_json::to_string(&e.adopt_state_keys(&[(key, 1)]).unwrap()).unwrap()).unwrap();
        host.drive(&mut e, out, true);
        let sent = host.sent.len();
        Device { host, e, sent }
    }

    fn apply(&mut self, snapshot: Value, kinds: &[&str]) {
        self.apply_from(snapshot, None, kinds);
    }

    /// Желаемое от `base` — того, что устройство показывало, когда пользователь правил (хост web).
    fn apply_from(&mut self, snapshot: Value, base: Option<Value>, kinds: &[&str]) {
        let out = call(&mut self.e, "stateApplyV1", &json!({"snapshot": snapshot, "kinds": kinds, "prune": true, "base": base})).unwrap();
        self.host.drive(&mut self.e, out, true);
    }

    /// Связь появилась: свои записи — серверу, затем догон журнала.
    fn online(&mut self, srv: &mut Server) {
        let out = call(&mut self.e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_EVENT", "method": "journal.state"})).unwrap();
        self.host.drive(&mut self.e, out, true);
        loop {
            let pending: Vec<Value> = self.host.sent[self.sent..].to_vec();
            self.sent = self.host.sent.len();
            if pending.is_empty() {
                break;
            }
            for r in pending {
                let method = r["method"].as_str().unwrap().to_string();
                let body = b64d(r["body"].as_str().unwrap_or(""));
                let resp = match method.as_str() {
                    "state.ops.append" => {
                        srv.append(&body);
                        vec![]
                    }
                    "state.ops.sync" => {
                        let req = parvane_protocol::pb::parvane::state::v2::SyncRequest::decode(body.as_slice()).unwrap();
                        srv.after(req.after_seq)
                    }
                    _ => vec![],
                };
                let out = call(&mut self.e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": r["req_id"], "body": b64e(&resp)})).unwrap();
                self.host.drive(&mut self.e, out, true);
            }
        }
    }

    fn view(&mut self) -> Value {
        call(&mut self.e, "stateViewV1", &json!({})).unwrap()["snapshot"].clone()
    }
}

fn folder(title: &str, emoticon: &str) -> Value {
    json!({"id": 5, "title": title, "emoticon": emoticon, "color": -1})
}

fn contact(first: &str, note: &str) -> Value {
    json!({"user": {"address": "carol@local"}, "first_name": first, "note": note})
}

#[test]
fn offline_edits_of_different_fields_both_survive() {
    let key = StateKey::generate();
    let mut srv = Server::default();
    let mut a = Device::open("alice@local", "d1", &key);
    let mut b = Device::open("alice@local", "d2", &key);
    a.apply(json!({"folders": [folder("Дом", "🏠")], "contacts": [contact("Кэрол", "")]}), &["folders", "contacts"]);
    a.online(&mut srv);
    b.online(&mut srv);
    assert_eq!(b.view()["folders"][0]["title"], json!("Дом"));
    // Без связи: A меняет название папки и имя контакта, B — значок папки и заметку контакта
    a.apply(json!({"folders": [folder("Работа", "🏠")], "contacts": [contact("Кэрол Р.", "")]}), &["folders", "contacts"]);
    b.apply(json!({"folders": [folder("Дом", "💼")], "contacts": [contact("Кэрол", "соседка")]}), &["folders", "contacts"]);
    a.online(&mut srv);
    b.online(&mut srv);
    a.online(&mut srv);
    // Хост web после переподключения пишет снова всё локальное от base (несохранённые виды): локальная копия A ещё
    // со старым значком, B — со старым названием; разница от base не откатывает чужую правку
    let base = json!({"folders": [folder("Дом", "🏠")], "contacts": [contact("Кэрол", "")]});
    a.apply_from(json!({"folders": [folder("Работа", "🏠")], "contacts": [contact("Кэрол Р.", "")]}), Some(base.clone()), &["folders", "contacts"]);
    b.apply_from(json!({"folders": [folder("Дом", "💼")], "contacts": [contact("Кэрол", "соседка")]}), Some(base), &["folders", "contacts"]);
    a.online(&mut srv);
    b.online(&mut srv);
    a.online(&mut srv);
    let mut c = Device::open("alice@local", "d3", &key);
    c.online(&mut srv);
    for (name, d) in [("A", &mut a), ("B", &mut b), ("C", &mut c)] {
        let v = d.view();
        assert_eq!(v["folders"][0]["title"], json!("Работа"), "{name}: название папки");
        assert_eq!(v["folders"][0]["emoticon"], json!("💼"), "{name}: значок папки");
        assert_eq!(v["contacts"][0]["first_name"], json!("Кэрол Р."), "{name}: имя контакта");
        assert_eq!(v["contacts"][0]["note"], json!("соседка"), "{name}: заметка контакта");
    }
}

#[test]
fn stale_desire_without_base_would_revert_but_base_keeps_remote() {
    let key = StateKey::generate();
    let mut srv = Server::default();
    let mut a = Device::open("alice@local", "d1", &key);
    let mut b = Device::open("alice@local", "d2", &key);
    a.apply(json!({"folders": [folder("Дом", "🏠")]}), &["folders"]);
    a.online(&mut srv);
    b.online(&mut srv);
    // B меняет значок; A его ещё не показал и правит название от прежнего base
    b.apply(json!({"folders": [folder("Дом", "💼")]}), &["folders"]);
    b.online(&mut srv);
    a.online(&mut srv);
    a.apply_from(json!({"folders": [folder("Работа", "🏠")]}), Some(json!({"folders": [folder("Дом", "🏠")]})), &["folders"]);
    a.online(&mut srv);
    b.online(&mut srv);
    for d in [&mut a, &mut b] {
        let v = d.view();
        assert_eq!(v["folders"][0]["title"], json!("Работа"));
        assert_eq!(v["folders"][0]["emoticon"], json!("💼"), "правка другого устройства после base не откатана");
    }
    // Папку, созданную другим устройством после base, prune от base не удаляет
    b.apply(json!({"folders": [folder("Работа", "💼"), {"id": 9, "title": "Новая", "color": -1}]}), &["folders"]);
    b.online(&mut srv);
    a.online(&mut srv);
    a.apply_from(json!({"folders": [folder("Работа", "💼")]}), Some(json!({"folders": [folder("Работа", "💼")]})), &["folders"]);
    assert_eq!(a.view()["folders"].as_array().map(Vec::len), Some(2), "чужая новая папка осталась");
}

#[test]
fn unchanged_desire_writes_nothing_and_prune_deletes_only_managed() {
    let key = StateKey::generate();
    let mut a = Device::open("alice@local", "d1", &key);
    let snap = json!({"folders": [folder("Дом", "🏠")], "archived": [{"user": {"address": "bob@local"}}]});
    a.apply(snap.clone(), &["folders", "archived"]);
    let before = a.host.sent.len();
    a.apply(snap, &["folders", "archived"]);
    assert_eq!(a.host.sent.len(), before, "то же желаемое — ни одной записи");
    // Папок больше нет; архив не управляется этим вызовом — остаётся
    a.apply(json!({}), &["folders"]);
    let v = a.view();
    assert!(v["folders"].as_array().is_none_or(|f| f.is_empty()), "папка удалена: {v}");
    assert_eq!(v["archived"][0]["user"]["address"], json!("bob@local"));
}
