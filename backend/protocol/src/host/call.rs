//! Единая точка входа нативных хостов (spec 029, FR-003): вызов функции движка по имени WASM-обвязки
//! (`plannerSeal`, `groupInfo`, …) с аргументами-объектом JSON. Desktop и android зовут движок теми же
//! именами и с тем же смыслом, что web (`controller.ts`), — порт хоста идёт вызов в вызов.
//!
//! Соглашения границы:
//! - аргументы — объект JSON, ключи — имена параметров WASM в camelCase (`opId`, `tsMs`, `syncResponse`);
//! - байты в обе стороны — base64-строки;
//! - аргумент «JSON-текст» (`contentJson`, `changeJson`, …) — строкой или сразу объектом;
//! - результат — значение JSON: запросы — объекты `{chan, method, body(base64), dest?}`, то, что WASM
//!   отдаёт JSON-строкой (`groupInfo`, `openRecord`, …), — уже разобранным значением; отсутствие — `null`;
//! - ошибка — строка JSON `{"need":…}` / `{"error":…}`; незнакомое имя — `{"error":"UnknownCall"}`.

use prost::Message;
use serde_json::{json, Value};

use super::{b64, cerr, err, events, l2_view_json, op_id, req_json, revocation_json, unb64, HostClient, HostState};
use crate::client::OutRequest;
use crate::codec::decode_checked;
use crate::error::ProtoError;
use crate::limits::Origin;
use crate::pb::parvane::core::v2::Ref;
use crate::pb::parvane::group::v2 as gpb;
use crate::pb::parvane::identity::v2 as ipb;
use crate::pb::parvane::msg::v2::Content;

type R = Result<Value, String>;

const UNKNOWN: &str = r#"{"error":"UnknownCall"}"#;

fn missing(k: &'static str) -> String {
    err(ProtoError::InvalidField(k))
}

/// Аргументы вызова.
struct Args<'a>(&'a Value);

impl Args<'_> {
    fn s(&self, k: &'static str) -> Result<&str, String> {
        self.0.get(k).and_then(Value::as_str).ok_or_else(|| missing(k))
    }
    fn so(&self, k: &str) -> Option<&str> {
        self.0.get(k).and_then(Value::as_str)
    }
    /// Строка или пусто.
    fn se(&self, k: &str) -> &str {
        self.so(k).unwrap_or("")
    }
    fn b(&self, k: &'static str) -> Result<Vec<u8>, String> {
        unb64(self.s(k)?)
    }
    fn bo(&self, k: &str) -> Result<Option<Vec<u8>>, String> {
        match self.so(k) {
            Some(s) => unb64(s).map(Some),
            None => Ok(None),
        }
    }
    fn i(&self, k: &'static str) -> Result<i64, String> {
        let v = self.0.get(k).ok_or_else(|| missing(k))?;
        v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).ok_or_else(|| missing(k))
    }
    fn u(&self, k: &'static str) -> Result<u64, String> {
        u64::try_from(self.i(k)?).map_err(|_| missing(k))
    }
    fn n(&self, k: &'static str) -> Result<usize, String> {
        usize::try_from(self.u(k)?).map_err(|_| missing(k))
    }
    fn flag(&self, k: &'static str) -> Result<bool, String> {
        self.0.get(k).and_then(Value::as_bool).ok_or_else(|| missing(k))
    }
    /// JSON-текст: строкой или значением.
    fn text(&self, k: &'static str) -> Result<String, String> {
        match self.0.get(k) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(v) if !v.is_null() => Ok(v.to_string()),
            _ => Err(missing(k)),
        }
    }
    /// Массив строк: значением или JSON-текстом.
    fn strings(&self, k: &'static str) -> Result<Vec<String>, String> {
        let v = match self.0.get(k) {
            Some(Value::String(s)) => serde_json::from_str::<Value>(s).map_err(|_| missing(k))?,
            Some(v) => v.clone(),
            None => return Err(missing(k)),
        };
        serde_json::from_value(v).map_err(|_| missing(k))
    }
    fn hex(&self, k: &'static str) -> Result<Vec<u8>, String> {
        hex::decode(self.s(k)?).map_err(|_| missing(k))
    }
}

fn req(r: &OutRequest) -> Value {
    req_json(r)
}

fn reqs(rs: &[OutRequest]) -> Value {
    Value::Array(rs.iter().map(req_json).collect())
}

/// JSON-текст движка → значение.
fn parsed(s: String) -> Value {
    serde_json::from_str(&s).unwrap_or(Value::Null)
}

fn opt<T: Into<Value>>(v: Option<T>) -> Value {
    v.map_or(Value::Null, Into::into)
}

