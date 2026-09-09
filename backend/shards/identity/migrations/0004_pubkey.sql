-- Публичный Ed25519-ключ пользователя (base64) для аутентификации сигналинга
-- звонков. Пусто = ключ не зарегистрирован.
ALTER TABLE users ADD COLUMN pubkey TEXT NOT NULL DEFAULT '';
