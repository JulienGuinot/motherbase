/**
 * SQL scripts written for psql, run through a driver instead.
 *
 * Migration files, seeds and pgTAP tests are routinely produced by `pg_dump`
 * or written to be fed to `psql -f`. Two things in such a file are psql's, not
 * Postgres's, and break or poison a driver session:
 *
 *   * meta-commands (`\restrict`, `\connect`, `\set`): recent pg_dump writes a
 *     `\restrict <key>` line into every dump, and the server rejects it as a
 *     syntax error;
 *   * `SELECT pg_catalog.set_config('search_path', '', false)`, which pg_dump
 *     emits to pin every name. With `false` it is session-wide, so it outlives
 *     the transaction and leaves a pooled connection resolving nothing.
 *
 * Kept pure so the rewrite can be tested without a database.
 */

const META_COMMAND = /^[ \t]*\\[A-Za-z!?].*$/gm;
const SESSION_SEARCH_PATH = /(set_config\(\s*'search_path'\s*,\s*'[^']*'\s*,\s*)false(\s*\))/gi;

/** Drop psql meta-commands and keep search_path changes transaction-local. */
export function prepareScript(sql: string): string {
  return sql.replace(META_COMMAND, '').replace(SESSION_SEARCH_PATH, '$1true$2');
}

/**
 * `BEGIN` / `COMMIT` / `ROLLBACK` written into a file. The runner owns the
 * transaction, so these are skipped rather than allowed to end it early.
 * Savepoints (`ROLLBACK TO`, `SAVEPOINT`) stay: they nest inside ours.
 */
export function isTransactionControl(statement: string): boolean {
  return /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b))\b/i.test(statement.trim());
}

// Prisma's interactive transactions time out after 5s by default, which a real
// migration or SQL file (an index build, a backfill) outlives.
export const LONG_TRANSACTION = { maxWait: 10_000, timeout: 10 * 60_000 };

/** `ROLLBACK` / `ABORT` (not `ROLLBACK TO`): the author asked for nothing to stick. */
export function isRollback(statement: string): boolean {
  return /^(?:ROLLBACK(?!\s+TO\b)|ABORT)\b/i.test(statement.trim());
}

/**
 * Statements Postgres refuses inside a transaction block (SQLSTATE 25001).
 * A batch runs as one transaction, so one of these can only run alone.
 */
export function cannotRunInTransaction(statement: string): boolean {
  return /^(?:VACUUM|(?:CREATE|DROP)\s+(?:DATABASE|TABLESPACE)|ALTER\s+SYSTEM|CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\b.*\bCONCURRENTLY|DROP\s+SUBSCRIPTION|CREATE\s+SUBSCRIPTION)\b/is.test(
    statement.trim()
  );
}

// pg_dump's preamble: session settings that restate server defaults.
const PREAMBLE_SET = /^SET\s+[a-z_.]+\s*(?:=|TO)\s*.*;\s*$/gim;
const SEARCH_PATH_RESET = /^SELECT pg_catalog\.set_config\('search_path', '', false\);\s*$/gm;
// `public` always exists on the target: creating it again is an error.
const PUBLIC_SCHEMA = /^(?:CREATE SCHEMA public;|COMMENT ON SCHEMA public IS .*;)\s*$/gm;

/**
 * Turn a `pg_dump --schema-only` of the app schemas into a migration file.
 *
 * Every name in a dump is schema-qualified, so dropping the empty search_path
 * changes nothing about what it builds, and the file stays readable.
 */
export function dumpToMigration(dump: string): string {
  const body = dump
    .replace(META_COMMAND, '')
    .replace(SEARCH_PATH_RESET, '')
    .replace(PREAMBLE_SET, '')
    .replace(PUBLIC_SCHEMA, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body ? `${body}\n` : '';
}

export interface TapSummary {
  planned: number | null;
  passed: number;
  failed: number;
  ok: boolean;
}

/**
 * Count a TAP stream. A run is green only when nothing failed AND every
 * planned test reported: a test file that dies half-way is not a pass.
 */
export function summarizeTap(lines: string[], errored = false): TapSummary {
  let planned: number | null = null;
  let passed = 0;
  let failed = 0;
  for (const line of lines) {
    const plan = /^\s*1\.\.(\d+)/.exec(line);
    if (plan) planned = Number(plan[1]);
    else if (/^\s*not ok\b/.test(line)) failed += 1;
    else if (/^\s*ok\b/.test(line)) passed += 1;
  }
  const complete = planned === null ? passed + failed > 0 : planned === passed + failed;
  return { planned, passed, failed, ok: !errored && failed === 0 && complete };
}
