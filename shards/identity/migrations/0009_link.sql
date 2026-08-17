-- Авто-линковка нового устройства: передача E2E-состояния со старого
-- устройства. Сервер видит только эфемерные ПУБЛИЧНЫЕ ключи и запечатанный
-- ECDH-бокс с координатами шифртекста в cloud — прочитать историю не может.

-- Оффер нового устройства: «хочу историю, вот мой эфемерный ключ».
-- TTL обслуживается кодом (просроченные строки чистятся при обращении).
CREATE TABLE IF NOT EXISTS link_offers (
    username   TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    eph_pub    TEXT NOT NULL,            -- base64 эфемерный публичный ключ ECDH
    created_at INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);

-- Грант старого устройства целевому: ECDH-бокс (внутри file_id + ключи
-- расшифровки выгруженного в cloud экспорта) + эфемерный ключ грантера.
-- Одноразовый: удаляется при выдаче в poll.
CREATE TABLE IF NOT EXISTS link_grants (
    username   TEXT NOT NULL,
    device_id  TEXT NOT NULL,            -- ЦЕЛЕВОЕ (новое) устройство
    box        TEXT NOT NULL,            -- base64 AES-GCM(box) под ECDH-ключом
    eph_pub    TEXT NOT NULL,            -- base64 эфемерный ключ грантера
    created_at INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);
