//! WASM-обвязка движка `parvane-protocol` для web (E2, T054). Граница —
//! байты protobuf (тела запросов/записи журнала) и proto3-JSON (pbjson) для
//! содержимого; разбор протокола на стороне JS не нужен (класс 10).
//!
//! Ошибки — исключение со строкой JSON: `{"need": {...}}` (добрать данные и
//! повторить) или `{"error": "<вид ProtoError>"}`.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use js_sys::{Array, Object, Reflect, Uint8Array};
use parvane_protocol::codec::{self, decode_checked};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ClientInfo, Frame, Hello, Ping, Request};
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::Content;
use parvane_protocol::ProtoError;
use prost::Message;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

// spec 035 T043: хранилище движка (`PvStore`, `storeOpen`) — отдельным модулем.
mod store;


/// Инициализация модуля: часы браузера для движка.
#[wasm_bindgen(start)]
pub fn start() {
    parvane_protocol::time::set_clock(|| js_sys::Date::now() as i64);
}

/// Версия движка.
#[wasm_bindgen]
pub fn version() -> String {
    parvane_protocol::version().to_string()
}

/// Мажорная версия протокола.
#[wasm_bindgen(js_name = protoMajor)]
pub fn proto_major() -> u32 {
    parvane_protocol::PROTO_MAJOR
}

pub(crate) fn err_proto(e: ProtoError) -> JsValue {
    JsValue::from_str(&json!({"error": e.kind()}).to_string())
}

pub(crate) fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(k), v);
}

fn content_json(c: &Content) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}





/// Разобрать ссылку-приглашение → JSON `{kind: "v2", domain, linkId(hex)}` |
/// `{kind: "legacy", token}` (исключение — не ссылка-приглашение).
#[wasm_bindgen(js_name = parseInvite)]
pub fn parse_invite(url: &str) -> Result<String, JsValue> {
    match parvane_protocol::invite::parse(url).map_err(err_proto)? {
        parvane_protocol::invite::ParsedInvite::V2(p) => Ok(json!({"kind": "v2", "domain": p.domain, "linkId": hex::encode(&p.link_id)}).to_string()),
        parvane_protocol::invite::ParsedInvite::LegacyV1 { token } => Ok(json!({"kind": "legacy", "token": token}).to_string()),
    }
}



fn parse_call_args(args_json: &str) -> Result<Value, JsValue> {
    let t = args_json.trim();
    if t.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(t).map_err(|_| err_proto(ProtoError::Malformed))
}

