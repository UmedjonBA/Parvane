//! Мини-сервер в памяти для тестов клиентского ядра и модели движка (журналы устройств, бандлы, ключи доставки,
//! журналы инбокса, группы) — те же проверки, что делают шарды, упрощённо. Общий для `client_flow.rs` и
//! `model_client.rs`.
#![allow(dead_code)]

use std::collections::HashMap;

use parvane_protocol::client::{Chan, OutRequest};
use parvane_protocol::codec::decode_checked;
use parvane_protocol::group::{self, SignerInfo};
use parvane_protocol::identity::DeviceLog;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{sealed_envelope::Access, GroupStateEntry, SignedOp};
use parvane_protocol::pb::parvane::group::v2 as gpb;
use parvane_protocol::pb::parvane::identity::v2 as ipb;
use parvane_protocol::pb::parvane::msg::v2::{self as mpb, inbox_record, InboxRecord};
use prost::Message;
use sha2::{Digest, Sha256};

#[derive(Default)]
pub struct Server {
    pub logs: HashMap<String, Vec<SignedOp>>,
    pub otks: HashMap<(String, String), Vec<ipb::OneTimeKey>>,
    pub fallback: HashMap<(String, String), ipb::OneTimeKey>,
    pub dk: HashMap<String, [u8; 32]>,
    pub inbox: HashMap<(String, String), Vec<InboxRecord>>,
    pub groups: HashMap<Vec<u8>, Vec<GroupStateEntry>>,
    /// Состояние групп по мере записи (как шард: прежние записи не перепроверяются по нынешним журналам).
    pub gstate: HashMap<Vec<u8>, group::GroupState>,
    /// Прежний ник → новый (spec 026).
    pub alias: HashMap<String, String>,
}

impl Server {
    pub fn log(&self, user: &str) -> DeviceLog {
        let mut l = DeviceLog::new(user).unwrap();
        for e in self.logs.get(user).into_iter().flatten() {
            l.apply(e).unwrap();
        }
        l
    }

    pub fn push(&mut self, user: &str, device: &str, item: inbox_record::Item) {
        let q = self.inbox.entry((user.into(), device.into())).or_default();
        let seq = q.len() as u64 + 1;
        q.push(InboxRecord { seq, received_ms: 0, item: Some(item) });
    }

