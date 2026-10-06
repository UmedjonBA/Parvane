//! WASM-обвязка движка `parvane-protocol` для web (E2, T054). Граница —
//! байты protobuf (тела запросов/записи журнала) и proto3-JSON (pbjson) для
//! содержимого; разбор протокола на стороне JS не нужен (класс 10).
//!
//! Ошибки — исключение со строкой JSON: `{"need": {...}}` (добрать данные и
//! повторить) или `{"error": "<вид ProtoError>"}`.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use js_sys::{Array, Object, Reflect, Uint8Array};
use parvane_protocol::client::{Chan, Client, ClientError, Event, LogVerdict, Need, OutRequest};
use parvane_protocol::codec::{self, decode_checked};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{frame, Auth, Channel, ClientInfo, Frame, Hello, Ping, Ref, Request};
use parvane_protocol::pb::parvane::group::v2 as gpb;
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::Content;
use parvane_protocol::unknown::Disposition;
use parvane_protocol::ProtoError;
use prost::Message;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

mod v1;

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

fn need_json(n: &Need) -> Value {
    match n {
        Need::PeerLog { user, after } => json!({"kind": "peerLog", "user": user, "after": after}),
        Need::Bundle { user } => json!({"kind": "bundle", "user": user}),
        Need::Token { user } => json!({"kind": "token", "user": user}),
        Need::RootChanged { user } => json!({"kind": "rootChanged", "user": user}),
        Need::GroupLog { group, after } => json!({"kind": "groupLog", "group": hex::encode(group), "after": after}),
        Need::GroupKeys { group, epoch } => json!({"kind": "groupKeys", "group": hex::encode(group), "epoch": epoch}),
        Need::Forbidden => json!({"kind": "forbidden"}),
    }
}

fn err_client(e: ClientError) -> JsValue {
    match e {
        ClientError::Need(n) => JsValue::from_str(&json!({"need": need_json(&n)}).to_string()),
        ClientError::Proto(p) => err_proto(p),
    }
}

pub(crate) fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(k), v);
}

fn req_js(r: &OutRequest) -> JsValue {
    let o = Object::new();
    set(&o, "chan", &JsValue::from_str(match r.chan {
        Chan::Id => "id",
        Chan::Anon => "anon",
    }));
    set(&o, "method", &JsValue::from_str(r.method));
    set(&o, "body", &Uint8Array::from(r.body.as_slice()).into());
    o.into()
}

fn reqs_js(rs: &[OutRequest]) -> Array {
    rs.iter().map(req_js).collect()
}

fn content_json(c: &Content) -> Value {
    serde_json::to_value(c).unwrap_or(Value::Null)
}

fn disp(d: Disposition) -> &'static str {
    match d {
        Disposition::Show => "show",
        Disposition::Stub => "stub",
        Disposition::Skip => "skip",
    }
}

fn event_json(e: &Event) -> Value {
    match e {
        Event::Direct { seq, chat, from, device, op_id, ts_ms, content, disposition } => json!({
            "type": "direct", "seq": seq, "chat": chat, "from": from, "device": device,
            "opId": uuid_str(op_id), "tsMs": ts_ms, "content": content_json(content), "disposition": disp(*disposition)
        }),
        Event::Group { seq, group, from, device, op_id, ts_ms, content, disposition } => json!({
            "type": "group", "seq": seq, "group": {"domain": group.domain, "id": hex::encode(&group.id)}, "from": from,
            "device": device, "opId": uuid_str(op_id), "tsMs": ts_ms, "content": content_json(content), "disposition": disp(*disposition)
        }),
        Event::LegacyV1 { seq, json } => json!({"type": "legacyV1", "seq": seq, "json": String::from_utf8_lossy(json)}),
        Event::GroupChanged { seq, group, version } => json!({"type": "groupChanged", "seq": seq, "group": {"domain": group.domain, "id": hex::encode(&group.id)}, "version": version}),
        Event::DeviceRevoked { seq, device_id } => json!({"type": "deviceRevoked", "seq": seq, "deviceId": device_id}),
        Event::DeviceAdded { device_id, log_version } => json!({"type": "deviceAdded", "deviceId": device_id, "logVersion": log_version}),
        Event::Call { from, device, call_id, ts_ms, signal } => json!({
            "type": "call", "from": from, "device": device, "callId": hex::encode(call_id), "tsMs": ts_ms,
            "signal": serde_json::to_value(signal).unwrap_or(Value::Null)
        }),
        Event::StateKeyRotated { seq, key_version } => json!({"type": "stateKeyRotated", "seq": seq, "keyVersion": key_version}),
        Event::Typing { .. } | Event::Presence { .. } => parvane_protocol::host::eph_event_json(e),
        Event::Internal { seq } => json!({"type": "internal", "seq": seq}),
        Event::Skipped { seq } => json!({"type": "skipped", "seq": seq}),
    }
}

