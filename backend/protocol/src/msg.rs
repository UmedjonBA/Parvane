//! Сообщения: сборка и проверки у получателя (T117; D-09, D-14; классы 3, 6, 7).
//!
//! Личное сообщение: `Content` → SignedOp (domain "msg", op_type "content",
//! `conversation.direct_peer`, audience) → Olm → `SealedInner{sender, olm}` →
//! HPKE (`seal.rs`). Проверки получателя — все обязательны, иначе отказ:
//! 1. сертификат отправителя валиден и устройство активно по его журналу;
//! 2. Olm-identity, которым расшифровано, == `sender.olm_curve25519`;
//! 3. SignedOp подписан `sender.olm_ed25519` (поле signer_key не доверяется);
//! 4. контекст беседы указывает на этот чат (пересылка Боб→Кэрол сообщения
//!    Алисы и повтор из группы A в B отвергаются);
//! 5. `(отправитель, op_id)` ещё не видели; в группах ещё и
//!    `(megolm_session, index)`.

use std::collections::{BTreeMap, VecDeque};

use prost::Message;
use serde::{Deserialize, Serialize};

use crate::codec::decode_checked;
use crate::content_guard;
use crate::error::{ProtoError, Result};
use crate::group::{ContextVerdict, GroupState};
use crate::identity::{verify_certificate, VerifiedDevice};
use crate::limits::Origin;
use crate::olm::OlmAccount;
use crate::pb::parvane::call::v2::CallSignal;
use crate::pb::parvane::core::v2::{
    op_header::Conversation, DeviceRef, GroupContext, GroupPlaintext, OpHeader, Ref, SealedInner,
    SignedDeviceCertificate, SignedOp, UserRef,
};
use crate::pb::parvane::msg::v2::{content, Content, Delete, Edit, MessageRef, Pin, Reaction, Receipt, ReceiptKind, Text};
use crate::sign::{self, VerifiedOp};
use crate::unknown::{self, Disposition};

pub const MSG_DOMAIN: &str = "msg";
pub const CONTENT_OP: &str = "content";
/// Сигнал звонка (D-08): тот же sealed-конверт, что у личного сообщения, но
/// домен `call` и цель — звонок; в журнал инбокса не пишется.
pub const CALL_DOMAIN: &str = "call";
pub const CALL_SIGNAL_OP: &str = "signal";
pub const CALL_ID_LEN: usize = 16;

/// Хранилище «уже видели» (персистентное у клиента; в тестах — память).
pub trait SeenStore {
    /// Вставить ключ; уже был → `Duplicate`.
    fn insert_once(&mut self, key: &[u8]) -> Result<()>;
}

impl SeenStore for crate::sign::ReplayGuard {
    fn insert_once(&mut self, key: &[u8]) -> Result<()> {
        self.check_and_insert(key)
    }
}

fn seen_key(parts: &[&[u8]]) -> Vec<u8> {
    let mut k = Vec::new();
    for p in parts {
        k.extend_from_slice(&(p.len() as u32).to_be_bytes());
        k.extend_from_slice(p);
    }
    k
}

/// Подписать содержимое личного сообщения.
pub fn sign_direct(device: &OlmAccount, content: &Content, peer: &str, audience: Vec<DeviceRef>, ts_ms: i64) -> Result<SignedOp> {
    sign_direct_with_id(device, content, peer, audience, ts_ms, sign::new_op_id())
}

/// То же с заданным `op_id` (UUIDv7 хоста — id сообщения в UI).
pub fn sign_direct_with_id(device: &OlmAccount, content: &Content, peer: &str, audience: Vec<DeviceRef>, ts_ms: i64, op_id: Vec<u8>) -> Result<SignedOp> {
    if !sign::is_valid_op_id(&op_id) {
        return Err(ProtoError::InvalidField("op_id"));
    }
    let header = OpHeader {
        domain: MSG_DOMAIN.into(),
        op_type: CONTENT_OP.into(),
        op_id,
        audience,
        ts_ms,
        conversation: Some(Conversation::DirectPeer(UserRef { address: peer.to_string() })),
        ..Default::default()
    };
    sign::sign_op(device, header, content.encode_to_vec())
}

