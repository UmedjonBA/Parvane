-- Регистрация через почту: email + флаг подтверждения. Существующие аккаунты
-- считаются подтверждёнными (email_verified=1), иначе они потеряли бы логин.
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;

-- Одноразовые коды подтверждения (argon2-хэш, не открытый код).
CREATE TABLE IF NOT EXISTS email_codes (
    username   TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL
);
