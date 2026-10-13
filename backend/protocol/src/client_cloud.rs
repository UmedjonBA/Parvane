// Контейнеры облака в клиенте (spec 016): включается в `client.rs` через
// `include!` — та же область видимости, доступ к полям `Client`.
//
// Несколько контейнеров домена `cloud.v1` на пользователя: личный диск и
// совместные папки — свои и чужие. У каждого генезис и журнал грантов
// (`ContainerAccess`), связка ключей эпох, сведённое дерево
// (`domain::cloud`), курсор `head_seq`, последний снимок.
// Ключ эпохи приходит по E2E (`Content.container_key`): своим устройствам — от
// своего аккаунта, участникам — от админа контейнера (проверка по журналу
// грантов), либо из экспорта линковки / копии ключей аккаунта. Операции,
// пришедшие раньше ключа, ждут в `pending_ops`. Авторы операций — устройства
// владельца и участников: их ключи берутся из проверенных журналов устройств
// (`own_log`, `peers`), кэш переживает отзыв устройства.

use crate::domain::{cloud, cloud_json};
use crate::pb::parvane::core::v2::{DomainGrantLeaveRequest, DomainGrantRevokeRequest, DomainGrantSetRequest, Grant, GrantLevel, OpBody};
use crate::pb::parvane::msg::v2::CloudInvite;

/// Сколько ключей может ждать подключения контейнера или журнала грантов.
const CLOUD_PENDING_KEYS: usize = 64;

/// Локальное состояние одного контейнера облака.
#[derive(Debug, Clone, PartialEq)]
struct CloudLocal {
    genesis: SignedOp,
    grants: Vec<SignedOp>,
    access: ContainerAccess,
    keys: KeyRing,
    guard: DomainGuard,
    state: cloud::CloudState,
    head_seq: u64,
    snapshot_seq: u64,
    /// Операции журнала, ждущие ключа своей эпохи (в порядке seq).
    pending_ops: Vec<ContainerOp>,
    /// JSON дерева для хоста по ревизии состояния — C1/A8.
    json_cache: JsonCache,
}

/// Итог приёма страницы журнала контейнера облака (`domain.op.sync`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudIngest {
    pub applied: usize,
    pub head_seq: u64,
    pub more: bool,
    /// Операции эпохи без ключа отложены — ждать `container_key`.
    pub missing_epoch: Option<u64>,
    /// Журнал грантов отстаёт (эпоха операции новее) — `domain.grant.list`, затем повтор.
    pub grants_behind: bool,
    /// Ключ автора операции неизвестен (новое устройство участника): обновить
    /// журналы устройств участников и повторить страницу.
    pub authors_behind: bool,
}

/// Роль пользователя в контейнере облака.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudRole {
    Owner,
    Editor,
    Reader,
}

impl CloudRole {
    pub fn name(self) -> &'static str {
        match self {
            CloudRole::Owner => "owner",
            CloudRole::Editor => "editor",
            CloudRole::Reader => "reader",
        }
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedCloud {
    genesis: String,
    grants: Vec<String>,
    keys: Vec<(u64, String)>,
    snapshot: String,
    head_seq: u64,
    snapshot_seq: u64,
    guard_max: u64,
    pending_ops: Vec<String>,
}

fn cloud_role_of(access: &ContainerAccess, user: &str) -> Option<CloudRole> {
    if access.owner == user {
        return Some(CloudRole::Owner);
    }
    match access.grants.get(&dom::Grantee::User(user.to_string())) {
        Some(GrantLevel::Read) => Some(CloudRole::Reader),
        Some(GrantLevel::Write) | Some(GrantLevel::Admin) => Some(CloudRole::Editor),
        _ => None,
    }
}

/// Пользователи, чьи журналы устройств нужны для проверки журнала грантов:
/// владелец и получатели грантов (выход подписывает сам участник). Поля
/// берутся без проверки подписи — только чтобы знать, чьи журналы добрать.
fn cloud_log_users(genesis: &SignedOp, entries: &[SignedOp]) -> Vec<String> {
    let mut users = BTreeSet::new();
    if let Ok((c, _)) = dom::verify_genesis(genesis) {
        if let Some(o) = c.owner {
            users.insert(o.address);
        }
    }
    for e in entries {
        let Ok(body) = decode_checked::<OpBody>(&e.body, Origin::Client) else { continue };
        let Ok(g) = decode_checked::<Grant>(&body.payload, Origin::Client) else { continue };
        if let Ok(dom::Grantee::User(u)) = dom::Grantee::from_pb(g.grantee.as_ref()) {
            users.insert(u);
        }
    }
    users.into_iter().collect()
}

fn restore_guard(max: u64) -> DomainGuard {
    let mut guard = DomainGuard::default();
    // Поднять до сохранённого максимума шагами в пределах допустимого скачка.
    while guard.max_seen() < max {
        let next = guard.max_seen().saturating_add(dom::LAMPORT_MAX_JUMP).min(max);
        let _ = guard.check(&dom::Stamp::new(next, "restore"));
    }
    guard
}

impl Client {
    /// Ключи подписи устройств → автор: свои устройства и устройства
    /// собеседников с проверенным журналом (кэш переживает отзыв устройства).
    fn cloud_author_map(&mut self) -> HashMap<[u8; 32], DomainAuthor> {
        let me = self.user.clone();
        let logs = std::iter::once((&me, &self.own_log)).chain(self.peers.iter().filter_map(|(u, p)| p.log.as_ref().map(|l| (u, l))));
        let mut fresh = vec![];
        for (user, log) in logs {
            for (id, d) in &log.devices {
                if let Ok(k) = d.olm_ed25519() {
                    fresh.push((k, user.clone(), id.clone()));
                }
            }
        }
        for (k, user, id) in fresh {
            self.cloud_authors.insert(k, (user, id));
        }
        self.cloud_authors.iter().map(|(k, (u, d))| (*k, DomainAuthor { user: u.clone(), device_id: d.clone() })).collect()
    }

