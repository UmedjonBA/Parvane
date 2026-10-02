-- v2 (spec 007, D-08): доступ к вложению по capability через анонимный канал.
-- Сервер хранит только SHA-256 секрета; сами блобы — в v1-таблицах основной БД.
CREATE TABLE IF NOT EXISTS blob_caps (
    file_id    TEXT PRIMARY KEY,
    cap_hash   BLOB NOT NULL,
    created_at INTEGER NOT NULL
);
