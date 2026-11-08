//! spec 035 T068 (HIST-2, S7-4): вход нового устройства в журнал истории по контрольной точке в модели движка.
//! Поддельный хост и поддельный сервер: журнал до точки свёрнут (записи 1–3 удалены), точка — сегмент (4) и
//! сводка (5), после точки — запись 6. Движок нового устройства спрашивает голову, берёт сводку (последние строки
//! и маркеры чатов), сегменты, ставит курсор на точку и синкает дальше — история видна целиком. Подменённый
//! сервером сегмент (op_id не тот) — точка не применяется и курсор не двигается. Без правки движок синкал с нуля
//! и получал только запись 6.

mod model_common;

use model_common::{b64d, b64e, call, Host};
use parvane_protocol::history::{self, HistorySession, SummaryMeta};
use parvane_protocol::model::Engine;
use parvane_protocol::pb::parvane::core::v2::UserRef;
use parvane_protocol::pb::parvane::history::v1::{
    history_op, AppendRequest, ChatSummary, Checkpoint, GetResponse, HeadResponse, HistoryOp, HistoryRecord, MessageRow, RowState, SegmentRef, SyncResponse,
};
use parvane_protocol::pb::parvane::state::v1::{peer, Peer};
use prost::Message;
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;
const ME: &str = "alice@local";

fn cfg() -> Value {
    json!({"user": ME, "device_id": "d2", "domain": "local", "now_ms": NOW.to_string(), "vectors": true, "device_key": b64e(&[3u8; 32])})
}

fn bob() -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: "bob@local".into() })) }
}

