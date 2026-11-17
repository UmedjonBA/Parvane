//! Клиентское ядро в модели движка (spec 035: T113 web, T125 desktop, T135 android; contracts/engine-api.md).
//!
//! Хост больше не держит прежний клиент (`PvClient` WASM, `pv_client_*` C ABI): клиент (`Client` — ключи
//! устройства, журналы устройств и групп, эпохи, сессии, «План», «Облако») принадлежит модели и лежит в её
//! хранилище (`engine-core/client`), корень и подготовленная смена ника — только в памяти модели (C1-06).
//!
//! - `clientCall{name, args_json}` — действие или чтение клиента теми же именами и аргументами, что единая точка
//!   входа нативных хостов (`host/call.rs`, имена WASM-обвязки): одно ядро для web, desktop и android. Изменённое
//!   состояние уходит на диск следующим итогом модели (`flush`, `tick`, `ingest`).
//! - `historyCall{name, args_json}` — сессия журнала истории модели (`host/history.rs`): ключи — из клиента модели.
//! - `clientReplace{mode}` — новое устройство (сброс личности, привязка заново) либо импорт экспорта.
//! - `flush` — итог с пачкой хранилища (состояние клиента, личное состояние), сведения групп обновляются.
//!
//! Режим хоста (`EngineConfig.host_driven`): записи инбокса подаются `ingest`, их события — хосту
//! (`client_events`), нужды клиента — хосту (`needs{kind: "client", detail: JSON нужды}`); запись, ждущая нужду, и
//! все следующие ждут `ingest{EVENT, method: "retry"}` (ORDER-1); подтверждение инбокса — после фиксации пачки
//! с применённым (SYNC-1).

use serde_json::Value;

use super::{err_json, Engine, Purpose, Work};
use crate::client::{Client, ClientError, Event};
use crate::error::ProtoError;
use crate::host::HostClient;
use crate::pb::parvane::engine::v1::{self as epb, model_change::Change, OpenState, Outcome};

/// Чтения клиента: состояние не меняют, на диск не пишутся.
pub const READS: &[&str] = &[
    "export",
    "exportRootBackup",
    "exportRootEscrow",
    "hasRoot",
    "ownSskExposed",
    "sessionProof",
    "linkGrantMaterial",
    "linkChallengeWrap",
    "linkChallengeUnwrap",
    "groupKeysExport",
    "groupKeysMerge",
    "syncRequest",
    "ackRequest",
    "cursor",
    "lastError",
    "logVersion",
    "logDevices",
    "logsBehind",
    "ownRenamedTo",
    "peerRenamedTo",
    "peerRenamedFrom",
    "selfAddress",
    "formerAddresses",
    "aliasesOf",
    "hasPeerDeliveryKey",
    "tokenCount",
    "tokenRefillDue",
    "tokenBatchSize",
    "tokenCountFor",
    "tokenRefillDueFor",
    "tokenRefillDueDomains",
    "readers",
    "leftSskHolders",
    "groupsRekeyPending",
    "groupVersion",
    "groupBehind",
    "groupDomain",
    "groupList",
    "groupUnconfirmed",
    "groupInfo",
    "groupAvatarKeyContent",
    "groupInviteAvatarKey",
    "publicHistoryItems",
    "groupSyncByLinkRequest",
    "groupSyncByLink",
    "l2Direct",
    "l2Group",
    "l2ActiveChats",
    "presenceAllowed",
    "hasStateKey",
    "plannerContainer",
    "plannerIsAttached",
    "plannerHasKey",
    "plannerHeadSeq",
    "plannerStateJson",
    "plannerSize",
    "plannerKeysExport",
    "healthContainer",
    "healthIsAttached",
    "healthHasKey",
    "healthHeadSeq",
    "healthStateJson",
    "healthView",
    "healthCompose",
    "healthRecall",
    "healthEntries",
    "healthDays",
    "healthCheck",
    "healthSize",
    "healthKeysExport",
    "healthParse",
    "musicContainer",
    "musicIsAttached",
    "musicHasKey",
    "musicHeadSeq",
    "musicStateJson",
    "musicCompose",
    "musicSize",
    "musicKeysExport",
    "cloudContainers",
    "cloudDomain",
    "cloudIsAttached",
    "cloudHasKey",
    "cloudHeadSeq",
    "cloudGrantVersion",
    "cloudStateJson",
    "cloudKeysExport",
    "prepareCover",
    "ephOpen",
];

