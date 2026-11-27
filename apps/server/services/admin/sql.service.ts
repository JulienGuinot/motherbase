import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { formatSqlError } from '../../lib/pg-error';
import { HttpException } from '../../exceptions/http-exception';
import { execDdl } from './schema-ddl';
import { LONG_TRANSACTION, cannotRunInTransaction, isRollback, isTransactionControl } from './sql-script';
import { invalidateCatalog } from '../rest-api/catalog';
import { hasUnsafeReadFunction } from '@motherbase/ai';
import { env } from '../../config/env';

export type StatementKind = 'read' | 'write' | 'empty';
export interface SqlMode {
  enabled: boolean;
  readonly: boolean;
}

const READ_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'VALUES', 'TABLE'];

/** Strip SQL comments so the leading keyword can be read reliably. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .trim();
}

/** Classify a single SQL statement as a read, a write, or empty. */
export function classifyStatement(sql: string): StatementKind {
  const cleaned = stripComments(sql);
  if (!cleaned) return 'empty';
  const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
  return READ_KEYWORDS.includes(firstWord) ? 'read' : 'write';
}

// Keywords that mutate data/schema even when nested inside a read-looking
// statement (e.g. `WITH x AS (DELETE ... RETURNING *) SELECT ...`).
const DATA_MODIFYING_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|REINDEX|VACUUM|REFRESH|SET|RESET|LOCK|SELECT\s+.*\bINTO\b)\b/i;

/** Remove string literals and quoted identifiers so keyword scans don't trip on data. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, ' ') // single-quoted strings
    .replace(/"(?:[^"]|"")*"/g, ' '); // double-quoted identifiers
}

/**
 * True when a read-classified statement actually hides a mutation or executes
 * a plan (EXPLAIN ANALYZE). Used to reject the classic read-only bypasses.
 */
export function isDisguisedWrite(sql: string): boolean {
  // READ ONLY transactions do not stop functions that affect another backend,
  // the filesystem, or server configuration.
  if (hasUnsafeReadFunction(sql)) return true;
  const cleaned = stripLiterals(stripComments(sql));
  if (/^EXPLAIN\b/i.test(cleaned) && /\bANALYZE\b/i.test(cleaned)) return true;
  // A leading SELECT/SHOW/VALUES/TABLE is safe; flag mutations only when they
  // appear in a CTE or otherwise inside the statement body.
  const firstWord = cleaned.split(/\s+/)[0]?.toUpperCase();
  if (firstWord === 'WITH' || firstWord === 'EXPLAIN') return DATA_MODIFYING_RE.test(cleaned);
  return false;
}

/**
 * The audit line is readable from Studio's Logs screen, so a literal that is a
 * credential (`ALTER ROLE x PASSWORD '...'`, `CREATE USER MAPPING ... OPTIONS
 * (password '...')`) must not reach it.
 */
export function redactSqlSecrets(sql: string): string {
  return sql.replace(/\b(password|secret)(\s+)'(?:[^']|'')*'/gi, "$1$2'[redacted]'");
}

