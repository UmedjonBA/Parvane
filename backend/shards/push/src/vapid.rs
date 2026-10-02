//! VAPID (RFC 8292): ключи сервера и заголовок `Authorization`. Общий для
//! v1-пушей (`push.device.*`) и пробуждений v2 (`push.wake.*`).
//!
//! P-51: VAPID-JWT подписываем сами через p256/ecdsa — без jwt-simple/rsa.

use anyhow::{Context, Result};
use base64::Engine;

/// Срок действия VAPID-JWT (RFC 8292 §2: не более 24 ч).
pub const VAPID_JWT_TTL_SECS: u64 = 12 * 60 * 60;
/// Контакт оператора в claim `sub` (RFC 8292 §2.1).
pub const VAPID_SUBJECT: &str = "mailto:admin@parvane.local";

pub struct VapidKeys {
    pub private_pem: String,
    pub public_b64url: String,
}

impl VapidKeys {
    /// Публичный ключ — несжатая точка P-256 (65 байт).
    pub fn public_raw(&self) -> Result<Vec<u8>> {
        b64url_decode(&self.public_b64url)
    }
}

pub fn vapid_from_pem(private_pem: &str) -> Result<VapidKeys> {
    use p256::pkcs8::DecodePrivateKey;
    let secret = p256::SecretKey::from_pkcs8_pem(private_pem)
        .map_err(|e| anyhow::anyhow!("VAPID PEM: {e}"))?;
    let public_point = secret.public_key().to_sec1_bytes();
    let public_b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&public_point);
    Ok(VapidKeys { private_pem: private_pem.to_string(), public_b64url })
}

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// base64url с паддингом или без (браузеры отдают `p256dh`/`auth` по-разному).
pub fn b64url_decode(s: &str) -> Result<Vec<u8>> {
    let trimmed = s.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed))
        .map_err(|e| anyhow::anyhow!("base64url: {e}"))
}

/// `aud` для VAPID: только scheme://host[:port] endpoint'а (RFC 8292 §2).
pub fn vapid_audience(endpoint: &url::Url) -> Result<String> {
    let host = endpoint.host_str().context("endpoint без host")?;
    Ok(match endpoint.port() {
        Some(port) => format!("{}://{}:{}", endpoint.scheme(), host, port),
        None => format!("{}://{}", endpoint.scheme(), host),
    })
}

/// ES256-JWT для VAPID: header `{"typ":"JWT","alg":"ES256"}`, подпись r||s (64 байта),
/// собранный руками поверх p256 — без jwt-simple/rsa.
pub fn vapid_jwt(vapid: &VapidKeys, audience: &str, now: u64) -> Result<String> {
    use p256::ecdsa::signature::Signer;
    use p256::pkcs8::DecodePrivateKey;

    let secret = p256::SecretKey::from_pkcs8_pem(&vapid.private_pem)
        .map_err(|e| anyhow::anyhow!("VAPID PEM: {e}"))?;
    let signing_key = p256::ecdsa::SigningKey::from(&secret);

    let header = b64url(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::json!({
        "aud": audience,
        "exp": now + VAPID_JWT_TTL_SECS,
        "sub": VAPID_SUBJECT,
    });
    let claims = b64url(serde_json::to_string(&claims)?.as_bytes());
    let signing_input = format!("{header}.{claims}");
    let signature: p256::ecdsa::Signature = signing_key.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", b64url(&signature.to_bytes())))
}

/// Заголовок `Authorization: vapid t=<jwt>, k=<публичный ключ>` (RFC 8292 §3).
pub fn vapid_authorization(vapid: &VapidKeys, endpoint: &url::Url, now: u64) -> Result<String> {
    let jwt = vapid_jwt(vapid, &vapid_audience(endpoint)?, now)?;
    Ok(format!("vapid t={}, k={}", jwt, vapid.public_b64url))
}
