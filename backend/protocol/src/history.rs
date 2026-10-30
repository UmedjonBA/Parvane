//! Журнал истории аккаунта (spec 033; правила HIST-1, HIST-2, READ-2).
//!
//! Две части:
//!
//! 1. **Сводимая модель строки сообщения** — чистые функции над `RowState` (proto
//!    `parvane.history.v1`): [`apply`], [`merge`], [`view`], [`is_unread`], [`mark_merge`],
//!    [`mark_after`], [`can_delete`], [`row_from_wire`], [`segment_key`], [`segment_digest`],
//!    [`compact`], [`needs_replace`], [`summary`]. Итог сведения не зависит от порядка, повторов и
//!    разбиения событий (коммутативно, ассоциативно, идемпотентно), поэтому все устройства аккаунта и
//!    все три клиента получают побайтно одинаковый канонический `RowState`.
//!
//!    Правила поля за полем:
//!    - `row` — заполняется, если пусто; два разных тела одного сообщения → меньшее по ключу
//!      (заголовок строки без тела, затем тело) — детерминированно;
//!    - `gone`, правка (`edit_stamp`/`edit_body`), закреп (`pin_stamp`/`pinned`) — LWW по метке
//!      `Stamp` = `(ts_ms, op_id)` (лексикографически), ничья — по байтам значения;
//!    - реакции — LWW по пользователю, эмодзи `""` — реакция снята (надгробие остаётся для сведения);
//!    - канонизация: при `gone` стираются тело строки, правка, реакции и закреп (строка остаётся
//!      надгробием: id, чат, автор, время); реакции отсортированы по пользователю; `chat`/`target`
//!      вложенных сообщений приводятся к полям состояния.
//!
//! 2. **Записи журнала** — AEAD AES-256-GCM на ключе истории
//!    `HKDF-SHA256(ikm = ключ личного состояния, salt = "parvane/history/v1", info = адрес)`;
//!    `aead_ciphertext = nonce (12) ‖ шифртекст ‖ тег (16)`, AAD = `"parvane/v2/history\0" ‖ адрес ‖
//!    op_id (16) ‖ chunk (1 байт)`. Открытый текст — `HistoryBatch` (операции пачкой ≤ 200 КиБ). Запись,
//!    перенесённая в чужой журнал, под другой op_id или с другим флагом `chunk`, не открывается.
//!    Прежние адреса (смена ника) и прежние версии ключа состояния — как в журнале состояния:
//!    [`HistorySession`] пробует их все.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use prost::Message;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::history::v1::{
    history_op::Op, AppendRequest, ChatSummary, Checkpoint, CommitRequest, Edit, GetRequest, Gone, GoneScope, HeadRequest,
    HeadResponse, HistoryBatch, HistoryOp, MessageRow, Pin, React, ReadMark, Reaction, RowState, SegmentRef, Stamp, Summary,
    SyncRequest, SyncResponse,
};
use crate::pb::parvane::state::v1::{peer, Peer};
use crate::state::{peer_key, StateKey};

/// Длина id сообщения, цели мутации и op_id метки (UUID).
pub const ID_LEN: usize = 16;
/// Горизонт надгробий и сирот: 180 суток (FR-021).
pub const HORIZON_MS: i64 = 180 * 86_400_000;
/// Префикс AAD записи журнала истории.
pub const AAD_PREFIX: &[u8] = b"parvane/v2/history\0";
/// Соль HKDF ключа истории.
pub const HKDF_SALT: &[u8] = b"parvane/history/v1";
/// Длина nonce AES-GCM в начале `aead_ciphertext`.
pub const NONCE_LEN: usize = 12;
/// Длина тега AES-GCM.
pub const TAG_LEN: usize = 16;
/// Потолок `aead_ciphertext` (схема `AppendRequest`).
pub const MAX_RECORD: usize = 262_144;
/// Потолок открытого текста одной записи (пачки операций).
pub const BATCH_BUDGET: usize = 200 * 1024;
/// Операций в пачке (`max_items` у `HistoryBatch.ops`).
pub const MAX_BATCH_OPS: usize = 4096;
/// Префикс отпечатка сегмента.
const DIGEST_PREFIX: &[u8] = b"parvane/history/v1/segment\0";

/// Виды содержимого (`content.kind` тела строки, формат экспорта привязки), которые НЕ считаются
/// непрочитанными: служебные строки чата (режим L2 `chat_mode` — у web это `action`-сообщение), голоса и
/// закрытие опросов, записи о звонках, мутации/квитанции и служебное движка (ключи). Список — общий для
/// всех клиентов (web `sync.ts isUnreadIncoming` не считает `action`-строки; `v2/contentMap.ts`
/// `MUTATION_KINDS`/`SERVICE_KINDS`).
pub const NON_COUNTED_KINDS: &[&str] = &[
    "chat_mode",
    "poll_vote",
    "poll_close",
    "call",
    "receipt",
    "edit",
    "delete",
    "reaction",
    "pin",
    "group_key",
    "delivery_key",
    "container_key",
    "state_key",
];

/// Поля строки формата экспорта привязки, которые не входят в тело `MessageRow.body`: адресация
/// (`id`, `from`, `to`, `ts`) и состояние, которое ведёт сведение или само устройство.
pub const WIRE_NON_BODY_FIELDS: &[&str] =
    &["id", "from", "to", "ts", "read", "edited", "reactions", "reactors", "pinned", "deleted", "origin", "updated_at", "order"];

// ---------------------------------------------------------------------------
// Проверки.

fn id16(b: &[u8], field: &'static str) -> Result<()> {
    if b.len() == ID_LEN {
        Ok(())
    } else {
        Err(ProtoError::InvalidField(field))
    }
}

fn check_stamp(s: &Option<Stamp>, field: &'static str) -> Result<Stamp> {
    let s = s.as_ref().ok_or(ProtoError::InvalidField(field))?;
    id16(&s.op_id, field)?;
    Ok(s.clone())
}

fn chat_key(p: &Option<Peer>) -> Result<String> {
    peer_key(p.as_ref().ok_or(ProtoError::InvalidField("chat"))?)
}

/// Проверка, что `chat` вложенного сообщения (если задан) — тот же чат.
fn same_chat(p: &Option<Peer>, key: &str) -> Result<()> {
    match p {
        None => Ok(()),
        Some(p) if peer_key(p)? == key => Ok(()),
        Some(_) => Err(ProtoError::ContextMismatch),
    }
}

/// Тело строки/правки: пусто либо JSON-объект.
fn check_json_object(b: &[u8], field: &'static str) -> Result<()> {
    if b.is_empty() {
        return Ok(());
    }
    match serde_json::from_slice::<Value>(b) {
        Ok(Value::Object(_)) => Ok(()),
        _ => Err(ProtoError::InvalidField(field)),
    }
}

