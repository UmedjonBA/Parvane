use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod nats;
pub mod topic_contract;

// ── топики ───────────────────────────────────────────────────────────────────

pub mod topics {
    pub const IDENTITY_ISSUE: &str = "identity.token.issue";
    pub const IDENTITY_VERIFY: &str = "identity.token.verify";
    /// Регистрация аккаунта (отдельно от логина). issue больше не создаёт юзеров.
    pub const IDENTITY_REGISTER: &str = "identity.user.register";
    /// E2E (Фаза 2): клиент публикует свою пачку публичных prekey-бандлов.
    pub const IDENTITY_PREKEYS_PUBLISH: &str = "identity.prekeys.publish";
    /// E2E: получить бандл собеседника для X3DH (одна one-time помечается consumed).
    pub const IDENTITY_PREKEYS_FETCH: &str = "identity.prekeys.fetch";
    pub const IDENTITY_SEARCH: &str = "identity.user.search";
    pub const IDENTITY_SETNAME: &str = "identity.user.setname";
    pub const IDENTITY_SETAVATAR: &str = "identity.user.setavatar";
    pub const IDENTITY_SETKEY: &str = "identity.user.setkey";
    pub const IDENTITY_RESOLVE: &str = "identity.user.resolve";

    pub const MSG_SEND: &str = "msg.chat.send";
    pub const MSG_DELIVERED: &str = "msg.chat.delivered";
    pub const MSG_READ: &str = "msg.chat.read";
    pub const MSG_EDIT: &str = "msg.chat.edit";
    pub const MSG_DELETE: &str = "msg.chat.delete";
    pub const MSG_REACT: &str = "msg.chat.react";
    pub const MSG_PIN: &str = "msg.chat.pin";
    /// Клиент подтверждает получение сообщения из своего инбокса (Фаза 1):
    /// снимает его из офлайн-очереди и сообщает отправителю о доставке.
    pub const MSG_ACK: &str = "msg.chat.ack";
    pub const MSG_SYNC_REQUEST: &str = "msg.sync.request";
    /// deprecated: не публиковать. Ответ sync идёт ТОЛЬКО в reply-inbox
    /// запросившего (иначе любой на шине читал бы чужую переписку). Оставлено,
    /// чтобы не ломать импорты.
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
    /// Выдача ICE-конфигурации (STUN + краткоживущие TURN-креды) по JWT.
    pub const CALL_ICE_REQUEST: &str = "call.ice.request";

    // Группы и каналы (request/reply на messenger-шард).
    pub const GROUP_CREATE: &str = "group.create";
    pub const GROUP_ADD_MEMBER: &str = "group.addmember";
    pub const GROUP_REMOVE_MEMBER: &str = "group.removemember";
    pub const GROUP_SET_ROLE: &str = "group.setrole";
    pub const GROUP_LIST: &str = "group.list";
    pub const GROUP_INFO: &str = "group.info";
    pub const GROUP_BAN: &str = "group.ban";
    pub const GROUP_UNBAN: &str = "group.unban";
    pub const GROUP_MUTE: &str = "group.mute";
    pub const GROUP_INVITE_CREATE: &str = "group.invite.create";
    pub const GROUP_JOIN: &str = "group.join";
    pub const GROUP_RENAME: &str = "group.rename";
    pub const GROUP_DELETE: &str = "group.delete";

    /// Превью ссылки: клиент-отправитель просит OG-метаданные по URL, наружу
    /// ходит шард (не браузер), с SSRF-защитой.
    pub const PREVIEW_FETCH: &str = "preview.link.fetch";

    /// Web-push: публичный VAPID-ключ для pushManager.subscribe.
    pub const PUSH_VAPID_GET: &str = "push.vapid.get";
    /// Web-push: регистрация подписки устройства (JWT в конверте).
    pub const PUSH_REGISTER: &str = "push.device.register";
    /// Web-push: снятие подписки (endpoint или все подписки пользователя).
    pub const PUSH_UNREGISTER: &str = "push.device.unregister";

