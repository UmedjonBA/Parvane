//! Методы каркаса доменов (реестр: `domain.*`, shard "domains") и хранилище.
//!
//! Право вызывающего (`req.user` — JWT уже проверил gateway):
//! владелец — ADMIN; иначе — уровень прямого гранта пользователю. Без доступа
//! контейнер «не существует» (`NOT_FOUND`), с недостаточным уровнем —
//! `FORBIDDEN`. Групповые гранты хранятся и раздаются клиентам, но право
//! записи сервер по ним не даёт: состав групп v2 — в messenger (отдельная
//! задача). Подписант каждой подписи определяется по ключу устройства через
//! identity (`v2.internal.identity.key_owner`) и обязан быть вызывающим.
//! Журнал грантов проверяется тем же движком, что и у клиентов
//! (`ContainerAccess`): цепочка, позиция, право админа, эпоха отзыва.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use async_nats::Client;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::domain::{self, no_groups, Author, ContainerAccess, Grantee, GrantEvent};
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{
    Container, ContainerOp, DomainContainerCreateRequest, DomainContainerCreateResponse, DomainContainerGetRequest,
    DomainContainerGetResponse, DomainGrantListRequest, DomainKeyRotateRequest, DomainKeyRotateResponse, DomainContainerListRequest, DomainContainerListResponse, DomainGrantListResponse, DomainGrantRevokeRequest,
    DomainGrantRevokeResponse, DomainGrantSetRequest, DomainGrantSetResponse, DomainOpAppendRequest, DomainOpAppendResponse,
    DomainOpSyncRequest, DomainOpSyncResponse, DomainSnapshotGetRequest, DomainSnapshotGetResponse, DomainSnapshotPutRequest,
    DomainSnapshotPutResponse, ErrorCode, GrantLevel, KeyOwnerRequest, KeyOwnerResponse, OpBody, Ref, ShardRequest, SignedOp,
    Snapshot, UserRef,
};
use parvane_protocol::registry_gen::INTERNAL_KEY_OWNER;
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message;
use sqlx::SqlitePool;
use tracing::{debug, error, info, warn};

/// Контейнеров на владельца.
pub const MAX_CONTAINERS_PER_OWNER: i64 = 1000;
/// Записей журнала грантов на контейнер.
pub const MAX_GRANT_LOG: u64 = 4096;
/// Элементов на страницу (по схеме: max_items = 1024).
pub const PAGE_ITEMS: usize = 1024;
/// Кэш «ключ устройства → автор».
const OWNER_TTL: Duration = Duration::from_secs(60);
const KEY_OWNER_TIMEOUT: Duration = Duration::from_secs(3);

pub struct Domains {
    pub pool: SqlitePool,
    nc: Option<Client>,
    pub server_domain: String,
    owners: Mutex<HashMap<[u8; 32], (Instant, Author)>>,
}

/// Домен сервера (как у messenger v2).
pub fn server_domain() -> String {
    std::env::var("PARVANE_DOMAIN")
        .ok()
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

/// Открыть хранилище `<db_path>-v2.db` и применить migrations_v2/.
pub async fn open_store(db_path: &str) -> Result<SqlitePool> {
    let path = format!("{db_path}-v2.db");
    let pool = parvane_db::connect(&path).await?;
    info!("SQLite готов: {}", path);
    sqlx::migrate!("./migrations_v2").run(&pool).await.context("миграции v2")?;
    info!("миграции v2 применены");
    Ok(pool)
}

/// Подписаться на методы роли "domains" из реестра.
pub async fn run(nc: Client, d: Arc<Domains>, concurrency: usize) -> Result<()> {
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let d = d.clone();
        Box::pin(async move { d.dispatch(m.name, req).await })
    });
    parvane_v2rt::serve(nc, "domains", concurrency, handler).await?;
    Ok(())
}

fn db_err<E: std::fmt::Display>(e: E) -> ErrorCode {
    error!("domains: {}", e);
    ErrorCode::Unavailable
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}