fn check_address(a: &str) -> Result<()> {
    if address::is_valid_address(a) {
        Ok(())
    } else {
        Err(ProtoError::BadAddress)
    }
}

// ---------------------------------------------------------------------------
// Порядок.

/// Порядок меток: `(ts_ms, op_id)` лексикографически.
pub fn stamp_cmp(a: &Stamp, b: &Stamp) -> Ordering {
    (a.ts_ms, a.op_id.as_slice()).cmp(&(b.ts_ms, b.op_id.as_slice()))
}

/// Выбрать большее из двух LWW-значений: метка, затем байты значения (ничья одной метки).
fn later<'a, T: Message>(a: (&'a Stamp, &'a T), b: (&'a Stamp, &'a T)) -> bool {
    match stamp_cmp(b.0, a.0) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => b.1.encode_to_vec() > a.1.encode_to_vec(),
    }
}

/// Ключ выбора строки при двух разных телах одного сообщения: заголовок без тела, затем тело.
fn row_key(r: &MessageRow) -> (Vec<u8>, &[u8]) {
    let head = MessageRow { body: vec![], ..r.clone() };
    (head.encode_to_vec(), r.body.as_slice())
}

// ---------------------------------------------------------------------------
// Сведение RowState.

/// Проверить состояние и привести его к канонической форме. Возвращает ключ чата.
fn canonical(mut s: RowState) -> Result<(RowState, String)> {
    id16(&s.target, "target")?;
    let key = chat_key(&s.chat)?;
    if let Some(r) = s.row.as_mut() {
        if r.id != s.target {
            return Err(ProtoError::ContextMismatch);
        }
        same_chat(&r.chat, &key)?;
        check_address(&r.from)?;
        check_json_object(&r.body, "row.body")?;
        r.chat = s.chat.clone();
    }
    match &s.edit_stamp {
        Some(_) => {
            check_stamp(&s.edit_stamp, "edit_stamp")?;
            check_json_object(&s.edit_body, "edit_body")?;
        }
        None if !s.edit_body.is_empty() => return Err(ProtoError::InvalidField("edit_body")),
        None => {}
    }
    match &s.pin_stamp {
        Some(_) => {
            check_stamp(&s.pin_stamp, "pin_stamp")?;
        }
        None if s.pinned => return Err(ProtoError::InvalidField("pinned")),
        None => {}
    }
    // Реакции: LWW по пользователю, сортировка по пользователю.
    let mut by_user: BTreeMap<String, Reaction> = BTreeMap::new();
    for r in std::mem::take(&mut s.reacts) {
        check_address(&r.user)?;
        check_stamp(&r.stamp, "react.stamp")?;
        put_reaction(&mut by_user, r);
    }
    s.reacts = by_user.into_values().collect();
    if let Some(g) = s.gone.as_mut() {
        if g.target != s.target {
            return Err(ProtoError::ContextMismatch);
        }
        same_chat(&g.chat, &key)?;
        check_stamp(&g.stamp, "gone.stamp")?;
        match GoneScope::try_from(g.scope) {
            Ok(GoneScope::Everyone) | Ok(GoneScope::Me) => {}
            _ => return Err(ProtoError::InvalidField("gone.scope")),
        }
        g.chat = s.chat.clone();
        // Надгробие: содержимого и мутаций больше нет.
        if let Some(r) = s.row.as_mut() {
            r.body.clear();
        }
        s.edit_stamp = None;
        s.edit_body.clear();
        s.reacts.clear();
        s.pin_stamp = None;
        s.pinned = false;
    }
    Ok((s, key))
}

fn put_reaction(map: &mut BTreeMap<String, Reaction>, r: Reaction) {
    let replace = match map.get(&r.user) {
        None => true,
        Some(cur) => match (&cur.stamp, &r.stamp) {
            (Some(a), Some(b)) => later((a, cur), (b, &r)),
            _ => false,
        },
    };
    if replace {
        map.insert(r.user.clone(), r);
    }
}

/// Свести два состояния одной строки (одна цель и один чат). Коммутативно, ассоциативно, идемпотентно.
pub fn merge(a: &RowState, b: &RowState) -> Result<RowState> {
    let (a, ka) = canonical(a.clone())?;
    let (b, kb) = canonical(b.clone())?;
    if a.target != b.target || ka != kb {
        return Err(ProtoError::ContextMismatch);
    }
    let row = match (a.row, b.row) {
        (Some(x), Some(y)) => Some(if row_key(&y) < row_key(&x) { y } else { x }),
        (x, y) => x.or(y),
    };
    let gone = match (a.gone, b.gone) {
        (Some(x), Some(y)) => {
            let (sx, sy) = (x.stamp.clone().unwrap_or_default(), y.stamp.clone().unwrap_or_default());
            Some(if later((&sx, &x), (&sy, &y)) { y } else { x })
        }
        (x, y) => x.or(y),
    };
    let (edit_stamp, edit_body) = match (a.edit_stamp, b.edit_stamp) {
        (Some(x), Some(y)) => {
            let (bx, by) = (a.edit_body, b.edit_body);
            if later((&x, &bx), (&y, &by)) {
                (Some(y), by)
            } else {
                (Some(x), bx)
            }
        }
        (Some(x), None) => (Some(x), a.edit_body),
        (None, Some(y)) => (Some(y), b.edit_body),
        (None, None) => (None, vec![]),
    };
    let (pin_stamp, pinned) = match (a.pin_stamp, b.pin_stamp) {
        (Some(x), Some(y)) => {
            if later((&x, &a.pinned), (&y, &b.pinned)) {
                (Some(y), b.pinned)
            } else {
                (Some(x), a.pinned)
            }
        }
        (Some(x), None) => (Some(x), a.pinned),
        (None, Some(y)) => (Some(y), b.pinned),
        (None, None) => (None, false),
    };
    let mut reacts = a.reacts;
    reacts.extend(b.reacts);
    let out = RowState { target: a.target, chat: a.chat, row, edit_stamp, edit_body, reacts, pin_stamp, pinned, gone };
    canonical(out).map(|(s, _)| s)
}

