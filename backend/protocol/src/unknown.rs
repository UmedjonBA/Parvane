//! Поведение на неизвестное (T016, FR-004):
//! - неизвестный вид содержимого (oneof `Content.kind` не распознан) или
//!   неизвестный номер из `OpHeader.critical_fields` → нативная заглушка
//!   «сообщение не поддерживается вашей версией», курсор идёт дальше;
//! - неизвестная запись журнала/служебное событие → пропуск (курсор идёт);
//! - неизвестный метод запроса → отказ `INVALID`.

use crate::pb::parvane::msg::v2::{inbox_record, Content, InboxRecord};
use crate::pb::parvane::core::v2::Event;
use crate::schema;

/// Что делать клиенту с полученной записью/содержимым.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Показать как обычно.
    Show,
    /// Показать нативную заглушку «не поддерживается».
    Stub,
    /// Пропустить без показа (служебное), курсор двигается.
    Skip,
}

/// Известен ли номер поля верхнего уровня `Content`.
fn content_field_known(number: u32) -> bool {
    schema::message("parvane.msg.v2.Content").is_some_and(|m| m.field(number).is_some())
}

/// Решение по расшифрованному содержимому.
pub fn content_disposition(content: &Content, critical_fields: &[u32]) -> Disposition {
    if content.kind.is_none() {
        return Disposition::Stub;
    }
    if critical_fields.iter().any(|n| !content_field_known(*n)) {
        return Disposition::Stub;
    }
    Disposition::Show
}

/// Решение по записи журнала инбокса.
pub fn record_disposition(rec: &InboxRecord) -> Disposition {
    match rec.item {
        None => Disposition::Skip,
        Some(inbox_record::Item::Sealed(_))
        | Some(inbox_record::Item::Group(_))
        | Some(inbox_record::Item::LegacyV1(_)) => Disposition::Show,
        Some(inbox_record::Item::GroupState(_))
        | Some(inbox_record::Item::DeviceRevoked(_))
        | Some(inbox_record::Item::DeviceAdded(_)) => Disposition::Skip,
    }
}

/// Известные виды событий подписки.
pub const KNOWN_EVENT_KINDS: &[&str] = &["inbox.record", "ephemeral.typing", "ephemeral.presence", "session.revoked"];

/// Неизвестный вид события → пропуск.
pub fn event_disposition(ev: &Event) -> Disposition {
    if KNOWN_EVENT_KINDS.contains(&ev.kind.as_str()) {
        Disposition::Show
    } else {
        Disposition::Skip
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::msg::v2::{content, Text};
    use prost::Message;

    #[test]
    fn unknown_kind_is_stub() {
        // Content с неизвестным полем 50 (новый вид из будущей версии).
        let bytes = [0x92, 0x03, 0x00];
        let c = Content::decode(&bytes[..]).unwrap();
        assert_eq!(content_disposition(&c, &[]), Disposition::Stub);
    }

    #[test]
    fn critical_unknown_is_stub() {
        let c = Content { kind: Some(content::Kind::Text(Text::default())), ..Default::default() };
        assert_eq!(content_disposition(&c, &[]), Disposition::Show);
        assert_eq!(content_disposition(&c, &[1]), Disposition::Show);
        assert_eq!(content_disposition(&c, &[77]), Disposition::Stub);
    }

    #[test]
    fn unknown_record_skipped() {
        let r = InboxRecord::decode(&[0x08, 0x05, 0xf2, 0x03, 0x00][..]).unwrap();
        assert_eq!(record_disposition(&r), Disposition::Skip);
        assert_eq!(event_disposition(&Event { kind: "future.kind".into(), ..Default::default() }), Disposition::Skip);
    }
}
