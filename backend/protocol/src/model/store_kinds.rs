//! Виды записей хранилища движка и их текущие форматы (spec 035, contracts/storage.md, data-model.md §2).
//! Формат растёт при смене смысла/раскладки payload вида; перенос — поколением. Таблица — источник
//! `engineInfo().storage_formats` и проверки «слишком новый формат» (`store.rs`, FR-025).

/// (вид, формат) по алфавиту вида.
pub const KINDS: &[(&str, u32)] = &[
    ("device-log", 1),
    ("domain-log", 1),
    ("domain-snapshot", 1),
    ("draft-local", 1),
    ("engine-core", 1),
    ("group-log", 1),
    ("group-view", 1),
    ("history-mark", 1),
    ("history-raw", 1),
    ("history-row", 1),
    ("media-key", 1),
    ("migration-progress", 1),
    ("note", 1),
    ("outbox", 1),
    ("pack-archive", 1),
    ("quarantine", 1),
    ("range-hold", 1),
    ("state-object", 1),
    ("state-raw", 1),
];

/// Текущий формат вида; `None` — вид движку не известен.
pub fn format_of(kind: &str) -> Option<u32> {
    KINDS.binary_search_by(|(k, _)| (*k).cmp(kind)).ok().and_then(|i| KINDS.get(i)).map(|(_, f)| *f)
}

#[cfg(test)]
mod tests {
    #[test]
    fn sorted_and_valid() {
        assert!(super::KINDS.windows(2).all(|w| w[0].0 < w[1].0), "KINDS не по алфавиту");
        for (k, f) in super::KINDS {
            assert!(*f >= 1 && !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'));
            assert_eq!(super::format_of(k), Some(*f));
        }
        assert_eq!(super::format_of("nope"), None);
    }
}
