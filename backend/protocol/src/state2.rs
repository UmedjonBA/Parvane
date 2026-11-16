//! Личное состояние v2 (spec 035, US2: FR-010…FR-018, FR-030…FR-035; схема `proto/parvane/state/v2`).
//!
//! Объект состояния — `(вид, ключ)`; у объекта метки `created`/`deleted`, регистры полей (номер поля →
//! `(метка, байты поля с тегом | очищено)`), элементы множеств (`(номер, байты элемента)` → `(метка, есть)`)
//! и отметки (номер → беззнаковое big-endian, максимум). Метка — `(lamport, device_id, op_id)`; у регистра
//! ничья решается байтами значения (очистка меньше любого значения), у элемента — «есть» больше «нет».
//!
//! Видимость (FR-014): объект виден, если есть отметки либо самая свежая метка среди `created`, полей и
//! элементов новее надгробия. В показ идут только поля и элементы новее надгробия. Правило одно для всех видов.
//!
//! Сведение коммутативно, ассоциативно и идемпотентно: `snapshot_bytes()` побайтно один при любом порядке,
//! повторах и разбиении записей (`tests/state2_props.rs`). Отказы зависят только от самой операции.
//!
//! Неизвестное (FR-015, R5/R6): байты значения поля и элемента непрозрачны — неизвестное поле значения и
//! неизвестный вид объекта хранятся и сводятся как известные, в показ (`view`) не попадают. Неизвестный вид
//! операции и неизвестное поле в самой операции обнаруживает `unknown::scan` по исходным байтам; такая запись
//! хранится исходными байтами (`held`): известная часть применяется, заменяющий снимок запрещён
//! (`replacement_snapshot` → `RangeHeld`), критичный вид (1000–1999) закрывает журнал для записи
//! (`write_blocked`, запись — `WriteBlocked`).
//!
//! Шифрование записи: `nonce (12) ‖ ChaCha20-Poly1305(StateOp)` на ключе личного состояния, AAD =
//! `"parvane/v2/state2\0" ‖ user ‖ op_id`. Записи разового переноса — с детерминированным nonce
//! `HMAC-SHA256(ключ, "parvane/migrate/nonce\0" ‖ op_id ‖ открытый текст)[..12]` (research.md R9): два
//! устройства, перенёсшие одно и то же, пишут одинаковые байты, сервер отдаёт прежний seq.

use std::collections::{BTreeMap, BTreeSet};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use prost::Message;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::{self, Origin};
use crate::pb::parvane::state::v2::{
    state_op::Op, AppendRequest, FieldRegister, MarkValue, ObjectKey, ObjectKind, ObjectState, SetElement, Stamp as PbStamp,
    StateOp, StateSnapshot,
};
use crate::schema::{self, FieldTy};
use crate::state::{StateKey, ACCEPT_LAMPORT_CEILING, MAX_RECORD, NONCE_LEN, OP_ID_LEN, TAG_LEN};
use crate::unknown;

/// Префикс AAD записи журнала `state.v2`.
pub const AAD_PREFIX: &[u8] = b"parvane/v2/state2\0";
/// Метка детерминированного nonce записей переноса.
pub const MIGRATE_NONCE_LABEL: &[u8] = b"parvane/migrate/nonce\0";
/// Полное имя типа операции.
pub const OP_TYPE: &str = "parvane.state.v2.StateOp";
/// Номер отметки «отправлено» у `SCHEDULED`.
pub const MARK_SCHEDULED_SENT: u32 = 1;
/// Номер отметки «граница очистки» у `CHAT_CLEARED` (= `ChatCleared.cleared_until_ms`).
pub const MARK_CHAT_CLEARED: u32 = 2;
/// Потолок длины отметки (как в схеме `Mark.value`).
const MAX_MARK: usize = 64;

type OpId = [u8; OP_ID_LEN];

// ---------------------------------------------------------------------------
// Шифрование записей.

/// AAD записи: `"parvane/v2/state2\0" ‖ user ‖ op_id`.
pub fn record_aad(user: &str, op_id: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + user.len() + op_id.len());
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(user.as_bytes());
    aad.extend_from_slice(op_id);
    aad
}

fn cipher(key: &StateKey) -> ChaCha20Poly1305 {
    ChaCha20Poly1305::new(Key::from_slice(key.as_bytes()))
}

