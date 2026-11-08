//! «Движок будущего» для тестов (spec 035, T025; cargo-feature `future-schema`): типы
//! `parvane.sample.v1.Future*` — надмножества сообщений выпуска (новое вложенное поле, новый обычный
//! вид, критичный вид, новое значение enum). Круг совместимости (Phase 5): байты, собранные этими
//! типами, проходят через движок выпуска и обратно; движок выпуска обязан сохранить непонятное или
//! явно отказать.

use prost::Message;

use crate::pb::parvane::sample::v1::{
    future_content, FutureContent, FutureCritical, FutureEntity, FutureEntityType, FutureNormal, FutureText,
};

/// Пары «тип будущего → тип выпуска с теми же номерами полей».
pub const MIRRORS: &[(&str, &str)] = &[
    ("parvane.sample.v1.FutureContent", "parvane.msg.v2.Content"),
    ("parvane.sample.v1.FutureText", "parvane.msg.v2.Text"),
    ("parvane.sample.v1.FutureEntity", "parvane.msg.v2.Entity"),
];

/// Содержимое с новым вложенным полем и новым значением enum на глубине 3.
pub fn text_with_future_fields() -> Vec<u8> {
    FutureContent {
        kind: Some(future_content::Kind::Text(FutureText {
            text: "привет".into(),
            entities: vec![FutureEntity { r#type: FutureEntityType::Sparkle as i32, offset: 0, length: 6, future_note: "новое".into() }],
            future_level: 3,
        })),
        ttl_secs: 0,
    }
    .encode_to_vec()
}

/// Новый обычный вид содержимого.
pub fn normal_kind() -> Vec<u8> {
    FutureContent { kind: Some(future_content::Kind::FutureNormal(FutureNormal { label: "новый вид".into() })), ttl_secs: 0 }.encode_to_vec()
}

/// Новый критичный вид содержимого.
pub fn critical_kind() -> Vec<u8> {
    FutureContent { kind: Some(future_content::Kind::FutureCritical(FutureCritical { secret_rule: vec![1, 2, 3] })), ttl_secs: 0 }.encode_to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unknown;

    #[test]
    fn release_engine_sees_future_bytes_as_unknown() {
        let r = unknown::scan("parvane.msg.v2.Content", &text_with_future_fields()).unwrap();
        assert!(!r.is_empty() && !r.has_critical());
        let r = unknown::scan("parvane.msg.v2.Content", &normal_kind()).unwrap();
        assert!(!r.is_empty() && !r.has_critical());
        assert!(unknown::scan("parvane.msg.v2.Content", &critical_kind()).unwrap().has_critical());
        // Движок будущего свои байты понимает.
        for b in [text_with_future_fields(), normal_kind(), critical_kind()] {
            assert!(unknown::scan("parvane.sample.v1.FutureContent", &b).unwrap().is_empty());
        }
    }
}
