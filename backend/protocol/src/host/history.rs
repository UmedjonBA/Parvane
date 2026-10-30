//! Журнал истории аккаунта для хостов (spec 033): статические функции `history*` (единая точка входа
//! `call_static`, WASM `historyCall`) и сессия журнала [`HostHistory`] (WASM `PvHistory.call`, C ABI
//! `pv_history_call`). Контракт — `specs/033-history-sync/contracts/engine-api.md`.
//!
//! JSON границы:
//! - сообщения схемы (`RowState`, `HistoryOp`, `ReadMark`, `ChatSummary`, `SegmentRef`, `Peer`) —
//!   proto3-JSON (pbjson, имена полей как в схеме; int64/uint64 — строкой, на входе — и числом);
//! - ИСКЛЮЧЕНИЕ: поля-идентификаторы сообщений `id`, `target`, `op_id`, `up_to_id` (вне `chat`) — строка UUID
//!   с дефисами (как `WireStoredMessage.id` web); на входе принимается и base64;
//! - свои структуры (результаты сессии, `historyView`) — camelCase, числа — числами, байты тел — base64.

use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use super::err;
use crate::error::ProtoError;
use crate::history::{self, ChatKind, HistorySession};
use crate::pb::parvane::history::v1::{AppendResponse, ChatSummary, Checkpoint, CommitResponse, HistoryOp, ReadMark, RowState, SegmentRef};
use crate::pb::parvane::state::v1::Peer;

type R = Result<Value, String>;

const UUID_KEYS: &[&str] = &["id", "target", "op_id", "up_to_id"];

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| err(ProtoError::Malformed))
}

fn missing(k: &'static str) -> String {
    err(ProtoError::InvalidField(k))
}

/// base64 16 байт → UUID-строка в полях-идентификаторах (не внутри `chat`).
fn ids_out(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if k == "chat" {
                    continue;
                }
                if UUID_KEYS.contains(&k.as_str()) {
                    if let Value::String(s) = x {
                        if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(s.as_bytes()) {
                            if b.len() == history::ID_LEN {
                                *s = history::uuid_string(&b);
                            }
                        }
                    }
                    continue;
                }
                ids_out(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(ids_out),
        _ => {}
    }
}

/// UUID-строка → base64 в полях-идентификаторах (base64 оставляется как есть).
fn ids_in(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if k == "chat" {
                    continue;
                }
                if UUID_KEYS.contains(&k.as_str()) {
                    if let Value::String(s) = x {
                        if let Ok(u) = uuid::Uuid::try_parse(s) {
                            *s = b64(u.as_bytes());
                        }
                    }
                    continue;
                }
                ids_in(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(ids_in),
        _ => {}
    }
}

/// Сообщение схемы → JSON границы.
pub fn to_json<T: Serialize>(m: &T) -> Value {
    let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
    ids_out(&mut v);
    v
}

/// JSON границы (значение или JSON-текст) → сообщение схемы.
pub fn from_json<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
    let mut v = match v {
        Value::String(s) => serde_json::from_str::<Value>(s).map_err(|_| err(ProtoError::Malformed))?,
        other => other.clone(),
    };
    ids_in(&mut v);
    serde_json::from_value(v).map_err(|_| err(ProtoError::Malformed))
}

struct Args<'a>(&'a Value);

impl Args<'_> {
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }
    fn msg<T: DeserializeOwned>(&self, k: &'static str) -> Result<T, String> {
        from_json(self.get(k).ok_or_else(|| missing(k))?)
    }
    fn opt<T: DeserializeOwned>(&self, k: &'static str) -> Result<Option<T>, String> {
        self.get(k).map(from_json).transpose()
    }
    fn list<T: DeserializeOwned>(&self, k: &'static str) -> Result<Vec<T>, String> {
        match self.get(k) {
            None => Ok(vec![]),
            Some(Value::Array(a)) => a.iter().map(from_json).collect(),
            Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
                Ok(Value::Array(a)) => a.iter().map(from_json).collect(),
                _ => Err(missing(k)),
            },
            Some(_) => Err(missing(k)),
        }
    }
    fn s(&self, k: &'static str) -> Result<&str, String> {
        self.get(k).and_then(Value::as_str).ok_or_else(|| missing(k))
    }
    fn i(&self, k: &'static str) -> Result<i64, String> {
        let v = self.get(k).ok_or_else(|| missing(k))?;
        v.as_i64()
            .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| missing(k))
    }
    fn io(&self, k: &'static str, d: i64) -> Result<i64, String> {
        if self.get(k).is_some() {
            self.i(k)
        } else {
            Ok(d)
        }
    }
    fn u(&self, k: &'static str) -> Result<u64, String> {
        u64::try_from(self.i(k)?).map_err(|_| missing(k))
    }
    fn uo(&self, k: &'static str) -> Result<u64, String> {
        if self.get(k).is_some() {
            self.u(k)
        } else {
            Ok(0)
        }
    }
    fn flag(&self, k: &str) -> bool {
        self.get(k).and_then(Value::as_bool).unwrap_or(false)
    }
    fn u64s(&self, k: &'static str) -> Result<Vec<u64>, String> {
        match self.get(k) {
            None => Ok(vec![]),
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())).ok_or_else(|| missing(k)))
                .collect(),
            Some(_) => Err(missing(k)),
        }
    }
    fn bytes(&self, k: &'static str) -> Result<Vec<u8>, String> {
        unb64(self.s(k)?)
    }
}

