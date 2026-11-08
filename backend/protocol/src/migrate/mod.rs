//! Разовый перенос данных клиента в новое хранилище движка (spec 035, US1, FR-060…FR-068, contracts/migration.md,
//! research.md R9). Общий для всех клиентов: хостовые читатели старых мест (web `migrate_legacy_web.ts`, ядро
//! `migrate_legacy.cpp`, android `MigrateLegacy.kt`) тонкие — они открывают старые хранилища только на чтение,
//! снимают СВОЁ шифрование хранилища (web — ключ WebCrypto `secure-state`, ядро — `storecrypt`) и отдают движку
//! записи как есть: `{key, value}`, где `key` — ключ по перечню `migration-inventory.json` (`record:m:<uuid>`,
//! `localStorage:parvane:cleareduntil:<адрес>`, `file:parvane-history-<адрес>.jsonl`, `file:/state` …), а `value` —
//! открытый текст записи. Разбор старых форматов — здесь (`web.rs`, `core.rs`, `android.rs`), журнал личного
//! состояния `state.v1` → `state.v2` — `state_v1.rs`, выгрузка сверки — `audit.rs`, карантин — `quarantine.rs`.
//! Подключение к модели движка (точки M1–M6, запись поколения 1, сеть) — `model/migration.rs`.
//!
//! Модуль удаляется вручную по решению пользователя (D2, T149) вместе с хостовыми читателями.

pub mod android;
pub mod audit;
pub mod core;
pub mod quarantine;
pub mod state_v1;
pub mod web;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::history;
use crate::pb::parvane::history::v1::{ReadMark, RowState};
use quarantine::Quarantined;

pub(crate) mod b64ser {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}

/// Старая запись, как её отдал хост.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyRecord {
    /// Ключ по перечню (`migration-inventory.json`): место и ключ/файл.
    pub key: String,
    /// Открытый текст записи (base64 на границе JSON).
    #[serde(with = "b64ser")]
    pub value: Vec<u8>,
}

impl LegacyRecord {
    pub fn new(key: impl Into<String>, value: impl Into<Vec<u8>>) -> Self {
        LegacyRecord { key: key.into(), value: value.into() }
    }
}

/// Клиент, чьи старые хранилища переносятся.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Web,
    Core,
    Android,
}

impl Layer {
    pub fn parse(s: &str) -> Option<Layer> {
        match s {
            "web" => Some(Layer::Web),
            "core" | "desktop" => Some(Layer::Core),
            "android" => Some(Layer::Android),
            _ => None,
        }
    }
}

/// Что старая запись значит для переноса.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Class {
    /// Экспорт состояния движка прежней версии (`exportState`).
    EngineState,
    /// Ключ экспорта (32 байта; сырые, base64, hex либо JSON-строка).
    EngineKey,
    /// Строки истории: JSON-объект строки, массив либо JSONL.
    HistoryRows,
    /// Маркеры «прочитано до».
    ReadMarks,
    /// Своё исходящее, ещё не ставшее строкой (`j:<uuid>`).
    OwnJournal,
    /// Граница очистки «у себя» по адресу (`{адрес: мс}`).
    Cleared,
    /// Неотправленные операции журнала `state.v1` этой версии (base64/hex байтов `StateOp` либо JSON).
    StateUnsent,
    /// Проекция журнала, кэш или служебная отметка — пересчитывается новым движком (судьба `recompute`,
    /// `drop-derived`, `keep` по перечню).
    Derived(&'static str),
    /// Ключ не из перечня этого клиента.
    Unknown,
}

