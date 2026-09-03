-- Очистка истории «для меня» (msg.chat.clear): сообщение остаётся в messages
-- для остальных участников, а для user исключается из выдачи sync.
CREATE TABLE IF NOT EXISTS hidden_messages (
    user       TEXT NOT NULL,
    message_id TEXT NOT NULL,
    hidden_at  INTEGER NOT NULL,
    PRIMARY KEY (user, message_id)
);
