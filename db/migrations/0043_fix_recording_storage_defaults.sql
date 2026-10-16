-- New recordings were stored as retention tier 0 (Critical) and not deletable
-- under disk pressure, because the writers zeroed their metadata. Give those
-- recordings the intended defaults (Standard, deletable) so disk cleanup can
-- free space again. Protected recordings are left alone.

-- migrate:up

UPDATE recordings
SET retention_tier = 2, disk_pressure_eligible = 1
WHERE protected = 0 AND retention_tier = 0 AND disk_pressure_eligible = 0;

-- migrate:down

SELECT 1;
