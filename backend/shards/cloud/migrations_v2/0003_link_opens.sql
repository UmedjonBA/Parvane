-- Сколько раз получатели открыли ссылку (spec 041 E2, доска `RdFiles`: «открытий: 37»): `cloud.link.get`
-- действующей неистёкшей ссылки прибавляет 1. Кто открывал, сервер не хранит; число видит только владелец
-- (`cloud.link.list`).
ALTER TABLE links ADD COLUMN opens INTEGER NOT NULL DEFAULT 0;
