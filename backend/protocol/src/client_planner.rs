// Контейнер планировщика в клиенте (spec 010): включается в `client.rs`
// через `include!` — та же область видимости, доступ к полям `Client`.
//
// Один контейнер домена `parvane.planner.v1` на пользователя: генезис и журнал
// грантов (как у сервера — `ContainerAccess`), связка ключей эпох, сведённое
// состояние (`domain::planner`), курсор `head_seq`, последний снимок.
// Ключ эпохи приходит своему устройству по E2E (`Content.container_key`,
// только от владельца — своего аккаунта) либо из экспорта линковки
// (`planner_keys_import`, доверенный источник — своё устройство). Операции,
// пришедшие раньше ключа, ждут в `pending_ops`. Отзыв своего устройства
// поднимает эпоху записью «rotate» (REVOKE-1, R6).

use crate::domain::{self as dom, health, health_json, music, music_json, no_groups, planner, planner_json, Author as DomainAuthor, ContainerAccess, JsonCache, KeyRing, LamportGuard as DomainGuard};
use crate::pb::parvane::core::v2::{
    ContainerKeyShare, ContainerOp, DomainContainerCreateRequest, DomainContainerGetResponse, DomainGrantListResponse,
    DomainKeyRotateRequest, DomainOpAppendRequest, DomainOpSyncResponse, DomainSnapshotGetResponse,
    DomainSnapshotPutRequest,
};

/// Личный контейнер домена — один на пользователя, ключ эпохи у своих устройств: планировщик (spec 010) и
/// «Здоровье» (spec 038). Весь код контейнера общий; различается только сведённое состояние (`PersonalState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Personal {
    Planner,
    Health,
    /// Плейлисты «Музыки» (spec 039, этап C).
    Music,
}

impl Personal {
    pub const ALL: [Personal; 3] = [Personal::Planner, Personal::Health, Personal::Music];

    pub fn domain(self) -> &'static str {
        match self {
            Personal::Planner => planner::DOMAIN_NAME,
            Personal::Health => health::DOMAIN_NAME,
            Personal::Music => music::DOMAIN_NAME,
        }
    }

    pub fn of_domain(domain: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.domain() == domain)
    }

    fn snapshot_every(self) -> u64 {
        match self {
            Personal::Planner => planner::SNAPSHOT_EVERY,
            Personal::Health => health::SNAPSHOT_EVERY,
            Personal::Music => music::SNAPSHOT_EVERY,
        }
    }

    fn changed(self, seq: u64, head_seq: u64) -> Event {
        match self {
            Personal::Planner => Event::PlannerChanged { seq, head_seq },
            Personal::Health => Event::HealthChanged { seq, head_seq },
            Personal::Music => Event::MusicChanged { seq, head_seq },
        }
    }
}

/// Поле `Client` личного контейнера. Макрос, а не метод: заимствуется одно поле, остальные поля клиента
/// (`last_error`, ожидающие ключи) остаются доступны рядом.
macro_rules! slot {
    ($c:expr, $kind:expr) => {
        match $kind {
            Personal::Planner => &mut $c.planner,
            Personal::Health => &mut $c.health,
            Personal::Music => &mut $c.music,
        }
    };
}
macro_rules! slot_ref {
    ($c:expr, $kind:expr) => {
        match $kind {
            Personal::Planner => &$c.planner,
            Personal::Health => &$c.health,
            Personal::Music => &$c.music,
        }
    };
}

/// Сведённое состояние личного контейнера.
#[derive(Debug, Clone, PartialEq)]
enum PersonalState {
    Planner(planner::PlannerState),
    Health(health::HealthState),
    Music(music::MusicState),
}

impl PersonalState {
    fn new(kind: Personal) -> Self {
        match kind {
            Personal::Planner => Self::Planner(Default::default()),
            Personal::Health => Self::Health(Default::default()),
            Personal::Music => Self::Music(Default::default()),
        }
    }

