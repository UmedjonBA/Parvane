-- Общие плейлисты (spec 041, MUSIC-3): хранятся открытым текстом — музыка не E2E, сервер и так видит треки.
-- `access`: 1 — только участники, 2 — все на сервере. `join_key` — ключ вступления из карточки в чате ('' — нет).
CREATE TABLE shared_playlists (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    access INTEGER NOT NULL,
    join_key TEXT NOT NULL DEFAULT '',
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX shared_playlists_owner ON shared_playlists (owner);
CREATE INDEX shared_playlists_access ON shared_playlists (access);
-- `role`: 1 — владелец, 2 — добавляет, 3 — слушает; `invited` — позван и ещё не открывал.
CREATE TABLE shared_members (
    playlist_id TEXT NOT NULL,
    address TEXT NOT NULL,
    role INTEGER NOT NULL,
    invited INTEGER NOT NULL DEFAULT 0,
    joined_ms INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, address)
);
CREATE INDEX shared_members_address ON shared_members (address);
-- Треки по порядку `rank`; повтор того же трека (track_id, server) в плейлисте не добавляется.
CREATE TABLE shared_items (
    playlist_id TEXT NOT NULL,
    id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    server TEXT NOT NULL DEFAULT '',
    rank REAL NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    duration_secs INTEGER NOT NULL DEFAULT 0,
    adder TEXT NOT NULL,
    added_ms INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, id)
);
CREATE INDEX shared_items_order ON shared_items (playlist_id, rank);
