use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod nats;
pub mod topic_contract;

// ── топики ───────────────────────────────────────────────────────────────────

pub mod topics {
    pub const IDENTITY_VERIFY: &str = "identity.token.verify";
    /// Публичные параметры сервера для экрана входа (pre-auth): домен адресов
    /// (ник без `@` дополняется до `ник@домен`) и нужна ли почта при регистрации.
    pub const IDENTITY_SERVER_INFO: &str = "identity.server.info";

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
    /// Устройство, для которого выдаётся JWT (claim `dev`): после отзыва
    /// устройства его токены отклоняются на verify сразу, а не через 24 ч.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// Двухфакторный вход: токен входа, уже подтверждённый в Telegram
    /// (identity.telegram.confirm) — с ним issue выдаёт JWT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_token: Option<String>,
    /// Секрет доверия устройства (2FA): выдан identity после подтверждённого
    /// входа в Telegram; с ним доверенное устройство входит без Telegram.
    /// Раньше доверие висело на голом device_id, который каталог отдаёт
    /// любому — второй фактор обходился при известном пароле.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_secret: Option<String>,
    /// Как устройство называет себя («Firefox, Linux») — подпись на экране
    /// «Устройства» у владельца; ни на что больше не влияет.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// IP клиента — подставляет gateway (X-Forwarded-For за прокси / пир);
    /// клиентское значение перезаписывается. Для лимитов по источнику.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueResponse {
    pub ok: bool,
    pub token: Option<String>,
    pub error: Option<String>,
    /// Пароль верен, но включён двухфакторный вход: нужно подтверждение в
    /// привязанном Telegram по deep link t.me/<bot>?start=<login_token>.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub twofa_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_bot: Option<String>,
    /// Новый секрет доверия (только после подтверждённого 2FA-входа) — клиент
    /// сохраняет и предъявляет при следующих issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_secret: Option<String>,
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
    /// Почта для подтверждения регистрации. Обязательна при
    /// PARVANE_EMAIL_REQUIRED=1; иначе опциональна (просто сохраняется).
    #[serde(default)]
    pub email: String,
    /// IP клиента от gateway (см. IssueRequest::client_ip).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterResponse {
    pub ok: bool,
    pub error: Option<String>,
    /// true — аккаунт создан, но ждёт подтверждения (код с почты через
    /// identity.email.confirm или Telegram-бот); логин до подтверждения
    /// невозможен.
    #[serde(default)]
    pub confirm_required: bool,
    /// Режим Telegram: одноразовый токен для deep link `t.me/<bot>?start=<token>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram_token: Option<String>,
}

/// Подтверждение почты: код из письма. Повторный `register` с тем же
/// user+password до подтверждения — перевыслать код (rate-limited).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailConfirmRequest {
    pub user: String,
    pub code: String,
    /// Подмешивает gateway (pre-auth) для IP-лимита; клиентское значение перезаписывается.
    #[serde(default)]
    pub client_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailConfirmResponse {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// Запрос публичных параметров сервера (тело пустое, поля зарезервированы).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerInfoRequest {}

/// Публичные параметры сервера для клиента до логина.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfoResponse {
    /// Домен адресов этого сервера (`PARVANE_DOMAIN`): `ник` → `ник@домен`.
    pub domain: String,
    /// true — регистрация требует почту и код подтверждения (confirm = email).
    pub email_required: bool,
    /// Как подтверждается регистрация: `none` | `email` | `telegram`.
    #[serde(default)]
    pub confirm: String,
    /// Username Telegram-бота (без @) для deep link при confirm = telegram.
    #[serde(default)]
    pub telegram_bot: String,
}

/// Бот → identity: пользователь Telegram нажал Start по deep link с токеном.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfirmRequest {
    /// Общий секрет бота и identity (`PARVANE_TELEGRAM_SECRET`).
    pub secret: String,
    /// Токен из `/start <token>`.
    pub token: String,
    /// Telegram user id — один Telegram = один подтверждённый аккаунт.
    pub telegram_id: i64,
    /// Имя/username для лога (необязательно).
    #[serde(default)]
    pub telegram_name: String,
    /// Подмешивает gateway (pre-auth) для IP-лимита перебора секрета.
    #[serde(default)]
    pub client_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfirmResponse {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// Подтверждённый адрес (ник@домен) — для ответа пользователю в боте.
    #[serde(default)]
    pub user: Option<String>,
    /// Что подтверждено: "register" (аккаунт) или "login" (двухфакторный вход).
    #[serde(default)]
    pub kind: Option<String>,
}

/// Двухфакторный вход: чтение/переключение (JWT). `enabled: None` — только
/// прочитать состояние. Включить можно только при привязанном Telegram.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwoFactorRequest {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// P-07: выключение 2FA требует пароль (один украденный JWT не должен
    /// снимать второй фактор).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwoFactorResponse {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub telegram_linked: bool,
    /// При включении 2FA — секрет доверия для устройства, которое включило.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordChangeRequest {
    #[serde(default)]
    pub token: String,
    pub old_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordChangeResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Клиент опрашивает, подтверждён ли его pending-аккаунт (токен — доказательство
/// владения регистрационной сессией).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterStatusRequest {
    pub user: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterStatusResponse {
    pub confirmed: bool,
}

// ── E2E prekeys (Фаза 2, X3DH) ────────────────────────────────────────────────
// Каталог ПУБЛИЧНЫХ ключей для установления E2E-сессии. Приватные части
// НИКОГДА не покидают устройство. Сервер лишь хранит и раздаёт публичные бандлы.


/// Одно устройство аккаунта. В отличие от prekeys.fetch НЕ расходует one-time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device_id: String,
    #[serde(default)]
    pub signing_key: String,
    pub identity_key: String,
    /// Unix-время последней публикации прекеев (≈ последняя активность установки).
    pub updated_at: i64,
    /// Сколько несожжённых one-time prekey осталось (для клиентского пополнения).
    pub one_time_available: i64,
    /// Подпись устройства, названная им при входе («Firefox, Linux»).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Unix-время последнего входа с этого устройства.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_at: Option<i64>,
}


