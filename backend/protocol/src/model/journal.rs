//! Состояние журнала движка (spec 035, data-model.md §3, T056): курсор, голова и разрешена ли запись.
//! `OPEN → BLOCKED{CRITICAL_UNKNOWN}` — в исходных записях есть неизвестный критичный вид (`hold::write_state`);
//! `OPEN → BLOCKED{TOO_NEW}` — формат журнала новее движка; обновлённый движок, понявший запись, снова `OPEN`.
//! Хост показывает «обновите приложение» по изменению модели `writeBlocked{journal, reason}`.

use crate::error::Result;
use crate::pb::parvane::engine::v1::{JournalState, JournalWrite, WriteBlocked};

/// Состояние журнала по его исходным записям `(seq, открытый текст)` типа `type_name`.
pub fn state_of(journal: &str, type_name: &str, records: &[(u64, &[u8])], cursor: u64, head: u64) -> Result<JournalState> {
    let write = crate::hold::write_state(type_name, records)?;
    Ok(JournalState { journal: journal.to_string(), cursor, head, write: write as i32 })
}

/// Изменение модели «запись закрыта», если журнал закрыт.
pub fn write_blocked(s: &JournalState) -> Option<WriteBlocked> {
    match JournalWrite::try_from(s.write) {
        Ok(JournalWrite::Open) | Ok(JournalWrite::Unspecified) => None,
        Ok(w) => Some(WriteBlocked { journal: s.journal.clone(), reason: w as i32 }),
        Err(_) => Some(WriteBlocked { journal: s.journal.clone(), reason: JournalWrite::BlockedTooNew as i32 }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_record_blocks_and_open_is_silent() {
        let mut crit = crate::pb::parvane::state::v2::StateOp { op_id: vec![1; 16], lamport: 1, device_id: "d".into(), ..Default::default() };
        let mut b = prost::Message::encode_to_vec(&crit);
        b.extend_from_slice(&[0xc2, 0x3e, 0x00]);
        let s = state_of("state", crate::state2::OP_TYPE, &[(1, &b)], 1, 1).unwrap();
        assert_eq!(write_blocked(&s).map(|w| w.reason), Some(JournalWrite::BlockedCriticalUnknown as i32));
        crit.lamport = 2;
        let ok = prost::Message::encode_to_vec(&crit);
        let s = state_of("state", crate::state2::OP_TYPE, &[(1, &ok)], 1, 1).unwrap();
        assert_eq!(write_blocked(&s), None);
    }
}
