-- Двухфакторный вход (по желанию): после верного пароля вход подтверждается
-- в ПРИВЯЗАННОМ Telegram (deep link боту, как при регистрации).
ALTER TABLE users ADD COLUMN tg_2fa INTEGER NOT NULL DEFAULT 0;

-- Одноразовые токены входа: бот сопоставляет /start <token> с ожидающим
-- входом; подтвердить может только Telegram с users.telegram_id.
CREATE TABLE IF NOT EXISTS login_links (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    device_id  TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    confirmed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_links_user ON login_links(username);

-- Доверенные устройства: после подтверждённого двухфакторного входа устройство
-- (claim dev) входит по паролю без повторного Start — иначе «оставаться в
-- системе» спрашивало бы Telegram при каждой загрузке страницы.
CREATE TABLE IF NOT EXISTS trusted_devices (
    username     TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);