fn seal_with_nonce(key: &StateKey, user: &str, op_id: &[u8], pt: &[u8], nonce: [u8; NONCE_LEN]) -> Result<AppendRequest> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    if NONCE_LEN + pt.len() + TAG_LEN > MAX_RECORD {
        return Err(ProtoError::FieldLimit("aead_ciphertext"));
    }
    let ct = cipher(key).encrypt(Nonce::from_slice(&nonce), Payload { msg: pt, aad: &record_aad(user, op_id) }).map_err(|_| ProtoError::Crypto)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(AppendRequest { op_id: op_id.to_vec(), aead_ciphertext: out })
}

fn deterministic_nonce(key: &StateKey, op_id: &[u8], pt: &[u8]) -> Result<[u8; NONCE_LEN]> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes()).map_err(|_| ProtoError::Crypto)?;
    mac.update(MIGRATE_NONCE_LABEL);
    mac.update(op_id);
    mac.update(pt);
    let tag = mac.finalize().into_bytes();
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&tag[..NONCE_LEN]);
    Ok(nonce)
}

/// Зашифровать операцию в запрос `state.ops.append` (случайный nonce).
pub fn seal_op(key: &StateKey, user: &str, op: &StateOp) -> Result<AppendRequest> {
    check_header(op)?;
    let pt = Zeroizing::new(op.encode_to_vec());
    let mut nonce = [0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    seal_with_nonce(key, user, &op.op_id, &pt, nonce)
}

/// Зашифровать ИСХОДНЫЕ байты операции (в том числе с непонятным этой версии) детерминированно.
pub fn seal_raw_deterministic(key: &StateKey, user: &str, op_id: &[u8], pt: &[u8]) -> Result<AppendRequest> {
    let nonce = deterministic_nonce(key, op_id, pt)?;
    seal_with_nonce(key, user, op_id, pt, nonce)
}

/// Расшифровать запись журнала: тег сходится (ключ, user, op_id в AAD), op_id внутри совпадает с op_id записи,
/// заголовок корректен. Возвращает исходные байты операции — разбор и сведение делает `State2::apply_bytes`,
/// чтобы непонятное не потерялось.
pub fn open(key: &StateKey, user: &str, op_id: &[u8], aead_ciphertext: &[u8]) -> Result<Vec<u8>> {
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
    let pt = cipher(key).decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &record_aad(user, op_id) }).map_err(|_| ProtoError::Crypto)?;
    let op: StateOp = decode_checked(&pt, Origin::Client)?;
    if op.op_id != op_id {
        return Err(ProtoError::ContextMismatch);
    }
    check_header(&op)?;
    Ok(pt)
}

/// Перешифровать запись под новый ключ состояния без разбора (FR-032, T055): открыть старый AEAD → те же
/// байты → новый AEAD (детерминированный nonce — два устройства дают одни байты) → проверить открытием.
pub fn reseal(old: &StateKey, new: &StateKey, user: &str, op_id: &[u8], aead_ciphertext: &[u8]) -> Result<AppendRequest> {
    let pt = Zeroizing::new(open(old, user, op_id, aead_ciphertext)?);
    let out = seal_raw_deterministic(new, user, op_id, &pt)?;
    let back = Zeroizing::new(open(new, user, op_id, &out.aead_ciphertext)?);
    if *back != *pt {
        return Err(ProtoError::Crypto);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Метки, проверки.

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Stamp {
    lamport: u64,
    device_id: String,
    op_id: OpId,
}

impl Stamp {
    fn of(op: &StateOp) -> Result<Stamp> {
        Ok(Stamp { lamport: op.lamport, device_id: op.device_id.clone(), op_id: op.op_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("op_id"))? })
    }
    fn to_pb(&self) -> PbStamp {
        PbStamp { lamport: self.lamport, device_id: self.device_id.clone(), op_id: self.op_id.to_vec() }
    }
    fn from_pb(s: &PbStamp) -> Result<Stamp> {
        let st = Stamp { lamport: s.lamport, device_id: s.device_id.clone(), op_id: s.op_id.as_slice().try_into().map_err(|_| ProtoError::InvalidField("stamp.op_id"))? };
        check_stamp(st.lamport, &st.device_id)?;
        Ok(st)
    }
}

fn check_stamp(lamport: u64, device_id: &str) -> Result<()> {
    if lamport == 0 || lamport > ACCEPT_LAMPORT_CEILING {
        return Err(ProtoError::InvalidField("lamport"));
    }
    if !address::is_valid_device_id(device_id) {
        return Err(ProtoError::InvalidField("device_id"));
    }
    Ok(())
}

fn check_header(op: &StateOp) -> Result<()> {
    if op.op_id.len() != OP_ID_LEN {
        return Err(ProtoError::InvalidField("op_id"));
    }
    check_stamp(op.lamport, &op.device_id)
}

/// Тип сообщения-значения известного вида объекта (`None` — объект-признак без полей либо вид неизвестен).
pub fn value_type(kind: i32) -> Option<&'static str> {
    use ObjectKind as K;
    Some(match K::try_from(kind).ok()? {
        K::Folder => "parvane.state.v1.Folder",
        K::Block => "parvane.state.v1.BlockEntry",
        K::PeerNotify => "parvane.state.v1.PeerNotify",
        K::NotifyDefaults => "parvane.state.v1.NotifyDefaults",
        K::Draft => "parvane.state.v1.Draft",
        K::Scheduled => "parvane.state.v1.ScheduledMessage",
        K::PinList => "parvane.state.v1.PinnedOrder",
        K::Call => "parvane.state.v1.CallRecord",
        K::GroupInvite => "parvane.state.v1.GroupInvite",
        K::PlannerContainer | K::HealthContainer => "parvane.state.v1.PlannerContainer",
        K::CloudContainer => "parvane.state.v1.CloudContainer",
        K::QuickReaction => "parvane.state.v1.QuickReaction",
        K::StickerPack | K::SavedGif => "parvane.state.v1.StickerPack",
        K::Contact => "parvane.state.v1.Contact",
        K::FolderOrder => "parvane.state.v1.FolderOrder",
        K::ChatCleared => "parvane.state.v1.ChatCleared",
        K::FavedSticker => "parvane.state.v2.FavedSticker",
        K::Archive | K::UnreadMark | K::Unspecified => return None,
    })
}

