//! Хост-API клиентского ядра для нативных обвязок (C ABI: desktop
//! parvane-core, android jni). Всё на границе — JSON-строки и байты: запросы
//! `{"chan","method","body"(base64)}`, события — как у WASM-обвязки, ошибки —
//! `{"need":{...}}` / `{"error":"<вид>"}`. Разбор протокола на стороне C++/
//! Kotlin не нужен (класс 10).

use base64::Engine as _;
use prost::Message;
use serde_json::{json, Value};

use crate::client::{Chan, Client, ClientError, Event, L2View, LogVerdict, Need, OutRequest};
use crate::codec::{self, decode_checked};
use crate::error::ProtoError;
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{frame, response, Auth, Channel, ClientInfo, ErrorCode, Frame, Hello, Ping, Ref, Request};
use crate::pb::parvane::group::v2 as gpb;
use crate::pb::parvane::identity::v2 as ipb;
use crate::pb::parvane::msg::v2::{Content, InboxSyncResponse};
use crate::unknown::Disposition;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn unb64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| err(ProtoError::Malformed))
}

pub fn err(e: ProtoError) -> String {
    json!({"error": e.kind()}).to_string()
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

fn cerr(e: ClientError) -> String {
    match e {
        ClientError::Need(n) => json!({"need": need_json(&n)}).to_string(),
        ClientError::Proto(p) => err(p),
    }
}

fn req_json(r: &OutRequest) -> Value {
    json!({"chan": match r.chan { Chan::Id => "id", Chan::Anon => "anon" }, "method": r.method, "body": b64(&r.body)})
}

fn reqs_json(rs: &[OutRequest]) -> String {
    Value::Array(rs.iter().map(req_json).collect()).to_string()
}

/// Устройства пользователя по проверенному журналу: `v2` — id устройств v2,
/// `legacy` — id подписанного списка v1-устройств, `legacySet` — список
/// публиковался, `legacyKeys` — его ключи (base64 без дополнения, как в Olm):
/// легаси-копию шлют только устройству с ТЕМ ЖЕ identity-ключом (FR-058).
/// `root` — корневой ключ личности (base64 без дополнения; нет журнала — поля
/// нет): клиенты выводят из этой строки «ключ безопасности» собеседника на v2.
pub fn log_devices_json(c: &Client, user: &str) -> String {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use base64::Engine as _;
    let (v2, legacy) = c.log_devices(user);
    let set = c.legacy_devices(user);
    let keys: Vec<Value> = set
        .iter()
        .flatten()
        .map(|d| json!({"deviceId": d.device_id, "identity": STANDARD_NO_PAD.encode(&d.olm_curve25519), "signing": STANDARD_NO_PAD.encode(&d.olm_ed25519)}))
        .collect();
    let mut out = json!({ "v2": v2, "legacy": legacy, "legacySet": set.is_some(), "legacyKeys": keys });
    if let Some(root) = c.log_root_key(user) {
        out["root"] = json!(STANDARD_NO_PAD.encode(root));
    }
    out.to_string()
}

/// JSON `[{"deviceId","identity","signing"}]` (ключи — base64, с дополнением или
/// без) → список v1-устройств для записи журнала.
pub fn parse_legacy_devices(devices_json: &str) -> Result<Vec<crate::pb::parvane::core::v2::LegacyDevice>, ProtoError> {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use base64::Engine as _;
    let list: Vec<Value> = serde_json::from_str(devices_json).map_err(|_| ProtoError::Malformed)?;
    let key = |v: &Value, k: &str| -> Result<Vec<u8>, ProtoError> {
        let raw = STANDARD_NO_PAD.decode(v[k].as_str().unwrap_or("").trim_end_matches('=')).map_err(|_| ProtoError::InvalidField("legacy_key"))?;
        if raw.len() != 32 {
            return Err(ProtoError::InvalidField("legacy_key"));
        }
        Ok(raw)
    };
    list.iter()
        .map(|v| {
            let device_id = v["deviceId"].as_str().unwrap_or("").to_string();
            if !crate::address::is_valid_device_id(&device_id) {
                return Err(ProtoError::InvalidField("device_id"));
            }
            Ok(crate::pb::parvane::core::v2::LegacyDevice { device_id, olm_curve25519: key(v, "identity")?, olm_ed25519: key(v, "signing")? })
        })
        .collect()
}

fn uuid_str(b: &[u8]) -> String {
    let h = hex::encode(b);
    if h.len() != 32 {
        return h;
    }
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn disp(d: Disposition) -> &'static str {
    match d {
        Disposition::Show => "show",
        Disposition::Stub => "stub",
        Disposition::Skip => "skip",
    }
}

fn event_json(e: &Event) -> Value {
    let content = |c: &Content| serde_json::to_value(c).unwrap_or(Value::Null);
    match e {
        Event::Direct { seq, chat, from, device, op_id, ts_ms, content: c, disposition } => json!({
            "type": "direct", "seq": seq, "chat": chat, "from": from, "device": device,
            "opId": uuid_str(op_id), "tsMs": ts_ms, "content": content(c), "disposition": disp(*disposition)
        }),
        Event::Group { seq, group, from, device, op_id, ts_ms, content: c, disposition } => json!({
            "type": "group", "seq": seq, "group": {"domain": group.domain, "id": hex::encode(&group.id)}, "from": from,
            "device": device, "opId": uuid_str(op_id), "tsMs": ts_ms, "content": content(c), "disposition": disp(*disposition)
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
        Event::PlannerChanged { seq, head_seq } => json!({"type": "plannerChanged", "seq": seq, "headSeq": head_seq}),
        Event::Typing { .. } | Event::Presence { .. } => eph_event_json(e),
        Event::Internal { seq } => json!({"type": "internal", "seq": seq}),
        Event::Skipped { seq } => json!({"type": "skipped", "seq": seq}),
    }
}

/// Разбор ответа синка журнала устройств (общий для C ABI и WASM, T129).
pub fn ingest_log_verdict(c: &mut Client, user: &str, resp: &[u8]) -> Result<&'static str, ProtoError> {
    let r: ipb::DeviceLogSyncAnonResponse = decode_checked(resp, Origin::Server)?;
    Ok(match c.ingest_log_sync(user, r.entries, &r.genesis_hash)? {
        LogVerdict::New => "new",
        LogVerdict::Known => "known",
        LogVerdict::RootChanged => "rootChanged",
        LogVerdict::Replaced => "replaced",
    })
}

/// Итог отзыва устройства (T128) — JSON для обвязок (тела запросов — base64).
pub fn revocation_json(o: &crate::client::RevocationOutcome) -> String {
    json!({
        "requests": Value::Array(o.requests.iter().map(req_json).collect()),
        "pendingKeyShares": o.pending_key_shares,
        "pendingEpochs": o.pending_epochs.iter().map(hex::encode).collect::<Vec<_>>(),
        "epochsNeedAdmin": o.epochs_need_admin.iter().map(hex::encode).collect::<Vec<_>>(),
        "sskRotationRequired": o.ssk_rotation_required,
        "stateKeyVersion": o.state_key_version,
    })
    .to_string()
}

// ── эфемерные каналы (T127): общий JSON-API для C ABI и WASM ────────────────

/// События эфемерных каналов: `{"type":"typing","chat","group":hex|null,
/// "from","action":<TypingAction>,"tsMs"}` и `{"type":"presence","from",
/// "online","lastSeenMs","tsMs"}`.
pub fn eph_event_json(e: &Event) -> Value {
    match e {
        Event::Typing { chat, group, from, action, ts_ms } => json!({
            "type": "typing", "chat": chat, "group": group.as_ref().map(hex::encode), "from": from, "action": action, "tsMs": ts_ms
        }),
        Event::Presence { from, online, last_seen_ms, ts_ms } => {
            json!({"type": "presence", "from": from, "online": online, "lastSeenMs": last_seen_ms, "tsMs": ts_ms})
        }
        _ => Value::Null,
    }
}

/// Подписка на каналы чатов: `{"peers":[адрес…],"groups":[hex…]}` → массив
/// запросов `ephemeral.subscribe` (только новые каналы).
pub fn eph_subscribe_json(c: &mut Client, chats_json: &str) -> Result<String, ProtoError> {
    eph_subscribe_reqs(c, chats_json).map(|r| reqs_json(&r))
}

/// То же, запросами (для WASM-обвязки: тела — байтами).
pub fn eph_subscribe_reqs(c: &mut Client, chats_json: &str) -> Result<Vec<OutRequest>, ProtoError> {
    let v: Value = serde_json::from_str(chats_json).map_err(|_| ProtoError::Malformed)?;
    let strings = |k: &str| -> Vec<String> { v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    let groups: Vec<Vec<u8>> = strings("groups").iter().filter_map(|h| hex::decode(h).ok()).collect();
    Ok(c.eph_subscribe(&strings("peers"), &groups))
}

/// «Печатает»: `chat` — адрес собеседника либо hex группы; `action` — номер
/// `TypingAction`. Массив запросов (пустой — канала нет или чат в L2).
pub fn eph_typing_json(c: &Client, chat: &str, action: i32) -> Result<String, ProtoError> {
    eph_typing_reqs(c, chat, action).map(|r| reqs_json(&r))
}

/// То же, запросами (для WASM-обвязки).
pub fn eph_typing_reqs(c: &Client, chat: &str, action: i32) -> Result<Vec<OutRequest>, ProtoError> {
    let action = crate::pb::parvane::msg::v2::TypingAction::try_from(action).map_err(|_| ProtoError::InvalidField("action"))?;
    let req = if chat.contains('@') {
        c.typing_request(chat, action)?
    } else {
        let gid = hex::decode(chat).map_err(|_| ProtoError::InvalidField("group"))?;
        c.group_typing_request(&gid, action)?
    };
    Ok(req.into_iter().collect())
}

/// Своё присутствие. Массив запросов (пустой — пока L2 активен хоть в одном чате).
pub fn eph_presence_json(c: &Client, online: bool, last_seen_ms: i64) -> Result<String, ProtoError> {
    Ok(reqs_json(c.presence_request(online, last_seen_ms)?.as_slice()))
}

/// Событие подписки `ephemeral` → массив событий (пустой — не для показа).
pub fn eph_open_json(c: &Client, body: &[u8]) -> String {
    Value::Array(c.open_ephemeral(body).iter().map(eph_event_json).collect()).to_string()
}

fn events(ev: &[Event]) -> String {
    Value::Array(ev.iter().map(event_json).collect()).to_string()
}

/// Состояние L2 чата → `{"active","mine","enabledBy","pad","ephemeralAllowed"}`.
pub fn l2_view_json(v: &L2View) -> String {
    json!({"active": v.active, "mine": v.mine, "enabledBy": v.enabled_by, "pad": v.pad, "ephemeralAllowed": v.ephemeral_allowed}).to_string()
}

/// Поле `pk` материала гранта линковки: ключи доступа собеседников старого
/// устройства `[{"u": адрес, "k": hex, "g": поколение}]` (общее для C ABI и WASM).
pub fn grant_peer_keys(c: &Client) -> Value {
    Value::Array(c.peer_delivery_keys().into_iter().map(|(u, k, g)| json!({"u": u, "k": hex::encode(k), "g": g})).collect())
}

/// Принять `pk` материала гранта (нет поля — грант прежней версии).
pub fn apply_grant_peer_keys(c: &mut Client, material: &Value) {
    for p in material.get("pk").and_then(Value::as_array).into_iter().flatten() {
        let (Some(u), Some(k)) = (p["u"].as_str(), p["k"].as_str().and_then(|k| hex::decode(k).ok())) else { continue };
        if crate::address::is_valid_address(u) {
            c.set_peer_delivery_key(u, k, p["g"].as_u64().unwrap_or(1));
        }
    }
}

fn op_id(s: &str) -> Result<Vec<u8>, String> {
    if s.is_empty() {
        return Ok(crate::sign::new_op_id());
    }
    let h: String = s.chars().filter(|c| *c != '-').collect();
    let b = hex::decode(h).map_err(|_| err(ProtoError::InvalidField("op_id")))?;
    if !crate::sign::is_valid_op_id(&b) {
        return Err(err(ProtoError::InvalidField("op_id")));
    }
    Ok(b)
}

fn key32(b: &[u8]) -> Result<[u8; 32], String> {
    b.try_into().map_err(|_| err(ProtoError::InvalidField("key")))
}

/// Обёртка клиента для нативных хостов.
pub struct HostClient {
    pub inner: Client,
}

impl HostClient {
    pub fn new(user: &str, device: &str, domain: &str) -> Result<Self, String> {
        Client::new(user, device, domain).map(|inner| Self { inner }).map_err(err)
    }

    pub fn import(blob: &[u8], key: &[u8]) -> Result<Self, String> {
        Client::import(blob, &key32(key)?).map(|inner| Self { inner }).map_err(err)
    }

    pub fn export(&self, key: &[u8]) -> Result<Vec<u8>, String> {
        self.inner.export(&key32(key)?).map_err(err)
    }

    /// Импорт Olm-аккаунта v1 (JSON-pickle parvane-e2e) — то же устройство.
    pub fn import_v1_account_json(&mut self, pickle_json: &str) -> Result<(), String> {
        let acc = crate::olm::OlmAccount::from_parvane_e2e_json(pickle_json).map_err(err)?;
        self.inner.import_v1_account(acc);
        Ok(())
    }

    pub fn create_identity(&mut self, otk: usize) -> Result<String, String> {
        let (reqs, root) = self.inner.create_identity(otk).map_err(err)?;
        Ok(json!({"requests": serde_json::from_str::<Value>(&reqs_json(&reqs)).unwrap_or(Value::Null), "rootSecret": b64(&root.root.to_bytes())}).to_string())
    }

    /// C1-06: резервная копия корня (`root_secret` — 32 байта из
    /// create_identity) под ключом восстановления из [`generate_recovery_key`].
    pub fn export_root_backup(&self, root_secret: &[u8], recovery_key: &str) -> Result<Vec<u8>, String> {
        let key = crate::recovery::RecoveryKey::parse(recovery_key).map_err(err)?;
        let root = zeroize::Zeroizing::new(key32(root_secret)?);
        self.inner.export_root_backup(&root, &key).map_err(err)
    }

    /// Копия корня для администратора сервера (`escrow_public` — 32 байта из
    /// `server.describe`): страховка на случай потери устройств и ключа восстановления.
    pub fn export_root_escrow(&self, root_secret: &[u8], escrow_public: &[u8]) -> Result<Vec<u8>, String> {
        let root = zeroize::Zeroizing::new(key32(root_secret)?);
        self.inner.export_root_escrow(&root, &key32(escrow_public)?).map_err(err)
    }

    /// Корень из копии (сверен с журналом устройств).
    pub fn import_root_backup(&self, blob: &[u8], recovery_key: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
        let key = crate::recovery::RecoveryKey::parse(recovery_key).map_err(err)?;
        self.inner.import_root_backup(blob, &key).map_err(err)
    }

    /// D-03: версия журнала группы, от которой отстаём (None — не отстаём).
    pub fn group_behind(&self, group_hex: &str) -> Result<Option<u64>, String> {
        let id = hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))?;
        Ok(self.inner.group_behind(&id))
    }

    pub fn link_grant_material(&self) -> Result<String, String> {
        let (ssk, entries, dk, gen) = self.inner.link_grant_material().map_err(err)?;
        let log = ipb::DeviceLogSyncResponse { entries, more: false, genesis_hash: vec![] };
        let mut m = json!({"ssk": hex::encode(ssk), "log": hex::encode(log.encode_to_vec()), "dk": hex::encode(dk), "gen": gen});
        // Ключ личного состояния — тем же грантом (R: «передаётся при линковке»)
        if let Some((k, v)) = self.inner.state_key() {
            m["sk"] = json!(hex::encode(k.as_bytes()));
            m["skv"] = json!(v);
        }
        m["pk"] = grant_peer_keys(&self.inner);
        Ok(m.to_string())
    }

    pub fn join_with_grant(&mut self, material: &str, otk: usize) -> Result<String, String> {
        let v: Value = serde_json::from_str(material).map_err(|_| err(ProtoError::Malformed))?;
        let h = |k: &str| hex::decode(v[k].as_str().unwrap_or("")).map_err(|_| err(ProtoError::Malformed));
        let log = ipb::DeviceLogSyncResponse::decode(h("log")?.as_slice()).map_err(|_| err(ProtoError::Malformed))?;
        let reqs = self
            .inner
            .join_with_ssk(key32(&h("ssk")?)?, log.entries, key32(&h("dk")?)?, v["gen"].as_u64().unwrap_or(1), otk)
            .map_err(err)?;
        if v.get("sk").is_some_and(|s| s.is_string()) {
            let k = crate::state::StateKey::from_bytes(&h("sk")?).map_err(|_| err(ProtoError::Malformed))?;
            self.inner.set_state_key(k, v["skv"].as_u64().unwrap_or(1) as u32);
        }
        apply_grant_peer_keys(&mut self.inner, &v);
        Ok(reqs_json(&reqs))
    }

    pub fn otk_request(&mut self, n: usize) -> String {
        req_json(&self.inner.otk_request(n)).to_string()
    }

    pub fn sync_request(&self) -> String {
        req_json(&self.inner.sync_request()).to_string()
    }

    pub fn ack_request(&self) -> String {
        req_json(&self.inner.ack_request()).to_string()
    }

    pub fn log_version(&self, user: &str) -> u64 {
        self.inner.log_version(user)
    }

    /// Ответ `identity.device.log_sync(_anon)` → "new" | "known" |
    /// "rootChanged" (KEY-1: показать предупреждение и `accept_root_change`) |
    /// "replaced" (журнал на сервере начат заново — перечитать с версии 0).
    pub fn ingest_log(&mut self, user: &str, resp: &[u8]) -> Result<String, String> {
        ingest_log_verdict(&mut self.inner, user, resp).map(str::to_string).map_err(err)
    }

    /// KEY-1 v2: принять смену корня собеседника (после предупреждения).
    pub fn accept_root_change(&mut self, user: &str) -> Result<bool, String> {
        self.inner.accept_pending_root(user).map_err(err)
    }

    /// T130: восстановление на новом устройстве по корню (32 байта из копии под
    /// ключом восстановления); `log_resp` — ответ `identity.device.log_sync`
    /// с версии 0. JSON-массив запросов.
    pub fn recover_with_root(&mut self, root_secret: &[u8], log_resp: &[u8], otk: usize) -> Result<String, String> {
        let root = zeroize::Zeroizing::new(key32(root_secret)?);
        let r: ipb::DeviceLogSyncResponse = decode_checked(log_resp, Origin::Server).map_err(err)?;
        self.inner.recover_with_root(&root, r.entries, otk).map(|r| reqs_json(&r)).map_err(err)
    }

    /// T130: сброс личности (новый корень взамен прежнего) → как
    /// `create_identity`; первый запрос — `identity.root.rotate`.
    pub fn reset_identity(&mut self, otk: usize) -> Result<String, String> {
        let (reqs, root) = self.inner.reset_identity(otk).map_err(err)?;
        Ok(json!({"requests": serde_json::from_str::<Value>(&reqs_json(&reqs)).unwrap_or(Value::Null), "rootSecret": b64(&root.root.to_bytes())}).to_string())
    }

    pub fn ingest_bundle(&mut self, user: &str, resp: &[u8]) -> Result<usize, String> {
        let r: ipb::DeviceFetchBundleAnonResponse = decode_checked(resp, Origin::Server).map_err(err)?;
        self.inner.ingest_bundle(user, r.devices).map_err(err)
    }

    pub fn set_peer_delivery_key(&mut self, user: &str, key: &[u8], generation: u64) {
        self.inner.set_peer_delivery_key(user, key.to_vec(), generation);
    }

    pub fn token_request(&mut self, key_list_resp: &[u8], server_key: &[u8], count: usize) -> Result<String, String> {
        let r: ipb::TokensKeyListResponse = decode_checked(key_list_resp, Origin::Server).map_err(err)?;
        let list = r.list.ok_or_else(|| err(ProtoError::InvalidField("list")))?;
        self.inner.token_request(&list, server_key, count).map(|r| req_json(&r).to_string()).map_err(err)
    }

    pub fn token_response(&mut self, resp: &[u8]) -> Result<usize, String> {
        let r: ipb::TokensIssueBlindedResponse = decode_checked(resp, Origin::Server).map_err(err)?;
        self.inner.token_response(&r).map_err(err)
    }

    pub fn prepare_direct(&mut self, peer: &str, content_json: &str, id: &str) -> Result<String, String> {
        let c: Content = serde_json::from_str(content_json).map_err(|_| err(ProtoError::Malformed))?;
        self.inner.prepare_direct_id(peer, &c, op_id(id)?).map(|r| reqs_json(&r)).map_err(cerr)
    }

    /// Сигнал звонка: proto3-JSON `parvane.call.v2.CallSignal` → запросы.
    pub fn prepare_call(&mut self, peer: &str, signal_json: &str) -> Result<String, String> {
        let signal: crate::pb::parvane::call::v2::CallSignal = serde_json::from_str(signal_json).map_err(|_| err(ProtoError::Malformed))?;
        self.inner.prepare_call(peer, &signal).map(|r| reqs_json(&r)).map_err(cerr)
    }

    pub fn eph_subscribe(&mut self, chats_json: &str) -> Result<String, String> {
        eph_subscribe_json(&mut self.inner, chats_json).map_err(err)
    }

    pub fn eph_reset(&mut self) {
        self.inner.eph_reset();
    }

    pub fn eph_typing(&self, chat: &str, action: i32) -> Result<String, String> {
        eph_typing_json(&self.inner, chat, action).map_err(err)
    }

    pub fn eph_presence(&self, online: bool, last_seen_ms: i64) -> Result<String, String> {
        eph_presence_json(&self.inner, online, last_seen_ms).map_err(err)
    }

    pub fn eph_open(&self, body: &[u8]) -> String {
        eph_open_json(&self.inner, body)
    }

    pub fn open_record(&mut self, record: &[u8]) -> Result<String, String> {
        self.inner.open_record(record).map(|e| events(&e)).map_err(cerr)
    }

    pub fn drain_ready(&mut self) -> String {
        events(&self.inner.drain_ready())
    }

    pub fn last_error(&self) -> Option<&'static str> {
        self.inner.last_error.as_ref().map(ProtoError::kind)
    }

    pub fn group_create(&mut self, kind: i32, name: &str, members_json: &str, perms_json: &str) -> Result<String, String> {
        self.group_create_from(kind, name, members_json, perms_json, "")
    }

    /// Группа, переводимая из v1 (T180): `migrated_from` — прежний `group_id`.
    pub fn group_create_from(&mut self, kind: i32, name: &str, members_json: &str, perms_json: &str, migrated_from: &str) -> Result<String, String> {
        let members: Vec<String> = serde_json::from_str(members_json).map_err(|_| err(ProtoError::Malformed))?;
        let perms: gpb::Permissions = serde_json::from_str(perms_json).map_err(|_| err(ProtoError::Malformed))?;
        let kind = gpb::GroupKind::try_from(kind).map_err(|_| err(ProtoError::InvalidField("kind")))?;
        let (g, r) = self.inner.group_create_from(kind, name, &members, perms, migrated_from).map_err(err)?;
        Ok(json!({"group": {"domain": g.domain, "id": hex::encode(&g.id)}, "request": req_json(&r)}).to_string())
    }

    pub fn group_ingest(&mut self, domain: &str, group_hex: &str, resp: &[u8]) -> Result<u64, String> {
        let r: gpb::StateSyncResponse = decode_checked(resp, Origin::Server).map_err(err)?;
        let id = hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))?;
        self.inner.group_ingest_hinted(&Ref { domain: domain.into(), id }, r.entries, &r.signer_hints).map_err(cerr)
    }

    pub fn group_change(&mut self, group_hex: &str, change_json: &str) -> Result<String, String> {
        let ch: gpb::GroupChange = serde_json::from_str(change_json).map_err(|_| err(ProtoError::Malformed))?;
        let c = ch.change.ok_or_else(|| err(ProtoError::InvalidField("change")))?;
        let id = hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))?;
        self.inner.group_change(&id, c).map(|r| req_json(&r).to_string()).map_err(err)
    }

    /// Решение по заявке на вступление: запрос `group.request.decide`.
    pub fn group_request_decide(&mut self, group_hex: &str, user: &str, approve: bool) -> Result<String, String> {
        self.inner.group_request_decide(&group_id(group_hex)?, user, approve).map(|r| req_json(&r).to_string()).map_err(err)
    }

    pub fn group_rotate_epoch(&mut self, group_hex: &str) -> Result<String, String> {
        let id = hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))?;
        self.inner.group_rotate_epoch(&id).map(|r| reqs_json(&r)).map_err(cerr)
    }

    pub fn prepare_group(&mut self, group_hex: &str, content_json: &str, id: &str) -> Result<String, String> {
        let c: Content = serde_json::from_str(content_json).map_err(|_| err(ProtoError::Malformed))?;
        let gid = hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))?;
        self.inner.prepare_group_id(&gid, &c, op_id(id)?).map(|r| reqs_json(&r)).map_err(cerr)
    }

    // ── группы: чтение журнала, ссылки (как WASM-обвязка) ──

    pub fn group_version(&self, group_hex: &str) -> Result<u64, String> {
        Ok(self.inner.group_version(&group_id(group_hex)?))
    }

    /// Забыть журнал группы (локальная запись отвергнута сервером).
    pub fn group_forget(&mut self, group_hex: &str) -> Result<(), String> {
        self.inner.group_forget(&group_id(group_hex)?);
        Ok(())
    }

    /// Группы, журнал которых известен устройству — JSON-массив hex id.
    pub fn group_list(&self) -> String {
        Value::Array(self.inner.group_ids().iter().map(|g| Value::String(hex::encode(g))).collect()).to_string()
    }

    /// FR-028 (T080): участники по данным сервера (`claimed_json` — массив
    /// адресов) без подтверждённой записи журнала → JSON-массив адресов.
    pub fn group_unconfirmed(&self, group_hex: &str, claimed_json: &str) -> Result<String, String> {
        let claimed: Vec<String> = if claimed_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(claimed_json).map_err(|_| err(ProtoError::Malformed))?
        };
        Ok(json!(self.inner.group_unconfirmed(&group_id(group_hex)?, &claimed)).to_string())
    }

    /// Сведения группы по журналу (тот же JSON, что `groupInfo` WASM).
    pub fn group_info(&self, group_hex: &str) -> Result<String, String> {
        let s = self.inner.group_state(&group_id(group_hex)?).ok_or_else(|| err(ProtoError::NotFound))?;
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

    /// Включить/выключить L2 в личном чате → запросы (как `prepare_direct`);
    /// `id` — id служебного сообщения в UI (пусто — новый).
    pub fn l2_set_direct(&mut self, peer: &str, enabled: bool, id: &str) -> Result<String, String> {
        self.inner.l2_set_direct_id(peer, enabled, op_id(id)?).map(|r| reqs_json(&r)).map_err(cerr)
    }

    /// Состояние L2 личного чата (см. [`l2_view_json`]).
    pub fn l2_direct(&self, peer: &str) -> String {
        l2_view_json(&self.inner.l2_direct(peer))
    }

    /// Состояние L2 группы: политика журнала + личное предпочтение.
    pub fn l2_group(&self, group_hex: &str) -> Result<String, String> {
        Ok(l2_view_json(&self.inner.l2_group(&group_id(group_hex)?)))
    }

    /// Личное предпочтение L2 в группе (свои исходящие выравниваются).
    pub fn l2_set_group_pref(&mut self, group_hex: &str, enabled: bool) -> Result<(), String> {
        self.inner.l2_set_group_pref(&group_id(group_hex)?, enabled);
        Ok(())
    }

    /// Чаты с активным L2 → `{"direct":[адреса],"groups":[hex id]}`.
    pub fn l2_active_chats(&self) -> String {
        let (direct, groups) = self.inner.l2_active_chats();
        json!({"direct": direct, "groups": groups.iter().map(hex::encode).collect::<Vec<_>>()}).to_string()
    }

    /// Публиковать ли своё присутствие (L2 не активен ни в одном чате).
    pub fn presence_allowed(&self) -> bool {
        self.inner.presence_allowed()
    }

    /// Новая ссылка-приглашение → `{"request", "url", "linkId"}` (секрет — только в url).
    pub fn group_invite_create(&mut self, group_hex: &str, title: &str, expires_ms: i64, usage_limit: u32, requires_approval: bool) -> Result<String, String> {
        let (r, parts) = self
            .inner
            .group_invite_create(&group_id(group_hex)?, title, expires_ms, usage_limit, requires_approval)
            .map_err(err)?;
        let url = crate::invite::format(&parts).map_err(err)?;
        Ok(json!({"request": req_json(&r), "url": url, "linkId": hex::encode(&parts.link_id)}).to_string())
    }

    /// Вступить по ссылке v2 (журнал группы уже принят group_ingest) → запрос `group.join`.
    pub fn group_join(&mut self, url: &str) -> Result<String, String> {
        let crate::invite::ParsedInvite::V2(parts) = crate::invite::parse(url).map_err(err)? else {
            return Err(err(ProtoError::InvalidField("invite")));
        };
        self.inner.group_join(&parts).map(|r| req_json(&r).to_string()).map_err(err)
    }

    /// Устройства пользователя по журналу → `{"v2": [...], "legacy": [...]}`.
    pub fn log_devices(&self, user: &str) -> String {
        log_devices_json(&self.inner, user)
    }

    /// Опубликовать/сократить свой список v1-устройств (FR-058): JSON
    /// `[{"deviceId","identity","signing"}]` → запрос `identity.device.log_append`.
    pub fn legacy_devices_request(&mut self, devices_json: &str) -> Result<String, String> {
        let devices = parse_legacy_devices(devices_json).map_err(err)?;
        self.inner.legacy_devices_request(devices).map(|r| req_json(&r).to_string()).map_err(err)
    }

    /// Запрос `msg.deliver_legacy`: v1 `SendPayload` (JSON) для v1-устройств.
    pub fn legacy_deliver_request(&self, message_id: &str, send_payload_json: &str) -> Result<String, String> {
        self.inner.legacy_deliver_request(message_id, send_payload_json.as_bytes()).map(|r| req_json(&r).to_string()).map_err(err)
    }

    /// Сервер отверг ключ доступа собеседника (FORBIDDEN на доставке): он сменил
    /// ключ (отзыв устройства, восстановление) — дальше слепым жетоном, пока
    /// новый ключ не придёт по E2E. true — ключ был и сброшен (есть смысл
    /// повторить отправку).
    pub fn delivery_key_rejected(&mut self, peer: &str) -> bool {
        let had = self.inner.has_peer_delivery_key(peer);
        self.inner.on_delivery_key_rejected(peer);
        had
    }

    /// Кто прочитал своё сообщение (по E2E-квитанциям) — JSON-массив
    /// `[{"user","tsMs"}]`. Серверу v2 это неизвестно («Просмотрено», T151).
    pub fn readers(&self, id: &str) -> Result<String, String> {
        let list: Vec<serde_json::Value> = self.inner.readers(&op_id(id)?).into_iter().map(|(user, ts)| json!({"user": user, "tsMs": ts})).collect();
        Ok(serde_json::Value::Array(list).to_string())
    }

    /// Известен ли ключ доступа собеседника: сигнал звонка сервер принимает
    /// только с ним (слепой жетон для звонков не годится).
    pub fn has_peer_delivery_key(&self, peer: &str) -> bool {
        self.inner.has_peer_delivery_key(peer)
    }

    // ── отзыв своего устройства (T128; D-11, D-12, D-16) ──

    /// Отозвать своё другое устройство и выполнить последствия →
    /// `{"requests":[…],"pendingKeyShares":[адрес…],"pendingEpochs":[hex…],
    /// "epochsNeedAdmin":[hex…],"sskRotationRequired":bool,"stateKeyVersion":n|null}`.
    /// Первый запрос — запись журнала (обязателен), остальные — ротации.
    /// Выход: запись журнала, которой устройство убирает само себя (JSON
    /// запросов). Оставшимся устройствам смена SSK не нужна.
    pub fn leave(&mut self) -> Result<String, String> {
        self.inner.leave_request().map(|r| reqs_json(&[r])).map_err(err)
    }

    pub fn revoke_device(&mut self, device_id: &str) -> Result<String, String> {
        self.inner.revoke_device(device_id).map(|o| revocation_json(&o)).map_err(cerr)
    }

    /// Отозвать ключ доступа у собеседника (FR-033) → тот же JSON итога, что
    /// у `revoke_device` (заполнены `requests` и `pendingKeyShares`).
    pub fn revoke_contact_access(&mut self, peer: &str) -> Result<String, String> {
        self.inner.revoke_contact_access(peer).map(|o| revocation_json(&o)).map_err(cerr)
    }

    /// Группы v2 — своим новым устройствам (T142): `devices_json` — JSON-массив
    /// id устройств. JSON-массив запросов (пустой — пересылать нечего).
    pub fn share_groups_with_own_devices(&mut self, devices_json: &str) -> Result<String, String> {
        let devices: Vec<String> = serde_json::from_str(devices_json).map_err(|e| e.to_string())?;
        self.inner.share_groups_with_own_devices(&devices).map(|r| reqs_json(&r)).map_err(cerr)
    }

    /// Секреты своих ссылок-приглашений — другим ведущим приглашения группы:
    /// `links_json`, `recipients_json` — JSON-массивы ссылок и адресов.
    pub fn share_invite_links(&mut self, group_hex: &str, links_json: &str, recipients_json: &str) -> Result<String, String> {
        let links: Vec<String> = serde_json::from_str(links_json).map_err(|e| e.to_string())?;
        let to: Vec<String> = serde_json::from_str(recipients_json).map_err(|e| e.to_string())?;
        self.inner.share_invite_links(&group_id(group_hex)?, &links, &to).map(|r| reqs_json(&r)).map_err(cerr)
    }

    /// Принятые секреты ссылок-приглашений: JSON `[{"group": hex, "url": …}]`.
    pub fn take_shared_invites(&mut self) -> String {
        let list: Vec<_> = self.inner.take_shared_invites().into_iter().map(|(g, url)| serde_json::json!({ "group": hex::encode(g), "url": url })).collect();
        serde_json::Value::Array(list).to_string()
    }

    /// Раздать текущий ключ доступа собеседнику (отложенное после отзыва).
    pub fn share_delivery_key(&mut self, peer: &str) -> Result<String, String> {
        self.inner.share_delivery_key(peer).map(|r| reqs_json(&r)).map_err(cerr)
    }

    /// Сменить SSK корнем (D-12) после отзыва устройства, державшего SSK.
    pub fn rotate_ssk(&mut self, root_secret: &[u8]) -> Result<String, String> {
        let root = zeroize::Zeroizing::new(key32(root_secret)?);
        self.inner.rotate_ssk_with_secret(&root).map(|r| reqs_json(&r)).map_err(err)
    }

    /// Свой SSK раскрыт и ещё не сменён.
    pub fn own_ssk_exposed(&self) -> bool {
        self.inner.own_ssk_exposed()
    }

    /// ID-01: доказательство устройства для `identity.session.issue` (64 байта).
    pub fn session_proof(&self, ts_ms: i64) -> Vec<u8> {
        self.inner.session_proof(ts_ms)
    }

    pub fn token_count(&self) -> usize {
        self.inner.token_count()
    }

    /// Пора получать суточную партию жетонов (FR-063: по расписанию, хост
    /// проверяет таймером — не перед тратой).
    pub fn token_refill_due(&self) -> bool {
        self.inner.token_refill_due(crate::time::now_ms())
    }

    /// Размер партии — вся суточная квота.
    pub fn token_batch_size(&self) -> usize {
        self.inner.token_batch_size()
    }

    // ── журнал личного состояния (T098) ──

    pub fn has_state_key(&self) -> bool {
        self.inner.state_key().is_some()
    }

    /// Первое устройство без ключа личного состояния — создать (версия 1).
    /// true — ключ создан сейчас (состояние клиента надо сохранить).
    pub fn ensure_state_key(&mut self) -> bool {
        if self.inner.state_key().is_some() {
            return false;
        }
        self.inner.set_state_key(crate::state::StateKey::generate(), 1);
        true
    }

    /// Сессия журнала личного состояния на текущем ключе (None — ключа нет).
    pub fn state_session(&self) -> Option<HostState> {
        let (k, _) = self.inner.state_key()?;
        Some(HostState {
            user: self.inner.user.clone(),
            device_id: self.inner.device_id.clone(),
            key: k.clone(),
            state: crate::state::PersonalState::new(),
            clock: crate::state::LamportClock::default(),
            cursor: 0,
            guard: crate::state::SendGuard::new(),
        })
    }
}