    /// Wildcard входящих инбоксов — на него подписан push-шард, чтобы будить
    /// офлайн-устройства web-push'ем. Контента в инбоксе он не понимает
    /// (sealed sender) и не разбирает — только факт доставки.
    pub const MSG_USER_WILDCARD: &str = "msg.user.>";

    /// Персональный инбокс пользователя для входящих сигналов звонка.
    /// Получатель подписывается на этот же точный субъект (`@` в субъекте NATS
    /// допустим). Например: `call.user.bob@local`.
    pub fn call_inbox(user: &str) -> String {
        format!("call.user.{user}")
    }

    /// Персональный инбокс пользователя для входящих сообщений и уведомлений
    /// (delivered/receipts). Получатель подписывается на точный субъект.
    /// Пример: `msg.user.alice@local`. Изоляция «людей» — на gateway.
    pub fn msg_inbox(user: &str) -> String {
        format!("msg.user.{user}")
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

/// Регистрация нового аккаунта. Отделена от логина (`issue`), чтобы `issue` не
/// создавал пользователей молча. `invite` — код приглашения для закрытого
/// пузыря (пусто — открытая регистрация, если не требуется инвайт).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub invite: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub ok: bool,
    pub error: Option<String>,
}

// ── E2E prekeys (Фаза 2, X3DH) ────────────────────────────────────────────────
// Каталог ПУБЛИЧНЫХ ключей для установления E2E-сессии. Приватные части
// НИКОГДА не покидают устройство. Сервер лишь хранит и раздаёт публичные бандлы.

/// Одна одноразовая (one-time) prekey: пара (id, публичный ключ).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneTimePrekey {
    pub key_id: i64,
    pub public_key: String, // base64
}

/// Публикация своей пачки prekey-бандлов. `one_time` — пачка одноразовых
/// (напр. 100); signed prekey и identity — долгоживущие.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishPrekeysRequest {
    pub token: String,
    pub registration_id: i64,
    pub identity_key: String,     // base64 публичный identity-ключ
    pub signed_prekey_id: i64,
    pub signed_prekey: String,    // base64 публичный
    pub signed_prekey_sig: String, // base64 подпись signed prekey identity-ключом
    #[serde(default)]
    pub one_time: Vec<OneTimePrekey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishPrekeysResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Запрос бандла собеседника для X3DH.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchBundleRequest {
    pub token: String,
    pub user: String,
}

/// Бандл собеседника. `one_time*` = None, если одноразовые кончились (X3DH без
/// one-time — стандартный фолбэк, чуть слабее forward secrecy для 1-го сообщения).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchBundleResponse {
    pub ok: bool,
    pub registration_id: Option<i64>,
    pub identity_key: Option<String>,
    pub signed_prekey_id: Option<i64>,
    pub signed_prekey: Option<String>,
    pub signed_prekey_sig: Option<String>,
    pub one_time_id: Option<i64>,
    pub one_time: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyRequest {
    pub token: String,
}

/// Публичная карточка пользователя: уникальный `username` (адрес, для поиска)
/// и отображаемое `display_name` (которое юзер задаёт; по умолчанию — локальная
/// часть адреса).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub username: String,
    pub display_name: String,
    /// file_id аватара в шарде cloud (None — нет фото, показываем инициалы).
    #[serde(default)]
    pub avatar: Option<String>,
    /// Публичный Ed25519-ключ пользователя (base64), для аутентификации
    /// сигналинга звонков. None — юзер ещё не зарегистрировал ключ.
    #[serde(default)]
    pub pubkey: Option<String>,
}

/// Установка своего аватара: file_id уже загруженного в cloud изображения.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetAvatarRequest {
    pub token: String,
    pub file_id: String,
}

