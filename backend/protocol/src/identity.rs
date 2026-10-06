//! Личность и устройства (T022, T115; R4; D-01, D-11, D-12).
//!
//! Цепочка: корневой ключ пользователя (Ed25519, только в резервной копии) →
//! self-signing-ключ (SSK, на устройствах) → `DeviceCertificate`. TOFU — по
//! корню (KEY-1 v2): новое устройство с валидной цепочкой от известного корня
//! предупреждения не вызывает; смена корня — предупреждение.
//!
//! Журнал устройств пользователя — хэш-цепочка `UserDeviceLogEntry` (SignedOp
//! domain "identity", op_type "device_log"), подписанная SSK (смена SSK —
//! корнем). Сервер хранит его, но не может скрыть отзыв или подсунуть
//! устройство: клиенты проверяют цепочку и отвергают откат (меньший `version`
//! или другой hash на тот же `version`). Легаси-копии v1 создаются только
//! устройствам из `LegacyDeviceSet`, который публикует владелец (D-01).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use ed25519_dalek::SigningKey;
use prost::Message;
use sha2::{Digest, Sha256};

use crate::address;
use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{
    user_device_log_entry::Change, DeviceCertificate, LegacyDevice, OpHeader, RotateSelfSigning, SignedDeviceCertificate,
    SignedOp, UserDeviceLogEntry, UserRef,
};
use crate::sign::{self, ctx, OpSigner};

pub const DEVICE_LOG_DOMAIN: &str = "identity";
pub const DEVICE_LOG_OP: &str = "device_log";
/// Признак в `DeviceCertificate.features`: устройство НЕ держит SSK (D-12).
/// Без признака считается, что держит (так безопаснее для старых сертификатов).
pub const FEATURE_NO_SSK: &str = "no-ssk";

/// Держало ли устройство SSK (по подписанному сертификату).
pub fn holds_ssk(cert: &DeviceCertificate) -> bool {
    !cert.features.iter().any(|f| f == FEATURE_NO_SSK)
}

fn key32(b: &[u8]) -> Result<[u8; 32]> {
    b.try_into().map_err(|_| ProtoError::BadCertificate)
}

/// Подпись корня над SSK пользователя.
pub fn sign_self_signing(root: &SigningKey, user: &str, ssk_pub: &[u8; 32]) -> Result<Vec<u8>> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    Ok(sign::sign_ctx(root, ctx::SELF_SIGNING, &[user.as_bytes(), b"\0", ssk_pub]))
}

pub fn verify_self_signing(root_pub: &[u8], user: &str, ssk_pub: &[u8], sig: &[u8]) -> Result<()> {
    if !address::is_valid_address(user) {
        return Err(ProtoError::BadAddress);
    }
    let ssk = key32(ssk_pub)?;
    sign::verify_ctx(root_pub, sig, ctx::SELF_SIGNING, &[user.as_bytes(), b"\0", &ssk]).map_err(|_| ProtoError::BadCertificate)
}

/// C1-01: подписываемые байты доказательства владения ключами устройства.
/// Покрывают привязку ключей к (user, device_id, корень), но не serial/
/// features/created_ms — пересертификация новым SSK переносит подпись.
fn possession_parts(cert: &DeviceCertificate, root_pub: &[u8]) -> Result<Vec<u8>> {
    let user = cert.user.as_ref().map(|u| u.address.as_str()).ok_or(ProtoError::BadCertificate)?;
    let mut v = Vec::with_capacity(user.len() + cert.device_id.len() + 2 + 32 * 4);
    v.extend_from_slice(user.as_bytes());
    v.push(0);
    v.extend_from_slice(cert.device_id.as_bytes());
    v.push(0);
    v.extend_from_slice(root_pub);
    v.extend_from_slice(&cert.olm_curve25519);
    v.extend_from_slice(&cert.olm_ed25519);
    v.extend_from_slice(&cert.hpke_x25519);
    Ok(v)
}

/// C1-01: подписать сертификат ключом самого устройства (olm_ed25519) —
/// без этого чужой ключ нельзя вписать в свой сертификат.
pub fn prove_possession(device: &dyn OpSigner, cert: &mut DeviceCertificate, root_pub: &[u8; 32]) -> Result<()> {
    if device.public_key().as_slice() != cert.olm_ed25519.as_slice() {
        return Err(ProtoError::BadCertificate);
    }
    let parts = possession_parts(cert, root_pub)?;
    cert.possession_signature = sign::sign_ctx(device, ctx::DEVICE_POSSESSION, &[&parts]);
    Ok(())
}