fn group_id(group_hex: &str) -> Result<Vec<u8>, String> {
    hex::decode(group_hex).map_err(|_| err(ProtoError::InvalidField("group")))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Разобрать ссылку-приглашение → `{"kind":"v2","domain","linkId"(hex)}` |
/// `{"kind":"legacy","token"}`; ошибка — не ссылка-приглашение.
pub fn parse_invite(url: &str) -> Result<String, String> {
    match crate::invite::parse(url).map_err(err)? {
        crate::invite::ParsedInvite::V2(p) => Ok(json!({"kind": "v2", "domain": p.domain, "linkId": hex::encode(&p.link_id)}).to_string()),
        crate::invite::ParsedInvite::LegacyV1 { token } => Ok(json!({"kind": "legacy", "token": token}).to_string()),
    }
}

/// Журнал личного состояния устройства (R10, T098) для нативных хостов — то
/// же, что `PvState` WASM-обвязки: сведение LWW (STATE-1), шифрование записей
/// ключом личного состояния (ключ не выходит наружу). Курсор — в памяти:
/// при запуске журнал читается с начала. Тела `state.append` — байты
/// `AppendRequest`, наружу — JSON-массив base64.
pub struct HostState {
    user: String,
    device_id: String,
    key: crate::state::StateKey,
    state: crate::state::PersonalState,
    clock: crate::state::LamportClock,
    cursor: u64,
    guard: crate::state::SendGuard,
}

impl HostState {
    /// Тело `state.sync` от курсора.
    pub fn sync_request(&self) -> Vec<u8> {
        crate::pb::parvane::state::v1::SyncRequest { after_seq: self.cursor, max_bytes: 0 }.encode_to_vec()
    }

    /// Ответ `state.sync` → `{"more","applied","rejected"}`. Нерасшифрованные
    /// и отвергнутые записи пропускаются — одинаково во всех клиентах.
    pub fn ingest(&mut self, resp: &[u8]) -> Result<String, String> {
        use crate::pb::parvane::state::v1::SyncResponse;
        let r: SyncResponse = decode_checked(resp, Origin::Server).map_err(err)?;
        let (mut applied, mut rejected) = (0usize, 0usize);
        for rec in &r.records {
            self.cursor = self.cursor.max(rec.seq);
            match crate::state::open_state_record(&self.key, &self.user, rec) {
                Ok(op) if self.state.apply(&op).is_ok() => applied += 1,
                _ => rejected += 1,
            }
        }
        self.clock.observe(self.state.max_lamport());
        Ok(json!({"more": r.more && !r.records.is_empty(), "applied": applied, "rejected": rejected}).to_string())
    }

    /// Сведённое состояние: proto3-JSON `state.v1.StateSnapshot`.
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&self.state.snapshot()).unwrap_or_else(|_| "{}".into())
    }

    /// Хост хочет состояние `desired_json` (StateSnapshot) по видам
    /// `kinds_json` (JSON-массив имён): операции разницы применяются локально,
    /// наружу — тела `state.append` (JSON-массив base64).
    pub fn diff(&mut self, desired_json: &str, kinds_json: &str) -> Result<String, String> {
        let desired: crate::pb::parvane::state::v1::StateSnapshot = serde_json::from_str(desired_json).map_err(|_| err(ProtoError::Malformed))?;
        let kinds: Vec<String> = serde_json::from_str(kinds_json).map_err(|_| err(ProtoError::Malformed))?;
        let m = crate::state::Managed::from_names(kinds.iter().map(String::as_str));
        let ops = crate::state::diff_ops(&self.state.snapshot(), &desired, m);
        self.seal_ops(ops)
    }

    /// Первый запуск: локальные данные (StateSnapshot) → начальные записи.
    pub fn migrate(&mut self, local_json: &str) -> Result<String, String> {
        let local: crate::pb::parvane::state::v1::StateSnapshot = serde_json::from_str(local_json).map_err(|_| err(ProtoError::Malformed))?;
        let ops = crate::state::migrate_snapshot(&local, &self.device_id, &mut self.clock, now_ms()).map_err(err)?;
        let mut out = Vec::new();
        for op in ops {
            if self.state.apply(&op).is_ok() {
                let r = crate::state::seal_op(&self.key, &self.user, &op).map_err(err)?;
                out.push(Value::String(b64(&r.encode_to_vec())));
            }
        }
        Ok(Value::Array(out).to_string())
    }

    /// Отложенные, которые ЭТО устройство отправляет сейчас (proto3-JSON
    /// `ScheduledMessage[]`); отправить с op_id отложенного, затем `mark_sent`.
    pub fn claim_due(&mut self, now_ms: i64) -> String {
        let due = self.state.claim_due(now_ms, &mut self.guard);
        serde_json::to_string(&due).unwrap_or_else(|_| "[]".into())
    }

    /// Отметка «отложенное отправлено» (op_id — base64 из снимка).
    pub fn mark_sent(&mut self, op_id_b64: &str) -> Result<String, String> {
        let s: crate::pb::parvane::state::v1::ScheduledRef =
            serde_json::from_value(json!({ "op_id": op_id_b64 })).map_err(|_| err(ProtoError::Malformed))?;
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::ScheduledSent(s)])
    }

    /// Запись истории звонков (D-08: сервер её не ведёт): proto3-JSON
    /// `state.v1.CallRecord` → тела `state.append`. LWW по `call_id`.
    pub fn call_set(&mut self, record_json: &str) -> Result<String, String> {
        let rec: crate::pb::parvane::state::v1::CallRecord = serde_json::from_str(record_json).map_err(|_| err(ProtoError::Malformed))?;
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::CallSet(rec)])
    }

    /// Ссылка-приглашение группы v2 (T160): proto3-JSON `state.v1.GroupInvite`
    /// → тела `state.append`. LWW по `link_id`.
    pub fn group_invite_set(&mut self, invite_json: &str) -> Result<String, String> {
        let i: crate::pb::parvane::state::v1::GroupInvite = serde_json::from_str(invite_json).map_err(|_| err(ProtoError::Malformed))?;
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::GroupInviteSet(i)])
    }

    /// Ссылка снята (отозвана или удалена): `link_id` — base64.
    pub fn group_invite_remove(&mut self, link_id_b64: &str) -> Result<String, String> {
        let r: crate::pb::parvane::state::v1::GroupInviteRef =
            serde_json::from_value(json!({ "link_id": link_id_b64 })).map_err(|_| err(ProtoError::Malformed))?;
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::GroupInviteRemove(r)])
    }

    /// Контейнер планировщика пользователя (spec 010): `domain` и hex id
    /// ссылки → тела `state.append`. LWW-регистр, один на пользователя.
    pub fn planner_container_set(&mut self, domain: &str, id_hex: &str) -> Result<String, String> {
        let id = hex::decode(id_hex).map_err(|_| err(ProtoError::Malformed))?;
        let c = crate::pb::parvane::state::v1::PlannerContainer {
            r#ref: Some(crate::pb::parvane::core::v2::Ref { domain: domain.into(), id }),
        };
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::PlannerContainerSet(c)])
    }

    /// Чат очищен «у себя» до момента (T145): proto3-JSON `state.v1.ChatCleared`
    /// → тела `state.append`. Граница по собеседнику только растёт.
    pub fn chat_cleared(&mut self, cleared_json: &str) -> Result<String, String> {
        let c: crate::pb::parvane::state::v1::ChatCleared = serde_json::from_str(cleared_json).map_err(|_| err(ProtoError::Malformed))?;
        self.seal_ops(vec![crate::pb::parvane::state::v1::state_op::Op::ChatCleared(c)])
    }

    /// Локальный журнал уже отправленных этим устройством (JSON-массив hex).
    pub fn sent_guard(&self) -> String {
        json!(self.guard.to_list().iter().map(hex::encode).collect::<Vec<_>>()).to_string()
    }

    pub fn load_sent_guard(&mut self, ids_json: &str) {
        let ids: Vec<String> = serde_json::from_str(ids_json).unwrap_or_default();
        let bytes: Vec<Vec<u8>> = ids.iter().filter_map(|h| hex::decode(h).ok()).collect();
        self.guard = crate::state::SendGuard::from_list(bytes.iter().map(Vec::as_slice));
    }

    fn seal_ops(&mut self, ops: Vec<crate::pb::parvane::state::v1::state_op::Op>) -> Result<String, String> {
        let mut out = Vec::new();
        let now = now_ms();
        for kind in ops {
            let op = crate::state::make_op(&mut self.clock, &self.device_id, now, kind).map_err(err)?;
            if self.state.apply(&op).is_err() {
                continue;
            }
            let r = crate::state::seal_op(&self.key, &self.user, &op).map_err(err)?;
            out.push(Value::String(b64(&r.encode_to_vec())));
        }
        Ok(Value::Array(out).to_string())
    }
}

