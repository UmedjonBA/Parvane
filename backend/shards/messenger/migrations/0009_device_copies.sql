-- Мультидевайс: sealed-копии одного сообщения для конкретных устройств.
-- Основной шифртекст остаётся в messages.content (копия «primary»-устройства,
-- wire-совместимость с одно-девайсными клиентами); дополнительные устройства
-- получают свою копию отсюда — sync подменяет ciphertext/ctype по device_id
-- запросившего. recipient пуст для копий «самому себе» (sealed sender не
-- раскрывает адрес) — владельца тогда определяет signing_key отправителя.
CREATE TABLE IF NOT EXISTS message_device_copies (
    message_id  TEXT NOT NULL,
    recipient   TEXT NOT NULL DEFAULT '',
    signing_key TEXT NOT NULL DEFAULT '',
    device_id   TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    ctype       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (message_id, recipient, signing_key, device_id)
);
CREATE INDEX IF NOT EXISTS idx_copies_device
    ON message_device_copies (message_id, device_id);
