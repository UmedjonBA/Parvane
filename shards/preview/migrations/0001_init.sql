-- Кэш превью ссылок: общий (не per-user), поэтому в нём нет ничего
-- пользовательского. Отрицательные результаты тоже кэшируются (ok=0).
CREATE TABLE IF NOT EXISTS previews (
    url         TEXT PRIMARY KEY,
    ok          INTEGER NOT NULL,
    site_name   TEXT,
    title       TEXT,
    description TEXT,
    fetched_at  INTEGER NOT NULL
);