fn verify_possession(cert: &DeviceCertificate, root_pub: &[u8; 32]) -> Result<()> {
    let parts = possession_parts(cert, root_pub)?;
    sign::verify_ctx(&cert.olm_ed25519, &cert.possession_signature, ctx::DEVICE_POSSESSION, &[&parts]).map_err(|_| ProtoError::BadCertificate)
}

/// Ключи личности пользователя на устройстве, которое держит корень/SSK.
pub struct RootIdentity {
    pub user: String,
    pub root: SigningKey,
    pub self_signing: SigningKey,
}

impl RootIdentity {
    pub fn generate(user: &str) -> Result<Self> {
        if !address::is_valid_address(user) {
            return Err(ProtoError::BadAddress);
        }
        Ok(Self { user: user.to_string(), root: sign::generate_signing_key(), self_signing: sign::generate_signing_key() })
    }

    pub fn root_pub(&self) -> [u8; 32] {
        self.root.verifying_key().to_bytes()
    }

    pub fn ssk_pub(&self) -> [u8; 32] {
        self.self_signing.verifying_key().to_bytes()
    }

    /// Выпустить сертификат устройства (в `cert` уже есть доказательство
    /// владения — [`prove_possession`] / [`RootIdentity::certify_device`]).
    pub fn certify(&self, cert: &DeviceCertificate) -> Result<SignedDeviceCertificate> {
        if cert.user.as_ref().map(|u| u.address.as_str()) != Some(self.user.as_str()) {
            return Err(ProtoError::BadCertificate);
        }
        if !address::is_valid_device_id(&cert.device_id) {
            return Err(ProtoError::BadAddress);
        }
        let bytes = cert.encode_to_vec();
        let ssk_pub = self.ssk_pub();
        Ok(SignedDeviceCertificate {
            self_signing_signature: sign::sign_ctx(&self.self_signing, ctx::DEVICE_CERT, &[&bytes]),
            certificate: bytes,
            self_signing_key: ssk_pub.to_vec(),
            root_signature_over_self_signing: sign_self_signing(&self.root, &self.user, &ssk_pub)?,
            root_key: self.root_pub().to_vec(),
        })
    }
}

/// Проверенный сертификат.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedDevice {
    pub cert: DeviceCertificate,
    pub root_key: [u8; 32],
    pub ssk: [u8; 32],
}

impl VerifiedDevice {
    pub fn user(&self) -> &str {
        self.cert.user.as_ref().map(|u| u.address.as_str()).unwrap_or("")
    }
    pub fn olm_ed25519(&self) -> Result<[u8; 32]> {
        key32(&self.cert.olm_ed25519)
    }
    pub fn olm_curve25519(&self) -> Result<[u8; 32]> {
        key32(&self.cert.olm_curve25519)
    }
    pub fn hpke_x25519(&self) -> Result<[u8; 32]> {
        key32(&self.cert.hpke_x25519)
    }
}

/// Проверить цепочку root → SSK → устройство. `expected_user` — чей это
/// сертификат по контексту (адрес собеседника).
pub fn verify_certificate(signed: &SignedDeviceCertificate, expected_user: Option<&str>) -> Result<VerifiedDevice> {
    let root = key32(&signed.root_key)?;
    let ssk = key32(&signed.self_signing_key)?;
    sign::verify_ctx(&ssk, &signed.self_signing_signature, ctx::DEVICE_CERT, &[&signed.certificate])
        .map_err(|_| ProtoError::BadCertificate)?;
    let cert: DeviceCertificate = decode_checked(&signed.certificate, Origin::Client)?;
    let user = cert.user.as_ref().map(|u| u.address.as_str()).ok_or(ProtoError::BadCertificate)?;
    verify_self_signing(&root, user, &ssk, &signed.root_signature_over_self_signing)?;
    if let Some(exp) = expected_user {
        if user != exp {
            return Err(ProtoError::BadCertificate);
        }
    }
    if !address::is_valid_device_id(&cert.device_id)
        || cert.olm_curve25519.len() != 32
        || cert.olm_ed25519.len() != 32
        || cert.hpke_x25519.len() != 32
    {
        return Err(ProtoError::BadCertificate);
    }
    // C1-01: ключи сертификата принадлежат этому устройству.
    verify_possession(&cert, &root)?;
    Ok(VerifiedDevice { cert, root_key: root, ssk })
}

