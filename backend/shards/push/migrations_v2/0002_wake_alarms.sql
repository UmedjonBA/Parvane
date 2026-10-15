-- Будильник напоминаний (push.alarm.set, 15 окт 2026): моменты пробуждения устройства. Текста нет — только время;
-- в срок push шлёт обычное пустое пробуждение каналам устройства (по токену журнала, как пробуждение по записи).
CREATE TABLE wake_alarms (
    inbox_token TEXT    NOT NULL,
    at_ms       INTEGER NOT NULL,
    PRIMARY KEY (inbox_token, at_ms)
);

CREATE INDEX idx_wake_alarms_at ON wake_alarms(at_ms);
