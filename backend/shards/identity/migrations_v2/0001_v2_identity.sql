-- Хранилище протокола v2 identity (spec 007, T047/T119/T071). Отдельный файл
-- БД `<PARVANE_DB_PATH>-v2.db`: v1-файл и его миграции не меняются, откат
-- бинарника E1 → v1 безопасен (contracts/migration.md «Хранение v2»).

-- Журнал устройств пользователя: хэш-цепочка записей (SignedOp), подписанных
-- SSK/корнем. Сервер только хранит и проверяет цепочку тем же движком, что и
-- клиенты; источник истины — подписи.
CREATE TABLE device_log (
    user       TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    entry      BLOB    NOT NULL,
    hash       BLOB    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user, version)
);

-- Прежние журналы после смены корня (KEY-1: собеседники видят предупреждение).
CREATE TABLE device_log_archive (
    user        TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    entry       BLOB    NOT NULL,
    archived_at INTEGER NOT NULL
);

-- Производное состояние журнала для быстрых выборок (перестраивается из журнала).
CREATE TABLE device_state (
    user        TEXT    NOT NULL,
    device_id   TEXT    NOT NULL,
    cert        BLOB    NOT NULL,
    serial      INTEGER NOT NULL,
    proto_major INTEGER NOT NULL,
    proto_minor INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    -- Ключ подписи устройства (olm_ed25519) — поиск владельца ключа.
    ed25519     BLOB,
    PRIMARY KEY (user, device_id)
);
CREATE INDEX device_state_ed25519 ON device_state (ed25519);

-- Одноразовые прекеи v2 (подписаны ключом устройства); выдаются атомарно.
CREATE TABLE one_time_keys (
    user      TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key_id    BLOB NOT NULL,
    curve     BLOB NOT NULL,
    signature BLOB NOT NULL,
    PRIMARY KEY (user, device_id, key_id)
);

CREATE TABLE fallback_keys (
    user      TEXT NOT NULL,
    device_id TEXT NOT NULL,
    key_id    BLOB NOT NULL,
    curve     BLOB NOT NULL,
    signature BLOB NOT NULL,
    PRIMARY KEY (user, device_id)
);

-- Ключ доступа к доставке: только SHA-256 (R7).
CREATE TABLE delivery_keys (
    user       TEXT PRIMARY KEY,
    key_hash   BLOB    NOT NULL,
    rotated_at INTEGER NOT NULL
);

-- Явные серверные поля приватности (FR-040).
CREATE TABLE privacy (
    user                    TEXT PRIMARY KEY,
    group_add               INTEGER NOT NULL DEFAULT 1,
    messages_from_strangers INTEGER NOT NULL DEFAULT 1,
    calls_from              INTEGER NOT NULL DEFAULT 1,
    presence_visibility     INTEGER NOT NULL DEFAULT 1
);

-- Выдача слепых жетонов: ≤ 50 в сутки на аккаунт (R7).
CREATE TABLE token_issuance (
    user  TEXT    NOT NULL,
    day   INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (user, day)
);
