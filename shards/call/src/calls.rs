//! Чистая логика жизненного цикла звонка — без async/IO, чтобы покрыть тестами.
//!
//! Звонок проходит статусы:
//!   ringing → answered → ended      (нормальный сценарий)
//!   ringing → missed                (повесили трубку до ответа)
//!   ringing → rejected              (вызываемый отклонил)
//! ICE-кандидаты статус не меняют (это обмен сетевыми путями во время дозвона).

use parvane_types::CallSignal;

/// Новый статус звонка после сигнала, либо `None` если статус не меняется.
/// `current` — текущий статус из БД (None, если звонка ещё нет).
pub fn next_status(current: Option<&str>, signal: &CallSignal) -> Option<&'static str> {
    match signal {
        CallSignal::Invite { .. } => Some("ringing"),
        CallSignal::Answer { .. } => Some("answered"),
        CallSignal::Reject { .. } => Some("rejected"),
        CallSignal::Hangup { .. } => {
            // Повесили трубку: если уже отвечали — это завершённый звонок,
            // иначе — пропущенный.
            if current == Some("answered") {
                Some("ended")
            } else {
                Some("missed")
            }
        }
        CallSignal::Ice { .. } => None,
    }
}

/// Терминальный статус — пора проставить `ended_at`.
pub fn is_terminal(status: &str) -> bool {
    matches!(status, "ended" | "missed" | "rejected")
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn invite() -> CallSignal {
        CallSignal::Invite {
            call_id: Uuid::nil(),
            media: parvane_types::CallMedia::Audio,
            sdp: "offer".into(),
        }
    }
    fn answer() -> CallSignal {
        CallSignal::Answer { call_id: Uuid::nil(), sdp: "answer".into() }
    }
    fn hangup() -> CallSignal {
        CallSignal::Hangup { call_id: Uuid::nil() }
    }
    fn reject() -> CallSignal {
        CallSignal::Reject { call_id: Uuid::nil(), reason: None }
    }
    fn ice() -> CallSignal {
        CallSignal::Ice { call_id: Uuid::nil(), candidate: "cand".into() }
    }

    #[test]
    fn invite_starts_ringing() {
        assert_eq!(next_status(None, &invite()), Some("ringing"));
    }

    #[test]
    fn answer_marks_answered() {
        assert_eq!(next_status(Some("ringing"), &answer()), Some("answered"));
    }

    #[test]
    fn hangup_after_answer_is_ended() {
        assert_eq!(next_status(Some("answered"), &hangup()), Some("ended"));
    }

    #[test]
    fn hangup_before_answer_is_missed() {
        assert_eq!(next_status(Some("ringing"), &hangup()), Some("missed"));
    }

    #[test]
    fn reject_marks_rejected() {
        assert_eq!(next_status(Some("ringing"), &reject()), Some("rejected"));
    }

    #[test]
    fn ice_does_not_change_status() {
        assert_eq!(next_status(Some("answered"), &ice()), None);
    }

    #[test]
    fn terminal_states() {
        assert!(is_terminal("ended"));
        assert!(is_terminal("missed"));
        assert!(is_terminal("rejected"));
        assert!(!is_terminal("ringing"));
        assert!(!is_terminal("answered"));
    }
}
