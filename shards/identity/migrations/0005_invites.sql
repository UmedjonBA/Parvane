-- Одноразовые инвайт-коды для закрытой регистрации (режим PARVANE_INVITE_REQUIRED=1).
-- В открытом пузыре таблица просто не используется.
CREATE TABLE IF NOT EXISTS invites (
    code       TEXT PRIMARY KEY,
    created_by TEXT,
    used_by    TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    used_at    INTEGER
);
