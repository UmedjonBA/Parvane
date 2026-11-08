//! Модель движка (spec 035, contracts/engine-api.md, FR-001…FR-007): хост подаёт намерения и ввод сервера,
//! движок сам ведёт личное состояние, историю, группы, домены и отдаёт изменения модели (`ModelDelta`) и
//! представления, уже готовые к показу. Ввод-вывод — sans-IO: движок не вызывает хост, а возвращает в
//! `Outcome` пачку хранилища (`store_batch`), чтения (`store_reads`) и запросы серверу (`requests`).
//!
//! Порядок «на диске раньше» (SYNC-1, T064): хост MUST зафиксировать `store_batch` до отправки `requests`
//! того же итога; подтверждение инбокса (`msg.inbox.ack`) движок выпускает только после `storeCommitted` той
//! пачки, в которой лежит применённое. Неподтверждённое сервер отдаст повторно — повтор сводится без следа.
//!
//! Слой поверх `client.rs`: шифрование, журналы устройств и групп, эпохи — `Client`; строки истории — `history.rs`
//! (`RowState`, HIST-1); личное состояние — `state2.rs`; хранилище — `store.rs`. Таблицы, на которые опирается
//! хранилище и `engineInfo()`: `store_kinds`, `features`.
//!
//! Упрощения этой фазы (помечены `T066+`): весь профиль читается при открытии (потолок памяти
//! `memory_budget_bytes` пока не соблюдается, `historyPage.pending` не выдаётся); контрольные точки журнала
//! истории строят прежние клиентские пути; голоса опросов не сводятся в `ViewPoll.votes`.

pub mod capabilities;
pub mod client_core;
pub mod delta;
pub mod features;
pub mod intent;
pub mod journal;
pub mod migration;
pub mod paging;
pub mod state_v1;
pub mod store_kinds;
pub mod views;

use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};

use prost::Message;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::client::{Chan, Client, ClientError, Event, Need};
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::history::{self, HistorySession};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{Ref, UserRef};
use crate::pb::parvane::engine::v1 as epb;
use crate::pb::parvane::engine::v1::{
    model_change::Change, ChatAnchor, ChatListRequest, ChatPage, ChatView, Delivery, Disposition, EngineConfig, HistoryPage,
    HistoryPageRequest, MessageRemove, MessageView, ModelDelta, OpenResult, OpenState, Outcome, PageDirection, RequestChannel,
    ServerInputKind, StateChanged, StateObjectView, StateView, StoreBatch, StoreLoaded, StoreReads, UnreadChanged,
    ViewReaction, ViewText,
};
use crate::pb::parvane::history::v1::{history_op::Op as HOp, HistoryOp, ReadMark, RowState};
use crate::pb::parvane::msg::v2::Content;
use crate::pb::parvane::state::v1::{peer, Peer};
use crate::pb::parvane::state::v2::{self as s2, ObjectKey, ObjectKind};
use crate::state2::State2;
use crate::store::{self, Store};

use capabilities::GroupFacts;
use delta::DeltaBuilder;
use paging::{ChatRows, Id, Row};

/// Окно пачки журнала истории (HIST-1 п. 5, S7-3): 30–120 с после первого события в очереди.
pub const HISTORY_BATCH_MIN_MS: i64 = 30_000;
pub const HISTORY_BATCH_MAX_MS: i64 = 120_000;
/// Опрос журналов (HIST-1 п. 5): раз в 60 с.
pub const POLL_MS: i64 = 60_000;
/// Номеров записей в одном `history.get` (как `GetRequest.seqs` max_items).
const HISTORY_GET_BATCH: usize = 256;
/// Сколько прекеев публиковать при создании личности.
pub const OTK_COUNT: usize = 50;

/// Имя записи ядра (`engine-core`).
const CORE_CLIENT: &str = "client";
const CORE_META: &str = "meta";
const STATE_SNAPSHOT: &str = "snapshot";

/// Зачем отправлен запрос (ответ приходит `ingest{RESPONSE, req_id}`).
#[derive(Debug, Clone)]
pub(crate) enum Purpose {
    /// Копия сообщения/мутации из исходящей очереди.
    Deliver(Id),
    PeerLog(String),
    Bundle(String),
    InboxSync,
    InboxAck,
    GroupSync { group: Ref, join: Option<crate::pb::parvane::group::v2::InviteLinkParts> },
    InviteCheck(crate::pb::parvane::group::v2::InviteLinkParts),
    StateAppend(Vec<u8>),
    StateSync,
    HistoryAppend,
    HistorySync,
    /// spec 035 (T068, HIST-2): вход нового устройства — голова журнала истории и его точка.
    HistoryHead,
    /// Сводка точки (`history.get [summary_seq]`).
    HistorySummary(crate::pb::parvane::history::v1::Checkpoint),
    /// Сегменты точки пачками (`history.get`): текущая пачка ушла, `rest` — дальше; `expect` — op_id по номерам.
    HistorySegments {
        cp: crate::pb::parvane::history::v1::Checkpoint,
        asked: Vec<u64>,
        rest: Vec<u64>,
        expect: BTreeMap<u64, Vec<u8>>,
    },
    /// Разовый перенос (spec 035, US1): чтение замороженного журнала `state.v1` и нового `state.v2`.
    MigrateV1Sync,
    MigrateV2Sync,
    Other,
}

/// Исходящее, ждущее отправки (вид записи хранилища `outbox`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OutboxItem {
    /// id операции (= id сообщения у строки).
    #[serde(with = "hexser")]
    pub op_id: Vec<u8>,
    /// Чат: `Peer` в байтах.
    #[serde(with = "hexser")]
    pub chat: Vec<u8>,
    /// `Content` в байтах; пусто у квитанции.
    #[serde(with = "hexser")]
    pub content: Vec<u8>,
    /// Квитанция прочтения: id сообщений (hex).
    #[serde(default)]
    pub receipt: Vec<String>,
    /// Строка ленты (своё сообщение) — у неё меняется доставка.
    #[serde(default)]
    pub row: bool,
    #[serde(skip)]
    pub inflight: u32,
    #[serde(skip)]
    pub waiting: bool,
}

mod hexser {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(s).map_err(serde::de::Error::custom)
    }
}

/// Мелкое состояние ядра (`engine-core/meta`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Meta {
    #[serde(default)]
    state_cursor: u64,
    #[serde(default)]
    history_cursor: u64,
    /// spec 035 (T068): id контрольной точки журнала истории, по которой вошло устройство (0 — не входило).
    #[serde(default)]
    history_checkpoint: u64,
    /// Голова журнала истории спрошена (вход нового устройства пройден: по точке либо журнал без точки).
    #[serde(default)]
    history_bootstrapped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    New,
    AwaitRoot(u64),
    AwaitRecords(u64),
    Open,
}

/// Что изменилось в этом вызове и должно попасть в пачку хранилища.
#[derive(Debug, Default)]
pub(crate) struct Dirty {
    pub client: bool,
    pub meta: bool,
    pub state: bool,
    pub rows: BTreeSet<(String, Id)>,
    pub rows_gone: BTreeSet<(String, Id)>,
    pub marks: BTreeSet<String>,
    pub outbox: BTreeSet<Id>,
    pub outbox_gone: BTreeSet<Id>,
    pub state_raw: BTreeMap<String, Option<Vec<u8>>>,
    /// Чаты, чьи представления пересчитать в конце вызова.
    pub chats: BTreeSet<String>,
    /// Подтверждение инбокса выпустить после фиксации пачки.
    pub ack: bool,
    /// Прочие записи (вид, имя, открытый текст): ход переноса, карантин, старое исходящее.
    pub extra: Vec<(String, String, Vec<u8>)>,
}

/// Работа одного вызова.
#[derive(Debug, Default)]
pub(crate) struct Work {
    pub delta: DeltaBuilder,
    pub requests: Vec<(epb::OutRequest, Purpose)>,
    pub reads: Vec<StoreReads>,
    pub open: Option<OpenResult>,
}

/// Движок модели одного профиля.
pub struct Engine {
    pub(crate) cfg: EngineConfig,
    pub(crate) features: BTreeSet<String>,
    pub(crate) now_ms: i64,
    stage: Stage,
    open_state: OpenState,
    store: Option<Store>,
    pub(crate) client: Option<Client>,
    pub(crate) chats: BTreeMap<String, ChatRows>,
    pub(crate) peers: BTreeMap<String, Peer>,
    pub(crate) marks: BTreeMap<String, ReadMark>,
    chat_shown: BTreeMap<String, u64>,
    unread_shown: BTreeMap<String, u32>,
    pub(crate) state: State2,
    meta: Meta,
    pub(crate) groups: BTreeMap<Vec<u8>, GroupFacts>,
    pub(crate) outbox: BTreeMap<Id, OutboxItem>,
    pending_inbox: Vec<Vec<u8>>,
    /// Запросы, которые выпускаются только после фиксации пачки (`batch_id` → запросы).
    held: BTreeMap<u64, Vec<(epb::OutRequest, Purpose)>>,
    inflight: BTreeMap<u64, Purpose>,
    /// Ключи нужд, по которым запрос уже в пути (не дублировать).
    needs_inflight: BTreeSet<String>,
    pub(crate) history_queue: Vec<HistoryOp>,
    history_due_ms: Option<i64>,
    history_session: Option<HistorySession>,
    next_poll_ms: i64,
    revision: u64,
    next_req: u64,
    next_read: u64,
    pub(crate) dirty: Dirty,
    /// Пачка с корнем нового профиля — уходит вместе с первыми данными.
    pending_root: Option<StoreBatch>,
    /// Свои операции личного состояния, ещё не принятые сервером (вид `state-raw`, имя — hex op_id).
    pub(crate) state_unsent: BTreeMap<String, Vec<u8>>,
    /// Разовый перенос старых хранилищ (spec 035, US1): идёт — `Some`.
    pub(crate) migration: Option<Box<migration::MigrationRun>>,
    /// Ход переноса с диска (`migration-progress/legacy`).
    pub(crate) migration_progress: Option<migration::Progress>,
    /// Своё исходящее прежней версии, не ставшее строкой истории (`outbox/legacy`, JSON как лежало).
    pub(crate) legacy_outbox: Vec<Value>,
    /// Корень личности после createIdentity/importRootBackup — только в памяти (C1-06), `clientCall`.
    pub(crate) root: Option<zeroize::Zeroizing<[u8; 32]>>,
    /// Подготовленная смена ника (spec 026) до ответа сервера, `clientCall`.
    pub(crate) rename_plan: Option<crate::client::RenamePlan>,
    /// Режим хоста: страница журнала инбокса кончилась на ждущих записях — следующая после `retry`.
    pub(crate) inbox_more: bool,
}

