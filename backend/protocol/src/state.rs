//! Личное состояние пользователя (R10, T097; правило STATE-1).
//!
//! Журнал `state` пользователя — записи `StateRecord`, каждая несёт
//! `StateOp`, зашифрованную ChaCha20-Poly1305 на ключе личного состояния
//! (32 байта, общий для устройств пользователя; новому устройству передаётся
//! сообщением `StateKeyShare` внутри E2E при линковке/восстановлении). Сервер
//! видит только шифртекст и `op_id`.
//!
//! Формат `aead_ciphertext` записи: `nonce (12 случайных байт) ‖ шифртекст ‖ тег`,
//! AAD = `"parvane/v2/state\0" ‖ user ‖ op_id` (op_id — ровно 16 байт в конце,
//! поэтому граница однозначна). Запись, перенесённая в чужой журнал или под
//! другой op_id, не расшифровывается.
//!
//! Сведение (STATE-1): каждый объект — LWW-регистр или LWW-карта. Метка
//! операции — `(lamport, device_id, op_id, sha256(байты операции))`, побеждает
//! большая; удаление — надгробие с меткой. Отметка «отложенное отправлено» —
//! множество только на рост и побеждает любую метку. Поэтому итог не зависит
//! от порядка, повторов и разбиения записей на порции.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use prost::Message;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::UserRef;
use crate::pb::parvane::state::v1::{
    peer, state_op::Op, AppendRequest, BlockEntry, CallRecord, ChatCleared, Draft, Folder, FolderOrder, NotifyDefaults, Peer,
    PeerKey, PeerNotify, PinList, PinnedOrder, ScheduledMessage, ScheduledRef, StateKeyShare, StateOp, StateRecord, StateSnapshot,
};

/// Длина ключа личного состояния.
pub const STATE_KEY_LEN: usize = 32;
/// Длина nonce в начале `aead_ciphertext`.
pub const NONCE_LEN: usize = 12;
/// Длина тега Poly1305.
pub const TAG_LEN: usize = 16;
/// Длина op_id (UUIDv7).
pub const OP_ID_LEN: usize = 16;
/// Префикс AAD записи.
pub const AAD_PREFIX: &[u8] = b"parvane/v2/state\0";
/// Потолок `aead_ciphertext` (как в схеме `AppendRequest`).
pub const MAX_RECORD: usize = 262_144;
/// Потолок лампорт-метки: 2^53 − 1 (точно представимо в JS у web-обвязки);
/// запись с большей меткой отвергается, чтобы ни одно устройство не упёрлось
/// в переполнение часов.
pub const MAX_LAMPORT: u64 = (1 << 53) - 1;
/// Зарезервированные id папок: 0 — «все чаты», 1 — архив.
const RESERVED_FOLDER_IDS: [u32; 2] = [0, 1];

type OpId = [u8; OP_ID_LEN];

// ---------------------------------------------------------------------------
// Ключ личного состояния.

/// Ключ личного состояния (стирается из памяти при удалении).
#[derive(Clone)]
pub struct StateKey(Zeroizing<[u8; STATE_KEY_LEN]>);

impl fmt::Debug for StateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StateKey(…)")
    }
}

impl StateKey {
    /// Новый случайный ключ (первое устройство пользователя).
    pub fn generate() -> Self {
        let mut k = Zeroizing::new([0u8; STATE_KEY_LEN]);
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, k.as_mut());
        StateKey(k)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let arr: [u8; STATE_KEY_LEN] = bytes.try_into().map_err(|_| ProtoError::InvalidField("state_key"))?;
        Ok(StateKey(Zeroizing::new(arr)))
    }

    pub fn as_bytes(&self) -> &[u8; STATE_KEY_LEN] {
        &self.0
    }

    /// Обёртка для передачи новому устройству (кладётся в E2E-сообщение).
    pub fn to_share(&self, user: &str, key_version: u32) -> Result<StateKeyShare> {
        if !address::is_valid_address(user) {
            return Err(ProtoError::BadAddress);
        }
        Ok(StateKeyShare { user: Some(UserRef { address: user.to_string() }), state_key: self.0.to_vec(), key_version })
    }

    /// Принять обёртку: ключ должен быть для `expected_user` (свой аккаунт).
    /// Возвращает ключ и его версию.
    pub fn from_share(share: &StateKeyShare, expected_user: &str) -> Result<(Self, u32)> {
        let user = share.user.as_ref().ok_or(ProtoError::InvalidField("user"))?;
        address::check_user(user)?;
        if user.address != expected_user {
            return Err(ProtoError::ContextMismatch);
        }
        Ok((StateKey::from_bytes(&share.state_key)?, share.key_version))
    }

    fn cipher(&self) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(self.0.as_ref()))
    }
}

