CREATE TABLE IF NOT EXISTS cal_events (
    id           TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    deleted_ts   INTEGER,
    deleted_site TEXT,
    created_at   INTEGER NOT NULL
);

-- LWW-регистр одного поля события.
CREATE TABLE IF NOT EXISTS cal_fields (
    event_id   TEXT NOT NULL,
    field      TEXT NOT NULL,
    value      TEXT NOT NULL,
    stamp_ts   INTEGER NOT NULL,
    stamp_site TEXT NOT NULL,
    PRIMARY KEY (event_id, field)
);

CREATE INDEX IF NOT EXISTS idx_cal_owner ON cal_events (owner);
