-- Хранилище протокола v2 push (spec 007, T101). Отдельный файл БД
-- `<PARVANE_DB_PATH>-v2.db`: v1-файл и его миграции не меняются, откат
-- бинарника на v1 безопасен (contracts/migration.md «Хранение v2»).

-- Каналы пробуждения (push.wake.register). Привязка — к токену журнала
-- устройства (inbox_subject(user, device) без префикса `v2.inbox.`): по
-- записи в журнал устройства push шлёт ПУСТОЕ пробуждение, не разбирая её.
-- endpoint уникален: повторная регистрация того же канала перепривязывает его.
CREATE TABLE wake_registrations (
    endpoint    TEXT    PRIMARY KEY,
    user        TEXT    NOT NULL,
    device_id   TEXT    NOT NULL,
    inbox_token TEXT    NOT NULL,
    kind        INTEGER NOT NULL,
    p256dh      BLOB    NOT NULL,
    auth        BLOB    NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_wake_registrations_user ON wake_registrations(user);
CREATE INDEX idx_wake_registrations_token ON wake_registrations(inbox_token);
