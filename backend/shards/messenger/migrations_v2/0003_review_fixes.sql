-- Исправления security-ревью кода v2 (security-code-review-us1.md).
--
-- C1-04: проверенный при приёме подписант записи журнала группы. Перестройка
-- состояния после рестарта берёт его отсюда, а не из ТЕКУЩИХ устройств
-- (иначе отзыв устройства подписанта обрывал перестройку и откатывал бан).
ALTER TABLE group_state_log ADD COLUMN signer_user TEXT;
ALTER TABLE group_state_log ADD COLUMN signer_root BLOB;

-- C1-14: ссылка-приглашение → группа (без перебора всех групп в invite.check).
CREATE TABLE group_links_v2 (
    link_id  BLOB PRIMARY KEY,
    group_id BLOB NOT NULL
);

-- C1-07: учёт объёма журнала инбокса устройства (квота без COUNT по журналу).
ALTER TABLE inbox_device ADD COLUMN records INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_device ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
UPDATE inbox_device SET
    records = (SELECT COUNT(*) FROM inbox_log l WHERE l.device = inbox_device.device),
    bytes = (SELECT COALESCE(SUM(LENGTH(item)), 0) FROM inbox_log l WHERE l.device = inbox_device.device);
