//! Пробуждения протокола v2 (spec 007 US6, R13, T101): чистая логика без
//! NATS и SQLite — проверка регистрации, схлопывание, сборка HTTP-запроса.
//!
//! Пробуждение ПУСТОЕ: в нём нет ни id чата, ни отправителя, ни содержимого,
//! ни даже того, сколько записей пришло. Сборщик запроса вообще не получает
//! запись журнала — только регистрацию канала, так что утечь нечему:
//! - web push: тело — постоянная [`WAKE_BODY`], зашифрованная по RFC 8291
//!   (aes128gcm) ключом подписки; снаружи — случайный шум фиксированной длины;
//! - UnifiedPush: POST на endpoint с пустым телом (RFC 8030 без полезной
//!   нагрузки).
//!
//! Схлопывание: не более одного пробуждения на устройство за
//! [`COLLAPSE_WINDOW`]; устройство, проснувшись, само забирает журнал.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use parvane_protocol::pb::parvane::core::v2::ErrorCode;
use parvane_protocol::pb::parvane::push::v1::{WakeKind, WakeRegistration};
use parvane_protocol::registry_gen::{inbox_subject, INBOX_PREFIX};
use web_push_native::{Auth, WebPushBuilder};

use crate::vapid::{vapid_authorization, VapidKeys, VAPID_JWT_TTL_SECS};

/// Окно схлопывания: ≤ 1 пробуждения на устройство.
pub const COLLAPSE_WINDOW: Duration = Duration::from_secs(30);
/// Не больше регистраций на пользователя (как у v1-подписок, P-17).
pub const MAX_REGISTRATIONS_PER_USER: i64 = 8;
/// Постоянное тело web push (до шифрования). Одинаково для всех пробуждений.
pub const WAKE_BODY: &[u8] = b"{}";
/// RFC 8030 `Topic`: push-сервис заменяет недоставленное пробуждение новым,
/// а не копит очередь (постоянное значение — ничего не раскрывает).
pub const WAKE_TOPIC: &str = "wake";
/// Длина токена журнала устройства (hex 16 байт).
pub const INBOX_TOKEN_LEN: usize = 32;
/// Порог чистки памяти схлопывания.
const COLLAPSE_CAP: usize = 50_000;

/// Токен журнала устройства: `inbox_subject(user, device)` без префикса.
pub fn device_token(user: &str, device_id: &str) -> Result<String, ErrorCode> {
    let s = inbox_subject(user, device_id).map_err(|_| ErrorCode::Invalid)?;
    s.strip_prefix(INBOX_PREFIX).map(str::to_string).ok_or(ErrorCode::Invalid)
}

/// Токен из subject'а `v2.inbox.<token>`; всё прочее — `None`.
pub fn inbox_token(subject: &str) -> Option<&str> {
    let t = subject.strip_prefix(INBOX_PREFIX)?;
    (t.len() == INBOX_TOKEN_LEN && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(t)
}

/// Схлопывание пробуждений по устройству.
pub struct Collapser {
    window: Duration,
    last: HashMap<String, Instant>,
}

impl Default for Collapser {
    fn default() -> Self {
        Self::new(COLLAPSE_WINDOW)
    }
}

impl Collapser {
    pub fn new(window: Duration) -> Self {
        Self { window, last: HashMap::new() }
    }

    /// Разрешить пробуждение устройства `token` в момент `now` и сразу его
    /// отметить (проверка и отметка атомарны под одной блокировкой — пачка
    /// параллельных записей даёт одно пробуждение).
    pub fn admit(&mut self, token: &str, now: Instant) -> bool {
        if let Some(t) = self.last.get(token) {
            if now.saturating_duration_since(*t) < self.window {
                return false;
            }
        }
        if self.last.len() >= COLLAPSE_CAP {
            let w = self.window;
            self.last.retain(|_, t| now.saturating_duration_since(*t) < w);
        }
        self.last.insert(token.to_string(), now);
        true
    }
}

/// Проверенная регистрация (то, что хранится в БД).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWake {
    pub kind: WakeKind,
    pub endpoint: String,
    /// Для web push — несжатая точка P-256 (65 байт); для UnifiedPush пусто.
    pub p256dh: Vec<u8>,
    /// Для web push — 16 байт; для UnifiedPush пусто.
    pub auth: Vec<u8>,
}

/// Проверка регистрации без сети. Сеть (резолв хоста в публичные адреса)
/// проверяет вызывающий.
pub fn check_registration(r: &WakeRegistration) -> Result<StoredWake, ErrorCode> {
    let kind = WakeKind::try_from(r.kind).map_err(|_| ErrorCode::Invalid)?;
    match kind {
        WakeKind::Unspecified => return Err(ErrorCode::Invalid),
        // Нативные каналы — отдельная фича (R13).
        WakeKind::Fcm | WakeKind::Apns => return Err(ErrorCode::Unavailable),
        WakeKind::WebPush | WakeKind::UnifiedPush => {}
    }
    // P-17: только публичный https (общий фильтр parvane-netguard).
    parvane_netguard::check_url(&r.endpoint, &parvane_netguard::UrlPolicy::HTTPS).map_err(|_| ErrorCode::Invalid)?;
    if kind == WakeKind::UnifiedPush {
        return Ok(StoredWake { kind, endpoint: r.endpoint.clone(), p256dh: Vec::new(), auth: Vec::new() });
    }
    if r.auth.len() != 16 || p256::PublicKey::from_sec1_bytes(&r.p256dh).is_err() || r.p256dh.len() != 65 {
        return Err(ErrorCode::Invalid);
    }
    Ok(StoredWake { kind, endpoint: r.endpoint.clone(), p256dh: r.p256dh.clone(), auth: r.auth.clone() })
}

