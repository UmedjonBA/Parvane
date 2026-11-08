//! Выгрузка «ничего не потеряно» новым движком (spec 035, contracts/migration.md «Канонические выгрузки» и «Видимые
//! значения»): те же строки `{"kind","key","digest"}` и те же правила разбиения и ключей, что у прежних клиентов
//! (web `auditDump.ts`, ядро `audit_dump.cpp`, общий образец `conformance/audit/`), поэтому выгрузка после переноса
//! сравнима с эталоном «до» (`scripts/migration_audit_diff.py`). Источники — JSON движка: `historyView` строки,
//! маркер, снимок личного состояния в форме `state.v1` (`state_v1::project_v1`), «План», «Облако», сведения групп,
//! голова своего журнала устройств, наличие ключей.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::client::Client;
use crate::history;
use crate::pb::parvane::history::v1::{ReadMark, RowState};
use crate::pb::parvane::state::v1 as v1;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AuditLine {
    pub kind: String,
    pub key: String,
    pub digest: String,
}

/// Что выгружать.
#[derive(Default)]
pub struct Sources<'a> {
    pub user: &'a str,
    pub rows: Vec<&'a RowState>,
    pub marks: Vec<&'a ReadMark>,
    /// Своё исходящее вне строк истории (JSON записи журнала исходящих: `id`, `to`, `ts`, `content`, `reply_to`).
    pub own_journal: Vec<&'a Value>,
    /// Снимок личного состояния в форме `state.v1`.
    pub state: Option<v1::StateSnapshot>,
    pub client: Option<&'a Client>,
}

/// Канонический JSON: ключи по возрастанию, без пробелов, `null` = отсутствующее поле, целое с `.0` — как целое.
pub fn canonical(v: &Value) -> String {
    let mut s = String::new();
    write_canonical(v, &mut s);
    s
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|_| n.is_f64()) {
                if !f.is_finite() {
                    out.push_str("null");
                } else if f.fract() == 0.0 && f.abs() < 1e21 {
                    out.push_str(&format!("{}", f as i128));
                } else {
                    out.push_str(&n.to_string());
                }
            } else {
                out.push_str(&n.to_string());
            }
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<(&String, &Value)> = m.iter().filter(|(_, x)| !x.is_null()).collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, x)) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(x, out);
            }
            out.push('}');
        }
    }
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

fn scalar(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(canonical(&Value::Number(n.clone()))),
        _ => None,
    }
}

/// Ключ собеседника состояния (`parvane.state.v1.Peer` в JSON): `u:<адрес>` | `g:<id группы, base64>`.
pub fn state_peer_key(p: Option<&Value>) -> Option<String> {
    let p = p?.as_object()?;
    if let Some(a) = p.get("user").and_then(|u| u.get("address")).and_then(Value::as_str) {
        return Some(format!("u:{a}"));
    }
    p.get("group").and_then(|g| g.get("id")).and_then(Value::as_str).map(|id| format!("g:{id}"))
}

const ELEMENT_ID_FIELDS: &[&str] = &["id", "op_id", "call_id", "link_id", "set_id"];
const ELEMENT_NAME_FIELDS: &[&str] = &["list", "day", "key", "address"];

/// Ключ элемента списка: id-поля → собеседник → `user`/`group` → `ref` → поля-имена → `h:` + начало дайджеста.
pub fn element_key(e: &Value) -> String {
    match e {
        Value::String(s) => return s.clone(),
        Value::Number(_) => return scalar(Some(e)).unwrap_or_default(),
        Value::Object(m) => {
            let first = |fields: &[&str]| fields.iter().find_map(|f| scalar(m.get(*f)));
            let r = m.get("ref").and_then(|r| r.get("id")).and_then(Value::as_str).map(|id| format!("r:{id}"));
            if let Some(k) = first(ELEMENT_ID_FIELDS).or_else(|| state_peer_key(m.get("peer"))).or_else(|| state_peer_key(Some(e))).or(r).or_else(|| first(ELEMENT_NAME_FIELDS)) {
                return k;
            }
        }
        _ => {}
    }
    format!("h:{}", &sha256_hex(&canonical(e))[..16])
}

struct Pending {
    kind: String,
    key: String,
    value: Value,
}

