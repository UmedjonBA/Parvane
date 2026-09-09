-- E2E prekeys (Фаза 2, X3DH). Хранятся ТОЛЬКО публичные ключи; приватные части
-- никогда не покидают устройство. identity_key/signed_prekey — долгоживущие;
-- one-time расходуются по одному (помечаются consumed при fetch).
CREATE TABLE IF NOT EXISTS device_keys (
    username          TEXT PRIMARY KEY,
    registration_id   INTEGER NOT NULL,
    identity_key      TEXT NOT NULL,   -- base64 публичный
    signed_prekey_id  INTEGER NOT NULL,
    signed_prekey     TEXT NOT NULL,   -- base64 публичный
    signed_prekey_sig TEXT NOT NULL,   -- base64 подпись identity-ключом
    updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
    username   TEXT NOT NULL,
    key_id     INTEGER NOT NULL,
    public_key TEXT NOT NULL,          -- base64 публичный
    consumed   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (username, key_id)
);
CREATE INDEX IF NOT EXISTS idx_otp_available
    ON one_time_prekeys (username, consumed);