/// Подписать сигнал звонка: цель операции — звонок (`call.id` == `signal.call_id`),
/// аудитория — устройства адресата. Привязка к цели и аудитории не даёт
/// переслать подписанный SDP в другой звонок или другому устройству (класс 6).
pub fn sign_call(device: &OlmAccount, signal: &CallSignal, call: Ref, audience: Vec<DeviceRef>, ts_ms: i64) -> Result<SignedOp> {
    if signal.call_id.len() != CALL_ID_LEN || call.id != signal.call_id {
        return Err(ProtoError::InvalidField("call_id"));
    }
    let header = OpHeader {
        domain: CALL_DOMAIN.into(),
        op_type: CALL_SIGNAL_OP.into(),
        op_id: sign::new_op_id(),
        target: Some(call),
        audience,
        ts_ms,
        ..Default::default()
    };
    sign::sign_op(device, header, signal.encode_to_vec())
}

/// Собрать внутренний слой sealed-конверта: SignedOp под Olm + сертификат.
pub fn seal_inner(sender_cert: &SignedDeviceCertificate, olm: &mut crate::olm::OlmSession, op: &SignedOp) -> Result<SealedInner> {
    let (t, ct) = olm.encrypt(&op.encode_to_vec())?;
    Ok(SealedInner { sender: Some(sender_cert.clone()), olm_message: ct, olm_type: t, padding: vec![] })
}

/// Расшифровка Olm: (identity-ключ отправителя, тип, байты) → plaintext.
pub type OlmDecrypt<'a> = dyn FnMut(&[u8; 32], u32, &[u8]) -> Result<Vec<u8>> + 'a;

/// Расшифрованное Megolm-сообщение группы.
pub struct GroupIncoming<'a> {
    pub envelope_epoch: u64,
    pub plaintext: &'a [u8],
    pub session_id: &'a str,
    pub index: u32,
}

/// Проверенное входящее сообщение.
#[derive(Debug, Clone)]
pub struct Opened {
    pub sender: VerifiedDevice,
    pub op: VerifiedOp,
    pub content: Content,
    pub disposition: Disposition,
}

fn finish(sender: VerifiedDevice, op: VerifiedOp) -> Result<Opened> {
    let mut content: Content = decode_checked(&op.payload, Origin::Client)?;
    let disposition = unknown::content_disposition(&content, &op.header.critical_fields);
    content_guard::sanitize_content(&mut content);
    Ok(Opened { sender, op, content, disposition })
}

/// Открытый сигнал звонка: отправитель проверен, подпись, аудитория и привязка
/// к звонку сошлись.
pub struct OpenedCall {
    pub sender: VerifiedDevice,
    pub op: VerifiedOp,
    pub signal: CallSignal,
}

/// Что лежало в sealed-конверте.
pub enum OpenedSealed {
    Message(Box<Opened>),
    Call(Box<OpenedCall>),
}

/// Проверить личное сообщение после снятия HPKE (сигнал звонка — отказ).
pub fn open_direct(
    inner: &SealedInner,
    me: &DeviceRef,
    device_active: &dyn Fn(&VerifiedDevice) -> bool,
    decrypt: &mut OlmDecrypt<'_>,
    seen: &mut dyn SeenStore,
) -> Result<Opened> {
    match open_sealed_op(inner, me, device_active, decrypt, seen)? {
        OpenedSealed::Message(m) => Ok(*m),
        OpenedSealed::Call(_) => Err(ProtoError::ContextMismatch),
    }
}

