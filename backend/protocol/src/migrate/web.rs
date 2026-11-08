//! Старые места web (перечень `migration-inventory.json`, слой `web`): записи защищённого хранилища
//! `parvane-e2e-v2/secure-state` (хост отдаёт их ключом `record:<имя>` уже расшифрованными своим ключом WebCrypto),
//! ключи `localStorage` (`localStorage:<ключ>`), прочие базы IndexedDB (`idb:<база>/<хранилище>`).
//!
//! Переносятся: экспорт движка `v2-engine-bin` под ключом `v2-storage-key` (ключи, сессии, журналы устройств и
//! групп, «План», «Облако»), строки истории `m:<uuid>` (поле `hs` — `RowState` в JSON движка, `order` — место
//! ORDER-1), маркеры `rm:<адрес>`, своё исходящее `j:<uuid>`, граница очистки `cleareduntil`. Проекции журнала
//! личного состояния в `localStorage` (`folders`, `contacts`, …) не переносятся — состояние берётся из журнала
//! `state.v1` на сервере (`state_v1.rs`) и пересчитывается.

use super::Class;

pub fn classify(key: &str) -> Class {
    if let Some(c) = super::core::generic(key) {
        return c;
    }
    let (place, rest) = super::split_place(key);
    match place {
        "record" => match rest {
            "v2-engine-bin" => Class::EngineState,
            "v2-storage-key" => Class::EngineKey,
            "v2-engine" => Class::Derived("engine-state-json"),
            _ if rest.starts_with("m:") => Class::HistoryRows,
            _ if rest.starts_with("rm:") => Class::ReadMarks,
            _ if rest.starts_with("j:") => Class::OwnJournal,
            _ => Class::Derived("record"),
        },
        "localStorage" if rest.starts_with("parvane:cleareduntil:") => Class::Cleared,
        "localStorage" | "literal" | "idb" => Class::Derived(place_label(place)),
        _ => Class::Unknown,
    }
}

fn place_label(place: &str) -> &'static str {
    match place {
        "localStorage" => "local-storage",
        "literal" => "local-storage",
        _ => "idb",
    }
}
