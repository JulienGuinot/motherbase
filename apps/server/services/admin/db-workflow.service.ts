import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import prisma from '../../lib/prisma';
import { absorbConnectionErrors } from '../../lib/errors';
import { formatSqlError } from '../../lib/pg-error';
import { HttpException } from '../../exceptions/http-exception';
import { invalidateCatalog } from '../rest-api/catalog';
import { quoteIdent } from './schema-ddl';
import { splitStatements } from './sql.service';
import { runCommand, toLibpqUrl } from './pg-command';
import { LONG_TRANSACTION, runStatements, type MigrationFileInput } from './schema-migration.service';
import { dumpToMigration, isTransactionControl, prepareScript, summarizeTap, type TapSummary } from './sql-script';

/**
 * The Supabase CLI's database workflow (`db diff`, `db pull`, `db reset`,
 * `db dump`, `db seed`, `test db`) against a project's own database.
 *
 * Schema history itself lives in `SchemaMigrationService`; this service is the
 * part that needs more than the live database: a scratch "shadow" database to
 * replay local migrations into, `pg_dump`, and transactions that are rolled
 * back on purpose.
 */

/**
 * Schemas Motherbase owns. Never dumped by default, never reset. `realtime`
 * (broadcast from the database), `vault` and `pgmq_public` (the queue RPC
 * wrappers) are created by the server, not by an extension, so the extension
 * check in APP_SCHEMAS_SQL does not catch them; `pgmq` itself it does.
 */
const PLATFORM_SCHEMAS = ['auth', 'storage', 'platform', 'realtime', 'vault', 'pgmq_public'];

/** Prisma's own bookkeeping lives in `public` and must survive a reset. */
const PRISMA_TABLE = '_prisma_migrations';

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface SeedFile {
  path: string;
  sql: string;
}

export interface DumpOptions {
  schemaOnly?: boolean;
  dataOnly?: boolean;
  schemas?: string[];
  /** COPY instead of INSERT for data. Faster, but only psql can load it. */
  useCopy?: boolean;
}

export interface DiffResult {
  sql: string;
  /** True when local migrations already describe the remote schema. */
  empty: boolean;
  /**
   * `dump` with no local migrations (the remote schema, verbatim, is the first
   * migration), `diff` otherwise (a best-effort DDL delta: see diffToDdl).
   */
  source: 'dump' | 'diff';
}

export interface TestResult extends TapSummary {
  name: string;
  output: string[];
  error: string | null;
}

type QueryClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

// A schema is the user's when Postgres did not create it, Motherbase does not
// own it, and no extension installed it (pg_cron's `cron`, pgmq's `pgmq`).
const APP_SCHEMAS_SQL = `
  SELECT n.nspname AS name
  FROM pg_namespace n
  WHERE n.nspname !~ '^pg_'
    AND n.nspname <> 'information_schema'
    AND n.nspname <> ALL($1::text[])
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e'
    )
  ORDER BY n.nspname`;

// Everything a migration can have put in `public`, as DROP statements. Objects
// an extension owns (pgcrypto's functions) are left to their extension, and
// CASCADE takes policies, triggers, indexes and owned sequences with a table.
const PUBLIC_OBJECTS_SQL = `
  WITH ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e')
  SELECT format('DROP %s IF EXISTS %s CASCADE',
           CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                          WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
           c.oid::regclass) AS stmt
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND c.relname <> '${PRISMA_TABLE}'
    AND NOT c.relispartition
    AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_class'::regclass AND ext.objid = c.oid)
  UNION ALL
  SELECT format('DROP %s IF EXISTS %s CASCADE', CASE p.prokind WHEN 'a' THEN 'AGGREGATE' ELSE 'ROUTINE' END,
           p.oid::regprocedure)
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_proc'::regclass AND ext.objid = p.oid)
  UNION ALL
  SELECT format('DROP %s IF EXISTS %s CASCADE', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
           t.oid::regtype)
  FROM pg_type t
  LEFT JOIN pg_class tc ON tc.oid = t.typrelid
  WHERE t.typnamespace = 'public'::regnamespace
    AND (t.typtype IN ('e', 'd', 'r', 'm') OR (t.typtype = 'c' AND tc.relkind = 'c'))
    AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_type'::regclass AND ext.objid = t.oid)`;

export class DbWorkflowService extends BaseContext {
  // ── Dump ────────────────────────────────────────────────────────────────────

  /** The user's schemas: what `db dump` dumps and `db reset` empties. */
  async appSchemas(client: QueryClient = prisma): Promise<string[]> {
    const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(APP_SCHEMAS_SQL, PLATFORM_SCHEMAS);
    return rows.map(row => row.name);
  }

