-- Хранилище каркаса доменов протокола v2 (spec 007, T091, R11). Отдельный
-- файл БД `<PARVANE_DB_PATH>-v2.db` (contracts/migration.md «Хранение v2»).
-- Содержимое операций и снимков — только шифртекст (AEAD ключа эпохи);
-- сервер видит, кто с кем делится (гранты), но не что внутри.

-- Контейнер: ссылка (id; домен ссылки — домен этого сервера), схема домена,
-- владелец, текущая эпоха ключа, голова журналов, генезис как прислали.
CREATE TABLE containers (
    id            BLOB    PRIMARY KEY,
    domain        TEXT    NOT NULL,
    owner         TEXT    NOT NULL,
    key_epoch     INTEGER NOT NULL,
    grant_version INTEGER NOT NULL DEFAULT 0,
    head_seq      INTEGER NOT NULL DEFAULT 0,
    genesis       BLOB    NOT NULL,
    genesis_key   BLOB    NOT NULL,
    created_at    INTEGER NOT NULL
);
CREATE INDEX containers_owner ON containers (owner);

-- Журнал операций контейнера: курсор клиента = seq; op_id уникален на журнал.
CREATE TABLE container_log (
    container BLOB    NOT NULL,
    seq       INTEGER NOT NULL,
    op_id     BLOB    NOT NULL,
    key_epoch INTEGER NOT NULL,
    op        BLOB    NOT NULL,
    at        INTEGER NOT NULL,
    PRIMARY KEY (container, seq),
    UNIQUE (container, op_id)
);

-- Журнал грантов (хэш-цепочка от генезиса; записи — как прислали) и
-- подписант каждой записи, определённый при приёме (для повторной проверки
-- цепочки движком без обращения к identity).
CREATE TABLE container_grant_log (
    container   BLOB    NOT NULL,
    version     INTEGER NOT NULL,
    entry       BLOB    NOT NULL,
    signer_key  BLOB    NOT NULL,
    signer_user TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    PRIMARY KEY (container, version)
);

-- Производные действующие гранты (перестраиваются из журнала грантов).
-- kind: 0 — пользователь (grantee = адрес), 1 — группа (grantee = hex id группы).
CREATE TABLE container_grants (
    container BLOB    NOT NULL,
    kind      INTEGER NOT NULL,
    grantee   TEXT    NOT NULL,
    level     INTEGER NOT NULL,
    PRIMARY KEY (container, kind, grantee)
);
CREATE INDEX container_grants_grantee ON container_grants (kind, grantee);

-- Последний снимок контейнера (compaction), пишет клиент.
CREATE TABLE container_snapshots (
    container BLOB    PRIMARY KEY,
    upto_seq  INTEGER NOT NULL,
    key_epoch INTEGER NOT NULL,
    snapshot  BLOB    NOT NULL,
    at        INTEGER NOT NULL
);