/// Известен ли вид объекта этой версии.
pub fn kind_known(kind: i32) -> bool {
    matches!(ObjectKind::try_from(kind), Ok(k) if k != ObjectKind::Unspecified)
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Ключ собеседника: `u:<адрес>` или `g:<домен>:<hex id>`.
fn is_peer_key(k: &str) -> bool {
    if let Some(a) = k.strip_prefix("u:") {
        return address::is_valid_address(a);
    }
    if let Some(rest) = k.strip_prefix("g:") {
        return match rest.rsplit_once(':') {
            Some((domain, id)) => !domain.is_empty() && !id.is_empty() && id.len() % 2 == 0 && is_hex(id, id.len()),
            None => false,
        };
    }
    false
}

fn check_key(object: &Option<ObjectKey>) -> Result<(i32, String)> {
    use ObjectKind as K;
    let o = object.as_ref().ok_or(ProtoError::InvalidField("object"))?;
    let k = o.key.as_str();
    let ok = match K::try_from(o.kind) {
        Ok(K::Unspecified) => false,
        Ok(K::Folder) => !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u32>().is_ok(),
        Ok(K::NotifyDefaults | K::PlannerContainer | K::HealthContainer | K::QuickReaction | K::FolderOrder) => k.is_empty(),
        Ok(K::Block | K::PeerNotify | K::Draft | K::Archive | K::UnreadMark | K::ChatCleared) => is_peer_key(k),
        Ok(K::Contact) => address::is_valid_address(k),
        Ok(K::PinList) => k == "1" || k == "2",
        Ok(K::Scheduled | K::Call) => is_hex(k, 32),
        Ok(K::GroupInvite) => is_hex(k, 64),
        Ok(K::CloudContainer | K::StickerPack) => !k.is_empty(),
        Ok(K::SavedGif) => k.len() > 2 && k.starts_with("g:"),
        Ok(K::FavedSticker) => k.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty()),
        // Вид новее этой версии: ключ хранится как есть (лимит длины — схема).
        Err(_) => true,
    };
    if !ok {
        return Err(ProtoError::InvalidField("object.key"));
    }
    Ok((o.kind, o.key.clone()))
}

/// Все записи байтов поля — с номером `field` (значение поля в кодировке сообщения-значения с тегом).
fn check_records(bytes: &[u8], field: u32) -> Result<()> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (key, n) = varint(&bytes[pos..])?;
        pos += n;
        if key >> 3 != u64::from(field) {
            return Err(ProtoError::InvalidField("field.value"));
        }
        match key & 7 {
            0 => pos += varint(&bytes[pos..])?.1,
            1 => pos += 8,
            2 => {
                let (len, n) = varint(&bytes[pos..])?;
                pos = pos.checked_add(n).and_then(|p| p.checked_add(usize::try_from(len).ok()?)).ok_or(ProtoError::Malformed)?;
            }
            5 => pos += 4,
            _ => return Err(ProtoError::Malformed),
        }
        if pos > bytes.len() {
            return Err(ProtoError::Malformed);
        }
    }
    Ok(())
}

