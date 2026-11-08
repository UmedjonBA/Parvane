-- spec 035 (FR-063, T035): журнал личного состояния v2 (`state.ops.append` / `state.ops.sync`). Как
-- `user_state_log`: только op_id и шифртекст записи (`StateOp` пакета parvane.state.v2 под ключом личного
-- состояния), seq на пользователя монотонный и не переиспользуется, повтор op_id с тем же шифртекстом — прежний
-- seq, с другим — DUPLICATE. Прежний журнал `user_state_log` с этого выпуска только читается (`state.append` →
-- UPGRADE_REQUIRED); удаляется вручную по решению пользователя (D2).
CREATE TABLE user_state_log_v2 (
    user   TEXT    NOT NULL,
    seq    INTEGER NOT NULL,
    op_id  BLOB    NOT NULL,
    record BLOB    NOT NULL,
    at     INTEGER NOT NULL,
    PRIMARY KEY (user, seq),
    UNIQUE (user, op_id)
);

-- Голова журнала v2: счётчик seq и учёт объёма для лимитов (PARVANE_STATE_MAX_RECORDS / _BYTES).
CREATE TABLE user_state_head_v2 (
    user     TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 0,
    records  INTEGER NOT NULL DEFAULT 0,
    bytes    INTEGER NOT NULL DEFAULT 0
);
