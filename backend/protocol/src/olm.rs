//! Olm/Megolm на vodozemac 0.11 (T023, R2): перенос `shared/parvane-e2e` в
//! движок. Приватные ключи живут только здесь/на устройстве. Импорт
//! существующих состояний: pickle vodozemac (desktop/android `parvane-e2e`) и
//! libolm pickle (web, `@matrix-org/olm`) — P-36.

use vodozemac::megolm::{
    ExportedSessionKey, GroupSession, InboundGroupSession, MegolmMessage, SessionConfig as MegolmConfig, SessionKey,
};
use vodozemac::olm::{Account, OlmMessage, Session, SessionConfig};
use vodozemac::Curve25519PublicKey;
use zeroize::Zeroizing;

use crate::error::{ProtoError, Result};

fn crypto<E>(_: E) -> ProtoError {
    ProtoError::Crypto
}

fn curve(b: &[u8]) -> Result<Curve25519PublicKey> {
    let arr: [u8; 32] = b.try_into().map_err(crypto)?;
    Ok(Curve25519PublicKey::from_bytes(arr))
}

/// Base64 v1-провода (стандартный алфавит без дополнения — как libolm и
/// `parvane-e2e`); при разборе дополнение допускается.
pub fn b64_encode(bytes: &[u8]) -> String {
    vodozemac::base64_encode(bytes)
}

pub fn b64_decode(text: &str) -> Result<Vec<u8>> {
    vodozemac::base64_decode(text).map_err(crypto)
}

/// Ключ pickle vodozemac (32 байта) из строкового ключа хранилища клиента
/// (веб держит `pickleKey` строкой; libolm брал её байты как есть).
pub fn pickle_key(storage_key: &str) -> Zeroizing<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"parvane-pickle-v2:");
    h.update(storage_key.as_bytes());
    Zeroizing::new(h.finalize().into())
}

/// Проверка подписи Ed25519 (ключ и подпись — сырые байты).
pub fn ed25519_verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = <[u8; 32]>::try_from(public_key) else { return false };
    let Ok(key) = vodozemac::Ed25519PublicKey::from_slice(&key) else { return false };
    let Ok(sig) = vodozemac::Ed25519Signature::from_slice(signature) else { return false };
    key.verify(message, &sig).is_ok()
}

pub struct OlmAccount(Account);

impl Default for OlmAccount {
    fn default() -> Self {
        Self::new()
    }
}

impl OlmAccount {
    pub fn new() -> Self {
        Self(Account::new())
    }

    pub fn curve25519(&self) -> [u8; 32] {
        self.0.curve25519_key().to_bytes()
    }

    pub fn ed25519(&self) -> [u8; 32] {
        self.0.ed25519_key().as_bytes().to_owned()
    }

    /// Подпись Ed25519 ключом аккаунта (ключ устройства в сертификате).
    pub fn sign(&self, data: &[u8]) -> [u8; 64] {
        self.0.sign(data).to_bytes()
    }

    /// Сгенерировать `n` одноразовых ключей; вернуть новые неопубликованные
    /// (key_id — внутренний id vodozemac, 8 байт BE) и пометить опубликованными.
    pub fn generate_one_time_keys(&mut self, n: usize) -> Vec<(Vec<u8>, [u8; 32])> {
        self.0.generate_one_time_keys(n);
        let out = self
            .0
            .one_time_keys()
            .into_iter()
            .map(|(id, k)| (id.to_base64().into_bytes(), k.to_bytes()))
            .collect();
        self.0.mark_keys_as_published();
        out
    }

    /// Новый резервный ключ (fallback); предыдущий vodozemac хранит.
    pub fn generate_fallback_key(&mut self) -> Option<[u8; 32]> {
        self.0.generate_fallback_key();
        let k = self.0.fallback_key().into_values().next().map(|k| k.to_bytes());
        self.0.mark_keys_as_published();
        k
    }

    /// Исходящая сессия по бандлу (identity-ключ и OTK/fallback собеседника).
    pub fn outbound(&self, identity: &[u8], one_time_key: &[u8]) -> Result<OlmSession> {
        let s = self
            .0
            .create_outbound_session(SessionConfig::version_1(), curve(identity)?, curve(one_time_key)?)
            .map_err(crypto)?;
        Ok(OlmSession(s))
    }

    /// Входящая сессия из pre-key сообщения. Возвращает сессию и plaintext.
    pub fn inbound(&mut self, sender_identity: &[u8], prekey_message: &[u8]) -> Result<(OlmSession, Vec<u8>)> {
        let msg = OlmMessage::from_parts(0, prekey_message).map_err(crypto)?;
        let OlmMessage::PreKey(pre) = msg else { return Err(ProtoError::Crypto) };
        let res = self
            .0
            .create_inbound_session(SessionConfig::version_1(), curve(sender_identity)?, &pre)
            .map_err(crypto)?;
        Ok((OlmSession(res.session), res.plaintext))
    }

