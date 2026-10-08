//! Каркас доменов (T092, R11, FR-044, D-16): контейнеры, ключи эпох, AEAD
//! операций и снимков, журнал грантов, раздача ключа по E2E, сведение LWW.
//!
//! Контейнер задаётся генезисом — `SignedOp` (domain "domain", op_type
//! "container") с payload `Container`, подписанным устройством владельца.
//! Гранты — хэш-цепочка записей `SignedOp` "grant"/"revoke" с payload `Grant`
//! (позиция `version`/`prev_hash` подписана вместе с грантом); подписант обязан
//! быть админом по состоянию `version-1`. Отзыв поднимает `key_epoch`: новый
//! ключ эпохи раздаётся (`ContainerKeyShare` по E2E) всем, кроме отозванного,
//! поэтому новые операции ему не открыть.
//!
//! Операция журнала: `aead_ciphertext = nonce(12) ‖ ChaCha20-Poly1305(ключ
//! эпохи)`, AAD = `"parvane/v2/domain-op\0" ‖ u8(len(ref.domain)) ‖ ref.domain
//! ‖ ref.id ‖ u8(len(domain)) ‖ domain ‖ epoch(u64 BE) ‖ op_id`. Автор
//! подписывает `SealDigest{key_epoch, SHA-256(шифртекста)}` (SignedOp "op",
//! target = контейнер, op_id — тот же, что в AAD). Сервер проверяет подпись и
//! дайджест, не зная ключа; клиент проверяет подпись и право автора, затем
//! снимает AEAD — fail-closed (инвариант 9). Снимок — то же с контекстом
//! `"parvane/v2/domain-snapshot\0"` и `upto_seq` в AAD и дайджесте.
//!
//! Сведение (CRDT) — внутри шифрования по схеме домена. Здесь — общие
//! LWW-примитивы: метка `(lamport, device_id)`, `LwwMap` (тестовый домен
//! `sample.v1`) и `cloud::LwwTree` (облако: дерево с LWW-перемещениями).
//! Сведение коммутативно: одинаковый результат при любом порядке применения.
//! Защита от «вечного победителя» (D-16) — `LamportGuard`, применяемый в
//! порядке `seq` журнала (одинаковом у всех клиентов).

use std::collections::{BTreeMap, BTreeSet};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use prost::Message;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{
    grant, Container, ContainerKeyShare, ContainerOp, Grant, GrantLevel, LwwStamp, OpBody, OpHeader, Ref, SealDigest,
    SignedOp, Snapshot, UserRef,
};
use crate::sign::{self, ctx, OpSigner};

/// `header.domain` всех подписей каркаса.
pub const DOMAIN: &str = "domain";
pub const OP_CONTAINER: &str = "container";
pub const OP_OP: &str = "op";
pub const OP_SNAPSHOT: &str = "snapshot";
pub const OP_GRANT: &str = "grant";
pub const OP_REVOKE: &str = "revoke";
/// Смена эпохи без отзыва гранта (spec 010, R6): запись журнала грантов без grantee.
pub const OP_ROTATE: &str = "rotate";

/// Первая эпоха ключа (генезис).
pub const FIRST_EPOCH: u64 = 1;
pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Открытый текст операции ≤ 256 КиБ (как payload v1); снимка ≤ 1 МиБ.
pub const MAX_OP_PLAINTEXT: usize = 262_144;
pub const MAX_SNAPSHOT_PLAINTEXT: usize = 1_048_576;
/// Байтовый бюджет страницы синхронизации журнала контейнера.
pub const SYNC_MAX_BYTES: u32 = 716_800;
/// D-16: метка не может обогнать виденный максимум больше чем на 2^20.
pub const LAMPORT_MAX_JUMP: u64 = 1 << 20;
pub const ZERO_HASH: [u8; 32] = [0u8; 32];

/// Ключ эпохи контейнера (обнуляется при освобождении).
pub type EpochKey = Zeroizing<[u8; KEY_LEN]>;

/// Новый случайный ключ эпохи.
pub fn new_epoch_key() -> EpochKey {
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, k.as_mut());
    k
}

/// Связка ключей контейнера по эпохам (старые нужны для чтения истории).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeyRing {
    keys: BTreeMap<u64, EpochKey>,
}

impl KeyRing {
    pub fn insert(&mut self, epoch: u64, key: EpochKey) {
        self.keys.insert(epoch, key);
    }
    pub fn get(&self, epoch: u64) -> Option<&[u8; KEY_LEN]> {
        self.keys.get(&epoch).map(|k| &**k)
    }
    /// Последняя известная эпоха и её ключ.
    pub fn latest(&self) -> Option<(u64, &[u8; KEY_LEN])> {
        self.keys.iter().next_back().map(|(e, k)| (*e, &**k))
    }
}

/// Имя схемы домена: `[a-z0-9_.]{1,32}` (как domain/op_type подписи).
pub fn check_domain_name(name: &str) -> Result<()> {
    if sign::is_valid_name(name) {
        Ok(())
    } else {
        Err(ProtoError::InvalidField("domain"))
    }
}

fn container_ref(c: &Container) -> Result<&Ref> {
    let r = c.r#ref.as_ref().ok_or(ProtoError::InvalidField("ref"))?;
    address::check_ref(r)?;
    Ok(r)
}

fn header(op_type: &str, target: &Ref, ts_ms: i64) -> OpHeader {
    header_with(op_type, target, ts_ms, sign::new_op_id())
}

fn header_with(op_type: &str, target: &Ref, ts_ms: i64, op_id: Vec<u8>) -> OpHeader {
    OpHeader {
        domain: DOMAIN.into(),
        op_type: op_type.into(),
        proto_minor: crate::PROTO_MINOR,
        op_id,
        target: Some(target.clone()),
        ts_ms,
        ..Default::default()
    }
}

/// Хэш записи журнала грантов (и генезиса):
/// SHA-256("parvane/v2/domain-grant\0" ‖ body ‖ signature).
pub fn entry_hash(op: &SignedOp) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(ctx::DOMAIN_GRANT_HASH);
    h.update(&op.body);
    h.update(&op.signature);
    h.finalize().into()
}

// ── генезис ─────────────────────────────────────────────────────────────────

/// Создать контейнер: новая ссылка на домене сервера, эпоха 1, генезис,
/// подписанный устройством владельца.
pub fn new_container(signer: &dyn OpSigner, server_domain: &str, domain: &str, owner: &str, ts_ms: i64) -> Result<(Container, SignedOp)> {
    let r = address::new_ref(server_domain)?;
    sign_genesis(signer, r, domain, owner, ts_ms)
}

