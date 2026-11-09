-- The ledger recorded whether a run failed and nothing about what it did, so
-- "see the detailed logs" had nothing to show for a run that succeeded: a
-- storage cleanup that deleted 0 objects and one that deleted 40,000 were the
-- same green row.
--
-- `output` is the run's own report, already returned by every `runOnce()` and
-- until now thrown away. `trigger` separates a run an operator started from the
-- bottom of the drawer from one the timer fired, because a manual test run must
-- never be read as evidence that the schedule is alive.
ALTER TABLE platform.job_runs ADD COLUMN IF NOT EXISTS output text;
ALTER TABLE platform.job_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'schedule';

-- Control-plane table: the data-plane roles must never see the new columns either.
REVOKE ALL ON platform.job_runs FROM anon, authenticated;
