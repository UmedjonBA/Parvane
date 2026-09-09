CREATE TABLE IF NOT EXISTS read_receipts (
    message_id TEXT NOT NULL,
    reader     TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (message_id, reader)
);