/// AAD записи: `"parvane/v2/state\0" ‖ user ‖ op_id`.
pub fn record_aad(user: &str, op_id: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + user.len() + op_id.len());
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(user.as_bytes());
    aad.extend_from_slice(op_id);
    aad
}

// ---------------------------------------------------------------------------
// Шифрование записей.

/// Зашифровать операцию в запрос `state.append`.
pub fn seal_op(key: &StateKey, user: &str, op: &StateOp) -> Result<AppendRequest> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    check_header(op)?;
    let pt = Zeroizing::new(op.encode_to_vec());
    if NONCE_LEN + pt.len() + TAG_LEN > MAX_RECORD {
        return Err(ProtoError::FieldLimit("aead_ciphertext"));
    }
    let mut nonce = [0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let ct = key
        .cipher()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &pt, aad: &record_aad(user, &op.op_id) })
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(AppendRequest { op_id: op.op_id.clone(), aead_ciphertext: out })
}

/// Расшифровать запись журнала и проверить, что операция принадлежит ей:
/// тег сходится (ключ, user, op_id в AAD), op_id внутри совпадает с op_id
/// записи, заголовок операции корректен.
pub fn open_record(key: &StateKey, user: &str, op_id: &[u8], aead_ciphertext: &[u8]) -> Result<StateOp> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    if op_id.len() != OP_ID_LEN {
        return Err(ProtoError::InvalidField("op_id"));
    }
    if aead_ciphertext.len() > MAX_RECORD {
        return Err(ProtoError::FieldLimit("aead_ciphertext"));
    }
    if aead_ciphertext.len() < NONCE_LEN + TAG_LEN {
        return Err(ProtoError::Crypto);
    }
    let (nonce, ct) = aead_ciphertext.split_at(NONCE_LEN);
    let pt = Zeroizing::new(
        key.cipher()
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &record_aad(user, op_id) })
            .map_err(|_| ProtoError::Crypto)?,
    );
    let op: StateOp = decode_checked(&pt, Origin::Client)?;
    if op.op_id != op_id {
        return Err(ProtoError::ContextMismatch);
    }
    check_header(&op)?;
    Ok(op)
}

/// То же для записи из `state.sync`.
pub fn open_state_record(key: &StateKey, user: &str, rec: &StateRecord) -> Result<StateOp> {
    open_record(key, user, &rec.op_id, &rec.aead_ciphertext)
}

// ---------------------------------------------------------------------------
// Лампорт-часы и построение операций.

/// Лампорт-часы устройства. После загрузки журнала — `observe(state.max_lamport())`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LamportClock {
    last: u64,
}

impl LamportClock {
    pub fn new(last: u64) -> Self {
        LamportClock { last }
    }

    pub fn last(&self) -> u64 {
        self.last
    }

    /// Учесть увиденную метку.
    pub fn observe(&mut self, lamport: u64) {
        self.last = self.last.max(lamport);
    }

    /// Метка для новой операции (строго больше всех увиденных).
    pub fn tick(&mut self) -> Result<u64> {
        let next = self.last.checked_add(1).filter(|v| *v <= MAX_LAMPORT).ok_or(ProtoError::InvalidField("lamport"))?;
        self.last = next;
        Ok(next)
    }
}

/// Новый op_id (UUIDv7).
pub fn new_op_id() -> OpId {
    uuid::Uuid::now_v7().into_bytes()
}

/// Построить операцию с заданным op_id.
pub fn make_op_with_id(clock: &mut LamportClock, device_id: &str, ts_ms: i64, op_id: OpId, op: Op) -> Result<StateOp> {
    if !address::is_valid_device_id(device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    let lamport = clock.tick()?;
    Ok(StateOp { op_id: op_id.to_vec(), lamport, device_id: device_id.to_string(), ts_ms, op: Some(op) })
}

/// Построить операцию с новым op_id.
pub fn make_op(clock: &mut LamportClock, device_id: &str, ts_ms: i64, op: Op) -> Result<StateOp> {
    make_op_with_id(clock, device_id, ts_ms, new_op_id(), op)
}

// ---------------------------------------------------------------------------
// Сведение LWW.

/// Метка LWW: порядок полей = порядок сравнения.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Stamp {
    lamport: u64,
    device_id: String,
    op_id: OpId,
    // Последний разрыв ничьей: разные операции с одним op_id (ошибка
    // устройства) всё равно сводятся одинаково везде.
    digest: [u8; 32],
}