fn key32(b: &[u8]) -> Result<[u8; 32], String> {
    b.try_into().map_err(|_| missing("key"))
}

fn malformed() -> String {
    err(ProtoError::Malformed)
}

impl HostClient {
    /// Вызов функции движка по имени WASM-обвязки (см. модуль).
    pub fn call(&mut self, name: &str, args: &Value) -> R {
        let a = Args(args);
        let c = &mut self.inner;
        Ok(match name {
            // ── личность, корень, восстановление ──
            "export" => json!(b64(&c.export(&key32(&a.b("key")?)?).map_err(err)?)),
            "createIdentity" => {
                let (r, root) = c.create_identity(a.n("otkCount")?).map_err(err)?;
                let secret = root.root.to_bytes();
                self.root = Some(zeroize::Zeroizing::new(secret));
                json!({"requests": reqs(&r), "rootSecret": b64(&secret)})
            }
            "resetIdentity" => {
                let (r, root) = c.reset_identity(a.n("otkCount")?).map_err(err)?;
                let secret = root.root.to_bytes();
                self.root = Some(zeroize::Zeroizing::new(secret));
                json!({"requests": reqs(&r), "rootSecret": b64(&secret)})
            }
            "exportRootBackup" => {
                let key = crate::recovery::RecoveryKey::parse(a.s("recoveryKey")?).map_err(err)?;
                let root = self.root_or(a.bo("rootSecret")?)?;
                json!(b64(&self.inner.export_root_backup(&root, &key).map_err(err)?))
            }
            "exportRootEscrow" => {
                let root = self.root_or(a.bo("rootSecret")?)?;
                json!(b64(&self.inner.export_root_escrow(&root, &key32(&a.b("escrowPublic")?)?).map_err(err)?))
            }
            "importRootBackup" => {
                let key = crate::recovery::RecoveryKey::parse(a.s("recoveryKey")?).map_err(err)?;
                let secret = c.import_root_backup(&a.b("blob")?, &key).map_err(err)?;
                let out = b64(secret.as_slice());
                self.root = Some(secret);
                json!(out)
            }
            "importRootBackupFor" => {
                let key = crate::recovery::RecoveryKey::parse(a.s("recoveryKey")?).map_err(err)?;
                let secret = crate::recovery::import_root_backup(&a.b("blob")?, &c.user, &key).map_err(err)?;
                self.root = Some(secret);
                Value::Null
            }
            "forgetRoot" => {
                self.root = None;
                Value::Null
            }
            "hasRoot" => json!(self.root.is_some()),
            "recoverWithRoot" => {
                let root = self.root.clone().ok_or_else(|| err(ProtoError::NotFound))?;
                let r: ipb::DeviceLogSyncResponse = decode_checked(&a.b("logResponse")?, Origin::Server).map_err(err)?;
                reqs(&self.inner.recover_with_root(&root, r.entries, a.n("otkCount")?).map_err(err)?)
            }
            "rotateSsk" => {
                let root = self.root.clone().ok_or_else(|| err(ProtoError::NotFound))?;
                reqs(&self.inner.rotate_ssk_with_secret(&root).map_err(err)?)
            }
            "ownSskExposed" => json!(c.own_ssk_exposed()),
            "sessionProof" => json!(b64(&c.session_proof(a.i("tsMs")?))),
            "acceptRootChange" => json!(c.accept_pending_root(a.s("user")?).map_err(err)?),

            // ── линковка ──
            "linkGrantMaterial" => json!(b64(self.link_grant_material()?.as_bytes())),
            "joinWithGrant" => {
                let m = String::from_utf8(a.b("material")?).map_err(|_| malformed())?;
                parsed(self.join_with_grant(&m, a.n("otkCount")?)?)
            }
            "shareGroupsWithOwnDevices" => reqs(&c.share_groups_with_own_devices(&a.strings("devicesJson")?).map_err(cerr)?),

            // ── журнал инбокса ──
            "otkRequest" => req(&c.otk_request(a.n("n")?)),
            "syncRequest" => req(&c.sync_request()),
            "ackRequest" => req(&c.ack_request()),
            "cursor" => json!(c.cursor().disk_value()),
            "openRecord" => parsed(c.open_record(&a.b("record")?).map(|e| events(&e)).map_err(cerr)?),
            "drainReady" => parsed(events(&c.drain_ready())),
            "lastError" => opt(c.last_error.as_ref().map(ProtoError::kind)),

            // ── журналы устройств собеседников ──
            "logVersion" => json!(c.log_version(a.s("user")?)),
            "logDevices" => parsed(super::log_devices_json(c, a.s("user")?)),
            "ingestLog" => json!(super::ingest_log_verdict(c, a.s("user")?, &a.b("syncResponse")?).map_err(err)?),
            "ingestBundle" => {
                let r: ipb::DeviceFetchBundleAnonResponse = decode_checked(&a.b("bundleResponse")?, Origin::Server).map_err(err)?;
                json!(c.ingest_bundle(a.s("user")?, r.devices).map_err(err)?)
            }
            "logsBehind" => json!(c.logs_behind().into_iter().map(|(u, _)| u).collect::<Vec<_>>()),
            "legacyDevicesRequest" => {
                let devices = super::parse_legacy_devices(&a.text("devicesJson")?).map_err(err)?;
                req(&c.legacy_devices_request(devices).map_err(err)?)
            }
            "legacyDeliverRequest" => req(&c.legacy_deliver_request(a.s("messageId")?, a.text("sendPayloadJson")?.as_bytes()).map_err(err)?),

            // ── смена ника (spec 026) ──
            "renamePrepare" => {
                let root = self.root.clone().ok_or_else(|| err(ProtoError::NotFound))?;
                let key = crate::recovery::RecoveryKey::parse(a.s("recoveryKey")?).map_err(err)?;
                let new_address = a.s("newAddress")?;
                let plan = self.inner.rename_prepare(&root, new_address).map_err(err)?;
                let root_backup = crate::recovery::export_root_backup(&root, new_address, &key).map_err(err)?;
                let body = ipb::AccountRenameRequest {
                    new_login: a.s("newLogin")?.to_string(),
                    rename: Some(plan.rename.clone()),
                    new_log: plan.new_log.clone(),
                    root_backup,
                };
                self.rename_plan = Some(plan);
                json!(b64(&body.encode_to_vec()))
            }
            "renameApply" => {
                let plan = self.rename_plan.take().ok_or_else(|| err(ProtoError::NotFound))?;
                self.inner.rename_apply(&plan).map_err(err)?;
                Value::Null
            }
            "renameFollow" => {
                let r: ipb::DeviceLogSyncResponse = decode_checked(&a.b("logResponse")?, Origin::Server).map_err(err)?;
                reqs(&c.rename_follow(r.entries).map_err(err)?)
            }
            "renameGroupsPending" => reqs(&c.rename_groups_pending().map_err(err)?),
            "ownRenamedTo" => opt(c.own_renamed_to()),
            "peerRenamedTo" => opt(c.peer_renamed_to(a.s("user")?)),
            "peerRenamedFrom" => opt(c.peer_renamed_from(a.s("user")?)),
            "selfAddress" => json!(c.user),
            "formerAddresses" => json!(c.former_addresses()),
            "aliasesOf" => json!(c.aliases_of(a.s("user")?)),

            // ── ключи доступа и жетоны ──
            "setPeerDeliveryKey" => {
                c.set_peer_delivery_key(a.s("user")?, a.b("key")?, a.u("generation")?);
                Value::Null
            }
            "hasPeerDeliveryKey" => json!(c.has_peer_delivery_key(a.s("peer")?)),
            "deliveryKeyRejected" => {
                let peer = a.s("peer")?;
                let had = c.has_peer_delivery_key(peer);
                c.on_delivery_key_rejected(peer);
                json!(had)
            }
            "shareDeliveryKey" => reqs(&c.share_delivery_key(a.s("peer")?).map_err(cerr)?),
            "revokeContactAccess" => parsed(revocation_json(&c.revoke_contact_access(a.s("peer")?).map_err(cerr)?)),
            "tokenRequest" => {
                let r: ipb::TokensKeyListResponse = decode_checked(&a.b("keyListResponse")?, Origin::Server).map_err(err)?;
                let list = r.list.ok_or_else(|| missing("list"))?;
                req(&c.token_request(&list, &a.b("serverKey")?, a.n("count")?).map_err(err)?)
            }
            "tokenResponse" => {
                let r: ipb::TokensIssueBlindedResponse = decode_checked(&a.b("resp")?, Origin::Server).map_err(err)?;
                json!(c.token_response(&r).map_err(err)?)
            }
            "tokenCount" => json!(c.token_count()),
            "tokenRefillDue" => json!(c.token_refill_due(crate::time::now_ms())),
            "tokenBatchSize" => json!(c.token_batch_size()),
            "tokenCountFor" => json!(c.token_count_for(a.s("domain")?)),
            "tokenRefillDueFor" => json!(c.token_refill_due_for(a.s("domain")?, crate::time::now_ms())),
            "tokenRefillDueDomains" => json!(c.token_refill_due_domains(crate::time::now_ms())),
            "tokenRequestFor" => {
                let r: ipb::TokensKeyListResponse = decode_checked(&a.b("keyListResponse")?, Origin::Server).map_err(err)?;
                let list = r.list.ok_or_else(|| missing("list"))?;
                req(&c.token_request_for(a.s("domain")?, &list, &a.b("serverKey")?, a.n("count")?).map_err(err)?)
            }
            "tokenResponseFor" => {
                let r: ipb::TokensIssueBlindedResponse = decode_checked(&a.b("resp")?, Origin::Server).map_err(err)?;
                json!(c.token_response_for(a.s("domain")?, &r).map_err(err)?)
            }

            // ── отправка ──
            "prepareDirect" => {
                let content: Content = serde_json::from_str(&a.text("contentJson")?).map_err(|_| malformed())?;
                reqs(&c.prepare_direct_id(a.s("peer")?, &content, op_id(a.se("opId"))?).map_err(cerr)?)
            }
            "prepareCall" => {
                let signal: crate::pb::parvane::call::v2::CallSignal = serde_json::from_str(&a.text("signalJson")?).map_err(|_| malformed())?;
                reqs(&c.prepare_call(a.s("peer")?, &signal).map_err(cerr)?)
            }
            "prepareCallOwn" => {
                let signal: crate::pb::parvane::call::v2::CallSignal = serde_json::from_str(&a.text("signalJson")?).map_err(|_| malformed())?;
                reqs(&c.prepare_call_own(&signal).map_err(cerr)?)
            }
            "prepareCover" => req(&c.prepare_cover().map_err(err)?),
            "readers" => {
                let list: Vec<Value> = c.readers(&op_id(a.s("id")?)?).into_iter().map(|(user, ts)| json!({"user": user, "tsMs": ts})).collect();
                Value::Array(list)
            }

            // ── свои устройства ──
            "leave" => reqs(&[c.leave_request().map_err(err)?]),
            "revokeDevice" => parsed(revocation_json(&c.revoke_device(a.s("deviceId")?).map_err(cerr)?)),
            "signOutDevice" => parsed(revocation_json(&c.sign_out_device(a.s("deviceId")?).map_err(cerr)?)),
            "reportDeviceStolen" => parsed(revocation_json(&c.report_device_stolen(a.s("deviceId")?).map_err(cerr)?)),
            "leftSskHolders" => json!(c.left_ssk_holders()),
            "groupsRekeyPending" => json!(c.groups_rekey_pending().iter().map(hex::encode).collect::<Vec<_>>()),

            // ── эфемерные каналы ──
            "ephSubscribe" => reqs(&super::eph_subscribe_reqs(c, &a.text("chatsJson")?).map_err(err)?),
            "ephReset" => {
                c.eph_reset();
                Value::Null
            }
            "ephTyping" => reqs(&super::eph_typing_reqs(c, a.s("chat")?, i32::try_from(a.i("action")?).map_err(|_| missing("action"))?).map_err(err)?),
            "ephPresence" => reqs(c.presence_request(a.flag("online")?, a.i("lastSeenMs")?).map_err(err)?.as_slice()),
            "ephOpen" => parsed(super::eph_open_json(c, &a.b("body")?)),

            // ── группы ──
            "groupCreate" => {
                let perms: gpb::Permissions = serde_json::from_str(&a.text("permsJson")?).map_err(|_| malformed())?;
                let kind = gpb::GroupKind::try_from(i32::try_from(a.i("kind")?).map_err(|_| missing("kind"))?).map_err(|_| missing("kind"))?;
                let (g, r) = c.group_create_from(kind, a.s("name")?, &a.strings("members")?, perms, a.se("migratedFrom")).map_err(err)?;
                json!({"group": {"domain": g.domain, "id": hex::encode(&g.id)}, "request": req(&r)})
            }
            "groupVersion" => json!(c.group_version(&a.hex("group")?)),
            "groupBehind" => opt(c.group_behind(&a.hex("group")?)),
            "groupDomain" => json!(c.group_domain(&a.hex("group")?)),
            "groupIngest" => {
                let r: gpb::StateSyncResponse = decode_checked(&a.b("syncResponse")?, Origin::Server).map_err(err)?;
                let g = Ref { domain: a.s("domain")?.into(), id: a.hex("group")? };
                json!(c.group_ingest_hinted(&g, r.entries, &r.signer_hints).map_err(cerr)?)
            }
            "groupForget" => {
                c.group_forget(&a.hex("group")?);
                Value::Null
            }
            "groupList" => json!(c.group_ids().iter().map(hex::encode).collect::<Vec<_>>()),
            "groupUnconfirmed" => json!(c.group_unconfirmed(&a.hex("group")?, &a.strings("claimed")?)),
            "groupInfo" => self.group_info_value(&a.hex("group")?)?,
            "groupInviteCreate" => {
                let (r, parts) = c
                    .group_invite_create(&a.hex("group")?, a.se("title"), a.i("expiresMs")?, u32::try_from(a.u("usageLimit")?).map_err(|_| missing("usageLimit"))?, a.flag("requiresApproval")?)
                    .map_err(err)?;
                json!({"request": req(&r), "url": crate::invite::format(&parts).map_err(err)?, "linkId": hex::encode(&parts.link_id)})
            }
            "groupJoin" => {
                let crate::invite::ParsedInvite::V2(parts) = crate::invite::parse(a.s("url")?).map_err(err)? else {
                    return Err(missing("invite"));
                };
                req(&c.group_join(&parts).map_err(err)?)
            }
            "groupSetPublic" => req(&c.group_set_public(&a.hex("group")?, a.flag("public")?, a.se("name"), a.flag("preview")?, a.flag("history")?).map_err(err)?),
            "groupJoinPublic" => {
                let secret: [u8; 32] = a.hex("secretHex")?.try_into().map_err(|_| missing("secret"))?;
                req(&c.group_join_public(&a.hex("group")?, &secret).map_err(err)?)
            }
            "publicHistoryItems" => {
                let r: gpb::PublicHistoryResponse = decode_checked(&a.b("response")?, Origin::Server).map_err(err)?;
                Value::Array(r.items.into_iter().filter_map(|i| Some(json!({"seq": i.seq, "envelope": b64(&i.envelope?.encode_to_vec())}))).collect())
            }
            "groupOpenEnvelope" => parsed(c.open_group_envelope(&a.b("envelope")?).map(|e| events(&e)).map_err(cerr)?),
            "groupChange" => {
                let ch: gpb::GroupChange = serde_json::from_str(&a.text("changeJson")?).map_err(|_| malformed())?;
                let change = ch.change.ok_or_else(|| missing("change"))?;
                req(&c.group_change(&a.hex("group")?, change).map_err(err)?)
            }
            "groupRequestDecide" => {
                let via = match a.so("viaLinkHex").filter(|h| !h.is_empty()) {
                    Some(h) => hex::decode(h).map_err(|_| missing("viaLinkHex"))?,
                    None => Vec::new(),
                };
                req(&c.group_request_decide_via(&a.hex("group")?, a.s("user")?, a.flag("approve")?, &via).map_err(err)?)
            }
            "groupRotateEpoch" => reqs(&c.group_rotate_epoch(&a.hex("group")?).map_err(cerr)?),
            "prepareGroup" => {
                let content: Content = serde_json::from_str(&a.text("contentJson")?).map_err(|_| malformed())?;
                reqs(&c.prepare_group_id(&a.hex("group")?, &content, op_id(a.se("opId"))?).map_err(cerr)?)
            }
            "shareInviteLinks" => reqs(&c.share_invite_links(&a.hex("group")?, &a.strings("linksJson")?, &a.strings("recipientsJson")?).map_err(cerr)?),
            "takeSharedInvites" => {
                Value::Array(c.take_shared_invites().into_iter().map(|(g, url)| json!({"group": hex::encode(g), "url": url})).collect())
            }

            // ── L2 ──
            "l2SetDirect" => reqs(&c.l2_set_direct_id(a.s("peer")?, a.flag("enabled")?, op_id(a.se("opId"))?).map_err(cerr)?),
            "l2Direct" => parsed(l2_view_json(&c.l2_direct(a.s("peer")?))),
            "l2Group" => parsed(l2_view_json(&c.l2_group(&a.hex("group")?))),
            "l2SetGroupPref" => {
                c.l2_set_group_pref(&a.hex("group")?, a.flag("enabled")?);
                Value::Null
            }
            "l2ActiveChats" => {
                let (direct, groups) = c.l2_active_chats();
                json!({"direct": direct, "groups": groups.iter().map(hex::encode).collect::<Vec<_>>()})
            }
            "presenceAllowed" => json!(c.presence_allowed()),

            // ── журнал личного состояния ──
            "hasStateKey" => json!(c.state_key().is_some()),
            "ensureStateKey" => json!(self.ensure_state_key()),

            // ── планировщик (spec 010) ──
            "plannerContainer" => c.planner_container().map_or(Value::Null, |r| json!({"domain": r.domain, "id": hex::encode(&r.id)})),
            "plannerIsAttached" => json!(c.planner_is_attached()),
            "plannerHasKey" => json!(c.planner_has_key()),
            "plannerHeadSeq" => json!(c.planner_head_seq()),
            "plannerStateJson" => c.planner_state_json().map_or(Value::Null, parsed),
            "plannerCreate" => req(&c.planner_create(a.i("tsMs")?).map_err(cerr)?),
            "plannerAttach" => {
                c.planner_attach(&a.b("getResponse")?, &a.b("grantsResponse")?).map_err(cerr)?;
                Value::Null
            }
            "plannerIngestGrants" => json!(c.planner_ingest_grants(&a.b("grantsResponse")?).map_err(cerr)?),
            "plannerIngestSync" => {
                let r = c.planner_ingest_sync(&a.b("syncResponse")?).map_err(cerr)?;
                json!({"applied": r.applied, "headSeq": r.head_seq, "more": r.more, "grantsBehind": r.grants_behind, "missingEpoch": r.missing_epoch})
            }
            "plannerIngestSnapshot" => json!(c.planner_ingest_snapshot(&a.b("snapshotResponse")?).map_err(cerr)?),
            "plannerPrepareLocal" => {
                let r = c.planner_prepare_local(&a.text("changesJson")?).map_err(cerr)?;
                json!({"opId": hex::encode(&r.op_id), "op": b64(&r.op), "applied": r.applied})
            }
            "plannerApplyLocal" => json!(c.planner_apply_local(&a.b("op")?).map_err(cerr)?),
            "plannerSeal" => req(&c.planner_seal(&a.b("op")?, &a.hex("opIdHex")?, a.i("tsMs")?).map_err(cerr)?),
            "plannerSnapshotRequest" => c.planner_snapshot_request(a.i("tsMs")?).map_err(cerr)?.map_or(Value::Null, |r| req(&r)),
            "plannerSize" => json!(c.planner_size()),
            "sharePlannerWithOwnDevices" => reqs(&c.share_planner_with_own_devices().map_err(cerr)?),
            "plannerKeysExport" => c.planner_keys_export().and_then(|e| serde_json::to_value(&e).ok()).unwrap_or(Value::Null),
            "plannerKeysImport" => {
                let e: crate::client::PlannerKeysExport = serde_json::from_str(&a.text("json")?).map_err(|_| malformed())?;
                c.planner_keys_import(&e).map_err(err)?;
                Value::Null
            }

            // ── облако (spec 016); id контейнера — hex ──
            "cloudContainers" => parsed(c.cloud_containers_json()),
            "cloudDomain" => json!(hex::decode(a.s("id")?).map_or_else(|_| String::new(), |id| c.cloud_domain(&id))),
            "cloudIsAttached" => json!(c.cloud_is_attached(&a.hex("id")?)),
            "cloudHasKey" => json!(c.cloud_has_key(&a.hex("id")?)),
            "cloudHeadSeq" => json!(c.cloud_head_seq(&a.hex("id")?)),
            "cloudGrantVersion" => json!(c.cloud_grant_version(&a.hex("id")?)),
            "cloudStateJson" => c.cloud_state_json(&a.hex("id")?).map_or(Value::Null, parsed),
            "cloudCreate" => {
                let (id, r) = c.cloud_create(a.i("tsMs")?).map_err(cerr)?;
                json!({"id": hex::encode(id), "request": req(&r)})
            }
            "cloudAttach" => json!(hex::encode(c.cloud_attach(&a.b("getResponse")?, &a.b("grantsResponse")?).map_err(cerr)?)),
            "cloudForget" => {
                c.cloud_forget(&a.hex("id")?);
                Value::Null
            }
            "cloudIngestGrants" => json!(c.cloud_ingest_grants(&a.hex("id")?, &a.b("grantsResponse")?).map_err(cerr)?),
            "cloudIngestSync" => {
                let r = c.cloud_ingest_sync(&a.hex("id")?, &a.b("syncResponse")?, a.flag("strict")?).map_err(cerr)?;
                json!({"applied": r.applied, "headSeq": r.head_seq, "more": r.more, "grantsBehind": r.grants_behind, "authorsBehind": r.authors_behind, "missingEpoch": r.missing_epoch})
            }
            "cloudIngestSnapshot" => json!(c.cloud_ingest_snapshot(&a.hex("id")?, &a.b("snapshotResponse")?).map_err(cerr)?),
            "cloudPrepareLocal" => {
                let r = c.cloud_prepare_local(&a.hex("id")?, &a.text("opsJson")?).map_err(cerr)?;
                json!({"opId": hex::encode(&r.op_id), "op": b64(&r.op), "applied": r.applied})
            }
            "cloudApplyLocal" => json!(c.cloud_apply_local(&a.hex("id")?, &a.b("op")?).map_err(cerr)?),
            "cloudSeal" => req(&c.cloud_seal(&a.hex("id")?, &a.b("op")?, &a.hex("opIdHex")?, a.i("tsMs")?).map_err(cerr)?),
            "cloudSnapshotRequest" => c.cloud_snapshot_request(&a.hex("id")?, a.i("tsMs")?).map_err(cerr)?.map_or(Value::Null, |r| req(&r)),
            "cloudShareWithOwnDevices" => reqs(&c.cloud_share_with_own_devices(&a.hex("id")?).map_err(cerr)?),
            "cloudShareKeys" => reqs(&c.cloud_share_keys(&a.hex("id")?).map_err(cerr)?),
            "cloudGrant" => reqs(&c.cloud_grant(&a.hex("id")?, a.s("user")?, a.flag("write")?, a.se("inviteText"), a.i("tsMs")?).map_err(cerr)?),
            "cloudRevoke" => reqs(&c.cloud_revoke(&a.hex("id")?, a.s("user")?, a.i("tsMs")?).map_err(cerr)?),
            "cloudRotate" => reqs(&c.cloud_rotate(&a.hex("id")?, a.i("tsMs")?).map_err(cerr)?),
            "cloudLeave" => req(&c.cloud_leave(&a.hex("id")?, a.i("tsMs")?).map_err(cerr)?),
            "cloudKeysExport" => serde_json::to_value(c.cloud_keys_export()).unwrap_or_else(|_| json!([])),
            "cloudKeysImport" => {
                let e: Vec<crate::client::PlannerKeysExport> = serde_json::from_str(&a.text("json")?).map_err(|_| malformed())?;
                c.cloud_keys_import(&e).map_err(err)?;
                Value::Null
            }
            _ => return call_static(name, args),
        })
    }

