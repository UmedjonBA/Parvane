use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── топики ───────────────────────────────────────────────────────────────────

pub mod topics {
    pub const IDENTITY_ISSUE: &str = "identity.token.issue";
    pub const IDENTITY_VERIFY: &str = "identity.token.verify";

    pub const MSG_SEND: &str = "msg.chat.send";
    pub const MSG_DELIVERED: &str = "msg.chat.delivered";
    pub const MSG_READ: &str = "msg.chat.read";
    pub const MSG_SYNC_REQUEST: &str = "msg.sync.request";
    pub const MSG_SYNC_RESPONSE: &str = "msg.sync.response";

    pub const FILE_UPLOAD_CHUNK: &str = "file.upload.chunk";
    pub const FILE_UPLOAD_COMPLETE: &str = "file.upload.complete";
    pub const FILE_DOWNLOAD_REQUEST: &str = "file.download.request";
    pub const FILE_DOWNLOAD_RESPONSE: &str = "file.download.response";
    pub const FILE_LIST_REQUEST: &str = "file.list.request";
    pub const FILE_LIST_RESPONSE: &str = "file.list.response";

    pub const NOTE_CREATE: &str = "note.create";
    pub const NOTE_UPDATE: &str = "note.update";
    pub const NOTE_DELETE: &str = "note.delete";
    pub const NOTE_SYNC_REQUEST: &str = "note.sync.request";
    pub const NOTE_SYNC_RESPONSE: &str = "note.sync.response";

    pub const CAL_CREATE: &str = "cal.event.create";
    pub const CAL_UPDATE: &str = "cal.event.update";
    pub const CAL_DELETE: &str = "cal.event.delete";
    pub const CAL_SYNC_REQUEST: &str = "cal.sync.request";
    pub const CAL_SYNC_RESPONSE: &str = "cal.sync.response";

    pub const CALL_SIGNAL: &str = "call.signal";
    pub const CALL_HISTORY_REQUEST: &str = "call.history.request";
    pub const CALL_HISTORY_RESPONSE: &str = "call.history.response";

    /// Персональный инбокс пользователя для входящих сигналов звонка.
    /// Получатель подписывается на этот же точный субъект (`@` в субъекте NATS
    /// допустим). Например: `call.user.bob@local`.
    pub fn call_inbox(user: &str) -> String {
        format!("call.user.{user}")
    }
}

// ── обёртка события ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParvaneEvent<T> {
    pub id: Uuid,
    pub from: String,
    pub ts: i64,
    /// JWT; пустая строка для identity.token.issue
    pub token: String,
    pub payload: T,
}

