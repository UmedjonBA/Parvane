//! Тип `Address` — адрес пользователя `local@domain`. Валидируется на gateway и
//! в шардах ПЕРЕД тем, как попасть в NATS-subject (`msg.user.<addr>` и т.п.),
//! чтобы клиент не мог внедрить пробел/CRLF/wildcard и разорвать кадр протокола
//! (subject-инъекция, находка P-01).
//!
//! Правила: ровно один `@`; `local` и `domain` — непустые, из `[A-Za-z0-9._-]`,
//! не начинаются и не кончаются на `.`, без `..`; суммарная длина ≤ `MAX_LEN`.
//! Групповой адрес — строго UUID (без `@`), для него отдельная проверка.

use std::fmt;
use std::str::FromStr;

/// Максимальная длина всего адреса (local@domain).
pub const MAX_LEN: usize = 255;
/// Максимальная длина каждой части.
pub const MAX_PART_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    local: String,
    domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressError {
    Empty,
    TooLong,
    NoAtSign,
    ManyAtSigns,
    EmptyPart,
    BadChar,
    BadDot,
}

impl fmt::Display for AddressError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            AddressError::Empty => "пустой адрес",
            AddressError::TooLong => "адрес слишком длинный",
            AddressError::NoAtSign => "адрес без '@'",
            AddressError::ManyAtSigns => "в адресе больше одного '@'",
            AddressError::EmptyPart => "пустая часть адреса",
            AddressError::BadChar => "недопустимый символ в адресе",
            AddressError::BadDot => "точка в начале/конце части или '..'",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for AddressError {}

fn valid_part(part: &str) -> Result<(), AddressError> {
    if part.is_empty() {
        return Err(AddressError::EmptyPart);
    }
    if part.len() > MAX_PART_LEN {
        return Err(AddressError::TooLong);
    }
    if part.starts_with('.') || part.ends_with('.') || part.contains("..") {
        return Err(AddressError::BadDot);
    }
    if !part
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        return Err(AddressError::BadChar);
    }
    Ok(())
}

impl FromStr for Address {
    type Err = AddressError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.is_empty() {
            return Err(AddressError::Empty);
        }
        if s.len() > MAX_LEN {
            return Err(AddressError::TooLong);
        }
        let mut parts = s.split('@');
        let local = parts.next().ok_or(AddressError::NoAtSign)?;
        let domain = parts.next().ok_or(AddressError::NoAtSign)?;
        if parts.next().is_some() {
            return Err(AddressError::ManyAtSigns);
        }
        valid_part(local)?;
        valid_part(domain)?;
        Ok(Address { local: local.to_string(), domain: domain.to_string() })
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}@{}", self.local, self.domain)
    }
}

impl Address {
    pub fn local(&self) -> &str {
        &self.local
    }
    pub fn domain(&self) -> &str {
        &self.domain
    }
}

/// Быстрая проверка «это допустимый адрес пользователя» без аллокации типа.
pub fn is_valid_address(s: &str) -> bool {
    Address::from_str(s).is_ok()
}

/// Групповой идентификатор — строго UUID (его генерирует сервер как uuid-v7).
/// Клиент присылает его в `to`, поэтому перед публикацией по нему проверяем.
pub fn is_valid_group_id(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}

/// Допустимый маршрут доставки в инбокс/сигналинг: адрес пользователя, UUID
/// группы или групповой mesh-адрес `gcall:<addr>` для звонков.
pub fn is_valid_route(route: &str) -> bool {
    if let Some(rest) = route.strip_prefix("gcall:") {
        return is_valid_address(rest);
    }
    is_valid_address(route) || is_valid_group_id(route)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_addresses() {
        assert!(is_valid_address("alice@local"));
        assert!(is_valid_address("a.b_c-d@sub.example.com"));
        assert!("bob@local".parse::<Address>().is_ok());
        let a: Address = "alice@example.com".parse().unwrap();
        assert_eq!(a.local(), "alice");
        assert_eq!(a.domain(), "example.com");
        assert_eq!(a.to_string(), "alice@example.com");
    }

    #[test]
    fn rejects_subject_injection() {
        // Пробел/CRLF — попытка разорвать кадр PUB
        assert!(!is_valid_address("bob@s 0\r\n\r\nPUB msg.user.bob@s 3"));
        assert!(!is_valid_address("bob@s\r\nPUB x"));
        assert!(!is_valid_address("bob @local"));
        assert!(!is_valid_address("bob@lo cal"));
        // Wildcards NATS
        assert!(!is_valid_address("bob@*"));
        assert!(!is_valid_address("*@local"));
        assert!(!is_valid_address("bob@local.>"));
        assert!(!is_valid_address("bob.>@local"));
    }

    #[test]
    fn rejects_malformed() {
        assert!(!is_valid_address(""));
        assert!(!is_valid_address("noatsign"));
        assert!(!is_valid_address("a@b@c"));
        assert!(!is_valid_address("@local"));
        assert!(!is_valid_address("bob@"));
        assert!(!is_valid_address(".bob@local"));
        assert!(!is_valid_address("bob.@local"));
        assert!(!is_valid_address("bob@.local"));
        assert!(!is_valid_address("bob@local."));
        assert!(!is_valid_address("a..b@local"));
        assert!(!is_valid_address(&format!("{}@local", "x".repeat(129))));
    }

    #[test]
    fn group_and_route() {
        let uuid = "0192f4a0-1c2b-7def-8123-000000000001";
        assert!(is_valid_group_id(uuid));
        assert!(!is_valid_group_id("not-a-uuid"));
        assert!(is_valid_route(uuid));
        assert!(is_valid_route("alice@local"));
        assert!(is_valid_route("gcall:alice@local"));
        assert!(!is_valid_route("gcall:bad addr"));
        assert!(!is_valid_route("bob@s\r\nPUB x"));
    }
}