fn now_or(ms: i64) -> i64 {
    ms
}

/// Отпечаток сообщения для сравнения «показ изменился».
fn fingerprint<M: Message>(m: &M) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    m.encode_to_vec().hash(&mut h);
    h.finish()
}

pub(crate) fn user_peer(address: &str) -> Peer {
    Peer { kind: Some(peer::Kind::User(UserRef { address: address.to_string() })) }
}

pub(crate) fn group_peer(group: &Ref) -> Peer {
    Peer { kind: Some(peer::Kind::Group(group.clone())) }
}

/// Ключ записи строки в хранилище.
fn row_name(chat: &str, id: &Id) -> String {
    format!("{chat}|{}", hex::encode(id))
}

fn encode_row(r: &Row) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&r.order.to_be_bytes());
    out.push(u8::from(r.hidden));
    out.extend_from_slice(&r.delivery.to_be_bytes());
    out.extend_from_slice(&r.state.encode_to_vec());
    out
}

fn decode_row(b: &[u8]) -> Result<Row> {
    if b.len() < 13 {
        return Err(ProtoError::Malformed);
    }
    let order = i64::from_be_bytes(b[0..8].try_into().map_err(|_| ProtoError::Malformed)?);
    let hidden = b[8] != 0;
    let delivery = i32::from_be_bytes(b[9..13].try_into().map_err(|_| ProtoError::Malformed)?);
    let state: RowState = decode_checked(&b[13..], Origin::Server)?;
    Ok(Row { order, state, hidden, delivery, shown: None, counted: false })
}

/// Разбить байты сообщения на поля верхнего уровня (номер → байты с тегом; повторы — подряд).
pub(crate) fn split_fields(mut b: &[u8]) -> Vec<s2::FieldValue> {
    let mut out: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    while !b.is_empty() {
        let start = b;
        let Ok((tag, wt)) = prost::encoding::decode_key(&mut b) else { break };
        let skipped = prost::encoding::skip_field(wt, tag, &mut b, prost::encoding::DecodeContext::default());
        if skipped.is_err() {
            break;
        }
        let used = start.len() - b.len();
        out.entry(tag).or_default().extend_from_slice(&start[..used]);
    }
    out.into_iter().map(|(field, value)| s2::FieldValue { field, value }).collect()
}

fn json_of<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| err_json(ProtoError::Malformed))
}

pub fn err_json(e: ProtoError) -> String {
    serde_json::json!({"error": e.kind()}).to_string()
}

fn parse<T: DeserializeOwned + Default>(args: &str) -> Result<T> {
    if args.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(args).map_err(|_| ProtoError::Malformed)
}

impl Engine {
    /// Открыть движок по конфигурации (без ввода-вывода; дальше — `start`).
    pub fn open(cfg: EngineConfig) -> Result<Engine> {
        if !crate::address::is_valid_address(&cfg.user) {
            return Err(ProtoError::BadAddress);
        }
        if !crate::address::is_valid_device_id(&cfg.device_id) {
            return Err(ProtoError::InvalidField("device_id"));
        }
        if !cfg.device_key.is_empty() && cfg.device_key.len() != 32 {
            return Err(ProtoError::InvalidField("device_key"));
        }
        if cfg.features.iter().any(|f| !features::is_valid(f)) {
            return Err(ProtoError::InvalidField("features"));
        }
        let features = cfg.features.iter().cloned().collect();
        let now_ms = now_or(cfg.now_ms);
        Ok(Engine {
            cfg,
            features,
            now_ms,
            stage: Stage::New,
            open_state: OpenState::Unspecified,
            store: None,
            client: None,
            chats: BTreeMap::new(),
            peers: BTreeMap::new(),
            marks: BTreeMap::new(),
            chat_shown: BTreeMap::new(),
            unread_shown: BTreeMap::new(),
            state: State2::new(),
            meta: Meta::default(),
            groups: BTreeMap::new(),
            outbox: BTreeMap::new(),
            pending_inbox: vec![],
            held: BTreeMap::new(),
            inflight: BTreeMap::new(),
            needs_inflight: BTreeSet::new(),
            history_queue: vec![],
            history_due_ms: None,
            history_session: None,
            next_poll_ms: 0,
            revision: 0,
            next_req: 1,
            next_read: 1,
            dirty: Dirty::default(),
            pending_root: None,
            state_unsent: BTreeMap::new(),
            migration: None,
            migration_progress: None,
            legacy_outbox: vec![],
            root: None,
            rename_plan: None,
            inbox_more: false,
        })
    }

    /// Открыть по JSON конфигурации (обвязки).
    pub fn open_json(config_json: &str) -> std::result::Result<Engine, String> {
        let cfg: EngineConfig = serde_json::from_str(config_json).map_err(|_| err_json(ProtoError::Malformed))?;
        Engine::open(cfg).map_err(err_json)
    }

    /// Вызов по имени: аргумент и результат — proto3-JSON типов `engine/v1/model.proto`; ошибка —
    /// `{"error": "<вид>"}`, незнакомое имя — `{"error": "UnknownCall"}`.
    pub fn call(&mut self, name: &str, args: &str) -> String {
        let r = match name {
            "start" => self.start().map(|o| json_of(&o)),
            "submit" => parse(args).and_then(|i| self.submit(i)).map(|o| json_of(&o)),
            "storeCommitted" => parse::<epb::StoreCommitted>(args).and_then(|a| self.store_committed(a.batch_id)).map(|o| json_of(&o)),
            "storeLoaded" => parse(args).and_then(|a| self.store_loaded(a)).map(|o| json_of(&o)),
            "ingest" => parse(args).and_then(|a| self.ingest(a)).map(|o| json_of(&o)),
            "tick" => parse::<epb::Tick>(args).and_then(|a| self.tick(a.now_ms)).map(|o| json_of(&o)),
            "unlockPin" => parse::<epb::UnlockPin>(args).and_then(|a| self.unlock_pin(&a.pin)).map(|o| json_of(&o)),
            "chatList" => parse(args).map(|a| json_of(&self.chat_list(&a))),
            "historyPage" => parse(args).and_then(|a| self.history_page(&a)).map(|p| json_of(&p)),
            "viewState" => parse(args).map(|a| json_of(&self.view_state(&a))),
            "viewGroup" => parse::<epb::ViewGroupRequest>(args).and_then(|a| self.view_group(a.group.as_ref())).map(|g| json_of(&g)),
            "capabilities" => parse::<epb::CapabilitiesRequest>(args).and_then(|a| self.capabilities(a.chat.as_ref())).map(|c| json_of(&c)),
            "contentHidden" => self.content_hidden(args).map(|h| serde_json::json!({"hidden": h}).to_string()),
            "engineInfo" => Ok(crate::engine_info_json()),
            "clientCall" | "historyCall" => {
                let a: epb::ClientCall = match parse(args) {
                    Ok(a) => a,
                    Err(e) => return err_json(e),
                };
                let r = if name == "clientCall" { self.client_call(a) } else { self.history_call(a) };
                return match r {
                    Ok(result_json) => json_of(&epb::CallResult { result_json }),
                    Err(e) => e,
                };
            }
            "clientReplace" => parse(args).and_then(|a| self.client_replace(a)).map(|_| "{}".to_string()),
            "flush" => self.flush().map(|o| json_of(&o)),
            "stateViewV1" => Ok(self.state_view_v1().to_string()),
            "stateApplyV1" => parse::<state_v1::ApplyV1>(args).and_then(|a| self.state_apply_v1(a)).map(|o| json_of(&o)),
            "migrateStep" => parse(args).and_then(|a| self.migrate_step(a)).map(|o| json_of(&o)),
            "migrateFinish" => self.migrate_finish().map(|o| json_of(&o)),
            "migrateStatus" => Ok(json_of(&self.migrate_status())),
            "auditDump" => Ok(json_of(&epb::AuditDump { jsonl: self.audit_dump() })),
            "vectorInput" if self.cfg.vectors => self.vector_input(args).map(|o| json_of(&o)),
            _ => return serde_json::json!({"error": "UnknownCall"}).to_string(),
        };
        r.unwrap_or_else(err_json)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn open_state(&self) -> OpenState {
        self.open_state
    }

    pub(crate) fn selves(&self) -> Vec<String> {
        let mut v = vec![self.cfg.user.clone()];
        if let Some(c) = &self.client {
            v.extend(c.state_former_addresses());
        }
        v
    }

    pub(crate) fn has_feature(&self, f: &str) -> bool {
        self.features.contains(f)
    }

    fn inner_key(&self) -> [u8; 32] {
        // Конфиденциальность записи ядра даёт AEAD хранилища (DEK); внутренний ключ экспорта клиента лишь
        // привязывает его к профилю.
        let id = self.store.as_ref().map(|s| s.root().store_id.clone()).unwrap_or_default();
        Sha256::new().chain_update(b"parvane/engine-core/v1\0").chain_update(&id).finalize().into()
    }

    pub(crate) fn writable(&self) -> Result<()> {
        match self.open_state {
            OpenState::Ready => Ok(()),
            OpenState::TooNew => Err(ProtoError::WriteBlocked),
            OpenState::Locked => Err(ProtoError::Locked),
            _ => Err(ProtoError::NotFound),
        }
    }

    pub(crate) fn req_id(&mut self) -> u64 {
        let id = self.next_req;
        self.next_req += 1;
        id
    }

    /// Запрос клиента → запрос хоста (с целью).
    pub(crate) fn push_req(&mut self, w: &mut Work, r: crate::client::OutRequest, p: Purpose) {
        let dest = crate::routing::dest_of(&r).filter(|d| !d.eq_ignore_ascii_case(&self.cfg.domain)).unwrap_or_default();
        let req = epb::OutRequest {
            req_id: self.req_id(),
            method: r.method.to_string(),
            channel: match r.chan {
                Chan::Id => RequestChannel::Id,
                Chan::Anon => RequestChannel::Anon,
            } as i32,
            body: r.body,
            deadline_ms: 0,
            dest_domain: dest,
        };
        w.requests.push((req, p));
    }

    fn id_req(method: &'static str, m: &impl Message) -> crate::client::OutRequest {
        crate::client::OutRequest { chan: Chan::Id, method, body: m.encode_to_vec(), dest: None }
    }

    fn anon_req(method: &'static str, m: &impl Message) -> crate::client::OutRequest {
        crate::client::OutRequest { chan: Chan::Anon, method, body: m.encode_to_vec(), dest: None }
    }

    // ── жизненный цикл ─────────────────────────────────────────────────────────

    /// Начать открытие: прочитать корень профиля.
    pub fn start(&mut self) -> Result<Outcome> {
        let mut w = Work::default();
        let id = self.next_read;
        self.next_read += 1;
        w.reads.push(StoreReads { read_id: id, keys: vec![store::ROOT_KEY.to_string()], ..Default::default() });
        self.stage = Stage::AwaitRoot(id);
        self.finish(w)
    }

    pub fn store_loaded(&mut self, l: StoreLoaded) -> Result<Outcome> {
        let mut w = Work::default();
        match self.stage {
            Stage::AwaitRoot(id) if id == l.read_id => self.root_loaded(&l, &mut w)?,
            Stage::AwaitRecords(id) if id == l.read_id => self.records_loaded(&l, &mut w)?,
            _ => return Err(ProtoError::ContextMismatch),
        }
        self.finish(w)
    }

    fn root_loaded(&mut self, l: &StoreLoaded, w: &mut Work) -> Result<()> {
        let root = l.entries.iter().find(|e| e.key == store::ROOT_KEY);
        let Some(root) = root else {
            if self.cfg.legacy_present {
                // Старые хранилища есть, нового ещё нет: разовый перенос (`migrateStep`), до него — ничего не пишем.
                self.open_state = OpenState::MigrationNeeded;
                self.stage = Stage::Open;
                w.open = Some(OpenResult { state: OpenState::MigrationNeeded as i32, migration: Some(migration::plan(None)) });
                return Ok(());
            }
            // Новый профиль: корень, DEK поколения 1, обёртка ключом устройства.
            let mut st = Store::create();
            let key: [u8; 32] = self.cfg.device_key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("device_key"))?;
            let batch = st.wrap_device(&key)?;
            self.store = Some(st);
            self.client = Some(Client::new(&self.cfg.user, &self.cfg.device_id, &self.cfg.domain)?);
            if self.cfg.vectors {
                self.ensure_state_key();
            }
            self.open_state = OpenState::Ready;
            self.stage = Stage::Open;
            self.dirty.client = true;
            self.dirty.meta = true;
            self.pending_root = Some(batch);
            w.open = Some(OpenResult { state: OpenState::Ready as i32, migration: None });
            return Ok(());
        };
        let mut st = Store::load(&root.value)?;
        let unlocked = match self.cfg.device_key.as_slice().try_into() {
            Ok(k) => st.unlock_device(&k).is_ok(),
            Err(_) => false,
        };
        let too_new = st.state() == store::OpenState::TooNew;
        let gen = st.root().active_generation;
        self.store = Some(st);
        if !unlocked {
            self.open_state = OpenState::Locked;
            self.stage = Stage::Open;
            w.open = Some(OpenResult { state: OpenState::Locked as i32, migration: None });
            return Ok(());
        }
        self.open_state = if too_new { OpenState::TooNew } else { OpenState::Ready };
        let id = self.next_read;
        self.next_read += 1;
        w.reads.push(StoreReads { read_id: id, prefix: format!("g{gen}/"), ..Default::default() });
        self.stage = Stage::AwaitRecords(id);
        Ok(())
    }