/// Статические функции журнала истории (spec 033) по имени: `historyApply`, `historyMerge`, `historyView`,
/// `historyIsUnread`, `historyMarkMerge`, `historyMarkAfter`, `historyCanDelete`, `historyRowFromWire`,
/// `historySegmentKey`, `historySegmentDigest`, `historyNeedsReplace`, `historyCompact`, `historySummary`,
/// `historyApplyMany`, `historyNewStamp`, `historyUnreadKinds`. Результат — JSON-текст.
#[wasm_bindgen(js_name = historyCall)]
pub fn history_call(name: &str, args_json: &str) -> Result<String, JsValue> {
    let args = parse_call_args(args_json)?;
    match parvane_protocol::host::history::call_static(name, &args) {
        Some(r) => r.map(|v| v.to_string()).map_err(|e| JsValue::from_str(&e)),
        None => Err(JsValue::from_str(r#"{"error":"UnknownCall"}"#)),
    }
}


/// Материал гранта линковки + копия корня под ключом восстановления (поле `rb`).
#[wasm_bindgen(js_name = grantWithRootBackup)]
pub fn grant_with_root_backup(material: &[u8], backup: &[u8]) -> Result<Vec<u8>, JsValue> {
    parvane_protocol::host::grant_with_root_backup(material, backup).map_err(err_proto)
}

/// Копия корня из материала гранта (`undefined` — гранта без копии).
#[wasm_bindgen(js_name = grantRootBackup)]
pub fn grant_root_backup(material: &[u8]) -> Option<Vec<u8>> {
    parvane_protocol::host::grant_root_backup(material)
}

/// C1-06: новый ключ восстановления (184 бита, `XXXX-XXXX-…`, 10 групп).
/// Жалоба администратору сервера (spec 024): JSON жалобы, запечатанный его открытым ключом
/// (`ServerDescribeResponse.report_public_key`); `reporter` — свой адрес (сервер берёт его из сессии).
#[wasm_bindgen(js_name = sealReport)]
pub fn seal_report(admin_public: &[u8], reporter: &str, plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
    let key: [u8; 32] = admin_public.try_into().map_err(|_| JsValue::from_str("ключ администратора: нужно 32 байта"))?;
    parvane_protocol::report::seal_report(plaintext, reporter, &key).map_err(err_proto)
}

/// REPORT-1 (A0008-2): подтвердить авторство сообщения из жалобы — `proof` (из события) и `op_id`
/// (UUID-строка), автор и начало текста совпадают с подписанным; `group_hex` не пуст — и группа беседы. Возвращает JSON `{ok, root?, deviceId?}`.
#[wasm_bindgen(js_name = verifyMessageProof)]
pub fn verify_message_proof(proof: &[u8], op_id: &str, author: &str, text: &str, group_hex: &str) -> String {
    let group = hex::decode(group_hex).unwrap_or_else(|_| vec![0]);
    let verdict = parvane_protocol::report::op_id_from_str(op_id)
        .and_then(|op| parvane_protocol::report::verify_message_proof(proof, &op, author, text, &group).ok());
    match verdict {
        Some(i) => json!({"ok": true, "root": hex::encode(i.root_key), "deviceId": i.device_id, "tsMs": i.ts_ms}),
        None => json!({"ok": false}),
    }
    .to_string()
}

/// A0023-1: эфемерная пара для ответа владельца через Telegram — 64 байта: приватный ‖ публичный.
#[wasm_bindgen(js_name = recoveryTgKeypair)]
pub fn recovery_tg_keypair() -> Vec<u8> {
    let (sk, pk) = parvane_protocol::recovery_tg::generate();
    let mut out = sk.to_vec();
    out.extend_from_slice(&pk);
    out
}

/// A0023-1: открыть запечатанный сервером ответ владельца приватным ключом пары.
#[wasm_bindgen(js_name = recoveryTgOpen)]
pub fn recovery_tg_open(secret: &[u8], user: &str, device_id: &str, sealed: &[u8]) -> Result<String, JsValue> {
    let opened = parvane_protocol::recovery_tg::open(secret, user, device_id, sealed).map_err(err_proto)?;
    Ok(String::from_utf8_lossy(&opened).into_owned())
}

#[wasm_bindgen(js_name = generateRecoveryKey)]
pub fn generate_recovery_key() -> String {
    parvane_protocol::recovery::RecoveryKey::generate().to_display().to_string()
}

/// C2-01 (D-05, инв. 25): какое анонимное соединение взять для запроса
/// `chan == "anon"`. Правила: соединение — только одному получателю
/// (пользователю или группе) и только в серии ≤ 60 с с открытия; копия своим
/// устройствам — отдельный получатель (своё соединение); публичные запросы
/// (журналы, бандлы, ключи жетонов) — всегда новое одноразовое соединение.
#[wasm_bindgen]
pub struct PvAnonPlanner {
    inner: parvane_protocol::access::AnonPlanner,
}

#[wasm_bindgen]
impl PvAnonPlanner {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PvAnonPlanner {
        PvAnonPlanner { inner: parvane_protocol::access::AnonPlanner::new() }
    }

    /// Запрос (метод + тело из OutRequest) → `{conn, open, closeAfter}`:
    /// `open` — открыть новое ANONYMOUS_DELIVERY-соединение под номером
    /// `conn`, `closeAfter` — закрыть сразу после ответа.
    pub fn assign(&mut self, method: &str, body: &[u8], now_ms: f64) -> Result<JsValue, JsValue> {
        let t = parvane_protocol::access::anon_target(method, body).map_err(err_proto)?;
        let a = self.inner.assign(t, now_ms as i64);
        let o = Object::new();
        set(&o, "conn", &JsValue::from_f64(a.conn as f64));
        set(&o, "open", &JsValue::from_bool(a.open));
        set(&o, "closeAfter", &JsValue::from_bool(a.close_after));
        Ok(o.into())
    }

    /// Соединения, серия которых истекла, — закрыть (номера).
    pub fn expired(&mut self, now_ms: f64) -> Vec<f64> {
        self.inner.expired(now_ms as i64).into_iter().map(|c| c as f64).collect()
    }

    /// Соединение закрылось (обрыв/таймаут) — больше не выдавать.
    pub fn closed(&mut self, conn: f64) {
        self.inner.closed(conn as u64);
    }

    #[wasm_bindgen(js_name = openCount)]
    pub fn open_count(&self) -> usize {
        self.inner.open_count()
    }
}

impl Default for PvAnonPlanner {
    fn default() -> Self {
        Self::new()
    }
}

// ── кадры транспорта ────────────────────────────────────────────────────────

/// Hello: channel 1 — идентифицированный, 2 — анонимная доставка.
#[wasm_bindgen(js_name = encodeHello)]
pub fn encode_hello(channel: i32, client_kind: &str, client_version: &str) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Hello(Hello {
        proto_minor: parvane_protocol::PROTO_MINOR,
        features: vec![],
        client: Some(ClientInfo { kind: client_kind.into(), version: client_version.into() }),
        channel: Channel::try_from(channel).unwrap_or(Channel::Identified) as i32,
    }))
}

