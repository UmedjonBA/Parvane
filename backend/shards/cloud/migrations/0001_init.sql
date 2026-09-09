CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    file_id     TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    data        BLOB NOT NULL,
    PRIMARY KEY (file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner);
