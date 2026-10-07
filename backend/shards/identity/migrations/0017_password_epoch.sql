-- ID-06: смена пароля гасит выданные ранее JWT. Токен с iat < password_changed_at
-- отклоняется; исключение — устройство, с которого пароль сменили (иначе владельца
-- выбрасывало бы сразу после смены, а клиенты ответ смены пароля токеном не обновляют).
ALTER TABLE users ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_dev TEXT NOT NULL DEFAULT '';