#[wasm_bindgen(js_name = encodeAuth)]
pub fn encode_auth(token: &str) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Auth(Auth { token: token.into() }))
}

/// `pad_to` — дополнить кадр до длины, кратной этому числу (spec 025, режим L2); не задано — без дополнения.
/// `dest_domain` (spec 028) — домен сервера объекта; пусто или свой — обычный запрос.
#[wasm_bindgen(js_name = encodeRequest)]
pub fn encode_request(id: u64, method: &str, body: &[u8], timeout_ms: u32, pad_to: Option<u32>, dest_domain: Option<String>) -> Vec<u8> {
    let req = Request {
        id,
        method: method.into(),
        body: body.to_vec(),
        timeout_ms,
        padding: vec![],
        dest_domain: dest_domain.unwrap_or_default(),
    };
    match pad_to {
        Some(n) if n > 0 => codec::encode_request_padded(req, n as usize),
        _ => codec::encode_frame(frame::Kind::Request(req)),
    }
}

#[wasm_bindgen(js_name = encodePing)]
pub fn encode_ping(nonce: u64) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Ping(Ping { nonce }))
}

/// Разобрать кадр сервера → объект {kind, …} (тела — Uint8Array).
#[wasm_bindgen(js_name = decodeFrame)]
pub fn decode_frame(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let f: Frame = codec::decode_frame(bytes, Origin::Server).map_err(err_proto)?;
    let o = Object::new();
    let u8a = |b: &[u8]| -> JsValue { Uint8Array::from(b).into() };
    match f.kind {
        Some(frame::Kind::Welcome(w)) => {
            set(&o, "kind", &"welcome".into());
            set(&o, "minSupportedMinor", &w.min_supported_minor.into());
            set(&o, "features", &JsValue::from_str(&w.features.join(",")));
            set(&o, "serverDescriptor", &u8a(&w.server_descriptor));
        }
        Some(frame::Kind::AuthOk(a)) => {
            set(&o, "kind", &"authOk".into());
            set(&o, "user", &a.user.into());
            set(&o, "deviceId", &a.device_id.into());
        }
        Some(frame::Kind::Response(r)) => {
            set(&o, "kind", &"response".into());
            set(&o, "id", &JsValue::from_f64(r.id as f64));
            match r.result {
                Some(parvane_protocol::pb::parvane::core::v2::response::Result::Ok(b)) => set(&o, "ok", &u8a(&b)),
                Some(parvane_protocol::pb::parvane::core::v2::response::Result::Error(e)) => {
                    set(&o, "error", &JsValue::from_str(error_name(e.code)));
                    set(&o, "retryAfterMs", &e.retry_after_ms.into());
                }
                None => set(&o, "error", &"UNSPECIFIED".into()),
            }
        }
        Some(frame::Kind::Event(e)) => {
            set(&o, "kind", &"event".into());
            set(&o, "subscription", &JsValue::from_f64(e.subscription as f64));
            set(&o, "eventKind", &e.kind.into());
            set(&o, "seq", &JsValue::from_f64(e.seq as f64));
            set(&o, "body", &u8a(&e.body));
        }
        Some(frame::Kind::StreamChunk(c)) => {
            set(&o, "kind", &"chunk".into());
            set(&o, "id", &JsValue::from_f64(c.id as f64));
            set(&o, "index", &c.index.into());
            set(&o, "last", &c.last.into());
            set(&o, "data", &u8a(&c.data));
            if let Some(e) = c.error {
                set(&o, "error", &JsValue::from_str(error_name(e.code)));
            }
        }
        Some(frame::Kind::Ping(p)) => {
            set(&o, "kind", &"ping".into());
            set(&o, "nonce", &JsValue::from_f64(p.nonce as f64));
        }
        Some(frame::Kind::Pong(p)) => {
            set(&o, "kind", &"pong".into());
            set(&o, "nonce", &JsValue::from_f64(p.nonce as f64));
        }
        _ => set(&o, "kind", &"unknown".into()),
    }
    Ok(o.into())
}

