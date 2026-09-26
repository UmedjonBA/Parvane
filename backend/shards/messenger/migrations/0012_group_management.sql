-- Управление группой (spec 003): фото/описание, права по умолчанию, ревизия;
-- гранулярные права админов; инвайт-ссылки с названием/сроком/лимитом/одобрением;
-- заявки на вступление. Только ADD COLUMN с дефолтами — старые строки не трогаются.
ALTER TABLE groups ADD COLUMN avatar_file_id TEXT;
ALTER TABLE groups ADD COLUMN about TEXT NOT NULL DEFAULT '';
ALTER TABLE groups ADD COLUMN default_perms_json TEXT NOT NULL DEFAULT '';
ALTER TABLE groups ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- NULL у role='admin' — полный набор прав (админ, назначенный до 0012).
ALTER TABLE group_members ADD COLUMN admin_rights_json TEXT;
ALTER TABLE group_members ADD COLUMN promoted_by TEXT;

ALTER TABLE group_invites ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE group_invites ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;   -- 0 — бессрочно
ALTER TABLE group_invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0;     -- 0 — без лимита
ALTER TABLE group_invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_invites ADD COLUMN request_needed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_invites ADD COLUMN revoked_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS group_join_requests (
    group_id     TEXT NOT NULL,
    member       TEXT NOT NULL,
    invite_token TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    status       TEXT NOT NULL,              -- 'pending' | 'approved' | 'declined'
    decided_by   TEXT,
    decided_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, member)
);
CREATE INDEX IF NOT EXISTS idx_group_join_requests_group ON group_join_requests (group_id, status);