#[derive(Debug, Clone)]
struct Lww<V> {
    stamp: Stamp,
    // None — надгробие.
    value: Option<V>,
}

fn put<K: Ord, V>(map: &mut BTreeMap<K, Lww<V>>, key: K, stamp: &Stamp, value: Option<V>) {
    match map.get(&key) {
        Some(cur) if cur.stamp >= *stamp => {}
        _ => {
            map.insert(key, Lww { stamp: stamp.clone(), value });
        }
    }
}

fn put_reg<V>(reg: &mut Option<Lww<V>>, stamp: &Stamp, value: V) {
    match reg {
        Some(cur) if cur.stamp >= *stamp => {}
        _ => *reg = Some(Lww { stamp: stamp.clone(), value: Some(value) }),
    }
}

fn live<K, V: Clone>(map: &BTreeMap<K, Lww<V>>) -> Vec<V> {
    map.values().filter_map(|e| e.value.clone()).collect()
}

/// Сведённое личное состояние. Применение операций коммутативно,
/// ассоциативно и идемпотентно (STATE-1).
#[derive(Debug, Clone, Default)]
pub struct PersonalState {
    folders: BTreeMap<u32, Lww<Folder>>,
    folder_order: Option<Lww<FolderOrder>>,
    blocked: BTreeMap<String, Lww<BlockEntry>>,
    notify: BTreeMap<String, Lww<PeerNotify>>,
    notify_defaults: Option<Lww<NotifyDefaults>>,
    drafts: BTreeMap<String, Lww<Draft>>,
    scheduled: BTreeMap<OpId, Lww<ScheduledMessage>>,
    scheduled_sent: BTreeSet<OpId>,
    archived: BTreeMap<String, Lww<Peer>>,
    pinned: BTreeMap<i32, Lww<PinnedOrder>>,
    calls: BTreeMap<OpId, Lww<CallRecord>>,
    // Граница очистки чата: только растёт (max), метка LWW не нужна.
    cleared: BTreeMap<String, ChatCleared>,
    max_lamport: u64,
}

fn op_id16(b: &[u8], field: &'static str) -> Result<OpId> {
    b.try_into().map_err(|_| ProtoError::InvalidField(field))
}

