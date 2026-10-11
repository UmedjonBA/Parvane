-- spec 016: блобы делятся на bucket'ы со своими пределами (0 — медиа чатов,
-- 1 — облако). Незавершённая загрузка ведёт счётчики байт и чанков (без
-- агрегатов по чанкам на каждый чанк) и время последней активности.
ALTER TABLE files ADD COLUMN bucket INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN bucket INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN chunks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uploads ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE uploads SET
    bytes = (SELECT COALESCE(SUM(LENGTH(c.data)), 0) FROM chunks c WHERE c.file_id = uploads.file_id),
    chunks = (SELECT COUNT(*) FROM chunks c WHERE c.file_id = uploads.file_id),
    updated_at = created_at;

CREATE INDEX IF NOT EXISTS idx_files_owner_bucket ON files (owner, bucket);
CREATE INDEX IF NOT EXISTS idx_uploads_owner_bucket ON uploads (owner, bucket);