fn error_name(code: i32) -> &'static str {
    use parvane_protocol::pb::parvane::core::v2::ErrorCode;
    ErrorCode::try_from(code).map(|c| c.as_str_name()).unwrap_or("ERROR_CODE_UNSPECIFIED")
}

/// Проверить описатель сервера → JSON {domain, serverKey(hex)}.
#[wasm_bindgen(js_name = verifyServerDescriptor)]
pub fn verify_server_descriptor(bytes: &[u8]) -> Result<String, JsValue> {
    let (d, k) = parvane_protocol::client::verify_server_descriptor(bytes).map_err(err_proto)?;
    Ok(json!({"domain": d, "serverKey": hex::encode(k)}).to_string())
}

/// Прогнать набор векторов conformance движком (тест клиента на своей сборке).
#[wasm_bindgen(js_name = runConformanceVectors)]
pub fn run_conformance_vectors(suite: &str, json: &str) -> Result<usize, JsValue> {
    parvane_protocol::conformance::run(suite, json).map_err(|e| JsValue::from_str(&e))
}

/// Тело запроса любого метода реестра из proto3-JSON (T161).
#[wasm_bindgen(js_name = encodeMethodRequest)]
pub fn encode_method_request(method: &str, json: &str) -> Result<Vec<u8>, JsValue> {
    parvane_protocol::host::encode_method_request(method, json).map_err(|e| JsValue::from_str(&e))
}

/// Ответ любого метода реестра → proto3-JSON (T161).
#[wasm_bindgen(js_name = decodeMethodResponse)]
pub fn decode_method_response(method: &str, bytes: &[u8]) -> Result<String, JsValue> {
    parvane_protocol::host::decode_method_response(method, bytes).map_err(|e| JsValue::from_str(&e))
}

/// Тело `cloud.blob.upload_chunk` из байт зашифрованного чанка (A7): без
/// base64/JSON. `bucket`: 0 — медиа чатов, 1 — диск «Облака». Кадр запроса —
/// как обычно, `encodeRequest(id, method, body, timeout)`. Чанки скачивания
/// уже приходят байтами (`decodeFrame` → `chunk.data`).
#[wasm_bindgen(js_name = encodeUploadChunk)]
pub fn encode_upload_chunk(upload_id: &str, index: u32, bucket: i32, data: &[u8]) -> Result<Vec<u8>, JsValue> {
    parvane_protocol::host::encode_upload_chunk(upload_id, index, bucket, data).map_err(|e| JsValue::from_str(&e))
}

/// proto3-JSON → байты сообщения по полному имени типа — для ВСЕХ сообщений схемы (spec 035, FR-050:
/// тонкий вызов сгенерированного `type_codec`). Незнакомый тип — `UnknownMethod`.
#[wasm_bindgen(js_name = encodeMessage)]
pub fn encode_message(type_name: &str, json: &str) -> Result<Vec<u8>, JsValue> {
    parvane_protocol::type_codec::encode_by_type(type_name, json).unwrap_or(Err(ProtoError::UnknownMethod)).map_err(err_proto)
}

/// Байты → proto3-JSON по полному имени типа (лимиты схемы — до разбора). Незнакомый тип — `UnknownMethod`.
#[wasm_bindgen(js_name = decodeMessage)]
pub fn decode_message(type_name: &str, bytes: &[u8]) -> Result<String, JsValue> {
    parvane_protocol::type_codec::decode_by_type(type_name, bytes, Origin::Server).unwrap_or(Err(ProtoError::UnknownMethod)).map_err(err_proto)
}

/// spec 035 (FR-046, contracts/versioning.md): `engineInfo()` этой сборки движка (JSON).
#[wasm_bindgen(js_name = engineInfo)]
pub fn engine_info() -> String {
    parvane_protocol::engine_info_json()
}

