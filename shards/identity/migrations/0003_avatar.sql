-- file_id аватара пользователя в шарде cloud (пусто = нет фото).
ALTER TABLE users ADD COLUMN avatar_file_id TEXT NOT NULL DEFAULT '';
