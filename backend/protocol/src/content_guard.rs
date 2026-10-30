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

/// Невидимые символы форматирования Юникода (категория Cf: bidi-управление, нулевой ширины, BOM, мягкий
/// перенос): ими подделывают вид имени файла и адреса.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// URL допустим для открытия: схема http/https, без пробелов, управляющих символов и символов
/// форматирования, без `user@` перед хостом (маскировка адреса), ≤ 2048 байт.
pub fn safe_url(url: &str) -> Option<&str> {
    let u = url.trim();
    if u.is_empty() || u.len() > 2048 || u.chars().any(|c| c.is_control() || c.is_whitespace() || is_format_char(c)) {
        return None;
    }
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    // Хост непустой.
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
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

/// Имена устройств Windows: файл с таким именем (с любым расширением) на ней не создать.
fn is_reserved_name(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (up.len() == 4 && (up.starts_with("COM") || up.starts_with("LPT")) && up.as_bytes()[3].is_ascii_digit() && up.as_bytes()[3] != b'0')
}

/// Безопасное имя файла: без путей, управляющих и невидимых символов, ведущих точек, хвостовых точек и
/// пробелов, зарезервированных имён Windows; не длиннее 255 байт.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String =
        base.chars().filter(|c| !c.is_control() && !is_format_char(*c) && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return "file".to_string();
    }
    let mut out = String::new();
    if is_reserved_name(trimmed.split('.').next().unwrap_or("").trim_end()) {
        out.push('_');
    }
    for c in trimmed.chars() {
        if out.len() + c.len_utf8() > 255 {
            break;
        }
        out.push(c);
    }
    out
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
        Some(content::Kind::Article(a)) => a.media.iter_mut().for_each(sanitize_media),
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
    fn article_media_sanitized() {
        let article = crate::pb::parvane::msg::v2::Article {
            media: vec![Media { mime: "text/html".into(), name: "../папка/x.png".into(), ..Default::default() }],
            ..Default::default()
        };
        let mut c = Content { kind: Some(content::Kind::Article(article)), ..Default::default() };
        sanitize_content(&mut c);
        let Some(content::Kind::Article(a)) = c.kind else { panic!("не статья") };
        assert_eq!(a.media[0].mime, OCTET_STREAM);
        assert!(!a.media[0].name.contains('/'), "{}", a.media[0].name);
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
        // bidi-подмена расширения, зарезервированные имена Windows, хвостовые точки, длина в байтах.
        assert_eq!(safe_file_name("photo\u{202E}gpj.exe"), "photogpj.exe");
        assert_eq!(safe_file_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_file_name("lpt1"), "_lpt1");
        assert_eq!(safe_file_name("com0.txt"), "com0.txt");
        assert_eq!(safe_file_name("a.txt. . "), "a.txt");
        assert!(safe_file_name(&"я".repeat(200)).len() <= 255);
    }

    #[test]
    fn url_userinfo_and_format_chars() {
        for bad in ["https://bank.example@evil.example/", "http://a@b", "https://exa\u{202E}mple.org/", "https://x.org\u{200B}/"] {
            assert!(safe_url(bad).is_none(), "{bad}");
        }
        assert!(safe_url("https://example.org/p?mail=a@b").is_some());
    }
}