const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split a batch into individual non-empty statements.
 *
 * A plain `sql.split(';')` truncates every construct whose body legitimately
 * contains a semicolon: PL/pgSQL functions, trigger functions, `DO $$ ... $$`
 * blocks, which is most of what a real schema is made of. This scanner walks
 * the text and only treats `;` as a separator when it is not inside a
 * single-quoted string (with `''` escapes, and backslash escapes for `E'...'`),
 * a double-quoted identifier, a dollar-quoted body (`$$ ... $$` / `$tag$ ...
 * $tag$`), a line comment, or a (nestable, as in Postgres) block comment.
 *
 * Positional placeholders (`$1`) are not dollar quotes: the tag pattern
 * requires the character after `$` to start an identifier.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;

  while (i < n) {
    const c = sql[i];

    if (c === "'" || c === '"') {
      // `E'...'` (and `e'...'`) give backslash its escaping meaning back; plain
      // strings under standard_conforming_strings do not.
      const prev = sql[i - 1];
      const beforePrev = sql[i - 2];
      const escapes =
        c === "'"
        && (prev === 'E' || prev === 'e')
        && !(beforePrev && /[A-Za-z0-9_$]/.test(beforePrev));
      i += 1;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; } // doubled quote = literal
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }

    if (c === '$') {
      const tag = DOLLAR_TAG_RE.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        // Unterminated body: hand the rest to Postgres, which reports it far
        // better than a guess here would.
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    if (c === ';') {
      out.push(sql.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  out.push(sql.slice(start));

  return out.map(s => s.trim()).filter(s => stripComments(s).length > 0);
}

/**
 * Throws an HttpException(403) when SQL execution is not permitted under the
 * given mode: the console is disabled, or a write is attempted while read-only.
 */
export function assertSqlAllowed(sql: string, mode: SqlMode): void {
  if (!mode.enabled) {
    throw new HttpException('SQL console is disabled (set CONSOLE_SQL_ENABLED=true)', 403);
  }
  if (mode.readonly) {
    for (const stmt of splitStatements(sql)) {
      if (classifyStatement(stmt) === 'write' || isDisguisedWrite(stmt)) {
        throw new HttpException('Only read statements are allowed: the SQL editor is read-only', 403);
      }
    }
  }
}

const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*)?(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi;

/** A relation a CREATE TABLE statement named, with the schema it qualified it with. */
export interface CreatedRelation {
  /** Null when the statement was unqualified, so it resolves against search_path. */
  schema: string | null;
  name: string;
}

/**
 * Extract created relations, schema included, so `CREATE TABLE
 * "reporting"."orders"` never collides with `public.orders` in the reserved-name
 * check or gets public-only RLS presets applied to it.
 */
export function extractCreatedRelations(sql: string): CreatedRelation[] {
  const cleaned = stripComments(sql);
  const found: CreatedRelation[] = [];
  let m: RegExpExecArray | null;
  CREATE_TABLE_RE.lastIndex = 0;
  while ((m = CREATE_TABLE_RE.exec(cleaned)) !== null) {
    found.push({ schema: m[1] ?? m[2] ?? m[3] ?? null, name: m[4] ?? m[5] ?? m[6] });
  }
  return found;
}

/** Extract table names from CREATE TABLE statements. */
export function extractCreatedTables(sql: string): string[] {
  return extractCreatedRelations(sql).map(relation => relation.name);
}

export interface ApiRoute {
  method: string;
  path: string;
  description: string;
}

/** Generate the REST API route descriptors for a dynamic table. */
export function tableRoutes(tableName: string): ApiRoute[] {
  const base = `/rest/v1/${tableName}`;
  return [
    { method: 'GET',    path: base, description: 'List rows (supports ?filter, ?limit, ?offset, ?sort)' },
    { method: 'POST',   path: base, description: 'Insert row' },
    { method: 'PATCH',  path: base, description: 'Update rows matching query filters' },
    { method: 'DELETE', path: base, description: 'Delete rows matching query filters' },
  ];
}

/** Convert values Prisma may return that JSON cannot serialize (BigInt). */
function sanitize(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

const TRANSACTION_CONTROL_ONLY =
  'The batch holds only BEGIN, COMMIT or ROLLBACK: the editor runs every batch in one transaction of its own.';
const TRANSACTION_CONTROL_SKIPPED =
  'BEGIN and COMMIT were skipped: the batch already ran as one transaction.';
const BATCH_ROLLED_BACK = 'The batch contains ROLLBACK: it ran, then was rolled back. Nothing was committed.';

/** Thrown inside the batch transaction to roll it back while keeping its result. */
class RollbackBatch extends Error {
  constructor(readonly result: SqlResult) {
    super('batch rolled back');
  }
}

const DESTRUCTIVE_RE = /^(DROP|TRUNCATE|DELETE|ALTER)\b/i;

/** True when a write statement is potentially destructive (irreversible data loss). */
function isDestructiveStatement(sql: string): boolean {
  const cleaned = stripComments(sql).trim();
  return DESTRUCTIVE_RE.test(cleaned);
}

export interface SqlResult {
  kind: StatementKind;
  columns?: string[];
  rows?: any[];
  rowsAffected?: number;
  /** Populated when DDL creates new tables: lists the generated REST routes. */
  newRoutes?: { table: string; routes: ApiRoute[] }[];
  /**
   * Populated when destructive statements (DROP, TRUNCATE, DELETE, ALTER) are
   * executed, or when transaction control was skipped.
   */
  warnings?: string[];
  /**
   * Set when any statement of the batch wrote. `kind` describes only the last
   * one, so `CREATE FUNCTION ...; SELECT 1` reads as a read; Studio needs this to
   * know its cached view of the database is stale.
   */
  wrote?: true;
}

/** Executes ad-hoc SQL from the Studio console, gated by env feature flags. */
export class SqlService extends BaseContext {
  /**
   * The editor's own mode. Whether the editor exists at all is the operator's
   * CONSOLE_SQL_ENABLED; whether it may write is the project's
   * `database.sqlEditor` setting, writes allowed unless someone restricts them.
   */
  async editorMode(): Promise<SqlMode> {
    const editor = await this.di.SettingsService?.get<{ allowWrites: boolean }>('database.sqlEditor').catch(() => null);
    return { enabled: env.CONSOLE_SQL_ENABLED, readonly: editor?.allowWrites === false };
  }

  async execute(sql: string, mode?: SqlMode): Promise<SqlResult> {
    const trimmed = (sql ?? '').trim();
    if (!trimmed) throw new HttpException('Empty SQL', 400);

    const resolvedMode = mode ?? (await this.editorMode());
    assertSqlAllowed(trimmed, resolvedMode);

    // The batch runs as one transaction that this service owns, so the author's
    // own BEGIN/COMMIT/ROLLBACK are not sent: a typed `BEGIN` would otherwise
    // open a second level the driver cannot see, and a typed `COMMIT` would end
    // ours half-way. A ROLLBACK anywhere in the batch is honoured by rolling the
    // whole batch back, which is what `BEGIN ... ROLLBACK` around a dry run means.
    const written = splitStatements(trimmed);
    const control = written.filter(stmt => isTransactionControl(stripComments(stmt)));
    const statements = written.filter(stmt => !isTransactionControl(stripComments(stmt)));
    if (statements.length === 0) throw new HttpException(TRANSACTION_CONTROL_ONLY, 400);
    const rollback = control.some(stmt => isRollback(stripComments(stmt)));

    // Read-only mode: rely on a real Postgres READ ONLY transaction as the hard
    // guarantee: any mutation (incl. data-modifying CTEs) is rejected by the DB
    // even if it slips past the static guard above.
    const result = resolvedMode.readonly
      ? await this.executeReadonly(statements)
      : await this.executeReadWrite(statements, rollback);
    if (rollback && !resolvedMode.readonly) (result.warnings ??= []).push(BATCH_ROLLED_BACK);
    else if (control.length) (result.warnings ??= []).push(TRANSACTION_CONTROL_SKIPPED);
    return result;
  }

  private async executeReadonly(statements: string[]): Promise<SqlResult> {
    return this.di.prisma.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      let last: SqlResult = { kind: 'empty' };
      for (const stmt of statements) {
        try {
          const rows = sanitize(await tx.$queryRawUnsafe(stmt));
          const columns = rows.length ? Object.keys(rows[0]) : [];
          this.audit(stmt, 'read', rows.length);
          last = { kind: 'read', columns, rows };
        } catch (err) {
          this.audit(stmt, 'error', 0, errorMessage(err));
          throw new HttpException(formatSqlError(err) || 'SQL error', 400);
        }
      }
      return last;
    });
  }

  /**
   * One transaction for the whole batch: a failing statement leaves nothing of
   * the statements before it, and a ROLLBACK in the batch undoes all of it.
   * The few statements Postgres refuses inside a transaction block run on their
   * own connection, and only as the sole statement of a batch.
   */
  private async executeReadWrite(statements: string[], rollback: boolean): Promise<SqlResult> {
    const outside = statements.find(stmt => cannotRunInTransaction(stripComments(stmt)));
    if (outside) {
      if (statements.length > 1 || rollback) {
        const keyword = stripComments(outside).trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
        throw new HttpException(
          `${keyword} cannot run inside a transaction, and a batch runs as one. Run it on its own, without BEGIN or ROLLBACK.`,
          400
        );
      }
      const result = await this.runWrites(this.di.prisma, statements);
      for (const { table, routes } of result.newRoutes ?? []) this.logRoutes(table, routes);
      return result;
    }
    try {
      const result = await this.di.prisma.$transaction(async (tx: any) => {
        const ran = await this.runWrites(tx, statements);
        if (rollback) throw new RollbackBatch(ran);
        return ran;
      }, LONG_TRANSACTION);
      for (const { table, routes } of result.newRoutes ?? []) this.logRoutes(table, routes);
      return result;
    } catch (err) {
      if (err instanceof RollbackBatch) {
        const { newRoutes: _discarded, ...result } = err.result;
        return result;
      }
      throw err;
    } finally {
      // DDL inside the transaction invalidated the catalog before it committed;
      // a reload in that window saw the old schema.
      invalidateCatalog();
    }
  }

  private async runWrites(executor: any, statements: string[]): Promise<SqlResult> {
    let last: SqlResult = { kind: 'empty' };
    const allNewRoutes: { table: string; routes: ApiRoute[] }[] = [];
    const warnings: string[] = [];
    let wrote = false;

    for (const stmt of statements) {
      const kind = classifyStatement(stmt);
      try {
        if (kind === 'read') {
          const rows = sanitize(await executor.$queryRawUnsafe(stmt));
          const columns = rows.length ? Object.keys(rows[0]) : [];
          this.audit(stmt, 'read', rows.length);
          last = { kind, columns, rows };
        } else {
          if (isDestructiveStatement(stmt)) {
            const keyword = stripComments(stmt).trim().split(/\s+/)[0].toUpperCase();
            warnings.push(`${keyword} statement executed: this operation may be irreversible.`);
          }
          // Every write statement goes through the DDL choke point, so an ad-hoc
          // CREATE/ALTER/DROP typed into the SQL console refreshes the catalog
          // and shows up on /rest/v1 with no restart.
          const rowsAffected = await execDdl<number>(executor, stmt);
          this.audit(stmt, 'write', rowsAffected);
          last = { kind, rowsAffected };
          wrote = true;

          for (const created of extractCreatedRelations(stmt)) {
            // REST and the RLS helpers address `public` only. A table created in
            // another schema gets neither, and announcing routes for it would
            // print endpoints that return 404.
            if (created.schema && created.schema !== 'public') continue;
            const table = created.name;
            const routes = tableRoutes(table);
            allNewRoutes.push({ table, routes });
            // Same transaction: a table that is rolled back takes its RLS with it,
            // and one that commits is never visible without it.
            await this.di.RlsService.setRls(table, true, executor);
            invalidateCatalog();
          }
        }
      } catch (err) {
        this.audit(stmt, 'error', 0, errorMessage(err));
        throw new HttpException(formatSqlError(err) || 'SQL error', 400);
      }
    }

    if (allNewRoutes.length) last.newRoutes = allNewRoutes;
    if (warnings.length) last.warnings = warnings;
    if (wrote) last.wrote = true;
    return last;
  }

  private audit(sql: string, outcome: string, count: number, message?: string) {
    const buffer = this.di.logBuffer;
    if (buffer?.push) {
      buffer.push({
        level: outcome === 'error' ? 'error' : 'info',
        source: 'sql',
        message: `[sql:${outcome}] ${redactSqlSecrets(sql).slice(0, 200)}${count ? ` (${count} rows)` : ''}${message ? `, ${message}` : ''}`,
      });
    }
  }

  private logRoutes(table: string, routes: ApiRoute[]) {
    const buffer = this.di.logBuffer;
    if (!buffer?.push) return;
    const lines = routes.map(r => `  ${r.method.padEnd(6)} ${r.path}`).join('\n');
    buffer.push({
      level: 'info',
      source: 'schema',
      message: `[schema] Table "${table}" created: REST API routes ready:\n${lines}`,
    });
  }
}