    /// PIN введён: открыть DEK и дочитать профиль.
    pub fn unlock_pin(&mut self, pin: &str) -> Result<Outcome> {
        let mut w = Work::default();
        let st = self.store.as_mut().ok_or(ProtoError::NotFound)?;
        st.unlock_pin(pin)?;
        self.open_state = if st.state() == store::OpenState::TooNew { OpenState::TooNew } else { OpenState::Ready };
        let gen = st.root().active_generation;
        let id = self.next_read;
        self.next_read += 1;
        w.reads.push(StoreReads { read_id: id, prefix: format!("g{gen}/"), ..Default::default() });
        self.stage = Stage::AwaitRecords(id);
        self.finish(w)
    }

    fn records_loaded(&mut self, l: &StoreLoaded, w: &mut Work) -> Result<()> {
        let st = self.store.as_ref().ok_or(ProtoError::NotFound)?;
        let mut client_blob = None;
        let mut rows = vec![];
        for e in &l.entries {
            let Some((_, kind, name)) = store::parse_key(&e.key) else { continue };
            let plain = match st.open(&e.key, &e.value) {
                Ok(p) => p,
                // Неизвестный формат/вид — не трогаем (TOO_NEW: только известное)
                Err(ProtoError::TooNew) => continue,
                Err(e) => return Err(e),
            };
            match (kind, name) {
                ("engine-core", CORE_CLIENT) => client_blob = Some(plain),
                ("engine-core", CORE_META) => self.meta = serde_json::from_slice(&plain).unwrap_or_default(),
                ("state-object", STATE_SNAPSHOT) => self.state = State2::from_snapshot_bytes(&plain)?,
                ("history-row", n) => {
                    if let Some((chat, _)) = n.split_once('|') {
                        rows.push((chat.to_string(), decode_row(&plain)?));
                    }
                }
                ("history-mark", chat) => {
                    let m: ReadMark = decode_checked(&plain, Origin::Server)?;
                    if let Some(p) = &m.chat {
                        self.peers.entry(chat.to_string()).or_insert_with(|| p.clone());
                    }
                    self.marks.insert(chat.to_string(), m);
                }
                ("migration-progress", migration::PROGRESS_NAME) => self.migration_progress = migration::Progress::from_bytes(&plain),
                ("outbox", migration::LEGACY_OUTBOX) => self.legacy_outbox = serde_json::from_slice(&plain).unwrap_or_default(),
                ("outbox", _) => {
                    if let Ok(item) = serde_json::from_slice::<OutboxItem>(&plain) {
                        if let Some(id) = paging::id16(&item.op_id) {
                            self.outbox.insert(id, item);
                        }
                    }
                }
                ("state-raw", n) => {
                    self.state_unsent.insert(n.to_string(), plain);
                }
                _ => {}
            }
        }
        let key = self.inner_key();
        self.client = Some(match client_blob {
            Some(b) => Client::import(&b, &key)?,
            None => {
                self.dirty.client = true;
                Client::new(&self.cfg.user, &self.cfg.device_id, &self.cfg.domain)?
            }
        });
        if self.cfg.vectors {
            self.ensure_state_key();
        }
        let selves = self.selves();
        let sv: Vec<&str> = selves.iter().map(String::as_str).collect();
        for (chat, mut row) in rows {
            let Some(id) = paging::id16(&row.state.target) else { continue };
            row.counted = history::is_unread(&row.state, None, &sv).unwrap_or(false);
            if let Some(p) = &row.state.chat {
                self.peers.entry(chat.clone()).or_insert_with(|| p.clone());
            }
            self.chats.entry(chat.clone()).or_default().put(id, row);
            self.dirty.chats.insert(chat);
        }
        self.refresh_groups(w, true);
        self.stage = Stage::Open;
        if let Some(plan) = migration::plan_after_open(self.migration_progress.as_ref(), self.cfg.legacy_present) {
            // Перенос прерван до переключения: начать заново (перенос идемпотентен), до этого не писать
            if self.open_state == OpenState::Ready && plan.0 {
                self.open_state = OpenState::MigrationNeeded;
            }
            w.open = Some(OpenResult { state: self.open_state as i32, migration: Some(plan.1) });
        } else {
            w.open = Some(OpenResult { state: self.open_state as i32, migration: None });
        }
        // Неотправленное до перезапуска — снова в путь
        let ids: Vec<Id> = self.outbox.keys().copied().collect();
        for id in ids {
            self.flush_outbox(&id, w);
        }
        let unsent: Vec<(String, Vec<u8>)> = self.state_unsent.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (op_hex, pt) in unsent {
            self.send_state_raw(&op_hex, &pt, w);
        }
        // FR-071: открытое фото частной группы, которое ещё не перезалито (перенос прерван после нужды, хост закрыт
        // до перезалива), — нужда снова при каждом открытии; хост сверяет журнал группы перед перезаливом
        if self.open_state == OpenState::Ready {
            self.avatar_reupload_needs(w);
        }
        Ok(())
    }

    pub(crate) fn ensure_state_key(&mut self) {
        if let Some(c) = &mut self.client {
            if c.state_key().is_none() {
                c.set_state_key(crate::state::StateKey::generate(), 1);
                self.dirty.client = true;
            }
        }
        self.history_session = None;
    }

    pub(crate) fn history_session(&mut self) -> Option<&HistorySession> {
        if self.history_session.is_none() {
            let c = self.client.as_ref()?;
            let keys = c.state_keys_all();
            if keys.is_empty() {
                return None;
            }
            self.history_session = HistorySession::new(&c.user, &c.state_former_addresses(), &c.device_id, &keys).ok();
        }
        self.history_session.as_ref()
    }

    /// Хост зафиксировал пачку: выпустить зависевшие от неё запросы (подтверждение инбокса).
    pub fn store_committed(&mut self, batch_id: u64) -> Result<Outcome> {
        if let Some(st) = &mut self.store {
            st.committed(batch_id)?;
        }
        let mut w = Work::default();
        if let Some(reqs) = self.held.remove(&batch_id) {
            w.requests.extend(reqs);
        }
        self.finish(w)
    }

    // ── сборка итога ───────────────────────────────────────────────────────────

    /// Закрыть вызов: пересчитать представления чатов, собрать пачку, отложить подтверждения.
    pub(crate) fn finish(&mut self, mut w: Work) -> Result<Outcome> {
        self.refresh_chats(&mut w.delta);
        let ack = std::mem::take(&mut self.dirty.ack);
        let batch = self.build_batch()?;
        if ack {
            if let Some(c) = &self.client {
                let r = c.ack_request();
                self.push_req(&mut w, r, Purpose::InboxAck);
            }
        }
        let requests = std::mem::take(&mut w.requests);
        let (later, mut out_reqs): (Vec<_>, Vec<_>) = requests.into_iter().partition(|(_, p)| matches!(p, Purpose::InboxAck));
        match &batch {
            // Подтверждение инбокса — только после фиксации пачки с применённым (SYNC-1)
            Some(b) if !later.is_empty() => self.held.entry(b.batch_id).or_default().extend(later),
            _ => out_reqs.extend(later),
        }
        for (r, p) in &out_reqs {
            self.inflight.insert(r.req_id, p.clone());
        }
        let delta: Option<ModelDelta> = std::mem::take(&mut w.delta).finish(&mut self.revision);
        Ok(Outcome {
            store_batch: batch,
            store_reads: w.reads,
            requests: out_reqs.into_iter().map(|(r, _)| r).collect(),
            delta,
            open: w.open,
        })
    }