fn parse_args(text: &str) -> std::result::Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(text).map_err(|_| err_json(ProtoError::Malformed))
}

impl Engine {
    /// `clientCall`: результат — `CallResult` (JSON-текст), ошибка — `{"need": …}` / `{"error": …}`.
    pub(crate) fn client_call(&mut self, a: epb::ClientCall) -> std::result::Result<String, String> {
        let args = parse_args(&a.args_json)?;
        let read = READS.contains(&a.name.as_str());
        if !read {
            match self.open_state {
                OpenState::Ready => {}
                OpenState::TooNew => return Err(err_json(ProtoError::WriteBlocked)),
                OpenState::Locked => return Err(err_json(ProtoError::Locked)),
                OpenState::Unspecified => return Err(err_json(ProtoError::NotFound)),
            }
        }
        let c = self.client.take().ok_or_else(|| err_json(ProtoError::NotFound))?;
        let mut hc = HostClient::from_parts(c, self.root.take(), self.rename_plan.take());
        let r = hc.call(&a.name, &args);
        let (c, root, plan) = hc.into_parts();
        self.client = Some(c);
        self.root = root;
        self.rename_plan = plan;
        if !read {
            self.dirty.client = true;
            // Ключи состояния могли смениться (привязка, ensureStateKey, импорт ключей) — сессия истории заново
            self.history_session = None;
        }
        r.map(|v| v.to_string())
    }

    /// `historyCall`: функция сессии журнала истории модели по имени.
    pub(crate) fn history_call(&mut self, a: epb::ClientCall) -> std::result::Result<String, String> {
        let args = parse_args(&a.args_json)?;
        let s = self.history_session().ok_or_else(|| err_json(ProtoError::NotFound))?;
        crate::host::history::session_call(s, &a.name, &args).map(|v| v.to_string())
    }