/// Нормализованное содержимое старых хранилищ одного профиля.
#[derive(Debug, Default, Clone)]
pub struct Legacy {
    pub engine_blob: Option<Vec<u8>>,
    pub engine_key: Option<[u8; 32]>,
    /// Ключ чата истории (`history_chat_key`) → id строки → (состояние, место ORDER-1, если было).
    pub rows: BTreeMap<String, BTreeMap<Vec<u8>, (RowState, Option<i64>)>>,
    /// Ключ чата истории → маркер.
    pub marks: BTreeMap<String, ReadMark>,
    /// id → запись журнала исходящих (JSON как лежал).
    pub own_journal: BTreeMap<String, Value>,
    /// Адрес чата (как в старом клиенте: `адрес` или `v2g:<hex>`) → граница очистки, мс.
    pub cleared: BTreeMap<String, i64>,
    /// Неотправленные операции старого журнала состояния (байты `parvane.state.v1.StateOp`).
    pub state_unsent: Vec<Vec<u8>>,
    pub quarantine: Vec<Quarantined>,
    /// Отчёт: число записей по классу.
    pub counts: BTreeMap<String, u64>,
    /// Ключи не из перечня (переносом не тронуты, в отчёте).
    pub unknown: Vec<String>,
}

impl Legacy {
    fn count(&mut self, what: &str) {
        *self.counts.entry(what.to_string()).or_default() += 1;
    }

    /// Свести строку истории (повтор той же строки из двух мест — по правилу журнала истории).
    pub fn put_row(&mut self, key: &str, state: RowState, order: Option<i64>) {
        let Ok(chat) = state.chat.as_ref().ok_or(()).and_then(|p| history::history_chat_key(p).map_err(|_| ())) else {
            self.quarantine.push(Quarantined::new(key, "bad-chat", &prost::Message::encode_to_vec(&state)));
            return;
        };
        let rows = self.rows.entry(chat).or_default();
        match rows.remove(&state.target) {
            Some((prev, prev_order)) => match history::merge(&prev, &state) {
                Ok(m) => {
                    rows.insert(state.target.clone(), (m, prev_order.or(order)));
                }
                Err(_) => {
                    self.quarantine.push(Quarantined::new(key, "merge", &prost::Message::encode_to_vec(&state)));
                    rows.insert(prev.target.clone(), (prev, prev_order));
                }
            },
            None => {
                rows.insert(state.target.clone(), (state, order));
            }
        }
    }

    pub fn put_mark(&mut self, mark: ReadMark) {
        let Some(chat) = mark.chat.as_ref().and_then(|p| history::history_chat_key(p).ok()) else { return };
        let merged = history::mark_merge(self.marks.get(&chat), Some(&mark)).ok().flatten().unwrap_or(mark);
        self.marks.insert(chat, merged);
    }

    pub fn row_count(&self) -> usize {
        self.rows.values().map(|r| r.len()).sum()
    }
}

/// Разобрать записи старых хранилищ клиента. Ничего не теряется: что не разобралось — в карантин,
/// незнакомый ключ — в `unknown`.
pub fn collect(layer: Layer, records: &[LegacyRecord], domain: &str) -> Legacy {
    let mut out = Legacy::default();
    for r in records {
        let class = match layer {
            Layer::Web => web::classify(&r.key),
            Layer::Core => core::classify(&r.key),
            Layer::Android => android::classify(&r.key),
        };
        absorb(&mut out, class, r, domain);
    }
    // Очищенное «у себя» до границы в выгрузке «до» не показывалось (`collectStates`) — не переносится.
    let cleared = out.cleared.clone();
    for (address, until) in cleared {
        let Some(chat) = chat_key_of_address(&address) else { continue };
        if let Some(rows) = out.rows.get_mut(&chat) {
            rows.retain(|_, (s, _)| s.row.as_ref().is_none_or(|r| r.ts_ms == 0 || r.ts_ms > until));
        }
    }
    out
}

/// Ключ чата истории по адресу старого клиента: `адрес` → `u:адрес`, `v2g:<hex>` → `g:<hex>`.
pub fn chat_key_of_address(a: &str) -> Option<String> {
    if let Some(hex) = a.strip_prefix("v2g:") {
        return Some(format!("g:{hex}"));
    }
    a.contains('@').then(|| format!("u:{a}"))
}

