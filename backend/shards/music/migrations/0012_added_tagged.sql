-- Теги и обложка скачанного переписаны по каталогу: 0 — ещё нет, 1 — да, 2 — в каталоге не нашёлся.
-- Свои загруженные файлы (sha256 не пуст) — со своими тегами: не трогаются
ALTER TABLE added_tracks ADD COLUMN tagged INTEGER NOT NULL DEFAULT 0;
UPDATE added_tracks SET tagged = 1 WHERE sha256 != '';