/// Регистрация СВОЕГО публичного Ed25519-ключа (base64) в каталоге identity.
/// Приватный ключ остаётся на устройстве. Нужен для подписи SDP в звонках.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetKeyRequest {
    pub token: String,
    pub pubkey: String,
}

/// Поиск пользователей по подстроке имени/адреса (каталог = таблица users).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchUsersRequest {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchUsersResponse {
    pub users: Vec<UserInfo>,
}

/// Смена своего отображаемого имени (нужен валидный токен — берём username из sub).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetNameRequest {
    pub token: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetNameResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Резолв отображаемых имён по известным адресам (для пиров из sync).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveRequest {
    pub usernames: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveResponse {
    pub users: Vec<UserInfo>,
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
        /// Форматирование (жирный/курсив/код/…). offset/length в UTF-16, как у
        /// Telegram. Пусто = обычный текст. Клиент кладёт/читает через content.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        entities: Vec<TextEntity>,
        /// Превью первой ссылки (OG-метаданные). Генерирует отправитель, чтобы
        /// шина/получатель не ходили во внешний URL. None — без превью.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        webpage: Option<WebPagePreview>,
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
    /// E2E-зашифрованное содержимое (Фаза 2). Реальный MessageContent
    /// (текст/медиа) зашифрован Olm-сессией — сервер видит только это.
    /// `sender_identity` — Curve25519 identity отправителя (нужен получателю для
    /// установления inbound-сессии). base64 — unpadded (vodozemac).
    Encrypted {
        ciphertext: String,
        ctype: u32,
        sender_identity: String,
        /// Ed25519 identity used only to authorize later mutations without
        /// revealing the account address in the sealed envelope.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        sender_signing_key: String,
    },
    /// E2E-зашифрованное групповое сообщение (Фаза 3, Megolm/sender keys).
    /// Контент зашифрован исходящей group-сессией отправителя; получатель
    /// расшифровывает входящей сессией, установленной из SKDM. `group` —
    /// адрес группы, `sender_identity` — Curve25519 отправителя (ключ входящей
    /// сессии). Раздача session_key идёт отдельно, 1-на-1 (Encrypted, kind=skdm).
    GroupEncrypted {
        ciphertext: String,
        group: String,
        sender_identity: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        sender_signing_key: String,
    },
}

/// Превью ссылки (Open Graph). Заполняет отправитель.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebPagePreview {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Один фрагмент форматирования текста (Telegram-совместимо).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TextEntity {
    /// bold/italic/underline/strike/code/pre/blockquote/spoiler/text_url/…
    #[serde(rename = "type")]
    pub kind: String,
    pub offset: i32,
    pub length: i32,
    /// URL для text_url, язык для pre.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
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
            MessageContent::Encrypted { .. } => "encrypted",
            MessageContent::GroupEncrypted { .. } => "group_encrypted",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendPayload {
    pub to: String,
    pub content: MessageContent,
    /// Если сообщение — ответ на другое, здесь его `id`. `None` — обычное.
    #[serde(default)]
    pub reply_to: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveredPayload {
    pub message_id: Uuid,
}

/// Пуш нового/изменённого сообщения в персональный инбокс получателя (Фаза 1).
/// Клиент вставляет напрямую (дедуп по id); sync — только догон/фолбэк.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxPush {
    pub message: StoredMessage,
}

/// Подтверждение получения сообщения получателем (снимает из офлайн-очереди).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AckPayload {
    pub message_id: Uuid,
    /// Sealed sender: у сообщения нет открытого `from`, поэтому получатель,
    /// расшифровав, сам указывает адрес отправителя — куда слать delivered.
    /// Пусто — обычный путь (delivered по messages.from_user).
    #[serde(default)]
    pub sender: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadPayload {
    pub message_id: Uuid,
}

/// Редактирование уже отправленного текстового сообщения. Только автор.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPayload {
    pub message_id: Uuid,
    /// Legacy non-E2E edit payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Replacement E2E envelope. The server never receives edited plaintext.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<MessageContent>,
    /// Ed25519 signature over `edit:<message_id>:<ciphertext>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Удаление сообщения «у всех» (tombstone). Только автор.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletePayload {
    pub message_id: Uuid,
    /// Ed25519 signature over `delete:<message_id>` for sealed messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Реакция на сообщение. Пустой `emoji` — снять свою реакцию.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactPayload {
    pub message_id: Uuid,
    pub emoji: String,
    /// Ed25519 signature over `react:<message_id>:<emoji>` for sealed senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Закрепить/открепить сообщение: любой участник 1-на-1, owner/admin в группе.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinPayload {
    pub message_id: Uuid,
    pub pin: bool,
    /// Ed25519 signature over `pin:<message_id>:<pin>` for sealed senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequestPayload {
    pub last_seen_id: String,
    /// Курсор по мутациям: вернуть также сообщения с `updated_at > since_updated`
    /// (правки, удаления, отметки о прочтении старых сообщений). `0` — отдать всё.
    #[serde(default)]
    pub since_updated: i64,
    /// Public identity used to recover the caller's own sealed envelopes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_signing_key: Option<String>,
    /// Ed25519 signature over `sync:<last_seen_id>:<since_updated>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
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
    /// `id` сообщения, на которое это — ответ.
    #[serde(default)]
    pub reply_to: Option<Uuid>,
    /// Текст был отредактирован автором.
    #[serde(default)]
    pub edited: bool,
    /// Удалено «у всех» — клиент рисует плейсхолдер вместо содержимого.
    #[serde(default)]
    pub deleted: bool,
    /// Прочитано получателем (есть read-receipt от `to`). Для галочки ✓✓.
    #[serde(default)]
    pub read: bool,
    /// Время последней мутации (создание/правка/удаление/прочтение/реакция).
    #[serde(default)]
    pub updated_at: i64,
    /// Реакции на сообщение (агрегат по эмодзи).
    #[serde(default)]
    pub reactions: Vec<ReactionCount>,
    /// Закреплено в диалоге.
    #[serde(default)]
    pub pinned: bool,
}