// ── Авто-линковка: передача E2E-состояния на новое устройство ────────────────
// Сервер — слепой релей эфемерных публичных ключей и запечатанного бокса;
// сам экспорт едет шифртекстом через cloud, ключи — внутри ECDH-бокса.

/// Оффер нового устройства: «передайте мне историю». Владелец — из JWT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkOfferRequest {
    pub token: String,
    pub device_id: String,
    /// base64 эфемерный публичный ключ ECDH. В протоколе v2 (P-03) сначала
    /// публикуется ТОЛЬКО commitment, а eph_pub раскрывается после challenge.
    #[serde(default)]
    pub eph_pub: String,
    /// v2: base64 SHA-256(eph_pub raw) — обязательство на ключ до раскрытия.
    #[serde(default)]
    pub commitment: String,
    /// v2: Ed25519 signing-ключ нового устройства — старое подпишет перенос
    /// владения своими исходящими (link-transfer), не отдавая приватный аккаунт.
    #[serde(default)]
    pub signing_key: String,
    /// Отзыв собственного оффера (история получена другим путём).
    #[serde(default)]
    pub revoke: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkOfferResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Опрос линковки от устройства `device_id`: в ответе — офферы ДРУГИХ
/// устройств аккаунта (роль старого устройства) и, если есть, грант для
/// самого `device_id` (роль нового; грант одноразовый — удаляется при выдаче).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPollRequest {
    pub token: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkOfferInfo {
    pub device_id: String,
    /// Пусто, пока новое устройство не раскрыло ключ (v2).
    pub eph_pub: String,
    pub created_at: i64,
    #[serde(default)]
    pub commitment: String,
    #[serde(default)]
    pub signing_key: String,
    /// Эфемерный ключ старого устройства, уже приложенный к офферу (v2).
    #[serde(default)]
    pub challenge_pub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkGrantInfo {
    pub box_payload: String, // base64 AES-GCM-бокс под ECDH-ключом
    pub eph_pub: String,     // base64 эфемерный ключ грантера
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPollResponse {
    pub ok: bool,
    #[serde(default)]
    pub offers: Vec<LinkOfferInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<LinkGrantInfo>,
    /// v2: challenge (эфемерный ключ старого устройства) к СОБСТВЕННОМУ офферу
    /// запрашивающего — сигнал раскрыть eph_pub и считать SAS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub challenge: Option<String>,
    pub error: Option<String>,
}

/// v2: старое устройство прикладывает свой эфемерный ключ к офферу целевого.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkChallengeRequest {
    #[serde(default)]
    pub token: String,
    /// ЦЕЛЕВОЕ (новое) устройство
    pub device_id: String,
    pub eph_pub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkChallengeResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Грант старого устройства: бокс для целевого устройства `device_id`.
/// Оффер целевого устройства при этом гасится.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkGrantRequest {
    pub token: String,
    pub device_id: String,   // ЦЕЛЕВОЕ (новое) устройство
    pub box_payload: String,
    pub eph_pub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkGrantResponse {
    pub ok: bool,
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
    /// «О себе» (bio). None/пусто — не задано.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    /// Дата рождения ISO `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birthday: Option<String>,
    /// Индекс цвета имени (как у Telegram peer color; бесплатно для всех).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<i64>,
    /// Личный канал (адрес/id канала), None — не задан.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_channel: Option<String>,
    /// Телефон (по желанию), None — не задан.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
}

/// Установка своего аватара: file_id уже загруженного в cloud изображения.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetAvatarRequest {
    pub token: String,
    pub file_id: String,
}


/// Поиск пользователей по подстроке имени/адреса (каталог = таблица users).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchUsersRequest {
    pub query: String,
    /// Токен запрашивающего (подставляет gateway). Пока не влияет на выдачу,
    /// но нужен для будущих настроек видимости (P-19).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
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
    /// Профильные поля (все опциональны — задаём только присланные; пустая
    /// строка очищает). Хранятся в identity, синхронизируются через resolve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birthday: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_color: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
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
    /// Токен запрашивающего (подставляет gateway): приватные поля профиля
    /// (телефон) отдаются только владельцу (P-19).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
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
    /// Устройство токена (claim `dev`); gateway v2 требует его (класс 5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

// ── messenger payloads ───────────────────────────────────────────────────────


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


/// Ответ на `preview.link.fetch`. При `ok=false` — `error` c причиной отказа.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewFetchResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webpage: Option<WebPagePreview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}


// ── управление группой (spec 003) ────────────────────────────────────────────


#[cfg(test)]
mod tests {
    use super::*;

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
            payload: VerifyRequest { token: "jwt".to_string() },
        };
        let json = serde_json::to_string(&event).unwrap();
        let decoded: ParvaneEvent<VerifyRequest> = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.from, "alice@local");
        assert_eq!(decoded.payload.token, "jwt");
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
        for topic in [IDENTITY_VERIFY, IDENTITY_SERVER_INFO, NOTE_CREATE, CAL_CREATE] {
            assert!(topic.contains('.'), "топик '{topic}' должен содержать точку");
        }
    }
}