    fn root_or(&self, given: Option<Vec<u8>>) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
        match (given, &self.root) {
            (Some(r), _) => Ok(zeroize::Zeroizing::new(key32(&r)?)),
            (None, Some(r)) => Ok(r.clone()),
            (None, None) => Err(err(ProtoError::NotFound)),
        }
    }

    /// Сведения группы — как `groupInfo` WASM (ENG-06: `epochStale` и после ухода устройства участника).
    fn group_info_value(&self, gid: &[u8]) -> R {
        let mut v = parsed(self.group_info(&hex::encode(gid))?);
        if self.inner.group_rekey_pending(gid) {
            v["epochStale"] = json!(true);
        }
        Ok(v)
    }
}

impl HostState {
    /// Вызов функции журнала личного состояния по имени WASM `PvState`.
    pub fn call(&mut self, name: &str, args: &Value) -> R {
        let a = Args(args);
        Ok(match name {
            "syncRequest" => json!(b64(&self.sync_request())),
            "ingest" => parsed(self.ingest(&a.b("resp")?)?),
            "snapshot" => parsed(self.snapshot()),
            "diff" => {
                let kinds = Value::from(a.strings("kinds")?).to_string();
                parsed(self.diff(&a.text("desiredJson")?, &kinds)?)
            }
            "migrate" => parsed(self.migrate(&a.text("localJson")?)?),
            "claimDue" => parsed(self.claim_due(a.i("nowMs")?)),
            "markSent" => parsed(self.mark_sent(a.s("opIdB64")?)?),
            "plannerContainerSet" => parsed(self.planner_container_set(a.s("domain")?, a.s("idHex")?)?),
            "cloudContainerSet" => parsed(self.cloud_container_set(&a.text("containerJson")?)?),
            "callSet" => parsed(self.call_set(&a.text("recordJson")?)?),
            "groupInviteSet" => parsed(self.group_invite_set(&a.text("inviteJson")?)?),
            "groupInviteRemove" => parsed(self.group_invite_remove(a.s("linkIdB64")?)?),
            "chatCleared" => parsed(self.chat_cleared(&a.text("clearedJson")?)?),
            "sentGuard" => parsed(self.sent_guard()),
            "loadSentGuard" => {
                self.load_sent_guard(&Value::from(a.strings("ids")?).to_string());
                Value::Null
            }
            _ => return Err(UNKNOWN.to_string()),
        })
    }
}