    /// identity-ключ отправителя из pre-key сообщения (для сверки с сертификатом).
    pub fn prekey_sender_identity(prekey_message: &[u8]) -> Result<[u8; 32]> {
        match OlmMessage::from_parts(0, prekey_message).map_err(crypto)? {
            OlmMessage::PreKey(p) => Ok(p.identity_key().to_bytes()),
            OlmMessage::Normal(_) => Err(ProtoError::Crypto),
        }
    }

    /// Pickle, зашифрованный ключом хранилища (32 байта).
    pub fn pickle(&self, key: &[u8; 32]) -> String {
        self.0.pickle().encrypt(key)
    }

    pub fn from_pickle(pickle: &str, key: &[u8; 32]) -> Result<Self> {
        let p = vodozemac::olm::AccountPickle::from_encrypted(pickle, key).map_err(crypto)?;
        Ok(Self(Account::from_pickle(p)))
    }

    /// JSON-pickle `parvane-e2e` (desktop/android) — импорт при переходе.
    pub fn from_parvane_e2e_json(json: &str) -> Result<Self> {
        let p: vodozemac::olm::AccountPickle = serde_json::from_str(json).map_err(crypto)?;
        Ok(Self(Account::from_pickle(p)))
    }

    /// JSON-pickle (для состояния клиента; шифруется целиком снаружи).
    pub fn to_pickle_json(&self) -> Result<String> {
        serde_json::to_string(&self.0.pickle()).map_err(crypto)
    }

    /// libolm-pickle web-клиента; `key` — pickleKey веб-клиента.
    pub fn from_libolm_pickle(pickle: &str, key: &[u8]) -> Result<Self> {
        Account::from_libolm_pickle(pickle, key).map(Self).map_err(crypto)
    }

    /// Экспорт в libolm-pickle: переносимая копия ключей (её читают
    /// desktop/android через `parvane-e2e` и прежние web-клиенты).
    pub fn to_libolm_pickle(&self, key: &[u8]) -> Result<String> {
        self.0.to_libolm_pickle(key).map_err(crypto)
    }
}

impl crate::sign::OpSigner for OlmAccount {
    fn public_key(&self) -> [u8; 32] {
        self.ed25519()
    }
    fn sign_bytes(&self, msg: &[u8]) -> [u8; 64] {
        self.sign(msg)
    }
}

pub struct OlmSession(Session);

impl OlmSession {
    /// Зашифровать: (тип 0 — pre-key / 1 — normal, байты).
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(u32, Vec<u8>)> {
        let m = self.0.encrypt(plaintext).map_err(crypto)?;
        let (t, ct) = m.to_parts();
        Ok((u32::try_from(t).map_err(crypto)?, ct))
    }

    pub fn decrypt(&mut self, msg_type: u32, ciphertext: &[u8]) -> Result<Vec<u8>> {
        let m = OlmMessage::from_parts(msg_type as usize, ciphertext).map_err(crypto)?;
        self.0.decrypt(&m).map_err(crypto)
    }

    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    /// Совпадает ли pre-key сообщение с этой сессией.
    pub fn matches_prekey(&self, prekey_message: &[u8]) -> bool {
        match OlmMessage::from_parts(0, prekey_message) {
            Ok(OlmMessage::PreKey(p)) => self.0.session_keys() == p.session_keys(),
            _ => false,
        }
    }

    pub fn pickle(&self, key: &[u8; 32]) -> String {
        self.0.pickle().encrypt(key)
    }

    pub fn from_pickle(pickle: &str, key: &[u8; 32]) -> Result<Self> {
        let p = vodozemac::olm::SessionPickle::from_encrypted(pickle, key).map_err(crypto)?;
        Ok(Self(Session::from_pickle(p)))
    }

    pub fn from_parvane_e2e_json(json: &str) -> Result<Self> {
        let p: vodozemac::olm::SessionPickle = serde_json::from_str(json).map_err(crypto)?;
        Ok(Self(Session::from_pickle(p)))
    }

    pub fn to_pickle_json(&self) -> Result<String> {
        serde_json::to_string(&self.0.pickle()).map_err(crypto)
    }

    pub fn from_libolm_pickle(pickle: &str, key: &[u8]) -> Result<Self> {
        Session::from_libolm_pickle(pickle, key).map(Self).map_err(crypto)
    }
}

