-- spec 035, T096: протокол v1 удалён — легаси-копий v2-отправителей нет, таблица `legacy_origin`
-- (0001_v2_logs.sql) не пишется и не читается. Проверено на проде: строк 0.
DROP TABLE IF EXISTS legacy_origin;
