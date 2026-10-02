-- Журнал личного состояния (T096): счётчик seq и учёт объёма на пользователя.
-- seq монотонный и не переиспользуется; records/bytes — для лимитов
-- (PARVANE_STATE_MAX_RECORDS / PARVANE_STATE_MAX_BYTES) без COUNT по журналу.
CREATE TABLE user_state_head (
    user     TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL DEFAULT 0,
    records  INTEGER NOT NULL DEFAULT 0,
    bytes    INTEGER NOT NULL DEFAULT 0
);

INSERT INTO user_state_head (user, next_seq, records, bytes)
SELECT user, MAX(seq), COUNT(*), COALESCE(SUM(LENGTH(record)), 0)
FROM user_state_log
GROUP BY user;