    /// Имя типа открытого текста операции и снимка — для отметок `range-hold` (поиск непонятого в байтах).
    fn op_type(&self) -> &'static str {
        match self {
            Self::Planner(_) => crate::hold::PLANNER_TYPE,
            Self::Health(_) => crate::hold::HEALTH_TYPE,
            Self::Music(_) => crate::hold::MUSIC_TYPE,
        }
    }

    fn snapshot_type(&self) -> &'static str {
        match self {
            Self::Planner(_) => crate::hold::PLANNER_SNAPSHOT_TYPE,
            Self::Health(_) => crate::hold::HEALTH_SNAPSHOT_TYPE,
            Self::Music(_) => crate::hold::MUSIC_SNAPSHOT_TYPE,
        }
    }

    /// Открытый текст операции журнала: разбор, часы, применение. `opaque` — операция не разобрана целиком.
    fn open_op(&mut self, guard: &mut DomainGuard, pt: &[u8], author_device: &str, opaque: &mut bool) -> Result<usize> {
        match self {
            Self::Planner(st) => {
                let op = planner::decode_op(pt).inspect_err(|_| *opaque = true)?;
                planner::guard_op(guard, &op).inspect_err(|_| *opaque = true)?;
                st.apply_op(&op, author_device)
            }
            Self::Health(st) => {
                let op = health::decode_op(pt).inspect_err(|_| *opaque = true)?;
                health::guard_op(guard, &op).inspect_err(|_| *opaque = true)?;
                st.apply_op(&op, author_device)
            }
            Self::Music(st) => {
                let op = music::decode_op(pt).inspect_err(|_| *opaque = true)?;
                music::guard_op(guard, &op).inspect_err(|_| *opaque = true)?;
                st.apply_op(&op, author_device)
            }
        }
    }

    /// Открытый текст снимка: метки — в часы до слияния (негодная метка — отказ всему снимку), затем слияние.
    fn merge_snapshot(&mut self, guard: &mut DomainGuard, pt: &[u8], upto_seq: u64) -> Result<()> {
        match self {
            Self::Planner(st) => {
                let s = planner::decode_snapshot(pt)?;
                planner::guard_snapshot(guard, &s, upto_seq)?;
                st.merge_snapshot(&s)
            }
            Self::Health(st) => {
                let s = health::decode_snapshot(pt)?;
                health::guard_snapshot(guard, &s, upto_seq)?;
                st.merge_snapshot(&s)
            }
            Self::Music(st) => {
                let s = music::decode_snapshot(pt)?;
                music::guard_snapshot(guard, &s, upto_seq)?;
                st.merge_snapshot(&s)
            }
        }
    }

    /// Локальная правка хоста (JSON): метка движка, применение; байты операции с метками и число применённых.
    fn prepare_local(&mut self, guard: &mut DomainGuard, changes_json: &str, dev: &str) -> Result<(Vec<u8>, usize)> {
        match self {
            Self::Planner(st) => {
                let mut op = planner_json::op_from_json(changes_json)?;
                planner::stamp_op(&mut op, &dom::Stamp::new(guard.tick(), dev));
                let applied = st.apply_op(&op, dev)?;
                Ok((op.encode_to_vec(), applied))
            }
            Self::Health(st) => {
                let mut op = health_json::op_from_json(changes_json)?;
                health::stamp_op(&mut op, &dom::Stamp::new(guard.tick(), dev));
                let applied = st.apply_op(&op, dev)?;
                Ok((op.encode_to_vec(), applied))
            }
            Self::Music(st) => {
                let mut op = music_json::op_from_json(changes_json)?;
                music::stamp_op(&mut op, &dom::Stamp::new(guard.tick(), dev));
                let applied = st.apply_op(&op, dev)?;
                Ok((op.encode_to_vec(), applied))
            }
        }
    }

    fn apply_local(&mut self, guard: &mut DomainGuard, op_bytes: &[u8], dev: &str) -> Result<usize> {
        match self {
            Self::Planner(st) => {
                let op = planner::decode_op(op_bytes)?;
                planner::guard_op(guard, &op)?;
                st.apply_op(&op, dev)
            }
            Self::Health(st) => {
                let op = health::decode_op(op_bytes)?;
                health::guard_op(guard, &op)?;
                st.apply_op(&op, dev)
            }
            Self::Music(st) => {
                let op = music::decode_op(op_bytes)?;
                music::guard_op(guard, &op)?;
                st.apply_op(&op, dev)
            }
        }
    }

    /// Байты заменяющего снимка; `RangeHeld` — над непонятым снимок запрещён (FR-035).
    fn replacement_snapshot(&self, holds: &[crate::pb::parvane::engine::v1::RangeHold], container: &crate::pb::parvane::core::v2::Container, upto_seq: u64) -> Result<Vec<u8>> {
        match self {
            Self::Planner(st) => Ok(st.replacement_snapshot(holds, container, upto_seq)?.encode_to_vec()),
            Self::Health(st) => {
                dom::replacement_allowed(holds, container, upto_seq)?;
                Ok(st.to_snapshot().encode_to_vec())
            }
            Self::Music(st) => {
                dom::replacement_allowed(holds, container, upto_seq)?;
                Ok(st.to_snapshot().encode_to_vec())
            }
        }
    }

    fn snapshot_bytes(&self) -> Vec<u8> {
        match self {
            Self::Planner(st) => st.to_snapshot().encode_to_vec(),
            Self::Health(st) => st.to_snapshot().encode_to_vec(),
            Self::Music(st) => st.to_snapshot().encode_to_vec(),
        }
    }

    fn from_snapshot_bytes(kind: Personal, bytes: &[u8]) -> Result<Self> {
        Ok(match kind {
            Personal::Planner => Self::Planner(planner::PlannerState::from_snapshot(&planner::decode_snapshot(bytes)?)?),
            Personal::Health => {
                let mut st = health::HealthState::default();
                st.merge_snapshot(&health::decode_snapshot(bytes)?)?;
                Self::Health(st)
            }
            Personal::Music => {
                let mut st = music::MusicState::default();
                st.merge_snapshot(&music::decode_snapshot(bytes)?)?;
                Self::Music(st)
            }
        })
    }

    fn state_json(&self, head_seq: u64) -> String {
        match self {
            Self::Planner(st) => planner_json::state_json(st, head_seq),
            Self::Health(st) => health_json::state_json(st, head_seq),
            Self::Music(st) => music_json::state_json(st, head_seq),
        }
    }

    /// Изменения для записи разобранного ввода «Здоровья» (HEALTH-3).
    fn health_compose(&self, parsed: &[serde_json::Value], now_ms: i64) -> Option<serde_json::Value> {
        match self {
            Self::Health(st) => Some(crate::domain::health_view::compose_changes(st, parsed, now_ms)),
            Self::Planner(_) | Self::Music(_) => None,
        }
    }

    /// Сводка «Здоровья» для экранов (HEALTH-3); у планировщика её нет.
    fn health_view(&self, now_ms: i64, tz_min: i32) -> Option<String> {
        match self {
            Self::Health(st) => Some(crate::domain::health_view::view_json(st, now_ms, tz_min)),
            Self::Planner(_) | Self::Music(_) => None,
        }
    }

    /// Записи показателя для подробного экрана «Здоровья» (HEALTH-3).
    fn health_entries(&self, kind: &str, limit: usize, now_ms: i64, tz_min: i32) -> Option<String> {
        match self {
            Self::Health(st) => Some(crate::domain::health_form::entries_json(st, kind, limit, now_ms, tz_min)),
            Self::Planner(_) | Self::Music(_) => None,
        }
    }

    /// Здоровье по дням для календаря «Плана».
    fn health_days(&self, from_day: &str, to_day: &str) -> Option<String> {
        match self {
            Self::Health(st) => Some(crate::domain::health_day::days_json(st, from_day, to_day)),
            Self::Planner(_) | Self::Music(_) => None,
        }
    }

    fn rev(&self) -> u64 {
        match self {
            Self::Planner(st) => st.rev(),
            Self::Health(st) => st.rev(),
            Self::Music(st) => st.rev(),
        }
    }

    fn size_estimate(&self) -> usize {
        match self {
            Self::Planner(st) => st.size_estimate(),
            Self::Health(st) => st.snapshot_size(),
            Self::Music(st) => st.snapshot_size(),
        }
    }
}

/// Локальное состояние личного контейнера (планировщик, «Здоровье»).
#[derive(Debug, Clone, PartialEq)]
struct PlannerLocal {
    genesis: SignedOp,
    grants: Vec<SignedOp>,
    access: ContainerAccess,
    keys: KeyRing,
    guard: DomainGuard,
    state: PersonalState,
    head_seq: u64,
    snapshot_seq: u64,
    /// Операции журнала, ждущие ключа своей эпохи (в порядке seq).
    pending_ops: Vec<ContainerOp>,
    /// Наибольшая эпоха ключа среди принятых операций этого запуска: сервер принимает операцию только в
    /// текущей эпохе, значит в журнале эпоха не убывает (убывающая — вставка старым ключом).
    last_op_epoch: u64,
    /// JSON состояния для хоста по (ревизия, head_seq) — C1.
    json_cache: JsonCache,
    /// Граница эпохи по подписанным данным (S7-6).
    cut: dom::EpochCut,
    /// spec 035 (FR-032, S7-22): с прошлого снимка была операция, которую движок понял не целиком (неизвестные
    /// поля, виды, значения либо не разобрал) — снимок без `complete`, журнал не обрезается. После восстановления
    /// из персиста прежнего вида — `true` (не знаем, что было).
    opaque: bool,
    /// spec 035 (FR-032…FR-035, T054): отметки `range-hold` журнала контейнера — операции (и снимки), в исходных
    /// байтах которых есть непонятное этой версии. Пока отметка накрывает диапазон, заменяющий снимок запрещён.
    holds: Vec<crate::pb::parvane::engine::v1::RangeHold>,
}

