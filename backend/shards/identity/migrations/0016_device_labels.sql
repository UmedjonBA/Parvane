-- Подпись устройства для экрана «Устройства» («Firefox, Linux») и время входа:
-- клиент называет себя при выдаче токена. Только для показа владельцу — ни на
-- доступ, ни на доверие не влияет.
CREATE TABLE IF NOT EXISTS device_labels (
    username  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    label     TEXT NOT NULL,
    login_at  INTEGER NOT NULL,
    PRIMARY KEY (username, device_id)
);