/// Агрегат реакции: эмодзи, сколько всего, реагировал ли запросивший (`mine`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionCount {
    pub emoji: String,
    pub count: i64,
    #[serde(default)]
    pub mine: bool,
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
    /// Пользователи, которым владелец явно выдаёт право скачивания.
    #[serde(default)]
    pub recipients: Vec<String>,
    /// Публичные объекты (например, avatar) доступны любому авторизованному пользователю.
    #[serde(default)]
    pub public_access: bool,
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
    /// Заменить весь текст заметки целиком. Клиент — источник истины для тела
    /// (local-first): шард сносит все существующие RGA-узлы и пересобирает их
    /// из `text`. Делает сохранение детерминированным независимо от того, что
    /// у клиента в кеше, и исключает задвоение текста.
    Replace { text: String },
}

/// Стабильная контрольная сумма содержимого заметки (FNV-1a, 64 бита).
/// Считается одинаково на шарде и в клиенте — основа diff-синхронизации: клиент
/// шлёт манифест `{id → checksum}`, шард возвращает только то, что разошлось.
pub fn content_checksum(title: &str, body: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in title.bytes().chain(std::iter::once(0u8)).chain(body.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
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
    /// Новый заголовок, если изменился. `None` — заголовок не трогаем.
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDeletePayload {
    pub note_id: Uuid,
}

/// Манифест клиента: `note_id → checksum` того, что уже есть локально.
/// Пустой (`known` отсутствует/пуст) — полная синхронизация (новое устройство).
/// Иначе шард вернёт только разошедшиеся заметки и tombstone'ы удалённых.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NoteSyncRequestPayload {
    #[serde(default)]
    pub known: std::collections::BTreeMap<String, u64>,
}

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
    /// Контрольная сумма `content_checksum(title, text)`. `0` для старых
    /// снапшотов без поля — клиент пересчитает сам.
    #[serde(default)]
    pub checksum: u64,
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

/// Манифест клиента для diff-синхронизации календаря (как у заметок).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CalSyncRequestPayload {
    #[serde(default)]
    pub known: std::collections::BTreeMap<String, u64>,
}

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
    /// `event_checksum(...)`. `0` для старых снапшотов — пересчитывается.
    #[serde(default)]
    pub checksum: u64,
}

