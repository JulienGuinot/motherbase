-- Scheduler run ledger. Deliberately not a Prisma model: it is written from
-- inside scheduler catch blocks, where a client that has drifted from the schema
-- must degrade to "no ledger" rather than take the scheduler down with it.
CREATE TABLE IF NOT EXISTS platform.job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',
  error       text
);

-- Every read is "the newest runs, optionally for one job".
CREATE INDEX IF NOT EXISTS job_runs_job_started_idx ON platform.job_runs (job, started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_started_idx ON platform.job_runs (started_at DESC);

-- Control-plane table: the data-plane roles must never see it.
REVOKE ALL ON platform.job_runs FROM anon, authenticated;