fn row(n: u8) -> MessageRow {
    MessageRow {
        id: vec![n; 16],
        chat: Some(bob()),
        from: "bob@local".into(),
        ts_ms: NOW - 1_000_000 + i64::from(n) * 1000,
        body: format!(r#"{{"content":{{"kind":"text","text":"сообщение {n}"}}}}"#).into_bytes(),
    }
}

fn state_of(n: u8) -> RowState {
    history::apply(None, &history::row_op(row(n))).unwrap()
}

/// Запись журнала под ключом сессии движка (как её положило бы другое устройство).
fn record(s: &HistorySession, seq: u64, ops: Vec<HistoryOp>, chunk: bool) -> HistoryRecord {
    let sealed = s.seal(ops, chunk, NOW).unwrap();
    assert_eq!(sealed.len(), 1);
    let a = AppendRequest::decode(sealed[0].1.as_slice()).unwrap();
    HistoryRecord { seq, op_id: a.op_id, aead_ciphertext: a.aead_ciphertext, chunk: a.chunk }
}

struct Server {
    cp: Checkpoint,
    summary: HistoryRecord,
    segment: HistoryRecord,
    after: HistoryRecord,
}

fn server(e: &mut Engine, tamper_segment: bool) -> Server {
    let s = e.debug_history_session().expect("сессия истории");
    let seg_states = vec![state_of(1), state_of(2)];
    let mut segment = record(s, 4, seg_states.iter().cloned().map(|st| HistoryOp { op: Some(history_op::Op::State(st)) }).collect(), true);
    let seg_ref = SegmentRef {
        key: history::segment_key(&seg_states[0]).unwrap(),
        digest: history::segment_digest(&seg_states).unwrap().to_vec(),
        seq: 4,
        op_id: segment.op_id.clone(),
    };
    let chats = vec![ChatSummary { chat: Some(bob()), last: Some(state_of(3)), mark: None, unread: 0, rows: 3 }];
    let meta = SummaryMeta { upto_seq: 5, checkpoint_id: 1, chains: Default::default() };
    let summary_op = history::summary(chats, vec![seg_ref], 0, &meta).unwrap();
    let summary = record(s, 5, vec![summary_op], true);
    let after = record(s, 6, vec![history::row_op(row(4))], false);
    if tamper_segment {
        // Сервер отдаёт под номером сегмента другую запись (прежнюю версию сегмента)
        segment = record(s, 4, vec![HistoryOp { op: Some(history_op::Op::State(state_of(1))) }], true);
    }
    Server { cp: Checkpoint { id: 1, upto_seq: 5, summary_seq: 5, chunk_seqs: vec![4, 5], created_ms: NOW }, summary, segment, after }
}

impl Server {
    fn answer(&self, method: &str, body: &[u8]) -> Vec<u8> {
        use parvane_protocol::pb::parvane::history::v1::{GetRequest, SyncRequest};
        match method {
            "history.head" => HeadResponse { head_seq: 6, checkpoint: Some(self.cp.clone()) }.encode_to_vec(),
            "history.get" => {
                let q = GetRequest::decode(body).unwrap();
                let records = [&self.segment, &self.summary, &self.after].into_iter().filter(|r| q.seqs.contains(&r.seq)).cloned().collect();
                GetResponse { records }.encode_to_vec()
            }
            "history.sync" => {
                let q = SyncRequest::decode(body).unwrap();
                // Журнал до точки свёрнут: записи ≤ 5 не отдаются, курсор внутри — `compacted`
                let compacted = (q.after_seq < self.cp.upto_seq).then(|| self.cp.clone());
                let records = [&self.after].into_iter().filter(|r| r.seq > q.after_seq).cloned().collect();
                SyncResponse { records, more: false, head_seq: 6, compacted }.encode_to_vec()
            }
            m => panic!("не ждали {m}"),
        }
    }
}

fn num(v: &Value) -> u64 {
    v.as_str().map(|s| s.parse().unwrap()).or(v.as_u64()).unwrap_or(0)
}

/// Отвечать на запросы журнала истории, пока движок их шлёт; возвращает методы по порядку.
fn serve(host: &mut Host, e: &mut Engine, srv: &Server, first: Value) -> Vec<String> {
    let mut methods = vec![];
    let mut queue = vec![first];
    for _ in 0..32 {
        let Some(out) = queue.pop() else { break };
        let step = host.drive(e, out, true);
        for r in step.requests {
            let m = r["method"].as_str().unwrap().to_string();
            if !m.starts_with("history.") {
                continue;
            }
            methods.push(m.clone());
            let body = srv.answer(&m, &b64d(r["body"].as_str().unwrap_or("")));
            queue.push(call(e, "ingest", &json!({"kind": "SERVER_INPUT_KIND_RESPONSE", "req_id": num(&r["req_id"]).to_string(), "body": b64e(&body)})).unwrap());
        }
    }
    methods
}

fn rows(e: &mut Engine) -> Vec<String> {
    let page = call(e, "historyPage", &json!({"chat": {"user": {"address": "bob@local"}}, "direction": "PAGE_DIRECTION_OLDER", "limit": 50})).unwrap();
    let mut ids: Vec<String> = page["rows"].as_array().into_iter().flatten().map(|r| r.to_string()).collect();
    ids.sort();
    ids
}

#[test]
fn new_device_enters_history_by_checkpoint() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    let srv = server(&mut e, false);
    let out = call(&mut e, "vectorInput", &json!({"history_pull": true})).unwrap();
    let methods = serve(&mut host, &mut e, &srv, out);
    assert_eq!(methods.first().map(String::as_str), Some("history.head"), "новое устройство спрашивает голову: {methods:?}");
    assert_eq!(methods.iter().filter(|m| *m == "history.get").count(), 2, "сводка и сегменты: {methods:?}");
    assert_eq!(methods.last().map(String::as_str), Some("history.sync"), "дальше — синк от точки: {methods:?}");
    assert_eq!(e.debug_rows(&bob()), 4, "строки сегмента, последняя из сводки и запись после точки");
    assert_eq!(rows(&mut e).len(), 4);

    // Перезапуск: курсор на точке, повторного входа нет
    let mut h2 = Host { store: host.store.clone(), ..Default::default() };
    let (mut e2, _) = h2.open(&cfg());
    let out = call(&mut e2, "vectorInput", &json!({"history_pull": true})).unwrap();
    let st = h2.drive(&mut e2, out, true);
    let m: Vec<&str> = st.requests.iter().filter_map(|r| r["method"].as_str()).filter(|m| m.starts_with("history.")).collect();
    assert_eq!(m, vec!["history.sync"], "после перезапуска — синк от курсора");
    assert_eq!(e2.debug_rows(&bob()), 4, "строки пережили перезапуск");
}

#[test]
fn tampered_segment_does_not_move_cursor() {
    let mut host = Host::default();
    let (mut e, _) = host.open(&cfg());
    let srv = server(&mut e, true);
    let out = call(&mut e, "vectorInput", &json!({"history_pull": true})).unwrap();
    let methods = serve(&mut host, &mut e, &srv, out);
    assert!(!methods.iter().any(|m| m == "history.sync"), "точка с подменённым сегментом не применяется: {methods:?}");
    // Следующий опрос снова идёт через голову (курсор не на точке)
    let out = call(&mut e, "vectorInput", &json!({"history_pull": true})).unwrap();
    let st = host.drive(&mut e, out, true);
    assert!(st.requests.iter().any(|r| r["method"] == "history.head"), "повтор входа по точке");
}