/// Операция → состояние из одного события (`row`/`gone`/`edit`/`react`/`pin`/`state`).
pub fn op_to_state(op: &HistoryOp) -> Result<RowState> {
    let s = match &op.op {
        Some(Op::Row(r)) => RowState { target: r.id.clone(), chat: r.chat.clone(), row: Some(r.clone()), ..Default::default() },
        Some(Op::Gone(g)) => RowState { target: g.target.clone(), chat: g.chat.clone(), gone: Some(g.clone()), ..Default::default() },
        Some(Op::Edit(e)) => RowState {
            target: e.target.clone(),
            chat: e.chat.clone(),
            edit_stamp: Some(check_stamp(&e.stamp, "edit.stamp")?),
            edit_body: e.body.clone(),
            ..Default::default()
        },
        Some(Op::React(r)) => RowState {
            target: r.target.clone(),
            chat: r.chat.clone(),
            reacts: vec![Reaction { user: r.user.clone(), stamp: Some(check_stamp(&r.stamp, "react.stamp")?), emoji: r.emoji.clone() }],
            ..Default::default()
        },
        Some(Op::Pin(p)) => RowState {
            target: p.target.clone(),
            chat: p.chat.clone(),
            pin_stamp: Some(check_stamp(&p.stamp, "pin.stamp")?),
            pinned: p.pinned,
            ..Default::default()
        },
        Some(Op::State(s)) => s.clone(),
        Some(Op::Read(_)) | Some(Op::Summary(_)) | None => return Err(ProtoError::InvalidField("op")),
    };
    canonical(s).map(|(s, _)| s)
}

/// Применить событие к состоянию строки (`None` — строки ещё нет: событие до цели даёт сироту).
pub fn apply(state: Option<&RowState>, op: &HistoryOp) -> Result<RowState> {
    let one = op_to_state(op)?;
    match state {
        None => Ok(one),
        Some(s) => merge(s, &one),
    }
}

/// Проверить операцию журнала (любого вида) — то же, что делает её применение.
pub fn validate_op(op: &HistoryOp) -> Result<()> {
    match &op.op {
        Some(Op::Read(m)) => check_mark(m).map(|_| ()),
        Some(Op::Summary(s)) => check_summary(s),
        _ => op_to_state(op).map(|_| ()),
    }
}

/// Ключ чата и цель операции строки (для хостов: куда применять).
pub fn op_target(op: &HistoryOp) -> Option<(&[u8], &Option<Peer>)> {
    match &op.op {
        Some(Op::Row(r)) => Some((&r.id, &r.chat)),
        Some(Op::Gone(g)) => Some((&g.target, &g.chat)),
        Some(Op::Edit(e)) => Some((&e.target, &e.chat)),
        Some(Op::React(r)) => Some((&r.target, &r.chat)),
        Some(Op::Pin(p)) => Some((&p.target, &p.chat)),
        Some(Op::State(s)) => Some((&s.target, &s.chat)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Представление и непрочитанное.

fn body_object(b: &[u8]) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(b) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// Тело строки с наложенной правкой (поля правки перекрывают поля тела верхнего уровня).
pub fn view_body(s: &RowState) -> Option<Map<String, Value>> {
    let row = s.row.as_ref()?;
    if s.gone.is_some() {
        return None;
    }
    let mut body = body_object(&row.body)?;
    if s.edit_stamp.is_some() {
        if let Some(e) = body_object(&s.edit_body) {
            body.extend(e);
        }
    }
    Some(body)
}

/// UUID-строка с дефисами (16 байт); иначе hex.
pub fn uuid_string(b: &[u8]) -> String {
    uuid::Uuid::from_slice(b).map(|u| u.hyphenated().to_string()).unwrap_or_else(|_| hex::encode(b))
}

/// Представление строки для клиента (см. `contracts/engine-api.md`).
pub fn view(s: &RowState) -> Result<Value> {
    let (s, key) = canonical(s.clone())?;
    let visible = s.row.is_some() && s.gone.is_none();
    // Реакции: по эмодзи — число и пользователи; порядок — больше голосов, раньше первая, эмодзи.
    let mut agg: BTreeMap<&str, (Vec<&str>, Stamp)> = BTreeMap::new();
    for r in s.reacts.iter().filter(|r| !r.emoji.is_empty()) {
        let st = r.stamp.clone().unwrap_or_default();
        let e = agg.entry(r.emoji.as_str()).or_insert_with(|| (vec![], st.clone()));
        e.0.push(r.user.as_str());
        if stamp_cmp(&st, &e.1) == Ordering::Less {
            e.1 = st;
        }
    }
    let mut reactions: Vec<(&str, Vec<&str>, Stamp)> = agg.into_iter().map(|(e, (u, st))| (e, u, st)).collect();
    reactions.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| stamp_cmp(&a.2, &b.2)).then_with(|| a.0.cmp(b.0)));
    let reactions: Vec<Value> =
        reactions.into_iter().map(|(e, users, _)| json!({"emoji": e, "count": users.len(), "users": users})).collect();
    let mut v = json!({
        "visible": visible,
        "deleted": s.gone.is_some(),
        "orphan": s.row.is_none(),
        "id": uuid_string(&s.target),
        "chat": serde_json::to_value(&s.chat).unwrap_or(Value::Null),
        "chatKey": key,
        "edited": visible && s.edit_stamp.is_some(),
        "reactions": if visible { reactions } else { vec![] },
        "pinned": visible && s.pinned,
    });
    if let Some(r) = &s.row {
        v["from"] = json!(r.from);
        v["tsMs"] = json!(r.ts_ms);
    }
    if let Some(b) = view_body(&s) {
        v["body"] = Value::Object(b);
    }
    if let (true, Some(st)) = (visible, &s.edit_stamp) {
        v["editTsMs"] = json!(st.ts_ms);
    }
    if let Some(g) = &s.gone {
        v["deletedScope"] = json!(if g.scope == GoneScope::Me as i32 { "me" } else { "everyone" });
    }
    Ok(v)
}

/// `content.kind` тела строки.
pub fn content_kind(body: &[u8]) -> Option<String> {
    body_object(body)?.get("content")?.get("kind")?.as_str().map(str::to_string)
}

fn check_mark(m: &ReadMark) -> Result<String> {
    id16(&m.up_to_id, "up_to_id")?;
    chat_key(&m.chat)
}

fn mark_cmp(ts: i64, id: &[u8], m: &ReadMark) -> Ordering {
    (ts, id).cmp(&(m.up_to_ts_ms, m.up_to_id.as_slice()))
}

/// Непрочитано ли сообщение: строка есть, не удалена, не своя, вид не служебный и `(ts, id)` после маркера.
pub fn is_unread(s: &RowState, mark: Option<&ReadMark>, self_address: &str) -> Result<bool> {
    let (s, key) = canonical(s.clone())?;
    if let Some(m) = mark {
        if check_mark(m)? != key {
            return Err(ProtoError::ContextMismatch);
        }
    }
    let Some(row) = &s.row else { return Ok(false) };
    if s.gone.is_some() || row.from == self_address {
        return Ok(false);
    }
    match content_kind(&row.body) {
        Some(k) if !NON_COUNTED_KINDS.contains(&k.as_str()) => {}
        _ => return Ok(false),
    }
    Ok(mark.is_none_or(|m| mark_cmp(row.ts_ms, &row.id, m) == Ordering::Greater))
}

/// Свести маркеры прочтения одного чата: максимум по `(ts, id)`.
pub fn mark_merge(a: Option<&ReadMark>, b: Option<&ReadMark>) -> Result<Option<ReadMark>> {
    match (a, b) {
        (Some(x), Some(y)) => {
            if check_mark(x)? != check_mark(y)? {
                return Err(ProtoError::ContextMismatch);
            }
            Ok(Some(if mark_cmp(y.up_to_ts_ms, &y.up_to_id, x) == Ordering::Greater { y.clone() } else { x.clone() }))
        }
        (Some(x), None) | (None, Some(x)) => {
            check_mark(x)?;
            Ok(Some(x.clone()))
        }
        (None, None) => Ok(None),
    }
}

/// Сдвинет ли `(ts, id)` маркер (строго после него).
pub fn mark_after(mark: Option<&ReadMark>, ts_ms: i64, id: &[u8]) -> Result<bool> {
    id16(id, "id")?;
    Ok(match mark {
        None => true,
        Some(m) => {
            check_mark(m)?;
            mark_cmp(ts_ms, id, m) == Ordering::Greater
        }
    })
}

/// Вид чата для прав удаления.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatKind {
    User,
    Group,
}

