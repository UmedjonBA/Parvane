-- C1-01 (security-code-review-us1): ключ устройства (olm_ed25519 /
-- olm_curve25519) закрепляется за первым (user, device_id), который его
-- сертифицировал, и не освобождается при отзыве: чужой ключ в своём
-- сертификате сервер отвергает, а поиск владельца ключа однозначен.
CREATE TABLE device_key_claims (
    key       BLOB PRIMARY KEY,
    user      TEXT NOT NULL,
    device_id TEXT NOT NULL
);

INSERT OR IGNORE INTO device_key_claims (key, user, device_id)
SELECT ed25519, user, device_id FROM device_state WHERE ed25519 IS NOT NULL AND revoked = 0;
