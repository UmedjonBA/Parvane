CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    from_user  TEXT NOT NULL,
    to_user    TEXT NOT NULL,
    text       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to_user ON messages (to_user, created_at);