impl ChatKind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "user" => Ok(ChatKind::User),
            "group" => Ok(ChatKind::Group),
            _ => Err(ProtoError::InvalidField("chatKind")),
        }
    }
}

/// Вправе ли `deleter` удалить «у всех» сообщение `author`: личный чат — любой из двух участников (как
/// Telegram); группа — автор или админ с правом удалять сообщения. «Только у себя» — всегда (это журнал
/// своего аккаунта, собеседнику ничего не уходит).
pub fn can_delete(kind: ChatKind, author: &str, deleter: &str, deleter_is_admin: bool) -> bool {
    match kind {
        ChatKind::User => true,
        ChatKind::Group => author == deleter || deleter_is_admin,
    }
}

// ---------------------------------------------------------------------------
// Строка формата экспорта привязки → MessageRow.

/// Разобрать id сообщения: UUID (с дефисами или без) либо base64 16 байт.
pub fn parse_id(s: &str) -> Result<Vec<u8>> {
    if let Ok(u) = uuid::Uuid::try_parse(s) {
        return Ok(u.as_bytes().to_vec());
    }
    use base64::Engine as _;
    match base64::engine::general_purpose::STANDARD.decode(s) {
        Ok(b) if b.len() == ID_LEN => Ok(b),
        _ => Err(ProtoError::InvalidField("id")),
    }
}

/// JSON с ключами объектов по алфавиту на всех уровнях (каноническая сериализация тела).
pub fn sorted_json(v: Value) -> Value {
    match v {
        Value::Object(m) => {
            let sorted: BTreeMap<String, Value> = m.into_iter().map(|(k, v)| (k, sorted_json(v))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(sorted_json).collect()),
        other => other,
    }
}

/// Строка `{id, from, to, ts (с), content, reply_to?, …}` → операция `row`. Тело — JSON без
/// [`WIRE_NON_BODY_FIELDS`], ключи по алфавиту (каноническая сериализация).
pub fn row_from_wire(row: &Value, chat: &Peer) -> Result<HistoryOp> {
    let o = row.as_object().ok_or(ProtoError::Malformed)?;
    let id = parse_id(o.get("id").and_then(Value::as_str).ok_or(ProtoError::InvalidField("id"))?)?;
    let from = o.get("from").and_then(Value::as_str).ok_or(ProtoError::InvalidField("from"))?;
    check_address(from)?;
    let ts = o.get("ts").and_then(Value::as_f64).filter(|t| t.is_finite()).ok_or(ProtoError::InvalidField("ts"))?;
    let ts_ms = (ts * 1000.0).round();
    if !(0.0..=9.0e15).contains(&ts_ms) {
        return Err(ProtoError::InvalidField("ts"));
    }
    if !o.get("content").is_some_and(Value::is_object) {
        return Err(ProtoError::InvalidField("content"));
    }
    peer_key(chat)?;
    let body: Map<String, Value> =
        o.iter().filter(|(k, _)| !WIRE_NON_BODY_FIELDS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let body = serde_json::to_vec(&sorted_json(Value::Object(body))).map_err(|_| ProtoError::Malformed)?;
    let op = HistoryOp {
        op: Some(Op::Row(MessageRow { id, chat: Some(chat.clone()), from: from.to_string(), ts_ms: ts_ms as i64, body })),
    };
    validate_op(&op)?;
    Ok(op)
}

// ---------------------------------------------------------------------------
// Сегменты контрольной точки.

/// `YYYY-MM` (UTC) по миллисекундам эпохи.
pub fn year_month(ts_ms: i64) -> String {
    let days = ts_ms.div_euclid(86_400_000);
    // Гражданская дата из числа дней (H. Hinnant, days_from_civil наоборот).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}")
}

/// Все метки мутаций состояния.
fn stamps(s: &RowState) -> impl Iterator<Item = &Stamp> {
    s.gone
        .iter()
        .filter_map(|g| g.stamp.as_ref())
        .chain(s.edit_stamp.iter())
        .chain(s.pin_stamp.iter())
        .chain(s.reacts.iter().filter_map(|r| r.stamp.as_ref()))
}

/// Ключ сегмента: ключ чата + `|` + `YYYY-MM` (UTC) от времени строки (сирота — от самой ранней метки).
pub fn segment_key(s: &RowState) -> Result<String> {
    let (s, key) = canonical(s.clone())?;
    let ts = match &s.row {
        Some(r) => r.ts_ms,
        None => stamps(&s).map(|st| st.ts_ms).min().ok_or(ProtoError::InvalidField("state"))?,
    };
    Ok(format!("{key}|{}", year_month(ts)))
}

/// Отпечаток сегмента: SHA-256 канонической сериализации состояний, отсортированных по `target`
/// (состояния одной цели предварительно сводятся).
pub fn segment_digest(states: &[RowState]) -> Result<[u8; 32]> {
    let mut by_target: BTreeMap<Vec<u8>, RowState> = BTreeMap::new();
    for s in states {
        let (s, _) = canonical(s.clone())?;
        let merged = match by_target.get(&s.target) {
            Some(cur) => merge(cur, &s)?,
            None => s,
        };
        by_target.insert(merged.target.clone(), merged);
    }
    let mut h = Sha256::new();
    h.update(DIGEST_PREFIX);
    for s in by_target.values() {
        let b = s.encode_to_vec();
        h.update((b.len() as u32).to_be_bytes());
        h.update(&b);
    }
    Ok(h.finalize().into())
}

/// Свернуть: выбросить надгробия и сирот, у которых последнее событие старше горизонта (180 суток).
pub fn compact(states: &[RowState], now_ms: i64) -> Result<Vec<RowState>> {
    let edge = now_ms.saturating_sub(HORIZON_MS);
    let mut out = Vec::with_capacity(states.len());
    for s in states {
        let (s, _) = canonical(s.clone())?;
        let last = stamps(&s).map(|st| st.ts_ms).max();
        let stale = match (&s.gone, &s.row) {
            (Some(g), _) => g.stamp.as_ref().is_some_and(|st| st.ts_ms < edge),
            (None, None) => last.is_none_or(|t| t < edge),
            (None, Some(_)) => false,
        };
        if !stale {
            out.push(s);
        }
    }
    Ok(out)
}

/// Режим замены (R8): точка свернула надгробия после последней полной синхронизации устройства, а курсор
/// устройства — до точки.
pub fn needs_replace(last_full_sync_ms: i64, tombstones_since_ms: i64, cursor: u64, upto_seq: u64) -> bool {
    tombstones_since_ms > last_full_sync_ms && cursor < upto_seq
}

fn check_summary(s: &Summary) -> Result<()> {
    for c in &s.chats {
        let key = chat_key(&c.chat)?;
        if let Some(l) = &c.last {
            let (_, k) = canonical(l.clone())?;
            if k != key {
                return Err(ProtoError::ContextMismatch);
            }
        }
        if let Some(m) = &c.mark {
            if check_mark(m)? != key {
                return Err(ProtoError::ContextMismatch);
            }
        }
    }
    for g in &s.segments {
        if g.key.is_empty() || g.digest.len() != 32 {
            return Err(ProtoError::InvalidField("segment"));
        }
    }
    Ok(())
}

/// Запись-сводка контрольной точки. Если не помещается в одну запись, у самых старых чатов (по времени
/// последней строки) выбрасывается `last`; не помогло — `FieldLimit`.
pub fn summary(chats: Vec<ChatSummary>, segments: Vec<SegmentRef>, tombstones_since_ms: i64) -> Result<HistoryOp> {
    let mut s = Summary { tombstones_since_ms, chats, segments };
    for c in s.chats.iter_mut() {
        if let Some(l) = c.last.take() {
            c.last = Some(canonical(l)?.0);
        }
    }
    check_summary(&s)?;
    let fits = |s: &Summary| HistoryOp { op: Some(Op::Summary(s.clone())) }.encoded_len() + 64 <= BATCH_BUDGET;
    if !fits(&s) {
        let mut order: Vec<usize> = (0..s.chats.len()).filter(|&i| s.chats[i].last.is_some()).collect();
        let ts = |c: &ChatSummary| c.last.as_ref().and_then(|l| l.row.as_ref()).map_or(i64::MIN, |r| r.ts_ms);
        order.sort_by_key(|&i| ts(&s.chats[i]));
        for i in order {
            s.chats[i].last = None;
            if fits(&s) {
                break;
            }
        }
        if !fits(&s) {
            return Err(ProtoError::FieldLimit("summary"));
        }
    }
    Ok(HistoryOp { op: Some(Op::Summary(s)) })
}

// ---------------------------------------------------------------------------
// Ключ истории и записи журнала.

/// Ключ истории (стирается из памяти при удалении).
#[derive(Clone)]
pub struct HistoryKey(Zeroizing<[u8; 32]>);

impl fmt::Debug for HistoryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HistoryKey(…)")
    }
}

