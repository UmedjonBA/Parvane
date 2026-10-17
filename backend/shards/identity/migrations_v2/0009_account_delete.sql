-- Удаление аккаунта (spec 027). Запрошенное удаление: аккаунт сразу выходит со всех устройств и скрыт от других
-- (журнал устройств, бандлы, профиль, поиск); через 7 дней строки стираются во всех шардах и ник свободен.
-- Вход паролем с `cancel_deletion` до срока отменяет удаление.
CREATE TABLE account_deletions (
    address      TEXT    PRIMARY KEY,
    requested_ms INTEGER NOT NULL,
    purge_at_ms  INTEGER NOT NULL,
    -- Устройства аккаунта (действующие и отозванные) — для ключей, выведенных из адреса и устройства
    device_ids   TEXT    NOT NULL
);

-- Стёртые аккаунты: пока ник никто не занял, собеседники видят «Удалённый аккаунт» (`deleted` в синке журнала).
CREATE TABLE deleted_accounts (
    address    TEXT    PRIMARY KEY,
    deleted_ms INTEGER NOT NULL
);