/// Полные имена всех сообщений схемы (тесты кодеков во всех обвязках, spec 035 T012).
#[wasm_bindgen(js_name = schemaMessageNames)]
pub fn schema_message_names() -> String {
    serde_json::to_string(&parvane_protocol::schema::MESSAGES.iter().map(|m| m.name).collect::<Vec<_>>()).unwrap_or_default()
}

/// Страница `msg.inbox.sync` → {records: Uint8Array[] (каждая — InboxRecord), more}.
#[wasm_bindgen(js_name = splitSyncResponse)]
pub fn split_sync_response(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let r: parvane_protocol::pb::parvane::msg::v2::InboxSyncResponse = decode_checked(bytes, Origin::Server).map_err(err_proto)?;
    let o = Object::new();
    let recs: Array = r.records.iter().map(|x| JsValue::from(Uint8Array::from(x.encode_to_vec().as_slice()))).collect();
    set(&o, "records", &recs.into());
    set(&o, "more", &r.more.into());
    Ok(o.into())
}

/// Число записей в ответе журнала устройств (0 — у пользователя нет v2).
#[wasm_bindgen(js_name = deviceLogEntries)]
pub fn device_log_entries(bytes: &[u8]) -> Result<usize, JsValue> {
    let r: ipb::DeviceLogSyncAnonResponse = decode_checked(bytes, Origin::Server).map_err(err_proto)?;
    Ok(r.entries.len())
}

/// Разбор записи истории/кадра v1 (legacy_v1) → JSON.
#[wasm_bindgen(js_name = parseLegacyStored)]
pub fn parse_legacy_stored(json_bytes: &[u8]) -> Result<String, JsValue> {
    let s = parvane_protocol::legacy_v1::parse_stored(json_bytes).map_err(err_proto)?;
    let body = match &s.body {
        parvane_protocol::legacy_v1::LegacyBody::Tombstone => json!({"tombstone": true}),
        parvane_protocol::legacy_v1::LegacyBody::Plain(c) => json!({"plain": content_json(c)}),
        parvane_protocol::legacy_v1::LegacyBody::Olm { ctype, sender_identity, .. } => json!({"olm": {"ctype": ctype, "senderIdentity": sender_identity}}),
        parvane_protocol::legacy_v1::LegacyBody::Megolm { group, sender_identity, .. } => json!({"megolm": {"group": group, "senderIdentity": sender_identity}}),
    };
    Ok(json!({"id": s.id, "from": s.from, "to": s.to, "ts": s.ts, "replyTo": s.reply_to, "edited": s.edited, "deleted": s.deleted, "pinned": s.pinned, "body": body}).to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn version() {
        assert_eq!(super::version(), parvane_protocol::version());
    }
}

/// spec 035 (T070, contracts/engine-api.md): модель движка — намерения → изменения модели. Граница —
/// proto3-JSON типов `engine/v1/model.proto`; ошибка вызова — `{"error": "<вид>"}` в строке результата,
/// ошибка открытия — исключение с той же строкой. Прежние поштучные экспорты (`Client`, `history*`, …)
/// остаются до перехода web на модель (T118).
#[wasm_bindgen]
pub struct PvEngine {
    inner: parvane_protocol::model::Engine,
}

#[wasm_bindgen]
impl PvEngine {
    /// Открыть по конфигурации (`EngineConfig`, JSON); дальше — `call("start", "{}")`.
    pub fn open(config_json: &str) -> Result<PvEngine, JsValue> {
        parvane_protocol::model::Engine::open_json(config_json).map(|inner| PvEngine { inner }).map_err(|e| JsValue::from_str(&e))
    }

    /// Вызов по имени (`start`, `submit`, `storeLoaded`, `storeCommitted`, `ingest`, `tick`, `chatList`,
    /// `historyPage`, `viewState`, `viewGroup`, `capabilities`, `unlockPin`, `engineInfo`) → JSON результата.
    pub fn call(&mut self, name: &str, args_json: &str) -> String {
        self.inner.call(name, args_json)
    }

    /// Ревизия последнего выпущенного изменения модели.
    pub fn revision(&self) -> f64 {
        self.inner.revision() as f64
    }

    #[wasm_bindgen(js_name = engineInfo)]
    pub fn engine_info(&self) -> String {
        parvane_protocol::engine_info_json()
    }
}