/// Итог приёма страницы журнала планировщика (`domain.op.sync`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlannerIngest {
    pub applied: usize,
    pub head_seq: u64,
    pub more: bool,
    /// Операции эпохи без ключа отложены — ждать `container_key` своих устройств.
    pub missing_epoch: Option<u64>,
    /// Журнал грантов отстаёт (эпоха операции новее) — `domain.grant.list`, затем повтор.
    pub grants_behind: bool,
    /// spec 035 (S7-22): курсор внутри обрезанного сервером журнала — `domain.snapshot.get`, затем синк дальше.
    pub need_snapshot: bool,
}

/// Локальная правка: операция с метками (хост хранит до подтверждения сервера).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannerLocalOp {
    pub op_id: Vec<u8>,
    /// Байты `PlannerOp` с метками (открытый текст; шифруется при отправке).
    pub op: Vec<u8>,
    pub applied: usize,
}

/// Ключи контейнера для экспорта линковки (LINK-1 п. 8, spec 010).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannerKeysExport {
    pub domain: String,
    /// hex id контейнера
    pub id: String,
    /// (эпоха, base64 ключа)
    pub keys: Vec<(u64, String)>,
}

#[derive(Serialize, Deserialize)]
struct PersistedPlanner {
    genesis: String,
    grants: Vec<String>,
    keys: Vec<(u64, String)>,
    snapshot: String,
    head_seq: u64,
    snapshot_seq: u64,
    guard_max: u64,
    pending_ops: Vec<String>,
    /// S7-6: операции прежних эпох до неподтверждённой границы и op_id на курсоре (нет поля — прежняя запись).
    #[serde(default)]
    held_ops: Vec<String>,
    #[serde(default)]
    head_op_id: String,
    /// spec 035 (T054): отметки `range-hold` (b64 `RangeHolds`) и «разобрано не всё» с прошлого снимка. Нет поля —
    /// запись прежнего вида: отметок нет (её писала версия, новее которой движков не было), `opaque` — да.
    #[serde(default)]
    holds: String,
    #[serde(default)]
    opaque: Option<bool>,
}

fn b64(x: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(x)
}

fn unb64(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| ProtoError::Malformed)
}

impl Client {
    /// Ключи подписи устройств своего аккаунта → автор (кэш переживает отзыв
    /// устройства: операции отозванного в истории остаются читаемыми).
    fn planner_author_map(&mut self) -> HashMap<[u8; 32], DomainAuthor> {
        // Вышедшие сами устройства — тоже (см. `cloud_author_map`)
        for e in self.own_log.eras.iter().filter(|e| !e.revoked) {
            self.planner_authors.entry(e.key).or_insert_with(|| e.device_id.clone());
        }
        for (id, d) in &self.own_log.devices {
            if let Ok(k) = d.olm_ed25519() {
                self.planner_authors.insert(k, id.clone());
            }
        }
        let me = self.user.clone();
        let aliases = self.former_addresses();
        self.planner_authors
            .iter()
            .map(|(k, d)| (*k, DomainAuthor { user: me.clone(), device_id: d.clone(), aliases: aliases.clone() }))
            .collect()
    }