fn check_header(op: &StateOp) -> Result<()> {
    op_id16(&op.op_id, "op_id")?;
    if op.lamport == 0 || op.lamport > MAX_LAMPORT {
        return Err(ProtoError::InvalidField("lamport"));
    }
    if !address::is_valid_device_id(&op.device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    Ok(())
}

/// Каноничный ключ собеседника: `u:<адрес>` или `g:<домен>:<hex id>`.
pub fn peer_key(p: &Peer) -> Result<String> {
    match &p.kind {
        Some(peer::Kind::User(u)) => {
            address::check_user(u)?;
            Ok(format!("u:{}", u.address))
        }
        Some(peer::Kind::Group(r)) => {
            address::check_ref(r)?;
            let hex: String = r.id.iter().map(|b| format!("{b:02x}")).collect();
            Ok(format!("g:{}:{hex}", r.domain))
        }
        None => Err(ProtoError::InvalidField("peer")),
    }
}

fn opt_peer_key(p: &Option<Peer>) -> Result<String> {
    peer_key(p.as_ref().ok_or(ProtoError::InvalidField("peer"))?)
}

fn check_peers(list: &[Peer]) -> Result<()> {
    list.iter().try_for_each(|p| peer_key(p).map(|_| ()))
}

fn check_folder(f: &Folder) -> Result<()> {
    if RESERVED_FOLDER_IDS.contains(&f.id) {
        return Err(ProtoError::InvalidField("folder.id"));
    }
    check_peers(&f.include_peers)?;
    check_peers(&f.exclude_peers)?;
    check_peers(&f.pinned_peers)
}

fn pin_list(list: i32) -> Result<i32> {
    match PinList::try_from(list) {
        Ok(PinList::Main) | Ok(PinList::Archive) => Ok(list),
        _ => Err(ProtoError::InvalidField("pinned.list")),
    }
}

impl PersonalState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Наибольшая увиденная лампорт-метка (для `LamportClock::observe`).
    pub fn max_lamport(&self) -> u64 {
        self.max_lamport
    }

    /// Применить операцию. Некорректная операция отвергается целиком и не
    /// меняет состояние (одинаково на всех устройствах). Неизвестный вид
    /// (`op` = None) — пропускается, метка учитывается.
    pub fn apply(&mut self, op: &StateOp) -> Result<()> {
        check_header(op)?;
        let stamp = Stamp {
            lamport: op.lamport,
            device_id: op.device_id.clone(),
            op_id: op_id16(&op.op_id, "op_id")?,
            digest: Sha256::digest(op.encode_to_vec()).into(),
        };
        match &op.op {
            None => {}
            Some(Op::FolderSet(f)) => {
                check_folder(f)?;
                put(&mut self.folders, f.id, &stamp, Some(f.clone()));
            }
            Some(Op::FolderRemove(r)) => {
                if RESERVED_FOLDER_IDS.contains(&r.id) {
                    return Err(ProtoError::InvalidField("folder.id"));
                }
                put(&mut self.folders, r.id, &stamp, None);
            }
            Some(Op::FolderOrder(o)) => put_reg(&mut self.folder_order, &stamp, o.clone()),
            Some(Op::BlockSet(b)) => {
                let k = opt_peer_key(&b.peer)?;
                put(&mut self.blocked, k, &stamp, Some(b.clone()));
            }
            Some(Op::BlockRemove(p)) => {
                let k = opt_peer_key(&p.peer)?;
                put(&mut self.blocked, k, &stamp, None);
            }
            Some(Op::NotifySet(n)) => {
                let k = opt_peer_key(&n.peer)?;
                let mut n = n.clone();
                n.settings.get_or_insert_with(Default::default);
                put(&mut self.notify, k, &stamp, Some(n));
            }
            Some(Op::NotifyRemove(p)) => {
                let k = opt_peer_key(&p.peer)?;
                put(&mut self.notify, k, &stamp, None);
            }
            Some(Op::NotifyDefaults(d)) => put_reg(&mut self.notify_defaults, &stamp, d.clone()),
            Some(Op::DraftSet(d)) => {
                let k = opt_peer_key(&d.peer)?;
                if !d.reply_to_op_id.is_empty() && d.reply_to_op_id.len() != OP_ID_LEN {
                    return Err(ProtoError::InvalidField("reply_to_op_id"));
                }
                put(&mut self.drafts, k, &stamp, Some(d.clone()));
            }
            Some(Op::DraftRemove(p)) => {
                let k = opt_peer_key(&p.peer)?;
                put(&mut self.drafts, k, &stamp, None);
            }
            Some(Op::ScheduledSet(s)) => {
                let id = op_id16(&s.op_id, "scheduled.op_id")?;
                opt_peer_key(&s.peer)?;
                if s.send_at_ms <= 0 {
                    return Err(ProtoError::InvalidField("send_at_ms"));
                }
                if s.content.is_empty() {
                    return Err(ProtoError::InvalidField("content"));
                }
                put(&mut self.scheduled, id, &stamp, Some(s.clone()));
            }
            Some(Op::ScheduledRemove(r)) => {
                let id = op_id16(&r.op_id, "scheduled.op_id")?;
                put(&mut self.scheduled, id, &stamp, None);
            }
            Some(Op::ScheduledSent(r)) => {
                let id = op_id16(&r.op_id, "scheduled.op_id")?;
                self.scheduled_sent.insert(id);
            }
            Some(Op::ArchiveSet(p)) => {
                let peer = p.peer.clone().ok_or(ProtoError::InvalidField("peer"))?;
                let k = peer_key(&peer)?;
                put(&mut self.archived, k, &stamp, Some(peer));
            }
            Some(Op::ArchiveRemove(p)) => {
                let k = opt_peer_key(&p.peer)?;
                put(&mut self.archived, k, &stamp, None);
            }
            Some(Op::PinnedOrder(o)) => {
                let list = pin_list(o.list)?;
                check_peers(&o.peers)?;
                put(&mut self.pinned, list, &stamp, Some(o.clone()));
            }
            Some(Op::CallSet(c)) => {
                let id = op_id16(&c.call_id, "call_id")?;
                opt_peer_key(&c.peer)?;
                put(&mut self.calls, id, &stamp, Some(c.clone()));
            }
            Some(Op::CallRemove(r)) => {
                let id = op_id16(&r.call_id, "call_id")?;
                put(&mut self.calls, id, &stamp, None);
            }
            Some(Op::ChatCleared(c)) => {
                let k = opt_peer_key(&c.peer)?;
                if c.cleared_until_ms <= 0 {
                    return Err(ProtoError::InvalidField("cleared_until_ms"));
                }
                match self.cleared.get(&k) {
                    Some(cur) if cur.cleared_until_ms >= c.cleared_until_ms => {}
                    _ => {
                        self.cleared.insert(k, c.clone());
                    }
                }
            }
        }
        self.max_lamport = self.max_lamport.max(op.lamport);
        Ok(())
    }

    /// Применить все операции; возвращает индексы отвергнутых.
    pub fn apply_all<'a>(&mut self, ops: impl IntoIterator<Item = &'a StateOp>) -> Vec<usize> {
        ops.into_iter().enumerate().filter_map(|(i, op)| self.apply(op).err().map(|_| i)).collect()
    }

    /// Каноничный снимок сведённого состояния (карты — по возрастанию ключа).
    pub fn snapshot(&self) -> StateSnapshot {
        StateSnapshot {
            folders: live(&self.folders),
            folder_order: self.folder_order.as_ref().and_then(|e| e.value.clone()),
            blocked: live(&self.blocked),
            notify: live(&self.notify),
            notify_defaults: self.notify_defaults.as_ref().and_then(|e| e.value.clone()),
            drafts: live(&self.drafts),
            scheduled: self.pending_scheduled().cloned().collect(),
            scheduled_sent: self.scheduled_sent.iter().map(|id| id.to_vec()).collect(),
            archived: live(&self.archived),
            pinned: live(&self.pinned),
            calls: live(&self.calls),
            cleared: self.cleared.values().cloned().collect(),
        }
    }

    /// Отложенные, ещё не отмеченные отправленными.
    fn pending_scheduled(&self) -> impl Iterator<Item = &ScheduledMessage> {
        self.scheduled
            .iter()
            .filter(|(id, _)| !self.scheduled_sent.contains(*id))
            .filter_map(|(_, e)| e.value.as_ref())
    }

    /// Отмечено ли отложенное отправленным (по журналу).
    pub fn is_scheduled_sent(&self, op_id: &[u8]) -> bool {
        op_id16(op_id, "op_id").is_ok_and(|id| self.scheduled_sent.contains(&id))
    }

    /// Какие отложенные ЭТО устройство должно отправить сейчас («первое
    /// устройство, заметившее срок»): срок наступил, в журнале нет отметки
    /// об отправке, и устройство ещё не отправляло этот op_id (`guard`). Каждое
    /// возвращённое сразу записывается в `guard` — повторный вызов его не
    /// вернёт. Отправлять сообщение с `op_id` отложенного (дубль от другого
    /// устройства отсекается по op_id), затем дописать в журнал
    /// `scheduled_sent`. Порядок — по (send_at_ms, op_id).
    pub fn claim_due(&self, now_ms: i64, guard: &mut SendGuard) -> Vec<ScheduledMessage> {
        let mut due: Vec<&ScheduledMessage> = self.pending_scheduled().filter(|s| s.send_at_ms <= now_ms).collect();
        due.sort_by(|a, b| (a.send_at_ms, &a.op_id).cmp(&(b.send_at_ms, &b.op_id)));
        due.into_iter().filter(|s| guard.claim(&s.op_id)).cloned().collect()
    }
}