/// Собрать POST пробуждения. На вход — только регистрация канала: запись
/// журнала сюда не попадает по построению.
pub fn build_wake_request(vapid: &VapidKeys, reg: &StoredWake, now: u64) -> Result<http::Request<Vec<u8>>> {
    let endpoint_url = url::Url::parse(&reg.endpoint).context("endpoint")?;
    let uri: http::Uri = reg.endpoint.parse().context("endpoint как URI")?;
    let mut request = match reg.kind {
        WakeKind::WebPush => {
            let ua_public = p256::PublicKey::from_sec1_bytes(&reg.p256dh).map_err(|e| anyhow::anyhow!("p256dh: {e}"))?;
            if reg.auth.len() != 16 {
                anyhow::bail!("auth должен быть 16 байт");
            }
            WebPushBuilder::new(uri, ua_public, Auth::clone_from_slice(&reg.auth))
                .with_valid_duration(Duration::from_secs(VAPID_JWT_TTL_SECS))
                .build(WAKE_BODY)
                .map_err(|e| anyhow::anyhow!("шифрование пробуждения: {e}"))?
        }
        WakeKind::UnifiedPush => http::Request::builder()
            .method(http::Method::POST)
            .uri(uri)
            .header("TTL", VAPID_JWT_TTL_SECS)
            .header(http::header::CONTENT_LENGTH, 0)
            .body(Vec::new())
            .context("запрос UnifiedPush")?,
        other => anyhow::bail!("канал {other:?} не поддержан"),
    };
    let authorization = vapid_authorization(vapid, &endpoint_url, now)?;
    let h = request.headers_mut();
    h.insert(http::header::AUTHORIZATION, http::HeaderValue::from_str(&authorization).context("заголовок VAPID")?);
    h.insert("Urgency", http::HeaderValue::from_static("high"));
    h.insert("Topic", http::HeaderValue::from_static(WAKE_TOPIC));
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_token_parsing() {
        let t = device_token("alice@local", "d1").unwrap();
        assert_eq!(t.len(), INBOX_TOKEN_LEN);
        assert_eq!(inbox_token(&format!("{INBOX_PREFIX}{t}")), Some(t.as_str()));
        assert_eq!(inbox_token("v2.inbox.zz"), None);
        assert_eq!(inbox_token("msg.user.alice@local"), None);
        assert_eq!(inbox_token(&format!("{INBOX_PREFIX}{}", "A".repeat(32))), None);
        assert!(device_token("a*@local", "d1").is_err());
    }

    #[test]
    fn collapser_window() {
        let mut c = Collapser::new(Duration::from_secs(30));
        let t0 = Instant::now();
        assert!(c.admit("a", t0));
        assert!(!c.admit("a", t0 + Duration::from_secs(29)));
        assert!(c.admit("b", t0 + Duration::from_secs(1)), "другое устройство — независимо");
        assert!(c.admit("a", t0 + Duration::from_secs(30)));
    }

    #[test]
    fn registration_checks() {
        let ua = p256::SecretKey::random(&mut rand::rngs::OsRng).public_key().to_sec1_bytes().to_vec();
        let ok = WakeRegistration {
            kind: WakeKind::WebPush as i32,
            endpoint: "https://fcm.googleapis.com/fcm/send/x".into(),
            p256dh: ua.clone(),
            auth: vec![1; 16],
        };
        assert!(check_registration(&ok).is_ok());
        for (r, code) in [
            (WakeRegistration { endpoint: "http://fcm.googleapis.com/x".into(), ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { endpoint: "https://10.0.0.1/x".into(), ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { endpoint: "https://localhost/x".into(), ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { auth: vec![1; 15], ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { p256dh: vec![4; 65], ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { kind: 0, ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { kind: 99, ..ok.clone() }, ErrorCode::Invalid),
            (WakeRegistration { kind: WakeKind::Fcm as i32, ..ok.clone() }, ErrorCode::Unavailable),
            (WakeRegistration { kind: WakeKind::Apns as i32, ..ok.clone() }, ErrorCode::Unavailable),
        ] {
            assert_eq!(check_registration(&r).err(), Some(code), "{r:?}");
        }
        let up = check_registration(&WakeRegistration { kind: WakeKind::UnifiedPush as i32, p256dh: vec![], auth: vec![], ..ok.clone() })
            .unwrap();
        assert!(up.p256dh.is_empty() && up.auth.is_empty());
    }
}