fn varint(b: &[u8]) -> Result<(u64, usize)> {
    let mut v: u64 = 0;
    for i in 0..10 {
        let byte = *b.get(i).ok_or(ProtoError::Malformed)?;
        if i == 9 && byte > 1 {
            return Err(ProtoError::Malformed);
        }
        v |= u64::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok((v, i + 1));
        }
    }
    Err(ProtoError::Malformed)
}

fn check_set(kind: i32, set: &[crate::pb::parvane::state::v2::FieldValue], clear: &[u32]) -> Result<()> {
    let mut seen = BTreeSet::new();
    for f in set.iter().map(|f| f.field).chain(clear.iter().copied()) {
        if f == 0 {
            return Err(ProtoError::InvalidField("field"));
        }
        if !seen.insert(f) {
            return Err(ProtoError::DuplicateField("field"));
        }
    }
    for fv in set {
        check_records(&fv.value, fv.field)?;
        if let Some(t) = value_type(kind) {
            limits::check_named(t, &fv.value, Origin::Client)?;
        }
    }
    Ok(())
}

fn check_element(kind: i32, field: u32, element: &[u8]) -> Result<()> {
    if field == 0 {
        return Err(ProtoError::InvalidField("field"));
    }
    let Some(spec) = value_type(kind).and_then(schema::message) else { return Ok(()) };
    let Some(f) = spec.field(field) else { return Ok(()) };
    if !f.repeated {
        return Err(ProtoError::InvalidField("field"));
    }
    match f.ty {
        FieldTy::Message(i) => limits::check(schema::MESSAGES.get(i).ok_or(ProtoError::Malformed)?, element, Origin::Client),
        FieldTy::Str => std::str::from_utf8(element).map(|_| ()).map_err(|_| ProtoError::Malformed),
        _ => Ok(()),
    }
}

fn check_mark(field: u32, value: &[u8]) -> Result<()> {
    if field == 0 {
        return Err(ProtoError::InvalidField("field"));
    }
    if value.is_empty() || value.len() > MAX_MARK || value[0] == 0 {
        return Err(ProtoError::InvalidField("mark.value"));
    }
    Ok(())
}

/// Сравнение отметок как беззнаковых чисел big-endian без ведущих нулей.
fn mark_max(a: &[u8], b: &[u8]) -> bool {
    (b.len(), b) > (a.len(), a)
}

/// Проверка операции целиком — без состояния (отказ одинаков при любом порядке).
fn check_op(op: &Op) -> Result<()> {
    match op {
        Op::Create(c) => {
            let (kind, _) = check_key(&c.object)?;
            check_set(kind, &c.set, &[])
        }
        Op::Patch(p) => {
            let (kind, _) = check_key(&p.object)?;
            check_set(kind, &p.set, &p.clear)
        }
        Op::Delete(d) => {
            let (kind, key) = check_key(&d.object)?;
            if kind == ObjectKind::Folder as i32 && (key == "0" || key == "1") {
                return Err(ProtoError::InvalidField("folder.id"));
            }
            Ok(())
        }
        Op::SetAdd(a) => {
            let (kind, _) = check_key(&a.object)?;
            check_element(kind, a.field, &a.element)
        }
        Op::SetRemove(r) => {
            let (kind, _) = check_key(&r.object)?;
            check_element(kind, r.field, &r.element)
        }
        Op::Mark(m) => {
            check_key(&m.object)?;
            check_mark(m.field, &m.value)
        }
        Op::Migrated(_) => Ok(()),
    }
}

/// Находки сканера, влияющие на сведение: всё, кроме значения enum вида объекта (новый вид объекта
/// хранится целиком, как известный).
fn relevant(report: &unknown::UnknownReport) -> Vec<&unknown::UnknownItem> {
    report.items.iter().filter(|i| !(i.kind == unknown::UnknownKind::Enum && i.path.ends_with("object.kind"))).collect()
}

// ---------------------------------------------------------------------------
// Объект и состояние.

#[derive(Debug, Clone, Default)]
struct Obj {
    created: Option<Stamp>,
    deleted: Option<Stamp>,
    // None — явная очистка.
    fields: BTreeMap<u32, (Stamp, Option<Vec<u8>>)>,
    elements: BTreeMap<(u32, Vec<u8>), (Stamp, bool)>,
    marks: BTreeMap<u32, Vec<u8>>,
}