    /// Журналы устройств всех `users` известны; иначе — `Need::PeerLog`.
    fn cloud_need_logs(&self, users: &[String]) -> CResult<()> {
        for u in users {
            if *u != self.user && self.peer_log(u).is_none() {
                return need(Need::PeerLog { user: u.clone(), after: 0 });
            }
        }
        Ok(())
    }

    fn cloud_get(&self, id: &[u8]) -> CResult<&CloudLocal> {
        self.cloud.get(id).ok_or(ClientError::Proto(ProtoError::NotFound))
    }

    /// Идентификаторы подключённых контейнеров облака.
    pub fn cloud_ids(&self) -> Vec<Vec<u8>> {
        self.cloud.keys().cloned().collect()
    }

    pub fn cloud_is_attached(&self, id: &[u8]) -> bool {
        self.cloud.contains_key(id)
    }

    /// Есть ли ключ текущей эпохи (без него писать и читать новое нельзя).
    pub fn cloud_has_key(&self, id: &[u8]) -> bool {
        self.cloud.get(id).is_some_and(|c| c.keys.get(c.access.epoch).is_some())
    }

    pub fn cloud_head_seq(&self, id: &[u8]) -> u64 {
        self.cloud.get(id).map_or(0, |c| c.head_seq)
    }

    pub fn cloud_grant_version(&self, id: &[u8]) -> u64 {
        self.cloud.get(id).map_or(0, |c| c.access.version)
    }

    /// Роль своего пользователя (`None` — контейнер не подключён либо доступа уже нет).
    pub fn cloud_role(&self, id: &[u8]) -> Option<CloudRole> {
        self.cloud.get(id).and_then(|c| cloud_role_of(&c.access, &self.user))
    }

    /// Видимое дерево контейнера для хоста (JSON). Пока ревизия состояния не
    /// менялась — та же строка из кэша (хост зовёт это на каждый узел).
    pub fn cloud_state_json(&self, id: &[u8]) -> Option<String> {
        self.cloud.get(id).map(|c| c.json_cache.get_or(c.state.rev(), 0, || cloud_json::state_json(&c.state)))
    }

