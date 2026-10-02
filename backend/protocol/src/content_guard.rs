//! Страж содержимого у получателя (T018, FR-026, класс 16). Данные
//! отправителя опасны получателю, поэтому до показа:
//! - MIME встраивания/воспроизведения — только из белого списка; остальное
//!   становится `application/octet-stream` (только скачивание); MIME не
//!   определяет исполнение;
//! - URL-схемы ссылок — только http/https (остальное нейтрализуется);
//! - entities обрезаются по длине текста (UTF-16), пустые и неизвестные
//!   выбрасываются;
//! - имя файла — без путей, управляющих символов и ведущих точек.

use crate::address;
use crate::pb::parvane::msg::v2::{content, Content, Entity, EntityType, LinkPreview, Media, Text};

pub const OCTET_STREAM: &str = "application/octet-stream";

/// Белый список MIME для встраивания/воспроизведения.
pub const INLINE_MIME: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/webm",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "application/x-tgsticker",
];

/// Нормализованный MIME: нижний регистр, без параметров; вне белого списка —
/// `application/octet-stream`.
pub fn safe_mime(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    INLINE_MIME.iter().find(|m| **m == base).copied().unwrap_or(OCTET_STREAM)
}

pub fn is_inline(mime: &str) -> bool {
    safe_mime(mime) != OCTET_STREAM
}

/// URL допустим для открытия: схема http/https, без пробелов и управляющих
/// символов, ≤ 2048 байт.
pub fn safe_url(url: &str) -> Option<&str> {
    let u = url.trim();
    if u.is_empty() || u.len() > 2048 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    // Хост непустой.
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some(u)
}

/// Длина строки в единицах UTF-16 (смещения entities — как в Telegram).
pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Обрезать entities по тексту; выбросить опасные/пустые/неизвестные.
pub fn sanitize_entities(text: &str, entities: &mut Vec<Entity>) {
    let len = utf16_len(text);
    entities.retain_mut(|e| {
        let Ok(ty) = EntityType::try_from(e.r#type) else { return false };
        if ty == EntityType::Unspecified || e.offset >= len {
            return false;
        }
        e.length = e.length.min(len - e.offset);
        if e.length == 0 {
            return false;
        }
        match ty {
            EntityType::TextUrl => {
                let ok = safe_url(&e.url).is_some();
                if !ok {
                    return false;
                }
            }
            EntityType::MentionName => {
                if !e.user.as_ref().is_some_and(|u| address::is_valid_address(&u.address)) {
                    return false;
                }
            }
            _ => e.url.clear(),
        }
        true
    });
}

/// Безопасное имя файла.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.chars().take(255).collect()
    }
}

fn sanitize_text(t: &mut Text) {
    let text = t.text.clone();
    sanitize_entities(&text, &mut t.entities);
    if let Some(p) = &mut t.preview {
        sanitize_preview(p);
        if p.url.is_empty() {
            t.preview = None;
        }
    }
}

fn sanitize_preview(p: &mut LinkPreview) {
    if safe_url(&p.url).is_none() {
        p.url.clear();
    }
    if let Some(img) = &mut p.image {
        sanitize_media(img);
    }
}

fn sanitize_media(m: &mut Media) {
    m.mime = safe_mime(&m.mime).to_string();
    if !m.name.is_empty() {
        m.name = safe_file_name(&m.name);
    }
    let caption = m.caption.clone();
    sanitize_entities(&caption, &mut m.caption_entities);
}

/// Применить страж ко всему содержимому (получатель, до показа).
pub fn sanitize_content(c: &mut Content) {
    match &mut c.kind {
        Some(content::Kind::Text(t)) => sanitize_text(t),
        Some(content::Kind::Media(m)) => sanitize_media(m),
        Some(content::Kind::Sticker(s)) => {
            if let Some(m) = &mut s.media {
                sanitize_media(m);
            }
        }
        Some(content::Kind::Edit(e)) => {
            if let Some(t) = &mut e.text {
                sanitize_text(t);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime() {
        assert_eq!(safe_mime("image/PNG; charset=x"), "image/png");
        assert_eq!(safe_mime("text/html"), OCTET_STREAM);
        assert_eq!(safe_mime("image/svg+xml"), OCTET_STREAM);
        assert_eq!(safe_mime("application/javascript"), OCTET_STREAM);
    }

    #[test]
    fn urls() {
        assert!(safe_url("https://example.org/a").is_some());
        assert!(safe_url("HTTP://x").is_some());
        for bad in ["javascript:alert(1)", "tg://resolve", "file:///etc/passwd", "data:text/html,x", "https://", "http:///x", "https://a b", "https://a\u{0}"] {
            assert!(safe_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn entities_clamped() {
        let mut es = vec![
            Entity { r#type: EntityType::Bold as i32, offset: 0, length: 100, ..Default::default() },
            Entity { r#type: EntityType::Bold as i32, offset: 10, length: 1, ..Default::default() },
            Entity { r#type: EntityType::TextUrl as i32, offset: 0, length: 1, url: "javascript:x".into(), ..Default::default() },
            Entity { r#type: 999, offset: 0, length: 1, ..Default::default() },
        ];
        sanitize_entities("héllo😀", &mut es);
        assert_eq!(es.len(), 1);
        assert_eq!(es[0].length, 7);
    }

    #[test]
    fn file_names() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("..\\..\\a.exe"), "a.exe");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name(""), "file");
    }
}