    /// `clientReplace`: новое устройство либо импорт экспорта. Корень, смена ника, сведения групп и ждущие нужды
    /// записи забываются; у нового устройства — и личное состояние прежнего (ключи журнала другие).
    pub(crate) fn client_replace(&mut self, r: epb::ClientReplace) -> crate::error::Result<()> {
        let c = match r.mode.as_str() {
            "new" => Client::new(&self.cfg.user, &self.cfg.device_id, &self.cfg.domain)?,
            "import" => {
                let key: [u8; 32] = r.key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("key"))?;
                Client::import(&r.blob, &key)?
            }
            _ => return Err(ProtoError::InvalidField("mode")),
        };
        if r.mode == "new" {
            self.state = crate::state2::State2::new();
            self.meta = Default::default();
            self.dirty.state = true;
            self.dirty.meta = true;
            for k in std::mem::take(&mut self.state_unsent).into_keys() {
                self.dirty.state_raw.insert(k, None);
            }
        }
        self.client = Some(c);
        self.root = None;
        self.rename_plan = None;
        self.groups.clear();
        self.history_session = None;
        self.pending_inbox.clear();
        self.needs_inflight.clear();
        self.inbox_more = false;
        self.dirty.client = true;
        Ok(())
    }

    /// `flush`: пачка хранилища с изменённым (клиент, личное состояние) и сведения групп.
    pub fn flush(&mut self) -> crate::error::Result<Outcome> {
        let mut w = Work::default();
        if self.dirty.client {
            self.refresh_groups(&mut w, false);
        }
        self.finish(w)
    }

    // ── режим хоста ───────────────────────────────────────────────────────────

    /// Запись инбокса в режиме хоста: ждущие записи впереди — встать за ними.
    pub(crate) fn host_record(&mut self, rec: Vec<u8>, w: &mut Work) {
        if !self.pending_inbox.is_empty() {
            self.pending_inbox.push(rec);
            return;
        }
        self.host_open(rec, w);
    }

    /// Открыть запись; `false` — ждёт нужду (запись отложена).
    fn host_open(&mut self, rec: Vec<u8>, w: &mut Work) -> bool {
        let Some(c) = &mut self.client else { return true };
        match c.open_record(&rec) {
            Ok(events) => {
                self.dirty.client = true;
                self.dirty.ack = true;
                // Пустой итог: повтор, конверт ждёт ключей эпохи либо отвергнут (`last_error`) — причину хосту
                if events.is_empty() {
                    let detail = c
                        .last_error
                        .take()
                        .map(|e| format!("{e:?}"))
                        .or_else(|| (c.pending_group_len() > 0).then(|| format!("ждут ключей эпохи: {}", c.pending_group_len())))
                        .unwrap_or_default();
                    w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "record_quiet".into(), detail }));
                }
                self.host_events(events, w);
                true
            }
            Err(ClientError::Need(n)) => {
                let detail = crate::host::need_json(&n).to_string();
                w.delta.push(Change::Needs(epb::Need { kind: "client".into(), chat: None, detail }));
                self.pending_inbox.push(rec);
                false
            }
            // Запись отвергнута (повтор, подделка, сломанное) — хосту уведомлением с причиной: молча пропавшая
            // запись (секрет фото группы под нагрузкой, 12 ноя 2026) иначе не разобрать
            Err(ClientError::Proto(e)) => {
                self.dirty.client = true;
                w.delta.push(Change::Notice(epb::Notice { chat: None, kind: "record_dropped".into(), detail: format!("{e:?}") }));
                true
            }
        }
    }

    /// События записи — хосту; журнал личного состояния ведёт модель. С `engine_rows` (spec 036) сообщения и
    /// мутации ещё и применяются к строкам моделью, журнал истории читает модель — хост их строк не собирает.
    fn host_events(&mut self, events: Vec<Event>, w: &mut Work) {
        if events.is_empty() {
            return;
        }
        let state = events.iter().any(|e| matches!(e, Event::Journal { kind, .. } if *kind != 2));
        let history = events.iter().any(|e| matches!(e, Event::Journal { kind: 2, .. }));
        w.delta.push(Change::ClientEvents(epb::ClientEvents { json: crate::host::events(&events) }));
        if state && self.client.as_ref().is_some_and(|c| c.state_key().is_some()) {
            self.state_sync_now(w);
        }
        if !self.cfg.engine_rows {
            return;
        }
        for ev in events {
            match ev {
                Event::Direct { .. } | Event::Group { .. } => self.apply_event(ev, w),
                _ => {}
            }
        }
        if history {
            self.history_pull(w);
        }
    }

    /// Хост добрал нужду: отложенные записи — по порядку до следующей нужды; страница журнала кончилась на них —
    /// следующая.
    pub(crate) fn host_retry(&mut self, w: &mut Work) {
        let pending = std::mem::take(&mut self.pending_inbox);
        let mut it = pending.into_iter();
        while let Some(rec) = it.next() {
            if !self.host_open(rec, w) {
                self.pending_inbox.extend(it);
                return;
            }
        }
        if self.inbox_more {
            self.inbox_more = false;
            self.inbox_sync(w);
        }
    }

    /// Хост не смог добрать нужду первой ждущей записи (повторы исчерпаны): запись пропускается — курсор её не
    /// отмечает, сервер отдаст её снова при следующем синке, — следующие идут дальше (как прежний хост web).
    pub(crate) fn host_skip(&mut self, w: &mut Work) {
        if !self.pending_inbox.is_empty() {
            self.pending_inbox.remove(0);
        }
        self.host_retry(w);
    }

    /// Запросить следующую страницу журнала инбокса (одна в пути).
    pub(crate) fn inbox_sync(&mut self, w: &mut Work) {
        if self.inflight.values().chain(w.requests.iter().map(|(_, p)| p)).any(|p| matches!(p, Purpose::InboxSync)) {
            return;
        }
        let Some(c) = &self.client else { return };
        if c.log_version(&self.cfg.user) == 0 {
            return;
        }
        let r = c.sync_request();
        self.push_req(w, r, Purpose::InboxSync);
    }
}