    /// Выполнить запрос клиента `user`/`device` (для ID-методов).
    pub fn handle(&mut self, user: &str, device: &str, r: &OutRequest) {
        match r.method {
            "identity.device.log_append" => {
                let q: ipb::DeviceLogAppendRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let op = q.entry.unwrap();
                let mut l = self.log(user);
                l.apply(&op).expect("журнал");
                self.logs.entry(user.into()).or_default().push(op);
            }
            "identity.device.publish_certificate" => {
                let q: ipb::DevicePublishCertificateRequest = decode_checked(&r.body, Origin::Client).unwrap();
                if let Some(op) = q.log_entry.filter(|e| !e.body.is_empty()) {
                    let mut l = self.log(user);
                    l.apply(&op).expect("сертификат");
                    self.logs.entry(user.into()).or_default().push(op);
                }
                self.otks.entry((user.into(), device.into())).or_default().extend(q.one_time_keys);
                if let Some(f) = q.fallback_key {
                    self.fallback.insert((user.into(), device.into()), f);
                }
            }
            "identity.delivery_key.set" => {
                let q: ipb::DeliveryKeySetRequest = decode_checked(&r.body, Origin::Client).unwrap();
                self.dk.insert(user.into(), Sha256::digest(&q.delivery_key).into());
            }
            // Сигналы звонка: анонимный канал, в журнал не пишутся (D-08)
            "call.ring_sealed" | "call.signal_sealed" => assert_eq!(r.chan, Chan::Anon),
            "msg.deliver_sealed" => {
                assert_eq!(r.chan, Chan::Anon);
                let q: mpb::DeliverSealedRequest = decode_checked(&r.body, Origin::Client).unwrap();
                for e in q.envelopes {
                    let rc = e.recipient.clone().unwrap();
                    // Прежний ник ведёт на новый (spec 026)
                    let to = self.alias.get(&rc.address).cloned().unwrap_or(rc.address.clone());
                    match e.access.as_ref().unwrap() {
                        Access::DeliveryKey(k) => {
                            let h: [u8; 32] = Sha256::digest(k).into();
                            assert_eq!(Some(&h), self.dk.get(&to), "ключ доступа");
                        }
                        Access::AnonToken(_) => {}
                    }
                    self.push(&to, &rc.device_id, inbox_record::Item::Sealed(e));
                }
            }
            // Отказ по заявке: записи журнала нет, шард только снимает заявку.
            "group.request.decide" if decode_checked::<gpb::RequestDecideRequest>(&r.body, Origin::Client).unwrap().entry.is_none() => {}
            "group.state.append" | "group.epoch.publish_send_key" | "group.invite.create" | "group.invite.revoke" | "group.join" | "group.request.decide" => {
                let entry = match r.method {
                    "group.request.decide" => {
                        let q = decode_checked::<gpb::RequestDecideRequest>(&r.body, Origin::Client).unwrap();
                        assert!(q.approve, "запись журнала — только при одобрении");
                        q.entry.unwrap()
                    }
                    "group.state.append" => decode_checked::<gpb::StateAppendRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.invite.create" => decode_checked::<gpb::InviteCreateRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.invite.revoke" => decode_checked::<gpb::InviteRevokeRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    "group.join" => decode_checked::<gpb::JoinRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                    _ => decode_checked::<gpb::EpochPublishSendKeyRequest>(&r.body, Origin::Client).unwrap().entry.unwrap(),
                };
                let gid = entry.group.clone().unwrap().id;
                let resolve = |k: &[u8; 32], _: u64| {
                    self.logs.keys().find_map(|u| {
                        let l = self.log(u);
                        l.devices.values().any(|d| d.cert.olm_ed25519.as_slice() == k).then(|| SignerInfo { user: u.clone(), root_key: l.root_key })
                    })
                };
                let signer_as = |k: &[u8; 32], v: u64, a: &str| resolve(k, v).filter(|s| s.user == a);
                let root_of = |a: &str| self.logs.contains_key(a).then(|| self.log(a).root_key);
                let lookup = group::Lookup { signer_as: &signer_as, root_of: &root_of };
                let st = self.gstate.get(&gid).cloned();
                let next = group::apply_with(st.as_ref(), &entry, &resolve, Some(&lookup)).expect("запись группы");
                let before: Vec<String> = st.map(|s| s.members.keys().cloned().collect()).unwrap_or_default();
                self.groups.entry(gid.clone()).or_default().push(entry);
                self.gstate.insert(gid.clone(), next.clone());
                // Нотис всем участникам (и исключённым этой записью), как шард.
                let mut notify: Vec<String> = next.members.keys().cloned().collect();
                notify.extend(before);
                notify.sort();
                notify.dedup();
                let notice = mpb::GroupStateNotice { group: next.group.clone().into(), version: next.version };
                for m in notify {
                    for d in self.log(&m).devices.keys().cloned().collect::<Vec<_>>() {
                        self.push(&m, &d, inbox_record::Item::GroupState(notice.clone()));
                    }
                }
            }
            "msg.deliver_group" => {
                let q: mpb::DeliverGroupRequest = decode_checked(&r.body, Origin::Client).unwrap();
                let env = q.envelope.unwrap();
                let gid = env.group.clone().unwrap().id;
                // Всем участникам последнего состояния — всем устройствам.
                let st = self.gstate.get(&gid).cloned().unwrap();
                group::verify_envelope(&env, st.epoch, &st.send_public_key.unwrap()).expect("подпись эпохи");
                for m in st.members.keys() {
                    for d in self.log(m).devices.keys() {
                        self.push(m, d, inbox_record::Item::Group(env.clone()));
                    }
                }
            }
            other => panic!("мини-сервер: {other}"),
        }
    }

    /// Подсказки подписантов записей группы (как `signer_hints` шарда).
    pub fn hints(&self, gid: &[u8], after: usize) -> (Vec<GroupStateEntry>, Vec<String>) {
        let entries: Vec<GroupStateEntry> = self.groups.get(gid).map(|v| v[after.min(v.len())..].to_vec()).unwrap_or_default();
        let hints = entries
            .iter()
            .map(|e| {
                let k = e.change.as_ref().unwrap().signer_key.clone();
                self.logs.keys().find(|u| self.log(u).devices.values().any(|d| d.cert.olm_ed25519 == k)).cloned().unwrap_or_default()
            })
            .collect();
        (entries, hints)
    }

    pub fn bundle(&mut self, user: &str) -> Vec<ipb::DeviceBundle> {
        let log = self.log(user);
        let certs: HashMap<String, _> = self
            .logs
            .get(user)
            .into_iter()
            .flatten()
            .filter_map(|op| {
                let b = parvane_protocol::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
                let e = parvane_protocol::pb::parvane::core::v2::UserDeviceLogEntry::decode(b.payload.as_slice()).ok()?;
                match e.change? {
                    parvane_protocol::pb::parvane::core::v2::user_device_log_entry::Change::AddDevice(c) => {
                        let v = parvane_protocol::identity::verify_certificate(&c, Some(user)).ok()?;
                        Some((v.cert.device_id, c))
                    }
                    _ => None,
                }
            })
            .collect();
        log.devices
            .keys()
            .map(|d| ipb::DeviceBundle {
                certificate: certs.get(d).cloned(),
                one_time_key: self.otks.get_mut(&(user.into(), d.clone())).and_then(|v| v.pop()),
                fallback_key: self.fallback.get(&(user.into(), d.clone())).cloned(),
            })
            .collect()
    }
}

