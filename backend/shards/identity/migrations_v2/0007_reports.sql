-- Жалобы администратору сервера (spec 024): шифртекст под ключом администратора и автор из сессии.
-- Содержимое сервер не видит; `done_ms` ставит утилита администратора после разбора.
CREATE TABLE reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter   TEXT    NOT NULL,
    created_ms INTEGER NOT NULL,
    sealed     BLOB    NOT NULL,
    done_ms    INTEGER
);
CREATE INDEX reports_open ON reports (done_ms, id);