/// Стабильная контрольная сумма наблюдаемого состояния события (поля + штампы +
/// флаг удаления). Считается одинаково на шарде и в клиенте.
pub fn event_checksum(ev: &CalEventSnapshot) -> u64 {
    let mut buf = String::new();
    buf.push_str(if ev.deleted { "D1" } else { "D0" });
    if let Some(s) = &ev.deleted_stamp {
        buf.push_str(&format!(";{}:{}", s.ts, s.site));
    }
    for (k, f) in &ev.fields {
        buf.push('\u{1}');
        buf.push_str(k);
        buf.push('\u{2}');
        buf.push_str(&f.value);
        buf.push('\u{3}');
        buf.push_str(&f.stamp.ts.to_string());
        buf.push(':');
        buf.push_str(&f.stamp.site);
    }
    content_checksum("", &buf)
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
    /// Приглашение: SDP-offer вызывающего. `sig` — base64 Ed25519-подпись SDP
    /// ключом инициатора (аутентификация против MITM; шард лишь релеит, не
    /// проверяет). Пусто, если клиент не подписывает.
    Invite {
        call_id: Uuid,
        media: CallMedia,
        sdp: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        sig: String,
    },
    /// Ответ: SDP-answer вызываемого (`sig` — подпись как в Invite).
    Answer {
        call_id: Uuid,
        sdp: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        sig: String,
    },
    /// Отклонить вызов.
    Reject { call_id: Uuid, reason: Option<String> },
    /// ICE-кандидат (обмен сетевыми путями).
    Ice { call_id: Uuid, candidate: String },
    /// Завершить звонок (или отменить до ответа).
    Hangup { call_id: Uuid },
    /// Приглашение в ГРУППОВОЙ звонок (mesh): id звонка + полный список
    /// участников. Шард только релеит его каждому; сами P2P-соединения идут
    /// отдельными Invite/Answer между парами. group_call_id — произвольная строка.
    GroupInvite {
        group_call_id: String,
        #[serde(default)]
        participants: Vec<String>,
        #[serde(default)]
        media: String,
    },
}

impl CallSignal {
    pub fn call_id(&self) -> Uuid {
        match self {
            CallSignal::Invite { call_id, .. }
            | CallSignal::Answer { call_id, .. }
            | CallSignal::Reject { call_id, .. }
            | CallSignal::Ice { call_id, .. }
            | CallSignal::Hangup { call_id, .. } => *call_id,
            CallSignal::GroupInvite { .. } => Uuid::nil(),
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
    /// Pairwise-запись группового mesh-звонка (`to` шёл с префиксом `gcall:`).
    #[serde(default)]
    pub is_group: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallHistoryRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallHistoryResponse {
    pub calls: Vec<CallRecord>,
}

/// Один ICE-сервер в формате RTCIceServer (username/credential — только TURN).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// Ответ на `call.ice.request`: STUN + краткоживущие TURN-креды (TURN REST,
/// username = `<expiry>:<user>`, credential = base64(HMAC-SHA1(secret, username))).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServersResponse {
    pub ice_servers: Vec<IceServer>,
    /// Сколько секунд клиент может кэшировать выданные креды.
    pub ttl_secs: u64,
}

// ── группы и каналы ───────────────────────────────────────────────────────────

/// Тип объединения: группа (все участники пишут) или канал (пишут owner/admin).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    Group,
    Channel,
}

impl Default for GroupKind {
    fn default() -> Self {
        GroupKind::Group
    }
}

/// Создать группу/канал. Создатель становится owner; `members` — начальные
/// участники (создатель добавляется автоматически).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCreateRequest {
    pub token: String,
    pub name: String,
    #[serde(default)]
    pub kind: GroupKind,
    #[serde(default)]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCreateResponse {
    pub ok: bool,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Добавить/удалить участника (только owner/admin). Для «выйти» — member == себя.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMemberRequest {
    pub token: String,
    pub group_id: String,
    pub member: String,
}

/// Сменить роль участника (только owner): `role` = "admin" | "member".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupSetRoleRequest {
    pub token: String,
    pub group_id: String,
    pub member: String,
    pub role: String,
}

