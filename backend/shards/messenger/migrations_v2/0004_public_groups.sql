-- Публичные группы (spec 023). Каталог — из состояния журнала группы (открытые сведения и открытый секрет `S` по
-- решению пользователя 15 окт 2026); конверты публичных групп хранятся для истории и чтения без вступления.
CREATE TABLE public_groups (
    group_id       BLOB    PRIMARY KEY,
    name           TEXT    NOT NULL UNIQUE,
    kind           INTEGER NOT NULL,
    title          TEXT    NOT NULL,
    title_norm     TEXT    NOT NULL,
    about          TEXT    NOT NULL,
    avatar_file_id TEXT    NOT NULL,
    members        INTEGER NOT NULL,
    preview        INTEGER NOT NULL,
    history        INTEGER NOT NULL,
    secret         BLOB    NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE public_group_messages (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id BLOB    NOT NULL,
    envelope BLOB    NOT NULL,
    at       INTEGER NOT NULL
);
CREATE INDEX idx_public_messages_group ON public_group_messages(group_id, seq);

-- С какого сообщения участник видит переписку без настройки «История для новых участников».
CREATE TABLE public_join_points (
    group_id BLOB    NOT NULL,
    user     TEXT    NOT NULL,
    seq      INTEGER NOT NULL,
    PRIMARY KEY (group_id, user)
);
