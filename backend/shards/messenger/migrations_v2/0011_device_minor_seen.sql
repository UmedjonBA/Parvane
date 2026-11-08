-- spec 035 (T150, D2, FR-066): статистика «устройства перенесли». Устройство, обратившееся к своему инбоксу
-- (`msg.inbox.sync`) через gateway с `proto_minor ≥ PROTO_MINOR_035` (минор из Hello, `ShardRequest.client_minor`),
-- отмечается здесь один раз. `device` — тот же токен, что в `inbox_device` (hex SHA-256 адреса и device_id): адресов
-- в таблице нет. Считает `messenger --migration-status` (только числа); удаляется вместе с кодом переноса (T149).
CREATE TABLE device_minor_seen (
    device   TEXT    PRIMARY KEY,
    minor    INTEGER NOT NULL,
    first_ms INTEGER NOT NULL
);
