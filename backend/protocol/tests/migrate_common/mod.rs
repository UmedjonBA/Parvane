//! Общее тестов разового переноса (spec 035 T098, T099): профиль прежней версии web «всё понемногу» (экспорт
//! движка под ключом экспорта, строки истории `m:<uuid>` с `hs`, маркеры `rm:`, исходящее `j:`, граница очистки),
//! замороженный журнал `state.v1` на «сервере» и поддельный сервер `state.sync`/`state.ops.*`. Данные выдуманные.
#![allow(dead_code)]

use std::collections::BTreeMap;

use parvane_protocol::client::Client;
use parvane_protocol::history;
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::core::v2::{Ref, UserRef};
use parvane_protocol::pb::parvane::history::v1::{MessageRow, ReadMark};
use parvane_protocol::pb::parvane::state::v1::{self as v1, peer, state_op::Op, Folder, Peer, PeerKey, StateOp};
use parvane_protocol::pb::parvane::state::v2 as s2;
use parvane_protocol::state::{self, StateKey};
use prost::Message;
use serde_json::{json, Value};

#[path = "../model_common/mod.rs"]
pub mod model_common;
pub use model_common::{b64d, b64e, call, Host};

pub const USER: &str = "alice@local";
pub const NOW: i64 = 1_800_000_000_000;
pub const STATE_KEY: [u8; 32] = [0x5a; 32];
pub const EXPORT_KEY: [u8; 32] = [0x3c; 32];

pub fn user(a: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
}

pub fn group_peer(b: u8) -> Peer {
    Peer { kind: Some(peer::Kind::Group(Ref { domain: "local".into(), id: vec![b; 16] })) }
}

pub fn uuid(n: u8) -> Vec<u8> {
    let mut id = vec![0x01, 0x92, 0x3a, 0x4b, 0x5c, 0x6d, 0x70, 0x01, 0x80, 0, 0, 0, 0, 0, 0, 0];
    id[15] = n;
    id
}

pub fn cfg(legacy: bool) -> Value {
    json!({"user": USER, "device_id": "d1", "domain": "local", "now_ms": NOW.to_string(), "device_key": b64e(&[9u8; 32]), "legacy_present": legacy})
}

/// Строка кэша web `m:<uuid>`: `{id, from, to, ts, content, order, hs}`.
fn row_record(n: u8, chat: Peer, from: &str, ts_ms: i64, text: &str) -> (String, Vec<u8>) {
    let id = uuid(n);
    let body = json!({"content": {"kind": "text", "text": text}}).to_string().into_bytes();
    let op = history::row_op(MessageRow { id: id.clone(), chat: Some(chat.clone()), from: from.into(), ts_ms, body });
    let st = history::apply(None, &op).unwrap();
    let rec = json!({
        "id": history::uuid_string(&id), "from": from, "to": "x", "ts": ts_ms / 1000, "content": {"kind": "text", "text": text},
        "order": ts_ms + i64::from(n), "hs": parvane_protocol::host::history::to_json(&st),
    });
    (format!("record:m:{}", history::uuid_string(&id)), rec.to_string().into_bytes())
}

/// Записи старых хранилищ web (то, что отдаёт `migrate_legacy_web.ts`).
pub fn legacy_records(rows: u8) -> Vec<Value> {
    // Один движок прежней версии на процесс: ключи личности случайны, а прогоны сравниваются между собой
    static BLOB: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let blob = BLOB
        .get_or_init(|| {
            let mut c = Client::new(USER, "d1", "local").unwrap();
            c.set_state_key(StateKey::from_bytes(&STATE_KEY).unwrap(), 1);
            c.export(&EXPORT_KEY).unwrap()
        })
        .clone();
    let mut out = vec![
        json!({"key": "record:v2-engine-bin", "value": b64e(&blob)}),
        json!({"key": "record:v2-storage-key", "value": b64e(json!(b64e(&EXPORT_KEY)).to_string().as_bytes())}),
    ];
    for n in 1..=rows {
        let (chat, from) = match n % 3 {
            0 => (group_peer(3), "carol@local"),
            1 => (user("bob@local"), "bob@local"),
            _ => (user("bob@local"), USER),
        };
        let (k, v) = row_record(n, chat, from, 1_762_500_000_000 + i64::from(n) * 1000, &format!("выдуманное сообщение {n}"));
        out.push(json!({"key": k, "value": b64e(&v)}));
    }
    // Чат, очищенный «у себя» до границы: строки до неё не переносятся (их не было и в выгрузке «до»)
    let (k, v) = row_record(200, user("dave@local"), "dave@local", 1_762_400_000_000, "до очистки");
    out.push(json!({"key": k, "value": b64e(&v)}));
    out.push(json!({"key": "localStorage:parvane:cleareduntil:alice@local", "value": b64e(json!({"dave@local": 1_762_450_000_000i64}).to_string().as_bytes())}));
    let mark = ReadMark { chat: Some(user("bob@local")), up_to_ts_ms: 1_762_500_002_000, up_to_id: uuid(2) };
    out.push(json!({"key": "record:rm:bob@local", "value": b64e(json!({"address": "bob@local", "mark": parvane_protocol::host::history::to_json(&mark)}).to_string().as_bytes())}));
    out.push(json!({"key": "record:j:01923a4b-5c6d-7001-8000-0000000000ff", "value": b64e(json!({"id": "01923a4b-5c6d-7001-8000-0000000000ff", "from": USER, "to": "bob@local", "ts": 1_762_500_100, "content": {"kind": "text", "text": "ещё не отправлено"}}).to_string().as_bytes())}));
    // Проекции журнала состояния — пересчитываются, не переносятся
    out.push(json!({"key": "localStorage:parvane:folders:alice@local", "value": b64e(b"[]")}));
    out
}

