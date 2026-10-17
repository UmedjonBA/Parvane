-- Федерация (spec 028): закреплённые ключи чужих серверов, очередь доставки, виденные nonce.
CREATE TABLE IF NOT EXISTS servers (
    domain        TEXT PRIMARY KEY,
    server_key    BLOB NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    -- active | key_changed | blocked
    state         TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dest_domain TEXT NOT NULL,
    -- сериализованный S2SRequest
    payload     BLOB NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_ms     INTEGER NOT NULL,
    created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_ms);

CREATE TABLE IF NOT EXISTS seen_nonces (
    origin_domain TEXT NOT NULL,
    nonce         BLOB NOT NULL,
    seen_ms       INTEGER NOT NULL,
    PRIMARY KEY (origin_domain, nonce)
);
CREATE INDEX IF NOT EXISTS seen_nonces_age ON seen_nonces(seen_ms);
