-- Модерация групп: мьют участников + инвайт-ссылки.
-- Бан — role='banned' в group_members (запись остаётся: банённый не получает
-- сообщения, не пишет, не может вступить по инвайту и быть добавленным).
ALTER TABLE group_members ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS group_invites (
    token      TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites (group_id);