impl HistoryKey {
    /// `HKDF-SHA256(ikm = ключ состояния, salt = "parvane/history/v1", info = адрес)`.
    pub fn derive(state_key: &StateKey, address: &str) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), state_key.as_bytes());
        let mut k = Zeroizing::new([0u8; 32]);
        // Длина 32 ≤ 255·32 — ошибки не бывает.
        let _ = hk.expand(address.as_bytes(), k.as_mut());
        HistoryKey(k)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(self.0.as_ref()))
    }
}

/// AAD записи: `"parvane/v2/history\0" ‖ адрес ‖ op_id ‖ chunk`.
pub fn record_aad(address: &str, op_id: &[u8], chunk: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + address.len() + op_id.len() + 1);
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(address.as_bytes());
    aad.extend_from_slice(op_id);
    aad.push(u8::from(chunk));
    aad
}

/// Зашифровать пачку с заданным nonce (векторы); в работе — [`seal_batch`].
pub fn seal_with_nonce(key: &HistoryKey, address: &str, op_id: &[u8], chunk: bool, batch: &HistoryBatch, nonce: [u8; NONCE_LEN]) -> Result<AppendRequest> {
    if !address::is_valid_address(address) {
        return Err(ProtoError::BadAddress);
    }
    if !crate::sign::is_valid_op_id(op_id) {
        return Err(ProtoError::InvalidField("op_id"));
    }
    let pt = Zeroizing::new(batch.encode_to_vec());
    if NONCE_LEN + pt.len() + TAG_LEN > MAX_RECORD {
        return Err(ProtoError::FieldLimit("aead_ciphertext"));
    }
    let ct = key
        .cipher()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &pt, aad: &record_aad(address, op_id, chunk) })
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(AppendRequest { op_id: op_id.to_vec(), aead_ciphertext: out, chunk })
}

/// Зашифровать пачку в запрос `history.append` (случайный nonce).
pub fn seal_batch(key: &HistoryKey, address: &str, op_id: &[u8], chunk: bool, batch: &HistoryBatch) -> Result<AppendRequest> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    seal_with_nonce(key, address, op_id, chunk, batch, nonce)
}

/// Открыть запись: тег сходится (ключ, адрес, op_id, chunk), пачка разбирается по лимитам схемы.
pub fn open_record(key: &HistoryKey, address: &str, op_id: &[u8], chunk: bool, aead_ciphertext: &[u8]) -> Result<HistoryBatch> {
    if !address::is_valid_address(address) {
        return Err(ProtoError::BadAddress);
    }
    id16(op_id, "op_id")?;
    if aead_ciphertext.len() > MAX_RECORD {
        return Err(ProtoError::FieldLimit("aead_ciphertext"));
    }
    if aead_ciphertext.len() < NONCE_LEN + TAG_LEN {
        return Err(ProtoError::Crypto);
    }
    let (nonce, ct) = aead_ciphertext.split_at(NONCE_LEN);
    let pt = Zeroizing::new(
        key.cipher()
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &record_aad(address, op_id, chunk) })
            .map_err(|_| ProtoError::Crypto)?,
    );
    let batch: HistoryBatch = decode_checked(&pt, Origin::Client)?;
    if !address::is_valid_device_id(&batch.device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    Ok(batch)
}