fn max_stamp(cur: &mut Option<Stamp>, s: Stamp) {
    if cur.as_ref().is_none_or(|c| s > *c) {
        *cur = Some(s);
    }
}

impl Obj {
    fn put_field(&mut self, field: u32, stamp: Stamp, value: Option<Vec<u8>>) {
        let newer = match self.fields.get(&field) {
            Some((s, v)) => (&stamp, &value) > (s, v),
            None => true,
        };
        if newer {
            self.fields.insert(field, (stamp, value));
        }
    }
    fn put_element(&mut self, field: u32, element: Vec<u8>, stamp: Stamp, present: bool) {
        let k = (field, element);
        let newer = match self.elements.get(&k) {
            Some((s, p)) => (&stamp, present) > (s, *p),
            None => true,
        };
        if newer {
            self.elements.insert(k, (stamp, present));
        }
    }
    fn put_mark(&mut self, field: u32, value: Vec<u8>) {
        let newer = self.marks.get(&field).is_none_or(|cur| mark_max(cur, &value));
        if newer {
            self.marks.insert(field, value);
        }
    }
    fn after_tombstone(&self, s: &Stamp) -> bool {
        self.deleted.as_ref().is_none_or(|d| s > d)
    }
    /// Самая свежая метка правок (Create, поля, элементы).
    fn live_stamp(&self) -> Option<&Stamp> {
        self.created.iter().chain(self.fields.values().map(|(s, _)| s)).chain(self.elements.values().map(|(s, _)| s)).max()
    }
    fn visible(&self) -> bool {
        !self.marks.is_empty() || self.live_stamp().is_some_and(|s| self.after_tombstone(s))
    }
}

/// Объект для показа: только известное и видимое.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectView {
    pub kind: i32,
    pub key: String,
    /// Байты сообщения-значения вида (`value_type`) — только известные поля новее надгробия; пусто у признаков.
    pub value: Vec<u8>,
    /// Номера полей, у которых есть значение (в том числе пустое).
    pub present: Vec<u32>,
    /// Отметки: номер → значение.
    pub marks: Vec<(u32, Vec<u8>)>,
}

/// Итог применения записи.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// Применена целиком.
    Known,
    /// Есть непонятное этой версии: известная часть применена, байты хранятся (`held`).
    Held { critical: bool },
}

/// Сведённое личное состояние v2.
#[derive(Debug, Clone, Default)]
pub struct State2 {
    objects: BTreeMap<(i32, String), Obj>,
    // Исходные байты записей с непонятным → критичная ли.
    held: BTreeMap<Vec<u8>, bool>,
    max_lamport: u64,
    migrated: Option<u64>,
}