/// Вердикт TOFU по корню.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustVerdict {
    /// Первый контакт — корень запомнен.
    New,
    /// Корень совпадает с известным.
    Known,
    /// Корень сменился — предупреждение KEY-1, ключи не выдаются до подтверждения.
    Changed,
}

/// Хранилище «виденных» корней (TOFU, KEY-1 v2).
#[derive(Default, Debug, Clone)]
pub struct RootTrust {
    roots: HashMap<String, [u8; 32]>,
}

impl RootTrust {
    pub fn observe(&mut self, user: &str, root: &[u8; 32]) -> TrustVerdict {
        match self.roots.get(user) {
            None => {
                self.roots.insert(user.to_string(), *root);
                TrustVerdict::New
            }
            Some(r) if r == root => TrustVerdict::Known,
            Some(_) => TrustVerdict::Changed,
        }
    }

    /// Пользователь подтвердил смену корня.
    pub fn accept(&mut self, user: &str, root: &[u8; 32]) {
        self.roots.insert(user.to_string(), *root);
    }

    pub fn get(&self, user: &str) -> Option<&[u8; 32]> {
        self.roots.get(user)
    }
}

// ── журнал устройств ────────────────────────────────────────────────────────

/// Хэш записи журнала устройств.
pub fn device_log_hash(op: &SignedOp) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(ctx::DEVICE_LOG_HASH);
    h.update(&op.body);
    h.update(&op.signature);
    h.finalize().into()
}

/// Состояние журнала устройств пользователя после проверки цепочки.
#[derive(Debug, Clone, Default)]
pub struct DeviceLog {
    pub user: String,
    pub version: u64,
    pub head_hash: [u8; 32],
    pub root_key: [u8; 32],
    pub ssk: [u8; 32],
    /// Активные устройства (сертификат текущего SSK).
    pub devices: BTreeMap<String, VerifiedDevice>,
    /// Максимальный serial по device_id (D-11: откат отвергается).
    pub max_serial: HashMap<String, u64>,
    pub revoked: BTreeSet<String>,
    /// D-01: признанные владельцем v1-устройства (None — список не публиковался).
    pub legacy: Option<Vec<LegacyDevice>>,
    /// D-12: отозвано устройство, державшее SSK, а SSK с тех пор не сменён —
    /// собеседники показывают предупреждение KEY-1 до смены.
    pub ssk_exposed: bool,
}

/// Подписать запись журнала устройств.
pub fn sign_device_log_entry(key: &dyn sign::OpSigner, entry: &UserDeviceLogEntry) -> Result<SignedOp> {
    let header = OpHeader {
        domain: DEVICE_LOG_DOMAIN.into(),
        op_type: DEVICE_LOG_OP.into(),
        op_id: sign::new_op_id(),
        ts_ms: now_ms(),
        ..Default::default()
    };
    sign::sign_op(key, header, entry.encode_to_vec())
}

pub(crate) fn now_ms() -> i64 {
    crate::time::now_ms()
}

impl DeviceLog {
    /// Пустой журнал пользователя (до генезиса).
    pub fn new(user: &str) -> Result<Self> {
        if !address::is_valid_address(user) {
            return Err(ProtoError::BadAddress);
        }
        Ok(Self { user: user.to_string(), ..Default::default() })
    }