/// Журнал истории аккаунта в памяти (как `messenger/src/v2_history.rs`): `history.append/sync/head/get` и
/// `history.checkpoint.commit` с CAS по id точки; точка удаляет записи до `upto_seq`, кроме сегментов и сводки.
/// Ответ — `Ok(тело)` либо `Err(код ErrorCode)`.
#[derive(Default, Clone)]
pub struct HistoryJournal {
    pub records: Vec<parvane_protocol::pb::parvane::history::v1::HistoryRecord>,
    pub checkpoint: Option<parvane_protocol::pb::parvane::history::v1::Checkpoint>,
    pub head: u64,
    /// Время, которое сервер ставит точке (`created_ms`).
    pub now_ms: i64,
}

impl HistoryJournal {
    pub fn append(&mut self, a: &parvane_protocol::pb::parvane::history::v1::AppendRequest) -> u64 {
        if let Some(r) = self.records.iter().find(|r| r.op_id == a.op_id) {
            return r.seq;
        }
        self.head += 1;
        self.records.push(parvane_protocol::pb::parvane::history::v1::HistoryRecord {
            seq: self.head,
            op_id: a.op_id.clone(),
            aead_ciphertext: a.aead_ciphertext.clone(),
            chunk: a.chunk,
        });
        self.head
    }

    pub fn commit(&mut self, r: &parvane_protocol::pb::parvane::history::v1::CommitRequest) -> Result<u64, i32> {
        use parvane_protocol::pb::parvane::core::v2::ErrorCode;
        let cur = self.checkpoint.as_ref().map_or(0, |c| c.id);
        if cur != r.expected_checkpoint_id {
            return Err(ErrorCode::Duplicate as i32);
        }
        let mut keep: std::collections::BTreeSet<u64> = r.chunk_seqs.iter().copied().collect();
        keep.insert(r.summary_seq);
        let chunks: std::collections::BTreeSet<u64> = self.records.iter().filter(|x| x.chunk).map(|x| x.seq).collect();
        if r.upto_seq > self.head || !keep.iter().all(|s| chunks.contains(s) && *s <= r.upto_seq) {
            return Err(ErrorCode::Invalid as i32);
        }
        self.records.retain(|x| x.seq > r.upto_seq || keep.contains(&x.seq));
        let id = cur + 1;
        self.checkpoint = Some(parvane_protocol::pb::parvane::history::v1::Checkpoint {
            id,
            upto_seq: r.upto_seq,
            summary_seq: r.summary_seq,
            chunk_seqs: r.chunk_seqs.clone(),
            created_ms: self.now_ms,
        });
        Ok(id)
    }

    pub fn handle(&mut self, method: &str, body: &[u8]) -> Result<Vec<u8>, i32> {
        use parvane_protocol::pb::parvane::history::v1 as h;
        Ok(match method {
            "history.append" => h::AppendResponse { seq: self.append(&h::AppendRequest::decode(body).unwrap()) }.encode_to_vec(),
            "history.head" => h::HeadResponse { head_seq: self.head, checkpoint: self.checkpoint.clone() }.encode_to_vec(),
            "history.get" => {
                let q = h::GetRequest::decode(body).unwrap();
                h::GetResponse { records: self.records.iter().filter(|r| q.seqs.contains(&r.seq)).cloned().collect() }.encode_to_vec()
            }
            "history.sync" => {
                let q = h::SyncRequest::decode(body).unwrap();
                let upto = self.checkpoint.as_ref().map_or(0, |c| c.upto_seq);
                let compacted = self.checkpoint.clone().filter(|_| q.after_seq < upto);
                let after = if compacted.is_some() { upto } else { q.after_seq };
                let records = self.records.iter().filter(|r| r.seq > after && !(q.skip_chunks && r.chunk)).cloned().collect();
                h::SyncResponse { records, more: false, head_seq: self.head, compacted }.encode_to_vec()
            }
            "history.checkpoint.commit" => h::CommitResponse { checkpoint_id: self.commit(&h::CommitRequest::decode(body).unwrap())? }.encode_to_vec(),
            m => panic!("журнал истории: {m}"),
        })
    }
}
