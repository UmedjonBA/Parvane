//! Ключ восстановления через Telegram-бота (spec 015, находки A0023-1, A0016-1, A0017-2):
//! ответ владельца запечатывается на эфемерный открытый ключ X25519 устройства, чей запрос он закрывает.
//! Сервер получает ключ от бота открытым текстом (должен проверить его по копии корня), но хранит и отдаёт
//! только запечатанный ответ: чужая сессия, подменившая `device_id` запросившего, расшифровать его не может.

use hpke::aead::ChaCha20Poly1305 as Aead;
use hpke::kdf::HkdfSha256 as Kdf;
use hpke::kem::X25519HkdfSha256 as Kem;
use hpke::{Deserializable, OpModeR, OpModeS, Serializable};
use zeroize::Zeroizing;

use crate::error::{ProtoError, Result};

pub const INFO: &[u8] = b"parvane/v2/recovery-tg\0";
/// Запечатанный ответ: `enc (32) || шифртекст`; ключ восстановления ≤ 64 знаков + тег 16.
pub const SEALED_MAX: usize = 32 + 64 + 16;

/// Эфемерная пара устройства: (приватный, публичный) по 32 байта.
pub fn generate() -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    crate::seal::generate_keypair()
}

fn info(user: &str, device_id: &str) -> Vec<u8> {
    let mut v = INFO.to_vec();
    v.extend_from_slice(user.as_bytes());
    v.push(0);
    v.extend_from_slice(device_id.as_bytes());
    v
}

/// Запечатать ответ владельца для запросившего устройства (вызывает сервер).
pub fn seal(public: &[u8], user: &str, device_id: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let pk = <Kem as hpke::Kem>::PublicKey::from_bytes(public).map_err(|_| ProtoError::Crypto)?;
    let (enc, ct) = hpke::single_shot_seal::<Aead, Kdf, Kem>(&OpModeS::Base, &pk, &info(user, device_id), plaintext, b"")
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = enc.to_bytes().to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Открыть ответ приватным ключом, оставшимся на устройстве.
pub fn open(secret: &[u8], user: &str, device_id: &str, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.len() <= 32 || sealed.len() > SEALED_MAX {
        return Err(ProtoError::Crypto);
    }
    let sk = <Kem as hpke::Kem>::PrivateKey::from_bytes(secret).map_err(|_| ProtoError::Crypto)?;
    let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&sealed[..32]).map_err(|_| ProtoError::Crypto)?;
    hpke::single_shot_open::<Aead, Kdf, Kem>(&OpModeR::Base, &sk, &enc, &info(user, device_id), &sealed[32..], b"")
        .map(Zeroizing::new)
        .map_err(|_| ProtoError::Crypto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_requesting_device_opens_the_reply() {
        let (sk, pk) = generate();
        let sealed = seal(&pk, "a@x", "dev-1", b"KEY").unwrap();
        assert_eq!(open(&sk[..], "a@x", "dev-1", &sealed).unwrap().as_slice(), b"KEY");
        let (other_sk, _) = generate();
        assert!(open(&other_sk[..], "a@x", "dev-1", &sealed).is_err(), "чужой ключ");
        assert!(open(&sk[..], "a@x", "dev-2", &sealed).is_err(), "другой device_id");
        assert!(open(&sk[..], "b@x", "dev-1", &sealed).is_err(), "другой пользователь");
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(open(&sk[..], "a@x", "dev-1", &bad).is_err(), "подмена");
        assert!(seal(&[1; 5], "a@x", "dev-1", b"KEY").is_err());
    }
}
