-- LINK-1 п. 13 (31 окт 2026): обёртка закрытой части ключа challenge для других своих устройств
-- (AES-256-GCM ключом из SSK аккаунта; сервер её не открывает). Пусто — challenge от клиента без обёртки.
ALTER TABLE link_offers ADD COLUMN challenge_wrap TEXT NOT NULL DEFAULT '';
