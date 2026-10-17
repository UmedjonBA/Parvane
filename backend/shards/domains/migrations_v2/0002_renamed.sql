-- Смена ника (spec 026): прежний адрес → новый. Навсегда: журналы грантов и генезисы контейнеров подписаны прежним
-- адресом, и при их перепроверке права прежнего адреса — права нового.
CREATE TABLE renamed (
    old_address TEXT PRIMARY KEY,
    new_address TEXT NOT NULL
);
CREATE INDEX idx_renamed_new ON renamed(new_address);
