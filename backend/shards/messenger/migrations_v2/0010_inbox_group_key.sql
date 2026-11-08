-- spec 035 (остаток S7-16, FR-073): группа уведомления журнала группы (GroupStateNotice) в инбоксе устройства —
-- "<домен>/<hex id>"; NULL у прочих записей. Новое неподтверждённое уведомление пары (устройство, группа)
-- замещает прежнее неподтверждённое этой пары в той же транзакции (v2::append_in). Прежние строки остаются
-- без группы (их уберёт срок жизни журнала).
ALTER TABLE inbox_log ADD COLUMN group_key TEXT;
CREATE INDEX inbox_log_group_key ON inbox_log (device, group_key) WHERE group_key IS NOT NULL;
