//! Проверка адресов и ссылок ДО использования (класс 4, FR-015): `Ref`,
//! `UserRef`, `DeviceRef`. Правила адреса совпадают с `parvane_types::Address`
//! v1: ровно один `@`, части из `[A-Za-z0-9._-]`, без `.` по краям и `..`,
//! часть ≤ 128, всё ≤ 255. `device_id` — `[A-Za-z0-9_-]`, 1..64.

use crate::error::{ProtoError, Result};
use crate::pb::parvane::core::v2::{DeviceRef, Ref, UserRef};

pub const MAX_ADDRESS_LEN: usize = 255;
pub const MAX_PART_LEN: usize = 128;
pub const MAX_DEVICE_ID_LEN: usize = 64;
pub const REF_ID_LEN: usize = 16;

fn valid_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= MAX_PART_LEN
        && !part.starts_with('.')
        && !part.ends_with('.')
        && !part.contains("..")
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Домен сервера (часть адреса после `@`, домен в `Ref`).
pub fn is_valid_domain(domain: &str) -> bool {
    valid_part(domain)
}

pub fn is_valid_address(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_ADDRESS_LEN {
        return false;
    }
    let mut parts = s.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => valid_part(local) && valid_part(domain),
        _ => false,
    }
}

/// Домен адреса (для проверки «свой/чужой сервер»).
pub fn address_domain(s: &str) -> Option<&str> {
    if !is_valid_address(s) {
        return None;
    }
    s.split_once('@').map(|(_, d)| d)
}

pub fn is_valid_device_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_DEVICE_ID_LEN
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn check_user(u: &UserRef) -> Result<()> {
    if is_valid_address(&u.address) {
        Ok(())
    } else {
        Err(ProtoError::BadAddress)
    }
}

pub fn check_device(d: &DeviceRef) -> Result<()> {
    if is_valid_address(&d.address) && is_valid_device_id(&d.device_id) {
        Ok(())
    } else {
        Err(ProtoError::BadAddress)
    }
}

pub fn check_ref(r: &Ref) -> Result<()> {
    if is_valid_domain(&r.domain) && r.id.len() == REF_ID_LEN {
        Ok(())
    } else {
        Err(ProtoError::BadAddress)
    }
}

/// Новая ссылка со случайным id.
pub fn new_ref(domain: &str) -> Result<Ref> {
    if !is_valid_domain(domain) {
        return Err(ProtoError::BadAddress);
    }
    let mut id = vec![0u8; REF_ID_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut id);
    Ok(Ref { domain: domain.to_string(), id })
}

/// Токен NATS-subject'а из проверенной ссылки: hex id — без `.`/`*`/`>`/пробелов.
pub fn ref_subject_token(r: &Ref) -> Result<String> {
    check_ref(r)?;
    Ok(r.id.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert!(is_valid_address("alice@parvane.duckdns.org"));
        assert!(is_valid_address("a_b-c.d@local"));
        for bad in [
            "", "alice", "a@b@c", "@local", "alice@", "al ice@local", "alice@lo*cal", "alice@>", "a.@local",
            ".a@local", "a..b@local", "alice@local\r\n", "alice@local.",
        ] {
            assert!(!is_valid_address(bad), "{bad:?}");
        }
        assert!(!is_valid_address(&format!("{}@local", "a".repeat(129))));
    }

    #[test]
    fn device_ids() {
        assert!(is_valid_device_id("web-1a2B_3"));
        assert!(!is_valid_device_id(""));
        assert!(!is_valid_device_id("a.b"));
        assert!(!is_valid_device_id("a*"));
        assert!(!is_valid_device_id(&"x".repeat(65)));
    }

    #[test]
    fn refs() {
        let r = new_ref("local").unwrap();
        assert!(check_ref(&r).is_ok());
        assert_eq!(ref_subject_token(&r).unwrap().len(), 32);
        assert!(check_ref(&Ref { domain: "local".into(), id: vec![0; 15] }).is_err());
        assert!(check_ref(&Ref { domain: "lo cal".into(), id: vec![0; 16] }).is_err());
    }
}
