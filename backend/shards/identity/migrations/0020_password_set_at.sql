-- Время последней смены именно пароля (секунды Unix; 0 — пароль не меняли с создания аккаунта). Отдельно от
-- `password_changed_at`: тот — отметка отзыва сессий, её двигает и смена ника, а владельцу показывается
-- «Пароль · менялся …» (`identity.account.get_2fa`).
ALTER TABLE users ADD COLUMN password_set_at INTEGER NOT NULL DEFAULT 0;