/// Локальный (не синхронизируемый) журнал op_id отложенных, которые это
/// устройство уже отправило. Хранится клиентом на диске.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendGuard {
    sent: BTreeSet<OpId>,
}

impl SendGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Восстановить с диска (некорректные op_id пропускаются).
    pub fn from_list<'a>(ids: impl IntoIterator<Item = &'a [u8]>) -> Self {
        SendGuard { sent: ids.into_iter().filter_map(|b| op_id16(b, "op_id").ok()).collect() }
    }

    pub fn to_list(&self) -> Vec<Vec<u8>> {
        self.sent.iter().map(|id| id.to_vec()).collect()
    }

    /// true — op_id отправляется впервые (и теперь отмечен); false — повтор,
    /// не отправлять.
    pub fn claim(&mut self, op_id: &[u8]) -> bool {
        match op_id16(op_id, "op_id") {
            Ok(id) => self.sent.insert(id),
            Err(_) => false,
        }
    }

    pub fn contains(&self, op_id: &[u8]) -> bool {
        op_id16(op_id, "op_id").is_ok_and(|id| self.sent.contains(&id))
    }
}

// ---------------------------------------------------------------------------
// Миграция локальных данных.

/// Построить начальные операции журнала из локального снимка (данные v1 при
/// первом запуске). Записи, которые не прошли бы проверку `apply` или не
/// уместились бы в запись журнала, пропускаются — миграция не падает из-за
/// одной испорченной записи. `next_op_id` — источник op_id.
pub fn migrate_snapshot_with(
    snapshot: &StateSnapshot,
    device_id: &str,
    clock: &mut LamportClock,
    ts_ms: i64,
    mut next_op_id: impl FnMut() -> OpId,
) -> Result<Vec<StateOp>> {
    if !address::is_valid_device_id(device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    let mut kinds: Vec<Op> = Vec::new();
    kinds.extend(snapshot.folders.iter().cloned().map(Op::FolderSet));
    kinds.extend(snapshot.folder_order.clone().map(Op::FolderOrder));
    kinds.extend(snapshot.blocked.iter().cloned().map(Op::BlockSet));
    kinds.extend(snapshot.notify.iter().cloned().map(Op::NotifySet));
    kinds.extend(snapshot.notify_defaults.clone().map(Op::NotifyDefaults));
    kinds.extend(snapshot.drafts.iter().cloned().map(Op::DraftSet));
    kinds.extend(snapshot.scheduled.iter().cloned().map(Op::ScheduledSet));
    kinds.extend(
        snapshot
            .scheduled_sent
            .iter()
            .map(|id| Op::ScheduledSent(ScheduledRef { op_id: id.clone() })),
    );
    kinds.extend(
        snapshot
            .archived
            .iter()
            .map(|p| Op::ArchiveSet(PeerKey { peer: Some(p.clone()) })),
    );
    kinds.extend(snapshot.pinned.iter().cloned().map(Op::PinnedOrder));
    kinds.extend(snapshot.calls.iter().cloned().map(Op::CallSet));
    kinds.extend(snapshot.cleared.iter().cloned().map(Op::ChatCleared));

    let mut scratch = PersonalState::new();
    let mut out = Vec::with_capacity(kinds.len());
    for kind in kinds {
        let mut probe = *clock;
        let op = make_op_with_id(&mut probe, device_id, ts_ms, next_op_id(), kind)?;
        if NONCE_LEN + op.encoded_len() + TAG_LEN > MAX_RECORD || scratch.apply(&op).is_err() {
            continue;
        }
        *clock = probe;
        out.push(op);
    }
    Ok(out)
}

/// То же с op_id UUIDv7.
pub fn migrate_snapshot(snapshot: &StateSnapshot, device_id: &str, clock: &mut LamportClock, ts_ms: i64) -> Result<Vec<StateOp>> {
    migrate_snapshot_with(snapshot, device_id, clock, ts_ms, new_op_id)
}

// ---------------------------------------------------------------------------
// Изменения хоста как операции журнала.

/// Какие виды объектов ведёт хост (остальные — не трогаются разницей).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Managed {
    pub folders: bool,
    pub blocked: bool,
    pub notify: bool,
    pub drafts: bool,
    pub scheduled: bool,
    pub archived: bool,
    pub pinned: bool,
}