/// Исходящая Megolm-сессия (своя на эпоху группы).
pub struct MegolmOutbound(GroupSession);

impl Default for MegolmOutbound {
    fn default() -> Self {
        Self::new()
    }
}

impl MegolmOutbound {
    pub fn new() -> Self {
        Self(GroupSession::new(MegolmConfig::version_1()))
    }

    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    /// Ключ для раздачи участникам (байты SessionKey).
    pub fn session_key(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.0.session_key().to_bytes())
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Vec<u8> {
        self.0.encrypt(plaintext).to_bytes()
    }

    /// Индекс следующего сообщения.
    pub fn message_index(&self) -> u32 {
        self.0.message_index()
    }

    /// libolm-pickle исходящей сессии web-клиента.
    pub fn from_libolm_pickle(pickle: &str, key: &[u8]) -> Result<Self> {
        GroupSession::from_libolm_pickle(pickle, key).map(Self).map_err(crypto)
    }

    pub fn pickle(&self, key: &[u8; 32]) -> String {
        self.0.pickle().encrypt(key)
    }

    pub fn from_pickle(pickle: &str, key: &[u8; 32]) -> Result<Self> {
        let p = vodozemac::megolm::GroupSessionPickle::from_encrypted(pickle, key).map_err(crypto)?;
        Ok(Self(GroupSession::from_pickle(p)))
    }

    pub fn from_parvane_e2e_json(json: &str) -> Result<Self> {
        let p: vodozemac::megolm::GroupSessionPickle = serde_json::from_str(json).map_err(crypto)?;
        Ok(Self(GroupSession::from_pickle(p)))
    }

    pub fn to_pickle_json(&self) -> Result<String> {
        serde_json::to_string(&self.0.pickle()).map_err(crypto)
    }
}

/// Входящая Megolm-сессия участника.
pub struct MegolmInbound(InboundGroupSession);

impl MegolmInbound {
    pub fn from_session_key(key: &[u8]) -> Result<Self> {
        let k = SessionKey::from_bytes(key).map_err(crypto)?;
        Ok(Self(InboundGroupSession::new(&k, MegolmConfig::version_1())))
    }

    pub fn session_id(&self) -> String {
        self.0.session_id()
    }

    /// Расшифровать: (plaintext, индекс сообщения — для защиты от повтора).
    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<(Vec<u8>, u32)> {
        let m = MegolmMessage::from_bytes(ciphertext).map_err(crypto)?;
        let d = self.0.decrypt(&m).map_err(crypto)?;
        Ok((d.plaintext, d.message_index))
    }

    /// Экспорт с первого известного индекса (формат libolm export_session).
    pub fn export(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.0.export_at_first_known_index().to_bytes())
    }

    /// Экспорт с индекса `index` (None — индекс раньше первого известного).
    pub fn export_at(&mut self, index: u32) -> Option<Zeroizing<Vec<u8>>> {
        self.0.export_at(index).map(|k| Zeroizing::new(k.to_bytes()))
    }

    pub fn first_known_index(&self) -> u32 {
        self.0.first_known_index()
    }

    pub fn import(exported: &[u8]) -> Result<Self> {
        let k = ExportedSessionKey::from_bytes(exported).map_err(crypto)?;
        Ok(Self(InboundGroupSession::import(&k, MegolmConfig::version_1())))
    }

    pub fn pickle(&self, key: &[u8; 32]) -> String {
        self.0.pickle().encrypt(key)
    }

    pub fn from_pickle(pickle: &str, key: &[u8; 32]) -> Result<Self> {
        let p = vodozemac::megolm::InboundGroupSessionPickle::from_encrypted(pickle, key).map_err(crypto)?;
        Ok(Self(InboundGroupSession::from_pickle(p)))
    }

    pub fn from_parvane_e2e_json(json: &str) -> Result<Self> {
        let p: vodozemac::megolm::InboundGroupSessionPickle = serde_json::from_str(json).map_err(crypto)?;
        Ok(Self(InboundGroupSession::from_pickle(p)))
    }

    pub fn to_pickle_json(&self) -> Result<String> {
        serde_json::to_string(&self.0.pickle()).map_err(crypto)
    }

    pub fn from_libolm_pickle(pickle: &str, key: &[u8]) -> Result<Self> {
        InboundGroupSession::from_libolm_pickle(pickle, key).map(Self).map_err(crypto)
    }
}