// ── identity payloads ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueRequest {
    pub user: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueResponse {
    pub ok: bool,
    pub token: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyRequest {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyResponse {
    pub ok: bool,
    pub user: Option<String>,
    pub error: Option<String>,
}

// ── messenger payloads ───────────────────────────────────────────────────────

/// Содержимое сообщения. Медиа-варианты несут только ссылку `file_id` на блоб,
/// загруженный в шард `cloud`, плюс метаданные для отображения. Сам бинарь по
/// шине не гоняется.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageContent {
    Text {
        text: String,
    },
    /// Голосовое сообщение.
    Voice {
        file_id: Uuid,
        duration_secs: u32,
        mime: String,
        size_bytes: u64,
    },
    /// Видео-кружочек.
    VideoNote {
        file_id: Uuid,
        duration_secs: u32,
        mime: String,
        size_bytes: u64,
    },
    Photo {
        file_id: Uuid,
        width: u32,
        height: u32,
        mime: String,
        size_bytes: u64,
        caption: Option<String>,
    },
    Video {
        file_id: Uuid,
        duration_secs: u32,
        width: u32,
        height: u32,
        mime: String,
        size_bytes: u64,
        caption: Option<String>,
    },
    File {
        file_id: Uuid,
        filename: String,
        mime: String,
        size_bytes: u64,
        caption: Option<String>,
    },
}

impl MessageContent {
    /// Короткое имя варианта — пишется в колонку `kind` для фильтрации.
    pub fn kind(&self) -> &'static str {
        match self {
            MessageContent::Text { .. } => "text",
            MessageContent::Voice { .. } => "voice",
            MessageContent::VideoNote { .. } => "video_note",
            MessageContent::Photo { .. } => "photo",
            MessageContent::Video { .. } => "video",
            MessageContent::File { .. } => "file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendPayload {
    pub to: String,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredPayload {
    pub message_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadPayload {
    pub message_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequestPayload {
    pub last_seen_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResponsePayload {
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: Uuid,
    pub from: String,
    pub to: String,
    pub content: MessageContent,
    pub ts: i64,
}

// ── cloud payloads ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadChunkPayload {
    pub file_id: Uuid,
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub data: String, // base64
    pub filename: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadCompletePayload {
    pub file_id: Uuid,
    pub filename: String,
    pub total_chunks: u32,
    pub size_bytes: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadCompleteResponse {
    pub ok: bool,
    pub file_id: Option<Uuid>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub file_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadResponse {
    pub ok: bool,
    pub file_id: Option<Uuid>,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub chunk_index: Option<u32>,
    pub total_chunks: Option<u32>,
    pub data: Option<String>, // base64
    pub error: Option<String>,
}

/// Один файл в облаке.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub file_id: Uuid,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListPayload {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListResponse {
    pub files: Vec<FileEntry>,
}

// ── notes CRDT (RGA) ──────────────────────────────────────────────────────────
//
// Каждый символ заметки — узел RGA с уникальным OpId и ссылкой `after` на
// предшественника. Вставки и удаления коммутируют: порядок применения операций
// не влияет на итоговый текст. Это обеспечивает сходимость (convergence) при
// офлайн-редактировании на нескольких клиентах.

/// Идентификатор операции: (seq, site). Производный `Ord` сравнивает сначала
/// `seq`, затем `site` — тотальный порядок для детерминированной сортировки.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct OpId {
    pub seq: u64,
    pub site: String,
}

/// Операция CRDT над заметкой.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NoteOp {
    /// Вставить символ `ch` с идентификатором `id` после узла `after`
    /// (`None` — в начало документа).
    Insert {
        id: OpId,
        after: Option<OpId>,
        ch: char,
    },
    /// Пометить узел `target` удалённым (tombstone).
    Delete { target: OpId },
}

/// Узел RGA как он хранится/передаётся (состояние, не операция).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteElement {
    pub id: OpId,
    pub after: Option<OpId>,
    pub ch: char,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteCreatePayload {
    pub note_id: Uuid,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteUpdatePayload {
    pub note_id: Uuid,
    pub ops: Vec<NoteOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDeletePayload {
    pub note_id: Uuid,
}

/// Пустой payload — sync возвращает все заметки пользователя.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSyncRequestPayload {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSyncResponsePayload {
    pub notes: Vec<NoteSnapshot>,
}

/// Полное состояние одной заметки: метаданные, отрендеренный текст и все узлы
/// RGA (чтобы клиент мог продолжить редактирование оффлайн).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSnapshot {
    pub note_id: Uuid,
    pub title: String,
    pub text: String,
    pub elements: Vec<NoteElement>,
    pub deleted: bool,
}

// ── calendar CRDT (per-field LWW-Map) ─────────────────────────────────────────
//
// Событие — это набор полей, каждое со своим LWW-регистром (значение + штамп).
// Штамп = (ts, site): при конфликте побеждает больший ts, site — детерминированный
// разрыв ничьей. Поля независимы, поэтому конкурентные правки разных полей
// сливаются без потерь. Удаление — отдельный штамп; событие считается удалённым,
// только если delete-штамп новее всех правок полей ("последняя операция побеждает").

/// Логический штамп. Производный `Ord` сравнивает `ts`, затем `site`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Stamp {
    pub ts: i64,
    pub site: String,
}

/// LWW-регистр одного поля.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LwwField {
    pub value: String,
    pub stamp: Stamp,
}

/// Создание/обновление события: задаёт значения полей с общим штампом.
/// `cal.event.create` и `cal.event.update` несут одинаковый payload — на уровне
/// CRDT это одна операция "записать поля". Create дополнительно фиксирует владельца.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalSetPayload {
    pub event_id: Uuid,
    /// Имя поля → значение. Известные поля: title, start, end, location.
    /// start/end — unix-секунды в виде строки.
    pub fields: std::collections::BTreeMap<String, String>,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalDeletePayload {
    pub event_id: Uuid,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalSyncRequestPayload {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalSyncResponsePayload {
    pub events: Vec<CalEventSnapshot>,
}

/// Полное состояние события со штампами — чтобы клиент мог продолжить мерж оффлайн.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalEventSnapshot {
    pub event_id: Uuid,
    pub fields: std::collections::BTreeMap<String, LwwField>,
    pub deleted: bool,
    pub deleted_stamp: Option<Stamp>,
}

// ── звонки (WebRTC-сигналинг) ─────────────────────────────────────────────────
//
// Backend только релеит сигналы между двумя пирами и ведёт историю. Сам медиа-
// поток идёт P2P через WebRTC (нужны STUN/TURN и клиент) — мимо нашей шины.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallMedia {
    Audio,
    Video,
}

/// Сигнал установления/завершения звонка.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CallSignal {
    /// Приглашение: SDP-offer вызывающего.
    Invite { call_id: Uuid, media: CallMedia, sdp: String },
    /// Ответ: SDP-answer вызываемого.
    Answer { call_id: Uuid, sdp: String },
    /// Отклонить вызов.
    Reject { call_id: Uuid, reason: Option<String> },
    /// ICE-кандидат (обмен сетевыми путями).
    Ice { call_id: Uuid, candidate: String },
    /// Завершить звонок (или отменить до ответа).
    Hangup { call_id: Uuid },
}

impl CallSignal {
    pub fn call_id(&self) -> Uuid {
        match self {
            CallSignal::Invite { call_id, .. }
            | CallSignal::Answer { call_id, .. }
            | CallSignal::Reject { call_id, .. }
            | CallSignal::Ice { call_id, .. }
            | CallSignal::Hangup { call_id, .. } => *call_id,
        }
    }
}

/// Конверт сигнала: кому адресован.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallSignalPayload {
    pub to: String,
    pub signal: CallSignal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallRecord {
    pub call_id: Uuid,
    pub caller: String,
    pub callee: String,
    pub media: CallMedia,
    /// ringing | answered | ended | missed | rejected
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallHistoryRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallHistoryResponse {
    pub calls: Vec<CallRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_content_kind_names() {
        let v = MessageContent::Voice {
            file_id: Uuid::nil(),
            duration_secs: 3,
            mime: "audio/ogg".into(),
            size_bytes: 100,
        };
        assert_eq!(v.kind(), "voice");

        // round-trip через JSON с тегом kind
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"kind\":\"voice\""));
        let back: MessageContent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn call_inbox_subject() {
        assert_eq!(topics::call_inbox("bob@local"), "call.user.bob@local");
    }

    #[test]
    fn call_signal_carries_call_id() {
        let id = Uuid::now_v7();
        let sig = CallSignal::Ice { call_id: id, candidate: "cand".into() };
        assert_eq!(sig.call_id(), id);
        // round-trip
        let json = serde_json::to_string(&sig).unwrap();
        assert!(json.contains("\"type\":\"ice\""));
    }

    #[test]
    fn stamp_orders_by_ts_then_site() {
        let a = Stamp { ts: 10, site: "z".into() };
        let b = Stamp { ts: 20, site: "a".into() };
        assert!(a < b, "ts доминирует");
        let c = Stamp { ts: 5, site: "a".into() };
        let d = Stamp { ts: 5, site: "b".into() };
        assert!(c < d, "при равном ts сравнивается site");
    }

    #[test]
    fn opid_orders_by_seq_then_site() {
        let a = OpId { seq: 1, site: "z".into() };
        let b = OpId { seq: 2, site: "a".into() };
        assert!(a < b, "seq доминирует над site");

        let c = OpId { seq: 5, site: "a".into() };
        let d = OpId { seq: 5, site: "b".into() };
        assert!(c < d, "при равном seq сравнивается site");
    }

    #[test]
    fn event_roundtrip() {
        let event = ParvaneEvent {
            id: Uuid::nil(),
            from: "alice@local".to_string(),
            ts: 1_000_000,
            token: "tok".to_string(),
            payload: SendPayload {
                to: "bob@local".to_string(),
                content: MessageContent::Text { text: "hi".to_string() },
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        let decoded: ParvaneEvent<SendPayload> = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.from, "alice@local");
        assert_eq!(decoded.payload.content, MessageContent::Text { text: "hi".to_string() });
    }

    #[test]
    fn topics_are_correct_format() {
        use topics::*;
        for topic in [IDENTITY_ISSUE, IDENTITY_VERIFY, MSG_SEND, MSG_DELIVERED,
                      MSG_READ, MSG_SYNC_REQUEST, MSG_SYNC_RESPONSE] {
            assert!(topic.contains('.'), "топик '{topic}' должен содержать точку");
        }
    }
}
