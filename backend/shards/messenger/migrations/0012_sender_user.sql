-- P-10/P-05: владелец сообщения по токену сессии (для sealed from_user = '').
-- Выборка по signing-ключам в sync и адрес delivered-квитанции опираются на
-- него, а не на самозаявленные ключи/поле ack.sender.
ALTER TABLE messages ADD COLUMN sender_user TEXT NOT NULL DEFAULT '';
UPDATE messages SET sender_user = from_user WHERE sender_user = '' AND from_user <> '';