/// Функции без клиента (имена свободных функций WASM).
pub fn call_static(name: &str, args: &Value) -> R {
    let a = Args(args);
    Ok(match name {
        "version" => json!(crate::version()),
        "protoMajor" => json!(crate::PROTO_MAJOR),
        "parseInvite" => parsed(super::parse_invite(a.s("url")?)?),
        "grantWithRootBackup" => json!(b64(&super::grant_with_root_backup(&a.b("material")?, &a.b("backup")?).map_err(err)?)),
        "grantRootBackup" => opt(super::grant_root_backup(&a.b("material")?).map(|b| b64(&b))),
        "sealReport" => {
            let key: [u8; 32] = a.b("adminPublic")?.try_into().map_err(|_| missing("adminPublic"))?;
            json!(b64(&crate::report::seal_report(&a.b("plaintext")?, a.s("reporter")?, &key).map_err(err)?))
        }
        "generateRecoveryKey" => json!(super::generate_recovery_key().as_str()),
        "encodeHello" => json!(b64(&super::encode_hello(i32::try_from(a.i("channel")?).map_err(|_| missing("channel"))?, a.se("clientKind"), a.se("clientVersion")))),
        "encodeAuth" => json!(b64(&super::encode_auth(a.s("token")?))),
        "encodeRequest" => {
            let r = crate::pb::parvane::core::v2::Request {
                id: a.u("id")?,
                method: a.s("method")?.into(),
                body: a.b("body")?,
                timeout_ms: u32::try_from(a.u("timeoutMs")?).map_err(|_| missing("timeoutMs"))?,
                padding: vec![],
                dest_domain: a.se("destDomain").to_string(),
            };
            let pad = args.get("padTo").and_then(Value::as_u64).unwrap_or(0);
            let bytes = if pad > 0 {
                crate::codec::encode_request_padded(r, usize::try_from(pad).map_err(|_| missing("padTo"))?)
            } else {
                crate::codec::encode_frame(crate::pb::parvane::core::v2::frame::Kind::Request(r))
            };
            json!(b64(&bytes))
        }
        "encodePing" => json!(b64(&super::encode_ping(a.u("nonce")?))),
        "decodeFrame" => parsed(super::decode_frame(&a.b("bytes")?)?),
        "verifyServerDescriptor" => parsed(super::verify_server_descriptor(&a.b("bytes")?)?),
        "runConformanceVectors" => json!(crate::conformance::run(a.s("suite")?, &a.text("json")?)?),
        "encodeMethodRequest" => json!(b64(&super::encode_method_request(a.s("method")?, &a.text("json")?)?)),
        "decodeMethodResponse" => parsed(super::decode_method_response(a.s("method")?, &a.b("bytes")?)?),
        "encodeUploadChunk" => {
            let index = u32::try_from(a.u("index")?).map_err(|_| missing("index"))?;
            let bucket = i32::try_from(a.i("bucket")?).map_err(|_| missing("bucket"))?;
            json!(b64(&super::encode_upload_chunk(a.s("uploadId")?, index, bucket, &a.b("data")?)?))
        }
        "encodeMessage" => json!(b64(&super::encode_message(a.s("typeName")?, &a.text("json")?)?)),
        "decodeMessage" => parsed(super::decode_message(a.s("typeName")?, &a.b("bytes")?)?),
        "splitSyncResponse" => {
            let r: crate::pb::parvane::msg::v2::InboxSyncResponse = decode_checked(&a.b("bytes")?, Origin::Server).map_err(err)?;
            json!({"records": r.records.iter().map(|x| b64(&x.encode_to_vec())).collect::<Vec<_>>(), "more": r.more})
        }
        "deviceLogEntries" => json!(super::device_log_entries(&a.b("bytes")?)?),
        "parseLegacyStored" => {
            let s = crate::legacy_v1::parse_stored(&a.b("jsonBytes")?).map_err(err)?;
            let body = match &s.body {
                crate::legacy_v1::LegacyBody::Tombstone => json!({"tombstone": true}),
                crate::legacy_v1::LegacyBody::Plain(c) => json!({"plain": serde_json::to_value(c).unwrap_or(Value::Null)}),
                crate::legacy_v1::LegacyBody::Olm { ctype, sender_identity, .. } => json!({"olm": {"ctype": ctype, "senderIdentity": sender_identity}}),
                crate::legacy_v1::LegacyBody::Megolm { group, sender_identity, .. } => json!({"megolm": {"group": group, "senderIdentity": sender_identity}}),
            };
            json!({"id": s.id, "from": s.from, "to": s.to, "ts": s.ts, "replyTo": s.reply_to, "edited": s.edited, "deleted": s.deleted, "pinned": s.pinned, "body": body})
        }
        _ => return Err(UNKNOWN.to_string()),
    })
}

/// Имена WASM, которые единая точка входа сознательно не обслуживает, — с причиной (сторож паритета).
pub const NOT_ROUTED: &[(&str, &str)] = &[
    ("start", "инициализация модуля WASM (часы браузера)"),
    ("new", "конструктор — pv_client_new"),
    ("importState", "конструктор — pv_client_import"),
    ("stateSession", "создаёт сессию журнала — pv_client_state_session"),
    ("assign", "PvAnonPlanner — pv_anon_planner_*"),
    ("expired", "PvAnonPlanner — pv_anon_planner_*"),
    ("closed", "PvAnonPlanner — pv_anon_planner_*"),
    ("openCount", "PvAnonPlanner — pv_anon_planner_*"),
];