fn code(e: parvane_protocol::ProtoError) -> ErrorCode {
    debug!("domains: отказ движка: {}", e);
    e.code()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Получатель гранта в таблице: (kind, grantee).
fn grantee_row(g: &Grantee) -> (i64, String) {
    match g {
        Grantee::User(u) => (0, u.clone()),
        Grantee::Group { domain, id } => (1, format!("{}:{}", domain, hex(id))),
    }
}

fn level_from(v: i64) -> Option<GrantLevel> {
    i32::try_from(v).ok().and_then(|v| GrantLevel::try_from(v).ok()).filter(|l| *l != GrantLevel::Unspecified)
}

/// Строка `containers`: domain, owner, key_epoch, grant_version, head_seq, genesis, genesis_key.
type MetaRow = (String, String, i64, i64, i64, Vec<u8>, Vec<u8>);

/// Строка контейнера.
struct Meta {
    domain: String,
    owner: String,
    key_epoch: u64,
    grant_version: u64,
    head_seq: u64,
    genesis: Vec<u8>,
    genesis_key: Vec<u8>,
}

impl Domains {
    pub fn new(pool: SqlitePool, nc: Option<Client>, server_domain: String) -> Self {
        Self { pool, nc, server_domain, owners: Mutex::new(HashMap::new()) }
    }

    /// Запомнить владельца ключа (кэш identity; в тестах — вместо identity).
    pub fn remember_key(&self, key: [u8; 32], author: Author) {
        if let Ok(mut g) = self.owners.lock() {
            g.insert(key, (Instant::now(), author));
        }
    }

    async fn key_owner(&self, key: &[u8; 32]) -> Result<Option<Author>, ErrorCode> {
        if let Ok(g) = self.owners.lock() {
            if let Some((at, a)) = g.get(key) {
                if at.elapsed() < OWNER_TTL {
                    return Ok(Some(a.clone()));
                }
            }
        }
        let Some(nc) = &self.nc else { return Ok(None) };
        let req = KeyOwnerRequest { ed25519: key.to_vec() }.encode_to_vec();
        let r = tokio::time::timeout(KEY_OWNER_TIMEOUT, nc.request(INTERNAL_KEY_OWNER.to_string(), req.into()))
            .await
            .map_err(|_| {
                warn!("domains: identity key_owner не ответил");
                ErrorCode::Unavailable
            })?
            .map_err(db_err)?;
        let o = decode_checked::<KeyOwnerResponse>(&r.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
        if !o.found {
            return Ok(None);
        }
        let a = Author { user: o.user, device_id: o.device_id };
        self.remember_key(*key, a.clone());
        Ok(Some(a))
    }

    /// Подписант — устройство вызывающего пользователя.
    async fn author_is_caller(&self, signer: &[u8; 32], user: &str) -> Result<Author, ErrorCode> {
        match self.key_owner(signer).await? {
            Some(a) if a.user == user => Ok(a),
            _ => Err(ErrorCode::Forbidden),
        }
    }

    /// Ссылка контейнера этого сервера → id.
    fn container_id(&self, r: Option<&Ref>) -> Result<Vec<u8>, ErrorCode> {
        let r = r.ok_or(ErrorCode::Invalid)?;
        parvane_protocol::address::check_ref(r).map_err(code)?;
        if r.domain != self.server_domain {
            return Err(ErrorCode::FederationUnavailable);
        }
        Ok(r.id.clone())
    }

    fn container_ref(&self, id: &[u8]) -> Ref {
        Ref { domain: self.server_domain.clone(), id: id.to_vec() }
    }

    async fn meta(&self, id: &[u8]) -> Result<Option<Meta>, ErrorCode> {
        let row: Option<MetaRow> = sqlx::query_as(
            "SELECT domain, owner, key_epoch, grant_version, head_seq, genesis, genesis_key FROM containers WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(row.map(|(domain, owner, e, v, h, genesis, genesis_key)| Meta {
            domain,
            owner,
            key_epoch: e as u64,
            grant_version: v as u64,
            head_seq: h as u64,
            genesis,
            genesis_key,
        }))
    }

    async fn level(&self, id: &[u8], meta: &Meta, user: &str) -> Result<Option<GrantLevel>, ErrorCode> {
        if user == meta.owner {
            return Ok(Some(GrantLevel::Admin));
        }
        let row: Option<(i64,)> = sqlx::query_as("SELECT level FROM container_grants WHERE container = ? AND kind = 0 AND grantee = ?")
            .bind(id)
            .bind(user)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(row.and_then(|(l,)| level_from(l)))
    }

    /// Контейнер и уровень вызывающего не ниже `min`. Без доступа — NOT_FOUND.
    async fn require(&self, id: &[u8], user: &str, min: GrantLevel) -> Result<(Meta, GrantLevel), ErrorCode> {
        let meta = self.meta(id).await?.ok_or(ErrorCode::NotFound)?;
        let level = self.level(id, &meta, user).await?.ok_or(ErrorCode::NotFound)?;
        if level < min {
            return Err(ErrorCode::Forbidden);
        }
        Ok((meta, level))
    }

    pub async fn dispatch(&self, method: &str, req: ShardRequest) -> Reply {
        if req.user.is_empty() || req.device_id.is_empty() {
            return Err(ErrorCode::Forbidden);
        }
        let user = req.user.as_str();
        match method {
            "domain.container.create" => self.create(user, body(&req)?).await,
            "domain.container.get" => self.get(user, body(&req)?).await,
            "domain.op.append" => self.append(user, body(&req)?).await,
            "domain.op.sync" => self.sync(user, body(&req)?).await,
            "domain.grant.set" => {
                let r: DomainGrantSetRequest = body(&req)?;
                let ev = self.grant_write(user, r.grant.ok_or(ErrorCode::Invalid)?, domain::OP_GRANT).await?;
                Ok(DomainGrantSetResponse { version: ev.version }.encode_to_vec())
            }
            "domain.grant.revoke" => {
                let r: DomainGrantRevokeRequest = body(&req)?;
                let ev = self.grant_write(user, r.grant.ok_or(ErrorCode::Invalid)?, domain::OP_REVOKE).await?;
                Ok(DomainGrantRevokeResponse { version: ev.version, key_epoch: ev.key_epoch }.encode_to_vec())
            }
            "domain.key.rotate" => {
                let r: DomainKeyRotateRequest = body(&req)?;
                let ev = self.grant_write(user, r.rotate.ok_or(ErrorCode::Invalid)?, domain::OP_ROTATE).await?;
                Ok(DomainKeyRotateResponse { version: ev.version, key_epoch: ev.key_epoch }.encode_to_vec())
            }
            "domain.container.list" => self.container_list(user, body(&req)?).await,
            "domain.grant.list" => self.grant_list(user, body(&req)?).await,
            "domain.snapshot.put" => self.snapshot_put(user, body(&req)?).await,
            "domain.snapshot.get" => self.snapshot_get(user, body(&req)?).await,
            _ => Err(ErrorCode::Unavailable),
        }
    }

    async fn create(&self, user: &str, r: DomainContainerCreateRequest) -> Reply {
        let genesis = r.genesis.ok_or(ErrorCode::Invalid)?;
        let (c, signer) = domain::verify_genesis(&genesis).map_err(code)?;
        let owner = c.owner.as_ref().map(|u| u.address.as_str()).unwrap_or_default();
        if owner != user {
            return Err(ErrorCode::Forbidden);
        }
        let id = self.container_id(c.r#ref.as_ref())?;
        self.author_is_caller(&signer, user).await?;
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM containers WHERE owner = ?")
            .bind(user)
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;
        if count >= MAX_CONTAINERS_PER_OWNER {
            return Err(ErrorCode::Limit);
        }
        let res = sqlx::query(
            "INSERT INTO containers (id, domain, owner, key_epoch, genesis, genesis_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(&id)
        .bind(&c.domain)
        .bind(user)
        .bind(domain::FIRST_EPOCH as i64)
        .bind(genesis.encode_to_vec())
        .bind(signer.to_vec())
        .bind(now_unix())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        if res.rows_affected() == 0 {
            return Err(ErrorCode::Duplicate);
        }
        debug!("domains: контейнер {} ({}) создан", hex(&id), c.domain);
        Ok(DomainContainerCreateResponse { container: Some(c) }.encode_to_vec())
    }

    fn container_pb(&self, id: &[u8], m: &Meta) -> Container {
        Container {
            r#ref: Some(self.container_ref(id)),
            domain: m.domain.clone(),
            owner: Some(UserRef { address: m.owner.clone() }),
            key_epoch: m.key_epoch,
        }
    }

    async fn get(&self, user: &str, r: DomainContainerGetRequest) -> Reply {
        let id = self.container_id(r.container.as_ref())?;
        let (m, level) = self.require(&id, user, GrantLevel::Read).await?;
        let genesis = SignedOp::decode(m.genesis.as_slice()).map_err(db_err)?;
        Ok(DomainContainerGetResponse {
            container: Some(self.container_pb(&id, &m)),
            genesis: Some(genesis),
            level: level as i32,
            head_seq: m.head_seq,
            grant_version: m.grant_version,
        }
        .encode_to_vec())
    }

    async fn append(&self, user: &str, r: DomainOpAppendRequest) -> Reply {
        let op = r.op.ok_or(ErrorCode::Invalid)?;
        let id = self.container_id(op.container.as_ref())?;
        let (m, _) = self.require(&id, user, GrantLevel::Write).await?;
        if op.key_epoch != m.key_epoch {
            return Err(ErrorCode::Expired);
        }
        let seal = domain::verify_op_seal(&op).map_err(code)?;
        self.author_is_caller(&seal.signer, user).await?;
        let stored = ContainerOp { seq: 0, ..op }.encode_to_vec();
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        // UPDATE первым — берёт блокировку записи, seq без гонок.
        let (seq,): (i64,) = sqlx::query_as("UPDATE containers SET head_seq = head_seq + 1 WHERE id = ? RETURNING head_seq")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?;
        let ins = sqlx::query("INSERT INTO container_log (container, seq, op_id, key_epoch, op, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(container, op_id) DO NOTHING")
            .bind(&id)
            .bind(seq)
            .bind(&seal.op_id)
            .bind(m.key_epoch as i64)
            .bind(&stored)
            .bind(now_unix())
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        if ins.rows_affected() == 0 {
            // Повтор op_id: откат (seq не расходуется).
            return Err(ErrorCode::Duplicate);
        }
        tx.commit().await.map_err(db_err)?;
        Ok(DomainOpAppendResponse { seq: seq as u64 }.encode_to_vec())
    }

    async fn sync(&self, user: &str, r: DomainOpSyncRequest) -> Reply {
        let id = self.container_id(r.container.as_ref())?;
        self.require(&id, user, GrantLevel::Read).await?;
        let budget = if r.max_bytes == 0 || r.max_bytes > domain::SYNC_MAX_BYTES { domain::SYNC_MAX_BYTES } else { r.max_bytes } as usize;
        let after = i64::try_from(r.after_seq).map_err(|_| ErrorCode::Invalid)?;
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT seq, op FROM container_log WHERE container = ? AND seq > ? ORDER BY seq LIMIT ?")
            .bind(&id)
            .bind(after)
            .bind(PAGE_ITEMS as i64 + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let mut ops = Vec::new();
        let mut used = 0usize;
        let mut more = false;
        for (seq, bytes) in rows {
            // Хотя бы одна запись на страницу, иначе клиент не продвинется.
            if ops.len() >= PAGE_ITEMS || (!ops.is_empty() && used + bytes.len() > budget) {
                more = true;
                break;
            }
            used += bytes.len();
            let mut op = ContainerOp::decode(bytes.as_slice()).map_err(db_err)?;
            op.seq = seq as u64;
            ops.push(op);
        }
        Ok(DomainOpSyncResponse { ops, more }.encode_to_vec())
    }

    /// grant.set / grant.revoke: проверка движком по всему журналу грантов.
    /// Запись журнала грантов: `expected` — "grant", "revoke" или "rotate"
    /// (spec 010: смена эпохи без грантов).
    async fn grant_write(&self, user: &str, op: SignedOp, expected: &str) -> Result<GrantEvent, ErrorCode> {
        let b: OpBody = decode_checked(&op.body, Origin::Client).map_err(code)?;
        let h = b.header.ok_or(ErrorCode::Invalid)?;
        if h.domain != domain::DOMAIN || h.op_type != expected {
            return Err(ErrorCode::Invalid);
        }
        let id = self.container_id(h.target.as_ref())?;
        let (m, _) = self.require(&id, user, GrantLevel::Admin).await?;
        if m.grant_version >= MAX_GRANT_LOG {
            return Err(ErrorCode::Limit);
        }
        let signer: [u8; 32] = op.signer_key.as_slice().try_into().map_err(|_| ErrorCode::Invalid)?;
        let author = self.author_is_caller(&signer, user).await?;

        // Повторная проверка сохранённой цепочки движком; подписанты истории —
        // из таблицы (определены при приёме).
        let genesis = SignedOp::decode(m.genesis.as_slice()).map_err(db_err)?;
        let rows: Vec<(Vec<u8>, Vec<u8>, String)> =
            sqlx::query_as("SELECT entry, signer_key, signer_user FROM container_grant_log WHERE container = ? ORDER BY version")
                .bind(&id)
                .fetch_all(&self.pool)
                .await
                .map_err(db_err)?;
        let mut keys: HashMap<[u8; 32], Author> = HashMap::new();
        let gk: [u8; 32] = m.genesis_key.as_slice().try_into().map_err(db_err_str)?;
        keys.insert(gk, Author { user: m.owner.clone(), device_id: String::new() });
        let mut entries = Vec::with_capacity(rows.len());
        for (entry, key, signer_user) in rows {
            let k: [u8; 32] = key.as_slice().try_into().map_err(db_err_str)?;
            keys.insert(k, Author { user: signer_user, device_id: String::new() });
            entries.push(SignedOp::decode(entry.as_slice()).map_err(db_err)?);
        }
        keys.insert(signer, author.clone());
        let resolve = |k: &[u8; 32]| keys.get(k).cloned();
        let mut access = ContainerAccess::replay(&genesis, &entries, &resolve, &no_groups).map_err(|e| {
            error!("domains: сохранённый журнал грантов {} не сходится: {}", hex(&id), e);
            ErrorCode::Unavailable
        })?;
        let ev = access.apply(&op, &resolve, &no_groups).map_err(code)?;

        let (kind, grantee) = grantee_row(&ev.grantee);
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        let upd = sqlx::query("UPDATE containers SET grant_version = ?, key_epoch = ? WHERE id = ? AND grant_version = ?")
            .bind(ev.version as i64)
            .bind(ev.key_epoch as i64)
            .bind(&id)
            .bind(m.grant_version as i64)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        if upd.rows_affected() != 1 {
            // Параллельная запись другого админа заняла эту позицию.
            return Err(ErrorCode::Duplicate);
        }
        sqlx::query("INSERT INTO container_grant_log (container, version, entry, signer_key, signer_user, at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(ev.version as i64)
            .bind(op.encode_to_vec())
            .bind(signer.to_vec())
            .bind(&author.user)
            .bind(now_unix())
            .execute(&mut *tx)
            .await
            .map_err(|_| ErrorCode::Duplicate)?;
        match ev.level {
            // Смена эпохи: гранты не менялись
            _ if ev.rotate => {}
            Some(level) => {
                sqlx::query("INSERT INTO container_grants (container, kind, grantee, level) VALUES (?, ?, ?, ?) ON CONFLICT(container, kind, grantee) DO UPDATE SET level = excluded.level")
                    .bind(&id)
                    .bind(kind)
                    .bind(&grantee)
                    .bind(level as i64)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
            None => {
                sqlx::query("DELETE FROM container_grants WHERE container = ? AND kind = ? AND grantee = ?")
                    .bind(&id)
                    .bind(kind)
                    .bind(&grantee)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
        }
        tx.commit().await.map_err(db_err)?;
        debug!("domains: журнал грантов {} → v{}, эпоха {}", hex(&id), ev.version, ev.key_epoch);
        Ok(ev)
    }

    /// Контейнеры домена, доступные пользователю: свои и по прямым грантам
    /// (групповые гранты каркас пока не раздаёт — `no_groups`).
    async fn container_list(&self, user: &str, r: DomainContainerListRequest) -> Reply {
        domain::check_domain_name(&r.domain).map_err(code)?;
        let rows: Vec<(Vec<u8>, String, i64)> = sqlx::query_as(
            "SELECT c.id, c.owner, c.key_epoch FROM containers c WHERE c.domain = ?1 AND (c.owner = ?2 \
             OR EXISTS (SELECT 1 FROM container_grants g WHERE g.container = c.id AND g.kind = 0 AND g.grantee = ?2)) \
             ORDER BY c.created_at LIMIT ?3",
        )
        .bind(&r.domain)
        .bind(user)
        .bind(PAGE_ITEMS as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        let containers = rows
            .into_iter()
            .map(|(id, owner, key_epoch)| Container {
                r#ref: Some(self.container_ref(&id)),
                domain: r.domain.clone(),
                owner: Some(UserRef { address: owner }),
                key_epoch: key_epoch as u64,
            })
            .collect();
        Ok(DomainContainerListResponse { containers }.encode_to_vec())
    }

    async fn grant_list(&self, user: &str, r: DomainGrantListRequest) -> Reply {
        let id = self.container_id(r.container.as_ref())?;
        let (m, _) = self.require(&id, user, GrantLevel::Read).await?;
        let after = i64::try_from(r.after_version).map_err(|_| ErrorCode::Invalid)?;
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT entry FROM container_grant_log WHERE container = ? AND version > ? ORDER BY version LIMIT ?")
            .bind(&id)
            .bind(after)
            .bind(PAGE_ITEMS as i64 + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let more = rows.len() > PAGE_ITEMS;
        let entries = rows
            .into_iter()
            .take(PAGE_ITEMS)
            .map(|(e,)| SignedOp::decode(e.as_slice()).map_err(db_err))
            .collect::<Result<Vec<_>, _>>()?;
        let genesis = SignedOp::decode(m.genesis.as_slice()).map_err(db_err)?;
        Ok(DomainGrantListResponse { genesis: Some(genesis), entries, more }.encode_to_vec())
    }

    async fn snapshot_put(&self, user: &str, r: DomainSnapshotPutRequest) -> Reply {
        let s = r.snapshot.ok_or(ErrorCode::Invalid)?;
        let id = self.container_id(s.container.as_ref())?;
        let (m, _) = self.require(&id, user, GrantLevel::Write).await?;
        if s.key_epoch != m.key_epoch {
            return Err(ErrorCode::Expired);
        }
        if s.upto_seq == 0 || s.upto_seq > m.head_seq {
            return Err(ErrorCode::Invalid);
        }
        let seal = domain::verify_snapshot_seal(&s).map_err(code)?;
        self.author_is_caller(&seal.signer, user).await?;
        // Хранится только самый свежий снимок (больший upto_seq; при равном —
        // более новая эпоха, например перешифрованный после отзыва).
        sqlx::query(
            "INSERT INTO container_snapshots (container, upto_seq, key_epoch, snapshot, at) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(container) DO UPDATE SET upto_seq = excluded.upto_seq, key_epoch = excluded.key_epoch, snapshot = excluded.snapshot, at = excluded.at \
             WHERE excluded.upto_seq > container_snapshots.upto_seq \
                OR (excluded.upto_seq = container_snapshots.upto_seq AND excluded.key_epoch > container_snapshots.key_epoch)",
        )
        .bind(&id)
        .bind(s.upto_seq as i64)
        .bind(s.key_epoch as i64)
        .bind(s.encode_to_vec())
        .bind(now_unix())
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(DomainSnapshotPutResponse {}.encode_to_vec())
    }

    async fn snapshot_get(&self, user: &str, r: DomainSnapshotGetRequest) -> Reply {
        let id = self.container_id(r.container.as_ref())?;
        self.require(&id, user, GrantLevel::Read).await?;
        let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT snapshot FROM container_snapshots WHERE container = ?")
            .bind(&id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;
        let snapshot = row.map(|(b,)| Snapshot::decode(b.as_slice())).transpose().map_err(db_err)?;
        Ok(DomainSnapshotGetResponse { snapshot }.encode_to_vec())
    }
}

fn db_err_str<E>(_: E) -> ErrorCode {
    error!("domains: повреждённый ключ в хранилище");
    ErrorCode::Unavailable
}
