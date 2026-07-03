-- Отображаемое имя пользователя (Telegram-подобно: username=адрес для поиска,
-- display_name — что видно везде). По умолчанию = локальная часть адреса.
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