    /// Применить следующую запись. Корень после генезиса неизменен; смена
    /// корня = новый журнал и предупреждение KEY-1 (решает вызывающий).
    pub fn apply(&mut self, op: &SignedOp) -> Result<()> {
        // Ключ подписанта берём из тела только после проверки ниже.
        let hint = sign::verifying_key(&op.signer_key)?.to_bytes();
        let genesis = self.version == 0;
        let v = sign::verify_op(op, DEVICE_LOG_DOMAIN, DEVICE_LOG_OP, Some(&hint))?;
        let entry: UserDeviceLogEntry = decode_checked(&v.payload, Origin::Client)?;
        if entry.user.as_ref().map(|u| u.address.as_str()) != Some(self.user.as_str()) {
            return Err(ProtoError::InvalidField("user"));
        }
        if entry.version != self.version + 1 {
            return Err(ProtoError::BrokenChain);
        }
        if entry.prev_hash.as_slice() != self.head_hash {
            return Err(ProtoError::BrokenChain);
        }
        let change = entry.change.as_ref().ok_or(ProtoError::InvalidField("change"))?;
        if genesis {
            // Генезис: корень + первый SSK, подписано корнем.
            let root = key32(&entry.root_key)?;
            let Change::RotateSelfSigningKey(RotateSelfSigning { self_signing_key, root_signature }) = change else {
                return Err(ProtoError::BrokenChain);
            };
            if v.signer != root {
                return Err(ProtoError::BadSignature);
            }
            verify_self_signing(&root, &self.user, self_signing_key, root_signature)?;
            self.root_key = root;
            self.ssk = key32(self_signing_key)?;
        } else {
            if !entry.root_key.is_empty() && entry.root_key.as_slice() != self.root_key {
                return Err(ProtoError::RootMismatch);
            }
            match change {
                Change::RotateSelfSigningKey(r) => {
                    if v.signer != self.root_key {
                        return Err(ProtoError::BadSignature);
                    }
                    verify_self_signing(&self.root_key, &self.user, &r.self_signing_key, &r.root_signature)?;
                    self.ssk = key32(&r.self_signing_key)?;
                    // Сертификаты старого SSK недействительны.
                    self.devices.clear();
                    self.ssk_exposed = false;
                }
                Change::AddDevice(signed) => {
                    if v.signer != self.ssk {
                        return Err(ProtoError::BadSignature);
                    }
                    // C1-02 (инв. 31): держатель SSK отозван — новые сертификаты
                    // только под новым SSK (после RotateSelfSigningKey корнем).
                    if self.ssk_exposed {
                        return Err(ProtoError::Forbidden);
                    }
                    let dev = verify_certificate(signed, Some(&self.user))?;
                    if dev.root_key != self.root_key || dev.ssk != self.ssk {
                        return Err(ProtoError::BadCertificate);
                    }
                    let id = dev.cert.device_id.clone();
                    if self.revoked.contains(&id) {
                        return Err(ProtoError::Forbidden);
                    }
                    // C1-01: ключ подписи/Olm не может принадлежать двум устройствам.
                    if self.devices.iter().any(|(other, d)| {
                        other != &id && (d.cert.olm_ed25519 == dev.cert.olm_ed25519 || d.cert.olm_curve25519 == dev.cert.olm_curve25519)
                    }) {
                        return Err(ProtoError::Duplicate);
                    }
                    let prev = self.max_serial.get(&id).copied();
                    if prev.is_some_and(|p| dev.cert.serial <= p) {
                        return Err(ProtoError::BrokenChain);
                    }
                    self.max_serial.insert(id.clone(), dev.cert.serial);
                    self.devices.insert(id, dev);
                }
                Change::RevokeDeviceId(id) => {
                    // Выход: устройство само убирает себя из журнала, подписав
                    // запись своим ключом (olm_ed25519 сертификата). Это не отзыв
                    // чужой рукой — устройство стирает ключи по воле владельца, —
                    // поэтому SSK раскрытым не считается (иначе каждый выход
                    // требовал бы ключ восстановления на оставшихся устройствах).
                    let by_itself = self.devices.get(id).is_some_and(|d| d.cert.olm_ed25519.as_slice() == v.signer);
                    if !by_itself && v.signer != self.ssk && v.signer != self.root_key {
                        return Err(ProtoError::BadSignature);
                    }
                    if self.devices.remove(id).is_some_and(|d| holds_ssk(&d.cert)) && !by_itself {
                        self.ssk_exposed = true;
                    }
                    self.revoked.insert(id.clone());
                    if let Some(l) = &mut self.legacy {
                        l.retain(|d| &d.device_id != id);
                    }
                }
                Change::LegacyDevices(set) => {
                    if v.signer != self.ssk {
                        return Err(ProtoError::BadSignature);
                    }
                    // C1-02: скомпрометированный SSK не меняет список легаси-получателей.
                    if self.ssk_exposed {
                        return Err(ProtoError::Forbidden);
                    }
                    match &self.legacy {
                        None => self.legacy = Some(set.devices.clone()),
                        // Список может только сокращаться.
                        Some(cur) => {
                            if !set.devices.iter().all(|d| cur.contains(d)) {
                                return Err(ProtoError::Forbidden);
                            }
                            self.legacy = Some(set.devices.clone());
                        }
                    }
                }
            }
        }
        self.version = entry.version;
        self.head_hash = device_log_hash(op);
        Ok(())
    }

