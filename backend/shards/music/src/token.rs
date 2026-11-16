//! Жетоны ссылок «Музыки» (spec 039): `base64url(тело ‖ HMAC-SHA256(ключ, тело))`. Ссылку открывает браузерный
//! `<audio>` и плееры клиентов без заголовков авторизации, поэтому право — сама ссылка: она названа на
//! пользователя, один трек (либо обложки) и ограничена сроком. Ключ подписи — файл шарда, наружу не уходит.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const VERSION: u8 = 1;
const MAC_LEN: usize = 32;
/// Срок ссылки на поток: клиент берёт новую, когда эта истекла.
pub const STREAM_TTL_MS: i64 = 2 * 3_600_000;
/// Срок базы ссылок обложек.
pub const COVER_TTL_MS: i64 = 24 * 3_600_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Grant {
    /// Поток одного трека; `opus` — перекодированный.
    Stream { track: String, opus: bool },
    /// Обложки (любые): база ссылок пользователя.
    Covers,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// Имя пользователя музыкального сервера.
    pub user: String,
    pub exp_ms: i64,
    pub grant: Grant,
}

fn mac(key: &[u8; 32], body: &[u8]) -> Option<Hmac<Sha256>> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).ok()?;
    m.update(body);
    Some(m)
}

pub fn sign(key: &[u8; 32], c: &Claims) -> Option<String> {
    let user = c.user.as_bytes();
    let user_len = u8::try_from(user.len()).ok()?;
    let (kind, flag, track) = match &c.grant {
        Grant::Stream { track, opus } => (1u8, u8::from(*opus), track.as_bytes()),
        Grant::Covers => (2u8, 0u8, &[][..]),
    };
    let mut body = Vec::with_capacity(12 + user.len() + track.len() + MAC_LEN);
    body.extend_from_slice(&[VERSION, kind, flag]);
    body.extend_from_slice(&c.exp_ms.to_be_bytes());
    body.push(user_len);
    body.extend_from_slice(user);
    body.extend_from_slice(track);
    let tag = mac(key, &body)?.finalize().into_bytes();
    body.extend_from_slice(&tag);
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body))
}

/// Проверить подпись и срок. Любой сбой — `None` (причину наружу не говорим).
pub fn verify(key: &[u8; 32], token: &str, now_ms: i64) -> Option<Claims> {
    if token.len() > 512 {
        return None;
    }
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token).ok()?;
    let split = raw.len().checked_sub(MAC_LEN)?;
    let (body, tag) = raw.split_at(split);
    mac(key, body)?.verify_slice(tag).ok()?;
    let (head, rest) = (body.get(..12)?, body.get(12..)?);
    if head.first() != Some(&VERSION) {
        return None;
    }
    let exp_ms = i64::from_be_bytes(head.get(3..11)?.try_into().ok()?);
    if exp_ms <= now_ms {
        return None;
    }
    let user_len = usize::from(*head.get(11)?);
    let user = String::from_utf8(rest.get(..user_len)?.to_vec()).ok()?;
    let track = String::from_utf8(rest.get(user_len..)?.to_vec()).ok()?;
    let grant = match (head.get(1)?, head.get(2)?) {
        (1, flag) if !track.is_empty() => Grant::Stream { track, opus: *flag == 1 },
        (2, _) if track.is_empty() => Grant::Covers,
        _ => return None,
    };
    Some(Claims { user, exp_ms, grant })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_expiry_and_tamper() {
        let key = [7u8; 32];
        let c = Claims { user: "alice.0a1b2c3d".into(), exp_ms: 2_000, grant: Grant::Stream { track: "tr-1".into(), opus: true } };
        let t = sign(&key, &c).unwrap();
        assert_eq!(verify(&key, &t, 1_000), Some(c.clone()));
        assert_eq!(verify(&key, &t, 2_000), None, "срок вышел");
        assert_eq!(verify(&[8u8; 32], &t, 1_000), None, "чужой ключ");
        // Подмена трека в теле ломает подпись
        let mut raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&t).unwrap();
        let i = raw.len() - MAC_LEN - 1;
        raw[i] ^= 1;
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        assert_eq!(verify(&key, &forged, 1_000), None);
        // Жетон обложек не открывает поток и наоборот — виды различаются
        let covers = sign(&key, &Claims { user: "bob".into(), exp_ms: 9_000, grant: Grant::Covers }).unwrap();
        assert_eq!(verify(&key, &covers, 1_000).unwrap().grant, Grant::Covers);
        assert_eq!(verify(&key, "", 0), None);
        assert_eq!(verify(&key, "не base64", 0), None);
    }
}
