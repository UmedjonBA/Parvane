-- Как человек слушал (сигнал вкуса «Микса дня»): дослушал трек исполнителя либо пропустил его в первые секунды.
CREATE TABLE IF NOT EXISTS listens (
    user TEXT NOT NULL,
    artist TEXT NOT NULL,
    finished INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listens_user ON listens (user, created_ms);
