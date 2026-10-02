//! Слепые жетоны для сообщений незнакомым (T025, R7; D-06): RFC 9474
//! RSABSSA-SHA384-PSS-Randomized. Клиент ослепляет случайные nonce, сервер
//! подписывает не видя их, клиент снимает ослепление; при трате сервер
//! проверяет подпись и одноразовость, но не может связать жетон с выдачей.
//!
//! Подписанное сообщение: `"parvane/v2/token\0" ‖ key_id ‖ nonce`, где
//! `key_id = SHA-256(SPKI ключа выпуска)`. Ключ выпуска суточный; клиент
//! принимает только ключи из `SignedTokenKeyList`, подписанного ключом сервера
//! и сверенного по анонимному каналу (одинаков для всех — иначе сервер
//! «пометил» бы аккаунт своим ключом).

use blind_rsa_signatures::{
    BlindSignature, BlindingResult, DefaultRng, KeyPairSha384PSSRandomized, MessageRandomizer,
    PublicKeySha384PSSRandomized, SecretKeySha384PSSRandomized, Signature,
};
use prost::Message;
use sha2::{Digest, Sha256};

use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::core::v2::{AnonToken, SignedTokenKeyList, TokenKey, TokenKeyList};
use crate::sign::{self, ctx};

/// Суточный лимит выдачи на аккаунт.
pub const DAILY_LIMIT: usize = 50;
/// Размер модуля RSA ключа выпуска.
pub const RSA_BITS: usize = 2048;
pub const NONCE_LEN: usize = 32;

fn crypto<E>(_: E) -> ProtoError {
    ProtoError::Crypto
}

pub fn key_id(spki: &[u8]) -> [u8; 32] {
    Sha256::digest(spki).into()
}

fn token_message(key_id: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut m = ctx::TOKEN.to_vec();
    m.extend_from_slice(key_id);
    m.extend_from_slice(nonce);
    m
}

/// Идентификатор траты для таблицы `spent` (атомарная вставка на сервере).
pub fn spent_id(t: &AnonToken) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(&t.key_id);
    h.update(&t.nonce);
    h.finalize().into()
}

// ── сервер ──────────────────────────────────────────────────────────────────

/// Ключ выпуска (сервер). Хранится файлом 0600 (DER).
pub struct Issuer {
    sk: SecretKeySha384PSSRandomized,
    pk: PublicKeySha384PSSRandomized,
    spki: Vec<u8>,
    pub valid_from_ms: i64,
    pub valid_until_ms: i64,
}

impl Issuer {
    pub fn generate(valid_from_ms: i64, valid_until_ms: i64) -> Result<Self> {
        let kp = KeyPairSha384PSSRandomized::generate(&mut DefaultRng, RSA_BITS).map_err(crypto)?;
        let spki = kp.pk.to_spki().map_err(crypto)?;
        Ok(Self { sk: kp.sk, pk: kp.pk, spki, valid_from_ms, valid_until_ms })
    }

    pub fn from_der(secret_der: &[u8], valid_from_ms: i64, valid_until_ms: i64) -> Result<Self> {
        let sk = SecretKeySha384PSSRandomized::from_der(secret_der).map_err(crypto)?;
        let pk = sk.public_key().map_err(crypto)?;
        let spki = pk.to_spki().map_err(crypto)?;
        Ok(Self { sk, pk, spki, valid_from_ms, valid_until_ms })
    }

    pub fn secret_der(&self) -> Result<Vec<u8>> {
        self.sk.to_der().map_err(crypto)
    }

    pub fn spki(&self) -> &[u8] {
        &self.spki
    }

    pub fn key_id(&self) -> [u8; 32] {
        key_id(&self.spki)
    }

    pub fn token_key(&self) -> TokenKey {
        TokenKey {
            key_id: self.key_id().to_vec(),
            rsa_public_key: self.spki.clone(),
            valid_from_ms: self.valid_from_ms,
            valid_until_ms: self.valid_until_ms,
        }
    }

