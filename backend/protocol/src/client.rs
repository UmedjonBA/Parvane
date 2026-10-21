//! Клиентское ядро протокола v2 (E2–E4: одно для web/desktop/android).
//!
//! Без ввода-вывода: хост (TS/C++/Kotlin) только передаёт байты между
//! ядром и gateway. Ядро держит состояние устройства и решает всё, что
//! касается формата и криптографии:
//! - ключи устройства (Olm, HPKE), SSK пользователя, сертификаты;
//! - журналы устройств собеседников с TOFU по корню и защитой от отката;
//! - Olm-сессии по устройствам, sealed-конверты (HPKE поверх Olm);
//! - ключи доступа к доставке (свой и собеседников), слепые жетоны;
//! - журналы групп, ключи эпох (конверт/отправка), Megolm по эпохам;
//! - курсор журнала инбокса (SYNC-1/2) и защита от повторов;
//! - «липкая» политика формата (D-13).
//!
//! Операции возвращают `OutRequest` (метод реестра + тело) или события
//! `Event`; «нужно ещё» — ошибкой `Need` (хост добирает данные и повторяет).
//! Состояние экспортируется целиком, зашифрованным ключом хранилища хоста.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::SigningKey;
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::access::{OwnDeliveryKey, TokenStock};
use crate::codec::decode_checked;
use crate::ephemeral::{self, EphChannel};
use crate::error::{ProtoError, Result};
use crate::group::{self, ContextVerdict, GroupState, SignerInfo};
use crate::identity::{self, DeviceLog, LogPin, RootIdentity, RootTrust, TrustVerdict, VerifiedDevice};
use crate::l2::{self, ChatKind, L2Pref, L2State};
use crate::limits::Origin;
use crate::msg;
use crate::olm::{MegolmInbound, MegolmOutbound, OlmAccount, OlmSession};
use crate::pb::parvane::core::v2::{
    sealed_envelope::Access, user_device_log_entry::Change as DevChange, AnonToken, DeviceCertificate, DeviceRef,
    GroupEnvelope, GroupEnvelopeInner, GroupStateEntry, Ref, SealedInner, SignedDeviceCertificate, SignedOp,
    TokenKey, UserRef,
};
use crate::pb::parvane::call::v2 as cpb;
use crate::pb::parvane::group::v2::{self as gpb, group_change::Change};
use crate::pb::parvane::identity::v2::{self as ipb, OneTimeKey};
use crate::pb::parvane::msg::v2::{self as mpb, content, inbox_record, Content, DeliveryKeyShare, GroupKeyShare};
use crate::policy::{self, SendFormat, StickyV2};
use crate::seal;
use crate::sign::{self, ReplayGuard};
use crate::state::StateKey;
use crate::sync::Cursor;
use crate::unknown::Disposition;

/// Грант линковки: SSK, журнал устройств, ключ доставки и его поколение.
pub type LinkGrantMaterial = ([u8; 32], Vec<SignedOp>, [u8; 32], u64);

/// Канал, которым отправить запрос.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Chan {
    /// Идентифицированная сессия.
    Id,
    /// Анонимный канал доставки.
    Anon,
}

/// Запрос, который хост должен выполнить (метод реестра + тело protobuf).
#[derive(Debug, Clone, PartialEq)]
pub struct OutRequest {
    pub chan: Chan,
    pub method: &'static str,
    pub body: Vec<u8>,
    /// Домен сервера объекта, которого нет в теле (spec 028, R14: «печатает» собеседнику — канал
    /// без адреса); `None` — `routing::dest_of` выводит его из тела.
    pub dest: Option<String>,
}

impl OutRequest {
    fn id(method: &'static str, m: &impl Message) -> Self {
        Self { chan: Chan::Id, method, body: m.encode_to_vec(), dest: None }
    }
    fn anon(method: &'static str, m: &impl Message) -> Self {
        Self { chan: Chan::Anon, method, body: m.encode_to_vec(), dest: None }
    }
}

/// Чего не хватает для операции (хост добирает и повторяет).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    /// Синхронизировать журнал устройств пользователя (`log_sync_anon`, after).
    PeerLog { user: String, after: u64 },
    /// Получить бандл пользователя (`fetch_bundle_anon`).
    Bundle { user: String },
    /// Нет ни ключа доступа собеседника, ни жетона — получить жетоны.
    Token { user: String },
    /// Смена корня собеседника — нужно подтверждение пользователя (KEY-1).
    RootChanged { user: String },
    /// Журнал группы не догнан (или форк) — `group.state.sync`.
    GroupLog { group: Vec<u8>, after: u64 },
    /// Нет ключей эпохи группы.
    GroupKeys { group: Vec<u8>, epoch: u64 },
    /// Нет права (не участник/не вправе писать).
    Forbidden,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    Need(Need),
    Proto(ProtoError),
}

impl From<ProtoError> for ClientError {
    fn from(e: ProtoError) -> Self {
        ClientError::Proto(e)
    }
}

pub type CResult<T> = std::result::Result<T, ClientError>;

fn need<T>(n: Need) -> CResult<T> {
    Err(ClientError::Need(n))
}

/// Событие для UI/хоста.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Сообщение (или мутация как содержимое) личного чата.
    Direct { seq: u64, chat: String, from: String, device: String, op_id: Vec<u8>, ts_ms: i64, content: Content, disposition: Disposition },
    /// Сообщение группы.
    Group { seq: u64, group: Ref, from: String, device: String, op_id: Vec<u8>, ts_ms: i64, content: Content, disposition: Disposition },
    /// Запись истории/сообщение v1 (разбор — legacy_v1).
    LegacyV1 { seq: u64, json: Vec<u8> },
    /// Изменился журнал группы — синхронизировать.
    GroupChanged { seq: u64, group: Ref, version: u64 },
    /// Отозвано одно из своих устройств.
    DeviceRevoked { seq: u64, device_id: String },
    /// Сигнал звонка от собеседника (D-08): живое событие мимо журнала.
    Call { from: String, device: String, call_id: Vec<u8>, ts_ms: i64, signal: cpb::CallSignal },
    /// Новое устройство в журнале своего пользователя (T119): живое событие,
    /// хосту — перечитать свой журнал и показать уведомление.
    DeviceAdded { device_id: String, log_version: u64 },
    /// Своё другое устройство сменило ключ личного состояния (после отзыва
    /// устройства): хост перешифровывает журнал состояния новым ключом.
    StateKeyRotated { seq: u64, key_version: u32 },
    /// «Печатает» по эфемерному каналу v2 (T127): `chat` — собеседник либо
    /// группа (`group` задан). Живое событие, в журнал не пишется.
    Typing { chat: String, group: Option<Vec<u8>>, from: String, action: i32, ts_ms: i64 },
    /// Присутствие собеседника по эфемерному каналу v2.
    Presence { from: String, online: bool, last_seen_ms: i64, ts_ms: i64 },
    /// Контейнер планировщика (spec 010): принят ключ эпохи, применены
    /// ожидавшие операции либо контейнер ещё надо подключить (`head_seq` 0).
    PlannerChanged { seq: u64, head_seq: u64 },
    /// Контейнер облака (spec 016): принят ключ эпохи и применены ожидавшие
    /// операции либо контейнер ещё надо подключить (ключ ждёт).
    CloudChanged { seq: u64, id: Vec<u8> },
    /// Служебное (ключи) — применено внутри, показывать нечего.
    Internal { seq: u64 },
    /// Запись пропущена (неизвестный вид/не расшифровалась после попыток).
    Skipped { seq: u64 },
}

/// Итог отзыва своего устройства (T124): запросы выполнять по порядку;
/// отложенное хост доделывает теми же методами после добора данных.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RevocationOutcome {
    pub requests: Vec<OutRequest>,
    /// Собеседники, которым новый ключ доступа не ушёл (нужен добор) —
    /// `share_delivery_key(peer)` позже.
    pub pending_key_shares: Vec<String>,
    /// Группы, где мы админ, но эпоху сейчас сменить нельзя (добор/частота) —
    /// `group_rotate_epoch` позже.
    pub pending_epochs: Vec<Vec<u8>>,
    /// Группы, где мы не админ: своя Megolm-сессия сменится при следующей
    /// отправке, новую эпоху начинает админ.
    pub epochs_need_admin: Vec<Vec<u8>>,
    /// Отозванное устройство держало SSK: нужна `rotate_ssk` корнем (до неё
    /// собеседники видят KEY-1).
    pub ssk_rotation_required: bool,
    /// Новая версия ключа личного состояния (хост перешифровывает журнал).
    pub state_key_version: Option<u32>,
}

/// Режим «усиленная приватность» (L2) чата глазами этого устройства (T079).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct L2View {
    /// Режим чата активен (виден всем участникам): личный чат — включил хотя
    /// бы один участник; группа — политика журнала группы.
    pub active: bool,
    /// Своё предпочтение (в группе — личное: действует на свои исходящие).
    pub mine: bool,
    /// Кто включил: личный чат — участники с включённым предпочтением;
    /// группа — автор действующей политики.
    pub enabled_by: Vec<String>,
    /// Исходящие конверты этого чата выравниваются по сетке.
    pub pad: bool,
    /// typing/presence в этом чате разрешены.
    pub ephemeral_allowed: bool,
}

/// Параметры подготовки личного сообщения.
struct DirectOpts {
    op_id: Vec<u8>,
    /// Раздать свой ключ доступа, если собеседник его ещё не получал.
    share_dk: bool,
    /// Выравнивать независимо от режима личного чата (раздача ключей L2-группы).
    force_l2: bool,
    ts_ms: i64,
}

/// Параметры запечатывания одной операции для устройств пользователя.
struct SealOpts {
    op_id: Vec<u8>,
    ts_ms: i64,
    l2: bool,
}

/// Вердикт по журналу собеседника.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogVerdict {
    New,
    Known,
    RootChanged,
    /// На сервере — другой журнал (другой генезис): перечитать с версии 0.
    Replaced,
    /// spec 026: журнал закрыт сменой ника — дочитать журнал нового адреса (`peer_renamed_to` /
    /// `own_renamed_to`).
    Moved,
    /// spec 026: журнал — продолжение прежнего адреса собеседника (тот же корень); всё о нём перенесено на
    /// этот адрес (`peer_renamed_from`).
    Renamed,
}

#[derive(Default)]
struct Peer {
    /// spec 026: перенос с прежнего адреса уже сообщён хосту (вердикт "renamed" — один раз за сеанс).
    rename_linked: bool,
    entries: Vec<SignedOp>,
    log: Option<DeviceLog>,
    pin: LogPin,
    delivery_key: Option<(Vec<u8>, u64)>,
    /// Корень сменился — ждём подтверждения пользователя.
    pending_root: Option<Vec<SignedOp>>,
}

struct EpochKeys {
    envelope_key: Zeroizing<[u8; 32]>,
    send_sk: Option<SigningKey>,
}

struct Inbound {
    group: Vec<u8>,
    epoch: u64,
    sender: String,
    session: MegolmInbound,
}

struct GroupLocal {
    entries: Vec<GroupStateEntry>,
    state: Option<GroupState>,
    /// D-03 (C1-03): проверенное сообщение/раздача ключей ссылается на более
    /// новую версию журнала — до догона не отправлять и не раздавать ключи.
    behind: Option<u64>,
    /// FR-028 (T080): участники, которых сервер добавил записью без
    /// подтверждённой подписи вправе приглашающего (запись отвергнута) —
    /// ключи им не раздаются, хост показывает предупреждение. Не сохраняется.
    unconfirmed: BTreeSet<String>,
}

impl GroupLocal {
    fn new(entries: Vec<GroupStateEntry>, state: Option<GroupState>) -> Self {
        GroupLocal { entries, state, behind: None, unconfirmed: BTreeSet::new() }
    }
}

/// ENG-08: версия журнала устройств подписанта, на которую ссылается запись (0 — нет).
fn entry_signer_version(e: &GroupStateEntry) -> u64 {
    let Some(op) = e.change.as_ref() else { return 0 };
    let Ok(body) = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()) else { return 0 };
    gpb::GroupStateChange::decode(body.payload.as_slice()).map(|sc| sc.signer_log_version).unwrap_or(0)
}

/// spec 026: адрес-подсказка подписанта и прежний адрес из `RenameMember` — их журналы нужны для проверки.
fn entry_rename_addresses(e: &GroupStateEntry) -> (Option<String>, Option<String>) {
    let Some(op) = e.change.as_ref() else { return (None, None) };
    let Ok(body) = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()) else { return (None, None) };
    let Ok(sc) = gpb::GroupStateChange::decode(body.payload.as_slice()) else { return (None, None) };
    let hinted = Some(sc.signer_address).filter(|a| !a.is_empty());
    let old = match sc.change.and_then(|c| c.change) {
        Some(Change::RenameMember(r)) => r.rename.and_then(|op| {
            let b = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
            crate::pb::parvane::core::v2::UserDeviceLogEntry::decode(b.payload.as_slice()).ok()?.user.map(|u| u.address)
        }),
        _ => None,
    };
    (hinted, old)
}

/// Кого добавляет запись журнала (для предупреждения FR-028 при отказе).
fn entry_added_member(e: &GroupStateEntry) -> Option<String> {
    let op = e.change.as_ref()?;
    let body = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
    let sc = gpb::GroupStateChange::decode(body.payload.as_slice()).ok()?;
    match sc.change?.change? {
        Change::AddMember(a) => a.member.map(|m| m.address),
        _ => None,
    }
}

/// Клиентское ядро одного устройства.
pub struct Client {
    pub user: String,
    pub device_id: String,
    pub domain: String,
    acc: OlmAccount,
    hpke_sk: Zeroizing<[u8; 32]>,
    hpke_pk: [u8; 32],
    ssk: Option<SigningKey>,
    own_entries: Vec<SignedOp>,
    own_log: DeviceLog,
    my_cert: Option<SignedDeviceCertificate>,
    cert_serial: u64,
    peers: BTreeMap<String, Peer>,
    sessions: HashMap<(String, String), OlmSession>,
    /// Вытесненные сессии с тем же устройством (обе стороны начали переписку
    /// одновременно): на них ещё может прийти сообщение собеседника.
    old_sessions: HashMap<(String, String), Vec<OlmSession>>,
    groups: BTreeMap<Vec<u8>, GroupLocal>,
    epoch_keys: HashMap<(Vec<u8>, u64), EpochKeys>,
    megolm_out: HashMap<(Vec<u8>, u64), MegolmOutbound>,
    megolm_shared: BTreeSet<(Vec<u8>, u64, String)>,
    megolm_in: HashMap<String, Inbound>,
    dk: OwnDeliveryKey,
    stock: TokenStock,
    /// Список ключей выпуска, полученный АНОНИМНО и проверенный (D-06).
    token_keys: Vec<TokenKey>,
    /// Ключ личного состояния и его версия (общий для своих устройств).
    state_key: Option<(StateKey, u32)>,
    /// Учёт доставки/прочтения своих сообщений (T074).
    reads: msg::ReadTracker,
    /// Отзывы, последствия которых уже выполнены этим устройством (T124).
    revocations_done: BTreeSet<String>,
    trust: RootTrust,
    sticky: StickyV2,
    seen: ReplayGuard,
    /// Отпечатки «видели» с моментом записи — для экспорта (A1(в)): окно
    /// `SEEN_WINDOW_MS`, не больше `SEEN_CAP`.
    seen_list: VecDeque<(SeenHash, i64)>,
    cursor: Cursor,
    pending_group: Vec<(u64, GroupEnvelope)>,
    /// ENG-05: проверенное сообщение автора ссылается на версию его журнала устройств новее
    /// известной — до догона журнала этому пользователю не отправлять (Need::PeerLog). Не сохраняется.
    log_behind: BTreeMap<String, u64>,
    /// ENG-06: группы, где у участника ушло устройство (выход или отзыв) в эпохе (значение): своя
    /// Megolm-сессия группы уже сброшена, новую эпоху начинает тот, кто вправе. Не сохраняется.
    rekey: BTreeMap<Vec<u8>, u64>,
    /// Расшифрованные ключи группы, для которых ещё нет журнала группы
    /// (Olm-сообщение повторно не расшифровать — держим здесь).
    pending_keys: Vec<(String, GroupKeyShare)>,
    /// Секреты ссылок-приглашений, принятые от других ведущих приглашения
    /// (группа, ссылка): хост забирает их `take_shared_invites` сразу после
    /// открытия записи и хранит сам; в экспорт состояния не входят.
    shared_invites: Vec<(Vec<u8>, String)>,
    /// Запрос жетонов в полёте (не сохраняется).
    token_req: Option<(crate::tokens::TokenRequest, TokenKey)>,
    /// Жетоны серверов других доменов (spec 028): письмо незнакомцу с чужого
    /// сервера оплачивается жетоном ЕГО сервера.
    foreign_tokens: BTreeMap<String, ForeignTokens>,
    /// L2 личных чатов (ключ — собеседник): предпочтения участников из
    /// проверенных операций `ChatMode` (T079).
    l2_direct: BTreeMap<String, L2State>,
    /// Личное предпочтение L2 в группах (только это устройство; политика
    /// группы — в журнале группы).
    l2_group_pref: BTreeMap<Vec<u8>, L2Pref>,
    /// Подписанные эфемерные каналы этого соединения (T127; не сохраняется).
    eph: BTreeMap<[u8; ephemeral::CHANNEL_ID_LEN], (EphChannel, EphTarget)>,
    /// Контейнер планировщика (spec 010) и ключи, ждущие его подключения.
    planner: Option<PlannerLocal>,
    planner_pending_keys: Vec<ContainerKeyShare>,
    /// Ключи из экспорта линковки: (домен, id контейнера, эпоха, ключ).
    planner_trusted_keys: Vec<(String, Vec<u8>, u64, [u8; 32])>,
    /// Ключ подписи устройства → device_id (включая уже отозванные).
    planner_authors: BTreeMap<[u8; 32], String>,
    /// Контейнеры облака (spec 016) по id: личный диск и совместные папки.
    cloud: BTreeMap<Vec<u8>, CloudLocal>,
    /// Ключи, ждущие подключения контейнера или журнала грантов: (отправитель, раздача).
    cloud_pending_keys: Vec<(String, ContainerKeyShare)>,
    /// Ключи из экспорта своего устройства: (id контейнера, эпоха, ключ).
    cloud_trusted_keys: Vec<(Vec<u8>, u64, [u8; 32])>,
    /// Ключ подписи устройства → (пользователь, device_id), включая уже отозванные.
    cloud_authors: BTreeMap<[u8; 32], (String, String)>,
    /// Последняя ошибка разбора записи (диагностика хоста; клиенту не показывается).
    pub last_error: Option<ProtoError>,
    /// spec 026: свои прежние адреса — записи и журнал каждого (закрыт `Rename`).
    former_own: Vec<(Vec<SignedOp>, DeviceLog)>,
}

/// Чей это эфемерный канал (T127).
#[derive(Debug, Clone, PartialEq, Eq)]
enum EphTarget {
    /// Присутствие собеседника.
    Presence(String),
    /// «Печатает» в личном чате с собеседником.
    Direct(String),
    /// «Печатает» в группе (эпоха, на ключ которой выведен канал).
    Group(Vec<u8>, u64),
}

/// Потолок подписанных эфемерных каналов на соединение (gateway — 256 подписок).
const EPH_MAX_CHANNELS: usize = 240;
/// Сигнал старше — отброшен (повтор старого через канал ничего не даёт).
const EPH_MAX_AGE_MS: i64 = 30_000;

fn rand32() -> [u8; 32] {
    let mut k = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k);
    k
}

fn now_ms() -> i64 {
    crate::time::now_ms()
}

const SEEN_CAP: usize = 20_000;
/// Сколько живёт отпечаток «видели» (A1(в)). Повтор доставки возможен только
/// из инбокса сервера, а тот стирает записи через 30 дней после приёма
/// (`INBOX_TTL_SECS` шарда messenger; нонсы групповых конвертов — столько же):
/// позже 30 дней после первого открытия та же запись прийти не может. Сутки
/// сверху — на расхождение часов.
const SEEN_WINDOW_MS: i64 = 31 * 24 * 3600 * 1000;
/// Отпечаток ключа «видели»: SHA-256, первые 16 байт (ключ — адрес, устройство
/// и op_id либо сессия Megolm и индекс — до 80 байт; в экспорте хранится отпечаток).
type SeenHash = [u8; 16];

fn seen_hash(key: &[u8]) -> SeenHash {
    let d = Sha256::digest(key);
    let mut h = [0u8; 16];
    h.copy_from_slice(&d[..16]);
    h
}
/// Сколько вытесненных Olm-сессий держать на устройство собеседника.
const MAX_OLD_SESSIONS: usize = 4;

impl Client {
    /// Новое устройство (свежий Olm-аккаунт, HPKE, ключ доступа к доставке).
    pub fn new(user: &str, device_id: &str, domain: &str) -> Result<Self> {
        if !crate::address::is_valid_address(user) || !crate::address::is_valid_device_id(device_id) || !crate::address::is_valid_domain(domain) {
            return Err(ProtoError::BadAddress);
        }
        let (sk, pk) = seal::generate_keypair();
        Ok(Self {
            user: user.into(),
            device_id: device_id.into(),
            domain: domain.into(),
            acc: OlmAccount::new(),
            hpke_sk: sk,
            hpke_pk: pk,
            ssk: None,
            own_entries: vec![],
            own_log: DeviceLog::new(user)?,
            my_cert: None,
            cert_serial: 0,
            peers: BTreeMap::new(),
            sessions: HashMap::new(),
            old_sessions: HashMap::new(),
            groups: BTreeMap::new(),
            epoch_keys: HashMap::new(),
            megolm_out: HashMap::new(),
            megolm_shared: BTreeSet::new(),
            megolm_in: HashMap::new(),
            dk: OwnDeliveryKey::new(),
            stock: TokenStock::new(),
            token_keys: vec![],
            state_key: None,
            reads: msg::ReadTracker::new(),
            revocations_done: BTreeSet::new(),
            trust: RootTrust::default(),
            sticky: StickyV2::default(),
            seen: ReplayGuard::new(SEEN_CAP),
            seen_list: VecDeque::new(),
            cursor: Cursor::default(),
            pending_group: vec![],
            log_behind: BTreeMap::new(),
            rekey: BTreeMap::new(),
            pending_keys: vec![],
            shared_invites: vec![],
            token_req: None,
            foreign_tokens: BTreeMap::new(),
            l2_direct: BTreeMap::new(),
            l2_group_pref: BTreeMap::new(),
            eph: BTreeMap::new(),
            planner: None,
            planner_pending_keys: vec![],
            planner_trusted_keys: vec![],
            planner_authors: BTreeMap::new(),
            cloud: BTreeMap::new(),
            cloud_pending_keys: vec![],
            cloud_trusted_keys: vec![],
            cloud_authors: BTreeMap::new(),
            last_error: None,
            former_own: vec![],
        })
    }

    /// Импорт Olm-аккаунта v1 (libolm pickle web или JSON parvane-e2e) — то же
    /// устройство продолжает жить на v2 с теми же identity-ключами.
    pub fn import_v1_account(&mut self, account: OlmAccount) {
        self.acc = account;
    }

    pub fn my_device(&self) -> DeviceRef {
        DeviceRef { address: self.user.clone(), device_id: self.device_id.clone() }
    }

    pub fn delivery_key(&self) -> &[u8; 32] {
        self.dk.key()
    }

    pub fn cursor(&self) -> &Cursor {
        &self.cursor
    }

    /// Запрос следующей страницы журнала инбокса.
    pub fn sync_request(&self) -> OutRequest {
        OutRequest::id("msg.inbox.sync", &self.cursor.next_request())
    }

    /// Подтверждение применённого (SYNC-1).
    pub fn ack_request(&self) -> OutRequest {
        OutRequest::id("msg.inbox.ack", &mpb::InboxAckRequest { up_to_seq: self.cursor.disk_value() })
    }

    // ── личность ────────────────────────────────────────────────────────────

    fn my_certificate_body(&mut self) -> DeviceCertificate {
        self.cert_serial += 1;
        DeviceCertificate {
            user: Some(UserRef { address: self.user.clone() }),
            device_id: self.device_id.clone(),
            olm_curve25519: self.acc.curve25519().to_vec(),
            olm_ed25519: self.acc.ed25519().to_vec(),
            hpke_x25519: self.hpke_pk.to_vec(),
            proto_major: crate::PROTO_MAJOR,
            proto_minor: crate::PROTO_MINOR,
            features: vec![],
            created_ms: now_ms(),
            serial: self.cert_serial,
            possession_signature: vec![],
        }
    }

    fn signed_otks(&mut self, n: usize) -> (Vec<OneTimeKey>, Option<OneTimeKey>) {
        let otks = self
            .acc
            .generate_one_time_keys(n)
            .into_iter()
            .map(|(id, k)| OneTimeKey { signature: sign::sign_ctx(&self.acc, sign::ctx::OTK, &[&id, &k]), key_id: id, curve25519: k.to_vec() })
            .collect();
        let fb = self.acc.generate_fallback_key().map(|k| {
            let id = b"fallback".to_vec();
            OneTimeKey { signature: sign::sign_ctx(&self.acc, sign::ctx::OTK, &[&id, &k]), key_id: id, curve25519: k.to_vec() }
        });
        (otks, fb)
    }

    /// Первое устройство пользователя: корень + SSK, генезис журнала,
    /// сертификат этого устройства, прекеи, ключ доставки. Возвращает запросы
    /// (выполнять по порядку) и корень для резервной копии пользователя (D-12:
    /// серверная копия — только под ключом восстановления ≥ 128 бит).
    pub fn create_identity(&mut self, otk_count: usize) -> Result<(Vec<OutRequest>, RootIdentity)> {
        if self.own_log.version > 0 {
            return Err(ProtoError::Duplicate);
        }
        let root = RootIdentity::generate(&self.user)?;
        let genesis = root.genesis_entry()?;
        self.own_log.apply(&genesis)?;
        self.own_entries.push(genesis.clone());
        self.ssk = Some(SigningKey::from_bytes(&root.self_signing.to_bytes()));
        let reqs = self.certify_self_requests(otk_count, Some(genesis))?;
        Ok((reqs, root))
    }