/// Проверить содержимое sealed-конверта после снятия HPKE: личное сообщение
/// или сигнал звонка.
///
/// `device_active` — устройство активно по журналу устройств отправителя.
/// `decrypt(identity, olm_type, bytes)` — расшифровать сессией с этим
/// identity-ключом (для pre-key — создать входящую).
pub fn open_sealed_op(
    inner: &SealedInner,
    me: &DeviceRef,
    device_active: &dyn Fn(&VerifiedDevice) -> bool,
    decrypt: &mut OlmDecrypt<'_>,
    seen: &mut dyn SeenStore,
) -> Result<OpenedSealed> {
    let cert = inner.sender.as_ref().ok_or(ProtoError::InvalidField("sender"))?;
    let sender = verify_certificate(cert, None)?;
    if !device_active(&sender) {
        return Err(ProtoError::Forbidden);
    }
    let identity = sender.olm_curve25519()?;
    if inner.olm_type == 0 && OlmAccount::prekey_sender_identity(&inner.olm_message)? != identity {
        return Err(ProtoError::BadCertificate);
    }
    let pt = decrypt(&identity, inner.olm_type, &inner.olm_message)?;
    let op: SignedOp = decode_checked(&pt, Origin::Client)?;
    let signer = sender.olm_ed25519()?;
    let v = match sign::verify_op(&op, MSG_DOMAIN, CONTENT_OP, Some(&signer)) {
        Ok(v) => v,
        Err(not_message) => {
            // Не сообщение — сигнал звонка (домен call) либо отказ с исходной ошибкой.
            let v = sign::verify_op(&op, CALL_DOMAIN, CALL_SIGNAL_OP, Some(&signer)).map_err(|_| not_message)?;
            v.require_audience(me)?;
            let signal: CallSignal = decode_checked(&v.payload, Origin::Client)?;
            // Цель операции — именно этот звонок: SDP из другого звонка не подставить.
            match &v.header.target {
                Some(t) if t.id.len() == CALL_ID_LEN && t.id == signal.call_id => {}
                _ => return Err(ProtoError::ContextMismatch),
            }
            seen.insert_once(&seen_key(&[sender.user().as_bytes(), sender.cert.device_id.as_bytes(), &v.header.op_id]))?;
            return Ok(OpenedSealed::Call(Box::new(OpenedCall { sender, op: v, signal })));
        }
    };
    // Контекст беседы: мне — direct_peer == я; копия с моего другого устройства —
    // отправитель я сам.
    let own_copy = sender.user() == me.address;
    match &v.header.conversation {
        Some(Conversation::DirectPeer(p)) if own_copy || p.address == me.address => {}
        _ => return Err(ProtoError::ContextMismatch),
    }
    v.require_audience(me)?;
    seen.insert_once(&seen_key(&[sender.user().as_bytes(), sender.cert.device_id.as_bytes(), &v.header.op_id]))?;
    finish(sender, v).map(|m| OpenedSealed::Message(Box::new(m)))
}

/// Подписать содержимое группового сообщения (с головой журнала, D-03).
pub fn sign_group(device: &OlmAccount, content: &Content, ctx: GroupContext, ts_ms: i64) -> Result<SignedOp> {
    sign_group_with_id(device, content, ctx, ts_ms, sign::new_op_id())
}

pub fn sign_group_with_id(device: &OlmAccount, content: &Content, ctx: GroupContext, ts_ms: i64, op_id: Vec<u8>) -> Result<SignedOp> {
    if !sign::is_valid_op_id(&op_id) {
        return Err(ProtoError::InvalidField("op_id"));
    }
    let header = OpHeader {
        domain: MSG_DOMAIN.into(),
        op_type: CONTENT_OP.into(),
        op_id,
        target: ctx.group.clone(),
        ts_ms,
        conversation: Some(Conversation::Group(ctx)),
        ..Default::default()
    };
    sign::sign_op(device, header, content.encode_to_vec())
}