/// Генезис для заданной ссылки.
pub fn sign_genesis(signer: &dyn OpSigner, r: Ref, domain: &str, owner: &str, ts_ms: i64) -> Result<(Container, SignedOp)> {
    address::check_ref(&r)?;
    check_domain_name(domain)?;
    if !address::is_valid_address(owner) {
        return Err(ProtoError::BadAddress);
    }
    let c = Container { r#ref: Some(r.clone()), domain: domain.into(), owner: Some(UserRef { address: owner.into() }), key_epoch: FIRST_EPOCH };
    let op = sign::sign_op(signer, header(OP_CONTAINER, &r, ts_ms), c.encode_to_vec())?;
    Ok((c, op))
}

/// Проверенный генезис (без привязки ключа к владельцу — это делает
/// `ContainerAccess::from_genesis` через резолвер).
pub fn verify_genesis(op: &SignedOp) -> Result<(Container, [u8; 32])> {
    let v = sign::verify_op(op, DOMAIN, OP_CONTAINER, None)?;
    let c: Container = decode_checked(&v.payload, Origin::Client)?;
    let r = container_ref(&c)?;
    v.require_target(r)?;
    check_domain_name(&c.domain)?;
    let owner = c.owner.as_ref().ok_or(ProtoError::InvalidField("owner"))?;
    address::check_user(owner)?;
    if c.key_epoch != FIRST_EPOCH {
        return Err(ProtoError::InvalidField("key_epoch"));
    }
    Ok((c, v.signer))
}

// ── AEAD операций и снимков ─────────────────────────────────────────────────

fn seal_aad(context: &[u8], container: &Ref, domain: &str, epoch: u64, upto: Option<u64>, op_id: &[u8]) -> Vec<u8> {
    let mut a = Vec::with_capacity(context.len() + container.domain.len() + domain.len() + 58);
    a.extend_from_slice(context);
    // Длины проверены (check_ref: ≤ 128, check_domain_name: ≤ 32) — умещаются в u8.
    a.push(container.domain.len() as u8);
    a.extend_from_slice(container.domain.as_bytes());
    a.extend_from_slice(&container.id);
    a.push(domain.len() as u8);
    a.extend_from_slice(domain.as_bytes());
    a.extend_from_slice(&epoch.to_be_bytes());
    if let Some(u) = upto {
        a.extend_from_slice(&u.to_be_bytes());
    }
    a.extend_from_slice(op_id);
    a
}

fn aead_seal(key: &[u8; KEY_LEN], aad: &[u8], pt: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: pt, aad }).map_err(|_| ProtoError::Crypto)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn aead_open(key: &[u8; KEY_LEN], aad: &[u8], data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.len() < NONCE_LEN + TAG_LEN {
        return Err(ProtoError::Crypto);
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad }).map(Zeroizing::new).map_err(|_| ProtoError::Crypto)
}

struct Sealed {
    ciphertext: Vec<u8>,
    author: SignedOp,
}

#[allow(clippy::too_many_arguments)]
fn seal_signed(
    signer: &dyn OpSigner,
    op_type: &str,
    aad_ctx: &[u8],
    container: &Container,
    epoch: u64,
    key: &[u8; KEY_LEN],
    upto: Option<u64>,
    plaintext: &[u8],
    ts_ms: i64,
) -> Result<Sealed> {
    seal_signed_with(signer, op_type, aad_ctx, container, epoch, key, upto, plaintext, ts_ms, None)
}

#[allow(clippy::too_many_arguments)]
fn seal_signed_with(
    signer: &dyn OpSigner,
    op_type: &str,
    aad_ctx: &[u8],
    container: &Container,
    epoch: u64,
    key: &[u8; KEY_LEN],
    upto: Option<u64>,
    plaintext: &[u8],
    ts_ms: i64,
    op_id: Option<Vec<u8>>,
) -> Result<Sealed> {
    let r = container_ref(container)?;
    check_domain_name(&container.domain)?;
    if epoch == 0 {
        return Err(ProtoError::InvalidField("key_epoch"));
    }
    let h = match op_id {
        Some(id) => header_with(op_type, r, ts_ms, id),
        None => header(op_type, r, ts_ms),
    };
    let aad = seal_aad(aad_ctx, r, &container.domain, epoch, upto, &h.op_id);
    let ciphertext = aead_seal(key, &aad, plaintext)?;
    let digest = SealDigest { key_epoch: epoch, ciphertext_sha256: Sha256::digest(&ciphertext).to_vec(), upto_seq: upto.unwrap_or(0) };
    let author = sign::sign_op(signer, h, digest.encode_to_vec())?;
    Ok(Sealed { ciphertext, author })
}

/// Результат проверки подписи автора операции/снимка.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSeal {
    /// Ключ устройства автора (32 байта).
    pub signer: [u8; 32],
    pub op_id: Vec<u8>,
    pub ts_ms: i64,
}

fn verify_seal_inner(author: Option<&SignedOp>, op_type: &str, container: Option<&Ref>, epoch: u64, ct: &[u8], upto: u64) -> Result<VerifiedSeal> {
    let author = author.ok_or(ProtoError::InvalidField("author"))?;
    let container = container.ok_or(ProtoError::InvalidField("container"))?;
    address::check_ref(container)?;
    if epoch == 0 {
        return Err(ProtoError::InvalidField("key_epoch"));
    }
    if ct.len() < NONCE_LEN + TAG_LEN {
        return Err(ProtoError::InvalidField("aead_ciphertext"));
    }
    let v = sign::verify_op(author, DOMAIN, op_type, None)?;
    v.require_target(container)?;
    let d: SealDigest = decode_checked(&v.payload, Origin::Client)?;
    if d.key_epoch != epoch || d.upto_seq != upto {
        return Err(ProtoError::ContextMismatch);
    }
    if d.ciphertext_sha256.as_slice() != Sha256::digest(ct).as_slice() {
        return Err(ProtoError::ContextMismatch);
    }
    Ok(VerifiedSeal { signer: v.signer, op_id: v.header.op_id, ts_ms: v.header.ts_ms })
}