    fn build_batch(&mut self) -> Result<Option<StoreBatch>> {
        let d = std::mem::take(&mut self.dirty);
        let root = self.pending_root.take();
        let Some(st) = &self.store else { return Ok(root) };
        if !matches!(self.open_state, OpenState::Ready | OpenState::MigrationNeeded) {
            return Ok(root);
        }
        let mut puts: Vec<(String, String, Vec<u8>)> = vec![];
        let mut deletes: Vec<(String, String)> = vec![];
        if d.client {
            if let Some(c) = &self.client {
                puts.push(("engine-core".into(), CORE_CLIENT.into(), c.export(&self.inner_key())?));
            }
        }
        if d.meta {
            puts.push(("engine-core".into(), CORE_META.into(), serde_json::to_vec(&self.meta).unwrap_or_default()));
        }
        if d.state {
            puts.push(("state-object".into(), STATE_SNAPSHOT.into(), self.state.snapshot_bytes()));
        }
        for (k, v) in d.state_raw {
            match v {
                Some(pt) => puts.push(("state-raw".into(), k, pt)),
                None => deletes.push(("state-raw".into(), k)),
            }
        }
        for (chat, id) in &d.rows {
            if let Some(r) = self.chats.get(chat).and_then(|c| c.get(id)) {
                puts.push(("history-row".into(), row_name(chat, id), encode_row(r)));
            }
        }
        for (chat, id) in &d.rows_gone {
            if !d.rows.contains(&(chat.clone(), *id)) {
                deletes.push(("history-row".into(), row_name(chat, id)));
            }
        }
        for chat in &d.marks {
            if let Some(m) = self.marks.get(chat) {
                puts.push(("history-mark".into(), chat.clone(), m.encode_to_vec()));
            }
        }
        for id in &d.outbox {
            if let Some(o) = self.outbox.get(id) {
                puts.push(("outbox".into(), hex::encode(id), serde_json::to_vec(o).unwrap_or_default()));
            }
        }
        for id in &d.outbox_gone {
            if !self.outbox.contains_key(id) {
                deletes.push(("outbox".into(), hex::encode(id)));
            }
        }
        puts.extend(d.extra);
        let _ = st;
        if puts.is_empty() && deletes.is_empty() {
            return Ok(root);
        }
        let st = self.store.as_mut().ok_or(ProtoError::NotFound)?;
        let p: Vec<(&str, &str, &[u8])> = puts.iter().map(|(k, n, v)| (k.as_str(), n.as_str(), v.as_slice())).collect();
        let dl: Vec<(&str, &str)> = deletes.iter().map(|(k, n)| (k.as_str(), n.as_str())).collect();
        let mut b = st.write(&p, &dl)?;
        if let Some(mut r) = root {
            // Корень нового профиля — в той же транзакции, первым
            r.puts.append(&mut b.puts);
            r.deletes.append(&mut b.deletes);
            b = r;
        }
        Ok(Some(b))
    }

    // ── представления ─────────────────────────────────────────────────────────

