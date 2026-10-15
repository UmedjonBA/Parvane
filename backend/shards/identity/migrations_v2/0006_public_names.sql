-- Публичные имена групп (spec 023): общее пространство с никами пользователей. Имя — в нижнем регистре; владелец —
-- id группы. Пользовательские ники живут в таблице users v1-хранилища, сверка — в коде.
CREATE TABLE public_names (
    name       TEXT    PRIMARY KEY,
    owner      BLOB    NOT NULL,
    claimed_at INTEGER NOT NULL
);

CREATE INDEX idx_public_names_owner ON public_names(owner);