/// Зашифровать и подписать операцию журнала контейнера.
pub fn seal_op(signer: &dyn OpSigner, container: &Container, epoch: u64, key: &[u8; KEY_LEN], plaintext: &[u8], ts_ms: i64) -> Result<ContainerOp> {
    if plaintext.len() > MAX_OP_PLAINTEXT {
        return Err(ProtoError::FieldLimit("plaintext"));
    }
    let s = seal_signed(signer, OP_OP, ctx::DOMAIN_OP_AAD, container, epoch, key, None, plaintext, ts_ms)?;
    Ok(ContainerOp { container: container.r#ref.clone(), key_epoch: epoch, aead_ciphertext: s.ciphertext, author: Some(s.author), seq: 0 })
}

/// То же с заданным `op_id` (16 байт UUIDv7): повтор отправки той же
/// операции после обрыва получает тот же id — сервер отвечает DUPLICATE,
/// а не пишет вторую копию (spec 010, FR-006).
pub fn seal_op_with_id(signer: &dyn OpSigner, container: &Container, epoch: u64, key: &[u8; KEY_LEN], plaintext: &[u8], ts_ms: i64, op_id: &[u8]) -> Result<ContainerOp> {
    if plaintext.len() > MAX_OP_PLAINTEXT {
        return Err(ProtoError::FieldLimit("plaintext"));
    }
    if op_id.len() != 16 {
        return Err(ProtoError::InvalidField("op_id"));
    }
    let s = seal_signed_with(signer, OP_OP, ctx::DOMAIN_OP_AAD, container, epoch, key, None, plaintext, ts_ms, Some(op_id.to_vec()))?;
    Ok(ContainerOp { container: container.r#ref.clone(), key_epoch: epoch, aead_ciphertext: s.ciphertext, author: Some(s.author), seq: 0 })
}

/// Проверка подписи автора и дайджеста шифртекста (сервер и клиент; ключ не нужен).
pub fn verify_op_seal(op: &ContainerOp) -> Result<VerifiedSeal> {
    verify_seal_inner(op.author.as_ref(), OP_OP, op.container.as_ref(), op.key_epoch, &op.aead_ciphertext, 0)
}

/// Снять AEAD операции (после проверки подписи — fail-closed).
pub fn open_op(op: &ContainerOp, container: &Container, key: &[u8; KEY_LEN]) -> Result<Zeroizing<Vec<u8>>> {
    let seal = verify_op_seal(op)?;
    let r = container_ref(container)?;
    if op.container.as_ref() != Some(r) {
        return Err(ProtoError::ContextMismatch);
    }
    let aad = seal_aad(ctx::DOMAIN_OP_AAD, r, &container.domain, op.key_epoch, None, &seal.op_id);
    aead_open(key, &aad, &op.aead_ciphertext)
}

/// Зашифровать и подписать снимок состояния до `upto_seq` включительно.
pub fn seal_snapshot(signer: &dyn OpSigner, container: &Container, epoch: u64, key: &[u8; KEY_LEN], upto_seq: u64, plaintext: &[u8], ts_ms: i64) -> Result<Snapshot> {
    if plaintext.len() > MAX_SNAPSHOT_PLAINTEXT {
        return Err(ProtoError::FieldLimit("plaintext"));
    }
    let s = seal_signed(signer, OP_SNAPSHOT, ctx::DOMAIN_SNAPSHOT_AAD, container, epoch, key, Some(upto_seq), plaintext, ts_ms)?;
    Ok(Snapshot { container: container.r#ref.clone(), upto_seq, key_epoch: epoch, aead_ciphertext: s.ciphertext, author: Some(s.author) })
}

pub fn verify_snapshot_seal(s: &Snapshot) -> Result<VerifiedSeal> {
    verify_seal_inner(s.author.as_ref(), OP_SNAPSHOT, s.container.as_ref(), s.key_epoch, &s.aead_ciphertext, s.upto_seq)
}

pub fn open_snapshot(s: &Snapshot, container: &Container, key: &[u8; KEY_LEN]) -> Result<Zeroizing<Vec<u8>>> {
    let seal = verify_snapshot_seal(s)?;
    let r = container_ref(container)?;
    if s.container.as_ref() != Some(r) {
        return Err(ProtoError::ContextMismatch);
    }
    let aad = seal_aad(ctx::DOMAIN_SNAPSHOT_AAD, r, &container.domain, s.key_epoch, Some(s.upto_seq), &seal.op_id);
    aead_open(key, &aad, &s.aead_ciphertext)
}

// ── гранты ──────────────────────────────────────────────────────────────────

/// Получатель гранта.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Grantee {
    User(String),
    Group { domain: String, id: Vec<u8> },
}

impl Grantee {
    pub fn from_pb(g: Option<&grant::Grantee>) -> Result<Self> {
        match g {
            Some(grant::Grantee::User(u)) => {
                address::check_user(u)?;
                Ok(Grantee::User(u.address.clone()))
            }
            Some(grant::Grantee::Group(r)) => {
                address::check_ref(r)?;
                Ok(Grantee::Group { domain: r.domain.clone(), id: r.id.clone() })
            }
            None => Err(ProtoError::InvalidField("grantee")),
        }
    }

    pub fn to_pb(&self) -> grant::Grantee {
        match self {
            Grantee::User(u) => grant::Grantee::User(UserRef { address: u.clone() }),
            Grantee::Group { domain, id } => grant::Grantee::Group(Ref { domain: domain.clone(), id: id.clone() }),
        }
    }

    fn covers(&self, user: &str, groups: Membership) -> bool {
        match self {
            Grantee::User(u) => u == user,
            g @ Grantee::Group { .. } => groups(g, user),
        }
    }
}

/// Автор подписи: пользователь и устройство (по ключу из проверенного
/// сертификата у клиента, через identity `key_owner` у сервера).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub user: String,
    pub device_id: String,
}

/// Ключ устройства → автор.
pub type KeyResolver<'a> = &'a dyn Fn(&[u8; 32]) -> Option<Author>;
/// Членство пользователя в группе-получателе гранта (по журналу группы).
pub type Membership<'a> = &'a dyn Fn(&Grantee, &str) -> bool;

/// Без групповых грантов.
pub fn no_groups(_: &Grantee, _: &str) -> bool {
    false
}

/// Изменение, внесённое записью журнала грантов.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantEvent {
    pub version: u64,
    pub key_epoch: u64,
    pub grantee: Grantee,
    /// `None` — отзыв либо смена эпохи.
    pub level: Option<GrantLevel>,
    pub signer: Author,
    /// Запись "rotate": гранты не менялись, поднята только эпоха; `grantee` —
    /// владелец (формально), в таблицы грантов не пишется.
    pub rotate: bool,
}

/// Подписать грант (выдача/смена уровня) от имени админа.
pub fn sign_grant(signer: &dyn OpSigner, access: &ContainerAccess, grantee: &Grantee, level: GrantLevel, ts_ms: i64) -> Result<SignedOp> {
    if level == GrantLevel::Unspecified {
        return Err(ProtoError::InvalidField("level"));
    }
    sign_grant_entry(signer, access, OP_GRANT, Some(grantee), level, access.epoch, ts_ms)
}

/// Подписать отзыв: новая эпоха `epoch + 1` (ключ новой эпохи раздаётся всем,
/// кроме отозванного).
pub fn sign_revoke(signer: &dyn OpSigner, access: &ContainerAccess, grantee: &Grantee, ts_ms: i64) -> Result<SignedOp> {
    let next = access.epoch.checked_add(1).ok_or(ProtoError::InvalidField("key_epoch"))?;
    sign_grant_entry(signer, access, OP_REVOKE, Some(grantee), GrantLevel::Unspecified, next, ts_ms)
}

/// Подписать смену эпохи (spec 010): `epoch + 1`, гранты прежние; новый ключ
/// раздаётся всем получателям ключа (кроме отозванных устройств владельца —
/// у них его больше нет по E2E).
pub fn sign_rotate(signer: &dyn OpSigner, access: &ContainerAccess, ts_ms: i64) -> Result<SignedOp> {
    let next = access.epoch.checked_add(1).ok_or(ProtoError::InvalidField("key_epoch"))?;
    sign_grant_entry(signer, access, OP_ROTATE, None, GrantLevel::Unspecified, next, ts_ms)
}

fn sign_grant_entry(signer: &dyn OpSigner, access: &ContainerAccess, op_type: &str, grantee: Option<&Grantee>, level: GrantLevel, key_epoch: u64, ts_ms: i64) -> Result<SignedOp> {
    let r = access.container_ref()?.clone();
    let g = Grant {
        container: Some(r.clone()),
        grantee: grantee.map(Grantee::to_pb),
        level: level as i32,
        key_epoch,
        version: access.version + 1,
        prev_hash: access.head_hash().to_vec(),
    };
    sign::sign_op(signer, header(op_type, &r, ts_ms), g.encode_to_vec())
}

/// Состояние доступа к контейнеру после проверки генезиса и журнала грантов.
/// Одна реализация для сервера (проверка записи) и клиентов (проверка автора,
/// раздача ключей).
#[derive(Debug, Clone, PartialEq)]
pub struct ContainerAccess {
    /// Контейнер; `key_epoch` — текущая эпоха.
    pub container: Container,
    pub owner: String,
    pub epoch: u64,
    /// Версия журнала грантов (0 — только генезис).
    pub version: u64,
    /// `hashes[0]` — генезис, `hashes[v]` — запись v (обнаружение форка, D-03).
    pub hashes: Vec<[u8; 32]>,
    /// Текущие гранты (владелец — всегда ADMIN, в карте его нет).
    pub grants: BTreeMap<Grantee, GrantLevel>,
    /// Кто вправе писать в каждой эпохе (для проверки автора истории).
    writers: BTreeMap<u64, BTreeSet<Grantee>>,
}

impl ContainerAccess {
    /// Проверить генезис: подпись, поля, подписант — устройство владельца.
    pub fn from_genesis(genesis: &SignedOp, resolve: KeyResolver) -> Result<Self> {
        let (container, signer) = verify_genesis(genesis)?;
        let owner = container.owner.as_ref().map(|u| u.address.clone()).ok_or(ProtoError::InvalidField("owner"))?;
        match resolve(&signer) {
            Some(a) if a.user == owner => {}
            _ => return Err(ProtoError::Forbidden),
        }
        let mut writers = BTreeMap::new();
        writers.insert(FIRST_EPOCH, BTreeSet::new());
        Ok(Self { container, owner, epoch: FIRST_EPOCH, version: 0, hashes: vec![entry_hash(genesis)], grants: BTreeMap::new(), writers })
    }

    /// Генезис + записи по порядку.
    pub fn replay(genesis: &SignedOp, entries: &[SignedOp], resolve: KeyResolver, groups: Membership) -> Result<Self> {
        let mut s = Self::from_genesis(genesis, resolve)?;
        for e in entries {
            s.apply(e, resolve, groups)?;
        }
        Ok(s)
    }

    pub fn container_ref(&self) -> Result<&Ref> {
        container_ref(&self.container)
    }

    /// Хэш головы журнала грантов.
    pub fn head_hash(&self) -> [u8; 32] {
        self.hashes.last().copied().unwrap_or(ZERO_HASH)
    }

    /// Уровень пользователя сейчас: владелец — ADMIN, иначе максимум из прямого
    /// и групповых грантов.
    pub fn level_of(&self, user: &str, groups: Membership) -> Option<GrantLevel> {
        if user == self.owner {
            return Some(GrantLevel::Admin);
        }
        self.grants.iter().filter(|(g, _)| g.covers(user, groups)).map(|(_, l)| *l).max()
    }

    pub fn can_read(&self, user: &str, groups: Membership) -> bool {
        self.level_of(user, groups).is_some_and(|l| l >= GrantLevel::Read)
    }

    pub fn can_write(&self, user: &str, groups: Membership) -> bool {
        self.level_of(user, groups).is_some_and(|l| l >= GrantLevel::Write)
    }

    pub fn can_admin(&self, user: &str, groups: Membership) -> bool {
        self.level_of(user, groups) == Some(GrantLevel::Admin)
    }

    /// Имел ли пользователь право записи в эпоху `epoch` (понижение уровня
    /// внутри эпохи действует со следующей эпохи — ключ у него уже был).
    pub fn could_write_at(&self, user: &str, epoch: u64, groups: Membership) -> bool {
        if user == self.owner {
            return epoch >= FIRST_EPOCH && epoch <= self.epoch;
        }
        self.writers.get(&epoch).is_some_and(|w| w.iter().any(|g| g.covers(user, groups)))
    }

    /// Кому раздавать ключ текущей эпохи: владелец и все получатели грантов.
    pub fn key_recipients(&self) -> Vec<Grantee> {
        let mut v = vec![Grantee::User(self.owner.clone())];
        v.extend(self.grants.keys().cloned());
        v
    }

    /// Применить запись журнала грантов ("grant", "revoke" или "rotate").
    pub fn apply(&mut self, op: &SignedOp, resolve: KeyResolver, groups: Membership) -> Result<GrantEvent> {
        // op_type — из присланного тела; verify_op сверит его с подписью.
        let body: OpBody = decode_checked(&op.body, Origin::Client)?;
        let op_type = match body.header.as_ref().map(|h| h.op_type.as_str()) {
            Some(OP_GRANT) => OP_GRANT,
            Some(OP_REVOKE) => OP_REVOKE,
            Some(OP_ROTATE) => OP_ROTATE,
            _ => return Err(ProtoError::ContextMismatch),
        };
        let revoke = op_type == OP_REVOKE;
        let rotate = op_type == OP_ROTATE;
        let v = sign::verify_op(op, DOMAIN, op_type, None)?;
        let cref = self.container_ref()?.clone();
        v.require_target(&cref)?;
        let g: Grant = decode_checked(&v.payload, Origin::Client)?;
        if g.container.as_ref() != Some(&cref) {
            return Err(ProtoError::ContextMismatch);
        }
        if g.version != self.version + 1 || g.prev_hash.as_slice() != self.head_hash().as_slice() {
            return Err(ProtoError::BrokenChain);
        }
        let signer = resolve(&v.signer).ok_or(ProtoError::Forbidden)?;
        if !self.can_admin(&signer.user, groups) {
            return Err(ProtoError::Forbidden);
        }
        if rotate {
            // Смена эпохи: без grantee и уровня, key_epoch = текущая + 1; состав
            // писателей новой эпохи — прежний.
            let next = self.epoch.checked_add(1).ok_or(ProtoError::InvalidField("key_epoch"))?;
            if g.grantee.is_some() || g.level != GrantLevel::Unspecified as i32 || g.key_epoch != next {
                return Err(ProtoError::InvalidField("key_epoch"));
            }
            self.epoch = next;
            let w: BTreeSet<Grantee> = self.grants.iter().filter(|(_, l)| **l >= GrantLevel::Write).map(|(g, _)| g.clone()).collect();
            self.writers.insert(next, w);
            self.version += 1;
            self.hashes.push(entry_hash(op));
            self.container.key_epoch = self.epoch;
            return Ok(GrantEvent { version: self.version, key_epoch: self.epoch, grantee: Grantee::User(self.owner.clone()), level: None, signer, rotate: true });
        }
        let grantee = Grantee::from_pb(g.grantee.as_ref())?;
        if grantee == Grantee::User(self.owner.clone()) {
            return Err(ProtoError::Forbidden);
        }
        let level = GrantLevel::try_from(g.level).map_err(|_| ProtoError::InvalidField("level"))?;
        let event_level = if revoke {
            let next = self.epoch.checked_add(1).ok_or(ProtoError::InvalidField("key_epoch"))?;
            if level != GrantLevel::Unspecified || g.key_epoch != next {
                return Err(ProtoError::InvalidField("key_epoch"));
            }
            if self.grants.remove(&grantee).is_none() {
                return Err(ProtoError::InvalidField("grantee"));
            }
            self.epoch = next;
            let w: BTreeSet<Grantee> = self.grants.iter().filter(|(_, l)| **l >= GrantLevel::Write).map(|(g, _)| g.clone()).collect();
            self.writers.insert(next, w);
            None
        } else {
            if level == GrantLevel::Unspecified {
                return Err(ProtoError::InvalidField("level"));
            }
            if g.key_epoch != self.epoch {
                return Err(ProtoError::Expired);
            }
            self.grants.insert(grantee.clone(), level);
            if level >= GrantLevel::Write {
                self.writers.entry(self.epoch).or_default().insert(grantee.clone());
            }
            Some(level)
        };
        self.version += 1;
        self.hashes.push(entry_hash(op));
        self.container.key_epoch = self.epoch;
        Ok(GrantEvent { version: self.version, key_epoch: self.epoch, grantee, level: event_level, signer, rotate: false })
    }

    /// Клиент: проверить автора операции — подпись, дайджест, эпоха известна,
    /// автор имел право записи в этой эпохе.
    pub fn check_op_author(&self, op: &ContainerOp, resolve: KeyResolver, groups: Membership) -> Result<Author> {
        if op.container.as_ref() != Some(self.container_ref()?) {
            return Err(ProtoError::ContextMismatch);
        }
        let seal = verify_op_seal(op)?;
        self.author_at(&seal, op.key_epoch, resolve, groups)
    }

    pub fn check_snapshot_author(&self, s: &Snapshot, resolve: KeyResolver, groups: Membership) -> Result<Author> {
        if s.container.as_ref() != Some(self.container_ref()?) {
            return Err(ProtoError::ContextMismatch);
        }
        let seal = verify_snapshot_seal(s)?;
        self.author_at(&seal, s.key_epoch, resolve, groups)
    }

    fn author_at(&self, seal: &VerifiedSeal, epoch: u64, resolve: KeyResolver, groups: Membership) -> Result<Author> {
        if epoch > self.epoch {
            // Журнал грантов отстаёт — сначала догнать.
            return Err(ProtoError::Expired);
        }
        let a = resolve(&seal.signer).ok_or(ProtoError::Forbidden)?;
        if !self.could_write_at(&a.user, epoch, groups) {
            return Err(ProtoError::Forbidden);
        }
        Ok(a)
    }

    /// Сообщение раздачи ключа эпохи (отправляется по E2E каждому получателю).
    pub fn key_share(&self, epoch: u64, key: &[u8; KEY_LEN]) -> Result<ContainerKeyShare> {
        if epoch == 0 || epoch > self.epoch {
            return Err(ProtoError::InvalidField("key_epoch"));
        }
        Ok(ContainerKeyShare {
            container: Some(self.container_ref()?.clone()),
            domain: self.container.domain.clone(),
            key_epoch: epoch,
            key: key.to_vec(),
            grant_version: self.version,
            grant_head_hash: self.head_hash().to_vec(),
        })
    }

    /// Принять ключ эпохи от `sender` (пользователь — из Olm-сессии). Ключ
    /// раздаёт только админ; голова журнала раздающего обязана совпасть с
    /// нашей историей (форк → отказ), более новая голова — сначала догнать.
    pub fn accept_key_share(&self, share: &ContainerKeyShare, sender: &str, groups: Membership) -> Result<(u64, EpochKey)> {
        if share.container.as_ref() != Some(self.container_ref()?) || share.domain != self.container.domain {
            return Err(ProtoError::ContextMismatch);
        }
        if !self.can_admin(sender, groups) {
            return Err(ProtoError::Forbidden);
        }
        if share.grant_version > self.version {
            return Err(ProtoError::Expired);
        }
        let known = usize::try_from(share.grant_version).ok().and_then(|i| self.hashes.get(i)).ok_or(ProtoError::BrokenChain)?;
        if share.grant_head_hash.as_slice() != known.as_slice() {
            return Err(ProtoError::BrokenChain);
        }
        if share.key_epoch == 0 || share.key_epoch > self.epoch {
            return Err(ProtoError::InvalidField("key_epoch"));
        }
        let arr: [u8; KEY_LEN] = share.key.as_slice().try_into().map_err(|_| ProtoError::InvalidField("key"))?;
        Ok((share.key_epoch, Zeroizing::new(arr)))
    }
}

/// Разобрать `ContainerKeyShare`, пришедший по E2E.
pub fn decode_key_share(bytes: &[u8]) -> Result<ContainerKeyShare> {
    let s: ContainerKeyShare = decode_checked(bytes, Origin::Client)?;
    if let Some(r) = &s.container {
        address::check_ref(r)?;
    }
    Ok(s)
}

// ── LWW-примитивы ───────────────────────────────────────────────────────────

/// Метка LWW: порядок `(lamport, device_id)`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp {
    pub lamport: u64,
    pub device_id: String,
}

impl Stamp {
    pub fn new(lamport: u64, device_id: &str) -> Self {
        Self { lamport, device_id: device_id.into() }
    }

    pub fn from_pb(s: Option<&LwwStamp>) -> Result<Self> {
        let s = s.ok_or(ProtoError::InvalidField("stamp"))?;
        if s.lamport == 0 {
            return Err(ProtoError::InvalidField("lamport"));
        }
        if !address::is_valid_device_id(&s.device_id) {
            return Err(ProtoError::InvalidField("device_id"));
        }
        Ok(Self { lamport: s.lamport, device_id: s.device_id.clone() })
    }

    pub fn to_pb(&self) -> LwwStamp {
        LwwStamp { lamport: self.lamport, device_id: self.device_id.clone() }
    }
}

/// Часы Лэмпорта устройства и защита от «вечного победителя» (D-16):
/// метка не выше виденного максимума + 2^20. Применяется в порядке `seq`
/// журнала — у всех клиентов одинаково, поэтому детерминировано.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LamportGuard {
    max_seen: u64,
}

impl LamportGuard {
    pub fn max_seen(&self) -> u64 {
        self.max_seen
    }

    pub fn check(&mut self, stamp: &Stamp) -> Result<()> {
        if stamp.lamport == 0 || stamp.lamport > self.max_seen.saturating_add(LAMPORT_MAX_JUMP) {
            return Err(ProtoError::InvalidField("lamport"));
        }
        self.max_seen = self.max_seen.max(stamp.lamport);
        Ok(())
    }

    /// Следующая локальная метка.
    pub fn tick(&mut self) -> u64 {
        self.max_seen = self.max_seen.saturating_add(1);
        self.max_seen
    }
}

/// Ячейка LWW-карты.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LwwCell {
    pub stamp: Stamp,
    pub deleted: bool,
    pub value: Vec<u8>,
}