    /// Устройство активно (есть сертификат текущего SSK и не отозвано).
    pub fn active(&self, device_id: &str) -> Option<&VerifiedDevice> {
        if self.revoked.contains(device_id) {
            return None;
        }
        self.devices.get(device_id)
    }

    /// D-01: кому из v1-устройств, которые назвал сервер, можно слать
    /// легаси-копию. Остальные — в список предупреждений.
    pub fn legacy_recipients<'a>(&self, server_listed: &'a [LegacyDevice]) -> (Vec<&'a LegacyDevice>, Vec<&'a LegacyDevice>) {
        let allowed = self.legacy.as_deref().unwrap_or(&[]);
        server_listed.iter().partition(|d| allowed.contains(d) && !self.revoked.contains(&d.device_id))
    }
}

/// Закреплённая голова журнала собеседника (защита от отката, D-11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogPin {
    pub version: u64,
    pub head_hash: [u8; 32],
}

impl LogPin {
    /// Проверить новую голову против закреплённой; при успехе — продвинуть.
    /// `hash_at_pinned` — hash записи новой цепочки с номером `self.version`.
    pub fn advance(&mut self, new_version: u64, new_head: [u8; 32], hash_at_pinned: Option<[u8; 32]>) -> Result<()> {
        if new_version < self.version {
            return Err(ProtoError::BrokenChain);
        }
        if self.version > 0 {
            let at = if new_version == self.version { Some(new_head) } else { hash_at_pinned };
            if at != Some(self.head_hash) {
                return Err(ProtoError::BrokenChain);
            }
        }
        self.version = new_version;
        self.head_hash = new_head;
        Ok(())
    }
}

/// Помощник: запись журнала для пользователя.
pub fn device_log_entry(user: &str, version: u64, prev_hash: [u8; 32], change: Change, root_key: Option<[u8; 32]>) -> UserDeviceLogEntry {
    UserDeviceLogEntry {
        user: Some(UserRef { address: user.to_string() }),
        version,
        prev_hash: prev_hash.to_vec(),
        change: Some(change),
        root_key: root_key.map(|k| k.to_vec()).unwrap_or_default(),
    }
}

/// Сертификат устройства, подписанный SSK (подпись корня над SSK — из журнала).
pub fn sign_certificate(ssk: &SigningKey, root_pub: &[u8; 32], root_signature_over_ssk: Vec<u8>, cert: &DeviceCertificate) -> SignedDeviceCertificate {
    let bytes = cert.encode_to_vec();
    SignedDeviceCertificate {
        self_signing_signature: sign::sign_ctx(ssk, ctx::DEVICE_CERT, &[&bytes]),
        certificate: bytes,
        self_signing_key: ssk.verifying_key().to_bytes().to_vec(),
        root_signature_over_self_signing: root_signature_over_ssk,
        root_key: root_pub.to_vec(),
    }
}

/// Смена SSK (D-12): запись журнала, подписанная корнем. Возвращает запись и
/// подпись корня над новым SSK (для сертификатов).
pub fn rotate_ssk_entry(root: &SigningKey, user: &str, version: u64, prev_hash: [u8; 32], new_ssk: &SigningKey) -> Result<(SignedOp, Vec<u8>)> {
    let pub_key = new_ssk.verifying_key().to_bytes();
    let root_signature = sign_self_signing(root, user, &pub_key)?;
    let e = device_log_entry(
        user,
        version,
        prev_hash,
        Change::RotateSelfSigningKey(RotateSelfSigning { self_signing_key: pub_key.to_vec(), root_signature: root_signature.clone() }),
        None,
    );
    Ok((sign_device_log_entry(root, &e)?, root_signature))
}

