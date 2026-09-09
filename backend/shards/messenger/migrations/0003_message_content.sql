-- Медиа-контент сообщений. `kind` — для фильтрации, `content` — JSON
-- MessageContent (text/voice/video_note/photo/video/file). Колонка `text`
-- остаётся для совместимости, но новыми записями не используется.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN content TEXT;
