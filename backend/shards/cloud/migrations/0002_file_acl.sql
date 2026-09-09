CREATE TABLE IF NOT EXISTS uploads (
    file_id      TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    total_chunks INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_grants (
    file_id    TEXT NOT NULL,
    principal  TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, principal),
    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_grants_principal
    ON file_grants (principal, file_id);
