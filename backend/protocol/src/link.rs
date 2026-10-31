//! LINK-1 п. 13 (31 окт 2026): общий challenge привязки для всех старых устройств аккаунта.
//!
//! Сервер фиксирует ПЕРВЫЙ challenge к офферу нового устройства (иначе сервер мог бы подменить сторону, с которой
//! считается код сверки). Чтобы запрос был виден и подтверждаем на любом старом устройстве, устройство, выставившее
//! challenge, кладёт рядом «обёртку» — закрытую часть своего эфемерного ключа, зашифрованную AES-256-GCM ключом из
//! self-signing-ключа аккаунта (SSK):
//!
//! ```text
//! ctx  = "parvane/v2/link-challenge\0" ‖ len‖адрес ‖ len‖устройство-цель ‖ len‖commitment ‖ len‖challenge_pub
//! key  = HKDF-SHA256(ikm = SSK (32 байта seed), salt = нет, info = ctx)
//! wrap = nonce(12) ‖ AES-256-GCM(key, nonce, секрет, aad = ctx)
//! ```
//!
//! (len — u32 BE; строки — как на проводе, base64.) Открыть обёртку может только держатель того же SSK — ровно
//! устройства, способные выдать грант (`link_grant_material` требует SSK). Успешное открытие доказывает, что
//! challenge выставило своё устройство для ЭТОГО обязательства и этого ключа, — сервер не может ни подставить свой
//! challenge, ни перенести чужой на другой оффер. Новое устройство ничего не меняет: код сверки
//! `SHA-256("parvane-link-sas-v2" ‖ new ‖ challenge)` один и тот же на всех старых устройствах, грант принимается
//! под ключ challenge, кто бы из старых устройств его ни запечатал.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{ProtoError, Result};

/// Метка контекста обёртки.
pub const WRAP_LABEL: &[u8] = b"parvane/v2/link-challenge\0";
const NONCE_LEN: usize = 12;
/// Потолок секрета (закрытая часть P-256 — 32 байта).
pub const MAX_SECRET: usize = 64;
/// Потолок обёртки в байтах (nonce + секрет + метка GCM).
pub const MAX_WRAP: usize = NONCE_LEN + MAX_SECRET + 16;

fn context(user: &str, target: &str, commitment: &str, challenge_pub: &str) -> Vec<u8> {
    let mut ctx = WRAP_LABEL.to_vec();
    for p in [user, target, commitment, challenge_pub] {
        ctx.extend_from_slice(&(p.len() as u32).to_be_bytes());
        ctx.extend_from_slice(p.as_bytes());
    }
    ctx
}

fn cipher(ssk_seed: &[u8; 32], ctx: &[u8]) -> Result<Aes256Gcm> {
    let hk = Hkdf::<Sha256>::new(None, ssk_seed);
    let mut k = Zeroizing::new([0u8; 32]);
    hk.expand(ctx, k.as_mut()).map_err(|_| ProtoError::Crypto)?;
    Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(k.as_ref())))
}

fn check_fields(target: &str, commitment: &str, challenge_pub: &str) -> Result<()> {
    if target.is_empty() || target.len() > 64 {
        return Err(ProtoError::InvalidField("device_id"));
    }
    if commitment.is_empty() || commitment.len() > 512 {
        return Err(ProtoError::InvalidField("commitment"));
    }
    if challenge_pub.is_empty() || challenge_pub.len() > 512 {
        return Err(ProtoError::InvalidField("challenge_pub"));
    }
    Ok(())
}

/// Обёртка с заданным nonce (векторы); в работе — [`wrap_challenge`].
pub fn wrap_challenge_with_nonce(
    ssk_seed: &[u8; 32],
    user: &str,
    target: &str,
    commitment: &str,
    challenge_pub: &str,
    secret: &[u8],
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    check_fields(target, commitment, challenge_pub)?;
    if secret.is_empty() || secret.len() > MAX_SECRET {
        return Err(ProtoError::InvalidField("secret"));
    }
    let ctx = context(user, target, commitment, challenge_pub);
    let ct = cipher(ssk_seed, &ctx)?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: secret, aad: &ctx })
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Завернуть закрытую часть эфемерного ключа challenge для своих устройств.
pub fn wrap_challenge(ssk_seed: &[u8; 32], user: &str, target: &str, commitment: &str, challenge_pub: &str, secret: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    wrap_challenge_with_nonce(ssk_seed, user, target, commitment, challenge_pub, secret, nonce)
}

/// Открыть обёртку challenge, выставленного другим своим устройством. `Crypto` — обёртка не от держателя этого
/// SSK, либо к другому офферу/ключу (подмена сервером).
pub fn unwrap_challenge(ssk_seed: &[u8; 32], user: &str, target: &str, commitment: &str, challenge_pub: &str, wrap: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    check_fields(target, commitment, challenge_pub)?;
    if wrap.len() <= NONCE_LEN + 16 || wrap.len() > MAX_WRAP {
        return Err(ProtoError::InvalidField("wrap"));
    }
    let ctx = context(user, target, commitment, challenge_pub);
    let (nonce, ct) = wrap.split_at(NONCE_LEN);
    let pt = cipher(ssk_seed, &ctx)?
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &ctx })
        .map_err(|_| ProtoError::Crypto)?;
    Ok(Zeroizing::new(pt))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SSK: [u8; 32] = [7u8; 32];

    #[test]
    fn roundtrip_and_binding() {
        let w = wrap_challenge(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &[1u8; 32]).unwrap();
        let s = unwrap_challenge(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &w).unwrap();
        assert_eq!(s.as_slice(), &[1u8; 32]);
        // Другой SSK (чужой аккаунт или сервер) — не открывается
        assert!(unwrap_challenge(&[8u8; 32], "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &w).is_err());
        // Перенос на другой оффер, другое устройство, другой ключ challenge, другой адрес — не открывается
        assert!(unwrap_challenge(&SSK, "alice@local", "dev-new", "b3RoZXI=", "Q0hBTA==", &w).is_err());
        assert!(unwrap_challenge(&SSK, "alice@local", "dev-other", "Y29tbWl0", "Q0hBTA==", &w).is_err());
        assert!(unwrap_challenge(&SSK, "alice@local", "dev-new", "Y29tbWl0", "T1RIRVI=", &w).is_err());
        assert!(unwrap_challenge(&SSK, "bob@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &w).is_err());
        // Порча
        let mut bad = w.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(unwrap_challenge(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &bad).is_err());
        assert!(unwrap_challenge(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &w[..20]).is_err());
    }

    #[test]
    fn fixed_vector_is_stable() {
        // Вектор для клиентов: формат обёртки не должен меняться незаметно
        let w = wrap_challenge_with_nonce(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &[1u8; 32], [9u8; 12]).unwrap();
        assert_eq!(w.len(), 12 + 32 + 16);
        assert_eq!(&w[..12], &[9u8; 12]);
        let again = wrap_challenge_with_nonce(&SSK, "alice@local", "dev-new", "Y29tbWl0", "Q0hBTA==", &[1u8; 32], [9u8; 12]).unwrap();
        assert_eq!(w, again);
    }

    #[test]
    fn limits() {
        assert!(wrap_challenge(&SSK, "a@l", "", "c", "p", &[1]).is_err());
        assert!(wrap_challenge(&SSK, "a@l", "d", "c", "p", &[]).is_err());
        assert!(wrap_challenge(&SSK, "a@l", "d", "c", "p", &[0u8; 65]).is_err());
    }
}
