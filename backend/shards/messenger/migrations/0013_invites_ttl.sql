-- P-34: инвайт-ссылки с ограниченным сроком и числом использований.
-- expires_at = 0 / max_uses = 0 — без ограничения (legacy-строки).
ALTER TABLE group_invites ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