    pub fn personal_container(&self, kind: Personal) -> Option<Ref> {
        slot_ref!(self, kind).as_ref().and_then(|p| p.access.container.r#ref.clone())
    }

    pub fn personal_is_attached(&self, kind: Personal) -> bool {
        slot_ref!(self, kind).is_some()
    }

    /// Есть ли ключ текущей эпохи (без него писать и читать новое нельзя).
    pub fn personal_has_key(&self, kind: Personal) -> bool {
        slot_ref!(self, kind).as_ref().is_some_and(|p| p.keys.get(p.access.epoch).is_some())
    }

    pub fn personal_head_seq(&self, kind: Personal) -> u64 {
        slot_ref!(self, kind).as_ref().map(|p| p.head_seq).unwrap_or(0)
    }

    /// Сведённое состояние для хоста (JSON, только живые объекты). Пока
    /// ревизия состояния и `head_seq` не менялись — та же строка из кэша.
    pub fn personal_state_json(&self, kind: Personal) -> Option<String> {
        slot_ref!(self, kind).as_ref().map(|p| p.json_cache.get_or(p.state.rev(), p.head_seq, || p.state.state_json(p.head_seq)))
    }

    /// Создать контейнер планировщика: генезис + ключ эпохи 1 → `domain.container.create`.
    /// Повторный вызов при существующем контейнере — `Duplicate`.
    pub fn personal_create(&mut self, kind: Personal, ts_ms: i64) -> CResult<OutRequest> {
        if slot_ref!(self, kind).is_some() {
            return Err(ClientError::Proto(ProtoError::Duplicate));
        }
        let (container, genesis) = dom::new_container(&self.acc, &self.domain, kind.domain(), &self.user, ts_ms)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::from_genesis(&genesis, &resolve)?;
        let mut keys = KeyRing::default();
        keys.insert(dom::FIRST_EPOCH, dom::new_epoch_key());
        debug_assert_eq!(access.container.r#ref, container.r#ref);
        *slot!(self, kind) = Some(PlannerLocal {
            genesis: genesis.clone(),
            grants: vec![],
            access,
            keys,
            guard: DomainGuard::default(),
            state: PersonalState::new(kind),
            head_seq: 0,
            snapshot_seq: 0,
            pending_ops: vec![],
            last_op_epoch: 0,
            json_cache: JsonCache::default(),
            cut: dom::EpochCut::default(),
            opaque: false,
            holds: vec![],
        });
        Ok(OutRequest::id("domain.container.create", &DomainContainerCreateRequest { genesis: Some(genesis) }))
    }

    /// Подключить существующий контейнер (новое устройство): ответы
    /// `domain.container.get` и `domain.grant.list`. Ключи — из ожидающих
    /// (`container_key` своих устройств, экспорт линковки).
    pub fn personal_attach(&mut self, kind: Personal, get_response: &[u8], grants_response: &[u8]) -> CResult<()> {
        let got: DomainContainerGetResponse = decode_checked(get_response, Origin::Server)?;
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        let genesis = got.genesis.ok_or(ProtoError::InvalidField("genesis"))?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::replay(&genesis, &grants.entries, &resolve, &no_groups)?;
        if access.container.domain != kind.domain() || !self.is_own_address(&access.owner) {
            return Err(ClientError::Proto(ProtoError::ContextMismatch));
        }
        if let Some(p) = slot_ref!(self, kind) {
            if p.access.container.r#ref != access.container.r#ref {
                return Err(ClientError::Proto(ProtoError::ContextMismatch));
            }
        }
        let existing = slot!(self, kind).take();
        let local = PlannerLocal {
            genesis,
            grants: grants.entries,
            access,
            keys: existing.as_ref().map(|p| p.keys.clone()).unwrap_or_default(),
            guard: existing.as_ref().map(|p| p.guard.clone()).unwrap_or_default(),
            state: existing.as_ref().map(|p| p.state.clone()).unwrap_or_else(|| PersonalState::new(kind)),
            head_seq: existing.as_ref().map(|p| p.head_seq).unwrap_or(0),
            snapshot_seq: existing.as_ref().map(|p| p.snapshot_seq).unwrap_or(0),
            cut: existing.as_ref().map(|p| p.cut.clone()).unwrap_or_default(),
            opaque: existing.as_ref().is_none_or(|p| p.opaque),
            holds: existing.as_ref().map(|p| p.holds.clone()).unwrap_or_default(),
            pending_ops: existing.map(|p| p.pending_ops).unwrap_or_default(),
            last_op_epoch: 0,
            json_cache: JsonCache::default(),
        };
        *slot!(self, kind) = Some(local);
        self.personal_absorb_pending_keys(kind);
        Ok(())
    }

    /// Принять ключи, ждавшие контейнера или журнала грантов: доверенные (из
    /// экспорта линковки) и присланные своими устройствами (`container_key`,
    /// чья голова журнала грантов была новее нашей). Непринятые остаются ждать.
    fn personal_absorb_pending_keys(&mut self, kind: Personal) {
        let me = self.identity_names(&self.user.clone());
        let Some(p) = slot!(self, kind).as_mut() else { return };
        let trusted = std::mem::take(&mut self.planner_trusted_keys);
        for (d, id, epoch, key) in trusted {
            let matches = p.access.container.domain == d && p.access.container.r#ref.as_ref().is_some_and(|r| r.id == id);
            if matches && epoch >= dom::FIRST_EPOCH && epoch <= p.access.epoch {
                p.keys.insert(epoch, Zeroizing::new(key));
            } else if matches || Personal::of_domain(&d).is_some_and(|k| k != kind) {
                // Эпоха впереди журнала грантов либо ключ другого личного контейнера — ждёт дальше
                self.planner_trusted_keys.push((d, id, epoch, key));
            }
        }
        let shares = std::mem::take(&mut self.planner_pending_keys);
        for share in shares {
            // Ключ другого личного контейнера ждёт своего подключения
            if share.domain != kind.domain() {
                self.planner_pending_keys.push(share);
                continue;
            }
            match p.access.accept_key_share_any(&share, &me, &no_groups) {
                Ok((epoch, key)) => {
                    p.keys.insert(epoch, key);
                }
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => self.planner_pending_keys.push(share),
                Err(_) => {}
            }
        }
        self.personal_retry_pending(kind);
    }

    /// Догнать журнал грантов (смена эпохи другим устройством): новые записи после известной версии.
    pub fn personal_ingest_grants(&mut self, kind: Personal, grants_response: &[u8]) -> CResult<u64> {
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        for e in grants.entries {
            if p.access.apply(&e, &resolve, &no_groups).is_ok() {
                p.grants.push(e);
            }
        }
        let version = p.access.version;
        self.personal_absorb_pending_keys(kind);
        Ok(version)
    }

    /// Принятая операция: ждёт ключа своей эпохи либо применяется.
    fn planner_take(p: &mut PlannerLocal, op: ContainerOp, author_device: &str, out: &mut PlannerIngest, last_error: &mut Option<ProtoError>) {
        p.last_op_epoch = p.last_op_epoch.max(op.key_epoch);
        if p.keys.get(op.key_epoch).is_none() {
            out.missing_epoch = Some(op.key_epoch);
            p.pending_ops.push(op);
            return;
        }
        match Self::planner_open_one(p, &op, author_device) {
            Ok(n) => out.applied += n,
            Err(e) => *last_error = Some(e),
        }
    }

    fn planner_open_one(p: &mut PlannerLocal, op: &ContainerOp, author_device: &str) -> Result<usize> {
        let key = p.keys.get(op.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_op(op, &p.access.container, key)?;
        // Непонятое в снимок из разобранного не войдёт — отметка диапазона запрещает заменяющий снимок (FR-032)
        let journal = dom::hold_journal(&p.access.container);
        if crate::hold::note(&mut p.holds, &journal, p.state.op_type(), op.seq, op.seq, &pt) {
            p.opaque = true;
        }
        p.state.open_op(&mut p.guard, &pt, author_device, &mut p.opaque)
    }

    /// Применить отложенные операции, для которых появился ключ.
    fn personal_retry_pending(&mut self, kind: Personal) -> usize {
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let Some(p) = slot!(self, kind).as_mut() else { return 0 };
        let pending = std::mem::take(&mut p.pending_ops);
        let mut applied = 0;
        for op in pending {
            if p.keys.get(op.key_epoch).is_none() {
                p.pending_ops.push(op);
                continue;
            }
            if let Ok(a) = p.access.check_op_author(&op, &resolve, &no_groups) {
                applied += Self::planner_open_one(p, &op, &a.device_id).unwrap_or(0);
            }
        }
        applied
    }

    /// Страница журнала контейнера (`domain.op.sync`): проверка автора,
    /// расшифровка, применение в порядке seq. Свои операции (уже применённые
    /// локально) идемпотентны. Негодная запись пропускается, курсор идёт дальше.
    pub fn personal_ingest_sync(&mut self, kind: Personal, sync_response: &[u8]) -> CResult<PlannerIngest> {
        let r: DomainOpSyncResponse = decode_checked(sync_response, Origin::Server)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let mut out = PlannerIngest { more: r.more, ..Default::default() };
        // spec 035 (S7-22): сервер обрезал журнал дальше курсора — сначала снимок (`domain.snapshot.get`)
        if r.truncated_upto > p.head_seq {
            out.need_snapshot = true;
            out.more = false;
            out.head_seq = p.head_seq;
            return Ok(out);
        }
        for op in r.ops {
            if op.seq <= p.head_seq {
                continue;
            }
            // S7-6: граница эпохи по подписанному op_id — сдвиг журнала сервером виден и новому читателю
            let verdict = p.access.op_boundary_verdict(&op);
            match verdict {
                dom::BoundaryVerdict::Tampered => {
                    p.cut.held.clear();
                    self.last_error = Some(ProtoError::ContextMismatch);
                    p.head_seq = op.seq;
                    p.cut.note_head(&op, false);
                    continue;
                }
                dom::BoundaryVerdict::Confirms(_) => {
                    for h in std::mem::take(&mut p.cut.held) {
                        if let Ok(a) = p.access.check_op_author(&h, &resolve, &no_groups) {
                            Self::planner_take(p, h, &a.device_id, &mut out, &mut self.last_error);
                        }
                    }
                }
                _ => {}
            }
            match p.access.check_op_author(&op, &resolve, &no_groups) {
                Ok(_) if op.key_epoch < p.last_op_epoch => {
                    // Эпоха убывает вдоль журнала: операция вставлена ключом, уже сменённым ротацией
                    self.last_error = Some(ProtoError::Forbidden);
                    p.head_seq = op.seq;
                    p.cut.note_head(&op, true);
                }
                Ok(_) if matches!(verdict, dom::BoundaryVerdict::Hold(_)) => {
                    p.head_seq = op.seq;
                    p.cut.note_head(&op, true);
                    p.last_op_epoch = p.last_op_epoch.max(op.key_epoch);
                    p.cut.held.push(op);
                }
                Ok(a) => {
                    p.head_seq = op.seq;
                    p.cut.note_head(&op, true);
                    Self::planner_take(p, op, &a.device_id, &mut out, &mut self.last_error);
                }
                Err(ProtoError::Expired) => {
                    // Эпоха новее журнала грантов — догнать гранты и повторить страницу.
                    out.grants_behind = true;
                    out.more = true;
                    break;
                }
                Err(e) => {
                    p.cut.note_head(&op, e == ProtoError::Forbidden);
                    self.last_error = Some(e);
                    p.head_seq = op.seq;
                }
            }
        }
        out.head_seq = p.head_seq;
        Ok(out)
    }

    /// Снимок контейнера (`domain.snapshot.get`): слить, сдвинуть курсор.
    pub fn personal_ingest_snapshot(&mut self, kind: Personal, snapshot_response: &[u8]) -> CResult<u64> {
        let r: DomainSnapshotGetResponse = decode_checked(snapshot_response, Origin::Server)?;
        let Some(s) = r.snapshot else { return Ok(self.personal_head_seq(kind)) };
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        p.access.check_snapshot_author(&s, &resolve, &no_groups)?;
        let key = p.keys.get(s.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_snapshot(&s, &p.access.container, key)?;
        // Снимок составителя новее этой версии: его непонятое накрывает весь диапазон снимка (FR-032)
        let journal = dom::hold_journal(&p.access.container);
        // Разбор — до отметки: неразбираемый снимок отметок не оставляет
        let mut probe = p.state.clone();
        let mut probe_guard = p.guard.clone();
        probe.merge_snapshot(&mut probe_guard, &pt, s.upto_seq)?;
        crate::hold::note(&mut p.holds, &journal, p.state.snapshot_type(), 1, s.upto_seq.max(1), &pt);
        // Метки снимка — в часы до слияния (иначе свои следующие метки могут оказаться ниже, а метка
        // u64::MAX навсегда победила бы); негодная метка — отказ всему снимку.
        p.state = probe;
        p.guard = probe_guard;
        p.cut.note_snapshot(s.upto_seq, p.head_seq);
        if s.upto_seq > p.head_seq {
            p.head_seq = s.upto_seq;
        }
        p.snapshot_seq = p.snapshot_seq.max(s.upto_seq);
        Ok(p.head_seq)
    }

    /// Локальная правка хоста (JSON изменений): метки движка, применение
    /// сразу (офлайн-first), байты операции — хосту в очередь отправки.
    pub fn personal_prepare_local(&mut self, kind: Personal, changes_json: &str) -> CResult<PlannerLocalOp> {
        let dev = self.device_id.clone();
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let (op, applied) = p.state.prepare_local(&mut p.guard, changes_json, &dev)?;
        Ok(PlannerLocalOp { op_id: sign::new_op_id(), op, applied })
    }

    /// Применить локально уже помеченную операцию (повтор после перезапуска хоста
    /// из очереди отправки): идемпотентно.
    pub fn personal_apply_local(&mut self, kind: Personal, op_bytes: &[u8]) -> CResult<usize> {
        let dev = self.device_id.clone();
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        Ok(p.state.apply_local(&mut p.guard, op_bytes, &dev)?)
    }

    /// Зашифровать операцию ключом текущей эпохи → `domain.op.append`
    /// (тот же `op_id` при повторе — сервер ответит DUPLICATE).
    pub fn personal_seal(&mut self, kind: Personal, op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        let p = slot_ref!(self, kind).as_ref().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let epoch = p.access.epoch;
        let key = p.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        let sealed = dom::seal_op_with_id(&self.acc, &p.access.container, epoch, key, op_bytes, ts_ms, op_id)?;
        Ok(OutRequest::id("domain.op.append", &DomainOpAppendRequest { op: Some(sealed) }))
    }

    /// Снимок по порогу (R5): после `SNAPSHOT_EVERY` операций с прошлого снимка.
    pub fn personal_snapshot_request(&mut self, kind: Personal, ts_ms: i64) -> CResult<Option<OutRequest>> {
        let p = slot!(self, kind).as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        // Операции, ждущие ключа эпохи, в снимок не входят, а курсор их уже прошёл — снимок их потерял бы.
        if p.head_seq < p.snapshot_seq.saturating_add(kind.snapshot_every()) || !p.pending_ops.is_empty() || !p.cut.held.is_empty() {
            return Ok(None);
        }
        let epoch = p.access.epoch;
        let key = p.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        // FR-035: заменяющий снимок над непонятым запрещён — журнал остаётся источником (исход 2 FR-034)
        let pt = match p.state.replacement_snapshot(&p.holds, &p.access.container, p.head_seq) {
            Ok(bytes) => bytes,
            Err(ProtoError::RangeHeld) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if pt.len() > dom::MAX_SNAPSHOT_PLAINTEXT {
            return Err(ClientError::Proto(ProtoError::FieldLimit("snapshot")));
        }
        // `complete` (FR-032, FR-077): ничего не отложено и не удержано (проверено выше), отметок `range-hold` в
        // диапазоне нет (снимок разрешён выше) и каждая операция диапазона разобрана.
        let complete = !p.opaque && dom::replacement_allowed(&p.holds, &p.access.container, p.head_seq).is_ok();
        let s = dom::seal_snapshot_complete(&self.acc, &p.access.container, epoch, key, p.head_seq, &pt, ts_ms, complete)?;
        p.snapshot_seq = p.head_seq;
        p.opaque = false;
        Ok(Some(OutRequest::id("domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s) })))
    }

    /// Размер открытого текста снимка — для предупреждения о потолке (FR-012).
    pub fn personal_size(&self, kind: Personal) -> usize {
        slot_ref!(self, kind).as_ref().map(|p| p.state.size_estimate()).unwrap_or(0)
    }

    fn personal_key_content(&self, kind: Personal) -> Option<Content> {
        let p = slot_ref!(self, kind).as_ref()?;
        let (epoch, key) = p.keys.latest()?;
        let share = p.access.key_share(epoch, key).ok()?;
        Some(Content { kind: Some(content::Kind::ContainerKey(share)), ..Default::default() })
    }

    /// Раздать ключ текущей эпохи своим устройствам (после создания контейнера,
    /// смены эпохи; новым устройствам — вместе с группами, T142).
    pub fn share_personal_with_own_devices(&mut self, kind: Personal) -> CResult<Vec<OutRequest>> {
        let Some(c) = self.personal_key_content(kind) else { return Ok(vec![]) };
        Ok(self.seal_to_own_devices(&c)?.into_iter().collect())
    }

    /// Ключ контейнера от своего устройства (`Content.container_key`).
    fn personal_accept_key(&mut self, sender: &str, share: &ContainerKeyShare, seq: u64) -> Vec<Event> {
        let Some(kind) = Personal::of_domain(&share.domain).filter(|_| self.is_own_address(sender)) else {
            return vec![Event::Skipped { seq }];
        };
        let me = self.identity_names(&self.user.clone());
        if let Some(p) = slot!(self, kind).as_mut() {
            match p.access.accept_key_share_any(share, &me, &no_groups) {
                Ok((epoch, key)) => {
                    p.keys.insert(epoch, key);
                    self.personal_retry_pending(kind);
                    let head = self.personal_head_seq(kind);
                    return vec![kind.changed(seq, head)];
                }
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => {
                    // Журнал грантов раздающего новее нашего — догнать и принять позже.
                    self.planner_pending_keys.push(share.clone());
                    return vec![kind.changed(seq, self.personal_head_seq(kind))];
                }
                Err(e) => {
                    self.last_error = Some(e);
                    return vec![Event::Skipped { seq }];
                }
            }
        }
        // Контейнер ещё не подключён: хост найдёт его (`domain.container.list`) и подключит.
        if self.planner_pending_keys.len() < 16 {
            self.planner_pending_keys.push(share.clone());
        }
        vec![kind.changed(seq, 0)]
    }

    /// Смена эпохи при отзыве своего устройства (REVOKE-1): запись «rotate»,
    /// новый ключ, раздача оставшимся своим устройствам.
    fn personal_rotate_on_revoke(&mut self, kind: Personal, ts_ms: i64) -> CResult<Vec<OutRequest>> {
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let Some(p) = slot!(self, kind).as_mut() else { return Ok(vec![]) };
        if p.keys.get(p.access.epoch).is_none() {
            return Ok(vec![]);
        }
        let rotate = dom::sign_rotate_cut(&self.acc, &p.access, ts_ms, Some(&p.cut.boundary(p.head_seq)))?;
        p.access.apply(&rotate, &resolve, &no_groups)?;
        p.grants.push(rotate.clone());
        p.keys.insert(p.access.epoch, dom::new_epoch_key());
        let mut out = vec![OutRequest::id("domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(rotate) })];
        out.extend(self.share_personal_with_own_devices(kind)?);
        Ok(out)
    }

    /// Ключи контейнера для экспорта линковки (новому устройству).
    pub fn personal_keys_export(&self, kind: Personal) -> Option<PlannerKeysExport> {
        let p = slot_ref!(self, kind).as_ref()?;
        let r = p.access.container.r#ref.as_ref()?;
        let mut keys: Vec<(u64, String)> = Vec::new();
        for epoch in dom::FIRST_EPOCH..=p.access.epoch {
            if let Some(k) = p.keys.get(epoch) {
                keys.push((epoch, b64(k)));
            }
        }
        Some(PlannerKeysExport { domain: p.access.container.domain.clone(), id: hex::encode(&r.id), keys })
    }

    /// Ключи из экспорта линковки своего устройства: ждут подключения контейнера.
    pub fn planner_keys_import(&mut self, export: &PlannerKeysExport) -> Result<()> {
        let id = hex::decode(&export.id).map_err(|_| ProtoError::Malformed)?;
        for (epoch, key) in &export.keys {
            let k: [u8; 32] = unb64(key)?.as_slice().try_into().map_err(|_| ProtoError::Malformed)?;
            if self.planner_trusted_keys.len() < 256 {
                self.planner_trusted_keys.push((export.domain.clone(), id.clone(), *epoch, k));
            }
        }
        for kind in Personal::ALL {
            self.personal_absorb_pending_keys(kind);
        }
        Ok(())
    }

    fn personal_persist(&self, kind: Personal) -> Option<PersistedPlanner> {
        let p = slot_ref!(self, kind).as_ref()?;
        let mut keys = vec![];
        for epoch in dom::FIRST_EPOCH..=p.access.epoch {
            if let Some(k) = p.keys.get(epoch) {
                keys.push((epoch, b64(k)));
            }
        }
        Some(PersistedPlanner {
            genesis: b64(&p.genesis.encode_to_vec()),
            grants: p.grants.iter().map(|g| b64(&g.encode_to_vec())).collect(),
            keys,
            snapshot: b64(&p.state.snapshot_bytes()),
            head_seq: p.head_seq,
            snapshot_seq: p.snapshot_seq,
            guard_max: p.guard.max_seen(),
            pending_ops: p.pending_ops.iter().map(|o| b64(&o.encode_to_vec())).collect(),
            held_ops: p.cut.held.iter().map(|o| b64(&o.encode_to_vec())).collect(),
            head_op_id: b64(&p.cut.head_op_id),
            holds: b64(&crate::hold::encode(&p.holds)),
            opaque: Some(p.opaque),
        })
    }

    fn personal_restore(&mut self, kind: Personal, pp: &PersistedPlanner) -> Result<()> {
        let genesis = SignedOp::decode(unb64(&pp.genesis)?.as_slice()).map_err(|_| ProtoError::Malformed)?;
        let grants = pp.grants.iter().map(|g| SignedOp::decode(unb64(g)?.as_slice()).map_err(|_| ProtoError::Malformed)).collect::<Result<Vec<_>>>()?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::replay(&genesis, &grants, &resolve, &no_groups)?;
        let mut keys = KeyRing::default();
        for (epoch, k) in &pp.keys {
            let arr: [u8; 32] = unb64(k)?.as_slice().try_into().map_err(|_| ProtoError::Malformed)?;
            keys.insert(*epoch, Zeroizing::new(arr));
        }
        let state = PersonalState::from_snapshot_bytes(kind, &unb64(&pp.snapshot)?)?;
        let mut guard = DomainGuard::default();
        if pp.guard_max > 0 {
            let _ = guard.check(&dom::Stamp::new(pp.guard_max.min(dom::LAMPORT_MAX_JUMP), "restore"));
            // Поднять до сохранённого максимума шагами в пределах допустимого скачка.
            while guard.max_seen() < pp.guard_max {
                let next = (guard.max_seen() + dom::LAMPORT_MAX_JUMP).min(pp.guard_max);
                let _ = guard.check(&dom::Stamp::new(next, "restore"));
            }
        }
        let pending_ops = pp.pending_ops.iter().map(|o| ContainerOp::decode(unb64(o)?.as_slice()).map_err(|_| ProtoError::Malformed)).collect::<Result<Vec<_>>>()?;
        let held = pp.held_ops.iter().map(|o| ContainerOp::decode(unb64(o)?.as_slice()).map_err(|_| ProtoError::Malformed)).collect::<Result<Vec<_>>>()?;
        let cut = dom::EpochCut { held, head_op_id: unb64(&pp.head_op_id)? };
        let holds = if pp.holds.is_empty() { vec![] } else { crate::hold::decode(&unb64(&pp.holds)?)? };
        let opaque = pp.opaque.unwrap_or(true);
        *slot!(self, kind) = Some(PlannerLocal { genesis, grants, access, keys, guard, state, head_seq: pp.head_seq, snapshot_seq: pp.snapshot_seq, pending_ops, last_op_epoch: 0, json_cache: JsonCache::default(), cut, opaque, holds });
        Ok(())
    }
    pub fn share_planner_with_own_devices(&mut self) -> CResult<Vec<OutRequest>> {
        self.share_personal_with_own_devices(Personal::Planner)
    }
    pub fn share_health_with_own_devices(&mut self) -> CResult<Vec<OutRequest>> {
        self.share_personal_with_own_devices(Personal::Health)
    }
    pub fn share_music_with_own_devices(&mut self) -> CResult<Vec<OutRequest>> {
        self.share_personal_with_own_devices(Personal::Music)
    }
    /// Ключи «Здоровья» из экспорта линковки: запись несёт домен, общий приём разложит по контейнерам.
    pub fn health_keys_import(&mut self, export: &PlannerKeysExport) -> Result<()> {
        self.planner_keys_import(export)
    }
    pub fn music_keys_import(&mut self, export: &PlannerKeysExport) -> Result<()> {
        self.planner_keys_import(export)
    }
    /// Ключи текущих эпох личных контейнеров — новым своим устройствам (T142).
    fn personal_key_contents(&self) -> Vec<Content> {
        Personal::ALL.into_iter().filter_map(|k| self.personal_key_content(k)).collect()
    }
    /// Смена эпохи личных контейнеров при отзыве своего устройства (REVOKE-1).
    fn personal_rotate_all_on_revoke(&mut self, ts_ms: i64) -> Vec<OutRequest> {
        let mut out = Vec::new();
        for kind in Personal::ALL {
            match self.personal_rotate_on_revoke(kind, ts_ms) {
                Ok(r) => out.extend(r),
                Err(ClientError::Proto(e)) => self.last_error = Some(e),
                Err(ClientError::Need(_)) => {}
            }
        }
        out
    }

    // ── обёртки по доменам: планировщик (spec 010) и «Здоровье» (spec 038) ──
    pub fn planner_container(&self) -> Option<Ref> {
        self.personal_container(Personal::Planner)
    }
    pub fn planner_is_attached(&self) -> bool {
        self.personal_is_attached(Personal::Planner)
    }
    pub fn planner_has_key(&self) -> bool {
        self.personal_has_key(Personal::Planner)
    }
    pub fn planner_head_seq(&self) -> u64 {
        self.personal_head_seq(Personal::Planner)
    }
    pub fn planner_state_json(&self) -> Option<String> {
        self.personal_state_json(Personal::Planner)
    }
    pub fn planner_create(&mut self, ts_ms: i64) -> CResult<OutRequest> {
        self.personal_create(Personal::Planner, ts_ms)
    }
    pub fn planner_attach(&mut self, get_response: &[u8], grants_response: &[u8]) -> CResult<()> {
        self.personal_attach(Personal::Planner, get_response, grants_response)
    }
    pub fn planner_ingest_grants(&mut self, grants_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_grants(Personal::Planner, grants_response)
    }
    pub fn planner_ingest_sync(&mut self, sync_response: &[u8]) -> CResult<PlannerIngest> {
        self.personal_ingest_sync(Personal::Planner, sync_response)
    }
    pub fn planner_ingest_snapshot(&mut self, snapshot_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_snapshot(Personal::Planner, snapshot_response)
    }
    pub fn planner_prepare_local(&mut self, changes_json: &str) -> CResult<PlannerLocalOp> {
        self.personal_prepare_local(Personal::Planner, changes_json)
    }
    pub fn planner_apply_local(&mut self, op_bytes: &[u8]) -> CResult<usize> {
        self.personal_apply_local(Personal::Planner, op_bytes)
    }
    pub fn planner_seal(&mut self, op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        self.personal_seal(Personal::Planner, op_bytes, op_id, ts_ms)
    }
    pub fn planner_snapshot_request(&mut self, ts_ms: i64) -> CResult<Option<OutRequest>> {
        self.personal_snapshot_request(Personal::Planner, ts_ms)
    }
    pub fn planner_size(&self) -> usize {
        self.personal_size(Personal::Planner)
    }
    pub fn planner_keys_export(&self) -> Option<PlannerKeysExport> {
        self.personal_keys_export(Personal::Planner)
    }
    pub fn health_container(&self) -> Option<Ref> {
        self.personal_container(Personal::Health)
    }
    pub fn health_is_attached(&self) -> bool {
        self.personal_is_attached(Personal::Health)
    }
    pub fn health_has_key(&self) -> bool {
        self.personal_has_key(Personal::Health)
    }
    pub fn health_head_seq(&self) -> u64 {
        self.personal_head_seq(Personal::Health)
    }
    pub fn health_state_json(&self) -> Option<String> {
        self.personal_state_json(Personal::Health)
    }
    /// Изменения для записи разобранных записей: id, сведение «лёг» и «встал» в один сон. Контейнера ещё нет —
    /// считается от пустого состояния.
    pub fn health_compose_json(&self, parsed: &[serde_json::Value], now_ms: i64) -> String {
        let composed = self.health.as_ref().and_then(|p| p.state.health_compose(parsed, now_ms));
        composed.unwrap_or_else(|| crate::domain::health_view::compose_changes(&Default::default(), parsed, now_ms)).to_string()
    }
    /// Сводка для экранов «Здоровья» на момент `now_ms` в поясе `tz_min` (HEALTH-3).
    /// Контейнера ещё нет (первое открытие) — сводка пустого состояния.
    pub fn health_view_json(&self, now_ms: i64, tz_min: i32) -> String {
        let view = self.health.as_ref().and_then(|p| p.state.health_view(now_ms, tz_min));
        view.unwrap_or_else(|| crate::domain::health_view::view_json(&Default::default(), now_ms, tz_min))
    }
    /// Записи вида новыми первыми, не больше `limit` (HEALTH-3): подробный экран показывает их страницами.
    pub fn health_entries_json(&self, kind: &str, limit: usize, now_ms: i64, tz_min: i32) -> String {
        let page = self.health.as_ref().and_then(|p| p.state.health_entries(kind, limit, now_ms, tz_min));
        page.unwrap_or_else(|| crate::domain::health_form::entries_json(&Default::default(), kind, limit, now_ms, tz_min))
    }
    /// Сны, приёмы пищи и тренировки по дням отрезка — календарю «Плана» (spec 041 B4).
    pub fn health_days_json(&self, from_day: &str, to_day: &str) -> String {
        let days = self.health.as_ref().and_then(|p| p.state.health_days(from_day, to_day));
        days.unwrap_or_else(|| crate::domain::health_day::days_json(&Default::default(), from_day, to_day))
    }
    pub fn health_create(&mut self, ts_ms: i64) -> CResult<OutRequest> {
        self.personal_create(Personal::Health, ts_ms)
    }
    pub fn health_attach(&mut self, get_response: &[u8], grants_response: &[u8]) -> CResult<()> {
        self.personal_attach(Personal::Health, get_response, grants_response)
    }
    pub fn health_ingest_grants(&mut self, grants_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_grants(Personal::Health, grants_response)
    }
    pub fn health_ingest_sync(&mut self, sync_response: &[u8]) -> CResult<PlannerIngest> {
        self.personal_ingest_sync(Personal::Health, sync_response)
    }
    pub fn health_ingest_snapshot(&mut self, snapshot_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_snapshot(Personal::Health, snapshot_response)
    }
    pub fn health_prepare_local(&mut self, changes_json: &str) -> CResult<PlannerLocalOp> {
        self.personal_prepare_local(Personal::Health, changes_json)
    }
    pub fn health_apply_local(&mut self, op_bytes: &[u8]) -> CResult<usize> {
        self.personal_apply_local(Personal::Health, op_bytes)
    }
    pub fn health_seal(&mut self, op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        self.personal_seal(Personal::Health, op_bytes, op_id, ts_ms)
    }
    pub fn health_snapshot_request(&mut self, ts_ms: i64) -> CResult<Option<OutRequest>> {
        self.personal_snapshot_request(Personal::Health, ts_ms)
    }
    pub fn health_size(&self) -> usize {
        self.personal_size(Personal::Health)
    }
    pub fn health_keys_export(&self) -> Option<PlannerKeysExport> {
        self.personal_keys_export(Personal::Health)
    }
    pub fn music_container(&self) -> Option<Ref> {
        self.personal_container(Personal::Music)
    }
    pub fn music_is_attached(&self) -> bool {
        self.personal_is_attached(Personal::Music)
    }
    pub fn music_has_key(&self) -> bool {
        self.personal_has_key(Personal::Music)
    }
    pub fn music_head_seq(&self) -> u64 {
        self.personal_head_seq(Personal::Music)
    }
    /// Плейлисты для экранов (MUSIC-2). Контейнера ещё нет — пустое состояние.
    pub fn music_state_json(&self) -> String {
        self.personal_state_json(Personal::Music).unwrap_or_else(|| music_json::state_json(&Default::default(), 0))
    }
    /// Действие пользователя над плейлистами → изменения для `music_prepare_local` (MUSIC-2).
    /// Контейнера ещё нет — считается от пустого состояния (первым действием может быть только создание).
    pub fn music_compose_json(&self, action: &serde_json::Value, now_ms: i64) -> Result<String> {
        let empty = music::MusicState::default();
        let state = match self.music.as_ref().map(|p| &p.state) {
            Some(PersonalState::Music(st)) => st,
            _ => &empty,
        };
        music_json::compose(state, action, now_ms, music_json::new_id).map(|v| v.to_string())
    }
    pub fn music_create(&mut self, ts_ms: i64) -> CResult<OutRequest> {
        self.personal_create(Personal::Music, ts_ms)
    }
    pub fn music_attach(&mut self, get_response: &[u8], grants_response: &[u8]) -> CResult<()> {
        self.personal_attach(Personal::Music, get_response, grants_response)
    }
    pub fn music_ingest_grants(&mut self, grants_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_grants(Personal::Music, grants_response)
    }
    pub fn music_ingest_sync(&mut self, sync_response: &[u8]) -> CResult<PlannerIngest> {
        self.personal_ingest_sync(Personal::Music, sync_response)
    }
    pub fn music_ingest_snapshot(&mut self, snapshot_response: &[u8]) -> CResult<u64> {
        self.personal_ingest_snapshot(Personal::Music, snapshot_response)
    }
    pub fn music_prepare_local(&mut self, changes_json: &str) -> CResult<PlannerLocalOp> {
        self.personal_prepare_local(Personal::Music, changes_json)
    }
    pub fn music_apply_local(&mut self, op_bytes: &[u8]) -> CResult<usize> {
        self.personal_apply_local(Personal::Music, op_bytes)
    }
    pub fn music_seal(&mut self, op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        self.personal_seal(Personal::Music, op_bytes, op_id, ts_ms)
    }
    pub fn music_snapshot_request(&mut self, ts_ms: i64) -> CResult<Option<OutRequest>> {
        self.personal_snapshot_request(Personal::Music, ts_ms)
    }
    pub fn music_size(&self) -> usize {
        self.personal_size(Personal::Music)
    }
    pub fn music_keys_export(&self) -> Option<PlannerKeysExport> {
        self.personal_keys_export(Personal::Music)
    }
}
