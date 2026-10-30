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

/// Что подтвердило доказательство авторства.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofInfo {
    /// Корень личности автора (его адрес к корню привязывает журнал устройств на сервере).
    pub root_key: [u8; 32],
    pub device_id: String,
    pub ts_ms: i64,
}

/// `op_id` из текстового вида (UUID с дефисами либо без).
pub fn op_id_from_str(s: &str) -> Option<Vec<u8>> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    let b = hex::decode(hex).ok()?;
    (b.len() == 16).then_some(b)
}

/// Подтвердить авторство сообщения из жалобы (REPORT-1, A0008-2): цепочка «корень → SSK → сертификат
/// устройства → подпись операции» верна, сертификат выдан `author`, `op_id` и (если не пусто) начало
/// текста совпадают с подписанными. Без `text` (вложение без подписи) текст не сверяется. `group_id` не пуст —
/// операция подписана именно для этой группы (контекст беседы), иначе чужое сообщение можно выдать за групповое.
pub fn verify_message_proof(proof: &[u8], op_id: &[u8], author: &str, text: &str, group_id: &[u8]) -> Result<ProofInfo> {
    use crate::codec::decode_checked;
    use crate::limits::Origin;
    use crate::pb::parvane::core::v2::MessageProof;
    use crate::pb::parvane::msg::v2::{content, Content};
    if proof.is_empty() || proof.len() > crate::msg::MAX_PROOF_LEN {
        return Err(ProtoError::Malformed);
    }
    let p: MessageProof = decode_checked(proof, Origin::Client)?;
    let cert = p.sender.as_ref().ok_or(ProtoError::InvalidField("sender"))?;
    let op = p.op.as_ref().ok_or(ProtoError::InvalidField("op"))?;
    let device = crate::identity::verify_certificate(cert, Some(author))?;
    let v = crate::sign::verify_op(op, crate::msg::MSG_DOMAIN, crate::msg::CONTENT_OP, Some(&device.olm_ed25519()?))?;
    if v.header.op_id != op_id {
        return Err(ProtoError::ContextMismatch);
    }
    if !group_id.is_empty() {
        match &v.header.conversation {
            Some(crate::pb::parvane::core::v2::op_header::Conversation::Group(ctx)) if ctx.group.as_ref().is_some_and(|g| g.id == group_id) => {}
            _ => return Err(ProtoError::ContextMismatch),
        }
    }
    let signed: Content = decode_checked(&v.payload, Origin::Client)?;
    let signed_text = match &signed.kind {
        Some(content::Kind::Text(t)) => t.text.as_str(),
        Some(content::Kind::Media(m)) => m.caption.as_str(),
        Some(_) => "",
        None => return Err(ProtoError::Malformed),
    };
    if !text.is_empty() && !signed_text.starts_with(text) {
        return Err(ProtoError::ContextMismatch);
    }
    Ok(ProofInfo { root_key: device.root_key, device_id: device.cert.device_id.clone(), ts_ms: v.header.ts_ms })
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