  async dump(options: DumpOptions = {}): Promise<{ sql: string; schemas: string[] }> {
    if (options.schemaOnly && options.dataOnly) {
      throw new HttpException('schemaOnly and dataOnly are mutually exclusive', 400);
    }
    const schemas = options.schemas?.length ? options.schemas : await this.appSchemas();
    for (const schema of schemas) {
      // pg_dump reads -n as a pattern: a metacharacter would select other schemas.
      if (!PLAIN_IDENTIFIER.test(schema)) throw new HttpException(`Invalid schema name: ${schema}`, 400);
    }

    const args = ['--dbname', toLibpqUrl(env.DATABASE_URL), '--format=plain', '--no-owner'];
    for (const schema of schemas) args.push('--schema', schema);
    args.push('--exclude-table', `public.${PRISMA_TABLE}`);
    if (options.schemaOnly) args.push('--schema-only');
    if (options.dataOnly) args.push('--data-only');
    // Supabase's default: INSERTs load through anything, including `db seed`.
    if (!options.schemaOnly && !options.useCopy) args.push('--rows-per-insert=100');

    const { stdout } = await runCommand('pg_dump', args);
    return { sql: stdout, schemas };
  }

  // ── Diff (shadow database) ─────────────────────────────────────────────────

  /**
   * What the remote schema has that the local migrations do not build.
   *
   * With no local migration there is nothing to replay, and the honest answer
   * is the remote schema itself, dumped by pg_dump (functions, policies, FKs
   * and all). Otherwise the local migrations are replayed into a shadow
   * database and its snapshot is diffed against the live one.
   */
  async diff(migrations: MigrationFileInput[]): Promise<DiffResult> {
    if (!migrations.length) {
      const schemas = await this.appSchemas();
      const sql = schemas.length ? dumpToMigration((await this.dump({ schemaOnly: true, schemas })).sql) : '';
      return { sql, empty: splitStatements(sql).length === 0, source: 'dump' };
    }

    const local = await this.withShadow(async shadow => {
      for (const migration of byVersion(migrations)) {
        try {
          await shadow.query('BEGIN');
          for (const statement of splitStatements(prepareScript(migration.sql))) await shadow.query(statement);
          await shadow.query('COMMIT');
        } catch (err) {
          await shadow.query('ROLLBACK').catch(() => undefined);
          throw new HttpException(
            `Local migration ${migration.version}_${migration.name} fails on a fresh database: ${formatSqlError(err) || String(err)}`,
            400,
          );
        }
      }
      return this.di.SchemaMigrationService.snapshot(asQueryClient(shadow));
    });

    const migrationsService = this.di.SchemaMigrationService;
    const diff = migrationsService.diff(local, await migrationsService.snapshot());
    const empty = !diff.addedTables.length && !diff.droppedTables.length && !diff.changedTables.length;
    return { sql: empty ? '' : migrationsService.diffToDdl(diff), empty, source: 'diff' };
  }

