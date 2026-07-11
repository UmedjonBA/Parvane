-- Персональная очередь доставки (Фаза 1). Строка живёт, пока получатель не
-- подтвердил (ack). Гарантия «доставлено ≥ одного раза»: потеря невозможна,
-- возможен дубликат (дедупится на клиенте по message_id). Служит также для
-- delivered-статуса отправителю (ack → уведомить отправителя).
CREATE TABLE IF NOT EXISTS inbox_queue (
    recipient  TEXT NOT NULL,
    message_id TEXT NOT NULL,
    delivered  INTEGER NOT NULL DEFAULT 0,
    queued_at  INTEGER NOT NULL,
    PRIMARY KEY (recipient, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_recipient
    ON inbox_queue (recipient, delivered, queued_at);
