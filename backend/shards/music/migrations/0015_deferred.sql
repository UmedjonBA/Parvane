-- «Добавить на сервер всё» (доска `XpMusic-02`): треки сверх суточного лимита ждут здесь и ставятся сами, когда лимит
-- снова позволяет («остальные — завтра сами»). `track` — CatalogTrack протокола.
CREATE TABLE deferred_fetch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    track BLOB NOT NULL,
    star INTEGER NOT NULL DEFAULT 0,
    created_ms INTEGER NOT NULL
);
CREATE INDEX deferred_fetch_user ON deferred_fetch (user, id);
