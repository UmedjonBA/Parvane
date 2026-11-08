-- S7-19: суточный счётчик жетонов, выданных пользователям других серверов, — по регистрируемому домену
-- отправителя (поддомены wildcard-DNS делят одну квоту) и общий для всех чужих ('*'); переживает перезапуск.
CREATE TABLE IF NOT EXISTS foreign_token_quota (
    site TEXT NOT NULL,
    day  INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site, day)
);
