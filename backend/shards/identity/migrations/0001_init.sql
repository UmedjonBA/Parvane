CREATE TABLE IF NOT EXISTS secret (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    bytes  BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);
