-- Every compose file preloads pg_stat_statements, so the counters are already
-- being collected; without the extension object nothing can read them, and
-- `inspect performance`, `inspect db outliers|calls` and the index advisor all
-- answer "pg_stat_statements not enabled". All seven production projects were
-- found in that state.
--
-- Only where the library is preloaded: installed without it, the extension
-- exists but every read of the view fails with 55000, which turns the clean
-- "not enabled" answer into an error (a plain postgres image, as in CI).
--
-- Guarded like pgcrypto (20260821000000): on a managed Postgres where the role
-- cannot install extensions, a missing extension is degraded diagnostics, a
-- failed migration is an outage.
DO $pss$
BEGIN
  IF current_setting('shared_preload_libraries') ~ '(^|,)\s*pg_stat_statements\s*(,|$)' THEN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  END IF;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR undefined_object THEN
  RAISE WARNING 'pg_stat_statements could not be installed automatically (%). Slow-query diagnostics will be unavailable.', SQLERRM;
END
$pss$;