/// Разложить операции по пачкам: открытый текст пачки ≤ [`BATCH_BUDGET`], ≤ [`MAX_BATCH_OPS`] операций.
/// Операция больше бюджета — `FieldLimit`.
pub fn pack(ops: Vec<HistoryOp>, device_id: &str, ts_ms: i64) -> Result<Vec<HistoryBatch>> {
    if !address::is_valid_device_id(device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    let head = HistoryBatch { device_id: device_id.to_string(), ts_ms, ops: vec![] }.encoded_len();
    let mut out = Vec::new();
    let mut cur = HistoryBatch { device_id: device_id.to_string(), ts_ms, ops: vec![] };
    let mut used = head;
    for op in ops {
        let len = op.encoded_len();
        // поле `ops`: тег (1) + длина (≤ 4) + сообщение
        let cost = 1 + prost::length_delimiter_len(len) + len;
        if head + cost > BATCH_BUDGET {
            return Err(ProtoError::FieldLimit("op"));
        }
        if !cur.ops.is_empty() && (used + cost > BATCH_BUDGET || cur.ops.len() >= MAX_BATCH_OPS) {
            out.push(std::mem::replace(&mut cur, HistoryBatch { device_id: device_id.to_string(), ts_ms, ops: vec![] }));
            used = head;
        }
        used += cost;
        cur.ops.push(op);
    }
    if !cur.ops.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Сессия журнала устройства.

/// Запись журнала, открытая сессией.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedRecord {
    pub seq: u64,
    pub chunk: bool,
    pub op_id: Vec<u8>,
    /// Индекс первой операции записи в общем списке и их число.
    pub first: usize,
    pub count: usize,
    /// Версия ключа состояния, которым запечатана запись.
    pub key_version: u32,
    /// Запечатана не текущим ключом или не под текущим адресом (точку стоит перезалить).
    pub stale: bool,
    /// Устройство-автор записи.
    pub device_id: String,
}

/// Итог разбора ответа `history.sync`/`history.get`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ingested {
    pub ops: Vec<HistoryOp>,
    pub records: Vec<OpenedRecord>,
    pub more: bool,
    pub head_seq: u64,
    pub compacted: Option<Checkpoint>,
    /// Записи, которые не открылись (чужой ключ, порча, подмена chunk/op_id).
    pub rejected: usize,
    /// Отвергнутые операции внутри открытых записей.
    pub rejected_ops: usize,
}

struct SessionKey {
    version: u32,
    address: String,
    key: HistoryKey,
}

/// Сессия журнала истории: ключи (текущий и прежние, под текущим и прежними адресами), шифрование и
/// разбор записей. Курсор, `head_seq` и строки хранит хост.
pub struct HistorySession {
    user: String,
    device_id: String,
    /// Первый — текущий ключ под текущим адресом (им запечатываются новые записи).
    keys: Vec<SessionKey>,
}

impl fmt::Debug for HistorySession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HistorySession").field("user", &self.user).field("device_id", &self.device_id).finish_non_exhaustive()
    }
}

impl HistorySession {
    /// `state_keys` — текущий ключ состояния первым, затем прежние; `former` — прежние адреса.
    pub fn new(user: &str, former: &[String], device_id: &str, state_keys: &[(&StateKey, u32)]) -> Result<Self> {
        if !address::is_valid_address(user) {
            return Err(ProtoError::BadAddress);
        }
        if !address::is_valid_device_id(device_id) {
            return Err(ProtoError::InvalidField("device_id"));
        }
        if state_keys.is_empty() {
            return Err(ProtoError::NotFound);
        }
        let mut keys = Vec::new();
        for (k, v) in state_keys {
            for a in std::iter::once(user).chain(former.iter().map(String::as_str)) {
                keys.push(SessionKey { version: *v, address: a.to_string(), key: HistoryKey::derive(k, a) });
            }
        }
        Ok(HistorySession { user: user.to_string(), device_id: device_id.to_string(), keys })
    }

    pub fn user(&self) -> &str {
        &self.user
    }

    /// Тело `history.sync`.
    pub fn sync_request(&self, after_seq: u64, skip_chunks: bool, max_bytes: u32) -> Vec<u8> {
        SyncRequest { after_seq, max_bytes, skip_chunks }.encode_to_vec()
    }

    pub fn head_request(&self) -> Vec<u8> {
        HeadRequest {}.encode_to_vec()
    }

    pub fn get_request(&self, seqs: Vec<u64>) -> Result<Vec<u8>> {
        if seqs.is_empty() || seqs.len() > 256 {
            return Err(ProtoError::InvalidField("seqs"));
        }
        Ok(GetRequest { seqs }.encode_to_vec())
    }

    pub fn commit_request(&self, expected: u64, upto_seq: u64, summary_seq: u64, chunk_seqs: Vec<u64>) -> Result<Vec<u8>> {
        if chunk_seqs.len() > 100_000 || summary_seq == 0 || summary_seq > upto_seq || chunk_seqs.iter().any(|s| *s == 0 || *s > upto_seq) {
            return Err(ProtoError::InvalidField("checkpoint"));
        }
        Ok(CommitRequest { expected_checkpoint_id: expected, upto_seq, summary_seq, chunk_seqs }.encode_to_vec())
    }

    /// Запечатать операции в тела `history.append` (`(op_id записи, байты AppendRequest)`), пачки
    /// ≤ 200 КиБ. Каждая операция проверяется до шифрования.
    pub fn seal(&self, ops: Vec<HistoryOp>, chunk: bool, ts_ms: i64) -> Result<Vec<([u8; ID_LEN], Vec<u8>)>> {
        ops.iter().try_for_each(validate_op)?;
        let cur = self.keys.first().ok_or(ProtoError::NotFound)?;
        let mut out = Vec::new();
        for batch in pack(ops, &self.device_id, ts_ms)? {
            let op_id = crate::state::new_op_id();
            let r = seal_batch(&cur.key, &self.user, &op_id, chunk, &batch)?;
            out.push((op_id, r.encode_to_vec()));
        }
        Ok(out)
    }

    fn open(&self, op_id: &[u8], chunk: bool, ct: &[u8]) -> Option<(HistoryBatch, u32, bool)> {
        self.keys.iter().enumerate().find_map(|(i, k)| open_record(&k.key, &k.address, op_id, chunk, ct).ok().map(|b| (b, k.version, i != 0)))
    }