fn push_snapshot(out: &mut Vec<Pending>, snapshot: &Value) {
    let Some(m) = snapshot.as_object() else { return };
    for (field, value) in m {
        if value.is_null() {
            continue;
        }
        if let Value::Array(a) = value {
            for e in a {
                let kind = match field.as_str() {
                    "drafts" => "draft".to_string(),
                    "scheduled" => "scheduled".to_string(),
                    "sticker_packs" => {
                        if e.get("set_id").and_then(Value::as_str).is_some_and(|s| s.starts_with("g:")) {
                            "saved-gif".into()
                        } else {
                            "sticker-pack".into()
                        }
                    }
                    f => format!("state:{f}"),
                };
                out.push(Pending { kind, key: element_key(e), value: e.clone() });
            }
        } else {
            out.push(Pending { kind: format!("state:{field}"), key: "_".into(), value: value.clone() });
        }
    }
}

fn push_planner(out: &mut Vec<Pending>, planner: &Value) {
    let Some(m) = planner.as_object() else { return };
    for (field, value) in m {
        if field == "headSeq" || field == "sizeBytes" || value.is_null() {
            continue;
        }
        if let Value::Array(a) = value {
            for e in a {
                out.push(Pending { kind: format!("planner:{field}"), key: element_key(e), value: e.clone() });
            }
        } else {
            out.push(Pending { kind: format!("planner:{field}"), key: "_".into(), value: value.clone() });
        }
    }
}

fn push_cloud(out: &mut Vec<Pending>, container: &Value, state: Option<&Value>) {
    let id = scalar(container.get("id")).unwrap_or_default();
    let members = container.get("members").and_then(Value::as_array).map(|a| {
        let mut a = a.clone();
        a.sort_by_key(canonical);
        Value::Array(a)
    });
    let pick = |k: &str| container.get(k).cloned().unwrap_or(Value::Null);
    out.push(Pending {
        kind: "cloud:container".into(),
        key: id.clone(),
        value: json!({"name": pick("name"), "owner": pick("owner"), "role": pick("role"), "hasKey": pick("hasKey"), "members": members}),
    });
    let Some(nodes) = state.and_then(|s| s.get("nodes")).and_then(Value::as_array) else { return };
    for node in nodes {
        let name = node.get("name").and_then(Value::as_str).unwrap_or("");
        let node_kind = node.get("kind").and_then(Value::as_str).unwrap_or("null");
        let is_note = node_kind != "folder" && name.to_lowercase().ends_with(".md");
        let kind = if is_note { "note".to_string() } else { format!("cloud:{node_kind}") };
        let nid = match node.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) => "null".into(),
            None => "undefined".into(),
            Some(other) => canonical(other),
        };
        out.push(Pending { kind, key: format!("{id}/{nid}"), value: node.clone() });
    }
}

const UNREADABLE_KINDS: &[&str] = &["encrypted", "group_encrypted", "unsupported"];

/// Поля, появившиеся в видимых значениях после выпуска, с которого переносим (`expected-additions.json`, раздел
/// `fields`): со значением по умолчанию поле в дайджест не входит — выгрузка «после» сравнима с эталоном «до»;
/// не по умолчанию — входит (это уже новое содержимое, сверка покажет «изменено»).
pub const NEW_DEFAULTS: &[(&str, &str, &str)] = &[
    // PV-005 (spec 035 T082): отпечаток секрета фото группы под эпохой; у групп до переноса — пусто
    ("group", "avatarKeyId", "\"\""),
];

fn strip_new_defaults(kind: &str, v: &mut Value) {
    let Value::Object(m) = v else { return };
    for (k, field, default) in NEW_DEFAULTS {
        if *k == kind {
            let d: Value = serde_json::from_str(default).unwrap_or(Value::Null);
            if m.get(*field).is_some_and(|x| *x == d) {
                m.remove(*field);
            }
        }
    }
}