/// Проверить групповое сообщение после Megolm-расшифровки.
/// `session_id`/`index` — из Megolm (защита от повтора индекса).
pub fn open_group(
    state: &GroupState,
    incoming: GroupIncoming<'_>,
    device_active: &dyn Fn(&VerifiedDevice) -> bool,
    now_ms: i64,
    seen: &mut dyn SeenStore,
) -> Result<Opened> {
    let GroupIncoming { envelope_epoch, plaintext, session_id, index } = incoming;
    let gp: GroupPlaintext = decode_checked(plaintext, Origin::Client)?;
    let cert = gp.sender.as_ref().ok_or(ProtoError::InvalidField("sender"))?;
    let sender = verify_certificate(cert, None)?;
    if !device_active(&sender) {
        return Err(ProtoError::Forbidden);
    }
    let op = gp.op.as_ref().ok_or(ProtoError::InvalidField("op"))?;
    let v = sign::verify_op(op, MSG_DOMAIN, CONTENT_OP, Some(&sender.olm_ed25519()?))?;
    let Some(Conversation::Group(ctx)) = &v.header.conversation else { return Err(ProtoError::ContextMismatch) };
    if ctx.epoch != envelope_epoch {
        return Err(ProtoError::ContextMismatch);
    }
    match state.check_context(ctx) {
        ContextVerdict::Ok => {}
        // D-03 (C1-03): отправитель видит более новую голову журнала — вызывающий
        // догоняет журнал (`Need::GroupLog`) и повторяет; индекс Megolm ещё не
        // отмечен, поэтому после догона сообщение откроется.
        ContextVerdict::Behind => return Err(ProtoError::BrokenChain),
        ContextVerdict::Fork | ContextVerdict::WrongGroup => return Err(ProtoError::ContextMismatch),
    }
    v.require_target(&state.group)?;
    let op_key = seen_key(&[sender.user().as_bytes(), sender.cert.device_id.as_bytes(), &v.header.op_id]);
    let opened = finish(sender, v)?;
    // Автор вправе писать по журналу (fail-closed) и по типу содержимого (GROUP-2).
    if !state.content_allowed(opened.sender.user(), &opened.content, now_ms) {
        return Err(ProtoError::Forbidden);
    }
    // «Видели» — только после всех проверок (повтор после добора возможен).
    seen.insert_once(&seen_key(&[b"megolm", session_id.as_bytes(), &index.to_be_bytes()]))?;
    seen.insert_once(&op_key)?;
    Ok(opened)
}

/// Версия журнала группы, на которую ссылается групповой plaintext (после
/// того как [`open_group`] вернул `BrokenChain` — отставание D-03; подпись к
/// этому моменту уже проверена).
pub fn group_context_version(plaintext: &[u8]) -> Option<u64> {
    let gp: GroupPlaintext = decode_checked(plaintext, Origin::Client).ok()?;
    let body: crate::pb::parvane::core::v2::OpBody = decode_checked(&gp.op?.body, Origin::Client).ok()?;
    match body.header?.conversation? {
        Conversation::Group(ctx) => Some(ctx.state_version),
        _ => None,
    }
}

/// Групповой plaintext (до Megolm).
pub fn group_plaintext(sender_cert: &SignedDeviceCertificate, op: SignedOp) -> Vec<u8> {
    GroupPlaintext { sender: Some(sender_cert.clone()), op: Some(op) }.encode_to_vec()
}

// ── квитанции и мутации как содержимое (T074, FR-035) ───────────────────────
//
// Квитанции доставки/прочтения, правки, удаления, реакции и закреп — обычное
// `Content` внутри sealed/group-конвертов: сервер не видит ни вида, ни автора.
// «Кто прочитал» в группах считается у отправителя из E2E-квитанций.

fn mref(op_id: &[u8]) -> MessageRef {
    MessageRef { op_id: op_id.to_vec() }
}

fn wrap(kind: content::Kind) -> Content {
    Content { kind: Some(kind), ..Default::default() }
}

