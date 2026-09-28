-- Линковка v2 (P-03): SAS от ОБОИХ эфемерных ключей с обязательством.
-- commitment   — base64 SHA-256(eph_pub raw) нового устройства, публикуется ДО ключа;
-- challenge_pub — эфемерный ключ старого устройства, приложенный к офферу;
-- signing_key  — Ed25519 signing-ключ нового устройства (для link-transfer, P-48).
ALTER TABLE link_offers ADD COLUMN commitment TEXT NOT NULL DEFAULT '';
ALTER TABLE link_offers ADD COLUMN challenge_pub TEXT NOT NULL DEFAULT '';
ALTER TABLE link_offers ADD COLUMN signing_key TEXT NOT NULL DEFAULT '';