/// Материал гранта линковки + копия корня под ключом восстановления (поле
/// `rb`, hex): с ней привязанное устройство сможет сменить SSK после отзыва
/// другого (D-12). Копия без ключа восстановления ничего не раскрывает.
pub fn grant_with_root_backup(material: &[u8], backup: &[u8]) -> Result<Vec<u8>, ProtoError> {
    let mut v: Value = serde_json::from_slice(material).map_err(|_| ProtoError::Malformed)?;
    if !v.is_object() || backup.is_empty() {
        return Err(ProtoError::Malformed);
    }
    v["rb"] = json!(hex::encode(backup));
    Ok(v.to_string().into_bytes())
}

/// Копия корня из материала гранта (поле `rb`); `None` — гранта без копии.
pub fn grant_root_backup(material: &[u8]) -> Option<Vec<u8>> {
    let v: Value = serde_json::from_slice(material).ok()?;
    hex::decode(v["rb"].as_str()?).ok().filter(|b| !b.is_empty())
}

/// T130: корень из копии под ключом восстановления на устройстве БЕЗ журнала
/// (восстановление): сверка с журналом — в `recover_with_root`.
pub fn import_root_backup_for(user: &str, blob: &[u8], recovery_key: &str) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
    let key = crate::recovery::RecoveryKey::parse(recovery_key).map_err(err)?;
    crate::recovery::import_root_backup(blob, user, &key).map_err(err)
}