    /// Сводка контейнеров для хоста:
    /// `[{id, owner, role, name, hasKey, headSeq, epoch, grantVersion, members:[{user, role}]}]`.
    pub fn cloud_containers_json(&self) -> String {
        let list: Vec<serde_json::Value> = self
            .cloud
            .iter()
            .map(|(id, c)| {
                let members: Vec<serde_json::Value> = c
                    .access
                    .grants
                    .iter()
                    .filter_map(|(g, _)| match g {
                        dom::Grantee::User(u) => cloud_role_of(&c.access, u).map(|r| serde_json::json!({"user": u, "role": r.name()})),
                        dom::Grantee::Group { .. } => None,
                    })
                    .collect();
                serde_json::json!({
                    "id": hex::encode(id),
                    "owner": c.access.owner,
                    "role": cloud_role_of(&c.access, &self.user).map(CloudRole::name),
                    "name": c.state.name(),
                    "hasKey": c.keys.get(c.access.epoch).is_some(),
                    "headSeq": c.head_seq,
                    "epoch": c.access.epoch,
                    "grantVersion": c.access.version,
                    "members": members,
                })
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// Создать контейнер облака (личный диск либо совместную папку): генезис +
    /// ключ эпохи 1 → `domain.container.create`. Возвращает id и запрос.
    pub fn cloud_create(&mut self, ts_ms: i64) -> CResult<(Vec<u8>, OutRequest)> {
        let (container, genesis) = dom::new_container(&self.acc, &self.domain, cloud::DOMAIN_NAME, &self.user, ts_ms)?;
        let id = container.r#ref.as_ref().map(|r| r.id.clone()).ok_or(ProtoError::InvalidField("ref"))?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::from_genesis(&genesis, &resolve)?;
        let mut keys = KeyRing::default();
        keys.insert(dom::FIRST_EPOCH, dom::new_epoch_key());
        self.cloud.insert(
            id.clone(),
            CloudLocal {
                genesis: genesis.clone(),
                grants: vec![],
                access,
                keys,
                guard: DomainGuard::default(),
                state: cloud::CloudState::default(),
                head_seq: 0,
                snapshot_seq: 0,
                pending_ops: vec![],
                json_cache: JsonCache::default(),
            },
        );
        Ok((id, OutRequest::id("domain.container.create", &DomainContainerCreateRequest { genesis: Some(genesis) })))
    }

    /// Подключить существующий контейнер: ответы `domain.container.get` и
    /// `domain.grant.list` (весь журнал). Журналы устройств владельца и
    /// участников должны быть известны — иначе `Need::PeerLog`. Возвращает id.
    pub fn cloud_attach(&mut self, get_response: &[u8], grants_response: &[u8]) -> CResult<Vec<u8>> {
        let got: DomainContainerGetResponse = decode_checked(get_response, Origin::Server)?;
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        let genesis = got.genesis.ok_or(ProtoError::InvalidField("genesis"))?;
        self.cloud_need_logs(&cloud_log_users(&genesis, &grants.entries))?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::replay(&genesis, &grants.entries, &resolve, &no_groups)?;
        if access.container.domain != cloud::DOMAIN_NAME {
            return Err(ClientError::Proto(ProtoError::ContextMismatch));
        }
        let id = access.container_ref()?.id.clone();
        let existing = self.cloud.remove(&id);
        // Локальный журнал грантов длиннее серверного ответа (своя запись ещё в пути) — оставляем свой.
        if let Some(e) = existing.as_ref().filter(|e| e.access.version > access.version) {
            let keep = e.clone();
            self.cloud.insert(id.clone(), keep);
            return Ok(id);
        }
        let local = CloudLocal {
            genesis,
            grants: grants.entries,
            access,
            keys: existing.as_ref().map(|c| c.keys.clone()).unwrap_or_default(),
            guard: existing.as_ref().map(|c| c.guard.clone()).unwrap_or_default(),
            state: existing.as_ref().map(|c| c.state.clone()).unwrap_or_default(),
            head_seq: existing.as_ref().map_or(0, |c| c.head_seq),
            snapshot_seq: existing.as_ref().map_or(0, |c| c.snapshot_seq),
            pending_ops: existing.map(|c| c.pending_ops).unwrap_or_default(),
            json_cache: JsonCache::default(),
        };
        self.cloud.insert(id.clone(), local);
        self.cloud_absorb_pending_keys();
        Ok(id)
    }

    /// Забыть контейнер (покинут, доступ отозван, удалён) и его ожидающие ключи.
    pub fn cloud_forget(&mut self, id: &[u8]) {
        self.cloud.remove(id);
        self.cloud_pending_keys.retain(|(_, s)| s.container.as_ref().is_none_or(|r| r.id != id));
        self.cloud_trusted_keys.retain(|(i, _, _)| i != id);
    }

    /// Принять ключи, ждавшие контейнера или журнала грантов. Непринятые остаются ждать.
    fn cloud_absorb_pending_keys(&mut self) {
        let trusted = std::mem::take(&mut self.cloud_trusted_keys);
        for (id, epoch, key) in trusted {
            match self.cloud.get_mut(&id) {
                Some(c) if epoch >= dom::FIRST_EPOCH && epoch <= c.access.epoch => c.keys.insert(epoch, Zeroizing::new(key)),
                _ => self.cloud_trusted_keys.push((id, epoch, key)),
            }
        }
        let shares = std::mem::take(&mut self.cloud_pending_keys);
        for (sender, share) in shares {
            let Some(c) = share.container.as_ref().and_then(|r| self.cloud.get_mut(&r.id)) else {
                self.cloud_pending_keys.push((sender, share));
                continue;
            };
            match c.access.accept_key_share(&share, &sender, &no_groups) {
                Ok((epoch, key)) => c.keys.insert(epoch, key),
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => self.cloud_pending_keys.push((sender, share)),
                Err(_) => {}
            }
        }
        for id in self.cloud_ids() {
            self.cloud_retry_pending(&id);
        }
    }

    /// Догнать журнал грантов: записи после известной версии. Запись, которую
    /// нельзя проверить (нет журнала устройств участника), останавливает
    /// догон с `Need::PeerLog`; уже принятые записи остаются.
    pub fn cloud_ingest_grants(&mut self, id: &[u8], grants_response: &[u8]) -> CResult<u64> {
        let grants: DomainGrantListResponse = decode_checked(grants_response, Origin::Server)?;
        self.cloud_get(id)?;
        self.cloud_need_logs(&cloud_log_users(&grants.genesis.clone().unwrap_or_default(), &grants.entries))?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let mut failed = None;
        for e in grants.entries {
            match c.access.apply(&e, &resolve, &no_groups) {
                Ok(_) => c.grants.push(e),
                // Запись уже применена (своя либо повтор страницы).
                Err(ProtoError::BrokenChain) => {}
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        let version = c.access.version;
        if let Some(e) = failed {
            self.last_error = Some(e);
        }
        self.cloud_absorb_pending_keys();
        Ok(version)
    }

    fn cloud_open_one(c: &mut CloudLocal, op: &ContainerOp, author_device: &str) -> Result<usize> {
        let key = c.keys.get(op.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_op(op, &c.access.container, key)?;
        let decoded = cloud::decode_batch(&pt)?;
        cloud::guard_batch(&mut c.guard, &decoded)?;
        c.state.apply_batch(&decoded, author_device)
    }

    /// Применить отложенные операции, для которых появился ключ.
    fn cloud_retry_pending(&mut self, id: &[u8]) -> usize {
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let Some(c) = self.cloud.get_mut(id) else { return 0 };
        let pending = std::mem::take(&mut c.pending_ops);
        let mut applied = 0;
        for op in pending {
            if c.keys.get(op.key_epoch).is_none() {
                c.pending_ops.push(op);
                continue;
            }
            if let Ok(a) = c.access.check_op_author(&op, &resolve, &no_groups) {
                applied += Self::cloud_open_one(c, &op, &a.device_id).unwrap_or(0);
            }
        }
        applied
    }

    /// Страница журнала контейнера (`domain.op.sync`): проверка автора (право
    /// записи в эпохе операции — операция читателя отвергается), расшифровка,
    /// применение в порядке seq. Свои операции идемпотентны. `strict` — на
    /// операции с неизвестным ключом автора остановиться (`authors_behind`),
    /// иначе такая операция пропускается.
    pub fn cloud_ingest_sync(&mut self, id: &[u8], sync_response: &[u8], strict: bool) -> CResult<CloudIngest> {
        let r: DomainOpSyncResponse = decode_checked(sync_response, Origin::Server)?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        let mut out = CloudIngest { more: r.more, ..Default::default() };
        for op in r.ops {
            if op.seq <= c.head_seq {
                continue;
            }
            let known = op.author.as_ref().and_then(|a| <[u8; 32]>::try_from(a.signer_key.as_slice()).ok()).is_some_and(|k| authors.contains_key(&k));
            if !known && strict {
                out.authors_behind = true;
                out.more = true;
                break;
            }
            match c.access.check_op_author(&op, &resolve, &no_groups) {
                Ok(a) => {
                    c.head_seq = op.seq;
                    if c.keys.get(op.key_epoch).is_none() {
                        out.missing_epoch = Some(op.key_epoch);
                        c.pending_ops.push(op);
                        continue;
                    }
                    match Self::cloud_open_one(c, &op, &a.device_id) {
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
                    c.head_seq = op.seq;
                }
            }
        }
        out.head_seq = c.head_seq;
        Ok(out)
    }

    /// Снимок контейнера (`domain.snapshot.get`): слить, сдвинуть курсор.
    pub fn cloud_ingest_snapshot(&mut self, id: &[u8], snapshot_response: &[u8]) -> CResult<u64> {
        let r: DomainSnapshotGetResponse = decode_checked(snapshot_response, Origin::Server)?;
        let Some(s) = r.snapshot else { return Ok(self.cloud_head_seq(id)) };
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        c.access.check_snapshot_author(&s, &resolve, &no_groups)?;
        let key = c.keys.get(s.key_epoch).ok_or(ProtoError::Crypto)?;
        let pt = dom::open_snapshot(&s, &c.access.container, key)?;
        let decoded = cloud::decode_snapshot(&pt)?;
        c.state.merge_snapshot(&decoded)?;
        c.head_seq = c.head_seq.max(s.upto_seq);
        c.snapshot_seq = c.snapshot_seq.max(s.upto_seq);
        // Метки снимка — в часы (иначе свои следующие метки могут оказаться ниже).
        let max = c.state.max_lamport();
        if max > c.guard.max_seen() {
            c.guard = restore_guard(max);
        }
        Ok(c.head_seq)
    }

    /// Локальная правка хоста (JSON операций): право записи, метки движка,
    /// проверка (родитель — папка, без циклов, предел узлов), применение
    /// сразу (офлайн-first); байты пакета — хосту в очередь отправки.
    pub fn cloud_prepare_local(&mut self, id: &[u8], ops_json: &str) -> CResult<PlannerLocalOp> {
        let mut batch = cloud_json::batch_from_json(ops_json)?;
        let dev = self.device_id.clone();
        let me = self.user.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if !c.access.can_write(&me, &no_groups) {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let mut guard = c.guard.clone();
        cloud::stamp_batch(&mut batch, &dev, &mut guard);
        c.state.check_local(&batch)?;
        let applied = c.state.apply_batch(&batch, &dev)?;
        c.guard = guard;
        Ok(PlannerLocalOp { op_id: sign::new_op_id(), op: batch.encode_to_vec(), applied })
    }

    /// Применить локально уже помеченный пакет (повтор после перезапуска хоста
    /// из очереди отправки): идемпотентно.
    pub fn cloud_apply_local(&mut self, id: &[u8], op_bytes: &[u8]) -> CResult<usize> {
        let batch = cloud::decode_batch(op_bytes)?;
        let dev = self.device_id.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        cloud::guard_batch(&mut c.guard, &batch)?;
        Ok(c.state.apply_batch(&batch, &dev)?)
    }

    /// Зашифровать пакет ключом текущей эпохи → `domain.op.append`
    /// (тот же `op_id` при повторе — сервер ответит DUPLICATE).
    pub fn cloud_seal(&mut self, id: &[u8], op_bytes: &[u8], op_id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        let c = self.cloud_get(id)?;
        let epoch = c.access.epoch;
        let key = c.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        let sealed = dom::seal_op_with_id(&self.acc, &c.access.container, epoch, key, op_bytes, ts_ms, op_id)?;
        Ok(OutRequest::id("domain.op.append", &DomainOpAppendRequest { op: Some(sealed) }))
    }

    /// Снимок по порогу: после `SNAPSHOT_EVERY` операций с прошлого снимка
    /// (пишет тот, у кого право записи).
    pub fn cloud_snapshot_request(&mut self, id: &[u8], ts_ms: i64) -> CResult<Option<OutRequest>> {
        let me = self.user.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if c.head_seq < c.snapshot_seq.saturating_add(cloud::SNAPSHOT_EVERY) || !c.access.can_write(&me, &no_groups) || !c.pending_ops.is_empty() {
            return Ok(None);
        }
        let epoch = c.access.epoch;
        let key = c.keys.get(epoch).ok_or(ProtoError::Crypto)?;
        let pt = c.state.to_snapshot(ts_ms.max(0) as u64).encode_to_vec();
        if pt.len() > dom::MAX_SNAPSHOT_PLAINTEXT {
            return Err(ClientError::Proto(ProtoError::FieldLimit("snapshot")));
        }
        let s = dom::seal_snapshot(&self.acc, &c.access.container, epoch, key, c.head_seq, &pt, ts_ms)?;
        c.snapshot_seq = c.head_seq;
        Ok(Some(OutRequest::id("domain.snapshot.put", &DomainSnapshotPutRequest { snapshot: Some(s) })))
    }

    /// Ключи контейнера как содержимое E2E: все известные эпохи либо только текущая.
    fn cloud_key_contents(&self, id: &[u8], all_epochs: bool) -> Vec<Content> {
        let Some(c) = self.cloud.get(id) else { return vec![] };
        let from = if all_epochs { dom::FIRST_EPOCH } else { c.access.epoch };
        (from..=c.access.epoch)
            .filter_map(|epoch| c.keys.get(epoch).and_then(|key| c.access.key_share(epoch, key).ok()))
            .map(|share| Content { kind: Some(content::Kind::ContainerKey(share)), ..Default::default() })
            .collect()
    }

    /// Раздать ключи контейнера своим устройствам (после создания, смены эпохи).
    pub fn cloud_share_with_own_devices(&mut self, id: &[u8]) -> CResult<Vec<OutRequest>> {
        let mut out = vec![];
        for c in self.cloud_key_contents(id, false) {
            out.extend(self.seal_to_own_devices(&c)?);
        }
        Ok(out)
    }

    /// Ключи контейнера участнику (личными сообщениями его устройствам).
    fn cloud_share_with_user(&mut self, id: &[u8], user: &str, all_epochs: bool) -> CResult<Vec<OutRequest>> {
        let mut out = vec![];
        for c in self.cloud_key_contents(id, all_epochs) {
            out.extend(self.prepare_direct(user, &c)?);
        }
        Ok(out)
    }

    /// Разослать ключ текущей эпохи всем участникам и своим устройствам
    /// (повтор после сбоя, новое устройство участника).
    pub fn cloud_share_keys(&mut self, id: &[u8]) -> CResult<Vec<OutRequest>> {
        let c = self.cloud_get(id)?;
        if !c.access.can_admin(&self.user, &no_groups) {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let users: Vec<String> = c.access.grants.keys().filter_map(|g| if let dom::Grantee::User(u) = g { Some(u.clone()) } else { None }).collect();
        for u in &users {
            self.check_peer(u)?;
        }
        let mut out = self.cloud_share_with_own_devices(id)?;
        for u in users {
            out.extend(self.cloud_share_with_user(id, &u, false)?);
        }
        Ok(out)
    }

    /// Выдать доступ либо сменить роль (`write` — редактор, иначе читатель):
    /// запись гранта, ключи всех эпох участнику и сообщение-приглашение (при
    /// первой выдаче). Понижение редактора до читателя — ещё и смена эпохи с
    /// раздачей нового ключа всем (иначе право записи в текущей эпохе остаётся).
    pub fn cloud_grant(&mut self, id: &[u8], user: &str, write: bool, invite_text: &str, ts_ms: i64) -> CResult<Vec<OutRequest>> {
        if !crate::address::is_valid_address(user) || user == self.user {
            return Err(ClientError::Proto(ProtoError::BadAddress));
        }
        self.check_peer(user)?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let me = self.user.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if !c.access.can_admin(&me, &no_groups) || c.keys.get(c.access.epoch).is_none() {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let grantee = dom::Grantee::User(user.to_string());
        let before = c.access.grants.get(&grantee).copied();
        let level = if write { GrantLevel::Write } else { GrantLevel::Read };
        if before == Some(level) {
            return Ok(vec![]);
        }
        let grant = dom::sign_grant(&self.acc, &c.access, &grantee, level, ts_ms)?;
        c.access.apply(&grant, &resolve, &no_groups)?;
        c.grants.push(grant.clone());
        let container = c.access.container_ref()?.clone();
        let name = c.state.name().to_string();
        let mut out = vec![OutRequest::id("domain.grant.set", &DomainGrantSetRequest { grant: Some(grant) })];
        if before.is_some_and(|l| l >= GrantLevel::Write) && !write {
            out.extend(self.cloud_rotate(id, ts_ms)?);
            return Ok(out);
        }
        out.extend(self.cloud_share_with_user(id, user, true)?);
        if before.is_none() {
            let invite = CloudInvite { container: Some(container), name, role: if write { 2 } else { 1 }, text: invite_text.to_string() };
            let content = Content { kind: Some(content::Kind::CloudInvite(invite)), ..Default::default() };
            out.extend(self.prepare_direct(user, &content)?);
        }
        Ok(out)
    }

    /// Убрать участника: запись отзыва (новая эпоха), новый ключ — оставшимся
    /// участникам и своим устройствам.
    pub fn cloud_revoke(&mut self, id: &[u8], user: &str, ts_ms: i64) -> CResult<Vec<OutRequest>> {
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let me = self.user.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if !c.access.can_admin(&me, &no_groups) {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let revoke = dom::sign_revoke(&self.acc, &c.access, &dom::Grantee::User(user.to_string()), ts_ms)?;
        c.access.apply(&revoke, &resolve, &no_groups)?;
        c.grants.push(revoke.clone());
        c.keys.insert(c.access.epoch, dom::new_epoch_key());
        let mut out = vec![OutRequest::id("domain.grant.revoke", &DomainGrantRevokeRequest { grant: Some(revoke) })];
        out.extend(self.cloud_share_current(id));
        Ok(out)
    }

    /// Смена эпохи без изменения состава (после выхода участника, понижения
    /// роли, отзыва устройства): запись «rotate», новый ключ — всем.
    pub fn cloud_rotate(&mut self, id: &[u8], ts_ms: i64) -> CResult<Vec<OutRequest>> {
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let me = self.user.clone();
        let c = self.cloud.get_mut(id).ok_or(ClientError::Proto(ProtoError::NotFound))?;
        if !c.access.can_admin(&me, &no_groups) || c.keys.get(c.access.epoch).is_none() {
            return Err(ClientError::Proto(ProtoError::Forbidden));
        }
        let rotate = dom::sign_rotate(&self.acc, &c.access, ts_ms)?;
        c.access.apply(&rotate, &resolve, &no_groups)?;
        c.grants.push(rotate.clone());
        c.keys.insert(c.access.epoch, dom::new_epoch_key());
        let mut out = vec![OutRequest::id("domain.key.rotate", &DomainKeyRotateRequest { rotate: Some(rotate) })];
        out.extend(self.cloud_share_current(id));
        Ok(out)
    }

    /// Ключ текущей эпохи своим устройствам и участникам; кому не удалось
    /// собрать сообщение сейчас — дошлёт `cloud_share_keys`.
    fn cloud_share_current(&mut self, id: &[u8]) -> Vec<OutRequest> {
        let mut out = self.cloud_share_with_own_devices(id).unwrap_or_default();
        let users: Vec<String> =
            self.cloud.get(id).map(|c| c.access.grants.keys().filter_map(|g| if let dom::Grantee::User(u) = g { Some(u.clone()) } else { None }).collect()).unwrap_or_default();
        for u in users {
            if let Ok(r) = self.cloud_share_with_user(id, &u, false) {
                out.extend(r);
            }
        }
        out
    }

    /// Покинуть чужой контейнер: запись «leave» → `domain.grant.leave`;
    /// локальное состояние контейнера удаляется.
    pub fn cloud_leave(&mut self, id: &[u8], ts_ms: i64) -> CResult<OutRequest> {
        let c = self.cloud_get(id)?;
        let me = dom::Grantee::User(self.user.clone());
        let leave = dom::sign_leave(&self.acc, &c.access, &me, ts_ms)?;
        self.cloud_forget(id);
        Ok(OutRequest::id("domain.grant.leave", &DomainGrantLeaveRequest { leave: Some(leave) }))
    }

    /// Ключ контейнера облака по E2E (`Content.container_key`): от своего
    /// аккаунта либо от админа контейнера. Для неподключённого контейнера
    /// ключ ждёт: хост подключит контейнер по событию.
    fn cloud_accept_key(&mut self, sender: &str, share: &ContainerKeyShare, seq: u64) -> Vec<Event> {
        let Some(id) = share.container.as_ref().filter(|r| r.domain == self.domain).map(|r| r.id.clone()) else {
            return vec![Event::Skipped { seq }];
        };
        if let Some(c) = self.cloud.get_mut(&id) {
            match c.access.accept_key_share(share, sender, &no_groups) {
                Ok((epoch, key)) => {
                    c.keys.insert(epoch, key);
                    self.cloud_retry_pending(&id);
                    return vec![Event::CloudChanged { seq, id }];
                }
                Err(ProtoError::Expired) | Err(ProtoError::BrokenChain) => {}
                Err(e) => {
                    self.last_error = Some(e);
                    return vec![Event::Skipped { seq }];
                }
            }
        }
        // Контейнер не подключён либо журнал грантов раздающего новее нашего.
        if self.cloud_pending_keys.len() < CLOUD_PENDING_KEYS {
            self.cloud_pending_keys.push((sender.to_string(), share.clone()));
        }
        vec![Event::CloudChanged { seq, id }]
    }

    /// Смена эпохи при отзыве своего устройства (REVOKE-1) — во всех
    /// контейнерах, где пользователь админ.
    fn cloud_rotate_on_revoke(&mut self, ts_ms: i64) -> Vec<OutRequest> {
        let mut out = vec![];
        for id in self.cloud_ids() {
            match self.cloud_rotate(&id, ts_ms) {
                Ok(r) => out.extend(r),
                Err(ClientError::Proto(ProtoError::Forbidden)) | Err(ClientError::Need(_)) => {}
                Err(ClientError::Proto(e)) => self.last_error = Some(e),
            }
        }
        out
    }

    /// Ключи текущих эпох всех контейнеров облака — новым своим устройствам.
    fn cloud_key_contents_for_own_devices(&self) -> Vec<Content> {
        self.cloud.keys().flat_map(|id| self.cloud_key_contents(id, true)).collect()
    }

    /// Ключи контейнеров облака для экспорта линковки и копии ключей аккаунта.
    pub fn cloud_keys_export(&self) -> Vec<PlannerKeysExport> {
        self.cloud
            .iter()
            .map(|(id, c)| {
                let keys = (dom::FIRST_EPOCH..=c.access.epoch).filter_map(|e| c.keys.get(e).map(|k| (e, b64(k)))).collect();
                PlannerKeysExport { domain: c.access.container.domain.clone(), id: hex::encode(id), keys }
            })
            .collect()
    }

    /// Ключи из экспорта своего устройства: ждут подключения контейнера.
    pub fn cloud_keys_import(&mut self, exports: &[PlannerKeysExport]) -> Result<()> {
        for export in exports.iter().filter(|e| e.domain == cloud::DOMAIN_NAME) {
            let id = hex::decode(&export.id).map_err(|_| ProtoError::Malformed)?;
            for (epoch, key) in &export.keys {
                let k: [u8; 32] = unb64(key)?.as_slice().try_into().map_err(|_| ProtoError::Malformed)?;
                self.cloud_trusted_keys.retain(|(i, e, _)| !(*i == id && e == epoch));
                self.cloud_trusted_keys.push((id.clone(), *epoch, k));
            }
        }
        self.cloud_absorb_pending_keys();
        Ok(())
    }

    fn cloud_persist(&self) -> Vec<PersistedCloud> {
        self.cloud
            .values()
            .map(|c| PersistedCloud {
                genesis: b64(&c.genesis.encode_to_vec()),
                grants: c.grants.iter().map(|g| b64(&g.encode_to_vec())).collect(),
                keys: (dom::FIRST_EPOCH..=c.access.epoch).filter_map(|e| c.keys.get(e).map(|k| (e, b64(k)))).collect(),
                // Локальная копия хранит все надгробия (момент 0 — ничего не отбрасывать).
                snapshot: b64(&c.state.to_snapshot(0).encode_to_vec()),
                head_seq: c.head_seq,
                snapshot_seq: c.snapshot_seq,
                guard_max: c.guard.max_seen(),
                pending_ops: c.pending_ops.iter().map(|o| b64(&o.encode_to_vec())).collect(),
            })
            .collect()
    }

    fn cloud_restore(&mut self, pc: &PersistedCloud) -> Result<()> {
        let genesis = SignedOp::decode(unb64(&pc.genesis)?.as_slice()).map_err(|_| ProtoError::Malformed)?;
        let grants = pc.grants.iter().map(|g| SignedOp::decode(unb64(g)?.as_slice()).map_err(|_| ProtoError::Malformed)).collect::<Result<Vec<_>>>()?;
        let authors = self.cloud_author_map();
        let resolve = |k: &[u8; 32]| authors.get(k).cloned();
        let access = ContainerAccess::replay(&genesis, &grants, &resolve, &no_groups)?;
        let mut keys = KeyRing::default();
        for (epoch, k) in &pc.keys {
            let arr: [u8; 32] = unb64(k)?.as_slice().try_into().map_err(|_| ProtoError::Malformed)?;
            keys.insert(*epoch, Zeroizing::new(arr));
        }
        let state = cloud::CloudState::from_snapshot(&cloud::decode_snapshot(&unb64(&pc.snapshot)?)?)?;
        let pending_ops = pc.pending_ops.iter().map(|o| ContainerOp::decode(unb64(o)?.as_slice()).map_err(|_| ProtoError::Malformed)).collect::<Result<Vec<_>>>()?;
        let id = access.container_ref()?.id.clone();
        self.cloud.insert(
            id,
            CloudLocal { genesis, grants, access, keys, guard: restore_guard(pc.guard_max), state, head_seq: pc.head_seq, snapshot_seq: pc.snapshot_seq, pending_ops, json_cache: JsonCache::default() },
        );
        Ok(())
    }
}
