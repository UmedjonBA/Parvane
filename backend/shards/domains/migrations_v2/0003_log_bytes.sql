-- S7-22 (ревью 7 ноя 2026): квота журнала операций в байтах — на контейнер и на писателя.
-- Байты журнала контейнера (счётчик; иначе каждый append считал бы SUM по журналу).
ALTER TABLE containers ADD COLUMN log_bytes INTEGER NOT NULL DEFAULT 0;
-- Кто записал операцию (адрес вызывающего; для пользователей другого сервера — `@<домен>`): операции получателей
-- грантов ложатся в их долю, а не в долю владельца контейнера. Прежние строки — на владельца (автора сервер не хранил).
ALTER TABLE container_log ADD COLUMN author TEXT NOT NULL DEFAULT '';
UPDATE container_log SET author = COALESCE((SELECT c.owner FROM containers c WHERE c.id = container_log.container), '');
UPDATE containers SET log_bytes = (SELECT COALESCE(SUM(LENGTH(l.op)), 0) FROM container_log l WHERE l.container = containers.id);
CREATE INDEX container_log_author ON container_log (author);
-- Доля писателя во всех журналах сервера: число операций и байты.
CREATE TABLE log_usage (
    user  TEXT    PRIMARY KEY,
    ops   INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO log_usage (user, ops, bytes)
    SELECT author, COUNT(*), SUM(LENGTH(op)) FROM container_log WHERE author <> '' GROUP BY author;
