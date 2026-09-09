-- Подтверждение регистрации через Telegram-бота (deep link t.me/<bot>?start=<token>).
-- Флаг подтверждения общий с почтой: users.email_verified = «аккаунт подтверждён».
-- telegram_id — привязанный Telegram-аккаунт: один Telegram = один аккаунт.
ALTER TABLE users ADD COLUMN telegram_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;

-- Одноразовые токены регистрационных сессий: бот сопоставляет /start <token>
-- с pending-ником. Токен случайный (128 бит), хранится открыто — он живёт
-- минуты и без секрета бота бесполезен.
CREATE TABLE IF NOT EXISTS telegram_links (
    username   TEXT PRIMARY KEY,
    token      TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
);
