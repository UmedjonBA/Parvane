//! Возможности устройства, которые понимает движок (spec 035, FR-049, contracts/versioning.md):
//! устройство объявляет их по своему интерфейсу (`DeviceCertificate.features`, `Hello.features`);
//! строки `[a-z0-9_.]{1,64}`. Список отдаёт `engineInfo().features`.

pub const KNOWN: &[&str] = &["article", "cloud", "cloud_invite", "planner", "sealed", "task_offer", "wire_rows"];

/// Хост рисует строки сам по содержимому в своём виде (`MessageView.wire`, web, spec 035 T114): показ отдаёт все
/// виды, кроме служебных строк ленты.
pub const WIRE_ROWS: &str = "wire_rows";

/// Служебные строки ленты: в страницы и последнее сообщение чата не входят, их видят только `rowsAll` хоста.
pub const WIRE_SERVICE_KINDS: &[&str] = &["poll_close", "poll_vote"];

/// Допустимое имя возможности.
pub fn is_valid(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
}

#[cfg(test)]
mod tests {
    #[test]
    fn known_are_valid_and_sorted() {
        assert!(super::KNOWN.windows(2).all(|w| w[0] < w[1]));
        assert!(super::KNOWN.iter().all(|f| super::is_valid(f)));
        assert!(!super::is_valid("no-ssk") && !super::is_valid(""));
    }
}
