-- Мультидевайс: prekey-бандлы хранятся на пару (username, device_id).
-- Существующие строки становятся устройством '' («primary» — desktop и прежние
-- web-установки, которые не знают device_id), новые устройства добавляются
-- отдельными строками и больше не перетирают друг друга.
ALTER TABLE device_keys RENAME TO device_keys_legacy;
CREATE TABLE device_keys (
    username          TEXT NOT NULL,
    device_id         TEXT NOT NULL DEFAULT '',
    signing_key       TEXT NOT NULL DEFAULT '', -- base64 Ed25519 устройства
    registration_id   INTEGER NOT NULL,
    identity_key      TEXT NOT NULL,   -- base64 публичный
    signed_prekey_id  INTEGER NOT NULL,
    signed_prekey     TEXT NOT NULL,   -- base64 публичный
    signed_prekey_sig TEXT NOT NULL,   -- base64 подпись identity-ключом
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);
INSERT INTO device_keys
    (username, device_id, signing_key, registration_id, identity_key,
     signed_prekey_id, signed_prekey, signed_prekey_sig, updated_at)
    SELECT username, '', '', registration_id, identity_key, signed_prekey_id,
           signed_prekey, signed_prekey_sig, updated_at
    FROM device_keys_legacy;
DROP TABLE device_keys_legacy;

DROP INDEX IF EXISTS idx_otp_available;
ALTER TABLE one_time_prekeys RENAME TO one_time_prekeys_legacy;
CREATE TABLE one_time_prekeys (
    username   TEXT NOT NULL,
    device_id  TEXT NOT NULL DEFAULT '',
    key_id     INTEGER NOT NULL,
    public_key TEXT NOT NULL,          -- base64 публичный
    consumed   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (username, device_id, key_id)
);
INSERT INTO one_time_prekeys (username, device_id, key_id, public_key, consumed)
    SELECT username, '', key_id, public_key, consumed FROM one_time_prekeys_legacy;
DROP TABLE one_time_prekeys_legacy;
CREATE INDEX IF NOT EXISTS idx_otp_available
    ON one_time_prekeys (username, device_id, consumed);
