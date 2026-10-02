-- Хранилище протокола v2 messenger (spec 007, T043). Отдельный файл БД
-- `<PARVANE_DB_PATH>-v2.db`: v1-таблицы и миграции не меняются, откат
-- бинарника E1 → v1 безопасен (contracts/migration.md «Хранение v2»).

-- Журнал инбокса устройства: одна запись = одно событие, курсор клиента = seq.
-- device — токен subject'а журнала (hex SHA-256 адреса и device_id).
-- Отправитель не хранится (класс 11).
CREATE TABLE inbox_log (
    device      TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    item        BLOB    NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (device, seq)
);

-- Счётчик seq (монотонный, не переиспользуется после удаления записей) и
-- подтверждённый курсор; флаг догона v1-истории.
CREATE TABLE inbox_device (
    device     TEXT PRIMARY KEY,
    next_seq   INTEGER NOT NULL DEFAULT 0,
    acked_seq  INTEGER NOT NULL DEFAULT 0,
    backfilled INTEGER NOT NULL DEFAULT 0
);

-- v1-сообщения, созданные легаси-копией v2-отправителя: в журналы v2-устройств
-- не мостятся (они уже получили sealed-версию).
CREATE TABLE legacy_origin (
    message_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

-- Потраченные слепые жетоны (атомарная трата, повтор → DUPLICATE).
CREATE TABLE spent_tokens (
    spent_id BLOB PRIMARY KEY,
    key_id   BLOB    NOT NULL,
    at       INTEGER NOT NULL
);

-- Журнал состояния группы (записи — как прислали, подписи проверяет движок).
CREATE TABLE group_state_log (
    group_id BLOB    NOT NULL,
    version  INTEGER NOT NULL,
    entry    BLOB    NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (group_id, version)
);

-- Производный состав группы для рассылки (перестраивается из журнала).
CREATE TABLE group_members_v2 (
    group_id BLOB NOT NULL,
    member   TEXT NOT NULL,
    PRIMARY KEY (group_id, member)
);
CREATE INDEX group_members_v2_member ON group_members_v2 (member);

-- Заявки на вступление по ссылке с одобрением.
CREATE TABLE group_join_requests_v2 (
    group_id     BLOB    NOT NULL,
    user         TEXT    NOT NULL,
    link_id      BLOB    NOT NULL,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user)
);

-- Повтор группового конверта (D-07): (группа, эпоха, nonce) уникальны.
CREATE TABLE group_envelope_nonce (
    group_id BLOB    NOT NULL,
    epoch    INTEGER NOT NULL,
    nonce    BLOB    NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (group_id, epoch, nonce)
);

-- Журнал личного состояния пользователя (R10): только шифртекст.
CREATE TABLE user_state_log (
    user   TEXT    NOT NULL,
    seq    INTEGER NOT NULL,
    op_id  BLOB    NOT NULL,
    record BLOB    NOT NULL,
    at     INTEGER NOT NULL,
    PRIMARY KEY (user, seq),
    UNIQUE (user, op_id)
);
