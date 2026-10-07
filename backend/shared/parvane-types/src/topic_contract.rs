//! Единый контракт subjects между Rust-шардами, gateway и NATS ACL.
//!
//! Runtime-код gateway использует клиентские allowlist из этого модуля, а
//! integration test `topic_acl_contract` сверяет эти списки, фактические
//! подписки шардов и оба NATS-конфига. Поэтому новый subject нельзя добавить
//! только в одном слое и незаметно получить отказ в production.

use crate::topics::*;

pub const REQUEST_INBOX: &str = "_INBOX.>";

/// Identity: клиентские v1-subject'ы удалены (T110, 7 окт 2026) — осталась
/// проверка JWT для gateway и шардов; методы v2 — в сгенерированных блоках.
pub const IDENTITY_NATS_SUBSCRIBE: &[&str] = &[IDENTITY_VERIFY, REQUEST_INBOX];
pub const IDENTITY_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

/// Messenger говорит только методами v2 (ACL — сгенерированные блоки
/// `# >>> v2 messenger`); v1-subject'ы `msg.chat.*`, `msg.sync.request`,
/// `group.*` удалены (T110, 7 окт 2026).
pub const MESSENGER_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
pub const MESSENGER_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

pub const CLOUD_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
pub const CLOUD_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

pub const CALL_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
pub const CALL_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

pub const NOTES_NATS_SUBSCRIBE: &[&str] = &[
    NOTE_CREATE,
    NOTE_UPDATE,
    NOTE_DELETE,
    NOTE_SYNC_REQUEST,
    REQUEST_INBOX,
];
pub const NOTES_NATS_PUBLISH: &[&str] = &[IDENTITY_VERIFY, REQUEST_INBOX];

pub const CALENDAR_NATS_SUBSCRIBE: &[&str] = &[
    CAL_CREATE,
    CAL_UPDATE,
    CAL_DELETE,
    CAL_SYNC_REQUEST,
    REQUEST_INBOX,
];
pub const CALENDAR_NATS_PUBLISH: &[&str] = &[IDENTITY_VERIFY, REQUEST_INBOX];

pub const PREVIEW_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
pub const PREVIEW_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

pub const PUSH_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
pub const PUSH_NATS_PUBLISH: &[&str] = &[REQUEST_INBOX];

/// Bus-права доверенного gateway. Клиентские subject'ы v1 удалены (T110, 7 окт
/// 2026): клиенты ходят только методами v2 (их ACL — сгенерированные блоки
/// `# >>> v2 gateway` в `infra/nats/*.conf`), от v1 остаётся лишь проверка JWT.
pub const GATEWAY_NATS_PUBLISH: &[&str] = &[IDENTITY_VERIFY];

pub const GATEWAY_NATS_SUBSCRIBE: &[&str] = &[REQUEST_INBOX];
