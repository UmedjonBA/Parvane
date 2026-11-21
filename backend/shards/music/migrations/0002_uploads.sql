-- «Загрузить свои файлы» (spec 041): SHA-256 принятого файла — повторную загрузку того же файла шард не принимает.
ALTER TABLE added_tracks ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
CREATE INDEX added_tracks_sha256 ON added_tracks (sha256);
