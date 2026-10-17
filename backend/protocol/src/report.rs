//! Жалобы администратору сервера (spec 024).
//!
//! Автор жалобы прикладывает к ней сообщения открытым текстом — их увидит администратор, но не
//! сервер: JSON жалобы запечатывается открытым ключом администратора (HPKE RFC 9180, base,
//! DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305, как копия корня), сервер хранит
//! шифртекст вместе с адресом автора из сессии. `info = "parvane/v2/report\0" ‖ адрес автора` —
//! жалобу нельзя выдать за чужую: открыть её с другим адресом не выйдет.
//! Формат: `PVRP` ‖ версия ‖ enc(32) ‖ ct. Содержимое движок не разбирает.

use crate::address;
use crate::error::{ProtoError, Result};
use zeroize::Zeroizing;

const REPORT_MAGIC: &[u8; 4] = b"PVRP";
const REPORT_VERSION: u8 = 1;
const REPORT_INFO: &[u8] = b"parvane/v2/report\0";
const REPORT_HEADER_LEN: usize = 4 + 1;
/// Предел открытого текста жалобы (запечатанная — в пределах `ReportSubmitRequest.sealed`).
pub const MAX_REPORT_PLAINTEXT: usize = 200 * 1024;

fn report_info(reporter: &str) -> Vec<u8> {
    let mut v = REPORT_INFO.to_vec();
    v.extend_from_slice(reporter.as_bytes());
    v
}

/// Похоже ли на запечатанную жалобу (сервер проверяет перед записью, ключа у него нет).
pub fn is_sealed_report(blob: &[u8]) -> bool {
    blob.len() > REPORT_HEADER_LEN + 32 + 16 && &blob[..4] == REPORT_MAGIC && blob[4] == REPORT_VERSION
}

/// Запечатать жалобу автора `reporter` открытым ключом администратора.
pub fn seal_report(plaintext: &[u8], reporter: &str, admin_public: &[u8; 32]) -> Result<Vec<u8>> {
    use hpke::{Deserializable, Serializable};
    if !address::is_valid_address(reporter) {
        return Err(ProtoError::BadAddress);
    }
    if plaintext.is_empty() || plaintext.len() > MAX_REPORT_PLAINTEXT {
        return Err(ProtoError::FieldLimit("report"));
    }
    let pk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(admin_public).map_err(|_| ProtoError::Crypto)?;
    let mut out = Vec::with_capacity(REPORT_HEADER_LEN + 32 + plaintext.len() + 16);
    out.extend_from_slice(REPORT_MAGIC);
    out.push(REPORT_VERSION);
    let (enc, ct) = hpke::single_shot_seal::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, hpke::kem::X25519HkdfSha256>(
        &hpke::OpModeS::Base,
        &pk,
        &report_info(reporter),
        plaintext,
        &out,
    )
    .map_err(|_| ProtoError::Crypto)?;
    out.extend_from_slice(&enc.to_bytes());
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Открыть жалобу закрытым ключом администратора; `reporter` — автор по записи сервера.
pub fn open_report(blob: &[u8], reporter: &str, admin_secret: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>> {
    use hpke::Deserializable;
    if !is_sealed_report(blob) {
        return Err(ProtoError::Malformed);
    }
    let (header, rest) = blob.split_at(REPORT_HEADER_LEN);
    let (enc, ct) = rest.split_at(32);
    let sk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(admin_secret).map_err(|_| ProtoError::Crypto)?;
    let enc = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(enc).map_err(|_| ProtoError::Crypto)?;
    let pt = hpke::single_shot_open::<hpke::aead::ChaCha20Poly1305, hpke::kdf::HkdfSha256, hpke::kem::X25519HkdfSha256>(
        &hpke::OpModeR::Base,
        &sk,
        &enc,
        &report_info(reporter),
        ct,
        header,
    )
    .map_err(|_| ProtoError::Crypto)?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_opens_only_for_its_reporter() {
        let (sk, pk) = crate::seal::generate_keypair();
        let blob = seal_report(br#"{"reason":"spam"}"#, "alice@x", &pk).unwrap();
        assert!(is_sealed_report(&blob));
        assert_eq!(open_report(&blob, "alice@x", &sk).unwrap().as_slice(), br#"{"reason":"spam"}"#);
        // Чужой автор и чужой ключ — отказ
        assert!(open_report(&blob, "mallory@x", &sk).is_err());
        let (other, _) = crate::seal::generate_keypair();
        assert!(open_report(&blob, "alice@x", &other).is_err());
        // Подменённый байт — отказ
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(open_report(&bad, "alice@x", &sk).is_err());
    }

    #[test]
    fn report_rejects_empty_and_oversized() {
        let (_, pk) = crate::seal::generate_keypair();
        assert!(seal_report(b"", "alice@x", &pk).is_err());
        assert!(seal_report(&vec![b'a'; MAX_REPORT_PLAINTEXT + 1], "alice@x", &pk).is_err());
    }
}