/// Замороженный журнал `state.v1` аккаунта на сервере.
pub fn v1_journal() -> Vec<v1::StateRecord> {
    let key = StateKey::from_bytes(&STATE_KEY).unwrap();
    let ops = vec![
        (1, Op::FolderSet(Folder { id: 2, title: "Работа".into(), include_peers: vec![user("bob@local"), group_peer(3)], color: -1, ..Default::default() })),
        (2, Op::ArchiveSet(PeerKey { peer: Some(group_peer(4)) })),
        (3, Op::ContactSet(v1::Contact { user: Some(UserRef { address: "bob@local".into() }), first_name: "Боб".into(), note: "заметка".into(), ..Default::default() })),
        (4, Op::QuickReaction(v1::QuickReaction { emoji: "👍".into(), ..Default::default() })),
        (5, Op::DraftSet(v1::Draft { peer: Some(user("bob@local")), text: b"draft".to_vec(), ..Default::default() })),
    ];
    ops.into_iter()
        .enumerate()
        .map(|(i, (l, k))| {
            let mut id = vec![0x22u8; 16];
            id[15] = i as u8;
            id[6] = 0x70;
            let op = StateOp { op_id: id, lamport: l, device_id: "d0".into(), ts_ms: 1, op: Some(k) };
            let a = state::seal_op(&key, USER, &op).unwrap();
            v1::StateRecord { seq: i as u64 + 1, op_id: a.op_id, aead_ciphertext: a.aead_ciphertext }
        })
        .collect()
}

/// Поддельный сервер: замороженный `state.v1`, журнал `state.v2` с идемпотентностью по op_id.
#[derive(Default, Clone)]
pub struct Server {
    pub v1: Vec<v1::StateRecord>,
    pub v2: Vec<s2::StateRecord>,
    /// Сколько записей отдавать за страницу (0 — все).
    pub page: usize,
    pub calls: Vec<String>,
}

impl Server {
    pub fn handle(&mut self, method: &str, body: &[u8]) -> (i32, Vec<u8>) {
        self.calls.push(method.to_string());
        let page = |n: usize| if self.page == 0 { n } else { self.page.min(n) };
        match method {
            "state.sync" => {
                let r = v1::SyncRequest::decode(body).unwrap();
                let rest: Vec<_> = self.v1.iter().filter(|x| x.seq > r.after_seq).cloned().collect();
                let n = page(rest.len());
                (0, v1::SyncResponse { more: n < rest.len(), records: rest[..n].to_vec() }.encode_to_vec())
            }
            "state.ops.sync" => {
                let r = s2::SyncRequest::decode(body).unwrap();
                let rest: Vec<_> = self.v2.iter().filter(|x| x.seq > r.after_seq).cloned().collect();
                let n = page(rest.len());
                (0, s2::SyncResponse { more: n < rest.len(), records: rest[..n].to_vec() }.encode_to_vec())
            }
            "state.ops.append" => {
                let r = s2::AppendRequest::decode(body).unwrap();
                if let Some(x) = self.v2.iter().find(|x| x.op_id == r.op_id) {
                    return if x.aead_ciphertext == r.aead_ciphertext { (0, s2::AppendResponse { seq: x.seq }.encode_to_vec()) } else { (4, vec![]) };
                }
                let seq = self.v2.len() as u64 + 1;
                self.v2.push(s2::StateRecord { seq, op_id: r.op_id, aead_ciphertext: r.aead_ciphertext });
                (0, s2::AppendResponse { seq }.encode_to_vec())
            }
            "state.append" => (17, vec![]),
            _ => (0, vec![]),
        }
    }

