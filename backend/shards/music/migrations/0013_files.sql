-- Файлы библиотеки (макет «Музыки» 23 ноя): откуда файл, корзина на 30 дней, правка тегов человеком, версии трека.
-- `source` — источник (hitmoz, youtube, soundcloud, bandcamp, upload…), `source_ref` — ссылка либо имя своего файла.
-- Удалённое не стирается сразу: файл переезжает в `<библиотека>/.trash/…` (`trash_path`), запись помечена
-- `deleted_ms`; через 30 дней стирается совсем. `original_tags` — теги до первой правки человеком (JSON).
-- `version` — вторая и следующие версии того же трека («[v2]»).
ALTER TABLE added_tracks ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN deleted_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE added_tracks ADD COLUMN deleted_by TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN trash_path TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN edited_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE added_tracks ADD COLUMN edited_by TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN original_tags TEXT NOT NULL DEFAULT '';
ALTER TABLE added_tracks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX added_tracks_deleted ON added_tracks (deleted_ms);
-- Исполнитель и название в нижнем регистре (Юникод — считает шард): версии и копии одного трека
ALTER TABLE added_tracks ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
CREATE INDEX added_tracks_name ON added_tracks (name_key);