/// C1-06: новый ключ восстановления (≥ 128 бит, строка для пользователя).
pub fn generate_recovery_key() -> zeroize::Zeroizing<String> {
    crate::recovery::RecoveryKey::generate().to_display()
}

// ── кадры ───────────────────────────────────────────────────────────────────

pub fn encode_hello(channel: i32, kind: &str, version: &str) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Hello(Hello {
        proto_minor: crate::PROTO_MINOR,
        features: vec![],
        client: Some(ClientInfo { kind: kind.into(), version: version.into() }),
        channel: Channel::try_from(channel).unwrap_or(Channel::Identified) as i32,
    }))
}

pub fn encode_auth(token: &str) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Auth(Auth { token: token.into() }))
}

pub fn encode_request(id: u64, method: &str, body: &[u8], timeout_ms: u32) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Request(Request { id, method: method.into(), body: body.to_vec(), timeout_ms }))
}

pub fn encode_ping(nonce: u64) -> Vec<u8> {
    codec::encode_frame(frame::Kind::Ping(Ping { nonce }))
}

fn error_name(code: i32) -> &'static str {
    ErrorCode::try_from(code).map(|c| c.as_str_name()).unwrap_or("ERROR_CODE_UNSPECIFIED")
}

/// Кадр сервера → JSON (тела — base64).
pub fn decode_frame(bytes: &[u8]) -> Result<String, String> {
    let f: Frame = codec::decode_frame(bytes, Origin::Server).map_err(err)?;
    let v = match f.kind {
        Some(frame::Kind::Welcome(w)) => json!({"kind": "welcome", "minSupportedMinor": w.min_supported_minor, "features": w.features, "serverDescriptor": b64(&w.server_descriptor)}),
        Some(frame::Kind::AuthOk(a)) => json!({"kind": "authOk", "user": a.user, "deviceId": a.device_id}),
        Some(frame::Kind::Response(r)) => match r.result {
            Some(response::Result::Ok(b)) => json!({"kind": "response", "id": r.id, "ok": b64(&b)}),
            Some(response::Result::Error(e)) => json!({"kind": "response", "id": r.id, "error": error_name(e.code), "retryAfterMs": e.retry_after_ms}),
            None => json!({"kind": "response", "id": r.id, "error": "ERROR_CODE_UNSPECIFIED"}),
        },
        Some(frame::Kind::Event(e)) => json!({"kind": "event", "subscription": e.subscription, "eventKind": e.kind, "seq": e.seq, "body": b64(&e.body)}),
        Some(frame::Kind::StreamChunk(c)) => json!({"kind": "chunk", "id": c.id, "index": c.index, "last": c.last, "data": b64(&c.data), "error": c.error.map(|e| error_name(e.code))}),
        Some(frame::Kind::Ping(p)) => json!({"kind": "ping", "nonce": p.nonce}),
        Some(frame::Kind::Pong(p)) => json!({"kind": "pong", "nonce": p.nonce}),
        _ => json!({"kind": "unknown"}),
    };
    Ok(v.to_string())
}

