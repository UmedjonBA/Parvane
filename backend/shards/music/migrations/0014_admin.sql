-- «Музыка на сервере · для администратора» (макет 23 ноя): настройки сервера ключ → значение (исходные — из
-- переменных окружения) и личные лимиты людей.
CREATE TABLE IF NOT EXISTS music_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- `per_day` NULL — общий лимит; `no_catalog` 1 — только слушать, не скачивать.
CREATE TABLE IF NOT EXISTS user_limits (
    user TEXT PRIMARY KEY,
    per_day INTEGER,
    no_catalog INTEGER NOT NULL DEFAULT 0
);
