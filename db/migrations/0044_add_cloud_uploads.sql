-- Cloud storage: one row per recording that is queued for, or done with,
-- upload to the configured cloud bucket. Recordings themselves are unchanged.

-- migrate:up

CREATE TABLE IF NOT EXISTS cloud_uploads (
    recording_id INTEGER PRIMARY KEY,
    status INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    remote_path TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_at INTEGER,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_uploads_status ON cloud_uploads(status, next_attempt);
CREATE INDEX IF NOT EXISTS idx_cloud_uploads_uploaded_at ON cloud_uploads(uploaded_at);

-- migrate:down

DROP INDEX IF EXISTS idx_cloud_uploads_uploaded_at;
DROP INDEX IF EXISTS idx_cloud_uploads_status;
DROP TABLE IF EXISTS cloud_uploads;
