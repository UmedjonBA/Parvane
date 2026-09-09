-- Мутации сообщений: ответы (reply_to), правки (edited), удаление «у всех»
-- (deleted) и курсор синхронизации мутаций (updated_at). Инкрементальный синк
-- по `id` не ловит изменения старых сообщений — для них нужен второй курсор
-- по `updated_at`, который бампается при правке/удалении/прочтении.
ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- Существующие строки: момент мутации = момент создания.
UPDATE messages SET updated_at = created_at WHERE updated_at = 0;

CREATE INDEX IF NOT EXISTS idx_messages_updated ON messages (updated_at);