fn absorb(out: &mut Legacy, class: Class, r: &LegacyRecord, _domain: &str) {
    match class {
        Class::EngineState => {
            out.count("engine-state");
            out.engine_blob = Some(r.value.clone());
        }
        Class::EngineKey => match parse_key32(&r.value) {
            Some(k) => {
                out.count("engine-key");
                out.engine_key = Some(k);
            }
            None => out.quarantine.push(Quarantined::new(&r.key, "malformed", &r.value)),
        },
        Class::HistoryRows => {
            let before = out.quarantine.len();
            let mut n = 0u64;
            for v in json_values(&r.value) {
                match v {
                    Ok(v) => n += rows_from_value(out, &r.key, &v),
                    Err(()) => out.quarantine.push(Quarantined::new(&r.key, "malformed", &r.value)),
                }
            }
            if n == 0 && out.quarantine.len() == before && !r.value.iter().all(u8::is_ascii_whitespace) {
                out.quarantine.push(Quarantined::new(&r.key, "no-row-state", &r.value));
            }
            *out.counts.entry("history-row".into()).or_default() += n;
        }
        Class::ReadMarks => {
            for v in json_values(&r.value) {
                match v {
                    Ok(v) => marks_from_value(out, &r.key, &v),
                    Err(()) => out.quarantine.push(Quarantined::new(&r.key, "malformed", &r.value)),
                }
            }
        }
        Class::OwnJournal => {
            for v in json_values(&r.value) {
                match v {
                    Ok(Value::Array(a)) => {
                        for e in a {
                            own_entry(out, &r.key, e);
                        }
                    }
                    Ok(e) => own_entry(out, &r.key, e),
                    Err(()) => out.quarantine.push(Quarantined::new(&r.key, "malformed", &r.value)),
                }
            }
        }
        Class::Cleared => match serde_json::from_slice::<BTreeMap<String, Value>>(&r.value) {
            Ok(m) => {
                for (a, v) in m {
                    if let Some(ms) = v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str().and_then(|s| s.parse().ok())) {
                        let e = out.cleared.entry(a).or_default();
                        *e = (*e).max(ms);
                    }
                }
                out.count("cleared");
            }
            Err(_) => out.quarantine.push(Quarantined::new(&r.key, "malformed", &r.value)),
        },
        Class::StateUnsent => {
            for v in json_values(&r.value) {
                let list = match v {
                    Ok(Value::Array(a)) => a,
                    Ok(other) => vec![other],
                    Err(()) => vec![Value::String(String::from_utf8_lossy(&r.value).trim().to_string())],
                };
                for e in list {
                    match e.as_str().and_then(decode_bytes) {
                        Some(b) => {
                            out.count("state-unsent");
                            out.state_unsent.push(b);
                        }
                        None => out.quarantine.push(Quarantined::new(&r.key, "malformed", e.to_string().as_bytes())),
                    }
                }
            }
        }
        Class::Derived(why) => out.count(why),
        Class::Unknown => out.unknown.push(r.key.clone()),
    }
}

fn own_entry(out: &mut Legacy, key: &str, e: Value) {
    match e.get("id").and_then(Value::as_str) {
        Some(id) => {
            out.count("own-journal");
            out.own_journal.insert(id.to_string(), e);
        }
        None => out.quarantine.push(Quarantined::new(key, "malformed", e.to_string().as_bytes())),
    }
}

/// Значения JSON записи: одно значение либо JSONL (по строке на значение).
pub fn json_values(b: &[u8]) -> Vec<std::result::Result<Value, ()>> {
    if let Ok(v) = serde_json::from_slice::<Value>(b) {
        return vec![Ok(v)];
    }
    let text = String::from_utf8_lossy(b);
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str::<Value>(l).map_err(|_| ())).collect()
}

