-- Профильные поля (bio, дата рождения, цвет имени, личный канал, телефон).
-- Все опциональны, по умолчанию пустые/0. Синхронизируются через resolve.
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN birthday TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN name_color INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN personal_channel TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