impl LwwCell {
    /// Полный порядок: метка, затем (deleted, value) — детерминированный
    /// разрыв равенства даже для сломанного устройства с повтором метки.
    fn order_key(&self) -> (&Stamp, bool, &[u8]) {
        (&self.stamp, self.deleted, &self.value)
    }
}

/// LWW-карта key → value. `apply` коммутативно, ассоциативно и идемпотентно.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LwwMap {
    cells: BTreeMap<String, LwwCell>,
}

impl LwwMap {
    /// Применить запись; `true`, если она победила.
    pub fn apply(&mut self, key: &str, cell: LwwCell) -> bool {
        match self.cells.get(key) {
            Some(cur) if cur.order_key() >= cell.order_key() => false,
            _ => {
                self.cells.insert(key.to_string(), cell);
                true
            }
        }
    }

    /// Свести с другой картой.
    pub fn merge(&mut self, other: &LwwMap) {
        for (k, c) in &other.cells {
            self.apply(k, c.clone());
        }
    }

    /// Живое значение ключа (надгробие → `None`).
    pub fn get(&self, key: &str) -> Option<&[u8]> {
        self.cells.get(key).filter(|c| !c.deleted).map(|c| c.value.as_slice())
    }

    /// Все ячейки, включая надгробия (для снимка).
    pub fn cells(&self) -> impl Iterator<Item = (&String, &LwwCell)> {
        self.cells.iter()
    }