    pub(crate) fn message_view(&self, chat_key: &str, row: &Row) -> Option<MessageView> {
        if !row.visible() {
            return None;
        }
        let v = history::view(&row.state).ok()?;
        let r = row.state.row.as_ref()?;
        let body = v.get("body").and_then(Value::as_object).cloned().unwrap_or_default();
        let content = views::effective_content(&body).unwrap_or_default();
        let kind = content.get("kind").and_then(Value::as_str).unwrap_or("");
        let disposition = match kind {
            "unsupported" if content.get("critical").and_then(Value::as_bool) == Some(true) => Disposition::StubCritical,
            "unsupported" | "" => Disposition::Stub,
            _ => Disposition::Show,
        };
        let has = |f: &str| self.has_feature(f);
        let body_view = if disposition == Disposition::Show { views::wire_to_body(&content, &has) } else { None };
        if disposition == Disposition::Show && body_view.is_none() {
            // Не показывается (голос/закрытие опроса и прочее служебное в ленте)
            return None;
        }
        let selves = self.selves();
        let outgoing = selves.contains(&r.from);
        let reactions = match v.get("reactions") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| ViewReaction {
                    emoji: x.get("emoji").and_then(Value::as_str).unwrap_or("").to_string(),
                    count: x.get("count").and_then(Value::as_u64).unwrap_or(0) as u32,
                    mine: x.get("users").and_then(Value::as_array).is_some_and(|u| u.iter().any(|u| u.as_str().is_some_and(|u| selves.iter().any(|s| s == u)))),
                })
                .collect(),
            _ => vec![],
        };
        let str_of = |k: &str| content.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let reply_quote = content.get("reply_quote").and_then(Value::as_object).map(|q| ViewText {
            text: q.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            entities: vec![],
        });
        let _ = chat_key;
        Some(MessageView {
            id: row.state.target.clone(),
            chat: row.state.chat.clone(),
            from: r.from.clone(),
            ts_ms: r.ts_ms,
            edited_ts_ms: v.get("editTsMs").and_then(Value::as_i64).unwrap_or(0),
            outgoing,
            disposition: disposition as i32,
            body: body_view,
            reply_to: views::body_reply_to(&body),
            forward_from: str_of("forwarded_from"),
            reactions,
            pinned: v.get("pinned").and_then(Value::as_bool).unwrap_or(false),
            ttl_secs: content.get("ttl_secs").and_then(Value::as_u64).unwrap_or(0) as u32,
            delivery: if outgoing { row.delivery } else { Delivery::Unspecified as i32 },
            forward_name: str_of("forwarded_name"),
            reply_quote,
            silent: content.get("silent").and_then(Value::as_bool).unwrap_or(false),
            order: row.order,
        })
    }

    /// Пересчитать показ строки: `messageUpsert`, если представление изменилось; `messageRemove`, если строка
    /// была показана и больше не видна.
    pub(crate) fn refresh_row(&mut self, chat: &str, id: &Id, d: &mut DeltaBuilder) {
        let Some(row) = self.chats.get(chat).and_then(|c| c.get(id)) else { return };
        let view = self.message_view(chat, row);
        let fp = view.as_ref().map(fingerprint);
        let prev = row.shown;
        let peer = row.state.chat.clone().or_else(|| self.peers.get(chat).cloned());
        if fp == prev {
            return;
        }
        match view {
            Some(v) => d.push(Change::MessageUpsert(v)),
            None => {
                if prev.is_some() {
                    d.push(Change::MessageRemove(MessageRemove { chat: peer, id: id.to_vec() }));
                }
            }
        }
        if let Some(r) = self.chats.get_mut(chat).and_then(|c| c.get_mut(id)) {
            r.shown = fp;
        }
        self.dirty.chats.insert(chat.to_string());
    }

    fn unread_of(&self, chat: &str) -> u32 {
        let Some(rows) = self.chats.get(chat) else { return 0 };
        let mark = self.marks.get(chat);
        let after = |r: &Row| match (mark, &r.state.row) {
            (None, _) => true,
            (Some(m), Some(x)) => (x.ts_ms, x.id.as_slice()) > (m.up_to_ts_ms, m.up_to_id.as_slice()),
            (Some(_), None) => false,
        };
        // Решение «считается» — `history::is_unread` без маркера, кэш строки; маркер — сравнение (ts, id)
        rows.rows().filter(|r| r.visible() && r.counted && after(r)).count() as u32
    }

    pub(crate) fn chat_view(&self, chat: &str) -> Option<ChatView> {
        let peer = self.peers.get(chat)?.clone();
        let rows = self.chats.get(chat);
        let last = rows.and_then(|c| c.last_visible()).and_then(|r| self.message_view(chat, r));
        let title = match &peer.kind {
            Some(peer::Kind::User(u)) => u.address.clone(),
            Some(peer::Kind::Group(g)) => self.groups.get(&g.id).map(|f| f.title.clone()).unwrap_or_default(),
            None => String::new(),
        };
        let pk = crate::state::peer_key(&peer).unwrap_or_default();
        let archived = self.state.view_object(ObjectKind::Archive as i32, &pk).is_some();
        Some(ChatView {
            chat: Some(peer),
            title,
            photo: None,
            last,
            unread: self.unread_of(chat),
            mention: false,
            pinned_rank: 0,
            archived,
            muted_until_ms: 0,
            draft: String::new(),
            folder_ids: vec![],
        })
    }

    fn refresh_chats(&mut self, d: &mut DeltaBuilder) {
        let chats = std::mem::take(&mut self.dirty.chats);
        for chat in chats {
            let Some(v) = self.chat_view(&chat) else { continue };
            if v.last.is_none() && !self.chat_shown.contains_key(&chat) {
                continue;
            }
            let unread = v.unread;
            let peer = v.chat.clone();
            let fp = fingerprint(&v);
            if self.chat_shown.get(&chat) != Some(&fp) {
                self.chat_shown.insert(chat.clone(), fp);
                d.push(Change::ChatUpsert(v));
            }
            if self.unread_shown.get(&chat).copied().unwrap_or(0) != unread {
                self.unread_shown.insert(chat.clone(), unread);
                d.push(Change::UnreadChanged(UnreadChanged { chat: peer, count: unread, mention: false }));
            }
        }
    }

    /// Сведения групп из их журналов (GROUP-3) → `groupChanged`. Группа чужого сервера (FED-1, T078): вступили —
    /// `group.remote.subscribe` своему серверу, вышли или исключены — `group.remote.unsubscribe`. При открытии
    /// профиля (`initial`) подписки не трогаются — они уже на сервере.
    pub(crate) fn refresh_groups(&mut self, w: &mut Work, initial: bool) {
        let Some(c) = &self.client else { return };
        let mut changed = vec![];
        for id in c.group_ids() {
            let Some(s) = c.group_state(&id) else { continue };
            let f = GroupFacts::from_state(s, c.group_avatar_key(&id));
            let same = self.groups.get(&id).is_some_and(|g| g.version == f.version && g.avatar_key == f.avatar_key);
            if !same {
                changed.push((id, f));
            }
        }
        let me = self.cfg.user.clone();
        let member = |f: &GroupFacts| matches!(f.role(&me), epb::GroupRole::Owner | epb::GroupRole::Admin | epb::GroupRole::Member) && !f.deleted;
        for (id, f) in changed {
            if !initial && !f.group.domain.eq_ignore_ascii_case(&self.cfg.domain) {
                let was = self.groups.get(&id).is_some_and(|g| member(g));
                let now = member(&f);
                let req = crate::pb::parvane::group::v2::RemoteSubscribeRequest { group: Some(f.group.clone()) };
                if now && !was {
                    let r = Self::id_req("group.remote.subscribe", &req);
                    self.push_req(w, r, Purpose::Other);
                } else if was && !now {
                    let r = Self::id_req("group.remote.unsubscribe", &crate::pb::parvane::group::v2::RemoteUnsubscribeRequest { group: req.group });
                    self.push_req(w, r, Purpose::Other);
                }
            }
            if !initial {
                w.delta.push(Change::GroupChanged(f.view(&me)));
            }
            let key = format!("g:{}", hex::encode(&id));
            self.peers.entry(key.clone()).or_insert_with(|| group_peer(&f.group));
            self.dirty.chats.insert(key);
            self.groups.insert(id, f);
        }
    }

    // ── чтение ────────────────────────────────────────────────────────────────

    pub fn chat_list(&self, req: &ChatListRequest) -> ChatPage {
        let limit = (req.limit as usize).clamp(1, 200);
        let mut all: Vec<(i64, String)> = self
            .chats
            .iter()
            .filter_map(|(k, c)| c.last_visible().map(|r| (r.order, k.clone())))
            .collect();
        all.sort_by(|a, b| b.cmp(a));
        let after = req.after.as_ref().map(|a| (a.ts_ms, a.chat_key.clone()));
        let mut chats = vec![];
        let mut next = None;
        for (order, key) in all.into_iter().filter(|x| after.as_ref().is_none_or(|a| x < a)) {
            if chats.len() == limit {
                next = Some(ChatAnchor { ts_ms: order, chat_key: key });
                break;
            }
            if let Some(v) = self.chat_view(&key) {
                if req.folder == 1 && !v.archived {
                    continue;
                }
                chats.push(v);
            }
        }
        if next.is_some() {
            if let Some(last) = chats.last() {
                let key = last.chat.as_ref().and_then(|p| history::history_chat_key(p).ok()).unwrap_or_default();
                next = Some(ChatAnchor { ts_ms: last.last.as_ref().map(|m| m.order).unwrap_or(0), chat_key: key });
            }
        }
        ChatPage { chats, next }
    }

    pub fn history_page(&self, req: &HistoryPageRequest) -> Result<HistoryPage> {
        let peer = req.chat.as_ref().ok_or(ProtoError::InvalidField("chat"))?;
        let chat = history::history_chat_key(peer)?;
        let Some(rows) = self.chats.get(&chat) else { return Ok(HistoryPage::default()) };
        let anchor = req.anchor.as_ref().and_then(paging::anchor_key);
        let dir = PageDirection::try_from(req.direction).unwrap_or(PageDirection::Older);
        let limit = if req.limit == 0 { 50 } else { req.limit as usize };
        let p = rows.page(anchor, dir, limit);
        Ok(HistoryPage {
            rows: p.rows.iter().filter_map(|r| self.message_view(&chat, r)).collect(),
            older: p.older.map(paging::key_anchor),
            newer: p.newer.map(paging::key_anchor),
            has_older: p.has_older,
            has_newer: p.has_newer,
            pending: None,
        })
    }

    pub(crate) fn state_object_view(&self, kind: i32, key: &str) -> Option<StateObjectView> {
        let v = self.state.view_object(kind, key)?;
        Some(StateObjectView {
            object: Some(ObjectKey { kind, key: key.to_string() }),
            fields: split_fields(&v.value),
            marks: v.marks.into_iter().map(|(field, value)| s2::MarkValue { field, value }).collect(),
        })
    }

    pub fn view_state(&self, req: &epb::ViewStateRequest) -> StateView {
        let kinds: Vec<i32> = req.kinds.iter().filter_map(|k| ObjectKind::from_str_name(k).map(|k| k as i32)).collect();
        StateView {
            objects: self
                .state
                .view()
                .into_iter()
                .filter(|v| kinds.is_empty() || kinds.contains(&v.kind))
                .filter_map(|v| self.state_object_view(v.kind, &v.key))
                .collect(),
        }
    }

    pub fn view_group(&self, group: Option<&Ref>) -> Result<epb::GroupView> {
        let g = group.ok_or(ProtoError::InvalidField("group"))?;
        let f = self.groups.get(&g.id).ok_or(ProtoError::NotFound)?;
        Ok(f.view(&self.cfg.user))
    }

    /// Сведения группы для решений «прямо сейчас»: из журнала группы клиента модели (режим хоста — без ожидания
    /// `flush`), иначе последние сведённые.
    fn live_group_facts(&self, id: &[u8]) -> Option<std::borrow::Cow<'_, GroupFacts>> {
        if let Some(c) = &self.client {
            if let Some(s) = c.group_state(id) {
                return Some(std::borrow::Cow::Owned(GroupFacts::from_state(s, c.group_avatar_key(id))));
            }
        }
        self.groups.get(id).map(std::borrow::Cow::Borrowed)
    }

    /// Приёмный фильтр GROUP-2 (spec 035 T114): скрыть ли сообщение автора `from` с содержимым `wire` (формат
    /// экспорта) в чате `chat`. Личный чат и неизвестная группа — не скрывать.
    pub fn content_hidden(&self, args: &str) -> Result<bool> {
        let v: Value = serde_json::from_str(args).map_err(|_| ProtoError::Malformed)?;
        let chat: Peer = serde_json::from_value(v.get("chat").cloned().ok_or(ProtoError::InvalidField("chat"))?).map_err(|_| ProtoError::Malformed)?;
        let Some(peer::Kind::Group(g)) = &chat.kind else { return Ok(false) };
        let from = v.get("from").and_then(Value::as_str).unwrap_or("");
        let Some(Value::Object(wire)) = v.get("wire") else { return Err(ProtoError::InvalidField("wire")) };
        let Some(f) = self.live_group_facts(&g.id) else { return Ok(false) };
        // Вид, которого движок не знает (служебное «режим чата» и прочее), правами по типу не скрывается
        let Ok(content) = views::wire_to_content(wire, None) else { return Ok(false) };
        Ok(f.hides(from, &content, self.now_ms))
    }

    pub fn capabilities(&self, chat: Option<&Peer>) -> Result<epb::Capabilities> {
        let p = chat.ok_or(ProtoError::InvalidField("chat"))?;
        let mut c = match &p.kind {
            Some(peer::Kind::User(_)) => capabilities::direct(),
            Some(peer::Kind::Group(g)) => match self.live_group_facts(&g.id) {
                Some(f) => f.capabilities(&self.cfg.user, self.now_ms),
                // Сведений группы ещё нет — ничего не разрешать до журнала (GROUP-3)
                None => epb::Capabilities { forward: true, ..Default::default() },
            },
            None => return Err(ProtoError::InvalidField("chat")),
        };
        if self.open_state != OpenState::Ready {
            c = epb::Capabilities { forward: c.forward, ..Default::default() };
        }
        Ok(c)
    }

    // ── ввод сервера ──────────────────────────────────────────────────────────

    pub fn tick(&mut self, now_ms: i64) -> Result<Outcome> {
        self.now_ms = now_ms.max(self.now_ms);
        let mut w = Work::default();
        if self.stage == Stage::Open && self.open_state == OpenState::Ready {
            self.flush_history(false, &mut w);
            if self.now_ms >= self.next_poll_ms {
                self.next_poll_ms = self.now_ms + POLL_MS;
                self.poll(&mut w);
            }
            // Ожидавшее нужды — повторить (FAIL-1: без вечного ожидания)
            let waiting: Vec<Id> = self.outbox.iter().filter(|(_, o)| o.inflight == 0 && !o.waiting).map(|(k, _)| *k).collect();
            for id in waiting {
                self.flush_outbox(&id, &mut w);
            }
        }
        self.finish(w)
    }

    /// Опрос журналов: инбокс, личное состояние, история.
    fn poll(&mut self, w: &mut Work) {
        let Some(c) = &self.client else { return };
        let has_key = c.state_key().is_some();
        if c.log_version(&self.cfg.user) == 0 {
            // Личности в модели нет (переходный период web: инбокс ведёт прежний клиент) — только личное состояние
            if has_key {
                self.state_sync_now(w);
            }
            return;
        }
        if self.cfg.host_driven {
            // Страница журнала инбокса уже в пути либо ждущие записи — не вторую
            if self.pending_inbox.is_empty() {
                self.inbox_sync(w);
            }
        } else {
            let r = c.sync_request();
            self.push_req(w, r, Purpose::InboxSync);
        }
        if has_key {
            let r = Self::id_req("state.ops.sync", &s2::SyncRequest { after_seq: self.meta.state_cursor, max_bytes: 0 });
            self.push_req(w, r, Purpose::StateSync);
        }
        // Режим хоста: журнал истории ведёт хост
        if !self.cfg.host_driven {
            self.history_pull(w);
        }
    }

    /// Чтение журнала истории (HIST-1, HIST-2): новое устройство (курсор 0, точки не было) сначала спрашивает
    /// голову — есть точка: сводка, затем сегменты, курсор на точку; иначе — синк от курсора.
    pub(crate) fn history_pull(&mut self, w: &mut Work) {
        let cursor = self.meta.history_cursor;
        let fresh = cursor == 0 && !self.meta.history_bootstrapped;
        if let Some(s) = self.history_session() {
            let (method, body, purpose) = if fresh {
                ("history.head", s.head_request(), Purpose::HistoryHead)
            } else {
                ("history.sync", s.sync_request(cursor, false, 0), Purpose::HistorySync)
            };
            let r = crate::client::OutRequest { chan: Chan::Id, method, body, dest: None };
            self.push_req(w, r, purpose);
        }
    }

    /// Точка журнала: запросить её сводку (курсор за точку не двигается, пока сводка и сегменты не применены —
    /// S7-4: сервер, не отдав сводку, не заставит пропустить записи до неё).
    fn history_checkpoint_start(&mut self, cp: crate::pb::parvane::history::v1::Checkpoint, w: &mut Work) {
        let Some(s) = self.history_session() else { return };
        let Ok(body) = s.get_request(vec![cp.summary_seq]) else { return };
        let r = crate::client::OutRequest { chan: Chan::Id, method: "history.get", body, dest: None };
        self.push_req(w, r, Purpose::HistorySummary(cp));
    }

    /// Пачка сегментов точки (`history.get` ≤ 256 номеров).
    fn history_segments_next(&mut self, cp: crate::pb::parvane::history::v1::Checkpoint, mut rest: Vec<u64>, expect: BTreeMap<u64, Vec<u8>>, w: &mut Work) {
        if rest.is_empty() {
            // Точка применена: курсор — на неё, дальше обычный синк
            self.meta.history_cursor = self.meta.history_cursor.max(cp.upto_seq);
            self.meta.history_checkpoint = cp.id;
            self.meta.history_bootstrapped = true;
            self.dirty.meta = true;
            self.history_pull(w);
            return;
        }
        let asked: Vec<u64> = rest.drain(..rest.len().min(HISTORY_GET_BATCH)).collect();
        let Some(s) = self.history_session() else { return };
        let Ok(body) = s.get_request(asked.clone()) else { return };
        let r = crate::client::OutRequest { chan: Chan::Id, method: "history.get", body, dest: None };
        self.push_req(w, r, Purpose::HistorySegments { cp, asked, rest, expect });
    }

    /// Ответ `history.head`: точка есть — вход по ней, нет — синк с начала.
    fn ingest_history_head(&mut self, body: &[u8], w: &mut Work) -> Result<()> {
        let Some(s) = self.history_session() else { return Ok(()) };
        let h = s.ingest_head(body)?;
        match h.checkpoint.filter(|c| c.upto_seq > 0) {
            Some(cp) => self.history_checkpoint_start(cp, w),
            None => {
                // Журнал без точки: дальше — обычный синк с начала
                self.meta.history_bootstrapped = true;
                self.dirty.meta = true;
                self.history_pull(w);
            }
        }
        Ok(())
    }

    /// Сводка точки: сверить с точкой (S7-4), применить последние строки и маркеры чатов, запросить сегменты.
    fn ingest_history_summary(&mut self, cp: crate::pb::parvane::history::v1::Checkpoint, body: &[u8], w: &mut Work) -> Result<()> {
        let Some(s) = self.history_session() else { return Ok(()) };
        let ing = s.ingest(body)?;
        let Some(summary) = ing.ops.iter().find_map(|o| match &o.op {
            Some(HOp::Summary(x)) => Some(x.clone()),
            _ => None,
        }) else {
            // Сводка не прочитана — точка не применяется, повтор при следующем опросе
            return Ok(());
        };
        if history::verify_checkpoint(&cp, &summary).is_err() {
            // S7-4: точка не сходится со сводкой — журнал не применяется, курсор прежний
            w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_checkpoint_rejected".into(), detail: cp.id.to_string() }));
            return Ok(());
        }
        for chat in &summary.chats {
            if let Some(last) = &chat.last {
                self.apply_history_op(&HistoryOp { op: Some(HOp::State(last.clone())) }, false, &mut w.delta);
            }
            if let Some(mark) = &chat.mark {
                self.apply_history_op(&HistoryOp { op: Some(HOp::Read(mark.clone())) }, false, &mut w.delta);
            }
        }
        let mut refs = summary.segments.clone();
        // Свежие сегменты первыми (как web orderSegments): последние месяцы видны раньше
        refs.sort_by(|a, b| b.key.cmp(&a.key));
        let expect: BTreeMap<u64, Vec<u8>> = refs.iter().filter(|r| !r.op_id.is_empty()).map(|r| (r.seq, r.op_id.clone())).collect();
        let rest: Vec<u64> = refs.iter().map(|r| r.seq).collect();
        self.history_segments_next(cp, rest, expect, w);
        Ok(())
    }

    /// Пачка сегментов: подменённый сегмент (op_id не тот) — точка не применяется; не поместившиеся в ответ —
    /// следующим запросом.
    fn ingest_history_segments(&mut self, cp: crate::pb::parvane::history::v1::Checkpoint, asked: Vec<u64>, mut rest: Vec<u64>, expect: BTreeMap<u64, Vec<u8>>, body: &[u8], w: &mut Work) -> Result<()> {
        let Some(s) = self.history_session() else { return Ok(()) };
        let ing = s.ingest_checked(body, &expect, None)?;
        if ing.mismatched > 0 {
            // Сервер подменил сегмент точки (S7-4) — точка не применяется, курсор прежний
            w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "history_checkpoint_rejected".into(), detail: cp.id.to_string() }));
            return Ok(());
        }
        let got: BTreeSet<u64> = ing.records.iter().map(|r| r.seq).collect();
        for op in &ing.ops {
            self.apply_history_op(op, false, &mut w.delta);
        }
        if !got.is_empty() {
            let missing: Vec<u64> = asked.into_iter().filter(|q| !got.contains(q)).collect();
            rest.splice(0..0, missing);
        }
        self.history_segments_next(cp, rest, expect, w);
        Ok(())
    }

    pub fn ingest(&mut self, si: epb::ServerInput) -> Result<Outcome> {
        let mut w = Work::default();
        match ServerInputKind::try_from(si.kind).unwrap_or(ServerInputKind::Unspecified) {
            ServerInputKind::Response => {
                let purpose = self.inflight.remove(&si.req_id).unwrap_or(Purpose::Other);
                self.on_response(purpose, si.error, &si.body, &mut w)?;
                if self.migration.is_some() {
                    self.migrate_advance(&mut w)?;
                }
            }
            ServerInputKind::InboxRecord => self.process_record(si.body, &mut w),
            ServerInputKind::Event => match si.method.as_str() {
                "inbox.record" => self.process_record(si.body, &mut w),
                // Хост добрал нужду клиента (режим хоста) либо данные пришли — повторить ждущее
                "retry" if self.cfg.host_driven => self.host_retry(&mut w),
                "retry" => self.retry_waiting(&mut w),
                "skip" if self.cfg.host_driven => self.host_skip(&mut w),
                // Живое уведомление/переподключение: страница журнала инбокса сейчас
                "inbox.poll" => self.inbox_sync(&mut w),
                // Хост узнал о новых записях журнала личного состояния (`JournalNotice{STATE}` прежнего клиента)
                "journal.state" => self.state_sync_now(&mut w),
                m if m.starts_with("ephemeral") => {
                    if let Some(ev) = self.client.as_ref().and_then(|c| c.open_ephemeral(&si.body)) {
                        self.apply_event(ev, &mut w);
                    }
                }
                _ => {}
            },
            _ => return Err(ProtoError::InvalidField("kind")),
        }
        self.finish(w)
    }

    fn need_key(n: &Need) -> String {
        match n {
            Need::PeerLog { user, .. } => format!("log:{user}"),
            Need::Bundle { user } => format!("bundle:{user}"),
            Need::GroupLog { group, .. } => format!("group:{}", hex::encode(group)),
            other => format!("{other:?}"),
        }
    }

    /// Нужда клиента: запросить недостающее самому; чего движок добрать не может — `needs` хосту.
    pub(crate) fn handle_need(&mut self, n: Need, w: &mut Work) {
        let handled = matches!(n, Need::PeerLog { .. } | Need::Bundle { .. } | Need::GroupLog { .. });
        if handled && !self.needs_inflight.insert(Self::need_key(&n)) {
            return;
        }
        match n {
            Need::PeerLog { user, after } => {
                let r = Self::anon_req(
                    "identity.device.log_sync_anon",
                    &crate::pb::parvane::identity::v2::DeviceLogSyncAnonRequest {
                        user: Some(UserRef { address: user.clone() }),
                        after_version: after,
                        genesis_hash: vec![],
                    },
                );
                self.push_req(w, r, Purpose::PeerLog(user));
            }
            Need::Bundle { user } => {
                let r = Self::anon_req(
                    "identity.device.fetch_bundle_anon",
                    &crate::pb::parvane::identity::v2::DeviceFetchBundleAnonRequest { user: Some(UserRef { address: user.clone() }) },
                );
                self.push_req(w, r, Purpose::Bundle(user));
            }
            Need::GroupLog { group, after } => {
                let domain = self.client.as_ref().map(|c| c.group_domain(&group)).unwrap_or_default();
                let g = Ref { domain, id: group };
                let r = Self::id_req(
                    "group.state.sync",
                    &crate::pb::parvane::group::v2::StateSyncRequest { group: Some(g.clone()), after_version: after, ..Default::default() },
                );
                self.push_req(w, r, Purpose::GroupSync { group: g, join: None });
            }
            // Жетоны (ключ сервера — у сеанса транспорта хоста), смена корня (решение пользователя), ключи эпохи —
            // хосту; повтор очереди — по `tick`
            Need::Token { user } => w.delta.push(Change::Needs(epb::Need { kind: "token".into(), chat: Some(user_peer(&user)), detail: user })),
            Need::RootChanged { user } => {
                w.delta.push(Change::Needs(epb::Need { kind: "root_changed".into(), chat: Some(user_peer(&user)), detail: user }))
            }
            Need::GroupKeys { group, epoch } => {
                w.delta.push(Change::Needs(epb::Need { kind: "group_keys".into(), chat: None, detail: format!("{}:{epoch}", hex::encode(group)) }))
            }
            Need::Forbidden => w.delta.push(Change::Needs(epb::Need { kind: "forbidden".into(), chat: None, detail: String::new() })),
        }
    }

    fn on_response(&mut self, p: Purpose, error: i32, body: &[u8], w: &mut Work) -> Result<()> {
        match p {
            Purpose::Deliver(id) => {
                let Some(o) = self.outbox.get_mut(&id) else { return Ok(()) };
                o.inflight = o.inflight.saturating_sub(1);
                if error != 0 {
                    // Отказ сервера: строка — «не отправлено», очередь снимается (повтор — новым намерением)
                    let item = self.outbox.remove(&id);
                    self.dirty.outbox_gone.insert(id);
                    if let Some(item) = item.filter(|i| i.row) {
                        self.set_delivery(&item, Delivery::Failed, &mut w.delta);
                    }
                } else if o.inflight == 0 && !o.waiting {
                    let item = self.outbox.remove(&id);
                    self.dirty.outbox_gone.insert(id);
                    if let Some(item) = item.filter(|i| i.row) {
                        self.set_delivery(&item, Delivery::Sent, &mut w.delta);
                    }
                }
            }
            Purpose::PeerLog(user) => {
                self.needs_inflight.remove(&format!("log:{user}"));
                if error == 0 {
                    if let Some(c) = &mut self.client {
                        let verdict = crate::host::ingest_log_verdict(c, &user, body)?;
                        self.dirty.client = true;
                        if verdict == "rootChanged" {
                            w.delta.push(Change::Notice(epb::Notice { chat: Some(user_peer(&user)), kind: "key_changed".into(), detail: user.clone() }));
                        }
                    }
                }
                self.retry_waiting(w);
            }
            Purpose::Bundle(user) => {
                self.needs_inflight.remove(&format!("bundle:{user}"));
                if error == 0 {
                    let r: crate::pb::parvane::identity::v2::DeviceFetchBundleAnonResponse = decode_checked(body, Origin::Server)?;
                    if let Some(c) = &mut self.client {
                        c.ingest_bundle(&user, r.devices)?;
                        self.dirty.client = true;
                    }
                }
                self.retry_waiting(w);
            }
            Purpose::InboxSync if error == 0 => {
                let r: crate::pb::parvane::msg::v2::InboxSyncResponse = decode_checked(body, Origin::Server)?;
                for rec in &r.records {
                    self.process_record(rec.encode_to_vec(), w);
                }
                if self.cfg.host_driven {
                    if r.more && !r.records.is_empty() {
                        if self.pending_inbox.is_empty() {
                            self.inbox_sync(w);
                        } else {
                            self.inbox_more = true;
                        }
                    }
                } else if r.more {
                    if let Some(c) = &self.client {
                        let req = c.sync_request();
                        self.push_req(w, req, Purpose::InboxSync);
                    }
                }
            }
            Purpose::GroupSync { group, join } => {
                self.needs_inflight.remove(&format!("group:{}", hex::encode(&group.id)));
                if error == 0 {
                    let r: crate::pb::parvane::group::v2::StateSyncResponse = decode_checked(body, Origin::Server)?;
                    if let Some(c) = &mut self.client {
                        match c.group_ingest_hinted(&group, r.entries, &r.signer_hints) {
                            Ok(_) | Err(ClientError::Proto(ProtoError::Duplicate)) => {}
                            Err(ClientError::Need(n)) => self.handle_need(n, w),
                            Err(ClientError::Proto(e)) => return Err(e),
                        }
                        self.dirty.client = true;
                    }
                    if let (Some(parts), Some(c)) = (join, &mut self.client) {
                        let req = c.group_join(&parts)?;
                        self.dirty.client = true;
                        self.push_req(w, req, Purpose::Other);
                    }
                    self.refresh_groups(w, false);
                }
                self.retry_waiting(w);
            }
            Purpose::InviteCheck(parts) if error == 0 => {
                let r: crate::pb::parvane::group::v2::InviteCheckResponse = decode_checked(body, Origin::Server)?;
                let g = r.group.ok_or(ProtoError::NotFound)?;
                if let Some(c) = &self.client {
                    let after = c.group_version(&g.id);
                    let req = c.group_sync_by_link(&g, after, &parts, self.now_ms)?;
                    self.push_req(w, req, Purpose::GroupSync { group: g, join: Some(parts) });
                }
            }
            // Записано (DUPLICATE: тот же op_id уже записан другими байтами — перенос с другого устройства) либо
            // окончательный отказ (схема, право) — повтор той же записи бессмыслен
            Purpose::StateAppend(op_id) if matches!(error, 0..=2 | 4) => {
                self.state_unsent.remove(&hex::encode(&op_id));
                self.dirty.state_raw.insert(hex::encode(&op_id), None);
            }
            Purpose::StateSync if error == 0 => self.ingest_state_sync(body, w)?,
            Purpose::MigrateV1Sync => self.migrate_response(true, error, body, w)?,
            Purpose::MigrateV2Sync => self.migrate_response(false, error, body, w)?,
            Purpose::HistorySync if error == 0 => self.ingest_history_sync(body, w)?,
            Purpose::HistoryHead if error == 0 => self.ingest_history_head(body, w)?,
            Purpose::HistorySummary(cp) if error == 0 => self.ingest_history_summary(cp, body, w)?,
            Purpose::HistorySegments { cp, asked, rest, expect } if error == 0 => self.ingest_history_segments(cp, asked, rest, expect, body, w)?,
            _ => {}
        }
        Ok(())
    }

    fn retry_waiting(&mut self, w: &mut Work) {
        let ids: Vec<Id> = self.outbox.iter().filter(|(_, o)| o.waiting).map(|(k, _)| *k).collect();
        for id in ids {
            if let Some(o) = self.outbox.get_mut(&id) {
                o.waiting = false;
            }
            self.flush_outbox(&id, w);
        }
        let pending = std::mem::take(&mut self.pending_inbox);
        for rec in pending {
            self.process_record(rec, w);
        }
    }

    fn ingest_state_sync(&mut self, body: &[u8], w: &mut Work) -> Result<()> {
        self.ingest_state_sync_as(body, w, Purpose::StateSync).map(|_| ())
    }

    /// Ответ `state.ops.sync`: применить записи; есть ещё — следующая страница с целью `next`. Возвращает «есть ещё».
    pub(crate) fn ingest_state_sync_as(&mut self, body: &[u8], w: &mut Work, next: Purpose) -> Result<bool> {
        let r: s2::SyncResponse = decode_checked(body, Origin::Server)?;
        let Some(c) = &self.client else { return Ok(false) };
        let Some((key, _)) = c.state_key() else { return Ok(false) };
        let key = key.clone();
        let user = c.user.clone();
        let mut touched = BTreeSet::new();
        for rec in &r.records {
            self.meta.state_cursor = self.meta.state_cursor.max(rec.seq);
            let Ok(pt) = crate::state2::open(&key, &user, &rec.op_id, &rec.aead_ciphertext) else { continue };
            if let Ok(op) = decode_checked::<s2::StateOp>(&pt, Origin::Server) {
                if let Some(k) = intent::op_object(&op) {
                    touched.insert((k.kind, k.key.clone()));
                }
            }
            let _ = self.state.apply_bytes(&pt);
        }
        self.dirty.meta = true;
        self.dirty.state = true;
        for (kind, key) in touched {
            self.emit_state(kind, &key, &mut w.delta);
        }
        if self.state.write_blocked() {
            w.delta.push(Change::WriteBlocked(epb::WriteBlocked { journal: crate::hold::STATE.into(), reason: epb::JournalWrite::BlockedCriticalUnknown as i32 }));
        }
        let more = r.more && !r.records.is_empty();
        if more {
            let req = Self::id_req("state.ops.sync", &s2::SyncRequest { after_seq: self.meta.state_cursor, max_bytes: 0 });
            self.push_req(w, req, next);
        }
        Ok(more)
    }

    fn ingest_history_sync(&mut self, body: &[u8], w: &mut Work) -> Result<()> {
        let Some(s) = self.history_session() else { return Ok(()) };
        let ing = s.ingest(body)?;
        // Курсор внутри свёрнутого журнала (HIST-2): сначала точка, страница после неё — повтором синка
        if let Some(cp) = ing.compacted.clone().filter(|c| self.meta.history_cursor < c.upto_seq) {
            self.history_checkpoint_start(cp, w);
            return Ok(());
        }
        for rec in &ing.records {
            self.meta.history_cursor = self.meta.history_cursor.max(rec.seq);
        }
        self.dirty.meta = true;
        for op in ing.ops {
            self.apply_history_op(&op, false, &mut w.delta);
        }
        if ing.more {
            let cursor = self.meta.history_cursor;
            if let Some(s) = self.history_session() {
                let body = s.sync_request(cursor, false, 0);
                let r = crate::client::OutRequest { chan: Chan::Id, method: "history.sync", body, dest: None };
                self.push_req(w, r, Purpose::HistorySync);
            }
        }
        Ok(())
    }

    /// Запись инбокса: открыть клиентом, применить события; курсор — на диск, подтверждение — после фиксации.
    pub(crate) fn process_record(&mut self, rec: Vec<u8>, w: &mut Work) {
        if self.cfg.host_driven {
            self.host_record(rec, w);
            return;
        }
        let Some(c) = &mut self.client else { return };
        let before = c.cursor().disk_value();
        match c.open_record(&rec) {
            Ok(events) => {
                for ev in events {
                    self.apply_event(ev, w);
                }
                let after = self.client.as_ref().map(|c| c.cursor().disk_value()).unwrap_or(before);
                self.dirty.client = true;
                // Повтор уже применённого — подтверждение сразу (на диске оно уже есть); новое — после фиксации
                let _ = after;
                self.dirty.ack = true;
            }
            Err(ClientError::Need(n)) => {
                self.pending_inbox.push(rec);
                self.handle_need(n, w);
            }
            Err(ClientError::Proto(_)) => {
                self.dirty.client = true;
            }
        }
    }

    pub(crate) fn apply_event(&mut self, ev: Event, w: &mut Work) {
        match ev {
            Event::Direct { chat, from, op_id, ts_ms, content, disposition, .. } => {
                let peer = user_peer(&chat);
                self.incoming(peer, &from, &op_id, ts_ms, content, disposition, w);
            }
            Event::Group { group, from, op_id, ts_ms, content, disposition, .. } => {
                let peer = group_peer(&group);
                self.incoming(peer, &from, &op_id, ts_ms, content, disposition, w);
            }
            Event::GroupChanged { group, .. } => {
                let after = self.client.as_ref().map(|c| c.group_version(&group.id)).unwrap_or(0);
                self.handle_need(Need::GroupLog { group: group.id, after }, w);
            }
            Event::Journal { kind, .. } => {
                if kind == 2 {
                    self.history_pull(w);
                } else {
                    let r = Self::id_req("state.ops.sync", &s2::SyncRequest { after_seq: self.meta.state_cursor, max_bytes: 0 });
                    self.push_req(w, r, Purpose::StateSync);
                }
            }
            Event::Typing { chat, group, from, .. } => {
                let p = match group {
                    Some(g) => group_peer(&Ref { domain: self.client.as_ref().map(|c| c.group_domain(&g)).unwrap_or_default(), id: g }),
                    None => user_peer(&chat),
                };
                w.delta.push(Change::Notice(epb::Notice { chat: Some(p), kind: "typing".into(), detail: from }));
            }
            Event::DeviceRevoked { device_id, .. } => {
                w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "device_revoked".into(), detail: device_id }));
            }
            Event::DeviceAdded { device_id, .. } => {
                w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "device_added".into(), detail: device_id }));
            }
            Event::Call { .. } | Event::Presence { .. } => {}
            _ => {}
        }
    }

    /// Применить операцию журнала истории к строке; `queue` — своя/входящая операция, которую надо записать
    /// в журнал (HIST-1 п. 5).
    pub(crate) fn apply_history_op(&mut self, op: &HistoryOp, queue: bool, d: &mut DeltaBuilder) {
        if let Some(HOp::Read(m)) = &op.op {
            if let Some(p) = &m.chat {
                if let Ok(chat) = history::history_chat_key(p) {
                    let merged = history::mark_merge(self.marks.get(&chat), Some(m)).ok().flatten();
                    if merged.as_ref() != self.marks.get(&chat) {
                        if let Some(mm) = merged {
                            self.marks.insert(chat.clone(), mm);
                        }
                        self.peers.entry(chat.clone()).or_insert_with(|| p.clone());
                        self.dirty.marks.insert(chat.clone());
                        self.dirty.chats.insert(chat);
                        if queue {
                            self.queue_history(op.clone());
                        }
                    }
                }
            }
            return;
        }
        let Some((target, chat)) = history::op_target(op) else { return };
        let Some(peer) = chat.clone() else { return };
        let Ok(chat) = history::history_chat_key(&peer) else { return };
        let Some(id) = paging::id16(target) else { return };
        let selves = self.selves();
        let sv: Vec<&str> = selves.iter().map(String::as_str).collect();
        let rows = self.chats.entry(chat.clone()).or_default();
        let prev = rows.get(&id).cloned();
        let Ok(state) = history::apply(prev.as_ref().map(|r| &r.state), op) else { return };
        if prev.as_ref().is_some_and(|p| p.state == state) {
            return;
        }
        let ts = state.row.as_ref().map(|r| r.ts_ms).unwrap_or(self.now_ms);
        let order = prev.as_ref().map(|p| p.order).unwrap_or_else(|| rows.place(ts, self.now_ms));
        let mut row = prev.unwrap_or_default();
        row.counted = history::is_unread(&state, None, &sv).unwrap_or(false);
        row.state = state;
        row.order = order;
        rows.put(id, row);
        self.peers.entry(chat.clone()).or_insert(peer);
        self.dirty.rows.insert((chat.clone(), id));
        self.dirty.chats.insert(chat.clone());
        if queue {
            self.queue_history(op.clone());
        }
        self.refresh_row(&chat, &id, d);
    }

    pub(crate) fn queue_history(&mut self, op: HistoryOp) {
        self.history_queue.push(op);
        if self.history_due_ms.is_none() {
            let span = (HISTORY_BATCH_MAX_MS - HISTORY_BATCH_MIN_MS) as u64;
            let jitter = (rand::random::<u64>() % (span + 1)) as i64;
            self.history_due_ms = Some(self.now_ms + HISTORY_BATCH_MIN_MS + jitter);
        }
    }

    /// Пачка журнала истории — по сроку (HIST-1 п. 5) либо принудительно.
    fn flush_history(&mut self, force: bool, w: &mut Work) {
        let due = self.history_due_ms.is_some_and(|t| force || self.now_ms >= t);
        if !due || self.history_queue.is_empty() {
            return;
        }
        let ops = std::mem::take(&mut self.history_queue);
        self.history_due_ms = None;
        let now = self.now_ms;
        let Some(s) = self.history_session() else {
            self.history_queue = ops;
            return;
        };
        if let Ok(bodies) = s.seal(ops, false, now) {
            for (_, body) in bodies {
                let r = crate::client::OutRequest { chan: Chan::Id, method: "history.append", body, dest: None };
                self.push_req(w, r, Purpose::HistoryAppend);
            }
        }
    }

    /// Входящее сообщение или мутация (инбокс, векторы).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn incoming(&mut self, peer: Peer, from: &str, op_id: &[u8], ts_ms: i64, content: Content, disposition: crate::unknown::Disposition, w: &mut Work) {
        intent::apply_incoming(self, peer, from, op_id, ts_ms, content, disposition, w);
    }

    pub(crate) fn emit_state(&mut self, kind: i32, key: &str, d: &mut DeltaBuilder) {
        let view = self.state_object_view(kind, key);
        d.push(Change::StateChanged(StateChanged { object: Some(ObjectKey { kind, key: key.to_string() }), view }));
        // Признак архива/отметки меняет представление чата
        if let Some(chat) = self.peers.iter().find(|(_, p)| crate::state::peer_key(p).ok().as_deref() == Some(key)).map(|(k, _)| k.clone()) {
            self.dirty.chats.insert(chat);
        }
    }

    fn set_delivery(&mut self, item: &OutboxItem, d: Delivery, delta: &mut DeltaBuilder) {
        let Ok(peer) = decode_checked::<Peer>(&item.chat, Origin::Server) else { return };
        let Ok(chat) = history::history_chat_key(&peer) else { return };
        let Some(id) = paging::id16(&item.op_id) else { return };
        if let Some(r) = self.chats.get_mut(&chat).and_then(|c| c.get_mut(&id)) {
            if r.delivery == Delivery::Read as i32 && d == Delivery::Sent {
                return;
            }
            r.delivery = d as i32;
            self.dirty.rows.insert((chat.clone(), id));
            self.refresh_row(&chat, &id, delta);
        }
    }

    /// Отправить исходящее из очереди (или запросить недостающее).
    pub(crate) fn flush_outbox(&mut self, id: &Id, w: &mut Work) {
        let Some(item) = self.outbox.get(id).cloned() else { return };
        let Ok(peer) = decode_checked::<Peer>(&item.chat, Origin::Server) else { return };
        let Some(c) = &mut self.client else { return };
        let result = if !item.receipt.is_empty() {
            let ids: Vec<Vec<u8>> = item.receipt.iter().filter_map(|h| hex::decode(h).ok()).collect();
            match &peer.kind {
                Some(peer::Kind::User(u)) => c.prepare_receipt(&u.address, crate::pb::parvane::msg::v2::ReceiptKind::Read, &ids),
                Some(peer::Kind::Group(g)) => c.prepare_group_receipt(&g.id, crate::pb::parvane::msg::v2::ReceiptKind::Read, &ids),
                None => return,
            }
        } else {
            let Ok(content) = decode_checked::<Content>(&item.content, Origin::Client) else { return };
            match &peer.kind {
                Some(peer::Kind::User(u)) => c.prepare_direct_id(&u.address, &content, item.op_id.clone()),
                Some(peer::Kind::Group(g)) => c.prepare_group_id(&g.id, &content, item.op_id.clone()),
                None => return,
            }
        };
        self.dirty.client = true;
        match result {
            Ok(reqs) => {
                let n = reqs.len() as u32;
                for r in reqs {
                    self.push_req(w, r, Purpose::Deliver(*id));
                }
                if let Some(o) = self.outbox.get_mut(id) {
                    o.inflight = n;
                    o.waiting = false;
                    if n == 0 {
                        // Отправлять некому (только свои, их нет) — доставлено
                        let item = self.outbox.remove(id);
                        self.dirty.outbox_gone.insert(*id);
                        if let Some(item) = item.filter(|i| i.row) {
                            self.set_delivery(&item, Delivery::Sent, &mut w.delta);
                        }
                    }
                }
            }
            Err(ClientError::Need(n)) => {
                if let Some(o) = self.outbox.get_mut(id) {
                    o.waiting = true;
                }
                self.handle_need(n, w);
            }
            Err(ClientError::Proto(_)) => {
                let item = self.outbox.remove(id);
                self.dirty.outbox_gone.insert(*id);
                if let Some(item) = item.filter(|i| i.row) {
                    self.set_delivery(&item, Delivery::Failed, &mut w.delta);
                }
            }
        }
    }

    /// Догнать журнал личного состояния: неотправленные свои операции (не в пути) и `state.ops.sync` от курсора.
    pub(crate) fn state_sync_now(&mut self, w: &mut Work) {
        let inflight: BTreeSet<String> = self
            .inflight
            .values()
            .filter_map(|p| match p {
                Purpose::StateAppend(id) => Some(hex::encode(id)),
                _ => None,
            })
            .collect();
        let unsent: Vec<(String, Vec<u8>)> =
            self.state_unsent.iter().filter(|(k, _)| !inflight.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect();
        for (op_hex, pt) in unsent {
            self.send_state_raw(&op_hex, &pt, w);
        }
        if self.inflight.values().any(|p| matches!(p, Purpose::StateSync)) {
            return;
        }
        let r = Self::id_req("state.ops.sync", &s2::SyncRequest { after_seq: self.meta.state_cursor, max_bytes: 0 });
        self.push_req(w, r, Purpose::StateSync);
    }

    pub(crate) fn send_state_raw(&mut self, op_hex: &str, pt: &[u8], w: &mut Work) {
        let Some(c) = &self.client else { return };
        let Some((key, _)) = c.state_key() else { return };
        let Ok(op_id) = hex::decode(op_hex) else { return };
        let Ok(req) = crate::state2::seal_raw_deterministic(key, &c.user, &op_id, pt) else { return };
        let r = Self::id_req("state.ops.append", &req);
        self.push_req(w, r, Purpose::StateAppend(op_id));
    }

    // ── векторы (FR-053) ───────────────────────────────────────────────────────

    fn vector_input(&mut self, args: &str) -> Result<Outcome> {
        intent::vector_input(self, args)
    }
}

/// Корень профиля нового хранилища ждёт первой пачки (одна транзакция с данными).
impl Engine {
    /// Сессия журнала истории движка (тесты собирают «серверные» записи под его ключом).
    #[doc(hidden)]
    pub fn debug_history_session(&mut self) -> Option<&HistorySession> {
        self.history_session()
    }

    #[doc(hidden)]
    pub fn debug_rows(&self, chat: &Peer) -> usize {
        history::history_chat_key(chat).ok().and_then(|k| self.chats.get(&k)).map(ChatRows::len).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_fields_groups_repeated() {
        let f = crate::pb::parvane::state::v1::Folder { id: 5, title: "Работа".into(), ..Default::default() };
        let parts = split_fields(&f.encode_to_vec());
        assert_eq!(parts.iter().map(|p| p.field).collect::<Vec<_>>(), vec![1, 2]);
        let joined: Vec<u8> = parts.iter().flat_map(|p| p.value.clone()).collect();
        assert_eq!(joined, f.encode_to_vec());
    }
}