    /// Устройство держит SSK (своё первое или получило при линковке):
    /// сертификат себя записью журнала + прекеи + ключ доставки.
    fn certify_self_requests(&mut self, otk_count: usize, genesis: Option<SignedOp>) -> Result<Vec<OutRequest>> {
        if self.ssk.is_none() {
            return Err(ProtoError::Forbidden);
        }
        let root_pub: [u8; 32] = self.own_log.root_key;
        let mut cert = self.my_certificate_body();
        // C1-01: доказательство владения ключами этого устройства.
        identity::prove_possession(&self.acc, &mut cert, &root_pub)?;
        let ssk = self.ssk.as_ref().ok_or(ProtoError::Forbidden)?;
        let bytes = cert.encode_to_vec();
        let ssk_pub = ssk.verifying_key().to_bytes();
        let signed = SignedDeviceCertificate {
            self_signing_signature: sign::sign_ctx(ssk, sign::ctx::DEVICE_CERT, &[&bytes]),
            certificate: bytes,
            self_signing_key: ssk_pub.to_vec(),
            root_signature_over_self_signing: vec![],
            root_key: root_pub.to_vec(),
        };
        // Подпись корня над SSK — из генезиса/ротации журнала.
        let root_sig = self.root_signature_over_ssk().ok_or(ProtoError::BadCertificate)?;
        let signed = SignedDeviceCertificate { root_signature_over_self_signing: root_sig, ..signed };
        let entry = identity::device_log_entry(&self.user, self.own_log.version + 1, self.own_log.head_hash, DevChange::AddDevice(signed.clone()), None);
        let op = identity::sign_device_log_entry(ssk, &entry)?;
        self.own_log.apply(&op)?;
        self.own_entries.push(op.clone());
        self.my_cert = Some(signed);
        let (otks, fb) = self.signed_otks(otk_count);
        let mut out = vec![];
        if let Some(g) = genesis {
            out.push(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(g) }));
        }
        out.push(OutRequest::id("identity.device.publish_certificate", &ipb::DevicePublishCertificateRequest { log_entry: Some(op), one_time_keys: otks, fallback_key: fb }));
        out.push(OutRequest::id("identity.delivery_key.set", &ipb::DeliveryKeySetRequest { delivery_key: self.dk.key().to_vec() }));
        Ok(out)
    }

    fn root_signature_over_ssk(&self) -> Option<Vec<u8>> {
        let ssk_pub = self.ssk.as_ref()?.verifying_key().to_bytes();
        for op in self.own_entries.iter().rev() {
            let body = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
            let e = crate::pb::parvane::core::v2::UserDeviceLogEntry::decode(body.payload.as_slice()).ok()?;
            if let Some(DevChange::RotateSelfSigningKey(r)) = e.change {
                if r.self_signing_key == ssk_pub {
                    return Some(r.root_signature);
                }
            }
        }
        None
    }

    /// Второе устройство пользователя после линковки (LINK-1 v2): получило
    /// SSK, журнал устройств и ключ доставки в гранте — сертифицирует себя.
    pub fn join_with_ssk(&mut self, ssk: [u8; 32], own_entries: Vec<SignedOp>, delivery_key: [u8; 32], dk_gen: u64, otk_count: usize) -> Result<Vec<OutRequest>> {
        let mut log = DeviceLog::new(&self.user)?;
        for e in &own_entries {
            log.apply(e)?;
        }
        let sk = SigningKey::from_bytes(&ssk);
        if sk.verifying_key().to_bytes() != log.ssk {
            return Err(ProtoError::BadCertificate);
        }
        self.own_log = log;
        self.own_entries = own_entries;
        self.ssk = Some(sk);
        self.dk = OwnDeliveryKey::from_parts(delivery_key, dk_gen, BTreeMap::new());
        self.trust.accept(&self.user.clone(), &self.own_log.root_key);
        let mut reqs = self.certify_self_requests(otk_count, None)?;
        // Ключ доставки уже на сервере (общий для устройств пользователя).
        reqs.retain(|r| r.method != "identity.delivery_key.set");
        Ok(reqs)
    }

    /// T130 (FR-066): восстановление на новом устройстве, когда других устройств
    /// аккаунта не осталось. Корень — из копии под ключом восстановления;
    /// `own_entries` — журнал устройств с сервера (с версии 1). Корень назначает
    /// новый SSK (сертификаты прежнего SSK недействительны), прежние устройства
    /// отзываются записями журнала (сервер гасит их сессии), это устройство
    /// сертифицирует себя; ключ доступа к доставке — новый. Ключ личного
    /// состояния не восстанавливается (его держали только устройства).
    pub fn recover_with_root(&mut self, root_secret: &[u8; 32], own_entries: Vec<SignedOp>, otk_count: usize) -> Result<Vec<OutRequest>> {
        let mut log = DeviceLog::new(&self.user)?;
        for e in &own_entries {
            log.apply(e)?;
        }
        let root = SigningKey::from_bytes(root_secret);
        if log.version == 0 || root.verifying_key().to_bytes() != log.root_key {
            return Err(ProtoError::RootMismatch);
        }
        let old_devices: Vec<String> = log.devices.keys().filter(|id| *id != &self.device_id).cloned().collect();
        let new_ssk = sign::generate_signing_key();
        let (rotate, _) = identity::rotate_ssk_entry(&root, &self.user, log.version + 1, log.head_hash, &new_ssk)?;
        log.apply(&rotate)?;
        let mut entries = own_entries;
        entries.push(rotate.clone());
        let mut reqs = vec![OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(rotate) })];
        for id in old_devices {
            let e = identity::device_log_entry(&self.user, log.version + 1, log.head_hash, DevChange::RevokeDeviceId(id), None);
            let op = identity::sign_device_log_entry(&new_ssk, &e)?;
            log.apply(&op)?;
            entries.push(op.clone());
            reqs.push(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }));
        }
        self.own_log = log;
        self.own_entries = entries;
        self.ssk = Some(new_ssk);
        self.dk = OwnDeliveryKey::new();
        self.trust.accept(&self.user.clone(), &self.own_log.root_key);
        reqs.extend(self.certify_self_requests(otk_count, None)?);
        Ok(reqs)
    }

    /// T130: сброс личности — новый корень и новый журнал устройств взамен
    /// прежнего (ключа восстановления нет, устройств не осталось). Первый
    /// запрос — `identity.root.rotate` (нужна свежая переаутентификация
    /// паролем); собеседники увидят смену корня (KEY-1), прежняя переписка v2
    /// этим устройством не читается.
    pub fn reset_identity(&mut self, otk_count: usize) -> Result<(Vec<OutRequest>, RootIdentity)> {
        self.own_log = DeviceLog::new(&self.user)?;
        self.own_entries.clear();
        self.ssk = None;
        self.my_cert = None;
        self.dk = OwnDeliveryKey::new();
        // Сброс на работающем устройстве: собеседник, приняв новый корень,
        // отбрасывает свои сессии с нами (accept_root_change) — прежние сессии
        // здесь тоже не годятся, иначе первое же сообщение не расшифруется.
        self.sessions.clear();
        self.old_sessions.clear();
        let (mut reqs, root) = self.create_identity(otk_count)?;
        let genesis = self.own_entries.first().cloned().ok_or(ProtoError::BrokenChain)?;
        match reqs.first_mut() {
            Some(first) if first.method == "identity.device.log_append" => {
                *first = OutRequest::id("identity.root.rotate", &ipb::RootRotateRequest { genesis: Some(genesis) });
            }
            _ => return Err(ProtoError::BrokenChain),
        }
        self.trust.accept(&self.user.clone(), &self.own_log.root_key);
        Ok((reqs, root))
    }

    /// C1-06: резервная копия корня под ключом восстановления (≥ 128 бит,
    /// [`crate::recovery::RecoveryKey::generate`]). Корень сверяется с журналом
    /// устройств; после подтверждения копии хост удаляет корень с устройства.
    pub fn export_root_backup(&self, root_secret: &[u8; 32], key: &crate::recovery::RecoveryKey) -> Result<Vec<u8>> {
        if SigningKey::from_bytes(root_secret).verifying_key().to_bytes() != self.own_log.root_key {
            return Err(ProtoError::RootMismatch);
        }
        crate::recovery::export_root_backup(root_secret, &self.user, key)
    }

    /// Копия корня для администратора сервера (страховка: потеряны устройства и
    /// ключ восстановления): корень сверяется с журналом устройств и
    /// запечатывается открытым ключом администратора.
    pub fn export_root_escrow(&self, root_secret: &[u8; 32], escrow_public: &[u8; 32]) -> Result<Vec<u8>> {
        if SigningKey::from_bytes(root_secret).verifying_key().to_bytes() != self.own_log.root_key {
            return Err(ProtoError::RootMismatch);
        }
        crate::recovery::seal_root_escrow(root_secret, &self.user, escrow_public)
    }

    /// Восстановить корень из копии (для смены SSK/корня); корень копии —
    /// текущий корень журнала устройств.
    pub fn import_root_backup(&self, blob: &[u8], key: &crate::recovery::RecoveryKey) -> Result<Zeroizing<[u8; 32]>> {
        let secret = crate::recovery::import_root_backup(blob, &self.user, key)?;
        if SigningKey::from_bytes(&secret).verifying_key().to_bytes() != self.own_log.root_key {
            return Err(ProtoError::RootMismatch);
        }
        Ok(secret)
    }

    /// Данные гранта линковки для нового устройства (только держатель SSK).
    pub fn link_grant_material(&self) -> Result<LinkGrantMaterial> {
        let ssk = self.ssk.as_ref().ok_or(ProtoError::Forbidden)?;
        Ok((ssk.to_bytes(), self.own_entries.clone(), *self.dk.key(), self.dk.generation()))
    }

    /// Пополнить одноразовые прекеи.
    pub fn otk_request(&mut self, n: usize) -> OutRequest {
        let (otks, fb) = self.signed_otks(n);
        OutRequest::id("identity.device.publish_certificate", &ipb::DevicePublishCertificateRequest { log_entry: None, one_time_keys: otks, fallback_key: fb })
    }

    /// Отозвать своё другое устройство: только запись журнала (подпись SSK).
    /// Последствия (ротации ключей, D-11/D-12) — [`Client::revoke_device`] или
    /// [`Client::on_own_device_revoked`].
    pub fn revoke_device_request(&mut self, device_id: &str) -> Result<OutRequest> {
        if device_id == self.device_id {
            return Err(ProtoError::Forbidden);
        }
        let ssk = self.ssk.as_ref().ok_or(ProtoError::Forbidden)?;
        let entry = identity::device_log_entry(&self.user, self.own_log.version + 1, self.own_log.head_hash, DevChange::RevokeDeviceId(device_id.into()), None);
        let op = identity::sign_device_log_entry(ssk, &entry)?;
        self.own_log.apply(&op)?;
        self.own_entries.push(op.clone());
        Ok(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }))
    }

    /// Обычный выход своего другого устройства по просьбе владельца («Завершить сеансы» без смены
    /// ключей): запись отзыва подписью SSK с признаком `sign_out` — SSK раскрытым не считается.
    pub fn sign_out_device_request(&mut self, device_id: &str) -> Result<OutRequest> {
        if device_id == self.device_id || self.own_log.active(device_id).is_none() {
            return Err(ProtoError::NotFound);
        }
        let ssk = self.ssk.as_ref().ok_or(ProtoError::Forbidden)?;
        let mut entry = identity::device_log_entry(&self.user, self.own_log.version + 1, self.own_log.head_hash, DevChange::RevokeDeviceId(device_id.into()), None);
        entry.sign_out = true;
        let op = identity::sign_device_log_entry(ssk, &entry)?;
        self.own_log.apply(&op)?;
        self.own_entries.push(op.clone());
        Ok(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }))
    }

    /// Выход: устройство убирает себя из журнала записью, подписанной СВОИМ
    /// ключом (не SSK) — оставшимся устройствам не нужен ключ восстановления.
    /// После этого состояние движка хост стирает.
    pub fn leave_request(&mut self) -> Result<OutRequest> {
        if self.own_log.active(&self.device_id).is_none() {
            return Err(ProtoError::NotFound);
        }
        let entry = identity::device_log_entry(&self.user, self.own_log.version + 1, self.own_log.head_hash, DevChange::RevokeDeviceId(self.device_id.clone()), None);
        let op = identity::sign_device_log_entry(&self.acc, &entry)?;
        self.own_log.apply(&op)?;
        self.own_entries.push(op.clone());
        Ok(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }))
    }

    /// Новый ключ доставки (раздаётся собеседникам со следующими сообщениями;
    /// сразу — через [`Client::share_delivery_key`] тем, кому раздавался прежний).
    pub fn rotate_delivery_key(&mut self) -> OutRequest {
        self.dk.rotate(&[]);
        OutRequest::id("identity.delivery_key.set", &ipb::DeliveryKeySetRequest { delivery_key: self.dk.key().to_vec() })
    }

    // ── журналы устройств ───────────────────────────────────────────────────

    /// Версия известного журнала пользователя (для `log_sync_anon`).
    pub fn log_version(&self, user: &str) -> u64 {
        if user == self.user {
            return self.own_log.version;
        }
        self.peers.get(user).and_then(|p| p.log.as_ref()).map(|l| l.version).unwrap_or(0)
    }

    /// Устройства пользователя по проверенному журналу: `(v2, legacy_v1)`.
    /// Пустые списки — журнала нет (пользователь целиком на v1).
    pub fn log_devices(&self, user: &str) -> (Vec<String>, Vec<String>) {
        let log = if user == self.user { Some(&self.own_log) } else { self.peers.get(user).and_then(|p| p.log.as_ref()) };
        let Some(log) = log else { return (Vec::new(), Vec::new()) };
        let v2 = log.devices.keys().cloned().collect();
        let legacy = log.legacy.as_ref().map(|l| l.iter().map(|d| d.device_id.clone()).collect()).unwrap_or_default();
        (v2, legacy)
    }

    /// Корневой ключ личности пользователя по проверенному журналу устройств
    /// (свой — по своему журналу): из него клиенты выводят «ключ безопасности»
    /// (отпечаток для сверки вслух). `None` — журнала нет.
    pub fn log_root_key(&self, user: &str) -> Option<[u8; 32]> {
        if user == self.user {
            return (self.own_log.version > 0).then_some(self.own_log.root_key);
        }
        self.peers.get(user).and_then(|p| p.log.as_ref()).map(|l| l.root_key)
    }

    /// Подписанный список v1-устройств пользователя (D-01, FR-058): `None` —
    /// список не публиковался. Только им можно слать легаси-копии.
    pub fn legacy_devices(&self, user: &str) -> Option<Vec<crate::pb::parvane::core::v2::LegacyDevice>> {
        let log = if user == self.user { Some(&self.own_log) } else { self.peers.get(user).and_then(|p| p.log.as_ref()) };
        log.and_then(|l| l.legacy.clone())
    }

    /// Опубликовать/сократить свой список v1-устройств (запись журнала, подпись
    /// SSK). Первая публикация задаёт список, дальше он только сокращается —
    /// v1-устройство, появившееся позже, легаси-копий не получит (FR-058).
    pub fn legacy_devices_request(&mut self, devices: Vec<crate::pb::parvane::core::v2::LegacyDevice>) -> Result<OutRequest> {
        use crate::pb::parvane::core::v2::LegacyDeviceSet;
        let ssk = self.ssk.as_ref().ok_or(ProtoError::Forbidden)?;
        let entry = identity::device_log_entry(
            &self.user,
            self.own_log.version + 1,
            self.own_log.head_hash,
            DevChange::LegacyDevices(LegacyDeviceSet { devices }),
            None,
        );
        let op = identity::sign_device_log_entry(ssk, &entry)?;
        // Проверяем на копии журнала (список только сокращается); сам журнал
        // запись получит синком после подтверждения сервера — при отказе
        // (гонка версий с другим устройством) локальное состояние не расходится.
        self.own_log.clone().apply(&op)?;
        Ok(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }))
    }

    /// Легаси-копии v1-устройствам (FR-054): готовый v1 `SendPayload` (JSON) с
    /// тем же id, что у v2-сообщения, — запрос `msg.deliver_legacy`. Сервер
    /// проводит его как v1-отправку и не мостит обратно в журналы v2-устройств.
    pub fn legacy_deliver_request(&self, message_id: &str, send_payload_json: &[u8]) -> Result<OutRequest> {
        if message_id.len() != 36 || send_payload_json.is_empty() {
            return Err(ProtoError::InvalidField("legacy"));
        }
        Ok(OutRequest::id(
            "msg.deliver_legacy",
            &mpb::DeliverLegacyRequest { message_id: message_id.into(), send_payload_json: send_payload_json.to_vec() },
        ))
    }

    /// Принять записи журнала устройств (после `log_sync(_anon)` с after = log_version).
    pub fn ingest_log(&mut self, user: &str, entries: Vec<SignedOp>) -> Result<LogVerdict> {
        if user == self.user {
            let before: Vec<String> = self.own_log.devices.keys().cloned().collect();
            for e in entries {
                self.own_log.apply(&e)?;
                self.own_entries.push(e);
            }
            // spec 026: ник сменён на другом своём устройстве — хост дочитывает журнал нового адреса
            if self.own_log.renamed_to.is_some() {
                return Ok(LogVerdict::Moved);
            }
            self.refresh_own_after_log();
            if before.iter().any(|d| !self.own_log.devices.contains_key(d)) {
                self.on_devices_removed(&user.to_string());
            }
            return Ok(LogVerdict::Known);
        }
        let current = self.peers.get(user).and_then(|p| p.log.clone());
        let mut log = match current {
            Some(l) => l,
            None => DeviceLog::new(user)?,
        };
        let mut appended = vec![];
        for e in entries {
            log.apply(&e)?;
            appended.push(e);
        }
        // Журнала нет (собеседник на v1): ни TOFU, ни закрепления.
        if log.version == 0 {
            return Ok(LogVerdict::New);
        }
        let peer = self.peers.entry(user.to_string()).or_default();
        // Откат/форк (D-11): голова не может уйти назад или разойтись.
        let at_pin = if peer.pin.version > 0 && peer.pin.version <= log.version {
            let idx = usize::try_from(peer.pin.version).map_err(|_| ProtoError::BrokenChain)?;
            let all: Vec<&SignedOp> = peer.entries.iter().chain(appended.iter()).collect();
            all.get(idx.saturating_sub(1)).map(|op| identity::device_log_hash(op))
        } else {
            None
        };
        peer.pin.advance(log.version, log.head_hash, at_pin)?;
        let verdict = match self.trust.observe(user, &log.root_key) {
            TrustVerdict::New => LogVerdict::New,
            TrustVerdict::Known => LogVerdict::Known,
            TrustVerdict::Changed => {
                let mut all = peer.entries.clone();
                all.extend(appended);
                peer.pending_root = Some(all);
                return Ok(LogVerdict::RootChanged);
            }
        };
        peer.entries.extend(appended);
        if log.version > 0 {
            self.sticky.mark(user);
        }
        let is_moved = log.renamed_to.is_some();
        let is_continuation = log.renamed_from.is_some();
        let removed = !is_moved && peer.log.as_ref().is_some_and(|old| old.devices.keys().any(|d| !log.devices.contains_key(d)));
        peer.log = Some(log);
        if removed {
            self.on_devices_removed(user);
        }
        // spec 026: смена ника собеседником
        if is_moved {
            return Ok(LogVerdict::Moved);
        }
        if is_continuation && self.link_peer_rename(user).is_some() {
            return Ok(LogVerdict::Renamed);
        }
        Ok(verdict)
    }

    /// spec 026: прежний адрес собеседника, чей журнал продолжает этот (после `Renamed`).
    pub fn peer_renamed_from(&self, user: &str) -> Option<String> {
        self.peer_log(user).and_then(|l| l.renamed_from.clone())
    }

    /// SHA-256 первой записи известного журнала пользователя («отпечаток
    /// журнала»): другой отпечаток на сервере — журнал начат заново.
    pub fn log_genesis(&self, user: &str) -> Option<[u8; 32]> {
        let first = if user == self.user { self.own_entries.first() } else { self.peers.get(user).and_then(|p| p.entries.first()) };
        first.map(identity::device_log_hash)
    }

    /// Ответ `identity.device.log_sync(_anon)` с отпечатком журнала сервера
    /// (T129). Отпечаток совпал или неизвестен — обычный [`Client::ingest_log`].
    /// Другой отпечаток — журнал начат заново (смена корня): по дельте —
    /// `Replaced` (хост перечитывает журнал с версии 0); по полному журналу —
    /// `RootChanged` (чужой: ждёт [`Client::accept_pending_root`]) либо отказ,
    /// если корень прежний (откат/форк, D-11). Свой журнал заменён — всегда
    /// `Replaced`: это устройство в новой личности не состоит.
    pub fn ingest_log_sync(&mut self, user: &str, entries: Vec<SignedOp>, genesis_hash: &[u8]) -> Result<LogVerdict> {
        let known = self.log_genesis(user);
        let replaced = genesis_hash.len() == 32 && known.is_some_and(|k| k[..] != *genesis_hash);
        if !replaced {
            return self.ingest_log(user, entries);
        }
        if user == self.user {
            return Ok(LogVerdict::Replaced);
        }
        let from_start = entries.first().is_some_and(|e| identity::device_log_hash(e)[..] == *genesis_hash);
        if !from_start {
            return Ok(LogVerdict::Replaced);
        }
        let mut log = DeviceLog::new(user)?;
        for e in &entries {
            log.apply(e)?;
        }
        match self.trust.observe(user, &log.root_key) {
            TrustVerdict::Changed => {
                self.peers.entry(user.to_string()).or_default().pending_root = Some(entries);
                Ok(LogVerdict::RootChanged)
            }
            // Корень прежний, а журнал другой — откат/форк: не принимаем.
            _ => Err(ProtoError::BrokenChain),
        }
    }

    /// KEY-1 v2: принять смену корня собеседника, замеченную синком журнала
    /// (хост показал предупреждение «ключ безопасности изменился»).
    pub fn accept_pending_root(&mut self, user: &str) -> Result<bool> {
        let Some(entries) = self.peers.get_mut(user).and_then(|p| p.pending_root.take()) else { return Ok(false) };
        self.accept_root_change(user, entries)?;
        self.sticky.mark(user);
        Ok(true)
    }

    /// Смена корня собеседника (KEY-1): пользователь подтвердил — принять новый
    /// журнал целиком (`entries` — с версии 1).
    pub fn accept_root_change(&mut self, user: &str, entries: Vec<SignedOp>) -> Result<()> {
        let mut log = DeviceLog::new(user)?;
        for e in &entries {
            log.apply(e)?;
        }
        self.trust.accept(user, &log.root_key);
        let peer = self.peers.entry(user.to_string()).or_default();
        peer.entries = entries;
        peer.pin = LogPin { version: log.version, head_hash: log.head_hash };
        peer.log = Some(log);
        peer.pending_root = None;
        self.sessions.retain(|(u, _), _| u != user);
        self.old_sessions.retain(|(u, _), _| u != user);
        Ok(())
    }

    fn peer_log(&self, user: &str) -> Option<&DeviceLog> {
        if user == self.user {
            return Some(&self.own_log);
        }
        self.peers.get(user).and_then(|p| p.log.as_ref())
    }

    /// Принять бандл (сертификаты + прекеи) и открыть исходящие сессии.
    pub fn ingest_bundle(&mut self, user: &str, devices: Vec<ipb::DeviceBundle>) -> Result<usize> {
        let log = self.peer_log(user).cloned().ok_or(ProtoError::BadCertificate)?;
        let mut opened = 0;
        for d in devices {
            let Some(c) = d.certificate.as_ref() else { continue };
            let Ok(v) = identity::verify_certificate(c, Some(user)) else { continue };
            // Только устройства из проверенного журнала (сервер не подсунет лишнее).
            let Some(known) = log.active(&v.cert.device_id) else { continue };
            if known.cert != v.cert {
                continue;
            }
            let key = (user.to_string(), v.cert.device_id.clone());
            if self.sessions.contains_key(&key) || (user == self.user && v.cert.device_id == self.device_id) {
                continue;
            }
            let ed = v.olm_ed25519()?;
            let valid = |k: &OneTimeKey| k.curve25519.len() == 32 && sign::verify_ctx(&ed, &k.signature, sign::ctx::OTK, &[&k.key_id, &k.curve25519]).is_ok();
            let otk = d.one_time_key.filter(|k| valid(k)).or(d.fallback_key.filter(|k| valid(k)));
            let Some(otk) = otk else { continue };
            let s = self.acc.outbound(&v.cert.olm_curve25519, &otk.curve25519)?;
            self.sessions.insert(key, s);
            opened += 1;
        }
        Ok(opened)
    }

    /// Готовность отправки пользователю: чего не хватает.
    pub fn check_peer(&self, user: &str) -> CResult<()> {
        // ENG-05: автор сослался на более новый журнал устройств — сначала догнать (в нём может быть отзыв)
        if let Some(&claimed) = self.log_behind.get(user) {
            let have = self.log_version(user);
            if claimed > have {
                return need(Need::PeerLog { user: user.into(), after: have });
            }
        }
        if user != self.user {
            let Some(p) = self.peers.get(user) else { return need(Need::PeerLog { user: user.into(), after: 0 }) };
            if p.pending_root.is_some() {
                return need(Need::RootChanged { user: user.into() });
            }
            if p.log.is_none() {
                return need(Need::PeerLog { user: user.into(), after: 0 });
            }
        }
        let log = self.peer_log(user).ok_or_else(|| ClientError::Need(Need::PeerLog { user: user.into(), after: 0 }))?;
        for id in log.devices.keys() {
            if user == self.user && id == &self.device_id {
                continue;
            }
            if !self.sessions.contains_key(&(user.to_string(), id.clone())) {
                return need(Need::Bundle { user: user.into() });
            }
        }
        Ok(())
    }

    /// Ключи доступа собеседников — в грант линковки: новое своё устройство
    /// пишет и звонит знакомым по ключу сразу, а не слепым жетоном (звонок по
    /// жетону сервер не принимает вовсе).
    pub fn peer_delivery_keys(&self) -> Vec<(String, Vec<u8>, u64)> {
        self.peers.iter().filter_map(|(u, p)| p.delivery_key.as_ref().map(|(k, g)| (u.clone(), k.clone(), *g))).collect()
    }

    /// Ключ доступа собеседника, полученный вне журнала (профиль/QR).
    pub fn set_peer_delivery_key(&mut self, user: &str, key: Vec<u8>, generation: u64) {
        if key.len() == 32 {
            self.peers.entry(user.to_string()).or_default().delivery_key = Some((key, generation));
        }
    }

    /// Добавить слепые жетоны (после `tokens.issue_blinded` + finalize).
    /// Срок — по ключу из списка, полученного анонимно (неизвестный ключ — без срока).
    pub fn add_tokens(&mut self, t: Vec<AnonToken>) {
        for tok in t {
            let until = self.token_keys.iter().find(|k| k.key_id == tok.key_id).map(|k| k.valid_until_ms).unwrap_or(i64::MAX);
            self.stock.add(vec![tok], until);
        }
    }

    /// Действующих жетонов в запасе.
    pub fn token_count(&self) -> usize {
        self.stock.len(now_ms())
    }

    /// Запас на исходе (UI; пополнение всё равно по расписанию).
    pub fn tokens_low(&self) -> bool {
        self.stock.is_low(now_ms())
    }

    /// Пора получать суточную партию жетонов (хост проверяет по таймеру, НЕ
    /// перед отправкой незнакомцу — D-06: выдача не должна связываться с тратой).
    pub fn token_refill_due(&self, now_ms: i64) -> bool {
        self.stock.refill_due(now_ms)
    }

    /// Время следующей партии (мс; None — ещё не получали: получить сразу).
    pub fn next_token_refill_ms(&self) -> Option<i64> {
        self.stock.next_refill_ms()
    }

    /// Размер партии — вся суточная квота.
    pub fn token_batch_size(&self) -> usize {
        self.stock.batch_size()
    }

    /// Запрос списка ключей выпуска — ТОЛЬКО анонимным каналом (D-06: сервер
    /// не может выдать аккаунту «свой» список).
    pub fn token_key_list_request(&self) -> OutRequest {
        OutRequest::anon("identity.tokens.key_list", &ipb::TokensKeyListRequest {})
    }

    /// Запрос жетонов: список ключей выпуска получен АНОНИМНО
    /// (`identity.tokens.key_list`) и проверен ключом сервера (D-06).
    /// Партия планируется на следующие сутки со случайной задержкой сразу
    /// (и при неудаче — повтор не раньше срока, без «дозапросов»).
    pub fn token_request(&mut self, key_list: &crate::pb::parvane::core::v2::SignedTokenKeyList, server_key: &[u8], count: usize) -> Result<OutRequest> {
        let trusted = crate::tokens::verify_key_list(key_list, server_key)?;
        let now = now_ms();
        let key = trusted
            .keys
            .iter()
            .filter(|k| k.valid_from_ms <= now && now <= k.valid_until_ms)
            .max_by_key(|k| k.valid_from_ms)
            .ok_or(ProtoError::Expired)?
            .clone();
        let (req, blinded) = crate::tokens::TokenRequest::new(&trusted, &key.key_id, count)?;
        // Ключ, выведенный из списка, — его жетоны больше не принимаются.
        self.stock.retain_keys(&trusted.keys);
        self.token_keys = trusted.keys;
        self.token_req = Some((req, key));
        self.stock.schedule_next(now, crate::access::random_jitter());
        Ok(OutRequest::id("identity.tokens.issue_blinded", &ipb::TokensIssueBlindedRequest { blinded }))
    }

    /// Ответ на запрос жетонов → жетоны в запас. D-06: выдача ключом, которого
    /// нет в списке, полученном анонимно (или не тем, что запрошен), отвергается.
    pub fn token_response(&mut self, resp: &ipb::TokensIssueBlindedResponse) -> Result<usize> {
        let (req, key) = self.token_req.take().ok_or(ProtoError::InvalidField("token_request"))?;
        let listed = self.token_keys.iter().any(|k| k.key_id == resp.key_id && k.rsa_public_key == key.rsa_public_key);
        if resp.key_id != key.key_id || !listed {
            return Err(ProtoError::Forbidden);
        }
        if !resp.public_key.is_empty() && resp.public_key != key.rsa_public_key {
            return Err(ProtoError::Forbidden);
        }
        let t = req.finalize(&resp.blind_signatures)?;
        let n = t.len();
        self.stock.add(t, key.valid_until_ms);
        Ok(n)
    }

    // ── личные сообщения ────────────────────────────────────────────────────

    fn seal_for(&mut self, user: &str, devices: &[String], chat: &str, content: &Content, access: Access) -> Result<mpb::DeliverSealedRequest> {
        let o = SealOpts { op_id: sign::new_op_id(), ts_ms: now_ms(), l2: self.direct_must_pad(chat) };
        self.seal_for_opts(user, devices, chat, content, access, o)
    }

    /// Запечатать операцию для устройств `user`. `o.l2` — выравнивать
    /// внутренний слой по сетке L2 (режим чата или раздача ключей L2-группы).
    fn seal_for_opts(&mut self, user: &str, devices: &[String], chat: &str, content: &Content, access: Access, o: SealOpts) -> Result<mpb::DeliverSealedRequest> {
        let log = self.peer_log(user).cloned().ok_or(ProtoError::BadCertificate)?;
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let audience: Vec<DeviceRef> = devices.iter().map(|d| DeviceRef { address: user.into(), device_id: d.clone() }).collect();
        let op = msg::sign_direct_at(&self.acc, content, chat, audience, o.ts_ms, o.op_id, self.own_log.version)?;
        let mut envelopes = vec![];
        for d in devices {
            let Some(dev) = log.active(d) else { continue };
            let hpke = dev.hpke_x25519()?;
            let Some(sess) = self.sessions.get_mut(&(user.to_string(), d.clone())) else { continue };
            let inner = msg::seal_inner(&cert, sess, &op)?;
            envelopes.push(seal::seal(&DeviceRef { address: user.into(), device_id: d.clone() }, &hpke, access.clone(), inner, o.l2)?);
        }
        Ok(mpb::DeliverSealedRequest { envelopes })
    }

    fn access_for(&mut self, user: &str) -> CResult<Access> {
        if user == self.user {
            return Ok(Access::DeliveryKey(self.dk.key().to_vec()));
        }
        if let Some((k, _)) = self.peers.get(user).and_then(|p| p.delivery_key.clone()) {
            return Ok(Access::DeliveryKey(k));
        }
        // Незнакомец с другого сервера — жетоном его сервера (spec 028)
        let domain = crate::address::address_domain(user).unwrap_or_default().to_ascii_lowercase();
        let stock = if domain.is_empty() || domain.eq_ignore_ascii_case(&self.domain) {
            &mut self.stock
        } else {
            match self.foreign_tokens.get_mut(&domain) {
                Some(f) => &mut f.stock,
                None => return need(Need::Token { user: user.into() }),
            }
        };
        match stock.take(now_ms()) {
            Some(t) => Ok(Access::AnonToken(t)),
            None => need(Need::Token { user: user.into() }),
        }
    }

    /// Жетон не ушёл (сборка запроса не удалась) — вернуть в запас.
    fn return_access(&mut self, access: Access) {
        if let Access::AnonToken(t) = access {
            // Жетон чужого сервера — в его запас (ключ выпуска есть только в его списке)
            if let Some(f) = self.foreign_tokens.values_mut().find(|f| f.keys.iter().any(|k| k.key_id == t.key_id)) {
                let until = f.keys.iter().find(|k| k.key_id == t.key_id).map(|k| k.valid_until_ms).unwrap_or(i64::MAX);
                f.stock.put_back(t, until);
                return;
            }
            let until = self.token_keys.iter().find(|k| k.key_id == t.key_id).map(|k| k.valid_until_ms).unwrap_or(i64::MAX);
            self.stock.put_back(t, until);
        }
    }

    // ── жетоны чужих серверов (spec 028) ────────────────────────────────────
    // Те же правила, что у своих (D-06): список ключей выпуска — анонимно и
    // проверен ключом ТОГО сервера (`server.describe` с адресатом-доменом),
    // выдача — проверена по этому списку. Хост ставит `dest_domain` = домен.

    /// Действующих жетонов сервера `domain`.
    pub fn token_count_for(&self, domain: &str) -> usize {
        self.foreign_tokens.get(&domain.to_ascii_lowercase()).map_or(0, |f| f.stock.len(now_ms()))
    }

    /// Пора пополнить запас сервера `domain` (нет запаса — сразу).
    pub fn token_refill_due_for(&self, domain: &str, now_ms: i64) -> bool {
        self.foreign_tokens.get(&domain.to_ascii_lowercase()).is_none_or(|f| f.stock.refill_due(now_ms))
    }

    /// Домены чужих серверов, чьи запасы пора пополнить.
    pub fn token_refill_due_domains(&self, now_ms: i64) -> Vec<String> {
        self.foreign_tokens.iter().filter(|(_, f)| f.stock.refill_due(now_ms)).map(|(d, _)| d.clone()).collect()
    }

    /// Запрос жетонов сервера `domain` по его списку ключей (получен анонимно с
    /// адресатом `domain`) и его ключу сервера.
    pub fn token_request_for(
        &mut self,
        domain: &str,
        key_list: &crate::pb::parvane::core::v2::SignedTokenKeyList,
        server_key: &[u8],
        count: usize,
    ) -> Result<OutRequest> {
        let domain = domain.to_ascii_lowercase();
        if !crate::address::is_valid_domain(&domain) || domain.eq_ignore_ascii_case(&self.domain) {
            return Err(ProtoError::BadAddress);
        }
        let trusted = crate::tokens::verify_key_list(key_list, server_key)?;
        let now = now_ms();
        let key = trusted
            .keys
            .iter()
            .filter(|k| k.valid_from_ms <= now && now <= k.valid_until_ms)
            .max_by_key(|k| k.valid_from_ms)
            .ok_or(ProtoError::Expired)?
            .clone();
        let (req, blinded) = crate::tokens::TokenRequest::new(&trusted, &key.key_id, count)?;
        let f = self.foreign_tokens.entry(domain).or_default();
        f.stock.retain_keys(&trusted.keys);
        f.keys = trusted.keys;
        f.req = Some((req, key));
        f.stock.schedule_next(now, crate::access::random_jitter());
        Ok(OutRequest::id("identity.tokens.issue_blinded", &ipb::TokensIssueBlindedRequest { blinded }))
    }

    /// Ответ сервера `domain` на запрос жетонов → его запас.
    pub fn token_response_for(&mut self, domain: &str, resp: &ipb::TokensIssueBlindedResponse) -> Result<usize> {
        let f = self.foreign_tokens.get_mut(&domain.to_ascii_lowercase()).ok_or(ProtoError::InvalidField("token_request"))?;
        let (req, key) = f.req.take().ok_or(ProtoError::InvalidField("token_request"))?;
        let listed = f.keys.iter().any(|k| k.key_id == resp.key_id && k.rsa_public_key == key.rsa_public_key);
        if resp.key_id != key.key_id || !listed {
            return Err(ProtoError::Forbidden);
        }
        if !resp.public_key.is_empty() && resp.public_key != key.rsa_public_key {
            return Err(ProtoError::Forbidden);
        }
        let t = req.finalize(&resp.blind_signatures)?;
        let n = t.len();
        f.stock.add(t, key.valid_until_ms);
        Ok(n)
    }

    /// Сервер отверг ключ доступа собеседника (FORBIDDEN): он сменил ключ
    /// (отзыв устройства), новый ещё не дошёл — дальше жетоном до раздачи.
    pub fn on_delivery_key_rejected(&mut self, peer: &str) {
        if let Some(p) = self.peers.get_mut(peer) {
            p.delivery_key = None;
        }
    }

    /// Ключ доступа собеседника известен (без жетона).
    pub fn has_peer_delivery_key(&self, peer: &str) -> bool {
        self.peers.get(peer).is_some_and(|p| p.delivery_key.is_some())
    }

    /// Сигнал звонка собеседнику (D-08): тот же sealed-конверт на каждое его
    /// устройство, анонимным каналом; оффер — `call.ring_sealed` (будит
    /// устройства), остальное — `call.signal_sealed`. В журнал не пишется, своим
    /// устройствам копия не идёт. `Need` — как у личного сообщения.
    pub fn prepare_call(&mut self, peer: &str, signal: &cpb::CallSignal) -> CResult<Vec<OutRequest>> {
        // spec 026: прежний ник собеседника — по новому адресу
        let current = self.current_address(peer);
        let peer = current.as_str();
        if peer == self.user
            || signal.call_id.len() != msg::CALL_ID_LEN
            || !(signal.group_call_id.is_empty() || signal.group_call_id.len() == msg::CALL_ID_LEN)
        {
            return Err(ProtoError::InvalidField("call").into());
        }
        self.check_peer(peer)?;
        let log = self.peer_log(peer).cloned().ok_or(ProtoError::BadCertificate)?;
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let devices: Vec<String> = log.devices.keys().cloned().collect();
        for d in &devices {
            if policy::choose(&mut self.sticky, peer, Some(&log), d, None, &[]) != SendFormat::SealedV2 {
                return Err(ClientError::Need(Need::Forbidden));
            }
        }
        let audience: Vec<DeviceRef> = devices.iter().map(|d| DeviceRef { address: peer.into(), device_id: d.clone() }).collect();
        // Сигнал звонка сервер принимает только по ключу доступа адресата
        // (D-08): без него одноразовый жетон был бы потрачен на заведомый отказ.
        if !self.has_peer_delivery_key(peer) {
            return Err(ProtoError::Forbidden.into());
        }
        let call = Ref { domain: self.domain.clone(), id: signal.call_id.clone() };
        let op = msg::sign_call(&self.acc, signal, call, audience, now_ms())?;
        let access = self.access_for(peer)?;
        let mut envelopes = vec![];
        for d in &devices {
            let Some(dev) = log.active(d) else { continue };
            let sealed = (|| -> Result<_> {
                let hpke = dev.hpke_x25519()?;
                let Some(sess) = self.sessions.get_mut(&(peer.to_string(), d.clone())) else { return Ok(None) };
                let inner = msg::seal_inner(&cert, sess, &op)?;
                seal::seal(&DeviceRef { address: peer.into(), device_id: d.clone() }, &hpke, access.clone(), inner, false).map(Some)
            })();
            match sealed {
                Ok(Some(env)) => envelopes.push(env),
                Ok(None) => {}
                Err(e) => {
                    self.return_access(access);
                    return Err(e.into());
                }
            }
        }
        if envelopes.is_empty() {
            self.return_access(access);
            return Err(ClientError::Need(Need::Bundle { user: peer.into() }));
        }
        // Будит устройства первый сигнал звонка: оффер личного звонка либо
        // приглашение в групповой. Оффер пары внутри группового звонка — обычный
        // сигнал (согласие на звонок уже дано, лимит вызовов он не тратит).
        let ring = match &signal.signal {
            Some(cpb::call_signal::Signal::Offer(_)) => signal.group_call_id.is_empty(),
            Some(cpb::call_signal::Signal::GroupRing(_)) => true,
            _ => false,
        };
        let method = if ring { "call.ring_sealed" } else { "call.signal_sealed" };
        let mut out = vec![];
        // Вызов: адресату нужен НАШ ключ доступа, чтобы ответить (answer, ICE —
        // те же сигналы звонка, жетоном их не отправить). Не раздавали — раздаём
        // перед вызовом, как с первым сообщением (иначе звонок тому, кто нам
        // писал, а мы ему нет, звонил бы, но не соединялся).
        if ring {
            out.extend(self.share_delivery_key(peer)?);
        }
        out.push(OutRequest::anon(method, &cpb::SignalSealedRequest { envelopes }));
        Ok(out)
    }

    /// Сигнал звонка своим ДРУГИМ устройствам (spec 024): «принят здесь» / «отклонён здесь» — `Hangup`
    /// с причиной `ANSWERED_ELSEWHERE` либо `DECLINED`; остальные устройства перестают звонить. Другие
    /// виды сигналов своим устройствам не шлются. Нет других устройств — пустой список.
    pub fn prepare_call_own(&mut self, signal: &cpb::CallSignal) -> CResult<Vec<OutRequest>> {
        if signal.call_id.len() != msg::CALL_ID_LEN || !matches!(signal.signal, Some(cpb::call_signal::Signal::Hangup(_))) {
            return Err(ProtoError::InvalidField("call").into());
        }
        let me = self.user.clone();
        self.check_peer(&me)?;
        let log = self.own_log.clone();
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let devices: Vec<String> = log.devices.keys().filter(|d| **d != self.device_id).cloned().collect();
        if devices.is_empty() {
            return Ok(vec![]);
        }
        let audience: Vec<DeviceRef> = devices.iter().map(|d| DeviceRef { address: me.clone(), device_id: d.clone() }).collect();
        let call = Ref { domain: self.domain.clone(), id: signal.call_id.clone() };
        let op = msg::sign_call(&self.acc, signal, call, audience, now_ms())?;
        let access = self.access_for(&me)?;
        let mut envelopes = vec![];
        for d in &devices {
            let Some(dev) = log.active(d) else { continue };
            let hpke = dev.hpke_x25519()?;
            let Some(sess) = self.sessions.get_mut(&(me.clone(), d.clone())) else { continue };
            let inner = msg::seal_inner(&cert, sess, &op)?;
            envelopes.push(seal::seal(&DeviceRef { address: me.clone(), device_id: d.clone() }, &hpke, access.clone(), inner, false)?);
        }
        if envelopes.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![OutRequest::anon("call.signal_sealed", &cpb::SignalSealedRequest { envelopes })])
    }

    /// Подготовить личное сообщение: копии устройствам собеседника и своим
    /// другим устройствам (отдельными запросами, D-05) + раздача своего ключа
    /// доставки собеседнику, если он его ещё не получал.
    pub fn prepare_direct(&mut self, peer: &str, content: &Content) -> CResult<Vec<OutRequest>> {
        self.prepare_direct_id(peer, content, sign::new_op_id())
    }

    /// То же с `op_id` хоста (id сообщения в UI; один на все копии).
    pub fn prepare_direct_id(&mut self, peer: &str, content: &Content, op_id: Vec<u8>) -> CResult<Vec<OutRequest>> {
        // spec 026: прежний ник собеседника — по новому адресу
        let current = self.current_address(peer);
        let peer = current.as_str();
        let ts_ms = now_ms();
        let out = self.prepare_direct_opts(peer, content, DirectOpts { op_id: op_id.clone(), share_dk: true, force_l2: false, ts_ms })?;
        if msg::is_trackable(content) && peer != self.user {
            self.reads.track(&op_id, msg::ChatKey::Direct(peer.to_string()));
        }
        // Своё предпочтение L2 — той же меткой, что ушла собеседнику и своим
        // устройствам (LWW по метке операции).
        if let Some(content::Kind::ChatMode(m)) = &content.kind {
            let me = self.user.clone();
            self.l2_apply_direct(peer, &me, m.l2, ts_ms);
        }
        Ok(out)
    }

    fn prepare_direct_inner(&mut self, peer: &str, content: &Content, op_id: Vec<u8>, share_dk: bool) -> CResult<Vec<OutRequest>> {
        self.prepare_direct_opts(peer, content, DirectOpts { op_id, share_dk, force_l2: false, ts_ms: now_ms() })
    }

    fn prepare_direct_opts(&mut self, peer: &str, content: &Content, o: DirectOpts) -> CResult<Vec<OutRequest>> {
        let DirectOpts { op_id, share_dk, force_l2, ts_ms } = o;
        // Смена режима сама идёт выровненной: по размеру её не отличить.
        let l2 = force_l2 || matches!(content.kind, Some(content::Kind::ChatMode(_))) || self.direct_must_pad(peer);
        self.check_peer(peer)?;
        self.check_peer(&self.user.clone())?;
        let peer_devices: Vec<String> = self.peer_log(peer).map(|l| l.devices.keys().cloned().collect()).unwrap_or_default();
        // Журнал собеседника уже есть, а устройств в нём ещё нет (его первое
        // устройство публикуется прямо сейчас: корень записан, сертификат — нет):
        // запечатывать некому. Раньше отправка «в ноль устройств» возвращала успех,
        // и сообщение молча терялось — теперь хост перечитывает журнал и повторяет.
        if peer != self.user && peer_devices.is_empty() {
            let after = self.peer_log(peer).map(|l| l.version).unwrap_or(0);
            return need(Need::PeerLog { user: peer.into(), after });
        }
        // D-13: формат по подписанным данным и памяти «видел v2».
        let plog = self.peer_log(peer).cloned();
        for d in &peer_devices {
            if policy::choose(&mut self.sticky, peer, plog.as_ref(), d, None, &[]) != SendFormat::SealedV2 {
                return Err(ClientError::Need(Need::Forbidden));
            }
        }
        let mut out = vec![];
        let mut contents = vec![content.clone()];
        if share_dk && peer != self.user && self.dk.needs_share(peer) {
            contents.insert(0, self.delivery_key_content());
        }
        for (i, c) in contents.iter().enumerate() {
            let access = self.access_for(peer)?;
            let id = if i + 1 == contents.len() { op_id.clone() } else { sign::new_op_id() };
            let req = match self.seal_for_opts(peer, &peer_devices, peer, c, access.clone(), SealOpts { op_id: id, ts_ms, l2 }) {
                Ok(r) => r,
                Err(e) => {
                    self.return_access(access);
                    return Err(e.into());
                }
            };
            if !req.envelopes.is_empty() {
                out.push(OutRequest::anon("msg.deliver_sealed", &req));
            } else {
                self.return_access(access);
            }
        }
        if contents.len() == 2 {
            self.dk.mark_shared(peer);
        }
        // Свои другие устройства: копия того же содержимого (чат = собеседник).
        let own: Vec<String> = self.own_log.devices.keys().filter(|d| **d != self.device_id).cloned().collect();
        let own_copy = !matches!(content.kind, Some(content::Kind::DeliveryKey(_)));
        if !own.is_empty() && peer != self.user && own_copy {
            let me = self.user.clone();
            let req = self.seal_for_opts(&me, &own, peer, content, Access::DeliveryKey(self.dk.key().to_vec()), SealOpts { op_id, ts_ms, l2 })?;
            if !req.envelopes.is_empty() {
                out.push(OutRequest::anon("msg.deliver_sealed", &req));
            }
        }
        Ok(out)
    }

    /// Только для тестов (cargo-feature `test-inject`, T041): личное сообщение
    /// с произвольными байтами `Content` — например, вид из будущей версии
    /// (номер поля, которого нет в content.proto). Все устройства собеседника,
    /// без копий своим устройствам и без раздачи своего ключа доступа.
    #[cfg(feature = "test-inject")]
    pub fn prepare_direct_raw(&mut self, peer: &str, content_bytes: &[u8]) -> CResult<Vec<OutRequest>> {
        // spec 026: прежний ник собеседника — по новому адресу
        let current = self.current_address(peer);
        let peer = current.as_str();
        use crate::pb::parvane::core::v2::{op_header::Conversation, OpHeader};
        self.check_peer(peer)?;
        let log = self.peer_log(peer).cloned().ok_or(ProtoError::BadCertificate)?;
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let devices: Vec<String> = log.devices.keys().cloned().collect();
        let header = OpHeader {
            domain: msg::MSG_DOMAIN.into(),
            op_type: msg::CONTENT_OP.into(),
            op_id: sign::new_op_id(),
            audience: devices.iter().map(|d| DeviceRef { address: peer.into(), device_id: d.clone() }).collect(),
            ts_ms: now_ms(),
            conversation: Some(Conversation::DirectPeer(UserRef { address: peer.into() })),
            ..Default::default()
        };
        let op = sign::sign_op(&self.acc, header, content_bytes.to_vec())?;
        let access = self.access_for(peer)?;
        let mut envelopes = vec![];
        for d in &devices {
            let Some(dev) = log.active(d) else { continue };
            let hpke = dev.hpke_x25519()?;
            let Some(sess) = self.sessions.get_mut(&(peer.to_string(), d.clone())) else { continue };
            let inner = msg::seal_inner(&cert, sess, &op)?;
            envelopes.push(seal::seal(&DeviceRef { address: peer.into(), device_id: d.clone() }, &hpke, access.clone(), inner, false)?);
        }
        if envelopes.is_empty() {
            self.return_access(access);
            return Ok(vec![]);
        }
        Ok(vec![OutRequest::anon("msg.deliver_sealed", &mpb::DeliverSealedRequest { envelopes })])
    }

    fn delivery_key_content(&self) -> Content {
        Content { kind: Some(content::Kind::DeliveryKey(DeliveryKeyShare { delivery_key: self.dk.key().to_vec(), generation: self.dk.generation() })), ..Default::default() }
    }

    /// Раздать текущий ключ доступа собеседнику (T075): после ротации — тем,
    /// кому раздавался прежний. Без повторной раздачи, если уже получил.
    pub fn share_delivery_key(&mut self, peer: &str) -> CResult<Vec<OutRequest>> {
        // spec 026: прежний ник собеседника — по новому адресу
        let current = self.current_address(peer);
        let peer = current.as_str();
        if peer == self.user || !self.dk.needs_share(peer) {
            return Ok(vec![]);
        }
        let c = self.delivery_key_content();
        let out = self.prepare_direct_inner(peer, &c, sign::new_op_id(), false)?;
        self.dk.mark_shared(peer);
        Ok(out)
    }

    /// Отозвать ключ доступа у одного собеседника (FR-033; блокировка): новый
    /// ключ — на сервер, своим устройствам и всем, кому раздавался прежний,
    /// КРОМЕ `peer`. Дальше `peer` может писать только как незнакомый
    /// (анонимные жетоны, если получатель их принимает). Собеседнику, у
    /// которого ключа не было, отзывать нечего — пустой итог.
    pub fn revoke_contact_access(&mut self, peer: &str) -> CResult<RevocationOutcome> {
        if peer == self.user {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        if !self.dk.shared().contains_key(peer) {
            return Ok(RevocationOutcome::default());
        }
        // Сессии со своими устройствами — до смены ключа (иначе добор посреди
        // раздачи оставил бы их со старым).
        self.check_peer(&self.user.clone())?;
        let mut o = RevocationOutcome::default();
        let targets = self.dk.rotate(&[peer.to_string()]);
        o.requests.push(OutRequest::id("identity.delivery_key.set", &ipb::DeliveryKeySetRequest { delivery_key: self.dk.key().to_vec() }));
        let dkc = self.delivery_key_content();
        o.requests.extend(self.seal_to_own_devices(&dkc)?);
        for p in targets {
            match self.share_delivery_key(&p) {
                Ok(r) => o.requests.extend(r),
                Err(_) => o.pending_key_shares.push(p),
            }
        }
        Ok(o)
    }

    /// Собеседники, которым раздавался ключ доступа, но не текущее поколение.
    pub fn pending_delivery_key_shares(&self) -> Vec<String> {
        self.dk.shared().iter().filter(|(_, g)| **g != self.dk.generation()).map(|(u, _)| u.clone()).collect()
    }

    /// Больше не раздавать ключ собеседнику (блокировка). Чтобы отнять уже
    /// выданный — `rotate_delivery_key` + `share_delivery_key` оставшимся.
    pub fn forget_delivery_key_peer(&mut self, peer: &str) {
        self.dk.forget(peer);
    }

    /// Поколение своего ключа доступа.
    pub fn delivery_key_generation(&self) -> u64 {
        self.dk.generation()
    }

    /// Копия содержимого своим другим устройствам (один запрос, D-05).
    fn seal_to_own_devices(&mut self, c: &Content) -> CResult<Option<OutRequest>> {
        let own: Vec<String> = self.own_log.devices.keys().filter(|d| **d != self.device_id).cloned().collect();
        if own.is_empty() {
            return Ok(None);
        }
        self.check_peer(&self.user.clone())?;
        let me = self.user.clone();
        let r = self.seal_for(&me, &own, &me, c, Access::DeliveryKey(self.dk.key().to_vec()))?;
        Ok((!r.envelopes.is_empty()).then(|| OutRequest::anon("msg.deliver_sealed", &r)))
    }

    // ── режим «усиленная приватность» (L2, T079) ───────────────────────────

    fn l2_apply_direct(&mut self, chat: &str, user: &str, enabled: bool, ts_ms: i64) -> bool {
        self.l2_direct.entry(chat.to_string()).or_insert_with(|| L2State::new(ChatKind::Direct)).set_pref(user, L2Pref { enabled, ts_ms })
    }

    /// Выравнивать ли исходящие личного чата с `chat`.
    fn direct_must_pad(&self, chat: &str) -> bool {
        self.l2_direct.get(chat).is_some_and(|s| s.must_pad(&self.user, &[self.user.as_str(), chat]))
    }

    /// Согласование L2 группы: политика журнала + личное предпочтение.
    fn group_l2_state(&self, group_id: &[u8], state: &GroupState) -> L2State {
        let mut s = L2State::new(ChatKind::Group);
        s.set_group_policy(L2Pref { enabled: state.l2, ts_ms: 1 });
        if let Some(p) = self.l2_group_pref.get(group_id) {
            s.set_pref(&self.user, *p);
        }
        s
    }

    /// Включить/выключить L2 в личном чате: подписанная операция `ChatMode`
    /// собеседнику и своим устройствам (видимое служебное сообщение чата).
    /// Своё предпочтение применяется сразу; режим чата остаётся активным,
    /// пока он включён у собеседника.
    pub fn l2_set_direct(&mut self, peer: &str, enabled: bool) -> CResult<Vec<OutRequest>> {
        self.l2_set_direct_id(peer, enabled, sign::new_op_id())
    }

    /// То же с `op_id` хоста (id служебного сообщения в UI).
    pub fn l2_set_direct_id(&mut self, peer: &str, enabled: bool, op_id: Vec<u8>) -> CResult<Vec<OutRequest>> {
        let c = Content { kind: Some(content::Kind::ChatMode(mpb::ChatMode { l2: enabled })), ..Default::default() };
        self.prepare_direct_id(peer, &c, op_id)
    }

    /// Состояние L2 личного чата.
    pub fn l2_direct(&self, peer: &str) -> L2View {
        let me = self.user.as_str();
        let parts = [me, peer];
        let Some(s) = self.l2_direct.get(peer) else {
            return L2View { ephemeral_allowed: true, ..Default::default() };
        };
        let mut enabled_by: Vec<String> = parts.iter().filter(|u| s.pref(u).enabled).map(|u| u.to_string()).collect();
        enabled_by.dedup();
        L2View { active: s.active(&parts), mine: s.pref(me).enabled, enabled_by, pad: s.must_pad(me, &parts), ephemeral_allowed: s.ephemeral_allowed(&parts) }
    }

    /// Состояние L2 группы: политика журнала (`GroupChange.set_privacy_mode`
    /// через [`Client::group_change`]) и личное предпочтение этого устройства.
    pub fn l2_group(&self, group_id: &[u8]) -> L2View {
        let Some(state) = self.group_state(group_id) else {
            return L2View { ephemeral_allowed: true, ..Default::default() };
        };
        let s = self.group_l2_state(group_id, state);
        let me = self.user.as_str();
        let active = s.active(&[]);
        let enabled_by = if active && !state.l2_by.is_empty() { vec![state.l2_by.clone()] } else { vec![] };
        L2View { active, mine: s.pref(me).enabled, enabled_by, pad: s.must_pad(me, &[]), ephemeral_allowed: s.ephemeral_allowed(&[]) }
    }

    /// Личное предпочтение L2 в группе: свои исходящие выравниваются, даже
    /// если политика группы — обычный режим. Остальным участникам не видно
    /// и typing в группе не выключает (это делает только политика).
    pub fn l2_set_group_pref(&mut self, group_id: &[u8], enabled: bool) {
        if enabled {
            self.l2_group_pref.insert(group_id.to_vec(), L2Pref { enabled, ts_ms: now_ms() });
        } else {
            self.l2_group_pref.remove(group_id);
        }
    }

    /// L2 активен хотя бы в одном чате (личном или группе, где мы участник).
    pub fn l2_any_active(&self) -> bool {
        let me = self.user.as_str();
        self.l2_direct.iter().any(|(peer, s)| s.active(&[me, peer.as_str()]))
            || self.groups.values().filter_map(|g| g.state.as_ref()).any(|s| s.l2 && !s.deleted && s.members.contains_key(me))
    }

    /// Чаты с активным L2: собеседники личных чатов и id групп (где мы
    /// участник). Хост держит по ним свой кэш «не слать typing/presence».
    pub fn l2_active_chats(&self) -> (Vec<String>, Vec<Vec<u8>>) {
        let me = self.user.as_str();
        let direct = self.l2_direct.iter().filter(|(peer, s)| s.active(&[me, peer.as_str()])).map(|(peer, _)| peer.clone()).collect();
        let groups = self
            .groups
            .iter()
            .filter(|(_, g)| g.state.as_ref().is_some_and(|s| s.l2 && !s.deleted && s.members.contains_key(me)))
            .map(|(id, _)| id.clone())
            .collect();
        (direct, groups)
    }

    /// Публиковать ли своё присутствие: оно одно на аккаунт, поэтому только
    /// пока L2 не активен ни в одном чате.
    pub fn presence_allowed(&self) -> bool {
        l2::presence_allowed(self.l2_any_active())
    }

    // ── эфемерные каналы: «печатает» и присутствие (T127, FR-013/FR-064) ─────

    fn eph_direct_channel(&self, peer: &str) -> Option<EphChannel> {
        if peer == self.user || !self.l2_direct(peer).ephemeral_allowed {
            return None;
        }
        let (dk, _) = self.peers.get(peer)?.delivery_key.as_ref()?;
        EphChannel::direct_typing(self.dk.key(), dk, 0).ok()
    }

    fn eph_presence_channel(&self, peer: &str) -> Option<EphChannel> {
        let (dk, _) = self.peers.get(peer)?.delivery_key.as_ref()?;
        EphChannel::presence(dk, 0).ok()
    }

    fn eph_group_channel(&self, group_id: &[u8]) -> Option<(EphChannel, u64)> {
        let state = self.group_state(group_id)?;
        if state.epoch_stale || !self.l2_group(group_id).ephemeral_allowed {
            return None;
        }
        let ek = self.epoch_keys.get(&(group_id.to_vec(), state.epoch))?;
        EphChannel::group_typing(&ek.envelope_key, &state.group, state.epoch).ok().map(|c| (c, state.epoch))
    }

    /// Подписаться на эфемерные каналы чатов: у собеседника (нужен его ключ
    /// доставки) — присутствие и «печатает» личного чата, у группы — «печатает»
    /// текущей эпохи. Возвращает запросы `ephemeral.subscribe` только на ещё не
    /// подписанные каналы; каналы L2-чатов не подписываются. После смены эпохи
    /// группы или ключа доставки собеседника вызвать снова.
    pub fn eph_subscribe(&mut self, peers: &[String], groups: &[Vec<u8>]) -> Vec<OutRequest> {
        let mut fresh: Vec<(EphChannel, EphTarget)> = vec![];
        for p in peers {
            if let Some(c) = self.eph_presence_channel(p) {
                fresh.push((c, EphTarget::Presence(p.clone())));
            }
            if let Some(c) = self.eph_direct_channel(p) {
                fresh.push((c, EphTarget::Direct(p.clone())));
            }
        }
        for g in groups {
            if let Some((c, epoch)) = self.eph_group_channel(g) {
                fresh.push((c, EphTarget::Group(g.clone(), epoch)));
            }
        }
        let mut ids = vec![];
        for (c, t) in fresh {
            if self.eph.contains_key(&c.id) || self.eph.len() >= EPH_MAX_CHANNELS {
                continue;
            }
            ids.push(c.id.to_vec());
            self.eph.insert(c.id, (c, t));
        }
        ids.chunks(64).map(|chunk| OutRequest::id("ephemeral.subscribe", &mpb::EphemeralSubscribeRequest { channel_ids: chunk.to_vec() })).collect()
    }

    /// Соединение пересоздано — подписок больше нет.
    pub fn eph_reset(&mut self) {
        self.eph.clear();
    }

    /// «Печатает» собеседнику личного чата. `None` — канала нет (ключ доставки
    /// собеседника неизвестен) или чат в L2: сигнал не шлётся НИКАК (в v1 тоже).
    pub fn typing_request(&self, peer: &str, action: mpb::TypingAction) -> Result<Option<OutRequest>> {
        let Some(c) = self.eph_direct_channel(peer) else { return Ok(None) };
        let payload = c.seal(&ephemeral::typing(&self.user, action, now_ms()))?;
        let mut r = OutRequest::id("ephemeral.typing", &mpb::EphemeralTypingRequest { channel_id: c.id.to_vec(), payload });
        // Собеседник с другого сервера (R14): его gateway публикует сигнал в канал, на который он подписан.
        r.dest = crate::address::address_domain(peer).map(str::to_ascii_lowercase);
        Ok(Some(r))
    }

    /// «Печатает» в группе: анонимно, подпись ключом отправки текущей эпохи (D-07).
    pub fn group_typing_request(&self, group_id: &[u8], action: mpb::TypingAction) -> Result<Option<OutRequest>> {
        let Some((c, epoch)) = self.eph_group_channel(group_id) else { return Ok(None) };
        let Some(state) = self.group_state(group_id) else { return Ok(None) };
        let Some(send) = self.epoch_keys.get(&(group_id.to_vec(), epoch)).and_then(|ek| ek.send_sk.as_ref()) else { return Ok(None) };
        let send = SigningKey::from_bytes(&send.to_bytes());
        let payload = c.seal(&ephemeral::typing(&self.user, action, now_ms()))?;
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        let epoch_signature = group::sign_group_typing(&send, &state.group, epoch, &nonce, &payload);
        Ok(Some(OutRequest::anon(
            "ephemeral.group_typing",
            &mpb::EphemeralGroupTypingRequest { group: Some(state.group.clone()), epoch, payload, nonce: nonce.to_vec(), epoch_signature, channel_id: c.id.to_vec() },
        )))
    }

    /// Своё присутствие — в канал из своего ключа доставки (его знают только
    /// те, кому ключ роздан). `None` — пока L2 активен хоть в одном чате.
    pub fn presence_request(&self, online: bool, last_seen_ms: i64) -> Result<Option<OutRequest>> {
        if !self.presence_allowed() {
            return Ok(None);
        }
        let c = EphChannel::presence(self.dk.key(), 0)?;
        let payload = c.seal(&ephemeral::presence(&self.user, online, last_seen_ms, now_ms()))?;
        Ok(Some(OutRequest::id("ephemeral.presence", &mpb::EphemeralPresenceRequest { channel_id: c.id.to_vec(), payload })))
    }

    /// Событие подписки `ephemeral` (тело — пересланный gateway запрос
    /// публикации). `None` — не наш канал, не открылось, устарело, своё эхо,
    /// автор не тот, чей это канал, либо чат в L2.
    pub fn open_ephemeral(&self, body: &[u8]) -> Option<Event> {
        let (id, payload) = match decode_checked::<mpb::EphemeralTypingRequest>(body, Origin::Client) {
            Ok(r) if r.channel_id.len() == ephemeral::CHANNEL_ID_LEN => (r.channel_id, r.payload),
            _ => {
                let r: mpb::EphemeralGroupTypingRequest = decode_checked(body, Origin::Client).ok()?;
                (r.channel_id, r.payload)
            }
        };
        let id: [u8; ephemeral::CHANNEL_ID_LEN] = id.as_slice().try_into().ok()?;
        let (channel, target) = self.eph.get(&id)?;
        let inner = channel.open(&payload).ok()?;
        let from = inner.from.as_ref()?.address.clone();
        if from == self.user {
            return None;
        }
        let l2_active = match target {
            EphTarget::Presence(_) => false,
            EphTarget::Direct(p) => !self.l2_direct(p).ephemeral_allowed,
            EphTarget::Group(g, _) => !self.l2_group(g).ephemeral_allowed,
        };
        if !ephemeral::accept(&inner, l2_active, now_ms(), EPH_MAX_AGE_MS) {
            return None;
        }
        use mpb::ephemeral_inner::Signal;
        match (target, inner.signal?) {
            (EphTarget::Presence(p), Signal::Presence(s)) if *p == from => {
                Some(Event::Presence { from, online: s.online, last_seen_ms: s.last_seen_ms, ts_ms: inner.ts_ms })
            }
            (EphTarget::Direct(p), Signal::Typing(s)) if *p == from => {
                Some(Event::Typing { chat: p.clone(), group: None, from, action: s.action, ts_ms: inner.ts_ms })
            }
            (EphTarget::Group(g, _), Signal::Typing(s)) if self.group_state(g).is_some_and(|st| st.members.contains_key(&from)) => {
                Some(Event::Typing { chat: hex::encode(g), group: Some(g.clone()), from, action: s.action, ts_ms: inner.ts_ms })
            }
            _ => None,
        }
    }

    // ── квитанции (T074) ────────────────────────────────────────────────────

    /// Квитанция доставки/прочтения в личном чате (+ копия своим устройствам —
    /// синхронизация прочитанного). D-15: незнакомцу (нет его ключа доступа)
    /// квитанции не шлются — ни жетонов, ни раздачи своего ключа.
    pub fn prepare_receipt(&mut self, peer: &str, kind: mpb::ReceiptKind, messages: &[Vec<u8>]) -> CResult<Vec<OutRequest>> {
        // spec 026: прежний ник собеседника — по новому адресу
        let current = self.current_address(peer);
        let peer = current.as_str();
        let c = msg::receipt(kind, messages)?;
        if peer != self.user && !self.has_peer_delivery_key(peer) {
            return Ok(self.seal_to_own_devices_chat(peer, &c)?.into_iter().collect());
        }
        self.prepare_direct_inner(peer, &c, sign::new_op_id(), false)
    }

    fn seal_to_own_devices_chat(&mut self, chat: &str, c: &Content) -> CResult<Option<OutRequest>> {
        let own: Vec<String> = self.own_log.devices.keys().filter(|d| **d != self.device_id).cloned().collect();
        if own.is_empty() {
            return Ok(None);
        }
        self.check_peer(&self.user.clone())?;
        let me = self.user.clone();
        let r = self.seal_for(&me, &own, chat, c, Access::DeliveryKey(self.dk.key().to_vec()))?;
        Ok((!r.envelopes.is_empty()).then(|| OutRequest::anon("msg.deliver_sealed", &r)))
    }

    /// Квитанция в группе — групповым конвертом (D-07: автор скрыт).
    pub fn prepare_group_receipt(&mut self, group_id: &[u8], kind: mpb::ReceiptKind, messages: &[Vec<u8>]) -> CResult<Vec<OutRequest>> {
        let c = msg::receipt(kind, messages)?;
        self.prepare_group(group_id, &c)
    }

    /// Кто прочитал своё сообщение (по E2E-квитанциям): (пользователь, время).
    pub fn readers(&self, op_id: &[u8]) -> Vec<(String, i64)> {
        self.reads.readers(op_id)
    }

    /// Кому доставлено своё сообщение.
    pub fn delivered_to(&self, op_id: &[u8]) -> Vec<(String, i64)> {
        self.reads.delivered_to(op_id)
    }

    // ── ключ личного состояния ──────────────────────────────────────────────

    /// Ключ личного состояния (первое устройство — `StateKey::generate`,
    /// связанное — из гранта линковки).
    pub fn set_state_key(&mut self, key: StateKey, version: u32) {
        self.state_key = Some((key, version));
    }

    pub fn state_key(&self) -> Option<(&StateKey, u32)> {
        self.state_key.as_ref().map(|(k, v)| (k, *v))
    }

    // ── отзыв устройства (T124; D-11, D-12, D-16) ───────────────────────────

    /// Отозвать своё другое устройство и выполнить последствия: запись
    /// журнала первой, затем ротации (см. [`RevocationOutcome`]).
    pub fn revoke_device(&mut self, device_id: &str) -> CResult<RevocationOutcome> {
        self.own_sessions_ready(device_id)?;
        let req = self.revoke_device_request(device_id)?;
        let mut o = self.on_own_device_revoked(device_id)?;
        o.requests.insert(0, req);
        Ok(o)
    }

    /// Обычный выход своего другого устройства без смены ключей: только запись журнала и то же, что
    /// при выходе устройства самим (его Olm- и свои Megolm-сессии забываются, группам — новая эпоха
    /// по ENG-06). Ключи доставки, состояния и доменов не меняются. Позже устройство можно отметить
    /// украденным ([`Client::report_device_stolen`]) — тогда ключи сменятся.
    pub fn sign_out_device(&mut self, device_id: &str) -> CResult<RevocationOutcome> {
        let req = self.sign_out_device_request(device_id)?;
        self.forget_revoked_device(device_id);
        self.on_devices_removed(&self.user.clone());
        Ok(RevocationOutcome { requests: vec![req], ..Default::default() })
    }

    /// Сессии со всеми своими оставшимися устройствами (кроме `except`) — до изменения журнала: ротации
    /// после отзыва раздаются им по E2E.
    fn own_sessions_ready(&self, except: &str) -> CResult<()> {
        for id in self.own_log.devices.keys() {
            if id != &self.device_id && id != except && !self.sessions.contains_key(&(self.user.clone(), id.clone())) {
                return need(Need::Bundle { user: self.user.clone() });
            }
        }
        Ok(())
    }

    /// ENG-04: свои устройства, державшие SSK и вышедшие сами. Выход украденного устройства выглядит
    /// так же — владелец может отметить его украденным ([`Client::report_device_stolen`]).
    pub fn left_ssk_holders(&self) -> Vec<String> {
        self.own_log.left_holders.iter().cloned().collect()
    }

    /// ENG-04: вышедшее само устройство украдено — повторный отзыв подписью SSK: SSK считается
    /// раскрытым (новые устройства — только после смены SSK корнем), ключи, которые устройство
    /// могло держать, меняются как при отзыве.
    pub fn report_device_stolen(&mut self, device_id: &str) -> CResult<RevocationOutcome> {
        if !self.own_log.left_holders.contains(device_id) {
            return Err(ClientError::Proto(ProtoError::NotFound));
        }
        // Запись журнала применяется сразу — добор после неё повтором уже не пройдёт проверку выше
        self.own_sessions_ready(device_id)?;
        let req = self.revoke_device_request(device_id)?;
        self.revocations_done.remove(device_id);
        let mut o = self.on_own_device_revoked(device_id)?;
        o.requests.insert(0, req);
        o.ssk_rotation_required = self.own_log.ssk_exposed;
        Ok(o)
    }

    /// Последствия отзыва своего устройства (запись отзыва уже в своём
    /// журнале). Выполняет устройство, которое отзывало (одно — иначе ключи
    /// разойдутся); остальные свои устройства получают новые ключи по E2E.
    /// Повторный вызов для того же устройства ничего не делает.
    ///
    /// - ключ доступа к доставке: новый на сервер, раздача своим устройствам
    ///   и собеседникам, которым раздавался прежний;
    /// - ключ личного состояния (если задан): новая версия своим устройствам;
    /// - группы, где мы админ: новая эпоха (исключённое устройство не получит
    ///   ключей); где не админ — новая своя Megolm-сессия, эпоху меняет админ;
    /// - отозванное устройство держало SSK → `ssk_rotation_required`
    ///   (`rotate_ssk` корнем; до смены собеседники видят KEY-1).
    pub fn on_own_device_revoked(&mut self, device_id: &str) -> CResult<RevocationOutcome> {
        if !self.own_log.revoked.contains(device_id) {
            return Err(ClientError::Proto(ProtoError::NotFound));
        }
        if self.revocations_done.contains(device_id) {
            return Ok(RevocationOutcome::default());
        }
        self.check_peer(&self.user.clone())?;
        self.forget_revoked_device(device_id);
        let mut o = RevocationOutcome::default();
        // Ключ доступа к доставке.
        let targets = self.dk.rotate(&[]);
        o.requests.push(OutRequest::id("identity.delivery_key.set", &ipb::DeliveryKeySetRequest { delivery_key: self.dk.key().to_vec() }));
        let dkc = self.delivery_key_content();
        o.requests.extend(self.seal_to_own_devices(&dkc)?);
        // Ключ личного состояния (D-16).
        if let Some(v) = self.state_key.as_ref().map(|(_, v)| v.saturating_add(1)) {
            let k = StateKey::generate();
            let share = k.to_share(&self.user, v)?;
            self.state_key = Some((k, v));
            let c = Content { kind: Some(content::Kind::StateKey(share)), ..Default::default() };
            o.requests.extend(self.seal_to_own_devices(&c)?);
            o.state_key_version = Some(v);
        }
        // Контейнер планировщика (spec 010, REVOKE-1): новая эпоха ключа.
        match self.planner_rotate_on_revoke(now_ms()) {
            Ok(r) => o.requests.extend(r),
            Err(ClientError::Proto(e)) => self.last_error = Some(e),
            Err(ClientError::Need(_)) => {}
        }
        // Контейнеры облака (spec 016), где пользователь админ: новая эпоха ключа.
        o.requests.extend(self.cloud_rotate_on_revoke(now_ms()));
        // Собеседники.
        for p in targets {
            match self.share_delivery_key(&p) {
                Ok(r) => o.requests.extend(r),
                Err(_) => o.pending_key_shares.push(p),
            }
        }
        // Группы.
        let me = self.user.clone();
        let groups: Vec<(Vec<u8>, bool)> = self
            .groups
            .iter()
            .filter_map(|(id, g)| g.state.as_ref().map(|s| (id, s)))
            .filter(|(_, s)| s.members.contains_key(&me) && !s.deleted)
            .map(|(id, s)| (id.clone(), s.owner == me || s.members.get(&me).is_some_and(|m| m.role == gpb::Role::Admin)))
            .collect();
        for (g, admin) in groups {
            if !admin {
                o.epochs_need_admin.push(g);
                continue;
            }
            match self.group_rotate_epoch(&g) {
                Ok(r) => o.requests.extend(r),
                Err(_) => o.pending_epochs.push(g),
            }
        }
        o.ssk_rotation_required = self.own_log.ssk_exposed;
        self.revocations_done.insert(device_id.to_string());
        Ok(o)
    }

    /// Забыть отозванное своё устройство: Olm-сессию с ним и свои исходящие
    /// Megolm-сессии (оно получало их копии) — следующая отправка в группу
    /// начнёт новую сессию и раздаст её только активным устройствам.
    fn forget_revoked_device(&mut self, device_id: &str) {
        self.sessions.remove(&(self.user.clone(), device_id.to_string()));
        self.old_sessions.remove(&(self.user.clone(), device_id.to_string()));
        self.megolm_out.clear();
        self.megolm_shared.clear();
    }

    /// Смена SSK корнем (D-12) после отзыва устройства, державшего SSK:
    /// запись смены + пересертификация оставшихся устройств новым SSK
    /// (`serial` растёт). Новый SSK остаётся только на этом устройстве;
    /// остальным в сертификат пишется `no-ssk`.
    pub fn rotate_ssk(&mut self, root: &RootIdentity) -> Result<Vec<OutRequest>> {
        if root.user != self.user || root.root_pub() != self.own_log.root_key {
            return Err(ProtoError::RootMismatch);
        }
        let devices: Vec<VerifiedDevice> = self.own_log.devices.values().cloned().collect();
        let new_ssk = sign::generate_signing_key();
        let (entry, root_sig) = identity::rotate_ssk_entry(&root.root, &self.user, self.own_log.version + 1, self.own_log.head_hash, &new_ssk)?;
        self.own_log.apply(&entry)?;
        self.own_entries.push(entry.clone());
        let mut out = vec![OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(entry) })];
        let root_pub = self.own_log.root_key;
        for d in devices {
            let mut cert = d.cert.clone();
            let max = self.own_log.max_serial.get(&cert.device_id).copied().unwrap_or(cert.serial);
            cert.serial = max.saturating_add(1);
            cert.created_ms = now_ms();
            let mine = cert.device_id == self.device_id;
            cert.features.retain(|f| f != identity::FEATURE_NO_SSK);
            if !mine {
                cert.features.push(identity::FEATURE_NO_SSK.to_string());
            }
            let signed = identity::sign_certificate(&new_ssk, &root_pub, root_sig.clone(), &cert);
            let e = identity::device_log_entry(&self.user, self.own_log.version + 1, self.own_log.head_hash, DevChange::AddDevice(signed.clone()), None);
            let op = identity::sign_device_log_entry(&new_ssk, &e)?;
            self.own_log.apply(&op)?;
            self.own_entries.push(op.clone());
            if mine {
                self.cert_serial = cert.serial;
                self.my_cert = Some(signed);
            }
            out.push(OutRequest::id("identity.device.log_append", &ipb::DeviceLogAppendRequest { entry: Some(op) }));
        }
        self.ssk = Some(new_ssk);
        Ok(out)
    }

    /// То же по секрету корня (хост получает его из резервной копии под
    /// ключом восстановления и сразу стирает).
    pub fn rotate_ssk_with_secret(&mut self, root_secret: &[u8; 32]) -> Result<Vec<OutRequest>> {
        let root = RootIdentity { user: self.user.clone(), root: SigningKey::from_bytes(root_secret), self_signing: sign::generate_signing_key() };
        self.rotate_ssk(&root)
    }

    /// Свой SSK раскрыт (отозвано устройство, державшее его) и ещё не сменён:
    /// новые устройства и список v1-устройств не принимаются до `rotate_ssk`.
    pub fn own_ssk_exposed(&self) -> bool {
        self.own_log.ssk_exposed
    }

    /// ID-01: доказательство владения ключом устройства для
    /// `identity.session.issue` — подпись `olm_ed25519` над (адрес, device_id,
    /// ts_ms). Сервер требует её от устройства, действующего в журнале: пароль
    /// сам по себе не даёт войти «как» чужое привязанное устройство.
    pub fn session_proof(&self, ts_ms: i64) -> Vec<u8> {
        sign::sign_ctx(&self.acc, sign::ctx::SESSION_PROOF, &session_proof_parts(&self.user, &self.device_id, ts_ms).iter().map(Vec::as_slice).collect::<Vec<_>>())
    }

    /// D-12: у пользователя отозвано устройство, державшее SSK, а SSK ещё не
    /// сменён — показать предупреждение KEY-1 (для себя — напоминание сменить).
    pub fn ssk_pending(&self, user: &str) -> bool {
        self.peer_log(user).is_some_and(|l| l.ssk_exposed)
    }

    /// Свой журнал изменился (синк с другого устройства): SSK сменён не нами —
    /// старый больше не действителен (D-12); свой сертификат — из журнала.
    fn refresh_own_after_log(&mut self) {
        if self.ssk.as_ref().is_some_and(|k| k.verifying_key().to_bytes() != self.own_log.ssk) {
            self.ssk = None;
        }
        let Some(active) = self.own_log.active(&self.device_id).map(|d| d.cert.clone()) else { return };
        if self.my_cert.as_ref().and_then(|c| identity::verify_certificate(c, Some(&self.user)).ok()).is_some_and(|v| v.cert == active) {
            return;
        }
        for op in self.own_entries.iter().rev() {
            let Ok(body) = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()) else { continue };
            let Ok(e) = crate::pb::parvane::core::v2::UserDeviceLogEntry::decode(body.payload.as_slice()) else { continue };
            if let Some(DevChange::AddDevice(c)) = e.change {
                if identity::verify_certificate(&c, Some(&self.user)).is_ok_and(|v| v.cert == active) {
                    self.cert_serial = self.cert_serial.max(active.serial);
                    self.my_cert = Some(c);
                    return;
                }
            }
        }
    }

    // ── приём ───────────────────────────────────────────────────────────────

    /// Открыть запись журнала инбокса. `Err(Need)` — запись не применена,
    /// повторить после добора (журнал отправителя/ключи группы).
    pub fn open_record(&mut self, record: &[u8]) -> CResult<Vec<Event>> {
        let rec: mpb::InboxRecord = decode_checked(record, Origin::Server)?;
        let seq = rec.seq;
        // Живое уведомление «новое своё устройство» (T119) идёт мимо журнала,
        // seq = 0 — курсором не отсекается (иначе не доходило никогда).
        if seq == 0 {
            if let Some(inbox_record::Item::DeviceAdded(d)) = &rec.item {
                return Ok(vec![Event::DeviceAdded { device_id: d.device_id.clone(), log_version: d.log_version }]);
            }
            // Сигнал звонка (D-08) — тоже мимо журнала. Обычное сообщение без
            // места в журнале не принимаем: его источник — только журнал.
            if let Some(inbox_record::Item::Sealed(env)) = &rec.item {
                let events = self.open_sealed(0, env)?;
                return Ok(events.into_iter().filter(|e| matches!(e, Event::Call { .. })).collect());
            }
        }
        if self.cursor.is_done(seq) {
            return Ok(vec![]);
        }
        let out = match rec.item {
            None => vec![Event::Skipped { seq }],
            Some(inbox_record::Item::LegacyV1(l)) => vec![Event::LegacyV1 { seq, json: l.json }],
            Some(inbox_record::Item::GroupState(n)) => match n.group {
                Some(g) => vec![Event::GroupChanged { seq, group: g, version: n.version }],
                None => vec![Event::Skipped { seq }],
            },
            Some(inbox_record::Item::DeviceRevoked(d)) => {
                if d.device_id != self.device_id {
                    self.forget_revoked_device(&d.device_id);
                }
                vec![Event::DeviceRevoked { seq, device_id: d.device_id }]
            }
            Some(inbox_record::Item::DeviceAdded(d)) => vec![Event::DeviceAdded { device_id: d.device_id, log_version: d.log_version }],
            Some(inbox_record::Item::Sealed(env)) => match self.open_sealed(seq, &env) {
                Ok(e) => e,
                Err(ClientError::Need(n)) => return Err(ClientError::Need(n)),
                Err(ClientError::Proto(e)) => {
                    self.last_error = Some(e);
                    if self.cursor.mark_failed(seq) == crate::sync::FailOutcome::Skipped {
                        return Ok(vec![Event::Skipped { seq }]);
                    }
                    return Ok(vec![]);
                }
            },
            Some(inbox_record::Item::Group(env)) => match self.open_group(seq, &env) {
                Ok(e) => e,
                Err(ClientError::Need(Need::GroupKeys { group, epoch })) => {
                    // Ключи придут отдельным сообщением: отложить конверт.
                    self.pending_group.push((seq, env));
                    self.cursor.mark_applied(seq);
                    let _ = (group, epoch);
                    return Ok(vec![]);
                }
                Err(ClientError::Need(n)) => return Err(ClientError::Need(n)),
                Err(ClientError::Proto(e)) => {
                    self.last_error = Some(e);
                    if self.cursor.mark_failed(seq) == crate::sync::FailOutcome::Skipped {
                        return Ok(vec![Event::Skipped { seq }]);
                    }
                    return Ok(vec![]);
                }
            },
        };
        self.cursor.mark_applied(seq);
        Ok(out)
    }

    fn open_sealed(&mut self, seq: u64, env: &crate::pb::parvane::core::v2::SealedEnvelope) -> CResult<Vec<Event>> {
        // spec 026: конверт, запечатанный на свой прежний адрес (отправитель ещё не знал о смене ника)
        let me = match env.recipient.as_ref() {
            Some(r) if r.device_id == self.device_id && r.address != self.user && self.is_own_address(&r.address) => r.clone(),
            _ => self.my_device(),
        };
        let inner: SealedInner = seal::open(env, &me, &self.hpke_sk)?;
        let cert = inner.sender.as_ref().ok_or(ProtoError::InvalidField("sender"))?;
        let v = identity::verify_certificate(cert, None)?;
        let sender = v.user().to_string();
        // spec 026: устройства прежнего своего адреса закрыты сменой ника
        if sender != self.user && self.is_own_address(&sender) {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        // Журнал отправителя обязателен (fail-closed): устройство активно.
        if sender != self.user {
            match self.peers.get(&sender) {
                Some(p) if p.pending_root.is_some() => return need(Need::RootChanged { user: sender }),
                Some(p) if p.log.is_some() => {}
                _ => return need(Need::PeerLog { user: sender, after: 0 }),
            }
        }
        let log = self.peer_log(&sender).cloned().ok_or_else(|| ClientError::Need(Need::PeerLog { user: sender.clone(), after: 0 }))?;
        let dev_id = v.cert.device_id.clone();
        // ENG-07: копия-обманка раздачи ключа, отправленная этим же устройством самому себе
        if sender == self.user && dev_id == self.device_id {
            return Ok(vec![Event::Internal { seq }]);
        }
        if log.active(&dev_id).map(|d| d.cert != v.cert).unwrap_or(true) {
            // Устройство не в журнале: журнал мог устареть — догнать.
            let after = log.version;
            if !log.revoked.contains(&dev_id) {
                return need(Need::PeerLog { user: sender, after });
            }
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let key = (sender.clone(), dev_id.clone());
        let acc = &mut self.acc;
        let sessions = &mut self.sessions;
        let old_sessions = &mut self.old_sessions;
        let mut decrypt = |identity: &[u8; 32], t: u32, b: &[u8]| -> Result<Vec<u8>> {
            if let Some(s) = sessions.get_mut(&key) {
                if t == 1 || s.matches_prekey(b) {
                    if let Ok(pt) = s.decrypt(t, b) {
                        return Ok(pt);
                    }
                }
            }
            // Собеседник пишет в вытесненную сессию (встречное начало
            // переписки) — она становится основной: следующая отправка пойдёт
            // в ту же сессию, и стороны сходятся на одной
            if let Some(olds) = old_sessions.get_mut(&key) {
                for i in 0..olds.len() {
                    if t != 1 && !olds[i].matches_prekey(b) {
                        continue;
                    }
                    if let Ok(pt) = olds[i].decrypt(t, b) {
                        let found = olds.remove(i);
                        if let Some(prev) = sessions.insert(key.clone(), found) {
                            olds.push(prev);
                        }
                        return Ok(pt);
                    }
                }
            }
            if t != 0 {
                return Err(ProtoError::Crypto);
            }
            let (s, pt) = acc.inbound(identity, b)?;
            if let Some(prev) = sessions.insert(key.clone(), s) {
                let olds = old_sessions.entry(key.clone()).or_default();
                olds.push(prev);
                if olds.len() > MAX_OLD_SESSIONS {
                    olds.remove(0);
                }
            }
            Ok(pt)
        };
        let mut seen = SeenAdapter { c: &mut self.seen, list: &mut self.seen_list };
        let opened = match msg::open_sealed_op(&inner, &me, &|_d: &VerifiedDevice| true, &mut decrypt, &mut seen)? {
            msg::OpenedSealed::Message(m) => *m,
            msg::OpenedSealed::Call(call) => {
                // Звонок «живёт» у звонящего (цель операции подписана вместе с
                // доменом): домен цели — домен звонящего; для своего сервера это
                // прежнее условие (spec 028, звонки между серверами).
                let caller_domain = crate::address::address_domain(&sender).unwrap_or_default();
                let target_ok = call.op.header.target.as_ref().is_some_and(|t| t.domain.eq_ignore_ascii_case(caller_domain));
                // От своего аккаунта — только «принят/отклонён на другом устройстве» (spec 024)
                let own_ok = sender != self.user
                    || (dev_id != self.device_id && matches!(call.signal.signal, Some(cpb::call_signal::Signal::Hangup(_))));
                if !own_ok || !target_ok {
                    return Err(ClientError::Proto(ProtoError::ContextMismatch));
                }
                return Ok(vec![Event::Call {
                    from: sender,
                    device: dev_id,
                    call_id: call.signal.call_id.clone(),
                    ts_ms: call.op.header.ts_ms,
                    signal: call.signal,
                }]);
            }
        };
        self.note_author_log(&sender, opened.op.header.author_log_version);
        let chat = match &opened.op.header.conversation {
            Some(crate::pb::parvane::core::v2::op_header::Conversation::DirectPeer(p)) if sender == self.user => p.address.clone(),
            _ => sender.clone(),
        };
        let ts = opened.op.header.ts_ms;
        let op_id = opened.op.header.op_id.clone();
        match &opened.content.kind {
            Some(content::Kind::DeliveryKey(k)) if sender == self.user => {
                // Своё другое устройство сменило ключ доступа (отзыв устройства).
                self.dk.adopt(&k.delivery_key, k.generation);
                return Ok(vec![Event::Internal { seq }]);
            }
            Some(content::Kind::StateKey(sk)) => {
                // Ключ состояния — только от своих устройств.
                if sender != self.user {
                    return Ok(vec![Event::Skipped { seq }]);
                }
                let (k, v) = StateKey::from_share(sk, &self.user)?;
                if self.state_key.as_ref().is_none_or(|(_, cur)| v > *cur) {
                    self.state_key = Some((k, v));
                    return Ok(vec![Event::StateKeyRotated { seq, key_version: v }]);
                }
                return Ok(vec![Event::Internal { seq }]);
            }
            Some(content::Kind::Receipt(r)) => {
                let me = self.user.clone();
                self.reads.apply(&me, &msg::ChatKey::Direct(chat.clone()), &sender, r, ts);
            }
            Some(content::Kind::ChatMode(m)) => {
                // Предпочтение подписавшего участника (собеседник или своё
                // другое устройство); дальше — хосту как служебное сообщение.
                let enabled = m.l2;
                self.l2_apply_direct(&chat, &sender, enabled, ts);
            }
            Some(content::Kind::DeliveryKey(k)) if sender != self.user => {
                if k.delivery_key.len() == 32 {
                    let p = self.peers.entry(sender.clone()).or_default();
                    if p.delivery_key.as_ref().map(|(_, g)| k.generation > *g).unwrap_or(true) {
                        p.delivery_key = Some((k.delivery_key.clone(), k.generation));
                    }
                }
                return Ok(vec![Event::Internal { seq }]);
            }
            Some(content::Kind::ContainerKey(share)) => {
                let share = share.clone();
                if share.domain == crate::domain::cloud::DOMAIN_NAME {
                    return Ok(self.cloud_accept_key(&sender, &share, seq));
                }
                return Ok(self.planner_accept_key(&sender, &share, seq));
            }
            Some(content::Kind::GroupKey(gk)) => {
                let gk = gk.clone();
                // Olm уже расшифрован — никакого Need наружу: откладываем.
                return match self.accept_group_key(&sender, &gk) {
                    Ok(()) => {
                        let mut ev = vec![Event::Internal { seq }];
                        ev.extend(self.retry_pending_groups());
                        Ok(ev)
                    }
                    Err(ClientError::Need(Need::GroupLog { group, .. })) => {
                        // Домен группы — из контекста ключа (группа может жить на другом сервере, spec 028)
                        let domain = gk.context.as_ref().and_then(|c| c.group.as_ref()).map(|r| r.domain.clone()).unwrap_or_else(|| self.domain.clone());
                        self.pending_keys.push((sender, gk));
                        let g = Ref { domain, id: group };
                        Ok(vec![Event::GroupChanged { seq, group: g, version: 0 }])
                    }
                    Err(ClientError::Need(_)) => Ok(vec![Event::Internal { seq }]),
                    Err(ClientError::Proto(e)) => {
                        self.last_error = Some(e);
                        Ok(vec![Event::Skipped { seq }])
                    }
                };
            }
            _ => {}
        }
        Ok(vec![Event::Direct { seq, chat, from: sender, device: dev_id, op_id, ts_ms: ts, content: opened.content, disposition: opened.disposition }])
    }

    // ── группы ──────────────────────────────────────────────────────────────

    /// Подписант записи группы по ключу устройства и версии журнала устройств, на которую
    /// ссылается запись (ENG-08): ключ действовал в этой версии; запись без версии — ключ
    /// действует либо перестал действовать без чужого отзыва.
    /// Журналы, где ключ `k` действовал в версии `version` (0 — без версии): (адрес, корень, журнал закрыт
    /// сменой ника на адрес).
    fn signer_candidates(&self, k: &[u8; 32], version: u64) -> Vec<(SignerInfo, Option<String>)> {
        let check = |user: &str, log: &DeviceLog| {
            let valid = if version > 0 { log.key_active_at(k, version) } else { log.key_known_unrevoked(k) };
            (log.key_ever(k) && valid).then(|| (SignerInfo { user: user.to_string(), root_key: log.root_key }, log.renamed_to.clone()))
        };
        check(&self.user, &self.own_log)
            .into_iter()
            .chain(self.former_own.iter().filter_map(|(_, l)| check(&l.user, l)))
            .chain(self.peers.iter().filter_map(|(u, p)| p.log.as_ref().and_then(|l| check(u, l))))
            .collect()
    }

    fn signer_resolver(&self) -> impl Fn(&[u8; 32], u64) -> Option<SignerInfo> + '_ {
        move |k: &[u8; 32], version: u64| {
            // C1-01: ключ однозначно принадлежит одному пользователю (доказательство
            // владения в сертификате); совпадение в двух журналах — отказ. Исключение (spec 026) — прежний и
            // новый адрес одной личности после смены ника: без подсказки адреса запись — прежнего (так
            // подписана история до смены)
            let mut found = self.signer_candidates(k, version);
            match found.len() {
                1 => found.pop().map(|(s, _)| s),
                2 => {
                    let (a, b) = (&found[0], &found[1]);
                    let pair = a.0.root_key == b.0.root_key
                        && (a.1.as_deref() == Some(b.0.user.as_str()) || b.1.as_deref() == Some(a.0.user.as_str()));
                    if !pair {
                        return None;
                    }
                    found.into_iter().find(|(_, moved)| moved.is_some()).map(|(s, _)| s)
                }
                _ => None,
            }
        }
    }

    /// Резолвер по подсказке адреса подписанта (записи после смены ника, spec 026).
    fn signer_resolver_as(&self) -> impl Fn(&[u8; 32], u64, &str) -> Option<SignerInfo> + '_ {
        move |k: &[u8; 32], version: u64, address: &str| {
            let mut found: Vec<SignerInfo> = self.signer_candidates(k, version).into_iter().map(|(s, _)| s).filter(|s| s.user == address).collect();
            (found.len() == 1).then(|| found.pop()).flatten()
        }
    }

    /// Корень известного журнала адреса (свой текущий и прежние, собеседники).
    fn root_resolver(&self) -> impl Fn(&str) -> Option<[u8; 32]> + '_ {
        move |user: &str| {
            if user == self.user {
                return Some(self.own_log.root_key);
            }
            self.former_own.iter().find(|(_, l)| l.user == user).map(|(_, l)| l.root_key).or_else(|| self.peer_log(user).map(|l| l.root_key))
        }
    }

    /// Подсказка адреса для своих записей групп: после смены ника ключ этого устройства есть и в прежнем журнале.
    fn own_signer_hint(&self) -> &str {
        if self.former_own.is_empty() { "" } else { &self.user }
    }

    /// ENG-06: у пользователя ушло устройство — в его группах своя Megolm-сессия начинается заново
    /// (раздаётся только действующим устройствам), а группа ждёт новой эпохи от того, кто вправе.
    fn on_devices_removed(&mut self, user: &str) {
        let groups: Vec<(Vec<u8>, u64)> = self
            .groups
            .iter()
            .filter_map(|(id, g)| g.state.as_ref().filter(|s| s.members.contains_key(user) && !s.deleted).map(|s| (id.clone(), s.epoch)))
            .collect();
        for (id, epoch) in groups {
            self.megolm_out.retain(|(g, _), _| g != &id);
            self.megolm_shared.retain(|(g, _, _)| g != &id);
            self.rekey.insert(id, epoch);
        }
    }

    /// ENG-06: группе нужна новая эпоха — у участника ушло устройство, а эпоха с тех пор не сменилась.
    pub fn group_rekey_pending(&self, group_id: &[u8]) -> bool {
        self.rekey.get(group_id).is_some_and(|&epoch| self.group_state(group_id).is_some_and(|s| s.epoch == epoch && !s.deleted))
    }

    /// Группы, ждущие новой эпохи после ухода устройства участника (ENG-06).
    pub fn groups_rekey_pending(&self) -> Vec<Vec<u8>> {
        self.rekey.keys().filter(|g| self.group_rekey_pending(g)).cloned().collect()
    }

    /// ENG-05: версия журнала устройств, на которую сослалось проверенное сообщение автора.
    fn note_author_log(&mut self, user: &str, version: u64) {
        if version > self.log_version(user) {
            let v = self.log_behind.entry(user.to_string()).or_default();
            *v = (*v).max(version);
        } else {
            self.log_behind.remove(user);
        }
    }

    /// Пользователи, чей журнал устройств отстаёт от версии, на которую сослались их сообщения
    /// (ENG-05): хост добирает журналы, а если сервер их не отдаёт — показывает предупреждение.
    pub fn logs_behind(&self) -> Vec<(String, u64)> {
        self.log_behind.iter().filter(|(u, v)| **v > self.log_version(u)).map(|(u, v)| (u.clone(), *v)).collect()
    }

    /// Чей это ключ устройства (когда-либо): пользователь с этим ключом в журнале.
    fn key_owner(&self, key: &[u8; 32]) -> Option<String> {
        if self.own_log.key_ever(key) {
            return Some(self.user.clone());
        }
        self.peers.iter().find(|(_, p)| p.log.as_ref().is_some_and(|l| l.key_ever(key))).map(|(u, _)| u.clone())
    }

    /// ENG-08: версия своего журнала устройств для новой записи группы — не меньше той, на которую
    /// уже ссылались свои записи в этой группе (другое устройство могло знать журнал новее).
    fn own_signer_version(&self, state: Option<&GroupState>) -> u64 {
        let seen = state.and_then(|s| s.signer_versions.get(&self.user)).copied().unwrap_or(0);
        self.own_log.version.max(seen)
    }

    /// Домен сервера группы (spec 028): из журнала, иначе из ожидающего ключа,
    /// иначе свой. Хост адресует им `group.state.sync` и прочие запросы группы.
    pub fn group_domain(&self, group_id: &[u8]) -> String {
        if let Some(s) = self.group_state(group_id) {
            return s.group.domain.clone();
        }
        self.pending_keys
            .iter()
            .filter_map(|(_, gk)| gk.context.as_ref()?.group.as_ref())
            .find(|r| r.id == group_id && crate::address::is_valid_domain(&r.domain))
            .map(|r| r.domain.clone())
            .unwrap_or_else(|| self.domain.clone())
    }

    /// Состояние группы (после `group_ingest`).
    pub fn group_state(&self, group_id: &[u8]) -> Option<&GroupState> {
        self.groups.get(group_id).and_then(|g| g.state.as_ref())
    }

    pub fn group_version(&self, group_id: &[u8]) -> u64 {
        self.group_state(group_id).map(|s| s.version).unwrap_or(0)
    }

    /// D-03: версия журнала группы, на которую сослался проверенный участник,
    /// а у нас её ещё нет (None — не отстаём). Пока отстаём, отправка и
    /// раздача ключей в группу отказывают `Need::GroupLog` (UI: «догоняем
    /// состав группы»; если сервер так и не отдаёт записи — предупреждение).
    pub fn group_behind(&self, group_id: &[u8]) -> Option<u64> {
        self.groups.get(group_id).and_then(|g| g.behind)
    }

    fn mark_behind(&mut self, group_id: &[u8], claimed: u64) {
        if let Some(g) = self.groups.get_mut(group_id) {
            let have = g.state.as_ref().map(|s| s.version).unwrap_or(0);
            if claimed > have {
                g.behind = Some(g.behind.map_or(claimed, |b| b.max(claimed)));
            }
        }
    }

    /// Отправка/раздача ключей в группу допустима только по актуальному
    /// журналу (D-03) и в неустаревшей эпохе (C1-12: после исключения/бана
    /// ключи получает только новый состав).
    fn group_send_ready(&self, group_id: &[u8], state: &GroupState) -> CResult<()> {
        if self.group_behind(group_id).is_some() {
            return need(Need::GroupLog { group: group_id.to_vec(), after: state.version });
        }
        Ok(())
    }

    /// Принять записи журнала группы (после `group.state.sync` с after = group_version).
    /// Подписантов проверяет по журналам устройств: неизвестный подписант —
    /// `Need::PeerLog` (добрать и повторить).
    pub fn group_ingest(&mut self, group: &Ref, entries: Vec<GroupStateEntry>) -> CResult<u64> {
        self.group_ingest_hinted(group, entries, &[])
    }

    /// То же с подсказками сервера `signer_hints` (адрес подписанта каждой
    /// записи): подсказке не доверяем — она лишь говорит, чей журнал устройств
    /// добрать, когда подписант не участник (генезис у нового участника,
    /// вступление по ссылке). Подписант проверяется по ключу устройства.
    pub fn group_ingest_hinted(&mut self, group: &Ref, entries: Vec<GroupStateEntry>, hints: &[String]) -> CResult<u64> {
        let mut state = self.group_state(&group.id).cloned();
        let mut accepted = vec![];
        for (i, e) in entries.into_iter().enumerate() {
            let hint: [u8; 32] = e.change.as_ref().and_then(|c| c.signer_key.as_slice().try_into().ok()).ok_or(ProtoError::InvalidField("signer"))?;
            let claimed = entry_signer_version(&e);
            // spec 026: журналы адреса-подсказки и прежнего адреса (`RenameMember`) — прочитать
            let (hinted_as, renamed_old) = entry_rename_addresses(&e);
            for u in hinted_as.iter().chain(renamed_old.iter()) {
                if crate::address::is_valid_address(u) && !self.is_own_address(u) && self.peer_log(u).is_none() {
                    return need(Need::PeerLog { user: u.clone(), after: 0 });
                }
            }
            // ENG-08: запись ссылается на более новый журнал устройств подписанта — догнать его
            // (в нём может быть и отзыв этого устройства)
            let owner = hinted_as.clone().or_else(|| self.key_owner(&hint)).or_else(|| hints.get(i).filter(|u| self.peer_log(u).is_some()).cloned());
            if let Some(u) = owner {
                let have = self.log_version(&u);
                if claimed > have {
                    return need(Need::PeerLog { user: u, after: have });
                }
            }
            let known = match &hinted_as {
                Some(a) => self.signer_resolver_as()(&hint, claimed, a).is_some(),
                None => self.signer_resolver()(&hint, claimed).is_some(),
            };
            if !known {
                // Подписант неизвестен: чей это ключ, узнаём из журналов —
                // сначала того, на кого указал сервер, затем участников.
                let hinted = hints.get(i).filter(|u| crate::address::is_valid_address(u) && self.peer_log(u).is_none()).cloned();
                let who: Vec<String> = state.as_ref().map(|s| s.members.keys().cloned().collect()).unwrap_or_default();
                let missing = hinted.or_else(|| who.into_iter().find(|u| self.peer_log(u).is_none()));
                if let Some(u) = missing {
                    return need(Need::PeerLog { user: u, after: 0 });
                }
                self.note_unconfirmed(&group.id, &e);
                return Err(ClientError::Proto(ProtoError::Forbidden));
            }
            let applied = {
                let resolve = self.signer_resolver();
                let (signer_as, root_of) = (self.signer_resolver_as(), self.root_resolver());
                let lookup = group::Lookup { signer_as: &signer_as, root_of: &root_of };
                group::apply_with(state.as_ref(), &e, &resolve, Some(&lookup))
            };
            let next = match applied {
                Ok(n) => n,
                Err(err) => {
                    if matches!(err, ProtoError::Forbidden | ProtoError::BadSignature) {
                        self.note_unconfirmed(&group.id, &e);
                    }
                    return Err(err.into());
                }
            };
            if next.group.id != group.id {
                return Err(ClientError::Proto(ProtoError::ContextMismatch));
            }
            state = Some(next);
            accepted.push(e);
        }
        let g = self.groups.entry(group.id.clone()).or_insert_with(|| GroupLocal::new(vec![], None));
        g.entries.extend(accepted);
        g.state = state;
        let version = g.state.as_ref().map(|s| s.version).unwrap_or(0);
        if g.behind.is_some_and(|b| version >= b) {
            g.behind = None;
        }
        Ok(version)
    }

    fn note_unconfirmed(&mut self, group_id: &[u8], e: &GroupStateEntry) {
        if let (Some(m), Some(g)) = (entry_added_member(e), self.groups.get_mut(group_id)) {
            g.unconfirmed.insert(m);
        }
    }

    /// FR-028 (T080): кто числится участником у сервера (`claimed` — состав,
    /// который показывает сервер), но не подтверждён проверенным журналом, плюс
    /// добавленные отвергнутыми записями. Таким ключи не раздаются.
    pub fn group_unconfirmed(&self, group_id: &[u8], claimed: &[String]) -> Vec<String> {
        let Some(g) = self.groups.get(group_id) else { return vec![] };
        let mut out = g.unconfirmed.clone();
        if let Some(s) = &g.state {
            out.extend(claimed.iter().filter(|u| !s.members.contains_key(*u)).cloned());
            out.retain(|u| !s.members.contains_key(u));
        }
        out.into_iter().collect()
    }

    /// Забыть журнал группы (локальная запись отвергнута сервером — хост
    /// перечитывает журнал с начала). Ключи эпох остаются.
    pub fn group_forget(&mut self, group_id: &[u8]) {
        self.groups.remove(group_id);
    }

    /// Группы, журнал которых известен устройству.
    pub fn group_ids(&self) -> Vec<Vec<u8>> {
        self.groups.iter().filter(|(_, g)| g.state.is_some()).map(|(id, _)| id.clone()).collect()
    }

    /// Вступить по ссылке-приглашению (D-04): журнал группы уже принят
    /// (`group.state.sync` с `invite_link_id`); подпись ключом ссылки над
    /// позицией и своим корнем, запись — своим устройством.
    pub fn group_join(&mut self, parts: &gpb::InviteLinkParts) -> Result<OutRequest> {
        let link = crate::invite::signing_key(parts)?;
        let gid = self.group_id_by_link(&parts.link_id).ok_or(ProtoError::NotFound)?;
        let state = self.group_state(&gid).cloned().ok_or(ProtoError::NotFound)?;
        let root = self.own_log.root_key;
        let join = gpb::JoinByInvite {
            link_public_key: link.verifying_key().to_bytes().to_vec(),
            joiner_root_key: root.to_vec(),
            link_signature: group::sign_join(&link, &state, &root),
        };
        // Ссылка «по одобрению»: запись вступления — это ЗАЯВКА. В журнал она
        // не попадает (участником заявителя сделает админ записью `AddMember`),
        // поэтому локально не применяется: сервер проверит подпись ключа ссылки
        // и ответит `pending`.
        let link_id = group::link_id(&join.link_public_key);
        if state.invite_links.get(&link_id).is_some_and(|l| l.announce.requires_approval) {
            let entry = group::build_entry_at(&self.acc, Some(&state), &self.domain, Change::JoinByInvite(join), now_ms(), self.own_signer_version(Some(&state)))?;
            return Ok(OutRequest::id("group.join", &gpb::JoinRequest { entry: Some(entry) }));
        }
        self.group_change(&gid, Change::JoinByInvite(join))
    }

    /// Новая ссылка-приглашение: запись `GroupInviteKeyAnnounce` и части
    /// ссылки (секрет — только в URL, серверу не уходит).
    /// Публичная группа (spec 023): включить (имя, настройки; секрет прежний либо новый) или выключить. После
    /// смены секрета эпоха устаревает — хост делает `group_rotate_epoch` (комплект ляжет в журнал).
    pub fn group_set_public(&mut self, group_id: &[u8], public: bool, name: &str, preview: bool, history: bool) -> Result<OutRequest> {
        let state = self.group_state(group_id).cloned().ok_or(ProtoError::NotFound)?;
        let change = if public {
            let name = group::normalize_public_name(name).ok_or(ProtoError::InvalidField("name"))?;
            let secret = state.public.as_ref().map(|p| p.secret).unwrap_or_else(rand32);
            gpb::SetPublic { public: true, name, secret: secret.to_vec(), preview, history }
        } else {
            gpb::SetPublic::default()
        };
        self.group_change(group_id, Change::SetPublic(change))
    }

    /// Вступить в публичную группу по открытому секрету (журнал группы уже загружен по публичной ссылке).
    pub fn group_join_public(&mut self, group_id: &[u8], secret: &[u8; 32]) -> Result<OutRequest> {
        let state = self.group_state(group_id).cloned().ok_or(ProtoError::NotFound)?;
        let link = group::public_link_key(secret);
        if state.public.as_ref().is_none_or(|p| p.link_public_key != link.verifying_key().to_bytes()) {
            return Err(ProtoError::Forbidden);
        }
        let root = self.own_log.root_key;
        let join = gpb::JoinByInvite {
            link_public_key: link.verifying_key().to_bytes().to_vec(),
            joiner_root_key: root.to_vec(),
            link_signature: group::sign_join(&link, &state, &root),
        };
        self.group_change(group_id, Change::JoinByInvite(join))
    }

    pub fn group_invite_create(&mut self, group_id: &[u8], title: &str, expires_ms: i64, usage_limit: u32, requires_approval: bool) -> Result<(OutRequest, gpb::InviteLinkParts)> {
        let (key, parts) = crate::invite::generate(&self.domain)?;
        let announce = crate::pb::parvane::core::v2::GroupInviteKeyAnnounce {
            link_public_key: key.verifying_key().to_bytes().to_vec(),
            expires_ms,
            usage_limit,
            requires_approval,
            title: title.into(),
        };
        let req = self.group_change(group_id, Change::InviteKey(announce))?;
        Ok((req, parts))
    }

    fn group_id_by_link(&self, link_id: &[u8]) -> Option<Vec<u8>> {
        let id: [u8; 32] = link_id.try_into().ok()?;
        self.groups.iter().find(|(_, g)| g.state.as_ref().is_some_and(|s| s.invite_links.contains_key(&id))).map(|(gid, _)| gid.clone())
    }

    /// Создать группу: запись генезиса (затем — `group_rotate_epoch`).
    pub fn group_create(&mut self, kind: gpb::GroupKind, name: &str, members: &[String], perms: gpb::Permissions) -> Result<(Ref, OutRequest)> {
        self.group_create_from(kind, name, members, perms, "")
    }

    /// То же для группы, переводимой из v1 (T180): `migrated_from` — прежний `group_id`.
    pub fn group_create_from(&mut self, kind: gpb::GroupKind, name: &str, members: &[String], perms: gpb::Permissions, migrated_from: &str) -> Result<(Ref, OutRequest)> {
        let create = gpb::Create {
            kind: kind as i32,
            name: name.into(),
            about: String::new(),
            default_permissions: Some(perms),
            members: members.iter().map(|m| UserRef { address: m.clone() }).collect(),
            migrated_from: migrated_from.into(),
        };
        let entry = group::build_entry_at(&self.acc, None, &self.domain, Change::Create(create), now_ms(), self.own_signer_version(None))?;
        let g = entry.group.clone().ok_or(ProtoError::InvalidField("group"))?;
        let st = {
            let resolve = self.signer_resolver();
            let (signer_as, root_of) = (self.signer_resolver_as(), self.root_resolver());
                let lookup = group::Lookup { signer_as: &signer_as, root_of: &root_of };
            group::apply_with(None, &entry, &resolve, Some(&lookup))?
        };
        self.groups.insert(g.id.clone(), GroupLocal::new(vec![entry.clone()], Some(st)));
        Ok((g, OutRequest::id("group.state.append", &gpb::StateAppendRequest { entry: Some(entry) })))
    }

    /// Запись журнала группы: собрать, проверить по своему состоянию и
    /// применить локально (отказ сервера хост лечит пересинхронизацией).
    fn group_entry(&mut self, group_id: &[u8], change: Change) -> Result<GroupStateEntry> {
        let state = self.group_state(group_id).cloned().ok_or(ProtoError::NotFound)?;
        let entry = group::build_entry_as(&self.acc, Some(&state), &self.domain, change, now_ms(), self.own_signer_version(Some(&state)), self.own_signer_hint())?;
        let next = {
            let resolve = self.signer_resolver();
            let (signer_as, root_of) = (self.signer_resolver_as(), self.root_resolver());
                let lookup = group::Lookup { signer_as: &signer_as, root_of: &root_of };
            group::apply_with(Some(&state), &entry, &resolve, Some(&lookup))?
        };
        if let Some(g) = self.groups.get_mut(group_id) {
            g.entries.push(entry.clone());
            g.state = Some(next);
        }
        Ok(entry)
    }

    /// Решение по заявке на вступление (ссылка с одобрением, D-04):
    /// одобрение — запись `AddMember`, которую сервер проводит и снимает
    /// заявку одним запросом `group.request.decide`; отказ — без записи.
    pub fn group_request_decide(&mut self, group_id: &[u8], user: &str, approve: bool) -> Result<OutRequest> {
        self.group_request_decide_via(group_id, user, approve, &[])
    }

    /// То же, с ссылкой, по которой пришла заявка (`JoinRequestInfo.link_id`, spec 024): одобренный
    /// считается во вступивших по ней. Пустая — без ссылки.
    pub fn group_request_decide_via(&mut self, group_id: &[u8], user: &str, approve: bool, via_link_id: &[u8]) -> Result<OutRequest> {
        let group = self.group_state(group_id).map(|s| s.group.clone()).ok_or(ProtoError::NotFound)?;
        let member = UserRef { address: user.into() };
        let entry = if approve {
            Some(self.group_entry(group_id, Change::AddMember(gpb::AddMember { via_link_id: via_link_id.to_vec(), member: Some(member.clone()) }))?)
        } else {
            None
        };
        Ok(OutRequest::id("group.request.decide", &gpb::RequestDecideRequest { group: Some(group), user: Some(member), approve, entry }))
    }

    /// Изменение группы (состав/права/сведения/ссылки): запись журнала.
    pub fn group_change(&mut self, group_id: &[u8], change: Change) -> Result<OutRequest> {
        let method = match &change {
            Change::InviteKey(_) => "group.invite.create",
            Change::InviteKeyRevoke(_) => "group.invite.revoke",
            Change::JoinByInvite(_) => "group.join",
            Change::NewEpoch(_) => "group.epoch.publish_send_key",
            _ => "group.state.append",
        };
        let entry = self.group_entry(group_id, change)?;
        let body = match method {
            "group.invite.create" => gpb::InviteCreateRequest { entry: Some(entry) }.encode_to_vec(),
            "group.invite.revoke" => gpb::InviteRevokeRequest { entry: Some(entry) }.encode_to_vec(),
            "group.join" => gpb::JoinRequest { entry: Some(entry) }.encode_to_vec(),
            "group.epoch.publish_send_key" => gpb::EpochPublishSendKeyRequest { entry: Some(entry) }.encode_to_vec(),
            _ => gpb::StateAppendRequest { entry: Some(entry) }.encode_to_vec(),
        };
        Ok(OutRequest { chan: Chan::Id, method, body, dest: None })
    }

    /// Только для тестов (cargo-feature `test-inject`): запись журнала группы
    /// БЕЗ локальной проверки права — чтобы проверить отказ сервера (право
    /// подписанта по состоянию `version-1`). Локальное состояние не меняется.
    #[cfg(feature = "test-inject")]
    pub fn group_change_raw(&mut self, group_id: &[u8], change: Change) -> Result<OutRequest> {
        let state = self.group_state(group_id).cloned().ok_or(ProtoError::NotFound)?;
        let entry = group::build_entry_at(&self.acc, Some(&state), &self.domain, change, now_ms(), self.own_signer_version(Some(&state)))?;
        Ok(OutRequest::id("group.state.append", &gpb::StateAppendRequest { entry: Some(entry) }))
    }

    /// Новая эпоха (админ): ключ отправки + ключ конверта; раздача по E2E —
    /// ключ конверта всем участникам, приватный ключ отправки — тем, кто
    /// вправе писать. Нужны сессии со всеми устройствами участников.
    pub fn group_rotate_epoch(&mut self, group_id: &[u8]) -> CResult<Vec<OutRequest>> {
        let state = self.group_state(group_id).cloned().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        // D-03: ключи новой эпохи — только по актуальному составу.
        self.group_send_ready(group_id, &state)?;
        let members: Vec<String> = state.members.keys().cloned().collect();
        for m in &members {
            self.check_peer(m)?;
        }
        let send = sign::generate_signing_key();
        let epoch = state.epoch + 1;
        let envelope_key = rand32();
        // Публичная группа (spec 023): ключи эпохи — комплектом в журнале под ключом от открытого секрета
        let public_bundle = match &state.public {
            Some(p) => group::seal_public_bundle(&p.secret, &state.group, epoch, &envelope_key, &send.to_bytes())?,
            None => vec![],
        };
        let is_public = !public_bundle.is_empty();
        let req = self.group_change(group_id, Change::NewEpoch(gpb::NewEpoch { epoch, send_public_key: send.verifying_key().to_bytes().to_vec(), public_bundle }))?;
        let next = self.group_state(group_id).cloned().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let writers: BTreeSet<String> = next.writers(now_ms()).into_iter().collect();
        self.epoch_keys.insert((group_id.to_vec(), epoch), EpochKeys { envelope_key: Zeroizing::new(envelope_key), send_sk: writers.contains(&self.user).then(|| SigningKey::from_bytes(&send.to_bytes())) });
        let mut out = vec![req];
        if is_public {
            return Ok(out);
        }
        // L2-группа: раздача ключей эпохи тоже выровнена.
        let pad = self.group_l2_state(group_id, &next).must_pad(&self.user, &[]);
        for m in &members {
            let share = GroupKeyShare {
                context: Some(next.context()),
                envelope_key: envelope_key.to_vec(),
                megolm_session_key: vec![],
                send_private_key: if writers.contains(m) { send.to_bytes().to_vec() } else { vec![] },
                ..Default::default()
            };
            let c = Content { kind: Some(content::Kind::GroupKey(share)), ..Default::default() };
            out.extend(self.share_group_key(m, &c, pad)?);
        }
        Ok(out)
    }

    /// Раздача ключа группы участнику `m` (себе — своим другим устройствам).
    /// `pad` — выравнивать (L2-группа или личное предпочтение).
    fn share_group_key(&mut self, m: &str, c: &Content, pad: bool) -> CResult<Vec<OutRequest>> {
        if m != self.user {
            return self.prepare_direct_opts(m, c, DirectOpts { op_id: sign::new_op_id(), share_dk: true, force_l2: pad, ts_ms: now_ms() });
        }
        let own: Vec<String> = self.own_log.devices.keys().filter(|d| **d != self.device_id).cloned().collect();
        let me = self.user.clone();
        let l2 = pad || self.direct_must_pad(&me);
        let mut r = if own.is_empty() {
            mpb::DeliverSealedRequest { envelopes: vec![] }
        } else {
            let o = SealOpts { op_id: sign::new_op_id(), ts_ms: now_ms(), l2 };
            self.seal_for_opts(&me, &own, &me, c, Access::DeliveryKey(self.dk.key().to_vec()), o)?
        };
        // ENG-07: раздача уходит и этому устройству (копия-обманка) — иначе сервер видит доставки
        // всем устройствам участников, кроме одного, и вычисляет автора следующего конверта
        r.envelopes.push(self.cover_envelope(c, l2)?);
        Ok(vec![OutRequest::anon("msg.deliver_sealed", &r)])
    }

    /// Шум режима L2 (spec 025): пустышка этому же устройству, выровненная по сетке L2, — снаружи и для сервера
    /// неотличима от личного сообщения (тот же метод анонимного канала, тот же размер); получив её, устройство
    /// молча выбрасывает (Olm-сессии с самим собой нет, см. `cover_envelope`).
    pub fn prepare_cover(&self) -> Result<OutRequest> {
        let content = Content { kind: Some(content::Kind::Text(mpb::Text::default())), ..Default::default() };
        let envelope = self.cover_envelope(&content, true)?;
        Ok(OutRequest::anon("msg.deliver_sealed", &mpb::DeliverSealedRequest { envelopes: vec![envelope] }))
    }

    /// ENG-07: конверт этому же устройству того же размера, что раздача ключа; получив его, устройство
    /// его отбрасывает (Olm-сессии с самим собой нет).
    fn cover_envelope(&self, c: &Content, l2: bool) -> Result<crate::pb::parvane::core::v2::SealedEnvelope> {
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let me = DeviceRef { address: self.user.clone(), device_id: self.device_id.clone() };
        let op = msg::sign_direct_at(&self.acc, c, &self.user, vec![me.clone()], now_ms(), sign::new_op_id(), self.own_log.version)?;
        // Olm-шифртекст длиннее открытого текста на заголовок и MAC
        let mut olm_message = vec![0u8; op.encoded_len() + 96];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut olm_message);
        let inner = SealedInner { sender: Some(cert), olm_message, olm_type: 1, padding: vec![] };
        seal::seal(&me, &self.hpke_pk, Access::DeliveryKey(self.dk.key().to_vec()), inner, l2)
    }

    fn accept_group_key(&mut self, sender: &str, gk: &GroupKeyShare) -> CResult<()> {
        let ctx = gk.context.as_ref().ok_or(ProtoError::InvalidField("context"))?;
        let g = ctx.group.as_ref().ok_or(ProtoError::InvalidField("group"))?;
        let state = match self.group_state(&g.id) {
            Some(s) => s.clone(),
            None => return need(Need::GroupLog { group: g.id.clone(), after: 0 }),
        };
        // ENG-03: членство отправителя — ДО отметки «отстали»: иначе любой, кто
        // знает id группы, ставил флаг с version = MAX и блокировал отправку в
        // группу навсегда. Неизвестный отправитель — дочитать журнал без флага
        // (он мог вступить позже нашей копии).
        if !state.members.contains_key(sender) {
            if matches!(state.check_context(ctx), ContextVerdict::Behind) {
                return need(Need::GroupLog { group: g.id.clone(), after: state.version });
            }
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        match state.check_context(ctx) {
            ContextVerdict::Ok => {}
            ContextVerdict::Behind => {
                self.mark_behind(&g.id, ctx.state_version);
                return need(Need::GroupLog { group: g.id.clone(), after: state.version });
            }
            // D-03: форк журнала сервером — ключи не принимаем.
            _ => return Err(ClientError::Proto(ProtoError::ContextMismatch)),
        }
        // Секреты ссылок-приглашений: принимаются по совпадению с объявленной в
        // журнале ссылкой (отозванные и неизвестные отбрасываются).
        for seed in &gk.invite_seeds {
            let Ok(seed) = <[u8; crate::invite::LINK_BYTES]>::try_from(seed.as_slice()) else { continue };
            let Ok(parts) = crate::invite::from_seed(&g.domain, &seed) else { continue };
            let Ok(id) = <[u8; 32]>::try_from(parts.link_id.as_slice()) else { continue };
            if !state.invite_links.contains_key(&id) {
                continue;
            }
            if let Ok(url) = crate::invite::format(&parts) {
                if !self.shared_invites.iter().any(|(_, u)| *u == url) && self.shared_invites.len() < 256 {
                    self.shared_invites.push((g.id.clone(), url));
                }
            }
        }
        // Своё устройство (тот же аккаунт; автор проверен по своему журналу
        // устройств) пересылает то, что уже получило само, — T142.
        let own = sender == self.user;
        if !gk.envelope_key.is_empty() {
            // Ключи эпохи раздаёт админ, создавший эпоху, либо своё устройство.
            let admin = state.owner == sender || state.members.get(sender).is_some_and(|m| m.role == gpb::Role::Admin);
            if !(admin || own) || ctx.epoch != state.epoch {
                return Err(ClientError::Proto(ProtoError::Forbidden));
            }
            let ek: [u8; 32] = gk.envelope_key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("envelope_key"))?;
            let send_sk = if gk.send_private_key.len() == 32 {
                let sk = SigningKey::from_bytes(&gk.send_private_key.as_slice().try_into().map_err(|_| ProtoError::Crypto)?);
                // Приватный ключ должен соответствовать опубликованному в журнале.
                if Some(sk.verifying_key().to_bytes()) != state.send_public_key {
                    return Err(ClientError::Proto(ProtoError::BadSignature));
                }
                Some(sk)
            } else {
                None
            };
            self.epoch_keys.insert((g.id.clone(), ctx.epoch), EpochKeys { envelope_key: Zeroizing::new(ek), send_sk });
        }
        if !gk.megolm_session_key.is_empty() {
            let inb = MegolmInbound::from_session_key(&gk.megolm_session_key)?;
            self.megolm_in.insert(inb.session_id(), Inbound { group: g.id.clone(), epoch: ctx.epoch, sender: sender.to_string(), session: inb });
        }
        if !gk.megolm_exported.is_empty() {
            // Чужую сессию Megolm вправе переслать только своё устройство; уже
            // известную сессию (с более раннего индекса) экспорт не заменяет.
            if !own || gk.megolm_owner.is_empty() {
                return Err(ClientError::Proto(ProtoError::Forbidden));
            }
            let inb = MegolmInbound::import(&gk.megolm_exported)?;
            let id = inb.session_id();
            if !self.megolm_in.contains_key(&id) {
                self.megolm_in.insert(id, Inbound { group: g.id.clone(), epoch: ctx.epoch, sender: gk.megolm_owner.clone(), session: inb });
            }
        }
        Ok(())
    }

    /// Группы v2 — своим новым устройствам (T142): грант линковки несёт только
    /// ключи устройства, поэтому устройство, уже состоящее в группах, пересылает
    /// каждому из `devices` ключи текущей эпохи и входящие сессии Megolm всех
    /// участников (с текущего индекса). Получив ключи группы, которой ещё не
    /// знает, новое устройство само дочитывает её журнал (`Need::GroupLog`).
    /// Устройства не из своего журнала и своё собственное пропускаются.
    pub fn share_groups_with_own_devices(&mut self, devices: &[String]) -> CResult<Vec<OutRequest>> {
        let own: Vec<String> = devices.iter().filter(|d| **d != self.device_id && self.own_log.devices.contains_key(*d)).cloned().collect();
        if own.is_empty() {
            return Ok(vec![]);
        }
        let me = self.user.clone();
        // Olm-сессии со своими устройствами — до сборки (иначе конверт для
        // устройства без сессии молча пропускается): Need::Bundle доберёт хост.
        self.check_peer(&me)?;
        let mut shares = vec![];
        for gid in self.group_ids() {
            let Some(state) = self.group_state(&gid).cloned() else { continue };
            if !state.members.contains_key(&me) {
                continue;
            }
            // Публичная группа (spec 023): ключи эпохи берутся из комплекта журнала лениво, при первом конверте;
            // в группе без сообщений их ещё нет — без этого новое своё устройство её не узнавало бы вовсе
            self.take_public_epoch_keys(&state, state.epoch);
            let Some(keys) = self.epoch_keys.get(&(gid.clone(), state.epoch)) else { continue };
            let pad = self.group_l2_state(&gid, &state).must_pad(&me, &[]);
            shares.push((pad, GroupKeyShare {
                context: Some(state.context()),
                envelope_key: keys.envelope_key.to_vec(),
                send_private_key: keys.send_sk.as_ref().map(|k| k.to_bytes().to_vec()).unwrap_or_default(),
                ..Default::default()
            }));
            for inb in self.megolm_in.values().filter(|i| i.group == gid && i.epoch == state.epoch) {
                shares.push((pad, GroupKeyShare {
                    context: Some(state.context()),
                    megolm_exported: inb.session.export().to_vec(),
                    megolm_owner: inb.sender.clone(),
                    ..Default::default()
                }));
            }
        }
        let mut out = vec![];
        for (pad, share) in shares {
            let c = Content { kind: Some(content::Kind::GroupKey(share)), ..Default::default() };
            let o = SealOpts { op_id: sign::new_op_id(), ts_ms: now_ms(), l2: pad || self.direct_must_pad(&me) };
            let r = self.seal_for_opts(&me, &own, &me, &c, Access::DeliveryKey(self.dk.key().to_vec()), o)?;
            out.push(OutRequest::anon("msg.deliver_sealed", &r));
        }
        // Ключ контейнера планировщика (spec 010) — тем же устройствам.
        // … и ключи контейнеров облака (spec 016).
        for c in self.planner_key_content().into_iter().chain(self.cloud_key_contents_for_own_devices()) {
            let o = SealOpts { op_id: sign::new_op_id(), ts_ms: now_ms(), l2: self.direct_must_pad(&me) };
            let r = self.seal_for_opts(&me, &own, &me, &c, Access::DeliveryKey(self.dk.key().to_vec()), o)?;
            if !r.envelopes.is_empty() {
                out.push(OutRequest::anon("msg.deliver_sealed", &r));
            }
        }
        Ok(out)
    }

    /// Секреты своих ссылок-приглашений — другим ведущим приглашения группы
    /// (владелец и админы с правом приглашать): у них общий список ссылок.
    /// `links` — ссылки этой группы целиком (с секретом); чужие группе и
    /// отозванные пропускаются. `recipients` — кому слать (хост выбирает сам:
    /// всем при создании ссылки, новому админу при назначении).
    pub fn share_invite_links(&mut self, group_id: &[u8], links: &[String], recipients: &[String]) -> CResult<Vec<OutRequest>> {
        let state = self.group_state(group_id).cloned().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let mut seeds = vec![];
        for link in links {
            let Ok(crate::invite::ParsedInvite::V2(parts)) = crate::invite::parse(link) else { continue };
            let Ok(id) = <[u8; 32]>::try_from(parts.link_id.as_slice()) else { continue };
            if state.invite_links.contains_key(&id) && crate::invite::signing_key(&parts).is_ok() && seeds.len() < 64 {
                seeds.push(parts.seed.clone());
            }
        }
        let me = self.user.clone();
        let to: Vec<String> = recipients
            .iter()
            .filter(|u| **u != me && (state.owner == **u || state.members.get(*u).is_some_and(|m| m.role == gpb::Role::Admin && m.rights.invite_users)))
            .cloned()
            .collect();
        if seeds.is_empty() || to.is_empty() {
            return Ok(vec![]);
        }
        for m in &to {
            self.check_peer(m)?;
        }
        let pad = self.group_l2_state(group_id, &state).must_pad(&me, &[]);
        let share = GroupKeyShare { context: Some(state.context()), invite_seeds: seeds, ..Default::default() };
        let c = Content { kind: Some(content::Kind::GroupKey(share)), ..Default::default() };
        let mut out = vec![];
        for m in &to {
            out.extend(self.share_group_key(m, &c, pad)?);
        }
        Ok(out)
    }

    /// Забрать принятые секреты ссылок-приглашений: пары (группа, ссылка).
    pub fn take_shared_invites(&mut self) -> Vec<(Vec<u8>, String)> {
        std::mem::take(&mut self.shared_invites)
    }

    /// После `group_ingest`: применить отложенные ключи и открыть отложенные
    /// групповые сообщения. Возвращает готовые события.
    pub fn drain_ready(&mut self) -> Vec<Event> {
        let keys = std::mem::take(&mut self.pending_keys);
        for (sender, gk) in keys {
            match self.accept_group_key(&sender, &gk) {
                Ok(()) => {}
                Err(ClientError::Need(Need::GroupLog { .. })) => self.pending_keys.push((sender, gk)),
                Err(_) => {}
            }
        }
        self.retry_pending_groups()
    }

    fn retry_pending_groups(&mut self) -> Vec<Event> {
        let pending = std::mem::take(&mut self.pending_group);
        let mut out = vec![];
        for (seq, env) in pending {
            match self.open_group(seq, &env) {
                Ok(e) => out.extend(e),
                Err(ClientError::Need(_)) => self.pending_group.push((seq, env)),
                Err(ClientError::Proto(_)) => out.push(Event::Skipped { seq }),
            }
        }
        out
    }

    /// Отправить сообщение в группу: при первой отправке в эпохе — раздать свой
    /// Megolm-ключ участникам (E2E), затем конверт через анонимный канал.
    pub fn prepare_group(&mut self, group_id: &[u8], c: &Content) -> CResult<Vec<OutRequest>> {
        self.prepare_group_id(group_id, c, sign::new_op_id())
    }

    pub fn prepare_group_id(&mut self, group_id: &[u8], c: &Content, op_id: Vec<u8>) -> CResult<Vec<OutRequest>> {
        let state = self.group_state(group_id).cloned().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if !state.content_allowed(&self.user, c, now_ms()) {
            return need(Need::Forbidden);
        }
        // Режим группы — запись журнала (`set_privacy_mode`), не содержимое.
        if matches!(c.kind, Some(content::Kind::ChatMode(_))) {
            return Err(ClientError::Proto(ProtoError::InvalidField("chat_mode")));
        }
        let pad = self.group_l2_state(group_id, &state).must_pad(&self.user, &[]);
        // D-03 (C1-03): отстаём от головы журнала — ни ключей, ни сообщений.
        self.group_send_ready(group_id, &state)?;
        // C1-12: состав/права изменились, новой эпохи ещё нет — старые ключи
        // эпохи и своя Megolm-сессия могли быть у исключённого; ждём новую эпоху.
        if state.epoch_stale {
            return need(Need::GroupKeys { group: group_id.to_vec(), epoch: state.epoch + 1 });
        }
        let epoch = state.epoch;
        let key = (group_id.to_vec(), epoch);
        self.take_public_epoch_keys(&state, epoch);
        let Some(ek) = self.epoch_keys.get(&key) else { return need(Need::GroupKeys { group: group_id.to_vec(), epoch }) };
        let Some(send) = ek.send_sk.as_ref().map(|k| SigningKey::from_bytes(&k.to_bytes())) else { return need(Need::Forbidden) };
        let envelope_key = *ek.envelope_key;
        let mut out = vec![];
        let session = self.megolm_out.entry(key.clone()).or_default();
        let session_key = session.session_key();
        let session_id = session.session_id();
        // Своя входящая копия — чтобы читать собственные сообщения с других устройств.
        if !self.megolm_in.contains_key(&session_id) {
            if let Ok(inb) = MegolmInbound::from_session_key(&session_key) {
                self.megolm_in.insert(session_id.clone(), Inbound { group: group_id.to_vec(), epoch, sender: self.user.clone(), session: inb });
            }
        }
        // Публичная группа: сеанс едет в самом конверте — раздавать его участникам по E2E не нужно
        let is_public = state.public.is_some();
        let members: Vec<String> = if is_public { vec![] } else { state.members.keys().cloned().collect() };
        // Сессии со всеми, кому раздавать, — до раздачи (иначе при добор-повторе
        // часть участников отмечена «получил», а запросы к ним отброшены).
        for m in &members {
            if !self.megolm_shared.contains(&(group_id.to_vec(), epoch, m.clone())) {
                self.check_peer(m)?;
            }
        }
        let mut shared_now = vec![];
        for m in &members {
            if self.megolm_shared.contains(&(group_id.to_vec(), epoch, m.clone())) {
                continue;
            }
            let share = GroupKeyShare { context: Some(state.context()), envelope_key: vec![], megolm_session_key: session_key.to_vec(), ..Default::default() };
            let sc = Content { kind: Some(content::Kind::GroupKey(share)), ..Default::default() };
            out.extend(self.share_group_key(m, &sc, pad)?);
            shared_now.push(m.clone());
        }
        for m in shared_now {
            self.megolm_shared.insert((group_id.to_vec(), epoch, m));
        }
        if msg::is_trackable(c) {
            self.reads.track(&op_id, msg::ChatKey::Group(group_id.to_vec()));
        }
        let op = msg::sign_group_at(&self.acc, c, state.context(), now_ms(), op_id, self.own_log.version)?;
        let cert = self.my_cert.clone().ok_or(ProtoError::BadCertificate)?;
        let plain = msg::group_plaintext(&cert, op);
        let session = self.megolm_out.get_mut(&key).ok_or(ProtoError::Crypto)?;
        let megolm_message = session.encrypt(&plain);
        let public_session = if is_public { session_key.to_vec() } else { vec![] };
        let mut inner = GroupEnvelopeInner { megolm_session_id: session_id.into_bytes(), megolm_message, padding: vec![], public_session };
        if pad {
            l2::pad_group(&mut inner);
        }
        let env = group::seal_envelope(&send, &envelope_key, &state.group, epoch, &inner)?;
        out.push(OutRequest::anon("msg.deliver_group", &mpb::DeliverGroupRequest { envelope: Some(env) }));
        Ok(out)
    }

    /// История публичной группы (`group.public.history`): конверт → события (без курсора инбокса, seq = 0).
    pub fn open_group_envelope(&mut self, envelope: &[u8]) -> CResult<Vec<Event>> {
        let env: GroupEnvelope = decode_checked(envelope, Origin::Server)?;
        self.open_group(0, &env)
    }

    /// Публичная группа (spec 023): ключи эпохи из комплекта журнала, если своих нет.
    fn take_public_epoch_keys(&mut self, state: &GroupState, epoch: u64) {
        let key = (state.group.id.clone(), epoch);
        if self.epoch_keys.contains_key(&key) {
            return;
        }
        let (Some(p), Some(bundle)) = (state.public.as_ref(), state.public_bundles.get(&epoch)) else { return };
        if let Ok((envelope_key, send)) = group::open_public_bundle(&p.secret, &state.group, epoch, bundle) {
            self.epoch_keys.insert(key, EpochKeys { envelope_key, send_sk: Some(SigningKey::from_bytes(&send)) });
        }
    }

    /// Сообщение публичной группы сеансом из конверта: (plaintext, индекс, автор по сертификату).
    fn open_public_session(&self, inner: &GroupEnvelopeInner) -> CResult<(Vec<u8>, u32, String)> {
        let mut inb = MegolmInbound::from_session_key(&inner.public_session)?;
        let (pt, index) = inb.decrypt(&inner.megolm_message)?;
        let author = msg::group_plaintext_author(&pt).ok_or(ProtoError::BadCertificate)?;
        Ok((pt, index, author))
    }

    fn open_group(&mut self, seq: u64, env: &GroupEnvelope) -> CResult<Vec<Event>> {
        let g = env.group.clone().ok_or(ProtoError::InvalidField("group"))?;
        let state = match self.group_state(&g.id) {
            Some(s) => s.clone(),
            None => return need(Need::GroupLog { group: g.id.clone(), after: 0 }),
        };
        if env.epoch > state.epoch {
            return need(Need::GroupLog { group: g.id.clone(), after: state.version });
        }
        self.take_public_epoch_keys(&state, env.epoch);
        let Some(ek) = self.epoch_keys.get(&(g.id.clone(), env.epoch)) else {
            return need(Need::GroupKeys { group: g.id.clone(), epoch: env.epoch });
        };
        let inner = group::open_envelope(env, &ek.envelope_key)?;
        let sid = String::from_utf8(inner.megolm_session_id.clone()).map_err(|_| ProtoError::InvalidField("session"))?;
        let (pt, index, expected_sender) = match self.megolm_in.get_mut(&sid) {
            Some(inb) => {
                if inb.group != g.id || inb.epoch != env.epoch {
                    return Err(ClientError::Proto(ProtoError::ContextMismatch));
                }
                match inb.session.decrypt(&inner.megolm_message) {
                    Ok((pt, index)) => (pt, index, inb.sender.clone()),
                    // Публичная группа: сообщение старше известного индекса (история) — сеанс из конверта
                    Err(_) if !inner.public_session.is_empty() => self.open_public_session(&inner)?,
                    Err(e) => return Err(e.into()),
                }
            }
            None if !inner.public_session.is_empty() => {
                let opened = self.open_public_session(&inner)?;
                if let Ok(inb) = MegolmInbound::from_session_key(&inner.public_session) {
                    self.megolm_in.insert(sid.clone(), Inbound { group: g.id.clone(), epoch: env.epoch, sender: opened.2.clone(), session: inb });
                }
                opened
            }
            None => return need(Need::GroupKeys { group: g.id.clone(), epoch: env.epoch }),
        };
        // Журнал автора — до отметки индекса «виденным» (повтор после добора).
        if expected_sender != self.user && self.peers.get(&expected_sender).and_then(|p| p.log.as_ref()).is_none() {
            return need(Need::PeerLog { user: expected_sender, after: 0 });
        }
        let mut seen = SeenAdapter { c: &mut self.seen, list: &mut self.seen_list };
        let resolve_logs: HashMap<String, DeviceLog> = std::iter::once((self.user.clone(), self.own_log.clone()))
            .chain(self.peers.iter().filter_map(|(u, p)| p.log.clone().map(|l| (u.clone(), l))))
            .collect();
        let active = |d: &VerifiedDevice| resolve_logs.get(d.user()).and_then(|l| l.active(&d.cert.device_id)).is_some_and(|x| x.cert == d.cert);
        let opened = match msg::open_group(&state, msg::GroupIncoming { envelope_epoch: env.epoch, plaintext: &pt, session_id: &sid, index }, &active, now_ms(), &mut seen) {
            Ok(o) => o,
            // D-03 (C1-03): автор видит более новую голову журнала — догнать
            // журнал (не отбрасывать сообщение) и до догона не отправлять.
            Err(ProtoError::BrokenChain) => {
                let claimed = msg::group_context_version(&pt).unwrap_or(state.version + 1);
                self.mark_behind(&g.id, claimed);
                return need(Need::GroupLog { group: g.id.clone(), after: state.version });
            }
            Err(e) => return Err(e.into()),
        };
        // Автор сообщения = владелец Megolm-сессии (ключ раздавал он сам).
        if opened.sender.user() != expected_sender && !self.aliases_of(&expected_sender).iter().any(|a| a == opened.sender.user()) {
            return Err(ClientError::Proto(ProtoError::BadCertificate));
        }
        self.note_author_log(&expected_sender, opened.op.header.author_log_version);
        if let Some(content::Kind::Receipt(r)) = &opened.content.kind {
            let me = self.user.clone();
            self.reads.apply(&me, &msg::ChatKey::Group(g.id.clone()), opened.sender.user(), r, opened.op.header.ts_ms);
        }
        // Режим группы задаёт только журнал состояния: `ChatMode` в групповом
        // конверте не действует и не показывается.
        if matches!(opened.content.kind, Some(content::Kind::ChatMode(_))) {
            return Ok(vec![Event::Internal { seq }]);
        }
        Ok(vec![Event::Group {
            seq,
            group: g,
            from: opened.sender.user().to_string(),
            device: opened.sender.cert.device_id.clone(),
            op_id: opened.op.header.op_id.clone(),
            ts_ms: opened.op.header.ts_ms,
            content: opened.content,
            disposition: opened.disposition,
        }])
    }

    // ── состояние ───────────────────────────────────────────────────────────

    /// Экспорт состояния, зашифрованный ключом хранилища хоста (32 байта).
    pub fn export(&self, storage_key: &[u8; 32]) -> Result<Vec<u8>> {
        let b = |x: &[u8]| base64::engine::general_purpose::STANDARD.encode(x);
        let p = Persisted {
            v: 1,
            user: self.user.clone(),
            device_id: self.device_id.clone(),
            domain: self.domain.clone(),
            account: self.acc.to_pickle_json()?,
            hpke_sk: b(&*self.hpke_sk),
            ssk: self.ssk.as_ref().map(|k| b(&k.to_bytes())),
            own_entries: self.own_entries.iter().map(|e| b(&e.encode_to_vec())).collect(),
            former_own: self.former_own.iter().map(|(entries, log)| (log.user.clone(), entries.iter().map(|e| b(&e.encode_to_vec())).collect())).collect(),
            my_cert: self.my_cert.as_ref().map(|c| b(&c.encode_to_vec())),
            cert_serial: self.cert_serial,
            peers: self
                .peers
                .iter()
                .map(|(u, p)| PersistedPeer {
                    user: u.clone(),
                    entries: p.entries.iter().map(|e| b(&e.encode_to_vec())).collect(),
                    pin_version: p.pin.version,
                    pin_hash: b(&p.pin.head_hash),
                    delivery_key: p.delivery_key.as_ref().map(|(k, g)| (b(k), *g)),
                })
                .collect(),
            sessions: self.sessions.iter().filter_map(|((u, d), s)| s.to_pickle_json().ok().map(|p| (u.clone(), d.clone(), p))).collect(),
            old_sessions: self
                .old_sessions
                .iter()
                .flat_map(|((u, d), list)| list.iter().filter_map(|s| s.to_pickle_json().ok().map(|p| (u.clone(), d.clone(), p))))
                .collect(),
            groups: self.groups.iter().map(|(id, g)| (b(id), g.entries.iter().map(|e| b(&e.encode_to_vec())).collect())).collect(),
            epoch_keys: self
                .epoch_keys
                .iter()
                .map(|((g, e), k)| (b(g), *e, b(&*k.envelope_key), k.send_sk.as_ref().map(|s| b(&s.to_bytes()))))
                .collect(),
            megolm_out: self.megolm_out.iter().filter_map(|((g, e), s)| s.to_pickle_json().ok().map(|p| (b(g), *e, p))).collect(),
            megolm_shared: self.megolm_shared.iter().map(|(g, e, u)| (b(g), *e, u.clone())).collect(),
            megolm_in: self
                .megolm_in
                .iter()
                .filter_map(|(sid, i)| i.session.to_pickle_json().ok().map(|p| (sid.clone(), b(&i.group), i.epoch, i.sender.clone(), p)))
                .collect(),
            my_delivery_key: b(self.dk.key()),
            my_dk_gen: self.dk.generation(),
            dk_shared: self.dk.shared().iter().map(|(u, g)| (u.clone(), *g)).collect(),
            tokens: self.stock.entries().map(|(t, _)| b(&t.encode_to_vec())).collect(),
            token_until: self.stock.entries().map(|(_, u)| u).collect(),
            next_refill_ms: self.stock.next_refill_ms(),
            foreign_tokens: self
                .foreign_tokens
                .iter()
                .map(|(domain, f)| PersistedForeignTokens {
                    domain: domain.clone(),
                    tokens: f.stock.entries().map(|(t, _)| b(&t.encode_to_vec())).collect(),
                    token_until: f.stock.entries().map(|(_, u)| u).collect(),
                    next_refill_ms: f.stock.next_refill_ms(),
                    keys: f.keys.iter().map(|k| b(&k.encode_to_vec())).collect(),
                })
                .collect(),
            token_keys: self.token_keys.iter().map(|k| b(&k.encode_to_vec())).collect(),
            state_key: self.state_key.as_ref().map(|(k, v)| (b(k.as_bytes()), *v)),
            reads: self.reads.clone(),
            revocations_done: self.revocations_done.iter().cloned().collect(),
            trust: self.peers.keys().filter_map(|u| self.trust.get(u).map(|r| (u.clone(), b(r)))).collect(),
            sticky: self.sticky.users().cloned().collect(),
            seen: vec![],
            seen_packed: self.seen_packed(),
            cursor: self.cursor.disk_value(),
            pending_group: self.pending_group.iter().map(|(s, e)| (*s, b(&e.encode_to_vec()))).collect(),
            pending_keys: self.pending_keys.iter().map(|(u, k)| (u.clone(), b(&k.encode_to_vec()))).collect(),
            group_behind: self.groups.iter().filter_map(|(id, g)| g.behind.map(|v| (b(id), v))).collect(),
            l2_direct: self.l2_direct.iter().map(|(chat, s)| (chat.clone(), s.prefs().map(|(u, p)| (u.to_string(), p.enabled, p.ts_ms)).collect())).collect(),
            l2_group_pref: self.l2_group_pref.iter().map(|(g, p)| (b(g), p.enabled, p.ts_ms)).collect(),
            planner: self.planner_persist(),
            planner_pending_keys: self.planner_pending_keys.iter().map(|k| b(&k.encode_to_vec())).collect(),
            planner_trusted_keys: self.planner_trusted_keys.iter().map(|(d, id, e, k)| (d.clone(), b(id), *e, b(k))).collect(),
            planner_authors: self.planner_authors.iter().map(|(k, d)| (b(k), d.clone())).collect(),
            cloud: self.cloud_persist(),
            cloud_pending_keys: self.cloud_pending_keys.iter().map(|(u, k)| (u.clone(), b(&k.encode_to_vec()))).collect(),
            cloud_trusted_keys: self.cloud_trusted_keys.iter().map(|(id, e, k)| (b(id), *e, b(k))).collect(),
            cloud_authors: self.cloud_authors.iter().map(|(k, (u, d))| (b(k), u.clone(), d.clone())).collect(),
        };
        let json = Zeroizing::new(serde_json::to_vec(&p).map_err(|_| ProtoError::Crypto)?);
        let mut nonce = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        let ct = ChaCha20Poly1305::new(Key::from_slice(storage_key))
            .encrypt(Nonce::from_slice(&nonce), chacha20poly1305::aead::Payload { msg: &json, aad: b"parvane/v2/client-state" })
            .map_err(|_| ProtoError::Crypto)?;
        let mut out = nonce.to_vec();
        out.extend(ct);
        Ok(out)
    }

    /// Восстановить состояние (проверяя журналы и группы заново).
    pub fn import(blob: &[u8], storage_key: &[u8; 32]) -> Result<Self> {
        if blob.len() < 12 {
            return Err(ProtoError::Crypto);
        }
        let json = Zeroizing::new(
            ChaCha20Poly1305::new(Key::from_slice(storage_key))
                .decrypt(Nonce::from_slice(&blob[..12]), chacha20poly1305::aead::Payload { msg: &blob[12..], aad: b"parvane/v2/client-state" })
                .map_err(|_| ProtoError::Crypto)?,
        );
        let p: Persisted = serde_json::from_slice(&json).map_err(|_| ProtoError::Malformed)?;
        let d = |s: &str| base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| ProtoError::Malformed);
        let d32 = |s: &str| -> Result<[u8; 32]> { d(s)?.as_slice().try_into().map_err(|_| ProtoError::Malformed) };
        let op = |s: &str| -> Result<SignedOp> { SignedOp::decode(d(s)?.as_slice()).map_err(|_| ProtoError::Malformed) };
        let mut c = Client::new(&p.user, &p.device_id, &p.domain)?;
        c.acc = OlmAccount::from_parvane_e2e_json(&p.account)?;
        c.hpke_sk = Zeroizing::new(d32(&p.hpke_sk)?);
        c.hpke_pk = x25519_public(&c.hpke_sk)?;
        c.ssk = p.ssk.as_deref().map(d32).transpose()?.map(|k| SigningKey::from_bytes(&k));
        for e in &p.own_entries {
            let o = op(e)?;
            c.own_log.apply(&o)?;
            c.own_entries.push(o);
        }
        for (addr, entries) in &p.former_own {
            let mut log = DeviceLog::new(addr)?;
            let mut ops = vec![];
            for e in entries {
                let o = op(e)?;
                log.apply(&o)?;
                ops.push(o);
            }
            c.former_own.push((ops, log));
        }
        c.my_cert = p.my_cert.as_deref().map(|s| d(s).and_then(|b| SignedDeviceCertificate::decode(b.as_slice()).map_err(|_| ProtoError::Malformed))).transpose()?;
        c.cert_serial = p.cert_serial;
        for (u, r) in &p.trust {
            c.trust.accept(u, &d32(r)?);
        }
        for pp in p.peers {
            let mut log = DeviceLog::new(&pp.user)?;
            let mut entries = vec![];
            for e in &pp.entries {
                let o = op(e)?;
                log.apply(&o)?;
                entries.push(o);
            }
            let peer = Peer {
                rename_linked: false,
                entries,
                log: (log.version > 0).then_some(log),
                pin: LogPin { version: pp.pin_version, head_hash: d32(&pp.pin_hash)? },
                delivery_key: pp.delivery_key.map(|(k, g)| d(&k).map(|k| (k, g))).transpose()?,
                pending_root: None,
            };
            c.peers.insert(pp.user, peer);
        }
        for (u, dv, s) in p.sessions {
            c.sessions.insert((u, dv), OlmSession::from_parvane_e2e_json(&s)?);
        }
        for (u, dv, s) in p.old_sessions {
            c.old_sessions.entry((u, dv)).or_default().push(OlmSession::from_parvane_e2e_json(&s)?);
        }
        for u in p.sticky {
            c.sticky.mark(&u);
        }
        for (gid, entries) in p.groups {
            let gid = d(&gid)?;
            let mut list = vec![];
            for e in entries {
                list.push(GroupStateEntry::decode(d(&e)?.as_slice()).map_err(|_| ProtoError::Malformed)?);
            }
            let g = Ref { domain: c.domain.clone(), id: gid };
            // ENG-08: запись, которая теперь не проверяется, не стирает группу — остаётся проверенная
            // часть журнала, остальное группа добирает синком (и показывает причину отказа)
            if c.group_ingest(&g, list.clone()).is_err() {
                for e in list {
                    if c.group_ingest(&g, vec![e]).is_err() {
                        break;
                    }
                }
            }
        }
        for (gid, v) in &p.group_behind {
            let gid = d(gid)?;
            c.mark_behind(&gid, *v);
        }
        for (g, e, ek, sk) in p.epoch_keys {
            c.epoch_keys.insert((d(&g)?, e), EpochKeys { envelope_key: Zeroizing::new(d32(&ek)?), send_sk: sk.as_deref().map(d32).transpose()?.map(|k| SigningKey::from_bytes(&k)) });
        }
        for (g, e, s) in p.megolm_out {
            c.megolm_out.insert((d(&g)?, e), MegolmOutbound::from_parvane_e2e_json(&s)?);
        }
        for (g, e, u) in p.megolm_shared {
            c.megolm_shared.insert((d(&g)?, e, u));
        }
        for (sid, g, e, sender, s) in p.megolm_in {
            c.megolm_in.insert(sid, Inbound { group: d(&g)?, epoch: e, sender, session: MegolmInbound::from_parvane_e2e_json(&s)? });
        }
        c.dk = OwnDeliveryKey::from_parts(d32(&p.my_delivery_key)?, p.my_dk_gen, p.dk_shared.into_iter().collect());
        for k in &p.token_keys {
            c.token_keys.push(TokenKey::decode(d(k)?.as_slice()).map_err(|_| ProtoError::Malformed)?);
        }
        for (i, t) in p.tokens.iter().enumerate() {
            let tok = AnonToken::decode(d(t)?.as_slice()).map_err(|_| ProtoError::Malformed)?;
            let until = p.token_until.get(i).copied().unwrap_or(i64::MAX);
            c.stock.add(vec![tok], until);
        }
        c.stock.set_next_refill(p.next_refill_ms);
        for pf in p.foreign_tokens {
            let mut f = ForeignTokens::default();
            for k in &pf.keys {
                f.keys.push(TokenKey::decode(d(k)?.as_slice()).map_err(|_| ProtoError::Malformed)?);
            }
            for (i, t) in pf.tokens.iter().enumerate() {
                let tok = AnonToken::decode(d(t)?.as_slice()).map_err(|_| ProtoError::Malformed)?;
                f.stock.add(vec![tok], pf.token_until.get(i).copied().unwrap_or(i64::MAX));
            }
            f.stock.set_next_refill(pf.next_refill_ms);
            c.foreign_tokens.insert(pf.domain.to_ascii_lowercase(), f);
        }
        c.state_key = p.state_key.as_ref().map(|(k, v)| d(k).and_then(|b| StateKey::from_bytes(&b).map_err(|_| ProtoError::Malformed)).map(|k| (k, *v))).transpose()?;
        c.reads = p.reads;
        c.revocations_done = p.revocations_done.into_iter().collect();
        // Прежний формат: сырые ключи без момента записи — считаем свежими.
        let now = now_ms();
        for s in p.seen {
            let h = seen_hash(&d(&s)?);
            let _ = c.seen.check_and_insert(&h);
            c.seen_list.push_back((h, now));
        }
        c.seen_unpack(&d(&p.seen_packed)?);
        c.cursor = Cursor::from_disk(p.cursor);
        for (u, k) in p.pending_keys {
            c.pending_keys.push((u, GroupKeyShare::decode(d(&k)?.as_slice()).map_err(|_| ProtoError::Malformed)?));
        }
        for (s, e) in p.pending_group {
            c.pending_group.push((s, GroupEnvelope::decode(d(&e)?.as_slice()).map_err(|_| ProtoError::Malformed)?));
        }
        for (chat, prefs) in p.l2_direct {
            for (user, enabled, ts_ms) in prefs {
                c.l2_apply_direct(&chat, &user, enabled, ts_ms);
            }
        }
        for (g, enabled, ts_ms) in p.l2_group_pref {
            c.l2_group_pref.insert(d(&g)?, L2Pref { enabled, ts_ms });
        }
        for (k, dev) in &p.planner_authors {
            c.planner_authors.insert(d32(k)?, dev.clone());
        }
        for (dom_name, id, epoch, key) in &p.planner_trusted_keys {
            c.planner_trusted_keys.push((dom_name.clone(), d(id)?, *epoch, d32(key)?));
        }
        for k in &p.planner_pending_keys {
            if let Ok(share) = ContainerKeyShare::decode(d(k)?.as_slice()) {
                c.planner_pending_keys.push(share);
            }
        }
        if let Some(pp) = &p.planner {
            c.planner_restore(pp)?;
        }
        for (k, user, dev) in &p.cloud_authors {
            c.cloud_authors.insert(d32(k)?, (user.clone(), dev.clone()));
        }
        for (id, epoch, key) in &p.cloud_trusted_keys {
            c.cloud_trusted_keys.push((d(id)?, *epoch, d32(key)?));
        }
        for (sender, k) in &p.cloud_pending_keys {
            if let Ok(share) = ContainerKeyShare::decode(d(k)?.as_slice()) {
                c.cloud_pending_keys.push((sender.clone(), share));
            }
        }
        for pc in &p.cloud {
            // Контейнер, который не удалось восстановить, хост подключит заново с сервера.
            if let Err(e) = c.cloud_restore(pc) {
                c.last_error = Some(e);
            }
        }
        Ok(c)
    }
}

