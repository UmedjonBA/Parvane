-- История звонков. Сами SDP/ICE не хранятся (real-time, fire-and-forget) —
-- только запись о факте звонка и его статусе.
CREATE TABLE IF NOT EXISTS calls (
    id         TEXT PRIMARY KEY,
    caller     TEXT NOT NULL,
    callee     TEXT NOT NULL,
    media      TEXT NOT NULL,           -- audio | video
    status     TEXT NOT NULL,           -- ringing | answered | ended | missed | rejected
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller, started_at);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee, started_at);
