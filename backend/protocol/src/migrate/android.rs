//! Старые места android (перечень, слой `android`): файлы каталога профиля libtd (`MigrateLegacy.kt` отдаёт их
//! ключом `file:<имя>`; файлы ядра — `file:/<имя>` каталога состояния v2, как у desktop).
//!
//! Переносятся: экспорт движка (`/v2-…/state` под `…/key`, общий с ядром), строки истории `history-<…>`
//! (`RowState` в JSON движка), маркеры `history-marks-<…>`. Прочее (`folders.json`, `contacts.json`, …) —
//! проекции журнала состояния либо служебное, пересчитывается. Общие ключи `migrate:<класс>` — как у ядра.

use super::{base_name, split_place, Class};

pub fn classify(key: &str) -> Class {
    if let Some(c) = super::core::generic(key) {
        return c;
    }
    let (place, path) = split_place(key);
    if place != "file" {
        return Class::Unknown;
    }
    let base = base_name(path);
    if base.starts_with("history-marks-") {
        return Class::ReadMarks;
    }
    if base.starts_with("history-sync-") || base.starts_with("history-local-") {
        return Class::Derived("history-local");
    }
    if base.starts_with("history-") {
        return Class::HistoryRows;
    }
    match super::core::classify(key) {
        Class::Unknown => Class::Derived("file"),
        c => c,
    }
}
