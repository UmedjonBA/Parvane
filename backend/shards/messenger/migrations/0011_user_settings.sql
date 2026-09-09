-- Настройки уведомлений/мута пользователя (JSON), синхронизируются между
-- его устройствами. Приватно: только сам пользователь читает/пишет.
CREATE TABLE IF NOT EXISTS user_settings (
    user TEXT PRIMARY KEY,
    notify_json TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);
