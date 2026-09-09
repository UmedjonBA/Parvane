-- Группы и каналы. Сообщение в группу = обычное сообщение с to_user = group_id;
-- участники получают его через fetch_missed (проверка членства). kind различает
-- группу (все пишут) и канал (пишут только owner/admin).
CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'group', -- 'group' | 'channel'
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    member   TEXT NOT NULL,
    role     TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'admin' | 'member'
    PRIMARY KEY (group_id, member)
);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members (member);
