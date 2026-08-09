-- Пометка pairwise-записей группового mesh-звонка (to шёл с префиксом gcall:),
-- чтобы клиенты не рисовали их как личные звонки в истории.
ALTER TABLE calls ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;