/// Safety number пары identity-ключей (совместимо с `parvane-e2e`): 6 групп по
/// 5 цифр, SHA-256, симметрично.
pub fn safety_number(id_a: &str, id_b: &str) -> String {
    use sha2::{Digest, Sha256};
    let (x, y) = if id_a <= id_b { (id_a, id_b) } else { (id_b, id_a) };
    let mut h = Sha256::new();
    h.update(x.as_bytes());
    h.update(b"|");
    h.update(y.as_bytes());
    let digest = h.finalize();
    let mut out = String::new();
    for chunk in digest.chunks(5).take(6) {
        let v = chunk.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b));
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&format!("{:05}", v % 100_000));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn olm_roundtrip_and_pickle() {
        let alice = OlmAccount::new();
        let mut bob = OlmAccount::new();
        let otks = bob.generate_one_time_keys(1);
        let mut a = alice.outbound(&bob.curve25519(), &otks[0].1).unwrap();
        let (t, ct) = a.encrypt(b"hello").unwrap();
        assert_eq!(t, 0);
        assert_eq!(OlmAccount::prekey_sender_identity(&ct).unwrap(), alice.curve25519());
        let (mut b, pt) = bob.inbound(&alice.curve25519(), &ct).unwrap();
        assert_eq!(pt, b"hello");
        let (t2, ct2) = b.encrypt(b"re").unwrap();
        assert_eq!(a.decrypt(t2, &ct2).unwrap(), b"re");
        let key = [7u8; 32];
        let p = a.pickle(&key);
        let mut a2 = OlmSession::from_pickle(&p, &key).unwrap();
        let (t3, ct3) = a2.encrypt(b"again").unwrap();
        assert_eq!(b.decrypt(t3, &ct3).unwrap(), b"again");
        assert!(OlmSession::from_pickle(&p, &[8u8; 32]).is_err());
    }

    #[test]
    fn megolm_roundtrip_and_replay_index() {
        let mut out = MegolmOutbound::new();
        let mut inb = MegolmInbound::from_session_key(&out.session_key()).unwrap();
        let c0 = out.encrypt(b"a");
        let c1 = out.encrypt(b"b");
        assert_eq!(inb.decrypt(&c0).unwrap(), (b"a".to_vec(), 0));
        assert_eq!(inb.decrypt(&c1).unwrap(), (b"b".to_vec(), 1));
        let imported = MegolmInbound::import(&inb.export()).unwrap();
        assert_eq!(imported.session_id(), out.session_id());
    }

    #[test]
    fn v1_compat_primitives() {
        // Подпись/проверка Ed25519 и переносимый libolm-pickle аккаунта.
        let acc = OlmAccount::new();
        let sig = acc.sign(b"sync:0:0");
        assert!(ed25519_verify(&acc.ed25519(), b"sync:0:0", &sig));
        assert!(!ed25519_verify(&acc.ed25519(), b"sync:0:1", &sig));
        assert!(!ed25519_verify(&acc.ed25519()[..31], b"sync:0:0", &sig));
        let libolm = acc.to_libolm_pickle(b"storage-key").unwrap();
        let back = OlmAccount::from_libolm_pickle(&libolm, b"storage-key").unwrap();
        assert_eq!(back.ed25519(), acc.ed25519());
        assert!(OlmAccount::from_libolm_pickle(&libolm, b"other").is_err());
        // Ключ pickle из строки хранилища детерминирован и зависит от строки.
        assert_eq!(*pickle_key("k"), *pickle_key("k"));
        assert_ne!(*pickle_key("k"), *pickle_key("k2"));
        assert_eq!(b64_decode(&b64_encode(b"abc")).unwrap(), b"abc");
        assert_eq!(b64_decode("YWI=").unwrap(), b"ab");

        // Megolm: индекс исходящей, экспорт входящей с заданного индекса.
        let mut out = MegolmOutbound::new();
        let mut inb = MegolmInbound::from_session_key(&out.session_key()).unwrap();
        let _c0 = out.encrypt(b"a");
        let c1 = out.encrypt(b"b");
        assert_eq!(out.message_index(), 2);
        assert_eq!(inb.first_known_index(), 0);
        let exported = inb.export_at(1).unwrap();
        let mut late = MegolmInbound::import(&exported).unwrap();
        assert_eq!(late.first_known_index(), 1);
        assert_eq!(late.decrypt(&c1).unwrap(), (b"b".to_vec(), 1));
        assert!(late.export_at(0).is_none());
    }

    #[test]
    fn parvane_e2e_pickle_import() {
        // JSON-pickle как у shared/parvane-e2e (vodozemac AccountPickle).
        let acc = vodozemac::olm::Account::new();
        let json = serde_json::to_string(&acc.pickle()).unwrap();
        let imported = OlmAccount::from_parvane_e2e_json(&json).unwrap();
        assert_eq!(imported.curve25519(), acc.curve25519_key().to_bytes());
    }
}