    /// Ответ `history.sync` или `history.get` (у них общее поле `records = 1`).
    pub fn ingest(&self, resp: &[u8]) -> Result<Ingested> {
        let r: SyncResponse = decode_checked(resp, Origin::Server)?;
        let mut out = Ingested { more: r.more && !r.records.is_empty(), head_seq: r.head_seq, compacted: r.compacted, ..Default::default() };
        for rec in &r.records {
            let Some((batch, key_version, stale)) = self.open(&rec.op_id, rec.chunk, &rec.aead_ciphertext) else {
                out.rejected += 1;
                continue;
            };
            let first = out.ops.len();
            for op in batch.ops {
                if validate_op(&op).is_ok() {
                    out.ops.push(op);
                } else {
                    out.rejected_ops += 1;
                }
            }
            out.records.push(OpenedRecord {
                seq: rec.seq,
                chunk: rec.chunk,
                op_id: rec.op_id.clone(),
                first,
                count: out.ops.len() - first,
                key_version,
                stale,
                device_id: batch.device_id,
            });
        }
        Ok(out)
    }

    /// Ответ `history.head`.
    pub fn ingest_head(&self, resp: &[u8]) -> Result<HeadResponse> {
        decode_checked(resp, Origin::Server)
    }
}

/// Пустой ли чат-ключ пользовательский (`u:`) — для хостов.
pub fn chat_kind_of(p: &Peer) -> Option<ChatKind> {
    match p.kind {
        Some(peer::Kind::User(_)) => Some(ChatKind::User),
        Some(peer::Kind::Group(_)) => Some(ChatKind::Group),
        None => None,
    }
}

// ---------------------------------------------------------------------------
// Вспомогательное для операций.

/// Новая метка `(ts_ms, UUIDv7)`.
pub fn new_stamp(ts_ms: i64) -> Stamp {
    Stamp { ts_ms, op_id: crate::state::new_op_id().to_vec() }
}

/// Операция строки из частей (для хостов и тестов).
pub fn row_op(row: MessageRow) -> HistoryOp {
    HistoryOp { op: Some(Op::Row(row)) }
}

pub fn gone_op(g: Gone) -> HistoryOp {
    HistoryOp { op: Some(Op::Gone(g)) }
}

pub fn edit_op(e: Edit) -> HistoryOp {
    HistoryOp { op: Some(Op::Edit(e)) }
}

pub fn react_op(r: React) -> HistoryOp {
    HistoryOp { op: Some(Op::React(r)) }
}

