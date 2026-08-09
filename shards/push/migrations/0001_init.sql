-- VAPID-ключи сервера (генерируются при первом старте)
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    private_pem TEXT NOT NULL,
    public_b64url TEXT NOT NULL
);

-- Web-push подписки устройств (endpoint уникален на устройство+браузер)
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user);