fn x25519_public(sk: &[u8; 32]) -> Result<[u8; 32]> {
    use hpke::{Deserializable, Kem, Serializable};
    let sk = <hpke::kem::X25519HkdfSha256 as Kem>::PrivateKey::from_bytes(sk).map_err(|_| ProtoError::Crypto)?;
    let pk = <hpke::kem::X25519HkdfSha256 as Kem>::sk_to_pk(&sk);
    let mut out = [0u8; 32];
    out.copy_from_slice(&pk.to_bytes());
    Ok(out)
}

/// ReplayGuard + список для экспорта (оба — по отпечатку ключа).
struct SeenAdapter<'a> {
    c: &'a mut ReplayGuard,
    list: &'a mut VecDeque<(SeenHash, i64)>,
}

impl msg::SeenStore for SeenAdapter<'_> {
    fn insert_once(&mut self, key: &[u8]) -> Result<()> {
        let h = seen_hash(key);
        self.c.check_and_insert(&h)?;
        self.list.push_back((h, now_ms()));
        while self.list.len() > SEEN_CAP {
            self.list.pop_front();
        }
        Ok(())
    }
}

/// Размер одной записи `seen_packed`: отпечаток + момент записи (мс, BE).
const SEEN_PACKED_ENTRY: usize = 16 + 8;

