//! Отметка «диапазон нельзя заменять» (`range-hold`, spec 035: FR-032…FR-035, R5, data-model.md §2–3).
//!
//! Запись журнала, в исходных байтах которой `unknown::scan` находит непонятное этой версии (неизвестный вид
//! oneof, неизвестное поле на любой глубине, неизвестное значение enum), ставит отметку на свой номер; соседние
//! такие записи сливаются в один диапазон. Уничтожающие операции над журналом — компактизация, заменяющий
//! снимок, контрольная точка, обрезка — проверяют отметки (`check`) и при пересечении явно отказывают
//! (`RangeHeld`), исходные записи не трогаются (FR-034). Отметки хранятся записью хранилища вида `range-hold`
//! (имя — имя журнала) под DEK профиля и переживают перезапуск; потерянная или испорченная запись
//! пересчитывается из исходных записей журнала (`load`), а не считается «пустой» (FR-033).
//!
//! Неизвестный критичный вид (1000–1999) закрывает журнал для записи (`write_state`,
//! `JournalWrite::BlockedCriticalUnknown`, FR-041).
//!
//! Новое значение `ObjectKey.kind` в журнале личного состояния — не непонятное: новый вид объекта хранится и
//! сводится целиком (`state2.rs`), отметки не ставит.

use prost::Message;

use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::pb::parvane::engine::v1::{JournalWrite, RangeHold, RangeHolds, Stored};
use crate::unknown::{self, UnknownItem, UnknownKind, UnknownReport};

/// Вид записи хранилища.
pub const STORE_KIND: &str = "range-hold";
/// Имена журналов движка.
pub const STATE: &str = "state";
pub const HISTORY: &str = "history";
/// Типы открытого текста записей журналов.
pub const HISTORY_TYPE: &str = "parvane.history.v1.HistoryBatch";
pub const PLANNER_TYPE: &str = "parvane.planner.v1.PlannerOp";
pub const CLOUD_TYPE: &str = "parvane.cloud.v1.CloudOp";
/// Типы открытого текста снимков доменов (снимок, составленный движком будущего, тоже может нести непонятное).
pub const PLANNER_SNAPSHOT_TYPE: &str = "parvane.planner.v1.PlannerSnapshot";
pub const CLOUD_SNAPSHOT_TYPE: &str = "parvane.cloud.v1.CloudSnapshot";
/// Путей на отметку не больше (как `max_items` схемы).
const MAX_PATHS: usize = 64;

/// Находки, влияющие на сведение журнала типа `type_name`.
fn relevant<'a>(type_name: &str, r: &'a UnknownReport) -> Vec<&'a UnknownItem> {
    r.items
        .iter()
        .filter(|i| !(type_name == crate::state2::OP_TYPE && i.kind == UnknownKind::Enum && i.path.ends_with("object.kind")))
        .collect()
}

/// Отметки журнала `journal` по исходным записям `(seq, открытый текст)` типа `type_name` (по возрастанию seq).
/// Повреждённая запись — ошибка (её нельзя ни понять, ни заменить молча).
pub fn scan(journal: &str, type_name: &str, records: &[(u64, &[u8])]) -> Result<Vec<RangeHold>> {
    let mut out: Vec<RangeHold> = Vec::new();
    let mut last: Option<u64> = None;
    for (seq, bytes) in records {
        let report = unknown::scan(type_name, bytes)?;
        let found = relevant(type_name, &report);
        if found.is_empty() {
            last = None;
            continue;
        }
        let paths: Vec<String> = found.iter().map(|i| if i.path.is_empty() { format!("#{}", i.number) } else { format!("{}#{}", i.path, i.number) }).collect();
        match out.last_mut() {
            Some(h) if last.is_some_and(|l| l + 1 == *seq) => {
                h.to_seq = *seq;
                for p in paths {
                    if h.paths.len() < MAX_PATHS && !h.paths.contains(&p) {
                        h.paths.push(p);
                    }
                }
            }
            _ => {
                let mut ps = Vec::new();
                for p in paths {
                    if ps.len() < MAX_PATHS && !ps.contains(&p) {
                        ps.push(p);
                    }
                }
                out.push(RangeHold { journal: journal.to_string(), from_seq: *seq, to_seq: *seq, paths: ps });
            }
        }
        last = Some(*seq);
    }
    Ok(out)
}