    /// Новый журнал, открытый ключом: операции по порядку.
    pub fn v2_ops(&self) -> Vec<s2::StateOp> {
        let key = StateKey::from_bytes(&STATE_KEY).unwrap();
        self.v2
            .iter()
            .map(|r| s2::StateOp::decode(parvane_protocol::state2::open(&key, USER, &r.op_id, &r.aead_ciphertext).unwrap().as_slice()).unwrap())
            .collect()
    }
}

/// Хост переноса: хранилище и сервер. `crash_at` — «убить процесс» сразу после фиксации пачки, на которой перенос
/// дошёл до точки M (1–6). Возвращает движок (None — «упали»).
pub fn run_migration(host: &mut Host, server: &mut Server, records: &[Value], crash_at: Option<u32>, chunk: u32) -> Option<Engine> {
    let (mut e, _) = host.open(&cfg(true));
    let st = call(&mut e, "migrateStatus", &json!({})).unwrap();
    let opened = e.open_state();
    if opened == parvane_protocol::pb::parvane::engine::v1::OpenState::Ready {
        // Перенос уже переключён (M6) — только отметка «перенесено»
        let out = call(&mut e, "migrateFinish", &json!({})).unwrap();
        drive_all(host, server, &mut e, out, None)?;
        let _ = st;
        return Some(e);
    }
    let out = call(&mut e, "migrateStep", &json!({"layer": "web", "records": records, "last": true, "chunk": chunk})).unwrap();
    let mut ready = drive_all(host, server, &mut e, out, crash_at)?;
    let mut guard = 0;
    while !ready {
        guard += 1;
        assert!(guard < 10_000, "перенос не закончился: {}", call(&mut e, "migrateStatus", &json!({})).unwrap());
        let out = call(&mut e, "migrateStep", &json!({})).unwrap();
        ready = drive_all(host, server, &mut e, out, crash_at)?;
    }
    if crash_at == Some(6) {
        return None;
    }
    let out = call(&mut e, "migrateFinish", &json!({})).unwrap();
    drive_all(host, server, &mut e, out, None)?;
    Some(e)
}

fn point(e: &mut Engine) -> u32 {
    call(e, "migrateStatus", &json!({})).unwrap()["point"].as_u64().unwrap_or(0) as u32
}

/// Довести итог: пачки (с фиксацией), чтения, запросы → ответы сервера. Возвращает «открыто READY» (`None` — упали).
pub fn drive_all(host: &mut Host, server: &mut Server, e: &mut Engine, out: Value, crash_at: Option<u32>) -> Option<bool> {
    let mut ready = false;
    let mut queue = vec![out];
    while let Some(out) = queue.pop() {
        if out["open"]["state"] == "OPEN_STATE_READY" {
            ready = true;
        }
        let mut batch_id = None;
        if let Some(b) = out.get("store_batch").filter(|b| !b.is_null()) {
            batch_id = Some(host.apply_batch(b));
        }
        let mut reqs: Vec<Value> = out["requests"].as_array().cloned().unwrap_or_default();
        for r in out["store_reads"].as_array().into_iter().flatten() {
            let _ = r;
            panic!("чтения во время переноса не ожидаются");
        }
        if let Some(id) = batch_id {
            if crash_at.is_some_and(|p| point(e) == p) {
                return None;
            }
            queue.push(call(e, "storeCommitted", &json!({"batch_id": id})).unwrap());
        }
        for r in reqs.drain(..) {
            let method = r["method"].as_str().unwrap().to_string();
            let body = b64d(r["body"].as_str().unwrap_or(""));
            let (err, resp) = server.handle(&method, &body);
            queue.insert(0, call(e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": r["req_id"], "body": b64e(&resp), "error": err})).unwrap());
        }
    }
    Some(ready)
}

/// Выгрузка после переноса движком, заново открытым над хранилищем.
pub fn reopened_dump(host: &mut Host) -> String {
    let (mut e, _) = host.open(&cfg(false));
    call(&mut e, "auditDump", &json!({})).unwrap()["jsonl"].as_str().unwrap().to_string()
}

pub fn kinds(dump: &str) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for l in dump.lines() {
        let v: Value = serde_json::from_str(l).unwrap();
        *m.entry(v["kind"].as_str().unwrap().to_string()).or_default() += 1;
    }
    m
}