    /// Живые пары по порядку ключей.
    pub fn live(&self) -> BTreeMap<String, Vec<u8>> {
        self.cells.iter().filter(|(_, c)| !c.deleted).map(|(k, c)| (k.clone(), c.value.clone())).collect()
    }
}

/// Домен планировщика `parvane.planner.v1` (spec 010).
pub mod planner;
/// JSON планировщика для хостов (web): сведённое состояние и изменения.
pub mod planner_json;

/// Тестовый домен `sample.v1` (SC-005): LWW-карта.
pub mod sample {
    use super::*;
    use crate::pb::parvane::sample::v1::{SampleEntry, SampleOp, SampleSnapshot};

    pub const DOMAIN_NAME: &str = "sample.v1";

    pub fn decode_op(bytes: &[u8]) -> Result<SampleOp> {
        decode_checked(bytes, Origin::Client)
    }

    pub fn decode_snapshot(bytes: &[u8]) -> Result<SampleSnapshot> {
        decode_checked(bytes, Origin::Client)
    }

    fn cell(e: &SampleEntry) -> Result<LwwCell> {
        if e.key.is_empty() {
            return Err(ProtoError::InvalidField("key"));
        }
        if e.deleted && !e.value.is_empty() {
            return Err(ProtoError::InvalidField("value"));
        }
        Ok(LwwCell { stamp: Stamp::from_pb(e.stamp.as_ref())?, deleted: e.deleted, value: e.value.clone() })
    }