pub fn verify_server_descriptor(bytes: &[u8]) -> Result<String, String> {
    let (d, k) = crate::client::verify_server_descriptor(bytes).map_err(err)?;
    Ok(json!({"domain": d, "serverKey": hex::encode(k)}).to_string())
}

/// Страница `msg.inbox.sync` → JSON {records: [base64], more}.
pub fn split_sync_response(bytes: &[u8]) -> Result<String, String> {
    let r: InboxSyncResponse = decode_checked(bytes, Origin::Server).map_err(err)?;
    Ok(json!({"records": r.records.iter().map(|x| b64(&x.encode_to_vec())).collect::<Vec<_>>(), "more": r.more}).to_string())
}

pub fn device_log_entries(bytes: &[u8]) -> Result<usize, String> {
    let r: ipb::DeviceLogSyncAnonResponse = decode_checked(bytes, Origin::Server).map_err(err)?;
    Ok(r.entries.len())
}

/// Тело запроса ЛЮБОГО метода реестра из proto3-JSON (T161): вход, профили,
/// устройства, линковка, файлы, превью, push, ICE — хост зовёт их сам.
pub fn encode_method_request(method: &str, json_text: &str) -> Result<Vec<u8>, String> {
    crate::schema::method_codec::encode_request(method, json_text).unwrap_or(Err(ProtoError::UnknownMethod)).map_err(err)
}

