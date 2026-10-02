//! Ссылки-приглашения в группу v2 (T084, D-04): единый формат
//! `https://<domain>/join/<link_id>#<seed>` (см. `proto/parvane/group/v2/invite.proto`).
//! Секрет ссылки (seed) — только во фрагменте URL; сервер знает link_id.
//! Прежние формы v1 (`#+<token>`, `parvane.invite/<token>`) распознаются
//! отдельно и ведут в v1-путь до E6.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::SigningKey;

use crate::address::is_valid_domain;
use crate::error::{ProtoError, Result};
use crate::group::link_id;
use crate::pb::parvane::group::v2::InviteLinkParts;

/// Длина seed и link_id.
pub const LINK_BYTES: usize = 32;
/// Предел длины ссылки при разборе (защита от мусора из буфера обмена).
pub const MAX_LINK_LEN: usize = 512;
/// Предел длины v1-токена.
const MAX_LEGACY_TOKEN: usize = 128;

/// Результат разбора ссылки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedInvite {
    /// Ссылка v2: домен группы, link_id и секрет.
    V2(InviteLinkParts),
    /// Прежняя ссылка v1: токен для `group.join` v1.
    LegacyV1 { token: String },
}

/// Новая ссылка: секрет (для подписи вступления) и части для URL.
/// Публичный ключ для записи журнала `GroupInviteKeyAnnounce` —
/// `key.verifying_key()`.
pub fn generate(domain: &str) -> Result<(SigningKey, InviteLinkParts)> {
    if !is_valid_domain(domain) {
        return Err(ProtoError::InvalidField("invite"));
    }
    let mut seed = [0u8; LINK_BYTES];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut seed);
    let parts = from_seed(domain, &seed)?;
    Ok((SigningKey::from_bytes(&seed), parts))
}

/// Части ссылки из известного секрета (векторы, восстановление).
pub fn from_seed(domain: &str, seed: &[u8; LINK_BYTES]) -> Result<InviteLinkParts> {
    if !is_valid_domain(domain) {
        return Err(ProtoError::InvalidField("invite"));
    }
    let key = SigningKey::from_bytes(seed);
    Ok(InviteLinkParts {
        domain: domain.to_string(),
        link_id: link_id(key.verifying_key().as_bytes()).to_vec(),
        seed: seed.to_vec(),
    })
}

/// Собрать URL из частей.
pub fn format(parts: &InviteLinkParts) -> Result<String> {
    check(parts)?;
    Ok(format!(
        "https://{}/join/{}#{}",
        parts.domain,
        URL_SAFE_NO_PAD.encode(&parts.link_id),
        URL_SAFE_NO_PAD.encode(&parts.seed)
    ))
}

/// Ключ подписи вступления из частей ссылки (с проверкой link_id).
pub fn signing_key(parts: &InviteLinkParts) -> Result<SigningKey> {
    check(parts)?;
    let seed: [u8; LINK_BYTES] = parts.seed.as_slice().try_into().map_err(|_| ProtoError::InvalidField("invite"))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Разобрать ссылку любого поддерживаемого вида.
pub fn parse(input: &str) -> Result<ParsedInvite> {
    let s = input.trim();
    if s.is_empty() || s.len() > MAX_LINK_LEN {
        return Err(ProtoError::InvalidField("invite"));
    }
    // v1: `…#+<token>` (веб) и `parvane.invite/<token>` (десктоп/андроид).
    if let Some((_, token)) = s.split_once("#+") {
        return legacy(token);
    }
    let rest = s.strip_prefix("https://").ok_or(ProtoError::InvalidField("invite"))?;
    if let Some(token) = rest.strip_prefix("parvane.invite/") {
        return legacy(token);
    }
    let (authority, path) = rest.split_once('/').ok_or(ProtoError::InvalidField("invite"))?;
    let domain = authority.split_once(':').map_or(authority, |(host, port)| {
        if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
            ""
        } else {
            host
        }
    });
    let (path, fragment) = path.split_once('#').ok_or(ProtoError::InvalidField("invite"))?;
    let id = path.strip_prefix("join/").ok_or(ProtoError::InvalidField("invite"))?;
    let parts = InviteLinkParts {
        domain: domain.to_string(),
        link_id: URL_SAFE_NO_PAD.decode(id).map_err(|_| ProtoError::InvalidField("invite"))?,
        seed: URL_SAFE_NO_PAD.decode(fragment).map_err(|_| ProtoError::InvalidField("invite"))?,
    };
    check(&parts)?;
    Ok(ParsedInvite::V2(parts))
}

fn legacy(token: &str) -> Result<ParsedInvite> {
    let token = token.trim_end_matches('/');
    if token.is_empty()
        || token.len() > MAX_LEGACY_TOKEN
        || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ProtoError::InvalidField("invite"));
    }
    Ok(ParsedInvite::LegacyV1 { token: token.to_string() })
}

/// Части согласованы: домен допустим, длины верны, link_id = SHA-256(pub(seed)).
fn check(parts: &InviteLinkParts) -> Result<()> {
    if !is_valid_domain(&parts.domain) || parts.link_id.len() != LINK_BYTES || parts.seed.len() != LINK_BYTES {
        return Err(ProtoError::InvalidField("invite"));
    }
    let seed: [u8; LINK_BYTES] = parts.seed.as_slice().try_into().map_err(|_| ProtoError::InvalidField("invite"))?;
    let key = SigningKey::from_bytes(&seed);
    if link_id(key.verifying_key().as_bytes()).as_slice() != parts.link_id.as_slice() {
        return Err(ProtoError::InvalidField("invite"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let (key, parts) = generate("parvane.example").unwrap();
        let url = format(&parts).unwrap();
        assert!(url.starts_with("https://parvane.example/join/"));
        let ParsedInvite::V2(back) = parse(&url).unwrap() else { panic!("не v2") };
        assert_eq!(back, parts);
        assert_eq!(signing_key(&back).unwrap().to_bytes(), key.to_bytes());
    }

    #[test]
    fn port_and_whitespace() {
        let (_, parts) = generate("parvane.example").unwrap();
        let url = format(&parts).unwrap().replace("parvane.example/", "parvane.example:20443/");
        assert!(matches!(parse(&format!("  {url}\n")).unwrap(), ParsedInvite::V2(p) if p.domain == "parvane.example"));
        assert!(parse(&url.replace(":20443", ":x")).is_err());
    }

    #[test]
    fn tampered_seed_rejected() {
        let (_, mut parts) = generate("a.b").unwrap();
        parts.seed[0] ^= 1;
        assert!(format(&parts).is_err());
        let (_, other) = generate("a.b").unwrap();
        let url = format!(
            "https://a.b/join/{}#{}",
            URL_SAFE_NO_PAD.encode(&other.link_id),
            URL_SAFE_NO_PAD.encode(&parts.seed)
        );
        assert!(parse(&url).is_err());
        // Без фрагмента (секрета) ссылка не принимается
        assert!(parse(&format!("https://a.b/join/{}", URL_SAFE_NO_PAD.encode(&other.link_id))).is_err());
    }

    #[test]
    fn legacy_forms() {
        assert_eq!(parse("https://web.example/#+AbC-12_x").unwrap(), ParsedInvite::LegacyV1 { token: "AbC-12_x".into() });
        assert_eq!(parse("https://parvane.invite/tok123").unwrap(), ParsedInvite::LegacyV1 { token: "tok123".into() });
        assert!(parse("https://parvane.invite/").is_err());
        assert!(parse("https://x/#+bad token").is_err());
        assert!(parse("http://a.b/join/x#y").is_err());
    }
}
