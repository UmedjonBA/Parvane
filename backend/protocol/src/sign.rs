//! Каноничные подписи (T015, класс 6, R5).
//!
//! Подписываемые байты операции (D-10):
//! `"parvane/v2/op" ‖ u8(len(domain)) ‖ domain ‖ u8(len(op_type)) ‖ op_type ‖ body`,
//! где `body` — присланные байты ОДНОГО сообщения `OpBody`. Проверка идёт над
//! ПРИСЛАННЫМИ байтами; объект никогда не пересобирается для проверки. После
//! подписи body разбирается, и `header.domain/op_type` сверяются с ожидаемыми —
//! одна подпись не проходит как другая операция. `domain`/`op_type` —
//! `[a-z0-9_.]{1,32}`.
//!
//! Прочие подписи (сертификаты, журналы, описатель сервера, групповые
//! конверты) — через `sign_ctx`/`verify_ctx` с собственными контекстами вида
//! `"parvane/v2/<имя>\0"`; ни один контекст не является префиксом другого (D-20).

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use prost::Message;

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{DeviceRef, OpBody, OpHeader, Ref, SignedOp};

pub const OP_CONTEXT: &[u8] = b"parvane/v2/op";
/// Максимальная длина domain/op_type.
pub const MAX_NAME: usize = 32;

/// Контексты прочих подписей.
pub mod ctx {
    pub const DEVICE_CERT: &[u8] = b"parvane/v2/device-cert\0";
    /// C1-01: доказательство владения ключами устройства (подпись olm_ed25519).
    pub const DEVICE_POSSESSION: &[u8] = b"parvane/v2/device-pop\0";
    /// ID-01: доказательство устройства при выпуске сессии (`identity.session.issue`).
    pub const SESSION_PROOF: &[u8] = b"parvane/v2/session-proof\0";
    /// C1-06: AAD резервной копии корня под ключом восстановления.
    pub const ROOT_BACKUP: &[u8] = b"parvane/v2/root-backup\0";
    pub const SELF_SIGNING: &[u8] = b"parvane/v2/self-signing\0";
    pub const SERVER_DESCRIPTOR: &[u8] = b"parvane/v2/server-descriptor\0";
    pub const GROUP_ENVELOPE: &[u8] = b"parvane/v2/group-env\0";
    pub const GROUP_TYPING: &[u8] = b"parvane/v2/group-typing\0";
    pub const GROUP_JOIN: &[u8] = b"parvane/v2/group-join\0";
    pub const GROUP_ENTRY_HASH: &[u8] = b"parvane/v2/group-entry\0";
    pub const GROUP_GENESIS: &[u8] = b"parvane/v2/group-genesis\0";
    pub const DEVICE_LOG_HASH: &[u8] = b"parvane/v2/device-log\0";
    pub const OTK: &[u8] = b"parvane/v2/otk\0";
    pub const TOKEN: &[u8] = b"parvane/v2/token\0";
    pub const TOKEN_KEYS: &[u8] = b"parvane/v2/token-keys\0";
    /// Каркас доменов (domain.rs): AAD операции и снимка контейнера, хэш
    /// записи журнала грантов.
    pub const DOMAIN_OP_AAD: &[u8] = b"parvane/v2/domain-op\0";
    pub const DOMAIN_SNAPSHOT_AAD: &[u8] = b"parvane/v2/domain-snapshot\0";
    pub const DOMAIN_GRANT_HASH: &[u8] = b"parvane/v2/domain-grant\0";
    /// Межсерверный кадр (federation.proto, S2SFrame).
    pub const S2S_FRAME: &[u8] = b"parvane/v2/s2s\0";

    /// Все контексты (для проверки «ни один не префикс другого»).
    pub const ALL: &[&[u8]] = &[
        super::OP_CONTEXT,
        DEVICE_CERT,
        DEVICE_POSSESSION,
        ROOT_BACKUP,
        SELF_SIGNING,
        SERVER_DESCRIPTOR,
        GROUP_ENVELOPE,
        GROUP_TYPING,
        GROUP_JOIN,
        GROUP_ENTRY_HASH,
        GROUP_GENESIS,
        DEVICE_LOG_HASH,
        OTK,
        TOKEN,
        TOKEN_KEYS,
        S2S_FRAME,
    ];
}

pub fn is_valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_NAME
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