pub fn pin_op(p: Pin) -> HistoryOp {
    HistoryOp { op: Some(Op::Pin(p)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::{Ref, UserRef};

    fn user(a: &str) -> Peer {
        Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
    }
    fn group() -> Peer {
        Peer { kind: Some(peer::Kind::Group(Ref { domain: "x".into(), id: vec![7; 16] })) }
    }
    fn st(ts: i64, n: u8) -> Stamp {
        Stamp { ts_ms: ts, op_id: vec![n; 16] }
    }
    fn row(id: u8, from: &str, ts: i64, text: &str) -> HistoryOp {
        row_op(MessageRow {
            id: vec![id; 16],
            chat: Some(user("bob@x")),
            from: from.into(),
            ts_ms: ts,
            body: serde_json::to_vec(&json!({"content": {"kind": "text", "text": text}})).unwrap(),
        })
    }
    fn gone(id: u8, s: Stamp, scope: GoneScope) -> HistoryOp {
        gone_op(Gone { target: vec![id; 16], chat: Some(user("bob@x")), stamp: Some(s), scope: scope as i32 })
    }

    #[test]
    fn orphan_then_row_then_gone() {
        let e = edit_op(Edit { target: vec![1; 16], chat: Some(user("bob@x")), stamp: Some(st(5, 1)), body: br#"{"content":{"kind":"text","text":"b"}}"#.to_vec() });
        let s = apply(None, &e).unwrap();
        let v = view(&s).unwrap();
        assert_eq!((v["orphan"].as_bool(), v["visible"].as_bool()), (Some(true), Some(false)));
        let s = apply(Some(&s), &row(1, "bob@x", 1000, "a")).unwrap();
        let v = view(&s).unwrap();
        assert_eq!(v["body"]["content"]["text"], "b", "правка поверх тела");
        assert_eq!(v["edited"], true);
        let s = apply(Some(&s), &gone(1, st(9, 2), GoneScope::Everyone)).unwrap();
        assert!(s.row.as_ref().unwrap().body.is_empty() && s.edit_stamp.is_none());
        // Сообщение после удаления не воскресает
        let s2 = apply(Some(&s), &row(1, "bob@x", 1000, "a")).unwrap();
        assert_eq!(s, s2);
        assert_eq!(view(&s2).unwrap()["visible"], false);
    }

    #[test]
    fn wrong_target_or_chat_rejected() {
        let s = apply(None, &row(1, "bob@x", 1, "a")).unwrap();
        assert_eq!(apply(Some(&s), &row(2, "bob@x", 1, "a")).unwrap_err(), ProtoError::ContextMismatch);
        let mut g = gone(1, st(1, 1), GoneScope::Me);
        if let Some(Op::Gone(x)) = g.op.as_mut() {
            x.chat = Some(group());
        }
        assert_eq!(apply(Some(&s), &g).unwrap_err(), ProtoError::ContextMismatch);
        assert!(apply(None, &gone(1, st(1, 1), GoneScope::Unspecified)).is_err());
        assert!(apply(None, &HistoryOp { op: Some(Op::Read(ReadMark::default())) }).is_err());
    }

    #[test]
    fn unread_and_marks() {
        let s = apply(None, &row(5, "bob@x", 2000, "hi")).unwrap();
        assert!(is_unread(&s, None, "alice@x").unwrap());
        assert!(!is_unread(&s, None, "bob@x").unwrap(), "своё");
        let m = ReadMark { chat: Some(user("bob@x")), up_to_ts_ms: 2000, up_to_id: vec![5; 16] };
        assert!(!is_unread(&s, Some(&m), "alice@x").unwrap());
        let m2 = ReadMark { chat: Some(user("bob@x")), up_to_ts_ms: 1999, up_to_id: vec![9; 16] };
        assert!(is_unread(&s, Some(&m2), "alice@x").unwrap());
        assert_eq!(mark_merge(Some(&m), Some(&m2)).unwrap(), Some(m.clone()));
        assert_eq!(mark_merge(Some(&m2), Some(&m)).unwrap(), Some(m.clone()));
        assert!(!mark_after(Some(&m), 2000, &[5; 16]).unwrap());
        assert!(mark_after(Some(&m), 2000, &[6; 16]).unwrap());
        let mode = row_op(MessageRow {
            id: vec![6; 16],
            chat: Some(user("bob@x")),
            from: "bob@x".into(),
            ts_ms: 3000,
            body: br#"{"content":{"kind":"chat_mode","l2":true}}"#.to_vec(),
        });
        assert!(!is_unread(&apply(None, &mode).unwrap(), None, "alice@x").unwrap(), "служебное");
        let wrong = ReadMark { chat: Some(group()), up_to_ts_ms: 0, up_to_id: vec![0; 16] };
        assert_eq!(is_unread(&s, Some(&wrong), "alice@x").unwrap_err(), ProtoError::ContextMismatch);
    }

    #[test]
    fn delete_rights() {
        assert!(can_delete(ChatKind::User, "bob@x", "alice@x", false));
        assert!(can_delete(ChatKind::Group, "bob@x", "bob@x", false));
        assert!(!can_delete(ChatKind::Group, "bob@x", "alice@x", false));
        assert!(can_delete(ChatKind::Group, "bob@x", "alice@x", true));
        assert!(ChatKind::parse("channel").is_err());
    }

    #[test]
    fn wire_row_and_segments() {
        let w = json!({"id": "0190a5b2-0000-7000-8000-000000000001", "from": "bob@x", "to": "alice@x", "ts": 1_700_000_000.5,
            "content": {"text": "hi", "kind": "text"}, "reply_to": "x", "read": true, "edited": true, "origin": "v2", "order": 3});
        let op = row_from_wire(&w, &user("bob@x")).unwrap();
        let Some(Op::Row(r)) = &op.op else { panic!() };
        assert_eq!(r.ts_ms, 1_700_000_000_500);
        assert_eq!(std::str::from_utf8(&r.body).unwrap(), r#"{"content":{"kind":"text","text":"hi"},"reply_to":"x"}"#);
        let s = apply(None, &op).unwrap();
        assert_eq!(segment_key(&s).unwrap(), "u:bob@x|2023-11");
        assert_eq!(year_month(0), "1970-01");
        assert_eq!(year_month(-1), "1969-12");
        assert_eq!(year_month(951_782_400_000), "2000-02"); // 29 фев 2000
        assert!(row_from_wire(&json!({"id": "nope", "from": "bob@x", "ts": 1, "content": {}}), &user("bob@x")).is_err());
        let d1 = segment_digest(&[s.clone(), apply(None, &row(2, "bob@x", 1, "x")).unwrap()]).unwrap();
        let d2 = segment_digest(&[apply(None, &row(2, "bob@x", 1, "x")).unwrap(), s.clone(), s]).unwrap();
        assert_eq!(d1, d2, "порядок и повторы не важны");
    }

    #[test]
    fn compact_horizon_and_replace() {
        let now = 400 * 86_400_000_i64;
        let old_gone = apply(None, &gone(1, st(now - HORIZON_MS - 1, 1), GoneScope::Everyone)).unwrap();
        let new_gone = apply(None, &gone(2, st(now - 1000, 1), GoneScope::Me)).unwrap();
        let old_orphan = apply(None, &react_op(React { target: vec![3; 16], chat: Some(user("bob@x")), user: "bob@x".into(), stamp: Some(st(1, 1)), emoji: "👍".into() })).unwrap();
        let live = apply(None, &row(4, "bob@x", 1, "old but alive")).unwrap();
        let out = compact(&[old_gone, new_gone.clone(), old_orphan, live.clone()], now).unwrap();
        assert_eq!(out, vec![new_gone, live]);
        assert!(needs_replace(10, 20, 5, 6));
        assert!(!needs_replace(30, 20, 5, 6));
        assert!(!needs_replace(10, 20, 6, 6));
    }

    #[test]
    fn seal_open_and_session() {
        let k = StateKey::generate();
        let old = StateKey::generate();
        let s = HistorySession::new("alice@x", &["al@x".into()], "d1", &[(&k, 2), (&old, 1)]).unwrap();
        let bodies = s.seal(vec![row(1, "bob@x", 1, "a")], false, 5).unwrap();
        assert_eq!(bodies.len(), 1);
        let req = AppendRequest::decode(bodies[0].1.as_slice()).unwrap();
        // Ответ sync с этой записью + записью прежнего ключа под прежним адресом + чужой
        let b = HistoryBatch { device_id: "d0".into(), ts_ms: 1, ops: vec![row(2, "bob@x", 2, "b")] };
        let oid = crate::state::new_op_id();
        let old_rec = seal_batch(&HistoryKey::derive(&old, "al@x"), "al@x", &oid, true, &b).unwrap();
        let foreign = seal_batch(&HistoryKey::derive(&StateKey::generate(), "alice@x"), "alice@x", &crate::state::new_op_id(), false, &b).unwrap();
        let rec = |seq, r: &AppendRequest| crate::pb::parvane::history::v1::HistoryRecord { seq, op_id: r.op_id.clone(), aead_ciphertext: r.aead_ciphertext.clone(), chunk: r.chunk };
        let mut flipped = rec(4, &req);
        flipped.chunk = true;
        let resp = SyncResponse { records: vec![rec(1, &req), rec(2, &old_rec), rec(3, &foreign), flipped], more: true, head_seq: 4, compacted: None };
        let got = s.ingest(&resp.encode_to_vec()).unwrap();
        assert_eq!(got.rejected, 2, "чужой ключ и подмена chunk");
        assert_eq!(got.records.len(), 2);
        assert!(!got.records[0].stale && got.records[1].stale && got.records[1].key_version == 1 && got.records[1].chunk);
        assert_eq!(got.ops.len(), 2);
        assert_eq!(got.head_seq, 4);
        assert!(s.commit_request(0, 5, 6, vec![]).is_err());
        assert!(s.get_request(vec![]).is_err());
    }

    #[test]
    fn pack_splits_by_budget() {
        let big = |i: u8| row_op(MessageRow { id: vec![i; 16], chat: Some(user("bob@x")), from: "bob@x".into(), ts_ms: 1, body: format!("{{\"t\":\"{}\"}}", "x".repeat(60_000)).into_bytes() });
        let batches = pack((0..7).map(big).collect(), "d1", 1).unwrap();
        assert_eq!(batches.len(), 3);
        assert!(batches.iter().all(|b| b.encoded_len() <= BATCH_BUDGET));
        let huge = row_op(MessageRow { id: vec![1; 16], chat: Some(user("bob@x")), from: "bob@x".into(), ts_ms: 1, body: vec![b'x'; BATCH_BUDGET] });
        assert_eq!(pack(vec![huge], "d1", 1).unwrap_err(), ProtoError::FieldLimit("op"));
    }
}
