-- Ключи безопасности аккаунта (SECKEY-1, spec 041): WebAuthn — второй фактор входа нового устройства паролем.
-- Открытый ключ: ES256 — SEC1 без сжатия (65 байт), EdDSA — 32 байта. Счётчик подписей растёт с каждым входом.
CREATE TABLE security_keys (
    user          TEXT    NOT NULL,
    credential_id BLOB    NOT NULL,
    name          TEXT    NOT NULL,
    alg           INTEGER NOT NULL,
    public_key    BLOB    NOT NULL,
    sign_count    INTEGER NOT NULL DEFAULT 0,
    created_ms    INTEGER NOT NULL,
    last_used_ms  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user, credential_id)
);

-- «Требовать ключ при входе»: первый ключ включает, действует только при хотя бы одном ключе.
CREATE TABLE seckey_settings (
    user     TEXT    PRIMARY KEY,
    required INTEGER NOT NULL
);
