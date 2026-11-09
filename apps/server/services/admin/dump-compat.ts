/**
 * Cross-version compatibility for dumps loaded into this project's Postgres.
 *
 * The image ships pg_dump 17 (needed to dump a Supabase source running 17)
 * while a project database runs Postgres 16. pg_dump writes a preamble of
 * `SET` directives describing the server it dumped FROM, and PG16 rejects the
 * ones it does not know:
 *
 *   ERROR: unrecognized configuration parameter "transaction_timeout"
 *
 * The load runs with --single-transaction + ON_ERROR_STOP, so that one line at
 * the top rolls the entire schema and data import back. These directives only
 * restate server defaults, so commenting out the unknown ones is safe and keeps
 * the load atomic.
 */

/**
 * The preamble parameters pg_dump has emitted across PG13-17 that exist on every
 * Postgres a project can run. Used when the target's own `pg_settings` cannot be
 * read: anything outside this set is commented out instead, so a preamble from a
 * newer pg_dump can never abort the load. Erring this way is safe because these
 * directives only restate server defaults.
 */
export const PORTABLE_DUMP_SETTINGS: ReadonlySet<string> = new Set([
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'client_encoding',
  'standard_conforming_strings',
  'check_function_bodies',
  'xmloption',
  'client_min_messages',
  'row_security',
  'search_path',
  'default_tablespace',
  'default_table_access_method',
  'default_transaction_read_only',
  'escape_string_warning',
  'session_replication_role',
]);

/** pg_dump writes its settings block first; nothing below the first statement is a directive. */
const SET_DIRECTIVE = /^SET\s+([a-z_][a-z0-9_.]*)\s*(?:=|\bTO\b)/i;
const PREAMBLE_ENDED = /^\s*(CREATE|ALTER|COPY|INSERT|GRANT|REVOKE|COMMENT|DROP|SELECT\s+pg_catalog\.setval)\b/i;

export interface NeutralizeResult {
  sql: string;
  /** Names of the settings that were commented out, in file order. */
  stripped: string[];
}

/**
 * Comment out preamble `SET` directives the target server does not recognise.
 *
 * Scanning stops at the first real statement, so a `SET ...` string sitting
 * inside COPY data or a function body is never touched.
 */
export function neutralizeUnsupportedSettings(
  sql: string,
  isSupported: (name: string) => boolean
): NeutralizeResult {
  const lines = sql.split('\n');
  const stripped: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PREAMBLE_ENDED.test(line)) break;
    const match = SET_DIRECTIVE.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (isSupported(name)) continue;
    lines[i] = `-- ${line}  -- removed by Motherbase: unknown to this Postgres`;
    stripped.push(name);
  }

  if (stripped.length === 0) return { sql, stripped };
  return { sql: lines.join('\n'), stripped };
}

/**
 * pg_dump 15+ writes a bare `CREATE SCHEMA public;` for a `--schema=public`
 * dump of a Supabase source, because `public` there is a normal user schema
 * rather than the one initdb created. A project database always has `public`
 * already, so that statement aborts the load:
 *
 *   ERROR: schema "public" already exists
 *
 * With --single-transaction + ON_ERROR_STOP that one line rolls back the entire
 * schema and data import while the independent auth-user step still succeeds,
 * which is the "only my users got imported" failure. `IF NOT EXISTS` makes the
 * statement idempotent without changing what the dump builds inside the schema.
 */

/** Top-level only: pg_dump writes DDL at column 0, so an indented match is a function body. */
const CREATE_SCHEMA = /^CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)/i;
const CREATE_SCHEMA_NAME = /^CREATE\s+SCHEMA\s+(?:AUTHORIZATION\s+)?("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/i;
/** pg_dump inlines row data after `COPY … FROM stdin;`, terminated by a lone `\.`. */
const COPY_BEGIN = /^COPY\s.+\sFROM\s+stdin;/i;

/**
 * Indexes of the lines that are SQL, skipping rows inlined after a COPY. A row
 * value that looks like a statement must never be rewritten.
 */
function* statementLines(lines: readonly string[]): Generator<number> {
  let inCopy = false;
  for (let i = 0; i < lines.length; i++) {
    if (inCopy) {
      if (lines[i] === '\\.') inCopy = false;
      continue;
    }
    if (COPY_BEGIN.test(lines[i])) {
      inCopy = true;
      continue;
    }
    yield i;
  }
}

export interface RelaxResult {
  sql: string;
  /** Names of the schemas whose CREATE was made idempotent, in file order. */
  relaxed: string[];
}

/**
 * Rewrite `CREATE SCHEMA x` to `CREATE SCHEMA IF NOT EXISTS x`.
 *
 * COPY blocks are skipped, so a row value that happens to start with
 * `CREATE SCHEMA` is never touched.
 */
export function relaxSchemaCreation(sql: string): RelaxResult {
  const lines = sql.split('\n');
  const relaxed: string[] = [];

  for (const i of statementLines(lines)) {
    const line = lines[i];
    if (!CREATE_SCHEMA.test(line)) continue;

    const raw = CREATE_SCHEMA_NAME.exec(line)?.[1];
    lines[i] = line.replace(/^CREATE\s+SCHEMA\s+/i, 'CREATE SCHEMA IF NOT EXISTS ');
    relaxed.push(raw ? raw.replace(/^"|"$/g, '').replace(/""/g, '"') : 'schema');
  }

  if (relaxed.length === 0) return { sql, relaxed };
  return { sql: lines.join('\n'), relaxed };
}

/**
 * Supabase's `auth.uid()` returns `uuid`; this project's returns `text` (see the
 * rls_foundation migration, where a project user id is a text column). Every
 * policy a Supabase user ever wrote therefore compares a `uuid` column against
 * it, and the dump aborts on the first one:
 *
 *   ERROR: operator does not exist: uuid = text
 *
 * Casting each call restores the source's own typing rather than imposing a new
 * one: an expression that was `uuid` on Supabase stays `uuid` here, and one the
 * author had already written as `auth.uid()::text` becomes `(auth.uid())::uuid
 * ::text`, which is still `text`. Changing the target function's return type
 * instead would break the policies this project's own presets generate.
 *
 * The cast is also a no-op against a target whose `auth.uid()` already returns
 * `uuid`, so this runs unconditionally.
 */
const AUTH_UID_CALL = /\bauth\.uid\s*\(\s*\)/gi;

export interface AuthTypeResult {
  sql: string;
  /** How many `auth.uid()` calls were cast. */
  casts: number;
}

/** Rewrite `auth.uid()` to `(auth.uid())::uuid` outside COPY data. */
export function castAuthUidToUuid(sql: string): AuthTypeResult {
  const lines = sql.split('\n');
  let casts = 0;

  for (const i of statementLines(lines)) {
    if (!AUTH_UID_CALL.test(lines[i])) continue;
    AUTH_UID_CALL.lastIndex = 0; // the regex is global; .test advances it
    lines[i] = lines[i].replace(AUTH_UID_CALL, () => {
      casts++;
      return '(auth.uid())::uuid';
    });
  }

  if (casts === 0) return { sql, casts };
  return { sql: lines.join('\n'), casts };
}
