CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    title      TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Узлы RGA. Один ряд = один символ. PRIMARY KEY делает Insert идемпотентным
-- на уровне БД (INSERT OR IGNORE).
CREATE TABLE IF NOT EXISTS note_elements (
    note_id    TEXT NOT NULL,
    site       TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    after_site TEXT,
    after_seq  INTEGER,
    ch         TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, site, seq)
);

CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner);
CREATE INDEX IF NOT EXISTS idx_elements_note ON note_elements (note_id);