    /// Подписать ослеплённые сообщения (≤ DAILY_LIMIT — квоту считает шард).
    pub fn issue(&self, blinded: &[Vec<u8>]) -> Result<Vec<Vec<u8>>> {
        if blinded.len() > DAILY_LIMIT {
            return Err(ProtoError::FieldLimit("blinded"));
        }
        blinded.iter().map(|b| self.sk.blind_sign(b).map(|s| s.0).map_err(crypto)).collect()
    }
}

/// Подписанный список ключей выпуска (ключом сервера).
pub fn sign_key_list(server: &ed25519_dalek::SigningKey, keys: Vec<TokenKey>, issued_ms: i64) -> SignedTokenKeyList {
    let list = TokenKeyList { keys, issued_ms }.encode_to_vec();
    SignedTokenKeyList { server_signature: sign::sign_ctx(server, ctx::TOKEN_KEYS, &[&list]), list }
}

/// Проверка жетона на сервере: ключ из набора действующих, подпись. Одноразовость —
/// атомарная вставка `spent_id` в SQLite вызывающим (повтор → DUPLICATE).
pub fn verify_token(t: &AnonToken, keys: &[&Issuer], now_ms: i64) -> Result<()> {
    if t.nonce.len() != NONCE_LEN || t.msg_randomizer.len() != 32 {
        return Err(ProtoError::InvalidField("anon_token"));
    }
    let issuer = keys.iter().find(|k| k.key_id().as_slice() == t.key_id).ok_or(ProtoError::Forbidden)?;
    if now_ms < issuer.valid_from_ms || now_ms > issuer.valid_until_ms {
        return Err(ProtoError::Expired);
    }
    let r: [u8; 32] = t.msg_randomizer.as_slice().try_into().map_err(crypto)?;
    issuer
        .pk
        .verify(&Signature(t.signature.clone()), Some(MessageRandomizer(r)), token_message(&t.key_id, &t.nonce))
        .map_err(|_| ProtoError::BadSignature)
}

// ── клиент ──────────────────────────────────────────────────────────────────

/// Проверенный клиентом список ключей выпуска.
#[derive(Debug, Clone)]
pub struct TrustedKeyList {
    pub keys: Vec<TokenKey>,
}

/// Проверить подписанный список ключом сервера (из описателя сервера).
pub fn verify_key_list(signed: &SignedTokenKeyList, server_key: &[u8]) -> Result<TrustedKeyList> {
    sign::verify_ctx(server_key, &signed.server_signature, ctx::TOKEN_KEYS, &[&signed.list])?;
    let list: TokenKeyList = decode_checked(&signed.list, Origin::Server)?;
    for k in &list.keys {
        if key_id(&k.rsa_public_key).as_slice() != k.key_id {
            return Err(ProtoError::InvalidField("key_id"));
        }
    }
    Ok(TrustedKeyList { keys: list.keys })
}

/// Ожидающий подписи запрос жетонов.
pub struct TokenRequest {
    pk: PublicKeySha384PSSRandomized,
    key_id: [u8; 32],
    pending: Vec<(Vec<u8>, BlindingResult)>,
}

impl TokenRequest {
    /// Подготовить `count` жетонов для ключа `key` из проверенного списка.
    /// Ключ, которого нет в списке, полученном анонимно, отвергается (D-06).
    pub fn new(trusted: &TrustedKeyList, key: &[u8], count: usize) -> Result<(Self, Vec<Vec<u8>>)> {
        if count == 0 || count > DAILY_LIMIT {
            return Err(ProtoError::FieldLimit("blinded"));
        }
        let entry = trusted.keys.iter().find(|k| k.key_id == key).ok_or(ProtoError::Forbidden)?;
        let pk = PublicKeySha384PSSRandomized::from_spki(&entry.rsa_public_key).map_err(crypto)?;
        let kid = key_id(&entry.rsa_public_key);
        let mut pending = Vec::with_capacity(count);
        let mut blinded = Vec::with_capacity(count);
        for _ in 0..count {
            let mut nonce = vec![0u8; NONCE_LEN];
            rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
            let br = pk.blind(&mut DefaultRng, token_message(&kid, &nonce)).map_err(crypto)?;
            blinded.push(br.blind_message.0.clone());
            pending.push((nonce, br));
        }
        Ok((Self { pk, key_id: kid, pending }, blinded))
    }