fn checkpoint_json(c: &Checkpoint) -> Value {
    json!({"id": c.id, "uptoSeq": c.upto_seq, "summarySeq": c.summary_seq, "chunkSeqs": c.chunk_seqs, "createdMs": c.created_ms})
}

fn now_ms() -> i64 {
    crate::time::now_ms()
}

/// Статические функции журнала истории (`history*`). `None` — имя не из этого набора.
pub fn call_static(name: &str, args: &Value) -> Option<R> {
    let a = Args(args);
    let r: R = (|| {
        Ok(match name {
            "historyApply" => {
                let state: Option<RowState> = a.opt("state")?;
                to_json(&history::apply(state.as_ref(), &a.msg::<HistoryOp>("op")?).map_err(err)?)
            }
            "historyApplyMany" => {
                let mut state: Option<RowState> = a.opt("state")?;
                for op in a.list::<HistoryOp>("ops")? {
                    state = Some(history::apply(state.as_ref(), &op).map_err(err)?);
                }
                state.as_ref().map_or(Value::Null, to_json)
            }
            "historyMerge" => to_json(&history::merge(&a.msg("a")?, &a.msg("b")?).map_err(err)?),
            "historyView" => history::view(&a.msg("state")?).map_err(err)?,
            "historyIsUnread" => {
                let mark: Option<ReadMark> = a.opt("mark")?;
                json!(history::is_unread(&a.msg("state")?, mark.as_ref(), a.s("self")?).map_err(err)?)
            }
            "historyMarkMerge" => {
                let (x, y): (Option<ReadMark>, Option<ReadMark>) = (a.opt("a")?, a.opt("b")?);
                history::mark_merge(x.as_ref(), y.as_ref()).map_err(err)?.as_ref().map_or(Value::Null, to_json)
            }
            "historyMarkAfter" => {
                let mark: Option<ReadMark> = a.opt("mark")?;
                let id = history::parse_id(a.s("id")?).map_err(err)?;
                json!(history::mark_after(mark.as_ref(), a.i("tsMs")?, &id).map_err(err)?)
            }
            "historyCanDelete" => {
                let kind = ChatKind::parse(a.s("chatKind")?).map_err(err)?;
                json!(history::can_delete(kind, a.s("author")?, a.s("deleter")?, a.flag("deleterIsAdmin")))
            }
            "historyRowFromWire" => {
                let row = match a.get("row").ok_or_else(|| missing("row"))? {
                    Value::String(s) => serde_json::from_str::<Value>(s).map_err(|_| err(ProtoError::Malformed))?,
                    v => v.clone(),
                };
                to_json(&history::row_from_wire(&row, &a.msg::<Peer>("chat")?).map_err(err)?)
            }
            "historySegmentKey" => json!(history::segment_key(&a.msg("state")?).map_err(err)?),
            "historySegmentDigest" => json!(b64(&history::segment_digest(&a.list::<RowState>("states")?).map_err(err)?)),
            "historyNeedsReplace" => {
                json!(history::needs_replace(a.i("lastFullSyncMs")?, a.i("tombstonesSinceMs")?, a.u("cursor")?, a.u("uptoSeq")?))
            }
            "historyCompact" => {
                let out = history::compact(&a.list::<RowState>("states")?, a.i("nowMs")?).map_err(err)?;
                Value::Array(out.iter().map(to_json).collect())
            }
            "historySummary" => {
                let chats: Vec<ChatSummary> = a.list("chats")?;
                let segments: Vec<SegmentRef> = a.list("segments")?;
                to_json(&history::summary(chats, segments, a.io("tombstonesSinceMs", 0)?).map_err(err)?)
            }
            "historyNewStamp" => to_json(&history::new_stamp(a.io("tsMs", now_ms())?)),
            "historyUnreadKinds" => json!(history::NON_COUNTED_KINDS),
            _ => return Err(super::call::UNKNOWN_CALL.to_string()),
        })
    })();
    match r {
        Err(e) if e == super::call::UNKNOWN_CALL => None,
        r => Some(r),
    }
}

