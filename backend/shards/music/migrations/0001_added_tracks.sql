-- «Найти и скачать» (spec 039, этап B): кто добавил трек в общую библиотеку и сколько он занимает.
-- По этой таблице считаются суточный лимит и место пользователя, показывается «кто добавил» и решается,
-- кому можно удалить. `path` — путь файла относительно папки библиотеки; `track_id` — id трека на музыкальном
-- сервере (пусто, пока сервер не увидел файл).
CREATE TABLE added_tracks (
    path TEXT PRIMARY KEY,
    adder TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    added_ms INTEGER NOT NULL,
    track_id TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    duration_secs INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX added_tracks_adder ON added_tracks (adder, added_ms);
CREATE INDEX added_tracks_track ON added_tracks (track_id);
