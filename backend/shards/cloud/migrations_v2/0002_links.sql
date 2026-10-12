-- Ссылки облака для людей без аккаунта (spec 022).
-- Ссылка — снимок: копии блобов владельца (таблицы files/chunks основной БД,
-- bucket облака) и зашифрованный ключом ссылки список. Ключа ссылки у сервера
-- нет. Строка ищется по SHA-256 идентификатора: время поиска не выдаёт сам
-- идентификатор (он — половина доступа).
CREATE TABLE IF NOT EXISTS links (
    key          BLOB PRIMARY KEY,
    link_id      TEXT NOT NULL,
    owner        TEXT NOT NULL,
    -- 1 — готовится (получателю не видна), 2 — действует; «истекла» —
    -- действующая с прошедшим expires_at, проверяется при чтении.
    state        INTEGER NOT NULL,
    -- Срок в днях (0 — без срока); отсчёт — с публикации либо продления.
    ttl_days     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    -- unix-секунды; 0 — без срока.
    expires_at   INTEGER NOT NULL DEFAULT 0,
    -- Шифртекст списка (ключ ссылки) и записи владельца (ключ личного диска).
    manifest     BLOB,
    owner_record BLOB
);
CREATE INDEX IF NOT EXISTS links_owner ON links (owner);

-- Копии ссылки. source_id — блоб-источник: повтор `cloud.link.add` с тем же
-- источником возвращает уже сделанную копию. Блоб из этой таблицы методам
-- `cloud.blob.*` не виден.
CREATE TABLE IF NOT EXISTS link_blobs (
    link_key   BLOB NOT NULL,
    source_id  TEXT NOT NULL,
    file_id    TEXT NOT NULL UNIQUE,
    -- 0 — копируется, 1 — готова.
    state      INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    chunks     INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (link_key, source_id)
);
