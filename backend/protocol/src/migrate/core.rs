//! Старые места ядра desktop/android (перечень, слои `core` и `desktop`): файлы tdata/профиля, которые хост
//! (`migrate_legacy.cpp`) отдаёт ключом `file:<путь от каталога профиля>` уже расшифрованными `storecrypt`.
//!
//! Переносятся: каталог состояния v2 `parvane-v2-<адрес>/state` (экспорт движка) под ключом `…/key`, журнал
//! истории `parvane-history-<адрес>.jsonl` (строки — `RowState` в JSON движка, допускаются `{hs, order}`),
//! маркеры `parvane-readmarks-…`, граница очистки `parvane-cleared-…`. Проекции журнала состояния
//! (`parvane-folders.json`, `parvane-dialogs.json`, …) пересчитываются из журнала `state.v1`.
//!
//! Общие ключи `migrate:<класс>` — для любого хоста, который отдаёт уже нормализованное (тот же формат значений):
//! `migrate:engine-state`, `migrate:engine-key`, `migrate:history-rows`, `migrate:read-marks`,
//! `migrate:own-journal`, `migrate:cleared`, `migrate:state-unsent`.

use super::{base_name, split_place, Class};

/// Общие ключи `migrate:<класс>` (все слои).
pub fn generic(key: &str) -> Option<Class> {
    let rest = key.strip_prefix("migrate:")?;
    let name = rest.split_once(':').map(|(a, _)| a).unwrap_or(rest);
    Some(match name {
        "engine-state" => Class::EngineState,
        "engine-key" => Class::EngineKey,
        "history-rows" => Class::HistoryRows,
        "read-marks" => Class::ReadMarks,
        "own-journal" => Class::OwnJournal,
        "cleared" => Class::Cleared,
        "state-unsent" => Class::StateUnsent,
        _ => Class::Unknown,
    })
}

pub fn classify(key: &str) -> Class {
    if let Some(c) = generic(key) {
        return c;
    }
    let (place, path) = split_place(key);
    if place != "file" {
        return Class::Unknown;
    }
    let base = base_name(path);
    let in_v2_dir = path.contains("parvane-v2-") || path.starts_with('/') || path.contains("/v2-");
    if in_v2_dir && base == "state" {
        return Class::EngineState;
    }
    if in_v2_dir && base == "key" {
        return Class::EngineKey;
    }
    if base.starts_with("parvane-history-sync-") {
        return Class::Derived("history-sync");
    }
    if base.starts_with("parvane-history-") {
        return Class::HistoryRows;
    }
    if base.starts_with("parvane-readmarks-") {
        return Class::ReadMarks;
    }
    if base.starts_with("parvane-cleared-") {
        return Class::Cleared;
    }
    if base.starts_with("parvane-") || in_v2_dir {
        return Class::Derived("file");
    }
    Class::Unknown
}