    /// Снять ослепление. Ответ, подписанный другим ключом, не пройдёт
    /// проверку внутри `finalize`.
    pub fn finalize(self, blind_sigs: &[Vec<u8>]) -> Result<Vec<AnonToken>> {
        if blind_sigs.len() != self.pending.len() {
            return Err(ProtoError::InvalidField("blind_signatures"));
        }
        self.pending
            .into_iter()
            .zip(blind_sigs)
            .map(|((nonce, br), bs)| {
                let msg = token_message(&self.key_id, &nonce);
                let sig = self.pk.finalize(&BlindSignature(bs.clone()), &br, &msg).map_err(|_| ProtoError::BadSignature)?;
                let r = br.msg_randomizer.ok_or(ProtoError::Crypto)?;
                Ok(AnonToken { key_id: self.key_id.to_vec(), nonce, signature: sig.0, msg_randomizer: r.0.to_vec() })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Issuer, ed25519_dalek::SigningKey, TrustedKeyList) {
        let issuer = Issuer::generate(0, i64::MAX).unwrap();
        let server = sign::generate_signing_key();
        let signed = sign_key_list(&server, vec![issuer.token_key()], 1);
        let trusted = verify_key_list(&signed, server.verifying_key().as_bytes()).unwrap();
        (issuer, server, trusted)
    }

    #[test]
    fn issue_and_spend() {
        let (issuer, _, trusted) = setup();
        let (req, blinded) = TokenRequest::new(&trusted, &issuer.key_id(), 3).unwrap();
        let sigs = issuer.issue(&blinded).unwrap();
        let tokens = req.finalize(&sigs).unwrap();
        assert_eq!(tokens.len(), 3);
        for t in &tokens {
            verify_token(t, &[&issuer], 5).unwrap();
        }
        // Жетоны не совпадают с ослеплёнными сообщениями (несвязываемость на уровне байт).
        assert!(tokens.iter().all(|t| !blinded.iter().any(|b| b.windows(32).any(|w| w == t.nonce.as_slice()))));
        assert_ne!(spent_id(&tokens[0]), spent_id(&tokens[1]));
    }

    #[test]
    fn foreign_key_rejected_by_client() {
        let (_, _, trusted) = setup();
        let rogue = Issuer::generate(0, i64::MAX).unwrap();
        assert!(TokenRequest::new(&trusted, &rogue.key_id(), 1).is_err());
    }

    #[test]
    fn forged_or_expired_rejected() {
        let (issuer, _, trusted) = setup();
        let (req, blinded) = TokenRequest::new(&trusted, &issuer.key_id(), 1).unwrap();
        let mut t = req.finalize(&issuer.issue(&blinded).unwrap()).unwrap().remove(0);
        let other = Issuer::generate(0, 10).unwrap();
        assert_eq!(verify_token(&t, &[&other], 5), Err(ProtoError::Forbidden));
        t.nonce[0] ^= 1;
        assert_eq!(verify_token(&t, &[&issuer], 5), Err(ProtoError::BadSignature));
    }

    #[test]
    fn tampered_key_list() {
        let (_, server, _) = setup();
        let mut signed = sign_key_list(&server, vec![Issuer::generate(0, 1).unwrap().token_key()], 1);
        signed.list[3] ^= 1;
        assert!(verify_key_list(&signed, server.verifying_key().as_bytes()).is_err());
    }
}
