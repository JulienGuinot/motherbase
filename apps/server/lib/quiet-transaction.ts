/**
 * Keep the rest of this transaction out of the server's own records: statement
 * logging, slow-statement logging and pg_stat_statements' copy of utility
 * statements. Run first in any transaction whose SQL text carries a secret, such
 * as a user mapping's password, which DDL cannot take as a bound parameter.
 *
 * Only a superuser may change these settings; under any other role the block is
 * a no-op, and binding values as parameters (never literals) is what keeps
 * plaintext out of the statement text wherever the SQL allows it.
 */
export const QUIET_TRANSACTION_SQL = `
  DO $$ BEGIN
    IF current_setting('is_superuser') = 'on' THEN
      PERFORM set_config('log_statement', 'none', true);
      PERFORM set_config('log_min_duration_statement', '-1', true);
      PERFORM set_config('pg_stat_statements.track_utility', 'off', true);
    END IF;
  END $$`;