    /// Применить операцию автора `author_device`: метки операции обязаны нести
    /// устройство автора (подпись SignedOp), иначе чужая метка — отказ (D-16).
    pub fn apply_op(map: &mut LwwMap, op: &SampleOp, author_device: &str) -> Result<()> {
        let cells = op.entries.iter().map(cell).collect::<Result<Vec<_>>>()?;
        if cells.iter().any(|c| c.stamp.device_id != author_device) {
            return Err(ProtoError::ContextMismatch);
        }
        for (e, c) in op.entries.iter().zip(cells) {
            map.apply(&e.key, c);
        }
        Ok(())
    }

    /// Проверить метки операции в порядке журнала (D-16).
    pub fn guard_op(guard: &mut LamportGuard, op: &SampleOp) -> Result<()> {
        for e in &op.entries {
            guard.check(&Stamp::from_pb(e.stamp.as_ref())?)?;
        }
        Ok(())
    }

    pub fn set(key: &str, value: &[u8], stamp: &Stamp) -> SampleEntry {
        SampleEntry { key: key.into(), value: value.to_vec(), deleted: false, stamp: Some(stamp.to_pb()) }
    }

    pub fn remove(key: &str, stamp: &Stamp) -> SampleEntry {
        SampleEntry { key: key.into(), value: vec![], deleted: true, stamp: Some(stamp.to_pb()) }
    }

    pub fn snapshot(map: &LwwMap) -> SampleSnapshot {
        SampleSnapshot {
            entries: map
                .cells()
                .map(|(k, c)| SampleEntry { key: k.clone(), value: c.value.clone(), deleted: c.deleted, stamp: Some(c.stamp.to_pb()) })
                .collect(),
        }
    }

    pub fn from_snapshot(s: &SampleSnapshot) -> Result<LwwMap> {
        let mut m = LwwMap::default();
        for e in &s.entries {
            m.apply(&e.key, cell(e)?);
        }
        Ok(m)
    }
}

/// Облако как домен `cloud.v1` (T094): дерево с LWW-перемещениями. Только
/// движок сведения — продуктовая реализация отдельной фичей.
pub mod cloud {
    use super::*;
    use crate::pb::parvane::cloud::v1::{cloud_op, CloudBlobRef, CloudNodeKind, CloudOp};

    pub const DOMAIN_NAME: &str = "cloud.v1";
    pub type NodeId = [u8; 16];

