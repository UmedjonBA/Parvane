-- Отозванные устройства: JWT с claim dev = device_id отклоняются на verify
-- сразу после отзыва (иначе токен жил бы до истечения 24 ч).
CREATE TABLE IF NOT EXISTS revoked_devices (
    username   TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    revoked_at INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);