/// Подписываемые байты операции.
pub fn op_signing_bytes(domain: &str, op_type: &str, body: &[u8]) -> Result<Vec<u8>> {
    if !is_valid_name(domain) {
        return Err(ProtoError::InvalidField("domain"));
    }
    if !is_valid_name(op_type) {
        return Err(ProtoError::InvalidField("op_type"));
    }
    let mut v = Vec::with_capacity(OP_CONTEXT.len() + domain.len() + op_type.len() + body.len() + 2);
    v.extend_from_slice(OP_CONTEXT);
    // Длины ≤ 32 — умещаются в u8 (проверено is_valid_name).
    v.push(domain.len() as u8);
    v.extend_from_slice(domain.as_bytes());
    v.push(op_type.len() as u8);
    v.extend_from_slice(op_type.as_bytes());
    v.extend_from_slice(body);
    Ok(v)
}

/// Новый `op_id` — UUIDv7 (16 байт).
pub fn new_op_id() -> Vec<u8> {
    uuid::Uuid::now_v7().as_bytes().to_vec()
}

/// `op_id` — ровно 16 байт и версия UUID 7.
pub fn is_valid_op_id(id: &[u8]) -> bool {
    uuid::Uuid::from_slice(id).is_ok_and(|u| u.get_version_num() == 7)
}

/// Подписант Ed25519: ключ в памяти или ключ Olm-аккаунта устройства.
pub trait OpSigner {
    fn public_key(&self) -> [u8; 32];
    fn sign_bytes(&self, msg: &[u8]) -> [u8; 64];
}

impl OpSigner for SigningKey {
    fn public_key(&self) -> [u8; 32] {
        self.verifying_key().to_bytes()
    }
    fn sign_bytes(&self, msg: &[u8]) -> [u8; 64] {
        self.sign(msg).to_bytes()
    }
}

/// Подписать операцию.
pub fn sign_op(key: &dyn OpSigner, header: OpHeader, payload: Vec<u8>) -> Result<SignedOp> {
    let domain = header.domain.clone();
    let op_type = header.op_type.clone();
    let body = OpBody { header: Some(header), payload }.encode_to_vec();
    let msg = op_signing_bytes(&domain, &op_type, &body)?;
    let sig = key.sign_bytes(&msg);
    Ok(SignedOp { body, signature: sig.to_vec(), signer_key: key.public_key().to_vec() })
}

/// Проверенная операция.
#[derive(Debug, Clone)]
pub struct VerifiedOp {
    pub header: OpHeader,
    pub payload: Vec<u8>,
    /// Ключ, которым подписано (32 байта).
    pub signer: [u8; 32],
}

pub fn verifying_key(bytes: &[u8]) -> Result<VerifyingKey> {
    let arr: [u8; 32] = bytes.try_into().map_err(|_| ProtoError::BadSignature)?;
    VerifyingKey::from_bytes(&arr).map_err(|_| ProtoError::BadSignature)
}

fn signature(bytes: &[u8]) -> Result<Signature> {
    let arr: [u8; 64] = bytes.try_into().map_err(|_| ProtoError::BadSignature)?;
    Ok(Signature::from_bytes(&arr))
}

/// Проверить операцию: подпись над присланными байтами → разбор → сверка
/// контекста. `expected_signer` — если ключ подписанта известен заранее
/// (ключ устройства из сертификата, ключ отправки эпохи).
pub fn verify_op(
    op: &SignedOp,
    expected_domain: &str,
    expected_op_type: &str,
    expected_signer: Option<&[u8; 32]>,
) -> Result<VerifiedOp> {
    let vk = verifying_key(&op.signer_key)?;
    if let Some(exp) = expected_signer {
        if vk.as_bytes() != exp {
            return Err(ProtoError::BadSignature);
        }
    }
    let sig = signature(&op.signature)?;
    let msg = op_signing_bytes(expected_domain, expected_op_type, &op.body)?;
    vk.verify_strict(&msg, &sig).map_err(|_| ProtoError::BadSignature)?;
    let body: OpBody = decode_checked(&op.body, Origin::Client)?;
    let header = body.header.ok_or(ProtoError::InvalidField("header"))?;
    if header.domain != expected_domain || header.op_type != expected_op_type {
        return Err(ProtoError::ContextMismatch);
    }
    if !is_valid_op_id(&header.op_id) {
        return Err(ProtoError::InvalidField("op_id"));
    }
    if let Some(t) = &header.target {
        address::check_ref(t)?;
    }
    for d in &header.audience {
        address::check_device(d)?;
    }
    Ok(VerifiedOp { header, payload: body.payload, signer: *vk.as_bytes() })
}

impl VerifiedOp {
    /// Операция адресована именно этому объекту (звонок, группа, сообщение).
    pub fn require_target(&self, expected: &Ref) -> Result<()> {
        match &self.header.target {
            Some(t) if t == expected => Ok(()),
            _ => Err(ProtoError::ContextMismatch),
        }
    }

    /// Устройство входит в адресатов операции (SDP, sync).
    pub fn require_audience(&self, me: &DeviceRef) -> Result<()> {
        if self.header.audience.iter().any(|d| d == me) {
            Ok(())
        } else {
            Err(ProtoError::ContextMismatch)
        }
    }
}