/// Квитанция (≤ 500 сообщений за раз).
pub fn receipt(kind: ReceiptKind, messages: &[Vec<u8>]) -> Result<Content> {
    if messages.is_empty() || messages.len() > 500 {
        return Err(ProtoError::FieldLimit("messages"));
    }
    Ok(wrap(content::Kind::Receipt(Receipt { kind: kind as i32, messages: messages.iter().map(|m| mref(m)).collect() })))
}

/// Правка текста (для медиа — подписи).
pub fn edit_text(target: &[u8], text: Text) -> Content {
    wrap(content::Kind::Edit(Edit { target: Some(mref(target)), text: Some(text), location: None }))
}

pub fn delete(targets: &[Vec<u8>], for_everyone: bool) -> Result<Content> {
    if targets.is_empty() || targets.len() > 500 {
        return Err(ProtoError::FieldLimit("targets"));
    }
    Ok(wrap(content::Kind::Delete(Delete { targets: targets.iter().map(|m| mref(m)).collect(), for_everyone })))
}

pub fn reaction(target: &[u8], emoji: &str, remove: bool) -> Content {
    wrap(content::Kind::Reaction(Reaction { target: Some(mref(target)), emoji: emoji.to_string(), remove }))
}

pub fn pin(target: &[u8], unpin: bool, silent: bool) -> Content {
    wrap(content::Kind::Pin(Pin { target: Some(mref(target)), unpin, silent }))
}

/// Сообщение, для которого ведётся учёт доставки/прочтения (не служебное и не мутация).
pub fn is_trackable(c: &Content) -> bool {
    matches!(
        c.kind,
        Some(content::Kind::Text(_))
            | Some(content::Kind::Media(_))
            | Some(content::Kind::Sticker(_))
            | Some(content::Kind::Location(_))
            | Some(content::Kind::Poll(_))
            | Some(content::Kind::Contact(_))
    )
}

/// Мутация (правка/удаление/реакция/закреп/квитанция) и её цели.
pub fn mutation_targets(c: &Content) -> Vec<&[u8]> {
    fn one(r: &Option<MessageRef>) -> Vec<&[u8]> {
        r.as_ref().map(|m| vec![m.op_id.as_slice()]).unwrap_or_default()
    }
    match &c.kind {
        Some(content::Kind::Edit(e)) => one(&e.target),
        Some(content::Kind::Reaction(r)) => one(&r.target),
        Some(content::Kind::Pin(p)) => one(&p.target),
        Some(content::Kind::Delete(d)) => d.targets.iter().map(|m| m.op_id.as_slice()).collect(),
        Some(content::Kind::Receipt(r)) => r.messages.iter().map(|m| m.op_id.as_slice()).collect(),
        _ => vec![],
    }
}

/// Вправе ли `sender` применить мутацию к сообщению автора `target_author`
/// (у получателя; сервер этого не видит). `sender_is_admin` — админ группы
/// с правом удаления (для личных чатов — false).
pub fn mutation_authorized(c: &Content, sender: &str, target_author: &str, sender_is_admin: bool) -> bool {
    match &c.kind {
        // Править можно только своё.
        Some(content::Kind::Edit(_)) => sender == target_author,
        // Удалить у всех — автор или админ группы; «только у себя» — только свои копии.
        Some(content::Kind::Delete(d)) => sender == target_author || (d.for_everyone && sender_is_admin),
        Some(content::Kind::Reaction(_)) | Some(content::Kind::Receipt(_)) | Some(content::Kind::Pin(_)) => true,
        _ => false,
    }
}

/// Беседа, в которой отправлено отслеживаемое сообщение.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ChatKey {
    Direct(String),
    Group(Vec<u8>),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct SentStatus {
    chat: Option<ChatKey>,
    delivered: BTreeMap<String, i64>,
    read: BTreeMap<String, i64>,
}

/// Сколько своих сообщений помнить для учёта прочтений.
pub const READ_TRACK_CAP: usize = 2000;

