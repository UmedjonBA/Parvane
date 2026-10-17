-- Смена ника (spec 026). Прежний ник 30 дней ведёт на новый адрес (вход, доставка, журнал устройств прежнего
-- адреса с записью `Rename`) и занят; затем журнал прежнего адреса уходит в архив, ник освобождается.
CREATE TABLE account_aliases (
    old_address TEXT    PRIMARY KEY,
    new_address TEXT    NOT NULL,
    until_ms    INTEGER NOT NULL
);
CREATE INDEX idx_account_aliases_new ON account_aliases(new_address);

-- Перенос строк прежнего адреса в шардах (messenger, domains, cloud, push): запрос с ответом, повтор до ответа.
CREATE TABLE rename_fanout (
    old_address TEXT    NOT NULL,
    new_address TEXT    NOT NULL,
    shard       TEXT    NOT NULL,
    device_ids  TEXT    NOT NULL,
    created_ms  INTEGER NOT NULL,
    PRIMARY KEY (old_address, shard)
);