/// Подпись с контекстом: `ctx ‖ parts...` (части фиксированной длины или
/// без `\0` — однозначность обеспечивает вызывающий).
pub fn sign_ctx(key: &dyn OpSigner, ctx: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let msg = concat(ctx, parts);
    key.sign_bytes(&msg).to_vec()
}

pub fn verify_ctx(pk: &[u8], sig: &[u8], ctx: &[u8], parts: &[&[u8]]) -> Result<()> {
    let vk = verifying_key(pk)?;
    let sig = signature(sig)?;
    vk.verify_strict(&concat(ctx, parts), &sig).map_err(|_| ProtoError::BadSignature)
}

fn concat(ctx: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut v = ctx.to_vec();
    for p in parts {
        v.extend_from_slice(p);
    }
    v
}

/// Новый ключ Ed25519.
pub fn generate_signing_key() -> SigningKey {
    SigningKey::generate(&mut rand::rngs::OsRng)
}

/// Защита от повторов в памяти (клиент/тесты): `op_id` уже видели → `Duplicate`.
/// Сервер хранит уникальность в SQLite (UNIQUE на журнал).
#[derive(Default)]
pub struct ReplayGuard {
    seen: std::collections::HashSet<Vec<u8>>,
    order: std::collections::VecDeque<Vec<u8>>,
    cap: usize,
}

impl ReplayGuard {
    pub fn new(cap: usize) -> Self {
        Self { cap, ..Default::default() }
    }

    pub fn check_and_insert(&mut self, op_id: &[u8]) -> Result<()> {
        if self.seen.contains(op_id) {
            return Err(ProtoError::Duplicate);
        }
        self.seen.insert(op_id.to_vec());
        self.order.push_back(op_id.to_vec());
        while self.order.len() > self.cap.max(1) {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(domain: &str, op: &str) -> OpHeader {
        OpHeader { domain: domain.into(), op_type: op.into(), op_id: new_op_id(), ts_ms: 1, ..Default::default() }
    }

    #[test]
    fn roundtrip() {
        let k = generate_signing_key();
        let op = sign_op(&k, header("msg", "content"), b"hi".to_vec()).unwrap();
        let v = verify_op(&op, "msg", "content", Some(k.verifying_key().as_bytes())).unwrap();
        assert_eq!(v.payload, b"hi");
    }

    #[test]
    fn cross_operation_rejected() {
        let k = generate_signing_key();
        let op = sign_op(&k, header("msg", "content"), vec![]).unwrap();
        assert_eq!(verify_op(&op, "msg", "edit", None).err(), Some(ProtoError::BadSignature));
        assert_eq!(verify_op(&op, "call", "content", None).err(), Some(ProtoError::BadSignature));
    }

    #[test]
    fn tampered_body_rejected() {
        let k = generate_signing_key();
        let mut op = sign_op(&k, header("msg", "content"), b"x".to_vec()).unwrap();
        let last = op.body.len() - 1;
        op.body[last] ^= 1;
        assert_eq!(verify_op(&op, "msg", "content", None).err(), Some(ProtoError::BadSignature));
    }

    #[test]
    fn names_are_unambiguous() {
        assert!(op_signing_bytes("ms\0g", "x", b"").is_err());
        assert!(op_signing_bytes("MSG", "x", b"").is_err());
        assert!(op_signing_bytes(&"a".repeat(33), "x", b"").is_err());
    }

    #[test]
    fn contexts_are_prefix_free() {
        for (i, a) in ctx::ALL.iter().enumerate() {
            for (j, b) in ctx::ALL.iter().enumerate() {
                if i != j {
                    assert!(!b.starts_with(a), "{:?} — префикс {:?}", String::from_utf8_lossy(a), String::from_utf8_lossy(b));
                }
            }
            // Не совпадают с v1-строками подписей (send:/edit:/pin:/sync:/<call_id>\n).
            for v1 in [&b"send:"[..], b"edit:", b"pin:", b"sync:", b"delete:", b"react:", b"read:"] {
                assert!(!a.starts_with(v1) && !v1.starts_with(a));
            }
        }
    }

    #[test]
    fn length_prefix_disambiguates() {
        // ("ab","c") и ("a","bc") дают разные байты.
        assert_ne!(op_signing_bytes("ab", "c", b"").unwrap(), op_signing_bytes("a", "bc", b"").unwrap());
    }

    #[test]
    fn replay_guard() {
        let mut g = ReplayGuard::new(2);
        let a = new_op_id();
        g.check_and_insert(&a).unwrap();
        assert_eq!(g.check_and_insert(&a), Err(ProtoError::Duplicate));
    }
}
