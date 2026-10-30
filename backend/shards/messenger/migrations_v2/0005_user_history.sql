-- Журнал истории аккаунта (spec 033; HIST-1, HIST-2, READ-2): только шифртекст записей (AEAD на ключе истории,
-- выведенном из ключа личного состояния). `chunk = 1` — сегмент или сводка контрольной точки.
CREATE TABLE user_history_log (
    user   TEXT    NOT NULL,
    seq    INTEGER NOT NULL,
    op_id  BLOB    NOT NULL,
    record BLOB    NOT NULL,
    chunk  INTEGER NOT NULL DEFAULT 0,
    at     INTEGER NOT NULL,
    PRIMARY KEY (user, seq),
    UNIQUE (user, op_id)
);

-- Счётчик seq (монотонный, не переиспользуется и после обрезки по точке) и учёт объёма для лимитов
-- (PARVANE_HISTORY_MAX_RECORDS / PARVANE_HISTORY_MAX_BYTES).
CREATE TABLE user_history_head (
    user     TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 0,
    records  INTEGER NOT NULL DEFAULT 0,
    bytes    INTEGER NOT NULL DEFAULT 0
);

-- Текущая контрольная точка пользователя: записи журнала seq ≤ upto_seq свёрнуты в сегменты chunk_seqs
-- (упакованные u64 big-endian) и сводку summary_seq.
CREATE TABLE user_history_checkpoint (
    user        TEXT    PRIMARY KEY,
    id          INTEGER NOT NULL,
    upto_seq    INTEGER NOT NULL,
    summary_seq INTEGER NOT NULL,
    chunk_seqs  BLOB    NOT NULL,
    created_ms  INTEGER NOT NULL
);