/// 16 байт → UUID-строка (как id сообщений v1/UI).
fn uuid_str(b: &[u8]) -> String {
    let h = hex::encode(b);
    if h.len() != 32 {
        return h;
    }
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn events_js(ev: &[Event]) -> String {
    Value::Array(ev.iter().map(event_json).collect()).to_string()
}

fn key32(k: &[u8]) -> Result<[u8; 32], JsValue> {
    k.try_into().map_err(|_| err_proto(ProtoError::InvalidField("key")))
}

fn parse_content(json: &str) -> Result<Content, JsValue> {
    serde_json::from_str(json).map_err(|_| err_proto(ProtoError::Malformed))
}

/// UUID-строка хоста → 16 байт (пусто — новый UUIDv7).
fn op_id_bytes(s: &str) -> Result<Vec<u8>, JsValue> {
    if s.is_empty() {
        return Ok(parvane_protocol::sign::new_op_id());
    }
    let hexs: String = s.chars().filter(|c| *c != '-').collect();
    let b = hex::decode(hexs).map_err(|_| err_proto(ProtoError::InvalidField("op_id")))?;
    if !parvane_protocol::sign::is_valid_op_id(&b) {
        return Err(err_proto(ProtoError::InvalidField("op_id")));
    }
    Ok(b)
}

fn group_id(hex_id: &str) -> Result<Vec<u8>, JsValue> {
    hex::decode(hex_id).map_err(|_| err_proto(ProtoError::InvalidField("group")))
}

/// Клиентское ядро устройства.
#[wasm_bindgen]
pub struct PvClient {
    inner: Client,
    /// Корень после createIdentity/importRootBackup — только в памяти (не в
    /// export): для exportRootBackup, затем forgetRoot (C1-06).
    root: Option<zeroize::Zeroizing<[u8; 32]>>,
}

#[wasm_bindgen]
impl PvClient {
    /// Новое устройство.
    #[wasm_bindgen(constructor)]
    pub fn new(user: &str, device_id: &str, domain: &str) -> Result<PvClient, JsValue> {
        Client::new(user, device_id, domain).map(|inner| PvClient { inner, root: None }).map_err(err_proto)
    }

    /// Восстановить из зашифрованного состояния.
    #[wasm_bindgen(js_name = importState)]
    pub fn import_state(blob: &[u8], key: &[u8]) -> Result<PvClient, JsValue> {
        Client::import(blob, &key32(key)?).map(|inner| PvClient { inner, root: None }).map_err(err_proto)
    }

    /// Экспорт состояния (шифруется ключом хранилища, 32 байта).
    #[wasm_bindgen(js_name = export)]
    pub fn export_state(&self, key: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.export(&key32(key)?).map_err(err_proto)
    }

    /// Импорт Olm-аккаунта v1 (libolm pickle web) — то же устройство.
    #[wasm_bindgen(js_name = importLibolmAccount)]
    pub fn import_libolm_account(&mut self, pickle: &str, pickle_key: &[u8]) -> Result<(), JsValue> {
        let acc = parvane_protocol::olm::OlmAccount::from_libolm_pickle(pickle, pickle_key).map_err(err_proto)?;
        self.inner.import_v1_account(acc);
        Ok(())
    }

    /// Первое устройство: корень, генезис, сертификат, прекеи, ключ доставки.
    /// Возвращает {requests, rootSecret} — корень для резервной копии.
    #[wasm_bindgen(js_name = createIdentity)]
    pub fn create_identity(&mut self, otk_count: usize) -> Result<JsValue, JsValue> {
        let (reqs, root) = self.inner.create_identity(otk_count).map_err(err_proto)?;
        let o = Object::new();
        set(&o, "requests", &reqs_js(&reqs).into());
        set(&o, "rootSecret", &Uint8Array::from(root.root.to_bytes().as_slice()).into());
        self.root = Some(zeroize::Zeroizing::new(root.root.to_bytes()));
        Ok(o.into())
    }

    /// C1-06: резервная копия корня под ключом восстановления (строка из
    /// `generateRecoveryKey()`, ≥ 128 бит; парольной фразы нет). Корень — из
    /// памяти (после createIdentity/importRootBackup) или `rootSecret`.
    /// Возвращает байты копии; после подтверждения копии — `forgetRoot()` и
    /// удалить корень из хранилища хоста.
    #[wasm_bindgen(js_name = exportRootBackup)]
    pub fn export_root_backup(&self, recovery_key: &str, root_secret: Option<Vec<u8>>) -> Result<Vec<u8>, JsValue> {
        let key = parvane_protocol::recovery::RecoveryKey::parse(recovery_key).map_err(err_proto)?;
        let root = match (&root_secret, &self.root) {
            (Some(r), _) => zeroize::Zeroizing::new(key32(r)?),
            (None, Some(r)) => r.clone(),
            (None, None) => return Err(err_proto(ProtoError::NotFound)),
        };
        self.inner.export_root_backup(&root, &key).map_err(err_proto)
    }

    /// Копия корня для администратора сервера: корень — из памяти (после
    /// createIdentity/importRootBackup) или `rootSecret`, запечатывается открытым
    /// ключом администратора (32 байта из `server.describe`).
    #[wasm_bindgen(js_name = exportRootEscrow)]
    pub fn export_root_escrow(&self, escrow_public: &[u8], root_secret: Option<Vec<u8>>) -> Result<Vec<u8>, JsValue> {
        let root = match (&root_secret, &self.root) {
            (Some(r), _) => zeroize::Zeroizing::new(key32(r)?),
            (None, Some(r)) => r.clone(),
            (None, None) => return Err(err_proto(ProtoError::NotFound)),
        };
        self.inner.export_root_escrow(&root, &key32(escrow_public)?).map_err(err_proto)
    }

    /// Восстановить корень из копии (сверяется с журналом устройств); корень
    /// остаётся в памяти до `forgetRoot()` и возвращается хосту.
    #[wasm_bindgen(js_name = importRootBackup)]
    pub fn import_root_backup(&mut self, blob: &[u8], recovery_key: &str) -> Result<Vec<u8>, JsValue> {
        let key = parvane_protocol::recovery::RecoveryKey::parse(recovery_key).map_err(err_proto)?;
        let secret = self.inner.import_root_backup(blob, &key).map_err(err_proto)?;
        let out = secret.to_vec();
        self.root = Some(secret);
        Ok(out)
    }

    /// Стереть корень из памяти движка.
    #[wasm_bindgen(js_name = forgetRoot)]
    pub fn forget_root(&mut self) {
        self.root = None;
    }

    /// Корень в памяти движка есть.
    #[wasm_bindgen(js_name = hasRoot)]
    pub fn has_root(&self) -> bool {
        self.root.is_some()
    }

    /// D-03 (C1-03): версия журнала группы, на которую сослался участник, а у
    /// нас её нет (undefined — не отстаём). Пока отстаём, prepareGroup и
    /// groupRotateEpoch отказывают need groupLog.
    #[wasm_bindgen(js_name = groupBehind)]
    pub fn group_behind(&self, group: &str) -> Result<Option<u64>, JsValue> {
        Ok(self.inner.group_behind(&group_id(group)?))
    }

    /// Материал гранта линковки: JSON {ssk, entries[], deliveryKey, gen} (hex/байты).
    #[wasm_bindgen(js_name = linkGrantMaterial)]
    pub fn link_grant_material(&self) -> Result<Vec<u8>, JsValue> {
        let (ssk, entries, dk, gen) = self.inner.link_grant_material().map_err(err_proto)?;
        let resp = ipb::DeviceLogSyncResponse { entries, more: false, genesis_hash: vec![] };
        let mut m = json!({"ssk": hex::encode(ssk), "log": hex::encode(resp.encode_to_vec()), "dk": hex::encode(dk), "gen": gen});
        // Ключ личного состояния — тем же грантом (формат общий с C ABI, host.rs)
        if let Some((k, v)) = self.inner.state_key() {
            m["sk"] = json!(hex::encode(k.as_bytes()));
            m["skv"] = json!(v);
        }
        m["pk"] = parvane_protocol::host::grant_peer_keys(&self.inner);
        Ok(m.to_string().into_bytes())
    }

    /// Новое устройство после линковки: материал гранта (см. linkGrantMaterial).
    #[wasm_bindgen(js_name = joinWithGrant)]
    pub fn join_with_grant(&mut self, material: &[u8], otk_count: usize) -> Result<Array, JsValue> {
        let v: Value = serde_json::from_slice(material).map_err(|_| err_proto(ProtoError::Malformed))?;
        let h = |k: &str| hex::decode(v[k].as_str().unwrap_or("")).map_err(|_| err_proto(ProtoError::Malformed));
        let log = ipb::DeviceLogSyncResponse::decode(h("log")?.as_slice()).map_err(|_| err_proto(ProtoError::Malformed))?;
        let reqs = self
            .inner
            .join_with_ssk(key32(&h("ssk")?)?, log.entries, key32(&h("dk")?)?, v["gen"].as_u64().unwrap_or(1), otk_count)
            .map_err(err_proto)?;
        if v.get("sk").is_some_and(|s| s.is_string()) {
            let k = parvane_protocol::state::StateKey::from_bytes(&h("sk")?).map_err(|_| err_proto(ProtoError::Malformed))?;
            self.inner.set_state_key(k, v["skv"].as_u64().unwrap_or(1) as u32);
        }
        parvane_protocol::host::apply_grant_peer_keys(&mut self.inner, &v);
        Ok(reqs_js(&reqs))
    }

    #[wasm_bindgen(js_name = otkRequest)]
    pub fn otk_request(&mut self, n: usize) -> JsValue {
        req_js(&self.inner.otk_request(n))
    }

    #[wasm_bindgen(js_name = syncRequest)]
    pub fn sync_request(&self) -> JsValue {
        req_js(&self.inner.sync_request())
    }

    #[wasm_bindgen(js_name = ackRequest)]
    pub fn ack_request(&self) -> JsValue {
        req_js(&self.inner.ack_request())
    }

    /// Курсор журнала (применено до seq включительно).
    #[wasm_bindgen(js_name = cursor)]
    pub fn cursor(&self) -> u64 {
        self.inner.cursor().disk_value()
    }

    #[wasm_bindgen(js_name = logVersion)]
    pub fn log_version(&self, user: &str) -> u64 {
        self.inner.log_version(user)
    }

    /// Устройства пользователя по журналу (JSON `{"v2": [...], "legacy": [...]}`).
    #[wasm_bindgen(js_name = logDevices)]
    pub fn log_devices(&self, user: &str) -> String {
        parvane_protocol::host::log_devices_json(&self.inner, user)
    }

    /// Опубликовать/сократить свой список v1-устройств (FR-058): JSON
    /// `[{"deviceId","identity","signing"}]` → запрос `identity.device.log_append`.
    /// Первая публикация задаёт список, дальше он только сокращается.
    #[wasm_bindgen(js_name = legacyDevicesRequest)]
    pub fn legacy_devices_request(&mut self, devices_json: &str) -> Result<JsValue, JsValue> {
        let devices = parvane_protocol::host::parse_legacy_devices(devices_json).map_err(err_proto)?;
        self.inner.legacy_devices_request(devices).map(|r| req_js(&r)).map_err(err_proto)
    }

    /// Запрос `msg.deliver_legacy` (FR-054): v1 `SendPayload` (JSON) с копиями
    /// для v1-устройств из подписанных списков собеседника и своего.
    #[wasm_bindgen(js_name = legacyDeliverRequest)]
    pub fn legacy_deliver_request(&self, message_id: &str, send_payload_json: &str) -> Result<JsValue, JsValue> {
        self.inner.legacy_deliver_request(message_id, send_payload_json.as_bytes()).map(|r| req_js(&r)).map_err(err_proto)
    }

    /// Ответ `identity.device.log_sync(_anon)` → вердикт "new" | "known" |
    /// "rootChanged" (KEY-1: показать предупреждение и `acceptRootChange`) |
    /// "replaced" (журнал на сервере начат заново — перечитать с версии 0).
    #[wasm_bindgen(js_name = ingestLog)]
    pub fn ingest_log(&mut self, user: &str, sync_response: &[u8]) -> Result<String, JsValue> {
        parvane_protocol::host::ingest_log_verdict(&mut self.inner, user, sync_response).map(str::to_string).map_err(err_proto)
    }

    /// KEY-1 v2: принять смену корня собеседника (после предупреждения).
    #[wasm_bindgen(js_name = acceptRootChange)]
    pub fn accept_root_change(&mut self, user: &str) -> Result<bool, JsValue> {
        self.inner.accept_pending_root(user).map_err(err_proto)
    }

    /// T130: восстановление на новом устройстве по корню (в памяти после
    /// `importRootBackupFor`); `log_response` — ответ `identity.device.log_sync`
    /// с версии 0. Запросы выполнять по порядку.
    #[wasm_bindgen(js_name = recoverWithRoot)]
    pub fn recover_with_root(&mut self, log_response: &[u8], otk_count: usize) -> Result<Array, JsValue> {
        let root = self.root.clone().ok_or_else(|| err_proto(ProtoError::NotFound))?;
        let r: ipb::DeviceLogSyncResponse = decode_checked(log_response, Origin::Server).map_err(err_proto)?;
        self.inner.recover_with_root(&root, r.entries, otk_count).map(|r| reqs_js(&r)).map_err(err_proto)
    }

    /// Корень из копии под ключом восстановления на устройстве БЕЗ журнала
    /// (восстановление): сверка с журналом — в `recoverWithRoot`. Корень
    /// остаётся в памяти до `forgetRoot()`.
    #[wasm_bindgen(js_name = importRootBackupFor)]
    pub fn import_root_backup_for(&mut self, blob: &[u8], recovery_key: &str) -> Result<(), JsValue> {
        let key = parvane_protocol::recovery::RecoveryKey::parse(recovery_key).map_err(err_proto)?;
        let secret = parvane_protocol::recovery::import_root_backup(blob, &self.inner.user, &key).map_err(err_proto)?;
        self.root = Some(secret);
        Ok(())
    }

    /// T130: сброс личности — новый корень взамен прежнего. Как
    /// `createIdentity`; первый запрос — `identity.root.rotate` (нужна свежая
    /// переаутентификация).
    #[wasm_bindgen(js_name = resetIdentity)]
    pub fn reset_identity(&mut self, otk_count: usize) -> Result<JsValue, JsValue> {
        let (reqs, root) = self.inner.reset_identity(otk_count).map_err(err_proto)?;
        let o = Object::new();
        set(&o, "requests", &reqs_js(&reqs).into());
        set(&o, "rootSecret", &Uint8Array::from(root.root.to_bytes().as_slice()).into());
        self.root = Some(zeroize::Zeroizing::new(root.root.to_bytes()));
        Ok(o.into())
    }

    /// Ответ `identity.device.fetch_bundle_anon` → число открытых сессий.
    #[wasm_bindgen(js_name = ingestBundle)]
    pub fn ingest_bundle(&mut self, user: &str, bundle_response: &[u8]) -> Result<usize, JsValue> {
        let r: ipb::DeviceFetchBundleAnonResponse = decode_checked(bundle_response, Origin::Server).map_err(err_proto)?;
        self.inner.ingest_bundle(user, r.devices).map_err(err_proto)
    }

    #[wasm_bindgen(js_name = setPeerDeliveryKey)]
    pub fn set_peer_delivery_key(&mut self, user: &str, key: &[u8], generation: u64) {
        self.inner.set_peer_delivery_key(user, key.to_vec(), generation);
    }

    /// Запрос жетонов: ответ `identity.tokens.key_list` (анонимно) + ключ сервера.
    #[wasm_bindgen(js_name = tokenRequest)]
    pub fn token_request(&mut self, key_list_response: &[u8], server_key: &[u8], count: usize) -> Result<JsValue, JsValue> {
        let r: ipb::TokensKeyListResponse = decode_checked(key_list_response, Origin::Server).map_err(err_proto)?;
        let list = r.list.ok_or_else(|| err_proto(ProtoError::InvalidField("list")))?;
        self.inner.token_request(&list, server_key, count).map(|r| req_js(&r)).map_err(err_proto)
    }

    #[wasm_bindgen(js_name = tokenResponse)]
    pub fn token_response(&mut self, resp: &[u8]) -> Result<usize, JsValue> {
        let r: ipb::TokensIssueBlindedResponse = decode_checked(resp, Origin::Server).map_err(err_proto)?;
        self.inner.token_response(&r).map_err(err_proto)
    }

    #[wasm_bindgen(js_name = tokenCount)]
    pub fn token_count(&self) -> usize {
        self.inner.token_count()
    }

    /// Пора получать суточную партию жетонов (FR-063: по расписанию, не перед
    /// тратой).
    #[wasm_bindgen(js_name = tokenRefillDue)]
    pub fn token_refill_due(&self) -> bool {
        self.inner.token_refill_due(parvane_protocol::time::now_ms())
    }

    /// Размер партии — вся суточная квота.
    #[wasm_bindgen(js_name = tokenBatchSize)]
    pub fn token_batch_size(&self) -> usize {
        self.inner.token_batch_size()
    }

    /// Личное сообщение: содержимое — proto3-JSON `msg.v2.Content`;
    /// `op_id` — UUID сообщения хоста (строка) или пусто.
    #[wasm_bindgen(js_name = prepareDirect)]
    pub fn prepare_direct(&mut self, peer: &str, content_json: &str, op_id: &str) -> Result<Array, JsValue> {
        let c = parse_content(content_json)?;
        let id = op_id_bytes(op_id)?;
        self.inner.prepare_direct_id(peer, &c, id).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Сигнал звонка собеседнику (D-08): `signal_json` — proto3-JSON
    /// `call.v2.CallSignal`; оффер уходит методом `call.ring_sealed`, остальное —
    /// `call.signal_sealed`, оба анонимным каналом.
    #[wasm_bindgen(js_name = prepareCall)]
    pub fn prepare_call(&mut self, peer: &str, signal_json: &str) -> Result<Array, JsValue> {
        let signal: parvane_protocol::pb::parvane::call::v2::CallSignal =
            serde_json::from_str(signal_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.inner.prepare_call(peer, &signal).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): он сменил
    /// ключ (отзыв устройства, восстановление) — дальше слепым жетоном. true —
    /// ключ был и сброшен (отправку стоит повторить).
    #[wasm_bindgen(js_name = deliveryKeyRejected)]
    pub fn delivery_key_rejected(&mut self, peer: &str) -> bool {
        let had = self.inner.has_peer_delivery_key(peer);
        self.inner.on_delivery_key_rejected(peer);
        had
    }

    /// Кто прочитал своё сообщение (по E2E-квитанциям) — JSON-массив
    /// `[{"user","tsMs"}]`. Серверу v2 это неизвестно («Просмотрено», T151).
    #[wasm_bindgen]
    pub fn readers(&self, id: &str) -> Result<String, JsValue> {
        let list: Vec<serde_json::Value> = self.inner.readers(&op_id_bytes(id)?).into_iter().map(|(user, ts)| json!({"user": user, "tsMs": ts})).collect();
        Ok(serde_json::Value::Array(list).to_string())
    }

    /// Известен ли ключ доступа собеседника: сигнал звонка сервер принимает
    /// только с ним (слепой жетон для звонков не годится).
    #[wasm_bindgen(js_name = hasPeerDeliveryKey)]
    pub fn has_peer_delivery_key(&self, peer: &str) -> bool {
        self.inner.has_peer_delivery_key(peer)
    }

    /// Выход: запрос с записью журнала, которой устройство убирает само себя
    /// (подписана ключом устройства — оставшимся смена SSK не нужна).
    #[wasm_bindgen(js_name = leave)]
    pub fn leave(&mut self) -> Result<Array, JsValue> {
        let req = self.inner.leave_request().map_err(err_proto)?;
        Ok(reqs_js(&[req]))
    }

    // ── отзыв своего устройства (T128; D-11, D-12, D-16) ──

    /// Отозвать своё другое устройство и выполнить последствия →
    /// `{requests, pendingKeyShares: [адрес], pendingEpochs: [hex],
    /// epochsNeedAdmin: [hex], sskRotationRequired, stateKeyVersion?}`. Первый
    /// запрос — запись журнала (обязателен), остальные — ротации ключей.
    #[wasm_bindgen(js_name = revokeDevice)]
    pub fn revoke_device(&mut self, device_id: &str) -> Result<JsValue, JsValue> {
        let out = self.inner.revoke_device(device_id).map_err(err_client)?;
        let strings = |items: Vec<String>| -> JsValue { items.iter().map(|s| JsValue::from_str(s)).collect::<Array>().into() };
        let o = Object::new();
        set(&o, "requests", &reqs_js(&out.requests).into());
        set(&o, "pendingKeyShares", &strings(out.pending_key_shares.clone()));
        set(&o, "pendingEpochs", &strings(out.pending_epochs.iter().map(hex::encode).collect()));
        set(&o, "epochsNeedAdmin", &strings(out.epochs_need_admin.iter().map(hex::encode).collect()));
        set(&o, "sskRotationRequired", &JsValue::from_bool(out.ssk_rotation_required));
        if let Some(v) = out.state_key_version {
            set(&o, "stateKeyVersion", &JsValue::from_f64(f64::from(v)));
        }
        Ok(o.into())
    }

    /// Отозвать ключ доступа у собеседника (FR-033; блокировка) →
    /// `{requests, pendingKeyShares: [адрес]}`; пустой `requests` — ключа у
    /// собеседника не было.
    #[wasm_bindgen(js_name = revokeContactAccess)]
    pub fn revoke_contact_access(&mut self, peer: &str) -> Result<JsValue, JsValue> {
        let out = self.inner.revoke_contact_access(peer).map_err(err_client)?;
        let o = Object::new();
        set(&o, "requests", &reqs_js(&out.requests).into());
        let pending: JsValue = out.pending_key_shares.iter().map(|s| JsValue::from_str(s)).collect::<Array>().into();
        set(&o, "pendingKeyShares", &pending);
        Ok(o.into())
    }

    /// Группы v2 — своим новым устройствам (T142): ключи текущей эпохи и
    /// входящие сессии Megolm. `devices_json` — JSON-массив id устройств.
    #[wasm_bindgen(js_name = shareGroupsWithOwnDevices)]
    pub fn share_groups_with_own_devices(&mut self, devices_json: &str) -> Result<Array, JsValue> {
        let devices: Vec<String> = serde_json::from_str(devices_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.share_groups_with_own_devices(&devices).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Секреты своих ссылок-приглашений — другим ведущим приглашения группы:
    /// `links_json`, `recipients_json` — JSON-массивы ссылок и адресов.
    #[wasm_bindgen(js_name = shareInviteLinks)]
    pub fn share_invite_links(&mut self, group_hex: &str, links_json: &str, recipients_json: &str) -> Result<Array, JsValue> {
        let gid = hex::decode(group_hex).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let links: Vec<String> = serde_json::from_str(links_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let to: Vec<String> = serde_json::from_str(recipients_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.share_invite_links(&gid, &links, &to).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Принятые секреты ссылок-приглашений: JSON `[{"group": hex, "url": …}]`.
    #[wasm_bindgen(js_name = takeSharedInvites)]
    pub fn take_shared_invites(&mut self) -> String {
        let list: Vec<_> = self.inner.take_shared_invites().into_iter().map(|(g, url)| serde_json::json!({ "group": hex::encode(g), "url": url })).collect();
        serde_json::Value::Array(list).to_string()
    }

    /// Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
    #[wasm_bindgen(js_name = shareDeliveryKey)]
    pub fn share_delivery_key(&mut self, peer: &str) -> Result<Array, JsValue> {
        self.inner.share_delivery_key(peer).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Сменить SSK корнем (D-12): корень — в памяти после `importRootBackup`;
    /// после успеха хост зовёт `forgetRoot()`.
    #[wasm_bindgen(js_name = rotateSsk)]
    pub fn rotate_ssk(&mut self) -> Result<Array, JsValue> {
        let root = self.root.clone().ok_or_else(|| err_proto(ProtoError::NotFound))?;
        self.inner.rotate_ssk_with_secret(&root).map(|r| reqs_js(&r)).map_err(err_proto)
    }

    /// Свой SSK раскрыт (отозвано державшее его устройство) и ещё не сменён.
    #[wasm_bindgen(js_name = ownSskExposed)]
    pub fn own_ssk_exposed(&self) -> bool {
        self.inner.own_ssk_exposed()
    }

    // ── эфемерные каналы: «печатает» и присутствие (T127) ──

    /// Подписаться на каналы чатов `{"peers":[адрес…],"groups":[hex…]}` →
    /// запросы `ephemeral.subscribe` (только новые каналы).
    #[wasm_bindgen(js_name = ephSubscribe)]
    pub fn eph_subscribe(&mut self, chats_json: &str) -> Result<Array, JsValue> {
        parvane_protocol::host::eph_subscribe_reqs(&mut self.inner, chats_json).map(|r| reqs_js(&r)).map_err(err_proto)
    }

    /// Соединение пересоздано — подписок на эфемерные каналы больше нет.
    #[wasm_bindgen(js_name = ephReset)]
    pub fn eph_reset(&mut self) {
        self.inner.eph_reset();
    }

    /// «Печатает»: `chat` — адрес собеседника либо hex группы, `action` — номер
    /// `TypingAction`. Запросы (пусто — канала нет или чат в L2).
    #[wasm_bindgen(js_name = ephTyping)]
    pub fn eph_typing(&self, chat: &str, action: i32) -> Result<Array, JsValue> {
        parvane_protocol::host::eph_typing_reqs(&self.inner, chat, action).map(|r| reqs_js(&r)).map_err(err_proto)
    }

    /// Своё присутствие → запросы (пусто — L2 активен в каком-то чате).
    #[wasm_bindgen(js_name = ephPresence)]
    pub fn eph_presence(&self, online: bool, last_seen_ms: f64) -> Result<Array, JsValue> {
        let req = self.inner.presence_request(online, last_seen_ms as i64).map_err(err_proto)?;
        Ok(reqs_js(req.as_slice()))
    }

    /// Событие подписки `ephemeral` → JSON-массив событий `typing`/`presence`.
    #[wasm_bindgen(js_name = ephOpen)]
    pub fn eph_open(&self, body: &[u8]) -> String {
        parvane_protocol::host::eph_open_json(&self.inner, body)
    }

    /// Открыть запись журнала инбокса → JSON-массив событий.
    #[wasm_bindgen(js_name = openRecord)]
    pub fn open_record(&mut self, record: &[u8]) -> Result<String, JsValue> {
        self.inner.open_record(record).map(|e| events_js(&e)).map_err(err_client)
    }

    #[wasm_bindgen(js_name = drainReady)]
    pub fn drain_ready(&mut self) -> String {
        events_js(&self.inner.drain_ready())
    }

    #[wasm_bindgen(js_name = lastError)]
    pub fn last_error(&self) -> Option<String> {
        self.inner.last_error.as_ref().map(|e| e.kind().to_string())
    }

    // ── группы ──

    /// Создать группу → {group: {domain, id}, request}.
    #[wasm_bindgen(js_name = groupCreate)]
    pub fn group_create(&mut self, kind: i32, name: &str, members: Vec<String>, perms_json: &str, migrated_from: Option<String>) -> Result<JsValue, JsValue> {
        let perms: gpb::Permissions = serde_json::from_str(perms_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        let kind = gpb::GroupKind::try_from(kind).map_err(|_| err_proto(ProtoError::InvalidField("kind")))?;
        // `migrated_from` — прежний `group_id` группы v1 (T180), обычная группа — без него
        let (g, r) = self.inner.group_create_from(kind, name, &members, perms, migrated_from.as_deref().unwrap_or("")).map_err(err_proto)?;
        let o = Object::new();
        set(&o, "group", &JsValue::from_str(&json!({"domain": g.domain, "id": hex::encode(&g.id)}).to_string()));
        set(&o, "request", &req_js(&r));
        Ok(o.into())
    }

    #[wasm_bindgen(js_name = groupVersion)]
    pub fn group_version(&self, group: &str) -> Result<u64, JsValue> {
        Ok(self.inner.group_version(&group_id(group)?))
    }

    /// Ответ `group.state.sync` → версия после применения.
    #[wasm_bindgen(js_name = groupIngest)]
    pub fn group_ingest(&mut self, domain: &str, group: &str, sync_response: &[u8]) -> Result<u64, JsValue> {
        let r: gpb::StateSyncResponse = decode_checked(sync_response, Origin::Server).map_err(err_proto)?;
        let g = Ref { domain: domain.into(), id: group_id(group)? };
        self.inner.group_ingest_hinted(&g, r.entries, &r.signer_hints).map_err(err_client)
    }

    /// Забыть журнал группы (запись отвергнута сервером — перечитать с начала).
    #[wasm_bindgen(js_name = groupForget)]
    pub fn group_forget(&mut self, group: &str) -> Result<(), JsValue> {
        self.inner.group_forget(&group_id(group)?);
        Ok(())
    }

    /// Группы, журнал которых известен устройству (hex id).
    #[wasm_bindgen(js_name = groupList)]
    pub fn group_list(&self) -> Vec<String> {
        self.inner.group_ids().iter().map(hex::encode).collect()
    }

    /// FR-028 (T080): участники по данным сервера (`claimed`) без
    /// подтверждённой записи журнала + добавленные отвергнутыми записями.
    #[wasm_bindgen(js_name = groupUnconfirmed)]
    pub fn group_unconfirmed(&self, group: &str, claimed: Vec<String>) -> Result<Vec<String>, JsValue> {
        Ok(self.inner.group_unconfirmed(&group_id(group)?, &claimed))
    }

    /// Новая ссылка-приглашение → {request, url} (секрет — только в url).
    #[wasm_bindgen(js_name = groupInviteCreate)]
    pub fn group_invite_create(&mut self, group: &str, title: &str, expires_ms: f64, usage_limit: u32, requires_approval: bool) -> Result<JsValue, JsValue> {
        let (r, parts) = self
            .inner
            .group_invite_create(&group_id(group)?, title, expires_ms as i64, usage_limit, requires_approval)
            .map_err(err_proto)?;
        let o = Object::new();
        set(&o, "request", &req_js(&r));
        set(&o, "url", &JsValue::from_str(&parvane_protocol::invite::format(&parts).map_err(err_proto)?));
        set(&o, "linkId", &JsValue::from_str(&hex::encode(&parts.link_id)));
        Ok(o.into())
    }

    /// Вступить по ссылке v2 (журнал группы уже принят groupIngest) → запрос `group.join`.
    #[wasm_bindgen(js_name = groupJoin)]
    pub fn group_join(&mut self, url: &str) -> Result<JsValue, JsValue> {
        let parvane_protocol::invite::ParsedInvite::V2(parts) = parvane_protocol::invite::parse(url).map_err(err_proto)? else {
            return Err(err_proto(ProtoError::InvalidField("invite")));
        };
        self.inner.group_join(&parts).map(|r| req_js(&r)).map_err(err_proto)
    }

    /// Изменение группы: proto3-JSON `group.v2.GroupChange`.
    #[wasm_bindgen(js_name = groupChange)]
    pub fn group_change(&mut self, group: &str, change_json: &str) -> Result<JsValue, JsValue> {
        let ch: gpb::GroupChange = serde_json::from_str(change_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        let c = ch.change.ok_or_else(|| err_proto(ProtoError::InvalidField("change")))?;
        self.inner.group_change(&group_id(group)?, c).map(|r| req_js(&r)).map_err(err_proto)
    }

    /// Решение по заявке на вступление (одобрение — запись `AddMember`).
    #[wasm_bindgen(js_name = groupRequestDecide)]
    pub fn group_request_decide(&mut self, group: &str, user: &str, approve: bool) -> Result<JsValue, JsValue> {
        self.inner.group_request_decide(&group_id(group)?, user, approve).map(|r| req_js(&r)).map_err(err_proto)
    }

    #[wasm_bindgen(js_name = groupRotateEpoch)]
    pub fn group_rotate_epoch(&mut self, group: &str) -> Result<Array, JsValue> {
        self.inner.group_rotate_epoch(&group_id(group)?).map(|r| reqs_js(&r)).map_err(err_client)
    }

    #[wasm_bindgen(js_name = prepareGroup)]
    pub fn prepare_group(&mut self, group: &str, content_json: &str, op_id: &str) -> Result<Array, JsValue> {
        let c = parse_content(content_json)?;
        let id = op_id_bytes(op_id)?;
        self.inner.prepare_group_id(&group_id(group)?, &c, id).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Состояние группы (JSON: участники, роли, права, эпоха).
    #[wasm_bindgen(js_name = groupInfo)]
    pub fn group_info(&self, group: &str) -> Result<String, JsValue> {
        let s = self.inner.group_state(&group_id(group)?).ok_or_else(|| err_proto(ProtoError::NotFound))?;
        let members: Vec<Value> = s
            .members
            .iter()
            .map(|(u, m)| json!({"user": u, "role": m.role as i32, "mutedUntilMs": m.muted_until_ms, "rights": serde_json::to_value(m.rights).unwrap_or(Value::Null)}))
            .collect();
        Ok(json!({
            "version": s.version, "kind": s.kind as i32, "name": s.name, "about": s.about, "avatarFileId": s.avatar_file_id, "migratedFrom": s.migrated_from,
            "owner": s.owner, "members": members, "banned": s.banned, "epoch": s.epoch, "epochStale": s.epoch_stale,
            "deleted": s.deleted, "defaultPermissions": serde_json::to_value(s.default_permissions).unwrap_or(Value::Null),
            "inviteLinks": s.invite_links.keys().map(hex::encode).collect::<Vec<_>>(),
            // Действующие ссылки с метаданными из журнала (секреты хост хранит сам)
            "invites": s.invites_json(),
            // Число вступивших по каждой ссылке (счёт по журналу группы) — для экрана ссылок
            "inviteUses": s.invite_links.iter().map(|(id, l)| (hex::encode(id), l.uses)).collect::<std::collections::BTreeMap<_, _>>(),
            "l2": s.l2, "l2By": s.l2_by,
        })
        .to_string())
    }

    // ── режим «усиленная приватность» (L2, T079) ──

    /// Включить/выключить L2 в личном чате: запросы как у `prepareDirect`
    /// (операция `ChatMode` собеседнику и своим устройствам); `op_id` — id
    /// служебного сообщения в UI или пусто.
    #[wasm_bindgen(js_name = l2SetDirect)]
    pub fn l2_set_direct(&mut self, peer: &str, enabled: bool, op_id: &str) -> Result<Array, JsValue> {
        let id = op_id_bytes(op_id)?;
        self.inner.l2_set_direct_id(peer, enabled, id).map(|r| reqs_js(&r)).map_err(err_client)
    }

    /// Состояние L2 личного чата: JSON
    /// `{active, mine, enabledBy: [адреса], pad, ephemeralAllowed}`.
    #[wasm_bindgen(js_name = l2Direct)]
    pub fn l2_direct(&self, peer: &str) -> String {
        parvane_protocol::host::l2_view_json(&self.inner.l2_direct(peer))
    }

    /// Состояние L2 группы (тот же JSON): политика журнала группы (меняется
    /// `groupChange` с `{"set_privacy_mode":{"l2":true}}`) + личное предпочтение.
    #[wasm_bindgen(js_name = l2Group)]
    pub fn l2_group(&self, group: &str) -> Result<String, JsValue> {
        Ok(parvane_protocol::host::l2_view_json(&self.inner.l2_group(&group_id(group)?)))
    }

    /// Личное предпочтение L2 в группе (свои исходящие выравниваются).
    #[wasm_bindgen(js_name = l2SetGroupPref)]
    pub fn l2_set_group_pref(&mut self, group: &str, enabled: bool) -> Result<(), JsValue> {
        self.inner.l2_set_group_pref(&group_id(group)?, enabled);
        Ok(())
    }

    /// Публиковать ли своё присутствие: false, пока L2 активен хотя бы в одном чате.
    #[wasm_bindgen(js_name = presenceAllowed)]
    pub fn presence_allowed(&self) -> bool {
        self.inner.presence_allowed()
    }
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

/// Журнал личного состояния устройства (R10, T098): сведение LWW (STATE-1),
/// шифрование записей ключом личного состояния из клиента (ключ не выходит
/// в JS). Курсор — в памяти: при запуске журнал читается с начала.
#[wasm_bindgen]
pub struct PvState {
    user: String,
    device_id: String,
    key: parvane_protocol::state::StateKey,
    state: parvane_protocol::state::PersonalState,
    clock: parvane_protocol::state::LamportClock,
    cursor: u64,
    guard: parvane_protocol::state::SendGuard,
}

fn snapshot_js(s: &parvane_protocol::pb::parvane::state::v1::StateSnapshot) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "{}".into())
}

#[wasm_bindgen]
impl PvClient {
    /// Ключ личного состояния есть (свой или от другого своего устройства).
    #[wasm_bindgen(js_name = hasStateKey)]
    pub fn has_state_key(&self) -> bool {
        self.inner.state_key().is_some()
    }

    /// Первое устройство без ключа личного состояния — создать (версия 1).
    #[wasm_bindgen(js_name = ensureStateKey)]
    pub fn ensure_state_key(&mut self) -> bool {
        if self.inner.state_key().is_some() {
            return false;
        }
        self.inner.set_state_key(parvane_protocol::state::StateKey::generate(), 1);
        true
    }

    /// Сессия журнала личного состояния на текущем ключе (undefined — ключа нет).
    #[wasm_bindgen(js_name = stateSession)]
    pub fn state_session(&self) -> Option<PvState> {
        let (k, _) = self.inner.state_key()?;
        Some(PvState {
            user: self.inner.user.clone(),
            device_id: self.inner.device_id.clone(),
            key: k.clone(),
            state: parvane_protocol::state::PersonalState::new(),
            clock: parvane_protocol::state::LamportClock::default(),
            cursor: 0,
            guard: parvane_protocol::state::SendGuard::new(),
        })
    }
}

#[wasm_bindgen]
impl PvState {
    /// Тело `state.sync` от курсора.
    #[wasm_bindgen(js_name = syncRequest)]
    pub fn sync_request(&self) -> Vec<u8> {
        parvane_protocol::pb::parvane::state::v1::SyncRequest { after_seq: self.cursor, max_bytes: 0 }.encode_to_vec()
    }

    /// Ответ `state.sync` → JSON `{more, applied, rejected}`. Нерасшифрованные
    /// (чужой ключ) и отвергнутые записи пропускаются — одинаково везде.
    pub fn ingest(&mut self, resp: &[u8]) -> Result<String, JsValue> {
        use parvane_protocol::pb::parvane::state::v1::SyncResponse;
        let r: SyncResponse = decode_checked(resp, Origin::Server).map_err(err_proto)?;
        let (mut applied, mut rejected) = (0usize, 0usize);
        for rec in &r.records {
            self.cursor = self.cursor.max(rec.seq);
            match parvane_protocol::state::open_state_record(&self.key, &self.user, rec) {
                Ok(op) if self.state.apply(&op).is_ok() => applied += 1,
                _ => rejected += 1,
            }
        }
        self.clock.observe(self.state.max_lamport());
        Ok(json!({"more": r.more && !r.records.is_empty(), "applied": applied, "rejected": rejected}).to_string())
    }

    /// Сведённое состояние: proto3-JSON `state.v1.StateSnapshot`.
    pub fn snapshot(&self) -> String {
        snapshot_js(&self.state.snapshot())
    }

    /// Хост хочет состояние `desired_json` (StateSnapshot) по видам `kinds`:
    /// операции разницы применяются локально, наружу — тела `state.append`.
    pub fn diff(&mut self, desired_json: &str, kinds: Vec<String>) -> Result<Array, JsValue> {
        let desired: parvane_protocol::pb::parvane::state::v1::StateSnapshot = serde_json::from_str(desired_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        let m = parvane_protocol::state::Managed::from_names(kinds.iter().map(String::as_str));
        let ops = parvane_protocol::state::diff_ops(&self.state.snapshot(), &desired, m);
        self.seal_ops(ops)
    }

    /// Первый запуск: локальные данные (StateSnapshot) → начальные операции.
    pub fn migrate(&mut self, local_json: &str) -> Result<Array, JsValue> {
        let local: parvane_protocol::pb::parvane::state::v1::StateSnapshot = serde_json::from_str(local_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        let ops = parvane_protocol::state::migrate_snapshot(&local, &self.device_id, &mut self.clock, js_sys::Date::now() as i64).map_err(err_proto)?;
        let out = Array::new();
        for op in ops {
            if self.state.apply(&op).is_ok() {
                let r = parvane_protocol::state::seal_op(&self.key, &self.user, &op).map_err(err_proto)?;
                out.push(&Uint8Array::from(r.encode_to_vec().as_slice()).into());
            }
        }
        Ok(out)
    }

    /// Отложенные, которые ЭТО устройство отправляет сейчас (proto3-JSON
    /// `ScheduledMessage[]`); отправлять с op_id отложенного, затем `markSent`.
    #[wasm_bindgen(js_name = claimDue)]
    pub fn claim_due(&mut self, now_ms: f64) -> String {
        let due = self.state.claim_due(now_ms as i64, &mut self.guard);
        serde_json::to_string(&due).unwrap_or_else(|_| "[]".into())
    }

    /// Отметка «отложенное отправлено» (op_id — base64 из снимка).
    #[wasm_bindgen(js_name = markSent)]
    pub fn mark_sent(&mut self, op_id_b64: &str) -> Result<Array, JsValue> {
        let s: parvane_protocol::pb::parvane::state::v1::ScheduledRef =
            serde_json::from_value(json!({ "op_id": op_id_b64 })).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.seal_ops(vec![parvane_protocol::pb::parvane::state::v1::state_op::Op::ScheduledSent(s)])
    }

    /// Запись истории звонков (D-08: сервер её не ведёт): proto3-JSON
    /// `state.v1.CallRecord` → тела `state.append`. LWW по `call_id`.
    #[wasm_bindgen(js_name = callSet)]
    pub fn call_set(&mut self, record_json: &str) -> Result<Array, JsValue> {
        let rec: parvane_protocol::pb::parvane::state::v1::CallRecord =
            serde_json::from_str(record_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.seal_ops(vec![parvane_protocol::pb::parvane::state::v1::state_op::Op::CallSet(rec)])
    }

    /// Ссылка-приглашение группы v2 (T160): proto3-JSON `state.v1.GroupInvite`
    /// → тела `state.append`. LWW по `link_id`.
    #[wasm_bindgen(js_name = groupInviteSet)]
    pub fn group_invite_set(&mut self, invite_json: &str) -> Result<Array, JsValue> {
        let i: parvane_protocol::pb::parvane::state::v1::GroupInvite =
            serde_json::from_str(invite_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.seal_ops(vec![parvane_protocol::pb::parvane::state::v1::state_op::Op::GroupInviteSet(i)])
    }

    /// Ссылка снята (отозвана или удалена): `link_id` — base64.
    #[wasm_bindgen(js_name = groupInviteRemove)]
    pub fn group_invite_remove(&mut self, link_id_b64: &str) -> Result<Array, JsValue> {
        let r: parvane_protocol::pb::parvane::state::v1::GroupInviteRef =
            serde_json::from_value(json!({ "link_id": link_id_b64 })).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.seal_ops(vec![parvane_protocol::pb::parvane::state::v1::state_op::Op::GroupInviteRemove(r)])
    }

    /// Чат очищен «у себя» до момента (T145): proto3-JSON `state.v1.ChatCleared`
    /// → тела `state.append`. Граница по собеседнику только растёт.
    #[wasm_bindgen(js_name = chatCleared)]
    pub fn chat_cleared(&mut self, cleared_json: &str) -> Result<Array, JsValue> {
        let c: parvane_protocol::pb::parvane::state::v1::ChatCleared =
            serde_json::from_str(cleared_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        self.seal_ops(vec![parvane_protocol::pb::parvane::state::v1::state_op::Op::ChatCleared(c)])
    }

    /// Локальный журнал уже отправленных этим устройством (hex; хранит хост).
    #[wasm_bindgen(js_name = sentGuard)]
    pub fn sent_guard(&self) -> Vec<String> {
        self.guard.to_list().iter().map(hex::encode).collect()
    }

    #[wasm_bindgen(js_name = loadSentGuard)]
    pub fn load_sent_guard(&mut self, ids: Vec<String>) {
        let bytes: Vec<Vec<u8>> = ids.iter().filter_map(|h| hex::decode(h).ok()).collect();
        self.guard = parvane_protocol::state::SendGuard::from_list(bytes.iter().map(Vec::as_slice));
    }

    fn seal_ops(&mut self, ops: Vec<parvane_protocol::pb::parvane::state::v1::state_op::Op>) -> Result<Array, JsValue> {
        let out = Array::new();
        let now = js_sys::Date::now() as i64;
        for kind in ops {
            let op = parvane_protocol::state::make_op(&mut self.clock, &self.device_id, now, kind).map_err(err_proto)?;
            if self.state.apply(&op).is_err() {
                continue;
            }
            let r = parvane_protocol::state::seal_op(&self.key, &self.user, &op).map_err(err_proto)?;
            out.push(&Uint8Array::from(r.encode_to_vec().as_slice()).into());
        }
        Ok(out)
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

#[wasm_bindgen(js_name = encodeRequest)]
pub fn encode_request(id: u64, method: &str, body: &[u8], timeout_ms: u32) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Request(Request { id, method: method.into(), body: body.to_vec(), timeout_ms }))
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

/// proto3-JSON → байты сообщения по полному имени типа (тела запросов из JS).
#[wasm_bindgen(js_name = encodeMessage)]
pub fn encode_message(type_name: &str, json: &str) -> Result<Vec<u8>, JsValue> {
    macro_rules! enc {
        ($($name:literal => $t:ty),* $(,)?) => {
            match type_name {
                $($name => {
                    let m: $t = serde_json::from_str(json).map_err(|_| err_proto(ProtoError::Malformed))?;
                    Ok(m.encode_to_vec())
                })*
                _ => Err(err_proto(ProtoError::UnknownMethod)),
            }
        };
    }
    enc! {
        "parvane.identity.v2.SessionIssueRequest" => ipb::SessionIssueRequest,
        "parvane.identity.v2.AccountRegisterRequest" => ipb::AccountRegisterRequest,
        "parvane.identity.v2.AccountConfirmEmailRequest" => ipb::AccountConfirmEmailRequest,
        "parvane.identity.v2.AccountRegisterStatusRequest" => ipb::AccountRegisterStatusRequest,
        "parvane.identity.v2.SessionReauthRequest" => ipb::SessionReauthRequest,
        "parvane.identity.v2.AccountSet2faRequest" => ipb::AccountSet2faRequest,
        "parvane.identity.v2.AccountChangePasswordRequest" => ipb::AccountChangePasswordRequest,
        "parvane.identity.v2.ProfileResolveRequest" => ipb::ProfileResolveRequest,
        "parvane.identity.v2.ProfileSetNameRequest" => ipb::ProfileSetNameRequest,
        "parvane.identity.v2.ProfileSetAvatarRequest" => ipb::ProfileSetAvatarRequest,
        "parvane.identity.v2.DirectorySearchRequest" => ipb::DirectorySearchRequest,
        "parvane.identity.v2.DeviceLogSyncAnonRequest" => ipb::DeviceLogSyncAnonRequest,
        "parvane.identity.v2.DeviceLogSyncRequest" => ipb::DeviceLogSyncRequest,
        "parvane.identity.v2.RootBackupSetRequest" => ipb::RootBackupSetRequest,
        "parvane.identity.v2.DeviceFetchBundleAnonRequest" => ipb::DeviceFetchBundleAnonRequest,
        "parvane.identity.v2.DeviceRevokeRequest" => ipb::DeviceRevokeRequest,
        "parvane.identity.v2.PrivacySetRequest" => ipb::PrivacySetRequest,
        "parvane.identity.v2.PrivacyGetRequest" => ipb::PrivacyGetRequest,
        "parvane.group.v2.StateSyncRequest" => gpb::StateSyncRequest,
        "parvane.group.v2.InviteCheckRequest" => gpb::InviteCheckRequest,
        "parvane.msg.v2.Text" => parvane_protocol::pb::parvane::msg::v2::Text,
        "parvane.msg.v2.Content" => Content,
        "parvane.group.v2.InviteListRequest" => gpb::InviteListRequest,
        "parvane.group.v2.RequestListRequest" => gpb::RequestListRequest,
        "parvane.cloud.v1.UploadChunkRequest" => parvane_protocol::pb::parvane::cloud::v1::UploadChunkRequest,
        "parvane.cloud.v1.UploadCompleteRequest" => parvane_protocol::pb::parvane::cloud::v1::UploadCompleteRequest,
        "parvane.cloud.v1.DownloadRequest" => parvane_protocol::pb::parvane::cloud::v1::DownloadRequest,
        "parvane.cloud.v1.DownloadCapRequest" => parvane_protocol::pb::parvane::cloud::v1::DownloadCapRequest,
        "parvane.preview.v2.LinkRequest" => parvane_protocol::pb::parvane::preview::v2::LinkRequest,
        "parvane.preview.v2.MapTileRequest" => parvane_protocol::pb::parvane::preview::v2::MapTileRequest,
        "parvane.push.v1.RegisterRequest" => parvane_protocol::pb::parvane::push::v1::RegisterRequest,
        "parvane.push.v1.UnregisterRequest" => parvane_protocol::pb::parvane::push::v1::UnregisterRequest,
    }
}

/// Байты ответа → proto3-JSON по полному имени типа.
#[wasm_bindgen(js_name = decodeMessage)]
pub fn decode_message(type_name: &str, bytes: &[u8]) -> Result<String, JsValue> {
    macro_rules! dec {
        ($($name:literal => $t:ty),* $(,)?) => {
            match type_name {
                $($name => {
                    let m: $t = decode_checked(bytes, Origin::Server).map_err(err_proto)?;
                    serde_json::to_string(&m).map_err(|_| err_proto(ProtoError::Malformed))
                })*
                _ => Err(err_proto(ProtoError::UnknownMethod)),
            }
        };
    }
    dec! {
        "parvane.identity.v2.SessionIssueResponse" => ipb::SessionIssueResponse,
        "parvane.identity.v2.AccountRegisterResponse" => ipb::AccountRegisterResponse,
        "parvane.identity.v2.AccountRegisterStatusResponse" => ipb::AccountRegisterStatusResponse,
        "parvane.identity.v2.ServerDescribeResponse" => ipb::ServerDescribeResponse,
        "parvane.identity.v2.SessionReauthResponse" => ipb::SessionReauthResponse,
        "parvane.identity.v2.AccountSet2faResponse" => ipb::AccountSet2faResponse,
        "parvane.identity.v2.ProfileResolveResponse" => ipb::ProfileResolveResponse,
        "parvane.identity.v2.DirectorySearchResponse" => ipb::DirectorySearchResponse,
        "parvane.identity.v2.DeviceListResponse" => ipb::DeviceListResponse,
        "parvane.identity.v2.RootBackupGetResponse" => ipb::RootBackupGetResponse,
        "parvane.identity.v2.PrivacyGetResponse" => ipb::PrivacyGetResponse,
        "parvane.msg.v2.InboxSyncResponse" => parvane_protocol::pb::parvane::msg::v2::InboxSyncResponse,
        "parvane.msg.v2.InboxSubscribeResponse" => parvane_protocol::pb::parvane::msg::v2::InboxSubscribeResponse,
        "parvane.msg.v2.DeliverSealedResponse" => parvane_protocol::pb::parvane::msg::v2::DeliverSealedResponse,
        "parvane.group.v2.InviteCheckResponse" => gpb::InviteCheckResponse,
        "parvane.group.v2.JoinResponse" => gpb::JoinResponse,
        "parvane.msg.v2.Text" => parvane_protocol::pb::parvane::msg::v2::Text,
        "parvane.msg.v2.Content" => Content,
        "parvane.group.v2.InviteListResponse" => gpb::InviteListResponse,
        "parvane.group.v2.RequestListResponse" => gpb::RequestListResponse,
        "parvane.cloud.v1.UploadChunkResponse" => parvane_protocol::pb::parvane::cloud::v1::UploadChunkResponse,
        "parvane.cloud.v1.UploadCompleteResponse" => parvane_protocol::pb::parvane::cloud::v1::UploadCompleteResponse,
        "parvane.cloud.v1.DownloadResponse" => parvane_protocol::pb::parvane::cloud::v1::DownloadResponse,
        "parvane.cloud.v1.DownloadCapResponse" => parvane_protocol::pb::parvane::cloud::v1::DownloadCapResponse,
        "parvane.preview.v2.LinkResponse" => parvane_protocol::pb::parvane::preview::v2::LinkResponse,
        "parvane.preview.v2.MapTileResponse" => parvane_protocol::pb::parvane::preview::v2::MapTileResponse,
        "parvane.push.v1.DescribeResponse" => parvane_protocol::pb::parvane::push::v1::DescribeResponse,
    }
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