/// Строки истории из значения: `{hs, order}` (запись кэша web), `{target, …}` (`RowState` в JSON движка),
/// `{state|row_state: …}`, массив или карта таких. Возвращает число строк.
fn rows_from_value(out: &mut Legacy, key: &str, v: &Value) -> u64 {
    match v {
        Value::Array(a) => a.iter().map(|x| rows_from_value(out, key, x)).sum(),
        Value::Object(m) => {
            let order = m.get("order").and_then(Value::as_i64);
            let state = m.get("hs").or_else(|| m.get("state")).or_else(|| m.get("row_state")).or_else(|| m.contains_key("target").then_some(v));
            match state {
                Some(s) => match crate::host::history::from_json::<RowState>(s) {
                    Ok(st) if !st.target.is_empty() => {
                        out.put_row(key, st, order);
                        1
                    }
                    _ => {
                        out.quarantine.push(Quarantined::new(key, "malformed", v.to_string().as_bytes()));
                        0
                    }
                },
                // Карта `id → строка` (файлы ядра) либо строка кэша без сводимого состояния
                None if m.values().all(Value::is_object) && !m.contains_key("id") => m.values().map(|x| rows_from_value(out, key, x)).sum(),
                None => {
                    out.quarantine.push(Quarantined::new(key, "no-row-state", v.to_string().as_bytes()));
                    0
                }
            }
        }
        _ => 0,
    }
}

/// Маркеры: `{address, mark}` (web `rm:`), `{chat, up_to_ts_ms, up_to_id}` (JSON движка), массив или карта.
fn marks_from_value(out: &mut Legacy, key: &str, v: &Value) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| marks_from_value(out, key, x)),
        Value::Object(m) if m.contains_key("mark") => marks_from_value(out, key, &m["mark"]),
        Value::Object(m) if m.contains_key("chat") => match crate::host::history::from_json::<ReadMark>(v) {
            Ok(mk) => {
                out.count("read-mark");
                out.put_mark(mk);
            }
            Err(_) => out.quarantine.push(Quarantined::new(key, "malformed", v.to_string().as_bytes())),
        },
        Value::Object(m) => m.values().for_each(|x| marks_from_value(out, key, x)),
        _ => {}
    }
}

/// 32 байта ключа: сырые, base64, hex или JSON-строка с base64/hex, либо JSON-массив чисел.
pub fn parse_key32(b: &[u8]) -> Option<[u8; 32]> {
    if b.len() == 32 {
        return b.try_into().ok();
    }
    let text = match serde_json::from_slice::<Value>(b) {
        Ok(Value::String(s)) => s,
        Ok(Value::Array(a)) => {
            let v: Option<Vec<u8>> = a.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok())).collect();
            return v.and_then(|v| v.try_into().ok());
        }
        _ => String::from_utf8(b.to_vec()).ok()?,
    };
    decode_bytes(text.trim())?.try_into().ok()
}

/// base64 (обычный/URL, с дополнением и без) либо hex.
pub fn decode_bytes(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    if !s.is_empty() && s.len() % 2 == 0 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(v) = hex::decode(s) {
            return Some(v);
        }
    }
    let e = base64::engine::general_purpose::STANDARD;
    e.decode(s)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(s))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s))
        .ok()
}

/// Ключ перечня без места: `record:m:abc` → (`record`, `m:abc`); `file:/state` → (`file`, `/state`).
pub fn split_place(key: &str) -> (&str, &str) {
    key.split_once(':').unwrap_or(("", key))
}

/// Имя файла по ключу перечня ядра/android (`file:parvane-v2-a@x/state` → `state`).
pub fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Отчёт переноса (поле `migration` записи `migration-progress/legacy` и ответ `migrateStatus`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// Число записей по классу/виду.
    #[serde(default)]
    pub counts: BTreeMap<String, u64>,
    /// В карантине: ключ и причина (без содержимого).
    #[serde(default)]
    pub quarantined: Vec<(String, String)>,
    /// Ключи не из перечня.
    #[serde(default)]
    pub unknown: Vec<String>,
    /// Сверка выгрузок «до» (из старых записей) и «после» (из нового хранилища).
    #[serde(default)]
    pub audit: audit::Diff,
    /// Ошибки (перенос остановлен до переключения).
    #[serde(default)]
    pub errors: Vec<String>,
}