/// Переименовать группу (owner/admin).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupRenameRequest {
    pub token: String,
    pub group_id: String,
    pub name: String,
}

/// Удалить группу со всеми участниками и инвайтами (только owner).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDeleteRequest {
    pub token: String,
    pub group_id: String,
}

/// Запрос превью ссылки (наружу ходит шард preview, не клиент). Токен идёт в
/// конверте `ParvaneEvent` (его подставляет gateway), в payload — только url.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewFetchRequest {
    #[serde(default)]
    pub token: String,
    pub url: String,
}

/// Ответ на `preview.link.fetch`. При `ok=false` — `error` c причиной отказа.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewFetchResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webpage: Option<WebPagePreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Подписка web-push (как её отдаёт `PushSubscription.toJSON()` браузера).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscriptionInfo {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Запрос `push.device.register`. Токен подставляет gateway (как у превью).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRegisterRequest {
    #[serde(default)]
    pub token: String,
    pub subscription: PushSubscriptionInfo,
}

/// Запрос `push.device.unregister`; без `endpoint` — снять все подписки юзера.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushUnregisterRequest {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub endpoint: Option<String>,
}

/// Ответ `push.vapid.get`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushVapidResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupActionResponse {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// Замьютить участника до unix-времени `until` (0 — снять мьют).
/// Только owner/admin; owner мьютить нельзя.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMuteRequest {
    pub token: String,
    pub group_id: String,
    pub member: String,
    pub until: i64,
}

/// Создать инвайт-ссылку (owner/admin). Ответ несёт token ссылки.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInviteCreateRequest {
    pub token: String,
    pub group_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInviteCreateResponse {
    pub ok: bool,
    #[serde(default)]
    pub invite: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Вступить в группу по инвайт-токену.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupJoinRequest {
    pub token: String,
    pub invite: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupJoinResponse {
    pub ok: bool,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Сведения о группе: имя, тип, создатель, участники (с ролями).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    pub group_id: String,
    pub name: String,
    pub kind: GroupKind,
    pub created_by: String,
    pub members: Vec<GroupMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMember {
    pub address: String,
    pub role: String,
}

/// Список групп/каналов, где состоит пользователь.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupListRequest {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupListResponse {
    pub groups: Vec<GroupInfo>,
}

/// Сведения об одной группе (участники и т.п.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfoRequest {
    pub token: String,
    pub group_id: String,
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
                content: MessageContent::Text { text: "hi".to_string(), entities: vec![], webpage: None },
                reply_to: None,
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        let decoded: ParvaneEvent<SendPayload> = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.from, "alice@local");
        assert_eq!(decoded.payload.content, MessageContent::Text { text: "hi".to_string(), entities: vec![], webpage: None });
    }

    #[test]
    fn upload_complete_acl_fields_default_for_legacy_clients() {
        let payload: UploadCompletePayload = serde_json::from_value(serde_json::json!({
            "file_id": Uuid::nil(),
            "filename": "legacy.bin",
            "total_chunks": 1,
            "size_bytes": 4,
            "mime_type": "application/octet-stream"
        }))
        .unwrap();

        assert!(payload.recipients.is_empty());
        assert!(!payload.public_access);
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