    /// Узел после сведения.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Node {
        pub kind: CloudNodeKind,
        /// `None` — корень контейнера.
        pub parent: Option<NodeId>,
        pub name: String,
        pub blob: Option<CloudBlobRef>,
        pub deleted: bool,
    }

    /// Множество операций дерева; состояние — детерминированная функция
    /// множества (порядок применения не важен): перемещения проигрываются по
    /// возрастанию меток, перемещение, создающее цикл или ведущее в
    /// неизвестный/файловый узел, пропускается.
    #[derive(Debug, Clone, Default)]
    pub struct LwwTree {
        /// Вид узла; при конфликте id побеждает создание с меньшей меткой.
        kinds: BTreeMap<NodeId, (Stamp, CloudNodeKind)>,
        /// (метка, узел) → (родитель, имя).
        moves: BTreeMap<(Stamp, NodeId), (Option<NodeId>, String)>,
        blobs: BTreeMap<NodeId, (Stamp, Vec<u8>)>,
        tombstones: BTreeMap<NodeId, Stamp>,
    }

    fn node_id(b: &[u8]) -> Result<NodeId> {
        b.try_into().map_err(|_| ProtoError::InvalidField("node_id"))
    }

    fn parent_id(b: &[u8]) -> Result<Option<NodeId>> {
        if b.is_empty() {
            Ok(None)
        } else {
            node_id(b).map(Some)
        }
    }

    fn check_name(n: &str) -> Result<()> {
        if n.is_empty() || n.contains('/') || n.contains('\0') || n == "." || n == ".." {
            return Err(ProtoError::InvalidField("name"));
        }
        Ok(())
    }

    impl LwwTree {
        fn add_move(&mut self, stamp: Stamp, node: NodeId, parent: Option<NodeId>, name: String) {
            let key = (stamp, node);
            let val = (parent, name);
            // Повтор метки с другим содержимым (сломанное устройство) — берём
            // большее, чтобы не зависеть от порядка.
            match self.moves.get(&key) {
                Some(cur) if *cur >= val => {}
                _ => {
                    self.moves.insert(key, val);
                }
            }
        }

        /// Применить операцию облака (открытый текст ContainerOp).
        pub fn apply(&mut self, op: &CloudOp) -> Result<()> {
            match op.op.as_ref().ok_or(ProtoError::InvalidField("op"))? {
                cloud_op::Op::Create(c) => {
                    let id = node_id(&c.node_id)?;
                    let parent = parent_id(&c.parent_id)?;
                    check_name(&c.name)?;
                    let stamp = Stamp::from_pb(c.stamp.as_ref())?;
                    let kind = CloudNodeKind::try_from(c.kind).map_err(|_| ProtoError::InvalidField("kind"))?;
                    if kind == CloudNodeKind::Unspecified {
                        return Err(ProtoError::InvalidField("kind"));
                    }
                    match self.kinds.get(&id) {
                        Some((s, k)) if (s, *k) <= (&stamp, kind) => {}
                        _ => {
                            self.kinds.insert(id, (stamp.clone(), kind));
                        }
                    }
                    if let Some(b) = &c.blob {
                        self.set_blob(id, stamp.clone(), b);
                    }
                    self.add_move(stamp, id, parent, c.name.clone());
                }
                cloud_op::Op::Move(m) => {
                    let id = node_id(&m.node_id)?;
                    let parent = parent_id(&m.parent_id)?;
                    check_name(&m.name)?;
                    self.add_move(Stamp::from_pb(m.stamp.as_ref())?, id, parent, m.name.clone());
                }
                cloud_op::Op::SetBlob(s) => {
                    let id = node_id(&s.node_id)?;
                    let b = s.blob.as_ref().ok_or(ProtoError::InvalidField("blob"))?;
                    self.set_blob(id, Stamp::from_pb(s.stamp.as_ref())?, b);
                }
                cloud_op::Op::Delete(d) => {
                    let id = node_id(&d.node_id)?;
                    let stamp = Stamp::from_pb(d.stamp.as_ref())?;
                    match self.tombstones.get(&id) {
                        Some(cur) if *cur >= stamp => {}
                        _ => {
                            self.tombstones.insert(id, stamp);
                        }
                    }
                }
            }
            Ok(())
        }

        fn set_blob(&mut self, id: NodeId, stamp: Stamp, b: &CloudBlobRef) {
            let bytes = b.encode_to_vec();
            match self.blobs.get(&id) {
                Some((s, cur)) if (s, cur) >= (&stamp, &bytes) => {}
                _ => {
                    self.blobs.insert(id, (stamp, bytes));
                }
            }
        }

        /// `ancestor` — предок `node` (или сам узел) в текущем состоянии.
        fn is_ancestor(parents: &BTreeMap<NodeId, (Option<NodeId>, String, Stamp)>, ancestor: &NodeId, node: &NodeId) -> bool {
            let mut cur = Some(*node);
            // Циклов нет по построению; ограничение шагов — защита.
            for _ in 0..=parents.len() {
                match cur {
                    Some(c) if &c == ancestor => return true,
                    Some(c) => cur = parents.get(&c).and_then(|(p, _, _)| *p),
                    None => return false,
                }
            }
            false
        }

        /// Итоговое дерево.
        pub fn state(&self) -> BTreeMap<NodeId, Node> {
            let mut parents: BTreeMap<NodeId, (Option<NodeId>, String, Stamp)> = BTreeMap::new();
            for ((stamp, node), (parent, name)) in &self.moves {
                if !self.kinds.contains_key(node) {
                    continue;
                }
                if let Some(p) = parent {
                    let folder = matches!(self.kinds.get(p), Some((_, CloudNodeKind::Folder)));
                    if !folder || !parents.contains_key(p) || Self::is_ancestor(&parents, node, p) {
                        continue;
                    }
                }
                parents.insert(*node, (*parent, name.clone(), stamp.clone()));
            }
            parents
                .into_iter()
                .filter_map(|(id, (parent, name, move_stamp))| {
                    let (_, kind) = self.kinds.get(&id)?;
                    let blob = self.blobs.get(&id).and_then(|(_, b)| CloudBlobRef::decode(b.as_slice()).ok());
                    let deleted = self.tombstones.get(&id).is_some_and(|t| *t > move_stamp);
                    Some((id, Node { kind: *kind, parent, name, blob, deleted }))
                })
                .collect()
        }

        /// Путь узла от корня (имена), `None` — узла нет.
        pub fn path(state: &BTreeMap<NodeId, Node>, id: &NodeId) -> Option<Vec<String>> {
            let mut out = Vec::new();
            let mut cur = Some(*id);
            for _ in 0..=state.len() {
                match cur {
                    Some(c) => {
                        let n = state.get(&c)?;
                        out.push(n.name.clone());
                        cur = n.parent;
                    }
                    None => {
                        out.reverse();
                        return Some(out);
                    }
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::cloud::v1::{cloud_op, CloudCreate, CloudMove, CloudNodeKind, CloudOp};
    use ed25519_dalek::SigningKey;
    use std::collections::HashMap;

    struct World {
        keys: HashMap<[u8; 32], Author>,
    }

    impl World {
        fn new() -> Self {
            Self { keys: HashMap::new() }
        }
        fn device(&mut self, user: &str, device: &str) -> SigningKey {
            let k = sign::generate_signing_key();
            self.keys.insert(k.verifying_key().to_bytes(), Author { user: user.into(), device_id: device.into() });
            k
        }
        fn resolve(&self) -> impl Fn(&[u8; 32]) -> Option<Author> + '_ {
            move |k| self.keys.get(k).cloned()
        }
    }

    #[test]
    fn op_roundtrip_and_tamper() {
        let mut w = World::new();
        let a = w.device("alice@local", "a1");
        let (c, _) = new_container(&a, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
        let key = new_epoch_key();
        let op = seal_op(&a, &c, 1, &key, b"hello", 1).unwrap();
        assert_eq!(open_op(&op, &c, &key).unwrap().as_slice(), b"hello");
        // Изменённый байт шифртекста — отказ до выдачи данных.
        let mut bad = op.clone();
        let last = bad.aead_ciphertext.len() - 1;
        bad.aead_ciphertext[last] ^= 1;
        assert!(verify_op_seal(&bad).is_err());
        assert!(open_op(&bad, &c, &key).is_err());
        // Подмена эпохи — дайджест не сходится.
        let mut e2 = op.clone();
        e2.key_epoch = 2;
        assert_eq!(verify_op_seal(&e2), Err(ProtoError::ContextMismatch));
        // Чужой ключ — AEAD не снимается.
        assert_eq!(open_op(&op, &c, &new_epoch_key()), Err(ProtoError::Crypto));
        // Операция не проходит как снимок.
        let snap = Snapshot { container: op.container.clone(), upto_seq: 0, key_epoch: 1, aead_ciphertext: op.aead_ciphertext.clone(), author: op.author.clone() };
        assert!(verify_snapshot_seal(&snap).is_err());
    }

    #[test]
    fn snapshot_roundtrip() {
        let mut w = World::new();
        let a = w.device("alice@local", "a1");
        let (c, _) = new_container(&a, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
        let key = new_epoch_key();
        let s = seal_snapshot(&a, &c, 1, &key, 7, b"state", 1).unwrap();
        assert_eq!(open_snapshot(&s, &c, &key).unwrap().as_slice(), b"state");
        let mut moved = s.clone();
        moved.upto_seq = 8;
        assert!(open_snapshot(&moved, &c, &key).is_err());
    }

    #[test]
    fn grants_chain_and_rights() {
        let mut w = World::new();
        let a = w.device("alice@local", "a1");
        let b = w.device("bob@local", "b1");
        let (_, genesis) = new_container(&a, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
        let res = w.resolve();
        let mut acc = ContainerAccess::from_genesis(&genesis, &res).unwrap();
        // Генезис чужим ключом от имени alice — отказ.
        let (_, forged) = new_container(&b, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
        assert_eq!(ContainerAccess::from_genesis(&forged, &res).err(), Some(ProtoError::Forbidden));

        let bob = Grantee::User("bob@local".into());
        let g1 = sign_grant(&a, &acc, &bob, GrantLevel::Read, 2).unwrap();
        // Не-админ не выдаёт гранты.
        let g_bad = sign_grant(&b, &acc, &bob, GrantLevel::Admin, 2).unwrap();
        assert_eq!(acc.clone().apply(&g_bad, &res, &no_groups).err(), Some(ProtoError::Forbidden));
        acc.apply(&g1, &res, &no_groups).unwrap();
        assert!(acc.can_read("bob@local", &no_groups) && !acc.can_write("bob@local", &no_groups));
        // Повтор той же записи — цепочка не сходится.
        assert_eq!(acc.clone().apply(&g1, &res, &no_groups).err(), Some(ProtoError::BrokenChain));

        let key1 = new_epoch_key();
        let share = acc.key_share(1, &key1).unwrap();
        let (e, k) = acc.accept_key_share(&share, "alice@local", &no_groups).unwrap();
        assert_eq!((e, *k), (1, *key1));
        // Ключ от не-админа не принимается.
        assert_eq!(acc.accept_key_share(&share, "bob@local", &no_groups).err(), Some(ProtoError::Forbidden));

        let rv = sign_revoke(&a, &acc, &bob, 3).unwrap();
        let ev = acc.apply(&rv, &res, &no_groups).unwrap();
        assert_eq!((ev.key_epoch, ev.level), (2, None));
        assert!(!acc.can_read("bob@local", &no_groups));
        assert!(!acc.key_recipients().contains(&bob));
        // Форк: подменённая голова в раздаче.
        let mut fork = acc.key_share(2, &new_epoch_key()).unwrap();
        fork.grant_head_hash = vec![7; 32];
        assert_eq!(acc.accept_key_share(&fork, "alice@local", &no_groups).err(), Some(ProtoError::BrokenChain));
    }

    #[test]
    fn group_grantee() {
        let mut w = World::new();
        let a = w.device("alice@local", "a1");
        let (_, genesis) = new_container(&a, "local", sample::DOMAIN_NAME, "alice@local", 1).unwrap();
        let res = w.resolve();
        let mut acc = ContainerAccess::from_genesis(&genesis, &res).unwrap();
        let grp = Grantee::Group { domain: "local".into(), id: vec![9; 16] };
        let members = |g: &Grantee, u: &str| matches!(g, Grantee::Group { .. }) && u == "carol@local";
        let op = sign_grant(&a, &acc, &grp, GrantLevel::Write, 2).unwrap();
        acc.apply(&op, &res, &members).unwrap();
        assert!(acc.can_write("carol@local", &members));
        assert!(!acc.can_write("dave@local", &members));
        assert!(acc.could_write_at("carol@local", 1, &members));
    }

    #[test]
    fn lww_map_is_order_independent() {
        let mut m1 = LwwMap::default();
        let mut m2 = LwwMap::default();
        let c = |l, d: &str, v: &[u8]| LwwCell { stamp: Stamp::new(l, d), deleted: false, value: v.to_vec() };
        let ops = [("k", c(1, "a", b"1")), ("k", c(2, "b", b"2")), ("k", c(2, "a", b"3"))];
        for (k, v) in ops.iter() {
            m1.apply(k, v.clone());
        }
        for (k, v) in ops.iter().rev() {
            m2.apply(k, v.clone());
        }
        assert_eq!(m1, m2);
        assert_eq!(m1.get("k"), Some(&b"2"[..]));
    }

    #[test]
    fn lamport_guard_rejects_huge_jump() {
        let mut g = LamportGuard::default();
        g.check(&Stamp::new(5, "a")).unwrap();
        assert!(g.check(&Stamp::new(u64::MAX, "b")).is_err());
        assert!(g.check(&Stamp::new(5 + LAMPORT_MAX_JUMP, "b")).is_ok());
    }

    fn create(id: u8, parent: Option<u8>, name: &str, kind: CloudNodeKind, l: u64) -> CloudOp {
        CloudOp {
            op: Some(cloud_op::Op::Create(CloudCreate {
                node_id: vec![id; 16],
                kind: kind as i32,
                parent_id: parent.map(|p| vec![p; 16]).unwrap_or_default(),
                name: name.into(),
                blob: None,
                stamp: Some(Stamp::new(l, "d").to_pb()),
            })),
        }
    }

    fn mv(id: u8, parent: Option<u8>, name: &str, l: u64, dev: &str) -> CloudOp {
        CloudOp {
            op: Some(cloud_op::Op::Move(CloudMove {
                node_id: vec![id; 16],
                parent_id: parent.map(|p| vec![p; 16]).unwrap_or_default(),
                name: name.into(),
                stamp: Some(Stamp::new(l, dev).to_pb()),
            })),
        }
    }

    #[test]
    fn tree_concurrent_moves_no_cycle() {
        let base = [
            create(1, None, "A", CloudNodeKind::Folder, 1),
            create(2, None, "B", CloudNodeKind::Folder, 2),
        ];
        // Одновременно: A → внутрь B и B → внутрь A.
        let x = mv(1, Some(2), "A", 3, "d1");
        let y = mv(2, Some(1), "B", 3, "d2");
        let mut t1 = cloud::LwwTree::default();
        let mut t2 = cloud::LwwTree::default();
        for o in base.iter().chain([&x, &y]) {
            t1.apply(o).unwrap();
        }
        for o in base.iter().chain([&y, &x]).rev() {
            t2.apply(o).unwrap();
        }
        let s1 = t1.state();
        assert_eq!(s1, t2.state());
        // Метка (3,"d1") < (3,"d2"): A уехал в B, перемещение B в A создало бы цикл.
        assert_eq!(s1[&[1u8; 16]].parent, Some([2u8; 16]));
        assert_eq!(s1[&[2u8; 16]].parent, None);
    }
}
