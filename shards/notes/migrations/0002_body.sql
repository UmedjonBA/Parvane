-- Добавляем колонку body для хранения итогового текста заметки.
-- Позволяет возвращать текст без реконструкции из всех RGA-элементов.
ALTER TABLE notes ADD COLUMN body TEXT NOT NULL DEFAULT '';
