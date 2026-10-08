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

use crate::domain::{self as dom, no_groups, planner, planner_json, Author as DomainAuthor, ContainerAccess, KeyRing, LamportGuard as DomainGuard};
use crate::pb::parvane::core::v2::{
    ContainerKeyShare, ContainerOp, DomainContainerCreateRequest, DomainContainerGetResponse, DomainGrantListResponse,
    DomainKeyRotateRequest, DomainOpAppendRequest, DomainOpSyncResponse, DomainSnapshotGetResponse,
    DomainSnapshotPutRequest,
};

/// Локальное состояние контейнера планировщика.
#[derive(Debug, Clone, PartialEq)]
struct PlannerLocal {
    genesis: SignedOp,
    grants: Vec<SignedOp>,
    access: ContainerAccess,
    keys: KeyRing,
    guard: DomainGuard,
    state: planner::PlannerState,
    head_seq: u64,
    snapshot_seq: u64,
    /// Операции журнала, ждущие ключа своей эпохи (в порядке seq).
    pending_ops: Vec<ContainerOp>,
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
        for (id, d) in &self.own_log.devices {
            if let Ok(k) = d.olm_ed25519() {
                self.planner_authors.insert(k, id.clone());
            }
        }
        let me = self.user.clone();
        self.planner_authors.iter().map(|(k, d)| (*k, DomainAuthor { user: me.clone(), device_id: d.clone() })).collect()
    }

    pub fn planner_container(&self) -> Option<Ref> {
        self.planner.as_ref().and_then(|p| p.access.container.r#ref.clone())
    }

    pub fn planner_is_attached(&self) -> bool {
        self.planner.is_some()
    }

    /// Есть ли ключ текущей эпохи (без него писать и читать новое нельзя).
    pub fn planner_has_key(&self) -> bool {
        self.planner.as_ref().is_some_and(|p| p.keys.get(p.access.epoch).is_some())
    }

    pub fn planner_head_seq(&self) -> u64 {
        self.planner.as_ref().map(|p| p.head_seq).unwrap_or(0)
    }

    /// Сведённое состояние для хоста (JSON, только живые объекты).
    pub fn planner_state_json(&self) -> Option<String> {
        self.planner.as_ref().map(|p| planner_json::state_json(&p.state, p.head_seq))
    }

    /// Создать контейнер планировщика: генезис + ключ эпохи 1 → `domain.container.create`.
    /// Повторный вызов при существующем контейнере — `Duplicate`.
    pub fn planner_create(&mut self, ts_ms: i64) -> CResult<OutRequest> {
        if self.planner.is_some() {
            return Err(ClientError::Proto(ProtoError::Duplicate));
        }
        let (container, genesis) = dom::new_container(&self.acc, &self.domain, planner::DOMAIN_NAME, &self.user, ts_ms)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::from_genesis(&genesis, &resolve)?;
        let mut keys = KeyRing::default();
        keys.insert(dom::FIRST_EPOCH, dom::new_epoch_key());
        debug_assert_eq!(access.container.r#ref, container.r#ref);
        self.planner = Some(PlannerLocal {
            genesis: genesis.clone(),
            grants: vec![],
            access,
            keys,
            guard: DomainGuard::default(),
            state: planner::PlannerState::default(),
            head_seq: 0,
            snapshot_seq: 0,
            pending_ops: vec![],
        });
        Ok(OutRequest::id("domain.container.create", &DomainContainerCreateRequest { genesis: Some(genesis) }))
    }

    /// Подключить существующий контейнер (новое устройство): ответы
    /// `domain.container.get` и `domain.grant.list`. Ключи — из ожидающих
    /// (`container_key` своих устройств, экспорт линковки).
    pub fn planner_attach(&mut self, get_response: &[u8], grants_response: &[u8]) -> CResult<()> {
        let got: DomainContainerGetResponse = decode_checked(get_response, Origin::Server)?;
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        let genesis = got.genesis.ok_or(ProtoError::InvalidField("genesis"))?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::replay(&genesis, &grants.entries, &resolve, &no_groups)?;
        if access.container.domain != planner::DOMAIN_NAME || access.owner != self.user {
            return Err(ClientError::Proto(ProtoError::ContextMismatch));
        }
        if let Some(p) = &self.planner {
            if p.access.container.r#ref != access.container.r#ref {
                return Err(ClientError::Proto(ProtoError::ContextMismatch));
            }
        }
        let existing = self.planner.take();
        let local = PlannerLocal {
            genesis,
            grants: grants.entries,
            access,
            keys: existing.as_ref().map(|p| p.keys.clone()).unwrap_or_default(),
            guard: existing.as_ref().map(|p| p.guard.clone()).unwrap_or_default(),
            state: existing.as_ref().map(|p| p.state.clone()).unwrap_or_default(),
            head_seq: existing.as_ref().map(|p| p.head_seq).unwrap_or(0),
            snapshot_seq: existing.as_ref().map(|p| p.snapshot_seq).unwrap_or(0),
            pending_ops: existing.map(|p| p.pending_ops).unwrap_or_default(),
        };
        self.planner = Some(local);
        self.planner_absorb_pending_keys();
        Ok(())
    }

    /// Принять ключи, ждавшие контейнера или журнала грантов: доверенные (из
    /// экспорта линковки) и присланные своими устройствами (`container_key`,
    /// чья голова журнала грантов была новее нашей). Непринятые остаются ждать.
    fn planner_absorb_pending_keys(&mut self) {
        let me = self.user.clone();
        let Some(p) = self.planner.as_mut() else { return };
        let trusted = std::mem::take(&mut self.planner_trusted_keys);
        for (d, id, epoch, key) in trusted {
            let matches = p.access.container.domain == d && p.access.container.r#ref.as_ref().is_some_and(|r| r.id == id);
            if matches && epoch >= dom::FIRST_EPOCH && epoch <= p.access.epoch {
                p.keys.insert(epoch, Zeroizing::new(key));
            } else if matches {
                self.planner_trusted_keys.push((d, id, epoch, key));
            }
        }
        let shares = std::mem::take(&mut self.planner_pending_keys);
        for share in shares {
            match p.access.accept_key_share(&share, &me, &no_groups) {
                Ok((epoch, key)) => {
                    p.keys.insert(epoch, key);
                }
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => self.planner_pending_keys.push(share),
                Err(_) => {}
            }
        }
        self.planner_retry_pending();
    }

    /// Догнать журнал грантов (смена эпохи другим устройством): новые записи после известной версии.
    pub fn planner_ingest_grants(&mut self, grants_response: &[u8]) -> CResult<u64> {
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        for e in grants.entries {
            if p.access.apply(&e, &resolve, &no_groups).is_ok() {
                p.grants.push(e);
            }
        }
        let version = p.access.version;
        self.planner_absorb_pending_keys();
        Ok(version)
    }

    fn planner_open_one(p: &mut PlannerLocal, op: &ContainerOp, author_device: &str) -> Result<usize> {
        let key = p.keys.get(op.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_op(op, &p.access.container, key)?;
        let decoded = planner::decode_op(&pt)?;
        planner::guard_op(&mut p.guard, &decoded)?;
        p.state.apply_op(&decoded, author_device)
    }

    /// Применить отложенные операции, для которых появился ключ.
    fn planner_retry_pending(&mut self) -> usize {
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let Some(p) = self.planner.as_mut() else { return 0 };
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
    pub fn planner_ingest_sync(&mut self, sync_response: &[u8]) -> CResult<PlannerIngest> {
        let r: DomainOpSyncResponse = decode_checked(sync_response, Origin::Server)?;
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let mut out = PlannerIngest { more: r.more, ..Default::default() };
        for op in r.ops {
            if op.seq <= p.head_seq {
                continue;
            }
            match p.access.check_op_author(&op, &resolve, &no_groups) {
                Ok(a) => {
                    if p.keys.get(op.key_epoch).is_none() {
                        out.missing_epoch = Some(op.key_epoch);
                        p.head_seq = op.seq;
                        p.pending_ops.push(op);
                        continue;
                    }
                    p.head_seq = op.seq;
                    match Self::planner_open_one(p, &op, &a.device_id) {
                        Ok(n) => out.applied += n,
                        Err(e) => self.last_error = Some(e),
                    }
                }
                Err(ProtoError::Expired) => {
                    // Эпоха новее журнала грантов — догнать гранты и повторить страницу.
                    out.grants_behind = true;
                    out.more = true;
                    break;
                }
                Err(e) => {
                    self.last_error = Some(e);
                    p.head_seq = op.seq;
                }
            }
        }
        out.head_seq = p.head_seq;
        Ok(out)
    }

    /// Снимок контейнера (`domain.snapshot.get`): слить, сдвинуть курсор.
    pub fn planner_ingest_snapshot(&mut self, snapshot_response: &[u8]) -> CResult<u64> {
        let r: DomainSnapshotGetResponse = decode_checked(snapshot_response, Origin::Server)?;
        let Some(s) = r.snapshot else { return Ok(self.planner_head_seq()) };
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        p.access.check_snapshot_author(&s, &resolve, &no_groups)?;
        let key = p.keys.get(s.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_snapshot(&s, &p.access.container, key)?;
        let decoded = planner::decode_snapshot(&pt)?;
        p.state.merge_snapshot(&decoded)?;
        if s.upto_seq > p.head_seq {
            p.head_seq = s.upto_seq;
        }
        p.snapshot_seq = p.snapshot_seq.max(s.upto_seq);
        // Метки снимка — в часы (иначе свои следующие метки могут оказаться ниже).
        for t in p.state.tasks.values() {
            if let Some(s) = t.name.as_ref().and_then(|f| f.stamp.as_ref()) {
                let _ = p.guard.check(&dom::Stamp::new(s.lamport, &s.device_id));
            }
        }
        Ok(p.head_seq)
    }

    /// Локальная правка хоста (JSON изменений): метки движка, применение
    /// сразу (офлайн-first), байты операции — хосту в очередь отправки.
    pub fn planner_prepare_local(&mut self, changes_json: &str) -> CResult<PlannerLocalOp> {
        let mut op = planner_json::op_from_json(changes_json)?;
        let dev = self.device_id.clone();
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let stamp = dom::Stamp::new(p.guard.tick(), &dev);
        planner::stamp_op(&mut op, &stamp);
        let applied = p.state.apply_op(&op, &dev)?;
        Ok(PlannerLocalOp { op_id: sign::new_op_id(), op: op.encode_to_vec(), applied })
    }

    /// Применить локально уже помеченную операцию (повтор после перезапуска хоста
    /// из очереди отправки): идемпотентно.
    pub fn planner_apply_local(&mut self, op_bytes: &[u8]) -> CResult<usize> {
        let op = planner::decode_op(op_bytes)?;
        let dev = self.device_id.clone();
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        planner::guard_op(&mut p.guard, &op)?;
        Ok(p.state.apply_op(&op, &dev)?)
    }

    /// Зашифровать операцию ключом текущей эпохи → `domain.op.append`
    /// (тот же `op_id` при повторе — сервер ответит DUPLICATE).
    pub fn planner_seal(&mut self, op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        let p = self.planner.as_ref().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let epoch = p.access.epoch;
        let key = p.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        let sealed = dom::seal_op_with_id(&self.acc, &p.access.container, epoch, key, op_bytes, ts_ms, op_id)?;
        Ok(OutRequest::id("domain.op.append", &DomainOpAppendRequest { op: Some(sealed) }))
    }

    /// Снимок по порогу (R5): после `SNAPSHOT_EVERY` операций с прошлого снимка.
    pub fn planner_snapshot_request(&mut self, ts_ms: i64) -> CResult<Option<OutRequest>> {
        let p = self.planner.as_mut().ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if p.head_seq < p.snapshot_seq.saturating_add(planner::SNAPSHOT_EVERY) {
            return Ok(None);
        }
        let epoch = p.access.epoch;
        let key = p.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        let pt = p.state.to_snapshot().encode_to_vec();
        if pt.len() > dom::MAX_SNAPSHOT_PLAINTEXT {
            return Err(ClientError::Proto(ProtoError::FieldLimit("snapshot")));
        }
        let s = dom::seal_snapshot(&self.acc, &p.access.container, epoch, key, p.head_seq, &pt, ts_ms)?;
        p.snapshot_seq = p.head_seq;
        Ok(Some(OutRequest::id("domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s) })))
    }

    /// Размер открытого текста снимка — для предупреждения о потолке (FR-012).
    pub fn planner_size(&self) -> usize {
        self.planner.as_ref().map(|p| p.state.size_estimate()).unwrap_or(0)
    }

    fn planner_key_content(&self) -> Option<Content> {
        let p = self.planner.as_ref()?;
        let (epoch, key) = p.keys.latest()?;
        let share = p.access.key_share(epoch, key).ok()?;
        Some(Content { kind: Some(content::Kind::ContainerKey(share)), ..Default::default() })
    }

    /// Раздать ключ текущей эпохи своим устройствам (после создания контейнера,
    /// смены эпохи; новым устройствам — вместе с группами, T142).
    pub fn share_planner_with_own_devices(&mut self) -> CResult<Vec<OutRequest>> {
        let Some(c) = self.planner_key_content() else { return Ok(vec![]) };
        Ok(self.seal_to_own_devices(&c)?.into_iter().collect())
    }

    /// Ключ контейнера от своего устройства (`Content.container_key`).
    fn planner_accept_key(&mut self, sender: &str, share: &ContainerKeyShare, seq: u64) -> Vec<Event> {
        if sender != self.user || share.domain != planner::DOMAIN_NAME {
            return vec![Event::Skipped { seq }];
        }
        let me = self.user.clone();
        if let Some(p) = self.planner.as_mut() {
            match p.access.accept_key_share(share, &me, &no_groups) {
                Ok((epoch, key)) => {
                    p.keys.insert(epoch, key);
                    self.planner_retry_pending();
                    let head = self.planner_head_seq();
                    return vec![Event::PlannerChanged { seq, head_seq: head }];
                }
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => {
                    // Журнал грантов раздающего новее нашего — догнать и принять позже.
                    self.planner_pending_keys.push(share.clone());
                    return vec![Event::PlannerChanged { seq, head_seq: self.planner_head_seq() }];
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
        vec![Event::PlannerChanged { seq, head_seq: 0 }]
    }

    /// Смена эпохи при отзыве своего устройства (REVOKE-1): запись «rotate»,
    /// новый ключ, раздача оставшимся своим устройствам.
    fn planner_rotate_on_revoke(&mut self, ts_ms: i64) -> CResult<Vec<OutRequest>> {
        let authors = self.planner_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let Some(p) = self.planner.as_mut() else { return Ok(vec![]) };
        if p.keys.get(p.access.epoch).is_none() {
            return Ok(vec![]);
        }
        let rotate = dom::sign_rotate(&self.acc, &p.access, ts_ms)?;
        p.access.apply(&rotate, &resolve, &no_groups)?;
        p.grants.push(rotate.clone());
        p.keys.insert(p.access.epoch, dom::new_epoch_key());
        let mut out = vec![OutRequest::id("domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(rotate) })];
        out.extend(self.share_planner_with_own_devices()?);
        Ok(out)
    }

    /// Ключи контейнера для экспорта линковки (новому устройству).
    pub fn planner_keys_export(&self) -> Option<PlannerKeysExport> {
        let p = self.planner.as_ref()?;
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
            self.planner_trusted_keys.push((export.domain.clone(), id.clone(), *epoch, k));
        }
        self.planner_absorb_pending_keys();
        Ok(())
    }

    fn planner_persist(&self) -> Option<PersistedPlanner> {
        let p = self.planner.as_ref()?;
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
            snapshot: b64(&p.state.to_snapshot().encode_to_vec()),
            head_seq: p.head_seq,
            snapshot_seq: p.snapshot_seq,
            guard_max: p.guard.max_seen(),
            pending_ops: p.pending_ops.iter().map(|o| b64(&o.encode_to_vec())).collect(),
        })
    }

    fn planner_restore(&mut self, pp: &PersistedPlanner) -> Result<()> {
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
        let snapshot = planner::decode_snapshot(&unb64(&pp.snapshot)?)?;
        let state = planner::PlannerState::from_snapshot(&snapshot)?;
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
        self.planner = Some(PlannerLocal { genesis, grants, access, keys, guard, state, head_seq: pp.head_seq, snapshot_seq: pp.snapshot_seq, pending_ops });
        Ok(())
    }
}