/// Сессия журнала истории для хостов (WASM `PvHistory`, C ABI `pv_history_*`). Курсор, `head_seq`, время
/// полной синхронизации и строки хранит хост.
#[derive(Debug)]
pub struct HostHistory {
    inner: HistorySession,
}

impl HostHistory {
    pub fn new(inner: HistorySession) -> Self {
        HostHistory { inner }
    }

    /// Вызов функции сессии по имени (`syncRequest`, `ingest`, `seal`, …); незнакомое имя — статические
    /// функции `history*`, иначе `UnknownCall`.
    pub fn call(&mut self, name: &str, args: &Value) -> R {
        let a = Args(args);
        let s = &self.inner;
        Ok(match name {
            "syncRequest" => {
                let max = u32::try_from(a.uo("maxBytes")?).map_err(|_| missing("maxBytes"))?;
                json!(b64(&s.sync_request(a.uo("afterSeq")?, a.flag("skipChunks"), max)))
            }
            "headRequest" => json!(b64(&s.head_request())),
            "getRequest" => json!(b64(&s.get_request(a.u64s("seqs")?).map_err(err)?)),
            "commitRequest" => {
                json!(b64(&s.commit_request(a.uo("expected")?, a.u("uptoSeq")?, a.u("summarySeq")?, a.u64s("chunkSeqs")?).map_err(err)?))
            }
            "seal" => {
                let ops: Vec<HistoryOp> = a.list("ops")?;
                let out = s.seal(ops, a.flag("chunk"), a.io("tsMs", now_ms())?).map_err(err)?;
                Value::Array(out.iter().map(|(id, body)| json!({"opId": history::uuid_string(id), "body": b64(body)})).collect())
            }
            "ingest" => {
                let r = s.ingest(&a.bytes("resp")?).map_err(err)?;
                let mut v = json!({
                    "ops": r.ops.iter().map(to_json).collect::<Vec<_>>(),
                    "records": r.records.iter().map(|x| json!({
                        "seq": x.seq, "chunk": x.chunk, "opId": history::uuid_string(&x.op_id), "first": x.first, "count": x.count,
                        "keyVersion": x.key_version, "stale": x.stale, "deviceId": x.device_id,
                    })).collect::<Vec<_>>(),
                    "more": r.more,
                    "headSeq": r.head_seq,
                    "rejected": r.rejected,
                    "rejectedOps": r.rejected_ops,
                });
                if let Some(c) = &r.compacted {
                    v["compacted"] = checkpoint_json(c);
                }
                v
            }
            "ingestHead" => {
                let h = s.ingest_head(&a.bytes("resp")?).map_err(err)?;
                let mut v = json!({"headSeq": h.head_seq});
                if let Some(c) = &h.checkpoint {
                    v["checkpoint"] = checkpoint_json(c);
                }
                v
            }
            "ingestAppend" => {
                let r: AppendResponse = crate::codec::decode_checked(&a.bytes("resp")?, crate::limits::Origin::Server).map_err(err)?;
                json!({"seq": r.seq})
            }
            "ingestCommit" => {
                let r: CommitResponse = crate::codec::decode_checked(&a.bytes("resp")?, crate::limits::Origin::Server).map_err(err)?;
                json!({"checkpointId": r.checkpoint_id})
            }
            _ => return call_static(name, args).unwrap_or_else(|| Err(super::call::UNKNOWN_CALL.to_string())),
        })
    }

    /// Тело `history.sync` (байты) — для хостов без JSON.
    pub fn sync_request(&self, after_seq: u64, skip_chunks: bool) -> Vec<u8> {
        self.inner.sync_request(after_seq, skip_chunks, 0)
    }

    pub fn session(&self) -> &HistorySession {
        &self.inner
    }
}