/// Источники уровня JSON — те же, что у web `buildAuditDump` (`AuditSources`): по ним общий образец
/// `conformance/audit/` сверяется с выгрузкой web и ядра (`tests/migrate_audit.rs`).
#[derive(Default)]
pub struct ValueSources {
    /// `historyView` строки, ключ чата (если вида нет `chatKey`) и id строки (если нет `id`).
    pub views: Vec<(Value, Option<String>, String)>,
    /// Ключ чата и маркер в JSON движка.
    pub marks: Vec<(String, Value)>,
    pub own_journal: Vec<Value>,
    /// Снимок личного состояния `state.v1` в JSON.
    pub state_snapshot: Option<Value>,
    pub planner: Option<Value>,
    pub cloud: Vec<(Value, Option<Value>)>,
    /// hex id группы → сведения (`groupInfo`).
    pub groups: Vec<(String, Value)>,
    /// Пользователь, версия, устройства.
    pub device_logs: Vec<(String, Value, Value)>,
    pub account_keys: Value,
}

/// Выгрузка по источникам — строки по (вид, ключ, дайджест).
pub fn build(src: &Sources<'_>) -> Vec<AuditLine> {
    build_values(&values_of(src))
}

/// Источники движка → источники уровня JSON.
pub fn values_of(src: &Sources<'_>) -> ValueSources {
    let mut v = ValueSources::default();
    for state in &src.rows {
        let Ok(view) = history::view(state) else { continue };
        let chat = state.chat.as_ref().and_then(|p| history::history_chat_key(p).ok());
        v.views.push((view, chat, history::uuid_string(&state.target)));
    }
    for mark in &src.marks {
        let Some(chat_key) = mark.chat.as_ref().and_then(|p| history::history_chat_key(p).ok()) else { continue };
        v.marks.push((chat_key, crate::host::history::to_json(*mark)));
    }
    v.own_journal = src.own_journal.iter().map(|e| (*e).clone()).collect();
    v.state_snapshot = src.state.as_ref().and_then(|s| serde_json::to_value(s).ok());
    let mut account = Map::new();
    if let Some(c) = src.client {
        v.planner = c.planner_state_json().and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let containers: Vec<Value> = serde_json::from_str(&c.cloud_containers_json()).unwrap_or_default();
        for container in containers {
            let state = scalar(container.get("id")).and_then(|id| hex::decode(id).ok()).and_then(|id| c.cloud_state_json(&id)).and_then(|s| serde_json::from_str::<Value>(&s).ok());
            v.cloud.push((container, state));
        }
        for gid in c.group_ids() {
            v.groups.push((hex::encode(&gid), crate::host::group_info_value(c, &gid).unwrap_or(Value::Null)));
        }
        let devices: Value = serde_json::from_str(&crate::host::log_devices_json(c, src.user)).unwrap_or(Value::Null);
        v.device_logs.push((src.user.to_string(), json!(c.log_version(src.user)), devices));
        account.insert("state".into(), Value::Bool(c.state_key().is_some()));
        account.insert("planner".into(), Value::Bool(c.planner_has_key()));
    }
    v.account_keys = Value::Object(account);
    v
}

