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
        Event::StateKeyRotated { seq, key_version } => json!({"type": "stateKeyRotated", "seq": seq, "keyVersion": key_version}),
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
        let resp = ipb::DeviceLogSyncResponse { entries, more: false };
        let mut m = json!({"ssk": hex::encode(ssk), "log": hex::encode(resp.encode_to_vec()), "dk": hex::encode(dk), "gen": gen});
        // Ключ личного состояния — тем же грантом (формат общий с C ABI, host.rs)
        if let Some((k, v)) = self.inner.state_key() {
            m["sk"] = json!(hex::encode(k.as_bytes()));
            m["skv"] = json!(v);
        }
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
        let (v2, legacy) = self.inner.log_devices(user);
        json!({ "v2": v2, "legacy": legacy }).to_string()
    }

    /// Ответ `identity.device.log_sync(_anon)` → вердикт "new" | "known" | "rootChanged".
    #[wasm_bindgen(js_name = ingestLog)]
    pub fn ingest_log(&mut self, user: &str, sync_response: &[u8]) -> Result<String, JsValue> {
        let r: ipb::DeviceLogSyncAnonResponse = decode_checked(sync_response, Origin::Server).map_err(err_proto)?;
        let v = self.inner.ingest_log(user, r.entries).map_err(err_proto)?;
        Ok(match v {
            LogVerdict::New => "new",
            LogVerdict::Known => "known",
            LogVerdict::RootChanged => "rootChanged",
        }
        .into())
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

    /// Личное сообщение: содержимое — proto3-JSON `msg.v2.Content`;
    /// `op_id` — UUID сообщения хоста (строка) или пусто.
    #[wasm_bindgen(js_name = prepareDirect)]
    pub fn prepare_direct(&mut self, peer: &str, content_json: &str, op_id: &str) -> Result<Array, JsValue> {
        let c = parse_content(content_json)?;
        let id = op_id_bytes(op_id)?;
        self.inner.prepare_direct_id(peer, &c, id).map(|r| reqs_js(&r)).map_err(err_client)
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
    pub fn group_create(&mut self, kind: i32, name: &str, members: Vec<String>, perms_json: &str) -> Result<JsValue, JsValue> {
        let perms: gpb::Permissions = serde_json::from_str(perms_json).map_err(|_| err_proto(ProtoError::Malformed))?;
        let kind = gpb::GroupKind::try_from(kind).map_err(|_| err_proto(ProtoError::InvalidField("kind")))?;
        let (g, r) = self.inner.group_create(kind, name, &members, perms).map_err(err_proto)?;
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
            "version": s.version, "kind": s.kind as i32, "name": s.name, "about": s.about, "avatarFileId": s.avatar_file_id,
            "owner": s.owner, "members": members, "banned": s.banned, "epoch": s.epoch, "epochStale": s.epoch_stale,
            "deleted": s.deleted, "defaultPermissions": serde_json::to_value(s.default_permissions).unwrap_or(Value::Null),
            "inviteLinks": s.invite_links.keys().map(hex::encode).collect::<Vec<_>>(),
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
        "parvane.identity.v2.DeviceFetchBundleAnonRequest" => ipb::DeviceFetchBundleAnonRequest,
        "parvane.identity.v2.DeviceRevokeRequest" => ipb::DeviceRevokeRequest,
        "parvane.identity.v2.PrivacySetRequest" => ipb::PrivacySetRequest,
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