impl RootIdentity {
    /// Доказательство владения ключом устройства + сертификат.
    pub fn certify_device(&self, device: &dyn OpSigner, cert: &DeviceCertificate) -> Result<SignedDeviceCertificate> {
        let mut c = cert.clone();
        prove_possession(device, &mut c, &self.root_pub())?;
        self.certify(&c)
    }

    /// Генезис журнала устройств: корень + SSK, подписано корнем.
    pub fn genesis_entry(&self) -> Result<SignedOp> {
        let ssk = self.ssk_pub();
        let e = device_log_entry(
            &self.user,
            1,
            [0u8; 32],
            Change::RotateSelfSigningKey(RotateSelfSigning {
                self_signing_key: ssk.to_vec(),
                root_signature: sign_self_signing(&self.root, &self.user, &ssk)?,
            }),
            Some(self.root_pub()),
        );
        sign_device_log_entry(&self.root, &e)
    }

    /// Запись «добавить устройство», подписанная SSK.
    pub fn add_device_entry(&self, version: u64, prev_hash: [u8; 32], cert: &DeviceCertificate) -> Result<SignedOp> {
        let e = device_log_entry(&self.user, version, prev_hash, Change::AddDevice(self.certify(cert)?), None);
        sign_device_log_entry(&self.self_signing, &e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::LegacyDeviceSet;

    /// Ключ устройства теста — детерминированно по id (тот же id → тот же ключ).
    fn dev_key(id: &str) -> SigningKey {
        let mut seed = [7u8; 32];
        for (i, b) in id.bytes().enumerate().take(32) {
            seed[i] = b;
        }
        SigningKey::from_bytes(&seed)
    }

    fn cert_for(root: &[u8; 32], user: &str, id: &str, serial: u64) -> DeviceCertificate {
        let k = dev_key(id);
        let mut c = DeviceCertificate {
            user: Some(UserRef { address: user.into() }),
            device_id: id.into(),
            olm_curve25519: k.verifying_key().to_bytes().iter().map(|b| b ^ 0x5a).collect(),
            olm_ed25519: k.verifying_key().to_bytes().to_vec(),
            hpke_x25519: vec![3; 32],
            proto_major: 2,
            serial,
            ..Default::default()
        };
        prove_possession(&k, &mut c, root).unwrap();
        c
    }

    #[test]
    fn certificate_chain() {
        let alice = RootIdentity::generate("alice@x").unwrap();
        let s = alice.certify(&cert_for(&alice.root_pub(), "alice@x", "d1", 1)).unwrap();
        let v = verify_certificate(&s, Some("alice@x")).unwrap();
        assert_eq!(v.root_key, alice.root_pub());
        assert!(verify_certificate(&s, Some("bob@x")).is_err());
        // Подпись не тем корнем.
        let mallory = RootIdentity::generate("alice@x").unwrap();
        let mut forged = s.clone();
        forged.root_key = mallory.root_pub().to_vec();
        assert_eq!(verify_certificate(&forged, None), Err(ProtoError::BadCertificate));
    }

    #[test]
    fn tofu() {
        let mut t = RootTrust::default();
        assert_eq!(t.observe("a@x", &[1; 32]), TrustVerdict::New);
        assert_eq!(t.observe("a@x", &[1; 32]), TrustVerdict::Known);
        assert_eq!(t.observe("a@x", &[2; 32]), TrustVerdict::Changed);
    }

    #[test]
    fn device_log_chain() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        let g = a.genesis_entry().unwrap();
        log.apply(&g).unwrap();
        let add = a.add_device_entry(2, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 1)).unwrap();
        log.apply(&add).unwrap();
        assert!(log.active("d1").is_some());
        // Повтор той же записи — цепочка не сходится.
        assert_eq!(log.apply(&add), Err(ProtoError::BrokenChain));
        // Откат serial.
        let again = a.add_device_entry(3, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 1)).unwrap();
        assert_eq!(log.apply(&again), Err(ProtoError::BrokenChain));
        // Отзыв.
        let e = device_log_entry("alice@x", 3, log.head_hash, Change::RevokeDeviceId("d1".into()), None);
        log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()).unwrap();
        assert!(log.active("d1").is_none());
        let back = a.add_device_entry(4, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 9)).unwrap();
        assert_eq!(log.apply(&back), Err(ProtoError::Forbidden));
    }

    #[test]
    fn device_log_rejects_server_forgery() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        // Сервер со своим корнем пытается добавить устройство.
        let srv = RootIdentity::generate("alice@x").unwrap();
        let add = srv.add_device_entry(2, log.head_hash, &cert_for(&srv.root_pub(), "alice@x", "evil", 1)).unwrap();
        assert!(log.apply(&add).is_err());
    }

    #[test]
    fn legacy_set_only_shrinks() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        let l1 = LegacyDevice { device_id: "old1".into(), olm_curve25519: vec![5; 32], olm_ed25519: vec![6; 32] };
        let l2 = LegacyDevice { device_id: "old2".into(), olm_curve25519: vec![7; 32], olm_ed25519: vec![8; 32] };
        let set = |d: Vec<LegacyDevice>| Change::LegacyDevices(LegacyDeviceSet { devices: d });
        let e = device_log_entry("alice@x", 2, log.head_hash, set(vec![l1.clone()]), None);
        log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()).unwrap();
        // Подсунутое сервером v1-устройство вне списка — не получатель.
        let fake = LegacyDevice { device_id: "srv".into(), olm_curve25519: vec![9; 32], olm_ed25519: vec![9; 32] };
        let listed = vec![l1.clone(), fake.clone()];
        let (ok, warn) = log.legacy_recipients(&listed);
        assert_eq!(ok, vec![&l1]);
        assert_eq!(warn, vec![&fake]);
        // Расширить список нельзя.
        let e = device_log_entry("alice@x", 3, log.head_hash, set(vec![l1, l2]), None);
        assert_eq!(log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()), Err(ProtoError::Forbidden));
    }

    #[test]
    fn pin_rollback() {
        let mut p = LogPin::default();
        p.advance(3, [3; 32], None).unwrap();
        assert!(p.advance(2, [2; 32], None).is_err());
        assert!(p.advance(3, [4; 32], None).is_err());
        assert!(p.advance(5, [5; 32], Some([9; 32])).is_err());
        p.advance(5, [5; 32], Some([3; 32])).unwrap();
    }

    /// C1-01: чужой ключ устройства в своём сертификате (без приватного
    /// ключа) и сертификат без доказательства владения отвергаются.
    #[test]
    fn possession_required() {
        let alice = RootIdentity::generate("alice@x").unwrap();
        let mallory = RootIdentity::generate("mallory@x").unwrap();
        let victim = cert_for(&alice.root_pub(), "alice@x", "d1", 1);
        // Mallory переписывает сертификат Алисы на себя (ключи Алисы, подпись — её).
        let mut stolen = victim.clone();
        stolen.user = Some(UserRef { address: "mallory@x".into() });
        let s = mallory.certify(&stolen).unwrap();
        assert_eq!(verify_certificate(&s, Some("mallory@x")), Err(ProtoError::BadCertificate));
        // Подпись другим ключом (Mallory подписала своим, вписав ключ Алисы).
        let mut forged = victim.clone();
        forged.user = Some(UserRef { address: "mallory@x".into() });
        let mk = dev_key("m1");
        forged.olm_ed25519 = mk.verifying_key().to_bytes().to_vec();
        prove_possession(&mk, &mut forged, &mallory.root_pub()).unwrap();
        forged.olm_ed25519 = victim.olm_ed25519.clone();
        assert!(verify_certificate(&mallory.certify(&forged).unwrap(), None).is_err());
        // Без подписи владения.
        let mut bare = victim.clone();
        bare.possession_signature.clear();
        assert_eq!(verify_certificate(&alice.certify(&bare).unwrap(), None), Err(ProtoError::BadCertificate));
        // Подпись владения привязана к корню.
        let other_root = RootIdentity::generate("alice@x").unwrap();
        assert!(verify_certificate(&other_root.certify(&victim).unwrap(), None).is_err());
        // Доказать владение можно только своим ключом.
        let mut c = victim.clone();
        assert_eq!(prove_possession(&dev_key("zz"), &mut c, &alice.root_pub()), Err(ProtoError::BadCertificate));
        assert!(verify_certificate(&alice.certify(&victim).unwrap(), Some("alice@x")).is_ok());
    }

    /// C1-01: один ключ — одно устройство в журнале.
    #[test]
    fn duplicate_device_key_rejected() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        log.apply(&a.add_device_entry(2, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 1)).unwrap()).unwrap();
        // Те же ключи под другим device_id.
        let k = dev_key("d1");
        let mut c = cert_for(&a.root_pub(), "alice@x", "d1", 1);
        c.device_id = "d2".into();
        prove_possession(&k, &mut c, &a.root_pub()).unwrap();
        assert_eq!(log.apply(&a.add_device_entry(3, log.head_hash, &c).unwrap()), Err(ProtoError::Duplicate));
    }

    /// C1-02 (инв. 31): после отзыва держателя SSK старый SSK не добавляет
    /// устройства и не меняет легаси-список; после смены SSK корнем — можно.
    #[test]
    fn device_leaving_by_itself_does_not_expose_ssk() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        log.apply(&a.add_device_entry(2, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 1)).unwrap()).unwrap();
        log.apply(&a.add_device_entry(3, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d2", 1)).unwrap()).unwrap();
        // Чужой ключ устройства (d2) не может убрать d1.
        let e = device_log_entry("alice@x", 4, log.head_hash, Change::RevokeDeviceId("d1".into()), None);
        assert_eq!(log.apply(&sign_device_log_entry(&dev_key("d2"), &e).unwrap()), Err(ProtoError::BadSignature));
        // d1 выходит сам: из журнала убран, вернуться под тем же id нельзя, SSK не раскрыт.
        log.apply(&sign_device_log_entry(&dev_key("d1"), &e).unwrap()).unwrap();
        assert!(log.active("d1").is_none());
        assert!(log.revoked.contains("d1"));
        assert!(!log.ssk_exposed);
        // Новые устройства добавляются без смены SSK корнем.
        log.apply(&a.add_device_entry(5, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d3", 1)).unwrap()).unwrap();
        assert!(log.active("d3").is_some());
        let back = a.add_device_entry(6, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 2)).unwrap();
        assert_eq!(log.apply(&back), Err(ProtoError::Forbidden));
    }

    #[test]
    fn exposed_ssk_cannot_add_devices() {
        let a = RootIdentity::generate("alice@x").unwrap();
        let mut log = DeviceLog::new("alice@x").unwrap();
        log.apply(&a.genesis_entry().unwrap()).unwrap();
        // d1 держит SSK (нет признака no-ssk).
        log.apply(&a.add_device_entry(2, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "d1", 1)).unwrap()).unwrap();
        let e = device_log_entry("alice@x", 3, log.head_hash, Change::RevokeDeviceId("d1".into()), None);
        log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()).unwrap();
        assert!(log.ssk_exposed);
        // Вор со старым SSK добавляет своё устройство.
        let evil = a.add_device_entry(4, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "evil", 1)).unwrap();
        assert_eq!(log.apply(&evil), Err(ProtoError::Forbidden));
        assert!(log.active("evil").is_none());
        let l = LegacyDevice { device_id: "old".into(), olm_curve25519: vec![5; 32], olm_ed25519: vec![6; 32] };
        let e = device_log_entry("alice@x", 4, log.head_hash, Change::LegacyDevices(LegacyDeviceSet { devices: vec![l] }), None);
        assert_eq!(log.apply(&sign_device_log_entry(&a.self_signing, &e).unwrap()), Err(ProtoError::Forbidden));
        // Смена SSK корнем — новые сертификаты под новым SSK принимаются.
        let new_ssk = sign::generate_signing_key();
        let (rot, sig) = rotate_ssk_entry(&a.root, "alice@x", 4, log.head_hash, &new_ssk).unwrap();
        log.apply(&rot).unwrap();
        assert!(!log.ssk_exposed);
        let c = sign_certificate(&new_ssk, &a.root_pub(), sig, &cert_for(&a.root_pub(), "alice@x", "d3", 1));
        let e = device_log_entry("alice@x", 5, log.head_hash, Change::AddDevice(c), None);
        log.apply(&sign_device_log_entry(&new_ssk, &e).unwrap()).unwrap();
        assert!(log.active("d3").is_some());
        // Старый SSK после смены — чужая подпись.
        let stale = a.add_device_entry(6, log.head_hash, &cert_for(&a.root_pub(), "alice@x", "evil", 1)).unwrap();
        assert_eq!(log.apply(&stale), Err(ProtoError::BadSignature));
    }
}