impl State2 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn max_lamport(&self) -> u64 {
        self.max_lamport
    }

    /// Перенос из `state.v1` завершён: наибольший `from_seq` записей `Migrated`.
    pub fn migrated_from(&self) -> Option<u64> {
        self.migrated
    }

    /// Записей с непонятным этой версии.
    pub fn held_count(&self) -> usize {
        self.held.len()
    }

    /// Исходные байты записей с непонятным (для `range-hold` и перешифровки без разбора).
    pub fn held(&self) -> impl Iterator<Item = &[u8]> {
        self.held.keys().map(Vec::as_slice)
    }

    /// Журнал закрыт для записи: есть неизвестный критичный вид (FR-041).
    pub fn write_blocked(&self) -> bool {
        self.held.values().any(|c| *c)
    }

    /// Разрешена ли запись в журнал этой версией.
    pub fn check_writable(&self) -> Result<()> {
        if self.write_blocked() {
            Err(ProtoError::WriteBlocked)
        } else {
            Ok(())
        }
    }

    /// Зашифровать свою новую операцию: только если журнал открыт для записи.
    pub fn seal_local(&self, key: &StateKey, user: &str, op: &StateOp) -> Result<AppendRequest> {
        self.check_writable()?;
        seal_op(key, user, op)
    }

    /// Применить операцию, собранную этой версией.
    pub fn apply(&mut self, op: &StateOp) -> Result<Applied> {
        self.apply_bytes(&op.encode_to_vec())
    }

    /// Применить исходные байты операции (открытый текст записи). Отказ не меняет состояние.
    pub fn apply_bytes(&mut self, pt: &[u8]) -> Result<Applied> {
        let op: StateOp = decode_checked(pt, Origin::Client)?;
        check_header(&op)?;
        let report = unknown::scan(OP_TYPE, pt)?;
        let found = relevant(&report);
        let stamp = Stamp::of(&op)?;
        let applied = match &op.op {
            None => {
                // Без известного вида допустим только неизвестный вид операции.
                if !found.iter().any(|i| i.kind == unknown::UnknownKind::Oneof && i.path.is_empty()) {
                    return Err(ProtoError::InvalidField("op"));
                }
                Applied::Held { critical: report.has_critical() }
            }
            Some(o) => {
                check_op(o)?;
                self.apply_known(o, stamp);
                if found.is_empty() {
                    Applied::Known
                } else {
                    Applied::Held { critical: report.has_critical() }
                }
            }
        };
        if let Applied::Held { critical } = applied {
            self.held.insert(pt.to_vec(), critical);
        }
        self.max_lamport = self.max_lamport.max(op.lamport);
        Ok(applied)
    }

    fn obj(&mut self, object: &Option<ObjectKey>) -> &mut Obj {
        let (kind, key) = object.as_ref().map(|o| (o.kind, o.key.clone())).unwrap_or_default();
        self.objects.entry((kind, key)).or_default()
    }

    fn apply_known(&mut self, op: &Op, stamp: Stamp) {
        match op {
            Op::Create(c) => {
                let o = self.obj(&c.object);
                max_stamp(&mut o.created, stamp.clone());
                for fv in &c.set {
                    o.put_field(fv.field, stamp.clone(), Some(fv.value.clone()));
                }
            }
            Op::Patch(p) => {
                let o = self.obj(&p.object);
                for fv in &p.set {
                    o.put_field(fv.field, stamp.clone(), Some(fv.value.clone()));
                }
                for f in &p.clear {
                    o.put_field(*f, stamp.clone(), None);
                }
            }
            Op::Delete(d) => max_stamp(&mut self.obj(&d.object).deleted, stamp),
            Op::SetAdd(a) => self.obj(&a.object).put_element(a.field, a.element.clone(), stamp, true),
            Op::SetRemove(r) => self.obj(&r.object).put_element(r.field, r.element.clone(), stamp, false),
            Op::Mark(m) => self.obj(&m.object).put_mark(m.field, m.value.clone()),
            Op::Migrated(m) => self.migrated = Some(self.migrated.unwrap_or(0).max(m.from_seq)),
        }
    }

    /// Каноничный снимок: объекты по (вид, ключ), регистры по номеру, элементы по (номер, байты), записи с
    /// непонятным — по байтам. Без потерь: `from_snapshot(snapshot())` — то же состояние.
    pub fn snapshot(&self) -> StateSnapshot {
        let objects = self
            .objects
            .iter()
            .map(|((kind, key), o)| ObjectState {
                object: Some(ObjectKey { kind: *kind, key: key.clone() }),
                created: o.created.as_ref().map(Stamp::to_pb),
                deleted: o.deleted.as_ref().map(Stamp::to_pb),
                fields: o
                    .fields
                    .iter()
                    .map(|(f, (s, v))| FieldRegister { field: *f, stamp: Some(s.to_pb()), value: v.clone().unwrap_or_default(), cleared: v.is_none() })
                    .collect(),
                elements: o
                    .elements
                    .iter()
                    .map(|((f, e), (s, p))| SetElement { field: *f, element: e.clone(), stamp: Some(s.to_pb()), present: *p })
                    .collect(),
                marks: o.marks.iter().map(|(f, v)| MarkValue { field: *f, value: v.clone() }).collect(),
            })
            .collect();
        StateSnapshot {
            objects,
            max_lamport: self.max_lamport,
            migrated: self.migrated.is_some(),
            migrated_from_seq: self.migrated.unwrap_or(0),
            held: self.held.keys().cloned().collect(),
        }
    }

    pub fn snapshot_bytes(&self) -> Vec<u8> {
        self.snapshot().encode_to_vec()
    }

    /// Заменяющий снимок (FR-035): разрешён, только если в исходных записях нет непонятного этой версии;
    /// иначе — явный отказ `RangeHeld`, исходные записи не трогаются (FR-034).
    pub fn replacement_snapshot(&self) -> Result<StateSnapshot> {
        if !self.held.is_empty() {
            return Err(ProtoError::RangeHeld);
        }
        Ok(self.snapshot())
    }

    /// Свести снимок в состояние (то же правило максимума, что у операций).
    pub fn merge_snapshot(&mut self, s: &StateSnapshot) -> Result<()> {
        // Сначала проверить всё, потом менять (отказ не трогает состояние).
        let mut parsed = Vec::with_capacity(s.objects.len());
        for o in &s.objects {
            let (kind, key) = check_key(&o.object)?;
            let created = o.created.as_ref().map(Stamp::from_pb).transpose()?;
            let deleted = o.deleted.as_ref().map(Stamp::from_pb).transpose()?;
            let mut fields = Vec::with_capacity(o.fields.len());
            for r in &o.fields {
                let st = Stamp::from_pb(r.stamp.as_ref().ok_or(ProtoError::InvalidField("stamp"))?)?;
                if r.cleared && !r.value.is_empty() {
                    return Err(ProtoError::InvalidField("cleared"));
                }
                check_set(kind, &[crate::pb::parvane::state::v2::FieldValue { field: r.field, value: r.value.clone() }], &[])?;
                fields.push((r.field, st, (!r.cleared).then(|| r.value.clone())));
            }
            let mut elements = Vec::with_capacity(o.elements.len());
            for e in &o.elements {
                let st = Stamp::from_pb(e.stamp.as_ref().ok_or(ProtoError::InvalidField("stamp"))?)?;
                check_element(kind, e.field, &e.element)?;
                elements.push((e.field, e.element.clone(), st, e.present));
            }
            for m in &o.marks {
                check_mark(m.field, &m.value)?;
            }
            parsed.push((kind, key, created, deleted, fields, elements, &o.marks));
        }
        if s.max_lamport > ACCEPT_LAMPORT_CEILING {
            return Err(ProtoError::InvalidField("max_lamport"));
        }
        for (kind, key, created, deleted, fields, elements, marks) in parsed {
            let o = self.objects.entry((kind, key)).or_default();
            if let Some(c) = created {
                max_stamp(&mut o.created, c);
            }
            if let Some(d) = deleted {
                max_stamp(&mut o.deleted, d);
            }
            for (f, st, v) in fields {
                o.put_field(f, st, v);
            }
            for (f, e, st, p) in elements {
                o.put_element(f, e, st, p);
            }
            for m in marks {
                o.put_mark(m.field, m.value.clone());
            }
        }
        self.max_lamport = self.max_lamport.max(s.max_lamport);
        if s.migrated {
            self.migrated = Some(self.migrated.unwrap_or(0).max(s.migrated_from_seq));
        }
        for h in &s.held {
            self.apply_bytes(h)?;
        }
        Ok(())
    }

    pub fn from_snapshot(s: &StateSnapshot) -> Result<Self> {
        let mut st = State2::new();
        st.merge_snapshot(s)?;
        Ok(st)
    }

    pub fn from_snapshot_bytes(b: &[u8]) -> Result<Self> {
        Self::from_snapshot(&decode_checked::<StateSnapshot>(b, Origin::Client)?)
    }

    /// Свести другое состояние (две части журнала на разных устройствах).
    pub fn merge(&mut self, other: &State2) {
        // Снимок своего же типа всегда проходит проверки.
        let _ = self.merge_snapshot(&other.snapshot());
    }

    /// Показ (FR-035): только известные виды, только видимые объекты, только известные поля новее надгробия.
    pub fn view(&self) -> Vec<ObjectView> {
        let mut out = Vec::new();
        for ((kind, key), o) in &self.objects {
            if !kind_known(*kind) || !o.visible() {
                continue;
            }
            out.push(Self::view_of(*kind, key, o));
        }
        out
    }

    /// Показ одного объекта (`None` — нет, не виден или вид неизвестен).
    pub fn view_object(&self, kind: i32, key: &str) -> Option<ObjectView> {
        let o = self.objects.get(&(kind, key.to_string()))?;
        (kind_known(kind) && o.visible()).then(|| Self::view_of(kind, key, o))
    }

    fn view_of(kind: i32, key: &str, o: &Obj) -> ObjectView {
        let spec = value_type(kind).and_then(schema::message);
        let known = |f: u32| spec.is_some_and(|s| s.field(f).is_some());
        let mut parts: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        for (f, (s, v)) in &o.fields {
            if let (Some(v), true, true) = (v, known(*f), o.after_tombstone(s)) {
                parts.entry(*f).or_default().extend_from_slice(v);
            }
        }
        for ((f, e), (s, present)) in &o.elements {
            if *present && known(*f) && o.after_tombstone(s) {
                let buf = parts.entry(*f).or_default();
                prost::encoding::encode_key(*f, prost::encoding::WireType::LengthDelimited, buf);
                prost::encoding::encode_varint(e.len() as u64, buf);
                buf.extend_from_slice(e);
            }
        }
        ObjectView {
            kind,
            key: key.to_string(),
            present: parts.keys().copied().collect(),
            value: parts.into_values().flatten().collect(),
            marks: o.marks.iter().map(|(f, v)| (*f, v.clone())).collect(),
        }
    }

    /// Значение регистра поля в снимке (в том числе неизвестного поля) — для проверок сохранности.
    pub fn raw_field(&self, kind: i32, key: &str, field: u32) -> Option<Option<&[u8]>> {
        self.objects.get(&(kind, key.to_string()))?.fields.get(&field).map(|(_, v)| v.as_deref())
    }

    /// Отправлено ли отложенное (`SCHEDULED` отметка 1).
    pub fn is_scheduled_sent(&self, op_id_hex: &str) -> bool {
        self.objects.get(&(ObjectKind::Scheduled as i32, op_id_hex.to_string())).is_some_and(|o| o.marks.contains_key(&MARK_SCHEDULED_SENT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::state::v2::{FieldValue, Patch};

    fn patch(id: u8, lamport: u64, dev: &str, field: u32, text: &str) -> StateOp {
        let mut value = Vec::new();
        prost::encoding::encode_key(field, prost::encoding::WireType::LengthDelimited, &mut value);
        prost::encoding::encode_varint(text.len() as u64, &mut value);
        value.extend_from_slice(text.as_bytes());
        let mut op_id = vec![0u8; 16];
        op_id[15] = id;
        StateOp {
            op_id,
            lamport,
            device_id: dev.into(),
            ts_ms: 0,
            op: Some(Op::Patch(Patch { object: Some(ObjectKey { kind: ObjectKind::Folder as i32, key: "5".into() }), set: vec![FieldValue { field, value }], clear: vec![] })),
        }
    }

    #[test]
    fn seal_open_reseal_and_context() {
        let key = StateKey::generate();
        let op = patch(1, 1, "d1", 2, "Дела");
        let rec = seal_op(&key, "alice@x", &op).unwrap();
        assert_eq!(open(&key, "alice@x", &rec.op_id, &rec.aead_ciphertext).unwrap(), op.encode_to_vec());
        assert_eq!(open(&key, "eve@x", &rec.op_id, &rec.aead_ciphertext).unwrap_err(), ProtoError::Crypto);
        // Запись state.v1 под тем же ключом не открывается как state.v2 (другой префикс AAD).
        let v1 = crate::state::record_aad("alice@x", &rec.op_id);
        assert_ne!(v1, record_aad("alice@x", &rec.op_id));
        let new = StateKey::generate();
        let moved = reseal(&key, &new, "alice@x", &rec.op_id, &rec.aead_ciphertext).unwrap();
        assert_eq!(open(&new, "alice@x", &moved.op_id, &moved.aead_ciphertext).unwrap(), op.encode_to_vec());
        assert!(open(&key, "alice@x", &moved.op_id, &moved.aead_ciphertext).is_err());
    }

    #[test]
    fn writes_blocked_by_critical_kind_and_replacement_refused_on_held() {
        let key = StateKey::generate();
        let mut s = State2::new();
        s.apply(&patch(1, 1, "d1", 2, "Дела")).unwrap();
        assert!(s.replacement_snapshot().is_ok());
        let mut normal = StateOp { op_id: vec![2; 16], lamport: 2, device_id: "d9".into(), ts_ms: 0, op: None }.encode_to_vec();
        normal.extend_from_slice(&[0xa2, 0x38, 0x00]);
        assert_eq!(s.apply_bytes(&normal).unwrap(), Applied::Held { critical: false });
        assert_eq!(s.replacement_snapshot().unwrap_err(), ProtoError::RangeHeld);
        assert!(s.seal_local(&key, "alice@x", &patch(3, 3, "d1", 3, "x")).is_ok());
        let mut crit = StateOp { op_id: vec![3; 16], lamport: 3, device_id: "d9".into(), ts_ms: 0, op: None }.encode_to_vec();
        crit.extend_from_slice(&[0xc2, 0x3e, 0x00]);
        assert_eq!(s.apply_bytes(&crit).unwrap(), Applied::Held { critical: true });
        assert_eq!(s.seal_local(&key, "alice@x", &patch(4, 4, "d1", 3, "x")).unwrap_err(), ProtoError::WriteBlocked);
        // Показ известного работает.
        assert_eq!(s.view().len(), 1);
        // Снимок без потерь: непонятное переживает загрузку.
        let back = State2::from_snapshot_bytes(&s.snapshot_bytes()).unwrap();
        assert!(back.write_blocked() && back.held_count() == 2);
        assert_eq!(back.snapshot_bytes(), s.snapshot_bytes());
    }
}
