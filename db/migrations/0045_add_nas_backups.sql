-- NAS backup (Nx Witness style): one row per recording that is queued for,
-- or done with, a copy to the backup NAS. When a backed-up recording's local
-- file is removed (retention or "delete local copy"), the recording's
-- file_path is pointed at backup_path so it stays playable.

-- migrate:up

CREATE TABLE IF NOT EXISTS nas_backups (
    recording_id INTEGER PRIMARY KEY,
    status INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    backup_path TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    backed_up_at INTEGER,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_nas_backups_status ON nas_backups(status, next_attempt);
CREATE INDEX IF NOT EXISTS idx_nas_backups_backed_up_at ON nas_backups(backed_up_at);

-- migrate:down

DROP INDEX IF EXISTS idx_nas_backups_backed_up_at;
DROP INDEX IF EXISTS idx_nas_backups_status;
DROP TABLE IF EXISTS nas_backups;