/// Добавить отметки `new` к `holds`: пересекающиеся и соседние диапазоны одного журнала сливаются.
pub fn merge(holds: &mut Vec<RangeHold>, new: Vec<RangeHold>) {
    for n in new {
        let mut n = n;
        let mut i = 0;
        while i < holds.len() {
            let h = &holds[i];
            if h.journal == n.journal && h.from_seq <= n.to_seq.saturating_add(1) && n.from_seq <= h.to_seq.saturating_add(1) {
                let h = holds.remove(i);
                n.from_seq = n.from_seq.min(h.from_seq);
                n.to_seq = n.to_seq.max(h.to_seq);
                for p in h.paths {
                    if n.paths.len() < MAX_PATHS && !n.paths.contains(&p) {
                        n.paths.push(p);
                    }
                }
            } else {
                i += 1;
            }
        }
        holds.push(n);
    }
    holds.sort_by(|a, b| (a.journal.as_str(), a.from_seq).cmp(&(b.journal.as_str(), b.from_seq)));
}

/// Отметить непонятое в одной записи журнала `journal`, накрывающей номера `from..=to` (операция — `from == to`,
/// снимок до `upto` — `1..=upto`). Повреждённая запись отметки не ставит (её не применить и не понять никакой
/// версии; снимок из разобранного её и не содержал). Возвращает, нашлось ли непонятое.
pub fn note(holds: &mut Vec<RangeHold>, journal: &str, type_name: &str, from: u64, to: u64, bytes: &[u8]) -> bool {
    let Ok(mut found) = scan(journal, type_name, &[(to, bytes)]) else { return false };
    if found.is_empty() {
        return false;
    }
    for h in &mut found {
        h.from_seq = from.min(to);
    }
    merge(holds, found);
    true
}

/// Разрешена ли уничтожающая операция над записями `from..=to` журнала `journal`.
pub fn check(holds: &[RangeHold], journal: &str, from: u64, to: u64) -> Result<()> {
    if holds.iter().any(|h| h.journal == journal && h.from_seq <= to && from <= h.to_seq) {
        Err(ProtoError::RangeHeld)
    } else {
        Ok(())
    }
}

/// Состояние записи журнала по исходным записям: критичный неизвестный вид — запись закрыта.
pub fn write_state(type_name: &str, records: &[(u64, &[u8])]) -> Result<JournalWrite> {
    for (_, bytes) in records {
        if unknown::scan(type_name, bytes)?.has_critical() {
            return Ok(JournalWrite::BlockedCriticalUnknown);
        }
    }
    Ok(JournalWrite::Open)
}

/// Байты отметок журнала (payload записи хранилища).
pub fn encode(holds: &[RangeHold]) -> Vec<u8> {
    RangeHolds { holds: holds.to_vec() }.encode_to_vec()
}

pub fn decode(bytes: &[u8]) -> Result<Vec<RangeHold>> {
    Ok(decode_checked::<RangeHolds>(bytes, Origin::Client)?.holds)
}

/// Отметки после перезапуска: сохранённые, а если их нет или запись не читается — пересчёт по исходным записям.
pub fn load(stored: Option<&[u8]>, journal: &str, type_name: &str, records: &[(u64, &[u8])]) -> Result<Vec<RangeHold>> {
    if let Some(Ok(h)) = stored.map(decode) {
        if h.iter().all(|x| x.journal == journal) {
            return Ok(h);
        }
    }
    scan(journal, type_name, records)
}

/// Запись хранилища вида `range-hold` (имя — журнал) под DEK профиля (`store.rs`).
pub fn seal(dek: &[u8; 32], store_id: &[u8], generation: u32, journal: &str, holds: &[RangeHold]) -> Result<Stored> {
    let format = crate::model::store_kinds::format_of(STORE_KIND).ok_or(ProtoError::InvalidField("kind"))?;
    crate::store::seal_record(dek, store_id, format, STORE_KIND, generation, journal, &encode(holds))
}

/// Открыть запись хранилища отметок журнала `journal`.
pub fn open(dek: &[u8; 32], store_id: &[u8], generation: u32, journal: &str, stored: &Stored) -> Result<Vec<RangeHold>> {
    decode(&crate::store::open_record(dek, store_id, generation, STORE_KIND, journal, stored)?)
}