impl Managed {
    /// Из списка имён (`folders`, `blocked`, `notify`, `drafts`, `scheduled`,
    /// `archived`, `pinned`); незнакомые имена пропускаются.
    pub fn from_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Self {
        let mut m = Managed::default();
        for n in names {
            match n {
                "folders" => m.folders = true,
                "blocked" => m.blocked = true,
                "notify" => m.notify = true,
                "drafts" => m.drafts = true,
                "scheduled" => m.scheduled = true,
                "archived" => m.archived = true,
                "pinned" => m.pinned = true,
                _ => {}
            }
        }
        m
    }
}

fn keyed<V: Clone>(list: &[V], key: impl Fn(&V) -> Option<String>) -> BTreeMap<String, V> {
    list.iter().filter_map(|v| key(v).map(|k| (k, v.clone()))).collect()
}

/// Операции, переводящие сведённое состояние `current` в желаемое хостом
/// `desired` по управляемым видам: новое или изменённое — запись, пропавшее —
/// надгробие. Отметки «отправлено» и история звонков разницей не меняются
/// (только явными операциями). Записи, которые `apply` отверг бы, пропускаются.
pub fn diff_ops(current: &StateSnapshot, desired: &StateSnapshot, m: Managed) -> Vec<Op> {
    let mut out = Vec::new();
    let pk = |p: &Option<Peer>| p.as_ref().and_then(|p| peer_key(p).ok());
    if m.folders {
        let cur: BTreeMap<u32, &Folder> = current.folders.iter().map(|f| (f.id, f)).collect();
        let want: BTreeMap<u32, &Folder> = desired.folders.iter().filter(|f| check_folder(f).is_ok()).map(|f| (f.id, f)).collect();
        for (id, f) in &want {
            if cur.get(id) != Some(f) {
                out.push(Op::FolderSet((*f).clone()));
            }
        }
        for id in cur.keys().filter(|id| !want.contains_key(id)) {
            out.push(Op::FolderRemove(crate::pb::parvane::state::v1::FolderRef { id: *id }));
        }
        let want_order = desired.folder_order.clone().unwrap_or_default();
        if current.folder_order.clone().unwrap_or_default() != want_order {
            out.push(Op::FolderOrder(want_order));
        }
    }
    if m.blocked {
        let cur = keyed(&current.blocked, |b| pk(&b.peer));
        let want = keyed(&desired.blocked, |b| pk(&b.peer));
        for (k, b) in &want {
            if !cur.contains_key(k) {
                out.push(Op::BlockSet(b.clone()));
            }
        }
        for (k, b) in &cur {
            if !want.contains_key(k) {
                out.push(Op::BlockRemove(PeerKey { peer: b.peer.clone() }));
            }
        }
    }
    if m.notify {
        let cur = keyed(&current.notify, |n| pk(&n.peer));
        let want = keyed(&desired.notify, |n| pk(&n.peer));
        for (k, n) in &want {
            let mut n = n.clone();
            n.settings.get_or_insert_with(Default::default);
            if cur.get(k) != Some(&n) {
                out.push(Op::NotifySet(n));
            }
        }
        for (k, n) in &cur {
            if !want.contains_key(k) {
                out.push(Op::NotifyRemove(PeerKey { peer: n.peer.clone() }));
            }
        }
        let want_d = desired.notify_defaults.clone().unwrap_or_default();
        if current.notify_defaults.clone().unwrap_or_default() != want_d {
            out.push(Op::NotifyDefaults(want_d));
        }
    }
    if m.drafts {
        let cur = keyed(&current.drafts, |d| pk(&d.peer));
        let want = keyed(&desired.drafts, |d| pk(&d.peer));
        for (k, d) in &want {
            if cur.get(k) != Some(d) {
                out.push(Op::DraftSet(d.clone()));
            }
        }
        for (k, d) in &cur {
            if !want.contains_key(k) {
                out.push(Op::DraftRemove(PeerKey { peer: d.peer.clone() }));
            }
        }
    }
    if m.scheduled {
        let cur: BTreeMap<Vec<u8>, &ScheduledMessage> = current.scheduled.iter().map(|x| (x.op_id.clone(), x)).collect();
        let want: BTreeMap<Vec<u8>, &ScheduledMessage> = desired.scheduled.iter().map(|x| (x.op_id.clone(), x)).collect();
        for (id, x) in &want {
            if cur.get(id) != Some(x) && !current.scheduled_sent.contains(id) {
                out.push(Op::ScheduledSet((*x).clone()));
            }
        }
        for id in cur.keys().filter(|id| !want.contains_key(*id)) {
            out.push(Op::ScheduledRemove(ScheduledRef { op_id: id.clone() }));
        }
    }
    if m.archived {
        let cur = keyed(&current.archived, |p| peer_key(p).ok());
        let want = keyed(&desired.archived, |p| peer_key(p).ok());
        for (k, p) in &want {
            if !cur.contains_key(k) {
                out.push(Op::ArchiveSet(PeerKey { peer: Some(p.clone()) }));
            }
        }
        for (k, p) in &cur {
            if !want.contains_key(k) {
                out.push(Op::ArchiveRemove(PeerKey { peer: Some(p.clone()) }));
            }
        }
    }
    if m.pinned {
        for list in [PinList::Main as i32, PinList::Archive as i32] {
            let cur = current.pinned.iter().find(|o| o.list == list).map(|o| o.peers.clone()).unwrap_or_default();
            let want = desired.pinned.iter().find(|o| o.list == list).map(|o| o.peers.clone()).unwrap_or_default();
            if cur != want && check_peers(&want).is_ok() {
                out.push(Op::PinnedOrder(PinnedOrder { list, peers: want }));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::state::v1::FolderRef;

    fn user(a: &str) -> Peer {
        Peer { kind: Some(peer::Kind::User(UserRef { address: a.into() })) }
    }

    #[test]
    fn seal_open_roundtrip_and_context() {
        let key = StateKey::generate();
        let mut clock = LamportClock::default();
        let op = make_op(&mut clock, "d1", 1, Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 5 })).unwrap();
        let rec = seal_op(&key, "alice@x", &op).unwrap();
        assert_eq!(open_record(&key, "alice@x", &rec.op_id, &rec.aead_ciphertext).unwrap(), op);
        assert_eq!(open_record(&key, "eve@x", &rec.op_id, &rec.aead_ciphertext).unwrap_err(), ProtoError::Crypto);
        let other = new_op_id();
        assert_eq!(open_record(&key, "alice@x", &other, &rec.aead_ciphertext).unwrap_err(), ProtoError::Crypto);
        let wrong = StateKey::generate();
        assert_eq!(open_record(&wrong, "alice@x", &rec.op_id, &rec.aead_ciphertext).unwrap_err(), ProtoError::Crypto);
    }

    #[test]
    fn key_share_bound_to_user() {
        let key = StateKey::generate();
        let share = key.to_share("alice@x", 1).unwrap();
        let (k2, v) = StateKey::from_share(&share, "alice@x").unwrap();
        assert_eq!(k2.as_bytes(), key.as_bytes());
        assert_eq!(v, 1);
        assert_eq!(StateKey::from_share(&share, "bob@x").unwrap_err(), ProtoError::ContextMismatch);
    }

    #[test]
    fn diff_converges_to_desired() {
        let mut s = PersonalState::new();
        let mut c = LamportClock::default();
        let seed = [
            Op::BlockSet(BlockEntry { peer: Some(user("bob@x")), blocked_at_ms: 1 }),
            Op::ArchiveSet(PeerKey { peer: Some(user("old@x")) }),
            Op::CallSet(CallRecord { call_id: vec![7; 16], peer: Some(user("bob@x")), ..Default::default() }),
        ];
        for op in seed {
            s.apply(&make_op(&mut c, "d1", 0, op).unwrap()).unwrap();
        }
        let mut desired = s.snapshot();
        desired.blocked = vec![BlockEntry { peer: Some(user("carol@x")), blocked_at_ms: 2 }];
        desired.archived.clear();
        desired.calls.clear();
        desired.pinned = vec![PinnedOrder { list: PinList::Main as i32, peers: vec![user("carol@x")] }];
        let m = Managed::from_names(["blocked", "archived", "pinned"]);
        let ops = diff_ops(&s.snapshot(), &desired, m);
        for op in ops {
            s.apply(&make_op(&mut c, "d1", 0, op).unwrap()).unwrap();
        }
        let got = s.snapshot();
        assert_eq!(got.blocked, desired.blocked);
        assert!(got.archived.is_empty());
        assert_eq!(got.pinned, desired.pinned);
        // Неуправляемое (звонки) разница не трогает.
        assert_eq!(got.calls.len(), 1);
        assert!(diff_ops(&got, &desired, m).is_empty());
    }

    #[test]
    fn clock_limits() {
        let mut c = LamportClock::new(MAX_LAMPORT);
        assert!(c.tick().is_err());
        let mut c = LamportClock::default();
        c.observe(10);
        assert_eq!(c.tick().unwrap(), 11);
    }

    #[test]
    fn reserved_folder_and_sent_sticky() {
        let mut s = PersonalState::new();
        let mut c = LamportClock::default();
        let bad = make_op(&mut c, "d1", 0, Op::FolderRemove(FolderRef { id: 0 })).unwrap();
        assert!(s.apply(&bad).is_err());
        let id = new_op_id();
        let sched = ScheduledMessage { op_id: id.to_vec(), peer: Some(user("bob@x")), send_at_ms: 10, content: vec![1] };
        let sent = make_op(&mut c, "d1", 0, Op::ScheduledSent(ScheduledRef { op_id: id.to_vec() })).unwrap();
        let later = make_op(&mut c, "d2", 0, Op::ScheduledSet(sched)).unwrap();
        s.apply(&sent).unwrap();
        s.apply(&later).unwrap();
        assert!(s.snapshot().scheduled.is_empty());
        let mut g = SendGuard::new();
        assert!(s.claim_due(100, &mut g).is_empty());
        let rm = make_op(&mut c, "d1", 0, Op::DraftRemove(PeerKey { peer: None })).unwrap();
        assert!(s.apply(&rm).is_err());
    }
}
