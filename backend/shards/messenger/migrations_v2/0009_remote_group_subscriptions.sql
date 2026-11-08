-- spec 035 (PV-014, FR-072): подписки своих пользователей на группы других серверов. Записи чужой группы
-- (S2sInboxPush) кладутся в инбокс только подписанным (v2_fed::store_pushed). Сервер видит факт членства
-- своего пользователя в чужой группе — маршрутный метаданный доставки (FED-1). Потолок — 5000 на пользователя.
CREATE TABLE remote_group_subscriptions (
    user         TEXT    NOT NULL,
    group_domain TEXT    NOT NULL,
    group_id     BLOB    NOT NULL,
    created_ms   INTEGER NOT NULL,
    PRIMARY KEY (user, group_domain, group_id)
);