  /**
   * Run `fn` against a throwaway database on the same server, dropped however
   * `fn` ends.
   *
   * It has to look like a fresh project, or a local migration that references
   * `auth.users` fails for the wrong reason: so it gets the live database's
   * extensions and the schema (no data) of the platform schemas. Roles are
   * cluster-wide, so `anon` and `authenticated` already exist. Everything else
   * starts empty, which is the point.
   */
  private async withShadow<T>(fn: (shadow: Client) => Promise<T>): Promise<T> {
    const name = `motherbase_shadow_${randomBytes(6).toString('hex')}`;
    const url = new URL(toLibpqUrl(env.DATABASE_URL));
    url.pathname = `/${name}`;
    const shadowUrl = url.toString();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'motherbase-shadow-'));

    await prisma.$executeRawUnsafe(`CREATE DATABASE ${quoteIdent(name)}`);
    const shadow = absorbConnectionErrors(new Client({ connectionString: shadowUrl }));
    try {
      await shadow.connect();
      await this.copyExtensions(shadow);
      const platformDump = path.join(scratch, 'platform.sql');
      await runCommand('pg_dump', [
        '--dbname', toLibpqUrl(env.DATABASE_URL), '--schema-only', '--no-owner',
        ...PLATFORM_SCHEMAS.flatMap(schema => ['--schema', schema]),
        '--file', platformDump,
      ]);
      // The URL as --dbname, never positional: psql on Windows stops reading
      // options at the first positional argument, ignored --file and sat on
      // stdin forever. pg_dump is called the same way for the same reason.
      await runCommand('psql', ['--dbname', shadowUrl, '--quiet', '--set', 'ON_ERROR_STOP=1', '--file', platformDump]);
      return await fn(shadow);
    } finally {
      await shadow.end().catch(() => undefined);
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Best effort per extension: pg_cron, for one, can only be created in the
   * database named by `cron.database_name`. A migration that needs a missing
   * one then fails on the shadow with Postgres's own message.
   */
  private async copyExtensions(shadow: Client): Promise<void> {
    const extensions = await prisma.$queryRawUnsafe<Array<{ name: string; schema: string }>>(
      `SELECT e.extname AS name, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname <> 'plpgsql'`,
    );
    for (const { name, schema } of extensions) {
      await shadow
        .query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}; CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)} WITH SCHEMA ${quoteIdent(schema)} CASCADE`)
        .catch(() => undefined);
    }
  }

  // ── Seed ────────────────────────────────────────────────────────────────────

  /** Run seed files in order, all or nothing. */
  async seed(files: SeedFile[]): Promise<{ files: string[] }> {
    try {
      await prisma.$transaction(tx => this.runSeeds(tx, files), LONG_TRANSACTION);
    } finally {
      invalidateCatalog();
    }
    return { files: files.map(file => file.path) };
  }

  private async runSeeds(tx: Prisma.TransactionClient, files: SeedFile[]): Promise<void> {
    for (const file of files) {
      try {
        await runStatements(tx, file.sql);
      } catch (err) {
        throw new HttpException(`Seed ${file.path} failed: ${formatSqlError(err) || String(err)}`, 400);
      }
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  /**
   * Supabase's `db reset --linked`: empty the app schemas, replay the local
   * migrations, then the seeds.
   *
   * Safety, on top of the explicit `confirm`: a pg_dump backup is taken first
   * (and the reset refuses to run without one), and everything after it is ONE
   * transaction, so a migration that fails half-way leaves the database exactly
   * as it was. Platform schemas and extensions are never touched.
   */
  async reset(input: { confirm?: string; migrations: MigrationFileInput[]; seeds?: SeedFile[] }): Promise<{
    backup: string;
    dropped: string[];
    applied: string[];
    seeded: string[];
  }> {
    if (input.confirm !== 'RESET') throw new HttpException('Reset requires confirm=RESET', 400);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const { file } = await this.di.BackupService.backupDatabase(`motherbase-pre-reset-${stamp}.sql`);

    const migrations = byVersion(input.migrations);
    const dropped: string[] = [];
    try {
      await prisma.$transaction(async tx => {
        const history = this.di.SchemaMigrationService;
        await history.lock(tx);

        for (const schema of await this.appSchemas(tx)) {
          if (schema === 'public') continue;
          await tx.$executeRawUnsafe(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
          dropped.push(schema);
        }
        const objects = await tx.$queryRawUnsafe<Array<{ stmt: string }>>(PUBLIC_OBJECTS_SQL);
        for (const { stmt } of objects) await tx.$executeRawUnsafe(stmt);

        // Nothing the history said was applied is there any more.
        await tx.schemaMigration.updateMany({ where: { status: 'applied' }, data: { status: 'rolledback', appliedAt: null } });
        for (const migration of migrations) await history.applyFile(tx, migration);
        await this.runSeeds(tx, input.seeds ?? []);
      }, LONG_TRANSACTION);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(formatSqlError(err) || 'Reset failed', 400);
    } finally {
      invalidateCatalog();
    }

    return {
      backup: file.name,
      dropped,
      applied: migrations.map(m => `${m.version}_${m.name}`),
      seeded: (input.seeds ?? []).map(s => s.path),
    };
  }

  // ── pgTAP ───────────────────────────────────────────────────────────────────

  /**
   * Run one pgTAP file inside a transaction that is always rolled back, and
   * return its TAP output. The file's own BEGIN/ROLLBACK are skipped: the
   * runner owns the transaction, so a test can never commit.
   */
  async runTest(input: { name: string; sql: string }): Promise<TestResult> {
    const available = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'pgtap'`,
    );
    if (!available.length) {
      throw new HttpException(
        'pgTAP is not installed on this database server. The Motherbase db image ships it (postgresql-16-pgtap in deploy/postgres.Dockerfile): rebuild and restart the db service, or install the pgtap package for your Postgres version.',
        400,
      );
    }

    const output: string[] = [];
    let error: string | null = null;
    await prisma
      .$transaction(async tx => {
        await tx.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgtap');
        for (const statement of splitStatements(prepareScript(input.sql))) {
          if (isTransactionControl(statement)) continue;
          try {
            const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(statement);
            output.push(...tapLines(rows));
          } catch (err) {
            error = formatSqlError(err) || String(err);
            break;
          }
        }
        throw ROLLBACK;
      }, LONG_TRANSACTION)
      .catch(err => {
        if (err !== ROLLBACK) throw err;
      });

    if (error) output.push(`# ERROR: ${error}`);
    return { name: input.name, output, error, ...summarizeTap(output, Boolean(error)) };
  }
}

/** Thrown to end the test transaction; never escapes `runTest`. */
const ROLLBACK = Symbol('rollback');

/** pgTAP functions return TAP as text rows, one or more lines each. */
function tapLines(rows: Array<Record<string, unknown>>): string[] {
  return rows.flatMap(row => {
    const value = Object.values(row)[0];
    return typeof value === 'string' ? value.split('\n') : [];
  });
}

const byVersion = (migrations: MigrationFileInput[]): MigrationFileInput[] =>
  [...migrations].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));

/**
 * The catalog readers take Prisma's `$queryRawUnsafe`; the shadow is reached
 * with node-postgres, because Prisma binds one database per client.
 */
function asQueryClient(client: Client): QueryClient {
  return {
    $queryRawUnsafe: (async (sql: string, ...values: unknown[]) => (await client.query(sql, values)).rows) as never,
  };
}
