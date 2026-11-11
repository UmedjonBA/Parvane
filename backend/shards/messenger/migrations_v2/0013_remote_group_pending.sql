-- spec 035 (PV-014, FR-072): записи группы другого сервера, пришедшие своему пользователю ДО его подписки
-- (`group.remote.subscribe`). Подписку устройство шлёт, только разобрав приглашение и журнал группы, а первые
-- записи (уведомление журнала, первое сообщение) сервер группы отправляет сразу — без отложенной очереди они
-- отбрасывались навсегда, участник с другого сервера не видел ни их, ни, офлайн при создании, всего до входа.
-- В инбокс они попадают только при подписке (v2_fed::release_pending); до неё лежат здесь с потолками на
-- получателя и на пару (получатель, домен группы) и сроком жизни — чужой сервер не заполнит ими инбокс.
CREATE TABLE remote_group_pending (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user         TEXT    NOT NULL,
    group_domain TEXT    NOT NULL,
    group_id     BLOB    NOT NULL,
    item         BLOB    NOT NULL,
    created_ms   INTEGER NOT NULL
);
CREATE INDEX remote_group_pending_group ON remote_group_pending (user, group_domain, group_id);
CREATE INDEX remote_group_pending_age ON remote_group_pending (created_ms);