/// Выгрузка по источникам уровня JSON (правила `auditDump.ts`).
pub fn build_values(src: &ValueSources) -> Vec<AuditLine> {
    let mut out: Vec<Pending> = vec![];
    let mut chats: BTreeMap<String, Value> = BTreeMap::new();
    let mut readable: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut seen_rows: BTreeSet<String> = BTreeSet::new();

    for (view, fallback_chat, fallback_id) in &src.views {
        let chat_key = view.get("chatKey").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).or_else(|| fallback_chat.clone());
        let Some(chat_key) = chat_key else { continue };
        let id = view.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| fallback_id.clone());
        seen_rows.insert(id.clone());
        chats.insert(chat_key.clone(), json!({"type": if chat_key.starts_with("g:") { "group" } else { "direct" }}));
        let mut value = view.clone();
        if let Value::Object(m) = &mut value {
            m.remove("id");
            m.remove("chat");
            m.remove("chatKey");
        }
        out.push(Pending { kind: "message".into(), key: format!("{chat_key}/{id}"), value });
        if view.get("visible").and_then(Value::as_bool) == Some(true) {
            let c = readable.entry(chat_key).or_default();
            c.0 += 1;
            let kind = match view.get("body").and_then(|b| b.get("kind")) {
                Some(Value::String(s)) => s.clone(),
                None => String::new(),
                Some(other) => canonical(other),
            };
            if !UNREADABLE_KINDS.contains(&kind.as_str()) {
                c.1 += 1;
            }
        }
    }

    for (chat_key, j) in &src.marks {
        let ts = scalar(j.get("up_to_ts_ms")).unwrap_or_else(|| "0".into());
        out.push(Pending { kind: "read-mark".into(), key: chat_key.clone(), value: json!({"up_to_ts_ms": ts, "up_to_id": j.get("up_to_id").cloned().unwrap_or(Value::Null)}) });
    }

    for e in &src.own_journal {
        let Some(id) = e.get("id").and_then(Value::as_str) else { continue };
        if seen_rows.contains(id) {
            continue;
        }
        let g = |k: &str| e.get(k).cloned().unwrap_or(Value::Null);
        out.push(Pending { kind: "outbox".into(), key: id.to_string(), value: json!({"to": g("to"), "ts": g("ts"), "content": g("content"), "reply_to": g("reply_to")}) });
    }

    if let Some(s) = &src.state_snapshot {
        push_snapshot(&mut out, s);
    }
    if let Some(p) = &src.planner {
        push_planner(&mut out, p);
    }
    for (container, state) in &src.cloud {
        push_cloud(&mut out, container, state.as_ref());
    }
    for (hex, info) in &src.groups {
        let key = format!("g:{hex}");
        chats.insert(key.clone(), json!({"type": "group"}));
        let mut info = info.clone();
        if let Value::Object(m) = &mut info {
            m.remove("epochStale");
        }
        out.push(Pending { kind: "group".into(), key, value: info });
    }
    for (user, version, devices) in &src.device_logs {
        out.push(Pending { kind: "device-log-head".into(), key: user.clone(), value: json!({"version": version, "devices": devices}) });
    }

    for (k, v) in chats {
        out.push(Pending { kind: "chat".into(), key: k, value: v });
    }
    for (k, (rows, ok)) in readable {
        out.push(Pending { kind: "key-material".into(), key: k, value: json!({"rows": rows, "readable": ok}) });
    }
    out.push(Pending { kind: "key-material".into(), key: "account".into(), value: src.account_keys.clone() });

    let mut lines: Vec<AuditLine> = out
        .into_iter()
        .map(|mut p| {
            strip_new_defaults(&p.kind, &mut p.value);
            AuditLine { kind: p.kind, key: p.key, digest: sha256_hex(&canonical(&p.value)) }
        })
        .collect();
    lines.sort();
    lines
}

/// JSONL выгрузки: строка — `{"kind","key","digest"}` в этом порядке полей.
pub fn jsonl(lines: &[AuditLine]) -> String {
    let mut s = String::new();
    for l in lines {
        let q = |x: &str| serde_json::to_string(x).unwrap_or_default();
        s.push_str(&format!("{{\"kind\":{},\"key\":{},\"digest\":{}}}", q(&l.kind), q(&l.key), q(&l.digest)));
        s.push('\n');
    }
    s
}

pub fn parse_jsonl(s: &str) -> Vec<AuditLine> {
    s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Сверка двух выгрузок: потеряно / изменено / добавлено (вид и ключ, без содержимого).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diff {
    #[serde(default)]
    pub lost: Vec<(String, String)>,
    #[serde(default)]
    pub changed: Vec<(String, String)>,
    #[serde(default)]
    pub added: Vec<(String, String)>,
}

impl Diff {
    pub fn clean(&self) -> bool {
        self.lost.is_empty() && self.changed.is_empty()
    }
}

pub fn diff(before: &[AuditLine], after: &[AuditLine]) -> Diff {
    let index = |ls: &[AuditLine]| -> BTreeMap<(String, String), BTreeSet<String>> {
        let mut m: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
        for l in ls {
            m.entry((l.kind.clone(), l.key.clone())).or_default().insert(l.digest.clone());
        }
        m
    };
    let (b, a) = (index(before), index(after));
    let mut d = Diff::default();
    for (k, dig) in &b {
        match a.get(k) {
            None => d.lost.push(k.clone()),
            Some(x) if x != dig => d.changed.push(k.clone()),
            _ => {}
        }
    }
    for k in a.keys() {
        if !b.contains_key(k) {
            d.added.push(k.clone());
        }
    }
    d
}
