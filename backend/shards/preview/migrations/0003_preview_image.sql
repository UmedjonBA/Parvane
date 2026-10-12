-- Картинка превью страницы (og:image / twitter:image): байты как пришли с
-- сайта и их тип. image_bytes — размер картинки (0 — её нет) для потолка кэша
-- по сумме байт (CLD-01); image_retry = 1 — картинка не добылась из-за
-- временного сбоя, такая строка живёт как отрицательная (15 минут).
ALTER TABLE previews ADD COLUMN image BLOB;
ALTER TABLE previews ADD COLUMN image_mime TEXT;
ALTER TABLE previews ADD COLUMN image_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE previews ADD COLUMN image_retry INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_previews_images ON previews (fetched_at DESC, url) WHERE image_bytes > 0;
-- Это кэш: прежние строки добыты без картинки и отдавали бы превью без неё до
-- конца своего срока (6 часов) — очищаем, превью добудутся заново.
DELETE FROM previews;
