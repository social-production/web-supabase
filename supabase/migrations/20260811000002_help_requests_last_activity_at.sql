-- Help-request feeds/mutations expect last_activity_at (parity with threads/projects/events).
ALTER TABLE help_requests
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE;

UPDATE help_requests
SET last_activity_at = created_at
WHERE last_activity_at IS NULL;

ALTER TABLE help_requests
  ALTER COLUMN last_activity_at SET DEFAULT now(),
  ALTER COLUMN last_activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS ix_help_requests_last_activity_at
  ON help_requests (last_activity_at DESC);
