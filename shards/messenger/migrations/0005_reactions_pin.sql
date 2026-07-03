-- Реакции: одна на пользователя на сообщение (как в Telegram по умолчанию).
CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    reactor    TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (message_id, reactor)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions (message_id);

-- Закрепление сообщения в диалоге.
ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