/// Ответ метода реестра → proto3-JSON (байты проверены лимитами схемы).
pub fn decode_method_response(method: &str, bytes: &[u8]) -> Result<String, String> {
    crate::schema::method_codec::decode_response(method, bytes).unwrap_or(Err(ProtoError::UnknownMethod)).map_err(err)
}

/// Тело запроса из proto3-JSON по имени типа (для методов, которые хост
/// вызывает сам: вход, профиль, журналы, бандлы, облако).
pub fn encode_message(type_name: &str, json_text: &str) -> Result<Vec<u8>, String> {
    macro_rules! enc {
        ($($name:literal => $t:ty),* $(,)?) => {
            match type_name {
                $($name => {
                    let m: $t = serde_json::from_str(json_text).map_err(|_| err(ProtoError::Malformed))?;
                    Ok(m.encode_to_vec())
                })*
                _ => Err(err(ProtoError::UnknownMethod)),
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
        "parvane.identity.v2.RecoveryTgSendRequest" => ipb::RecoveryTgSendRequest,
        "parvane.identity.v2.RecoveryTgRequestRequest" => ipb::RecoveryTgRequestRequest,
        "parvane.identity.v2.RecoveryTgPollRequest" => ipb::RecoveryTgPollRequest,
        "parvane.identity.v2.TelegramPullRequest" => ipb::TelegramPullRequest,
        "parvane.identity.v2.TelegramReplyRequest" => ipb::TelegramReplyRequest,
        "parvane.identity.v2.DeviceFetchBundleAnonRequest" => ipb::DeviceFetchBundleAnonRequest,
        "parvane.identity.v2.DeviceRevokeRequest" => ipb::DeviceRevokeRequest,
        "parvane.identity.v2.PrivacySetRequest" => ipb::PrivacySetRequest,
        "parvane.identity.v2.PrivacyGetRequest" => ipb::PrivacyGetRequest,
        "parvane.group.v2.StateSyncRequest" => gpb::StateSyncRequest,
        "parvane.group.v2.InviteCheckRequest" => gpb::InviteCheckRequest,
        "parvane.msg.v2.Text" => crate::pb::parvane::msg::v2::Text,
        "parvane.msg.v2.Content" => Content,
        "parvane.group.v2.InviteListRequest" => gpb::InviteListRequest,
        "parvane.group.v2.RequestListRequest" => gpb::RequestListRequest,
        "parvane.cloud.v1.UploadChunkRequest" => crate::pb::parvane::cloud::v1::UploadChunkRequest,
        "parvane.cloud.v1.UploadCompleteRequest" => crate::pb::parvane::cloud::v1::UploadCompleteRequest,
        "parvane.cloud.v1.DownloadRequest" => crate::pb::parvane::cloud::v1::DownloadRequest,
        "parvane.cloud.v1.DownloadCapRequest" => crate::pb::parvane::cloud::v1::DownloadCapRequest,
        "parvane.preview.v2.LinkRequest" => crate::pb::parvane::preview::v2::LinkRequest,
        "parvane.preview.v2.MapTileRequest" => crate::pb::parvane::preview::v2::MapTileRequest,
        "parvane.push.v1.RegisterRequest" => crate::pb::parvane::push::v1::RegisterRequest,
        "parvane.push.v1.UnregisterRequest" => crate::pb::parvane::push::v1::UnregisterRequest,
    }
}

/// Байты ответа → proto3-JSON по полному имени типа (ответы методов,
/// которые хост разбирает сам: проверка ссылки, вступление, тексты черновиков).
pub fn decode_message(type_name: &str, bytes: &[u8]) -> Result<String, String> {
    macro_rules! dec {
        ($($name:literal => $t:ty),* $(,)?) => {
            match type_name {
                $($name => {
                    let m: $t = decode_checked(bytes, Origin::Server).map_err(err)?;
                    serde_json::to_string(&m).map_err(|_| err(ProtoError::Malformed))
                })*
                _ => Err(err(ProtoError::UnknownMethod)),
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
        "parvane.identity.v2.AccountGet2faResponse" => ipb::AccountGet2faResponse,
        "parvane.identity.v2.ProfileResolveResponse" => ipb::ProfileResolveResponse,
        "parvane.identity.v2.DirectorySearchResponse" => ipb::DirectorySearchResponse,
        "parvane.identity.v2.DeviceListResponse" => ipb::DeviceListResponse,
        "parvane.identity.v2.RootBackupGetResponse" => ipb::RootBackupGetResponse,
        "parvane.identity.v2.RecoveryTgPollResponse" => ipb::RecoveryTgPollResponse,
        "parvane.identity.v2.TelegramPullResponse" => ipb::TelegramPullResponse,
        "parvane.identity.v2.TelegramReplyResponse" => ipb::TelegramReplyResponse,
        "parvane.identity.v2.PrivacyGetResponse" => ipb::PrivacyGetResponse,
        "parvane.msg.v2.InboxSyncResponse" => crate::pb::parvane::msg::v2::InboxSyncResponse,
        "parvane.msg.v2.InboxSubscribeResponse" => crate::pb::parvane::msg::v2::InboxSubscribeResponse,
        "parvane.msg.v2.DeliverSealedResponse" => crate::pb::parvane::msg::v2::DeliverSealedResponse,
        "parvane.group.v2.InviteCheckResponse" => gpb::InviteCheckResponse,
        "parvane.group.v2.JoinResponse" => gpb::JoinResponse,
        "parvane.msg.v2.Text" => crate::pb::parvane::msg::v2::Text,
        "parvane.msg.v2.Content" => Content,
        "parvane.group.v2.InviteListResponse" => gpb::InviteListResponse,
        "parvane.group.v2.RequestListResponse" => gpb::RequestListResponse,
        "parvane.cloud.v1.UploadChunkResponse" => crate::pb::parvane::cloud::v1::UploadChunkResponse,
        "parvane.cloud.v1.UploadCompleteResponse" => crate::pb::parvane::cloud::v1::UploadCompleteResponse,
        "parvane.cloud.v1.DownloadResponse" => crate::pb::parvane::cloud::v1::DownloadResponse,
        "parvane.cloud.v1.DownloadCapResponse" => crate::pb::parvane::cloud::v1::DownloadCapResponse,
        "parvane.preview.v2.LinkResponse" => crate::pb::parvane::preview::v2::LinkResponse,
        "parvane.preview.v2.MapTileResponse" => crate::pb::parvane::preview::v2::MapTileResponse,
        "parvane.push.v1.DescribeResponse" => crate::pb::parvane::push::v1::DescribeResponse,
    }
}

/// base64 → байты (помощник для хостов без своей base64).
pub fn from_b64(s: &str) -> Result<Vec<u8>, String> {
    unb64(s)
}