impl Client {
    /// Отпечатки «видели» не старше окна, одной строкой base64
    /// (`[отпечаток 16][момент i64 BE]` подряд).
    fn seen_packed(&self) -> String {
        let now = now_ms();
        let mut out = Vec::with_capacity(self.seen_list.len() * SEEN_PACKED_ENTRY);
        for (h, ts) in &self.seen_list {
            if now.saturating_sub(*ts) > SEEN_WINDOW_MS {
                continue;
            }
            out.extend_from_slice(h);
            out.extend_from_slice(&ts.to_be_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(out)
    }

    fn seen_unpack(&mut self, packed: &[u8]) {
        for e in packed.chunks_exact(SEEN_PACKED_ENTRY) {
            let mut h = [0u8; 16];
            h.copy_from_slice(&e[..16]);
            let ts = i64::from_be_bytes(e[16..].try_into().unwrap_or([0; 8]));
            if self.seen.check_and_insert(&h).is_ok() {
                self.seen_list.push_back((h, ts));
            }
        }
        while self.seen_list.len() > SEEN_CAP {
            self.seen_list.pop_front();
        }
    }
}

/// Запас жетонов сервера другого домена (spec 028).
#[derive(Default)]
struct ForeignTokens {
    stock: TokenStock,
    keys: Vec<TokenKey>,
    req: Option<(crate::tokens::TokenRequest, TokenKey)>,
}

#[derive(Serialize, Deserialize)]
struct PersistedForeignTokens {
    domain: String,
    tokens: Vec<String>,
    token_until: Vec<i64>,
    next_refill_ms: Option<i64>,
    keys: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PersistedPeer {
    user: String,
    entries: Vec<String>,
    pin_version: u64,
    pin_hash: String,
    delivery_key: Option<(String, u64)>,
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    v: u32,
    user: String,
    device_id: String,
    domain: String,
    account: String,
    hpke_sk: String,
    ssk: Option<String>,
    own_entries: Vec<String>,
    /// spec 026: свои прежние адреса и их журналы.
    #[serde(default)]
    former_own: Vec<(String, Vec<String>)>,
    my_cert: Option<String>,
    cert_serial: u64,
    peers: Vec<PersistedPeer>,
    sessions: Vec<(String, String, String)>,
    #[serde(default)]
    old_sessions: Vec<(String, String, String)>,
    groups: Vec<(String, Vec<String>)>,
    epoch_keys: Vec<(String, u64, String, Option<String>)>,
    megolm_out: Vec<(String, u64, String)>,
    megolm_shared: Vec<(String, u64, String)>,
    megolm_in: Vec<(String, String, u64, String, String)>,
    my_delivery_key: String,
    my_dk_gen: u64,
    dk_shared: Vec<(String, u64)>,
    tokens: Vec<String>,
    trust: Vec<(String, String)>,
    sticky: Vec<String>,
    /// Прежний формат «видели»: сырые ключи base64 (читается, не пишется).
    seen: Vec<String>,
    /// «Видели» с A1(в): отпечатки с моментом записи одной строкой base64.
    #[serde(default)]
    seen_packed: String,
    cursor: u64,
    pending_group: Vec<(u64, String)>,
    #[serde(default)]
    pending_keys: Vec<(String, String)>,
    #[serde(default)]
    token_until: Vec<i64>,
    #[serde(default)]
    next_refill_ms: Option<i64>,
    /// spec 028: жетоны серверов других доменов (нет поля — нет запасов).
    #[serde(default)]
    foreign_tokens: Vec<PersistedForeignTokens>,
    #[serde(default)]
    token_keys: Vec<String>,
    #[serde(default)]
    state_key: Option<(String, u32)>,
    #[serde(default)]
    reads: msg::ReadTracker,
    #[serde(default)]
    revocations_done: Vec<String>,
    #[serde(default)]
    group_behind: Vec<(String, u64)>,
    /// L2 личных чатов: (собеседник, предпочтения участников).
    #[serde(default)]
    l2_direct: Vec<(String, Vec<PersistedL2Pref>)>,
    /// Личное предпочтение L2 в группах (ключ — id группы).
    #[serde(default)]
    l2_group_pref: Vec<PersistedL2Pref>,
    /// Контейнер планировщика (spec 010).
    #[serde(default)]
    planner: Option<PersistedPlanner>,
    #[serde(default)]
    planner_pending_keys: Vec<String>,
    #[serde(default)]
    planner_trusted_keys: Vec<(String, String, u64, String)>,
    #[serde(default)]
    planner_authors: Vec<(String, String)>,
    /// Контейнеры облака (spec 016).
    #[serde(default)]
    cloud: Vec<PersistedCloud>,
    #[serde(default)]
    cloud_pending_keys: Vec<(String, String)>,
    #[serde(default)]
    cloud_trusted_keys: Vec<(String, u64, String)>,
    #[serde(default)]
    cloud_authors: Vec<(String, String, String)>,
}

/// Предпочтение L2: (участник или id группы, включено, метка времени).
type PersistedL2Pref = (String, bool, i64);

/// Проверить подписанный описатель сервера (из Welcome/.well-known): (домен, ключ).
pub fn verify_server_descriptor(bytes: &[u8]) -> Result<(String, [u8; 32])> {
    let sd: crate::pb::parvane::core::v2::SignedServerDescriptor = decode_checked(bytes, Origin::Server)?;
    let d: crate::pb::parvane::core::v2::ServerDescriptor = decode_checked(&sd.descriptor, Origin::Server)?;
    sign::verify_ctx(&d.server_key, &sd.signature, sign::ctx::SERVER_DESCRIPTOR, &[&sd.descriptor])?;
    let k: [u8; 32] = d.server_key.as_slice().try_into().map_err(|_| ProtoError::BadSignature)?;
    if !crate::address::is_valid_domain(&d.domain) {
        return Err(ProtoError::BadAddress);
    }
    Ok((d.domain, k))
}

/// ID-01: подписываемые части доказательства устройства (общие для клиента и
/// проверки на сервере).
pub fn session_proof_parts(user: &str, device_id: &str, ts_ms: i64) -> [Vec<u8>; 3] {
    [user.as_bytes().to_vec(), device_id.as_bytes().to_vec(), ts_ms.to_be_bytes().to_vec()]
}

/// ID-01: проверка доказательства устройства ключом `olm_ed25519` из журнала.
pub fn verify_session_proof(ed25519: &[u8], user: &str, device_id: &str, ts_ms: i64, proof: &[u8]) -> bool {
    let parts = session_proof_parts(user, device_id, ts_ms);
    let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    sign::verify_ctx(ed25519, proof, sign::ctx::SESSION_PROOF, &refs).is_ok()
}

#[cfg(test)]
mod session_proof_tests {
    use super::*;

    #[test]
    fn session_proof_verifies_only_for_device_key_and_fresh_time() {
        // ID-01: подпись olm_ed25519 над адресом, device_id и временем;
        // проверяется ключом устройства из журнала
        let mut c = Client::new("alice@local", "dev-1", "local").unwrap();
        let _ = c.create_identity(2).unwrap();
        let ed = c.own_log.devices.get("dev-1").unwrap().cert.olm_ed25519.clone();
        let ts = 1_760_000_000_000i64;
        let proof = c.session_proof(ts);
        assert!(verify_session_proof(&ed, "alice@local", "dev-1", ts, &proof));
        assert!(!verify_session_proof(&ed, "alice@local", "dev-2", ts, &proof), "другое устройство");
        assert!(!verify_session_proof(&ed, "mallory@local", "dev-1", ts, &proof), "другой адрес");
        assert!(!verify_session_proof(&ed, "alice@local", "dev-1", ts + 1, &proof), "другое время");
        let other = Client::new("alice@local", "dev-2", "local").unwrap();
        assert!(!verify_session_proof(&ed, "alice@local", "dev-1", ts, &other.session_proof(ts)), "чужой ключ");
    }
}

#[cfg(test)]
mod export_size_tests {
    use super::*;
    use crate::pb::parvane::cloud::v1::{cloud_op, CloudBlobRef, CloudCreate, CloudNodeKind, CloudOp, CloudPurge};

    /// Ключ «видели» как в `msg::seen_key` (части с длиной).
    fn seen_key(parts: &[&[u8]]) -> Vec<u8> {
        let mut k = Vec::new();
        for p in parts {
            k.extend_from_slice(&(p.len() as u32).to_be_bytes());
            k.extend_from_slice(p);
        }
        k
    }

    fn file_op(n: u32, parent: &[u8]) -> CloudOp {
        let mut id = [0u8; 16];
        id[..4].copy_from_slice(&n.to_be_bytes());
        let blob = CloudBlobRef {
            file_id: format!("f{n:08x}"),
            key: vec![1; 32],
            size: 1000,
            chunks: 1,
            mime: "image/jpeg".into(),
            sha256: vec![2; 32],
            nonce: vec![3; 12],
            capability: vec![4; 32],
            uploader: "alice@local".into(),
        };
        CloudOp {
            op: Some(cloud_op::Op::Create(CloudCreate {
                node_id: id.to_vec(),
                kind: CloudNodeKind::File as i32,
                parent_id: parent.to_vec(),
                name: format!("Фото {n}.jpg"),
                stamp: Some(crate::domain::Stamp::new(n as u64 + 1, "d1").to_pb()),
                blob: Some(blob),
                mtime_ms: 1_700_000_000_000 + n as u64,
                ..Default::default()
            })),
        }
    }

    /// A1(в): синтетика — 10 000 сообщений (6 000 личных, 4 000 групповых) и
    /// облако из 3 000 узлов, из которых 1 000 стёрты. Печатает размер экспорта
    /// по слоям; проверяет потолок.
    #[test]
    fn export_size_on_synthetic_state() {
        use msg::SeenStore;
        let mut c = Client::new("alice@local", "d1", "local").unwrap();
        let _ = c.create_identity(2).unwrap();
        let key = [5u8; 32];
        let base = c.export(&key).unwrap().len();

        let now = now_ms();
        for i in 0u32..6_000 {
            let mut op_id = [0u8; 16];
            op_id[..4].copy_from_slice(&i.to_be_bytes());
            let k = seen_key(&[b"bob@local", b"desktop-0123456789ab", &op_id]);
            let mut s = SeenAdapter { c: &mut c.seen, list: &mut c.seen_list };
            s.insert_once(&k).unwrap();
        }
        let sid = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
        for i in 0u32..4_000 {
            let mut op_id = [0u8; 16];
            op_id[..4].copy_from_slice(&(i | 0x8000_0000).to_be_bytes());
            let mut s = SeenAdapter { c: &mut c.seen, list: &mut c.seen_list };
            s.insert_once(&seen_key(&[b"megolm", sid.as_bytes(), &(i as u32).to_be_bytes()])).unwrap();
            s.insert_once(&seen_key(&[b"carol@local", b"web-0123456789abcdef", &op_id])).unwrap();
        }
        let _ = now;
        let with_seen = c.export(&key).unwrap().len();

        let (id, _) = c.cloud_create(1_700_000_000_000).unwrap();
        {
            let st = &mut c.cloud.get_mut(&id).unwrap().state;
            for n in 0u32..3_000 {
                st.apply(&file_op(n, &[])).unwrap();
            }
            for n in 0u32..1_000 {
                let mut nid = [0u8; 16];
                nid[..4].copy_from_slice(&n.to_be_bytes());
                // Половина надгробий старше 90 дней, половина свежие.
                let at = if n % 2 == 0 { 1_600_000_000_000 } else { (now_ms() as u64).saturating_sub(1000) };
                st.apply(&CloudOp {
                    op: Some(cloud_op::Op::Purge(CloudPurge { node_id: nid.to_vec(), stamp: Some(crate::domain::Stamp::new(5000 + n as u64, "d1").to_pb()), at_ms: at })),
                })
                .unwrap();
            }
        }
        let with_cloud = c.export(&key).unwrap().len();
        eprintln!("export: base={base} +seen(10k msgs)={with_seen} (+{}) +cloud(3k/1k)={with_cloud} (+{})", with_seen - base, with_cloud - with_seen);
        // 14 000 отпечатков по 24 байта ≈ 450 КБ base64; узлы облака без 500 старых надгробий.
        assert!(with_seen - base < 480_000, "seen: {}", with_seen - base);
        assert!(with_cloud - with_seen < 760_000, "cloud: {}", with_cloud - with_seen);
        // Восстановление: дедупликация живёт, свежие надгробия на месте, старые ушли.
        let mut r = Client::import(&c.export(&key).unwrap(), &key).unwrap();
        let mut op_id = [0u8; 16];
        op_id[..4].copy_from_slice(&7u32.to_be_bytes());
        let k = seen_key(&[b"bob@local", b"desktop-0123456789ab", &op_id]);
        let mut s = SeenAdapter { c: &mut r.seen, list: &mut r.seen_list };
        assert_eq!(s.insert_once(&k).err(), Some(ProtoError::Duplicate));
        let tree: serde_json::Value = serde_json::from_str(&r.cloud_state_json(&id).unwrap()).unwrap();
        assert_eq!(tree["purgedBlobs"].as_array().unwrap().len(), 500, "свежие надгробия (≤ 90 дней) сохранены");
        assert_eq!(tree["nodes"].as_array().map(|n| n.len()).unwrap_or(0), 2_000);
    }

    /// Отпечаток старше окна в экспорт не попадает; в окне — попадает.
    #[test]
    fn seen_export_keeps_only_window() {
        use msg::SeenStore;
        let mut c = Client::new("alice@local", "d1", "local").unwrap();
        let _ = c.create_identity(2).unwrap();
        let fresh = seen_key(&[b"bob@local", b"d1", &[1u8; 16]]);
        let stale = seen_key(&[b"bob@local", b"d1", &[2u8; 16]]);
        SeenAdapter { c: &mut c.seen, list: &mut c.seen_list }.insert_once(&fresh).unwrap();
        SeenAdapter { c: &mut c.seen, list: &mut c.seen_list }.insert_once(&stale).unwrap();
        // Состарить вторую запись за окно.
        let old = now_ms() - SEEN_WINDOW_MS - 1;
        if let Some(e) = c.seen_list.iter_mut().find(|(h, _)| *h == seen_hash(&stale)) {
            e.1 = old;
        }
        let key = [3u8; 32];
        let mut r = Client::import(&c.export(&key).unwrap(), &key).unwrap();
        assert_eq!(r.seen_list.len(), 1);
        assert_eq!(SeenAdapter { c: &mut r.seen, list: &mut r.seen_list }.insert_once(&fresh).err(), Some(ProtoError::Duplicate));
        assert!(SeenAdapter { c: &mut r.seen, list: &mut r.seen_list }.insert_once(&stale).is_ok(), "за окном — забыт");
    }

    /// Экспорт прежнего формата (поле `seen` — сырые ключи base64) читается:
    /// ключи превращаются в отпечатки, дедупликация сохраняется.
    #[test]
    fn import_reads_legacy_seen_keys() {
        use msg::SeenStore;
        let c = {
            let mut c = Client::new("alice@local", "d1", "local").unwrap();
            let _ = c.create_identity(2).unwrap();
            c
        };
        let key = [4u8; 32];
        let blob = c.export(&key).unwrap();
        let json = ChaCha20Poly1305::new(Key::from_slice(&key))
            .decrypt(Nonce::from_slice(&blob[..12]), chacha20poly1305::aead::Payload { msg: &blob[12..], aad: b"parvane/v2/client-state" })
            .unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&json).unwrap();
        let raw = seen_key(&[b"bob@local", b"d1", &[9u8; 16]]);
        v["seen"] = serde_json::json!([base64::engine::general_purpose::STANDARD.encode(&raw)]);
        v.as_object_mut().unwrap().remove("seen_packed");
        let json = serde_json::to_vec(&v).unwrap();
        let nonce = [1u8; 12];
        let ct = ChaCha20Poly1305::new(Key::from_slice(&key))
            .encrypt(Nonce::from_slice(&nonce), chacha20poly1305::aead::Payload { msg: &json, aad: b"parvane/v2/client-state" })
            .unwrap();
        let mut old = nonce.to_vec();
        old.extend(ct);
        let mut r = Client::import(&old, &key).unwrap();
        assert_eq!(SeenAdapter { c: &mut r.seen, list: &mut r.seen_list }.insert_once(&raw).err(), Some(ProtoError::Duplicate));
        // Новый экспорт — уже отпечатком, и он переживает ещё один круг.
        let mut r2 = Client::import(&r.export(&key).unwrap(), &key).unwrap();
        assert_eq!(SeenAdapter { c: &mut r2.seen, list: &mut r2.seen_list }.insert_once(&raw).err(), Some(ProtoError::Duplicate));
    }
}

#[cfg(test)]
mod state_json_cache_tests {
    use super::*;
    use crate::pb::parvane::cloud::v1::{cloud_op, CloudCreate, CloudNodeKind, CloudOp};

    /// C1: JSON планировщика для хоста пересобирается только при смене
    /// ревизии состояния или `head_seq`.
    #[test]
    fn planner_state_json_is_cached_by_revision() {
        let mut c = Client::new("alice@local", "d1", "local").unwrap();
        let _ = c.create_identity(2).unwrap();
        c.planner_create(1_700_000_000_000).unwrap();
        let a = c.planner_state_json().unwrap();
        let key = c.planner.as_ref().unwrap().json_cache.key();
        assert!(key.is_some());
        assert_eq!(c.planner_state_json().unwrap(), a);
        assert_eq!(c.planner.as_ref().unwrap().json_cache.key(), key, "повторное чтение — из кэша");
        c.planner_prepare_local(r#"{"changes":[{"task":{"id":"t1","title":"Хлеб","day":"2026-10-01"}}]}"#).unwrap();
        let b = c.planner_state_json().unwrap();
        assert_ne!(a, b);
        assert_ne!(c.planner.as_ref().unwrap().json_cache.key(), key, "правка — новая ревизия");
        let key2 = c.planner.as_ref().unwrap().json_cache.key();
        c.planner.as_mut().unwrap().head_seq += 1;
        let d: serde_json::Value = serde_json::from_str(&c.planner_state_json().unwrap()).unwrap();
        assert_eq!(d["headSeq"], serde_json::json!(1));
        assert_ne!(c.planner.as_ref().unwrap().json_cache.key(), key2, "сдвиг курсора — новая строка");
    }

    /// C1/A8: JSON дерева облака — та же строка, пока дерево не менялось.
    #[test]
    fn cloud_state_json_is_cached_by_revision() {
        let mut c = Client::new("alice@local", "d1", "local").unwrap();
        let _ = c.create_identity(2).unwrap();
        let (id, _) = c.cloud_create(1_700_000_000_000).unwrap();
        let a = c.cloud_state_json(&id).unwrap();
        let key = c.cloud[&id].json_cache.key();
        assert_eq!(c.cloud_state_json(&id).unwrap(), a);
        assert_eq!(c.cloud[&id].json_cache.key(), key);
        let op = CloudOp {
            op: Some(cloud_op::Op::Create(CloudCreate {
                node_id: vec![9; 16],
                kind: CloudNodeKind::Folder as i32,
                name: "Документы".into(),
                stamp: Some(crate::domain::Stamp::new(1, "d1").to_pb()),
                ..Default::default()
            })),
        };
        c.cloud.get_mut(&id).unwrap().state.apply(&op).unwrap();
        let b = c.cloud_state_json(&id).unwrap();
        assert_ne!(a, b);
        assert_ne!(c.cloud[&id].json_cache.key(), key);
        assert!(b.contains("Документы"));
    }
}

// Контейнер планировщика (spec 010) — отдельный файл той же области видимости.
include!("client_planner.rs");
include!("client_cloud.rs");
include!("client_rename.rs");