/// Учёт доставки/прочтения своих сообщений по E2E-квитанциям (личные чаты
/// и «кто прочитал» в группах).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReadTracker {
    /// Ключи — hex(op_id) (JSON экспорта состояния требует строковых ключей).
    order: VecDeque<String>,
    sent: BTreeMap<String, SentStatus>,
}

impl ReadTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Запомнить своё отправленное сообщение.
    pub fn track(&mut self, op_id: &[u8], chat: ChatKey) {
        let id = hex::encode(op_id);
        if self.sent.contains_key(&id) {
            return;
        }
        if self.order.len() >= READ_TRACK_CAP {
            if let Some(old) = self.order.pop_front() {
                self.sent.remove(&old);
            }
        }
        self.order.push_back(id.clone());
        self.sent.insert(id, SentStatus { chat: Some(chat), ..Default::default() });
    }

    /// Применить квитанцию `from` в беседе `chat`. Учитываются только
    /// сообщения этой беседы (квитанция из чужого чата игнорируется); своя
    /// квитанция (с другого своего устройства) читателем не считается.
    /// Возвращает op_id, статус которых изменился.
    pub fn apply(&mut self, me: &str, chat: &ChatKey, from: &str, r: &Receipt, ts_ms: i64) -> Vec<Vec<u8>> {
        if from == me {
            return vec![];
        }
        if let ChatKey::Direct(peer) = chat {
            if peer != from {
                return vec![];
            }
        }
        let read = r.kind == ReceiptKind::Read as i32;
        if !read && r.kind != ReceiptKind::Delivered as i32 {
            return vec![];
        }
        let mut changed = vec![];
        for m in &r.messages {
            let Some(st) = self.sent.get_mut(&hex::encode(&m.op_id)) else { continue };
            if st.chat.as_ref() != Some(chat) {
                continue;
            }
            let mut ch = false;
            if !st.delivered.contains_key(from) {
                st.delivered.insert(from.to_string(), ts_ms);
                ch = true;
            }
            if read && !st.read.contains_key(from) {
                st.read.insert(from.to_string(), ts_ms);
                ch = true;
            }
            if ch {
                changed.push(m.op_id.clone());
            }
        }
        changed
    }

    /// Кто прочитал (пользователь, время квитанции).
    pub fn readers(&self, op_id: &[u8]) -> Vec<(String, i64)> {
        self.sent.get(&hex::encode(op_id)).map(|s| s.read.iter().map(|(u, t)| (u.clone(), *t)).collect()).unwrap_or_default()
    }

    /// Кому доставлено.
    pub fn delivered_to(&self, op_id: &[u8]) -> Vec<(String, i64)> {
        self.sent.get(&hex::encode(op_id)).map(|s| s.delivered.iter().map(|(u, t)| (u.clone(), *t)).collect()).unwrap_or_default()
    }

    pub fn is_tracked(&self, op_id: &[u8]) -> bool {
        self.sent.contains_key(&hex::encode(op_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::RootIdentity;
    use crate::olm::{OlmAccount, OlmSession};
    use crate::pb::parvane::core::v2::DeviceCertificate;
    use crate::sign::ReplayGuard;

    struct Party {
        dev: DeviceRef,
        acc: OlmAccount,
        cert: SignedDeviceCertificate,
    }

    fn party(user: &str, device: &str) -> Party {
        let root = RootIdentity::generate(user).unwrap();
        let acc = OlmAccount::new();
        let c = DeviceCertificate {
            user: Some(UserRef { address: user.into() }),
            device_id: device.into(),
            olm_curve25519: acc.curve25519().to_vec(),
            olm_ed25519: acc.ed25519().to_vec(),
            hpke_x25519: vec![1; 32],
            serial: 1,
            ..Default::default()
        };
        Party { dev: DeviceRef { address: user.into(), device_id: device.into() }, cert: root.certify_device(&acc, &c).unwrap(), acc }
    }

    fn text(t: &str) -> Content {
        Content { kind: Some(content::Kind::Text(Text { text: t.into(), ..Default::default() })), ..Default::default() }
    }

    /// Alice → получатель; возвращает (inner, сессия получателя создаётся в decrypt).
    fn send(from: &Party, to: &mut Party, peer_claim: &str, c: &Content) -> SealedInner {
        let otk = to.acc.generate_one_time_keys(1).remove(0).1;
        let mut s = from.acc.outbound(&to.acc.curve25519(), &otk).unwrap();
        let op = sign_direct(&from.acc, c, peer_claim, vec![to.dev.clone()], 1).unwrap();
        seal_inner(&from.cert, &mut s, &op).unwrap()
    }

    fn recv(to: &mut Party, inner: &SealedInner, seen: &mut ReplayGuard) -> Result<Opened> {
        let me = to.dev.clone();
        let acc = &mut to.acc;
        let mut dec = |id: &[u8; 32], t: u32, b: &[u8]| -> Result<Vec<u8>> {
            assert_eq!(t, 0);
            acc.inbound(id, b).map(|(_, pt): (OlmSession, Vec<u8>)| pt)
        };
        open_direct(inner, &me, &|_| true, &mut dec, seen)
    }

    #[test]
    fn mutations_and_read_tracking() {
        let id1 = sign::new_op_id();
        let id2 = sign::new_op_id();
        let g = ChatKey::Group(vec![7; 32]);
        let mut t = ReadTracker::new();
        t.track(&id1, g.clone());
        t.track(&id2, ChatKey::Direct("bob@x".into()));
        let rd = |ids: &[Vec<u8>]| match receipt(ReceiptKind::Read, ids).unwrap().kind {
            Some(content::Kind::Receipt(r)) => r,
            _ => unreachable!(),
        };
        let dl = match receipt(ReceiptKind::Delivered, std::slice::from_ref(&id1)).unwrap().kind {
            Some(content::Kind::Receipt(r)) => r,
            _ => unreachable!(),
        };
        assert_eq!(t.apply("alice@x", &g, "carol@x", &dl, 5), vec![id1.clone()]);
        assert!(t.readers(&id1).is_empty());
        assert_eq!(t.apply("alice@x", &g, "bob@x", &rd(&[id1.clone(), id2.clone()]), 10), vec![id1.clone()]);
        assert_eq!(t.apply("alice@x", &g, "carol@x", &rd(std::slice::from_ref(&id1)), 11), vec![id1.clone()]);
        // Повтор, своя квитанция, чужой чат — без изменений.
        assert!(t.apply("alice@x", &g, "carol@x", &rd(std::slice::from_ref(&id1)), 12).is_empty());
        assert!(t.apply("alice@x", &g, "alice@x", &rd(std::slice::from_ref(&id1)), 12).is_empty());
        assert!(t.apply("alice@x", &ChatKey::Direct("carol@x".into()), "carol@x", &rd(std::slice::from_ref(&id2)), 12).is_empty());
        assert_eq!(t.readers(&id1), vec![("bob@x".to_string(), 10), ("carol@x".to_string(), 11)]);
        assert_eq!(t.delivered_to(&id1).len(), 2);
        assert_eq!(t.apply("alice@x", &ChatKey::Direct("bob@x".into()), "bob@x", &rd(std::slice::from_ref(&id2)), 13), vec![id2.clone()]);
        // Права мутаций.
        let e = edit_text(&id1, Text { text: "x".into(), ..Default::default() });
        assert!(mutation_authorized(&e, "a", "a", false) && !mutation_authorized(&e, "b", "a", true));
        let d = delete(std::slice::from_ref(&id1), true).unwrap();
        assert!(mutation_authorized(&d, "b", "a", true) && !mutation_authorized(&d, "b", "a", false));
        assert!(!mutation_authorized(&delete(std::slice::from_ref(&id1), false).unwrap(), "b", "a", true));
        assert!(mutation_authorized(&reaction(&id1, "👍", false), "b", "a", false));
        assert_eq!(mutation_targets(&pin(&id1, false, true)), vec![id1.as_slice()]);
        assert!(receipt(ReceiptKind::Read, &[]).is_err());
        assert!(!is_trackable(&d) && is_trackable(&text("x")));
        // Кольцо ограничено.
        for _ in 0..READ_TRACK_CAP {
            t.track(&sign::new_op_id(), g.clone());
        }
        assert!(!t.is_tracked(&id1));
    }

    #[test]
    fn direct_roundtrip() {
        let alice = party("alice@x", "a1");
        let mut bob = party("bob@x", "b1");
        let inner = send(&alice, &mut bob, "bob@x", &text("hi"));
        let o = recv(&mut bob, &inner, &mut ReplayGuard::new(100)).unwrap();
        assert_eq!(o.sender.user(), "alice@x");
        assert_eq!(o.disposition, Disposition::Show);
    }

    #[test]
    fn forward_to_other_chat_rejected() {
        // Боб пересылает Кэрол подписанное Алисой сообщение «для Боба».
        let alice = party("alice@x", "a1");
        let mut carol = party("carol@x", "c1");
        let otk = carol.acc.generate_one_time_keys(1).remove(0).1;
        let mut s = alice.acc.outbound(&carol.acc.curve25519(), &otk).unwrap();
        let op = sign_direct(&alice.acc, &text("secret for bob"), "bob@x", vec![carol.dev.clone()], 1).unwrap();
        let inner = seal_inner(&alice.cert, &mut s, &op).unwrap();
        assert_eq!(recv(&mut carol, &inner, &mut ReplayGuard::new(100)).err(), Some(ProtoError::ContextMismatch));
    }

    #[test]
    fn identity_mismatch_rejected() {
        // Mallory шифрует своей Olm-сессией, но прикладывает сертификат Алисы.
        let alice = party("alice@x", "a1");
        let mallory = party("mallory@x", "m1");
        let mut bob = party("bob@x", "b1");
        let otk = bob.acc.generate_one_time_keys(1).remove(0).1;
        let mut s = mallory.acc.outbound(&bob.acc.curve25519(), &otk).unwrap();
        let op = sign_direct(&mallory.acc, &text("x"), "bob@x", vec![bob.dev.clone()], 1).unwrap();
        let inner = seal_inner(&alice.cert, &mut s, &op).unwrap();
        assert_eq!(recv(&mut bob, &inner, &mut ReplayGuard::new(100)).err(), Some(ProtoError::BadCertificate));
    }

    #[test]
    fn replay_rejected_and_revoked_sender() {
        let alice = party("alice@x", "a1");
        let mut bob = party("bob@x", "b1");
        let inner = send(&alice, &mut bob, "bob@x", &text("hi"));
        let mut seen = ReplayGuard::new(100);
        // Первая доставка принята; повтор того же op_id другой Olm-сессией — DUPLICATE.
        let op_bytes = {
            let mut dec_acc = OlmAccount::new();
            std::mem::swap(&mut dec_acc, &mut bob.acc);
            let (_, pt) = dec_acc.inbound(&alice.acc.curve25519(), &inner.olm_message).unwrap();
            std::mem::swap(&mut dec_acc, &mut bob.acc);
            pt
        };
        let me = bob.dev.clone();
        let mut dec = |_: &[u8; 32], _: u32, _: &[u8]| Ok(op_bytes.clone());
        let mut inner1 = inner.clone();
        inner1.olm_type = 1;
        open_direct(&inner1, &me, &|_| true, &mut dec, &mut seen).unwrap();
        assert_eq!(open_direct(&inner1, &me, &|_| true, &mut dec, &mut seen).err(), Some(ProtoError::Duplicate));
        // Отозванное устройство.
        assert_eq!(open_direct(&inner1, &me, &|_| false, &mut dec, &mut ReplayGuard::new(1)).err(), Some(ProtoError::Forbidden));
    }
}
