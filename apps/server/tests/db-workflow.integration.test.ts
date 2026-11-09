import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SchemaMigrationService } from '../services/admin/schema-migration.service';
import type { DbWorkflowService } from '../services/admin/db-workflow.service';

// The CLI's migration workflow, end to end against Postgres: push, history,
// repair, diff through a shadow database, dump, seed, reset, pgTAP.
//
// `db reset` drops every object in `public`, and test files run in parallel
// against the same database. So this file migrates a database of its own and
// points every module at it before loading any of them: the services read
// DATABASE_URL once, at import.

const base = new URL(process.env.DATABASE_URL!);
const dbName = `mb_dbw_${randomBytes(4).toString('hex')}`;
const adminUrl = (() => {
  const url = new URL(base);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
})();

let prisma: PrismaClient;
let history: SchemaMigrationService;
let workflow: DbWorkflowService;
const backups: string[] = [];

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const columns = async (table: string) =>
  (await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
    table,
  )).map(row => row.column_name);

beforeAll(async () => {
  await admin(`CREATE DATABASE "${dbName}"`);
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  process.env.DATABASE_URL = url.toString();
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env },
    stdio: 'ignore',
  });

  prisma = (await import('../lib/prisma')).default;
  const { SchemaService } = await import('../services/admin/schema.service');
  const { SchemaMigrationService } = await import('../services/admin/schema-migration.service');
  const { DbWorkflowService } = await import('../services/admin/db-workflow.service');
  history = new SchemaMigrationService({ SchemaService: new SchemaService({} as never) } as never);
  // The real backup writes into BACKUP_DIR; what matters here is that reset
  // asks for one before touching anything.
  const BackupService = {
    backupDatabase: async (name: string) => {
      backups.push(name);
      return { file: { name } };
    },
  };
  workflow = new DbWorkflowService({ SchemaMigrationService: history, BackupService } as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
});

const orders = {
  version: '20260101000000',
  name: 'orders',
  sql: `CREATE TABLE public.dbw_orders (id bigint PRIMARY KEY, total numeric NOT NULL);
        CREATE FUNCTION public.dbw_total() RETURNS numeric LANGUAGE sql AS $$ SELECT sum(total) FROM public.dbw_orders; $$;`,
  downSql: 'DROP FUNCTION public.dbw_total(); DROP TABLE public.dbw_orders;',
};

describe('migration history', () => {
  it('pushes a multi-statement file and lists it under its version', async () => {
    const row = await history.push(orders);
    expect(row).toMatchObject({ version: orders.version, name: 'orders', origin: 'cli', status: 'applied' });

    const [entry] = await history.history();
    expect(entry.statements).toHaveLength(2);
    expect(await columns('dbw_orders')).toEqual(['id', 'total']);
  });

  it('records nothing when a statement fails half-way', async () => {
    await expect(
      history.push({ version: '20260102000000', name: 'broken', sql: 'CREATE TABLE public.dbw_half (id int); SELECT nope();' }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('20260102000000_broken') });
    expect(await columns('dbw_half')).toEqual([]);
    expect((await history.history()).map(h => h.version)).toEqual([orders.version]);
  });

  it('repairs without running SQL', async () => {
    await history.repair('20260103000000', { status: 'applied', name: 'by_hand', sql: 'CREATE TABLE public.dbw_never (id int)' });
    expect(await columns('dbw_never')).toEqual([]);
    await history.repair('20260103000000', { status: 'reverted' });
    const repaired = (await history.history()).find(h => h.version === '20260103000000');
    expect(repaired).toMatchObject({ status: 'rolledback', appliedAt: null });
  });

  it('rolls back through the down SQL, one statement at a time', async () => {
    await history.push({ version: '20260104000000', name: 'tag', sql: 'ALTER TABLE public.dbw_orders ADD COLUMN tag text', downSql: 'ALTER TABLE public.dbw_orders DROP COLUMN tag' });
    const row = await history.getByVersion('20260104000000');
    await history.rollback(row.id);
    expect(await columns('dbw_orders')).toEqual(['id', 'total']);
  });
});

// Each diff creates a database, copies extensions and runs pg_dump and psql as
// child processes: seconds, not milliseconds, on a cold or remote server.
describe('diff through a shadow database', { timeout: 30_000 }, () => {
  it('dumps the remote schema verbatim when there is no local migration', async () => {
    const result = await workflow.diff([]);
    expect(result.source).toBe('dump');
    expect(result.sql).toContain('CREATE TABLE public.dbw_orders');
    expect(result.sql).toContain('CREATE FUNCTION public.dbw_total()');
    // psql-only lines never reach a migration file.
    expect(result.sql).not.toMatch(/^\\restrict|set_config\('search_path'/m);
  });

  it('reports what the remote has beyond the local migrations, and drops the shadow', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE public.dbw_orders ADD COLUMN note text');
    const before = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname LIKE 'motherbase_shadow_%'`);

    const result = await workflow.diff([orders]);
    expect(result).toMatchObject({ source: 'diff', empty: false });
    expect(result.sql).toContain('ALTER TABLE "dbw_orders" ADD COLUMN "note" text');

    const after = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname LIKE 'motherbase_shadow_%'`);
    expect(after.length).toBe(before.length);
  });

  it('is empty once the local migrations build the same schema', async () => {
    const note = { version: '20260105000000', name: 'note', sql: 'ALTER TABLE public.dbw_orders ADD COLUMN note text' };
    expect(await workflow.diff([orders, note])).toMatchObject({ empty: true, sql: '' });
  });

  it('names the local migration that does not replay on a fresh database', async () => {
    const bad = { version: '20260106000000', name: 'bad', sql: 'ALTER TABLE public.missing ADD COLUMN x int' };
    await expect(workflow.diff([orders, bad])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('20260106000000_bad'),
    });
  });
});

describe('dump, seed, reset', () => {
  it('dumps schema only, the app schemas only', async () => {
    const { sql, schemas } = await workflow.dump({ schemaOnly: true });
    expect(schemas).toEqual(['public']);
    expect(sql).toContain('CREATE TABLE public.dbw_orders');
    expect(sql).not.toContain('_prisma_migrations');
    expect(sql).not.toContain('CREATE TABLE auth.');
  });

  it('seeds all or nothing', async () => {
    await expect(workflow.seed([
      { path: 'seed.sql', sql: 'INSERT INTO public.dbw_orders VALUES (1, 10, null);' },
      { path: 'broken.sql', sql: 'INSERT INTO public.dbw_orders VALUES (1, 10, null);' },
    ])).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('broken.sql') });
    expect(await prisma.$queryRawUnsafe<unknown[]>('SELECT * FROM public.dbw_orders')).toEqual([]);

    // A data-only dump is the usual seed: it must load through the same path.
    await prisma.$executeRawUnsafe('INSERT INTO public.dbw_orders VALUES (7, 70, null)');
    const { sql } = await workflow.dump({ dataOnly: true });
    await prisma.$executeRawUnsafe('DELETE FROM public.dbw_orders');
    await workflow.seed([{ path: 'dump.sql', sql }]);
    expect(await prisma.$queryRawUnsafe('SELECT id FROM public.dbw_orders')).toEqual([{ id: BigInt(7) }]);
  });

  it('refuses to reset without the confirmation', async () => {
    await expect(workflow.reset({ migrations: [] })).rejects.toMatchObject({ statusCode: 400 });
    expect(backups).toEqual([]);
  });

  it('leaves everything as it was when a replayed migration fails', async () => {
    const bad = { version: '20260107000000', name: 'bad', sql: 'SELECT nope()' };
    await expect(workflow.reset({ confirm: 'RESET', migrations: [orders, bad] })).rejects.toMatchObject({ statusCode: 400 });
    expect(await columns('dbw_orders')).toEqual(['id', 'note', 'total']);
  });

  it('empties the app schemas, replays local migrations and seeds, and keeps the platform', async () => {
    await prisma.$executeRawUnsafe('CREATE SCHEMA dbw_extra');
    await prisma.$executeRawUnsafe('CREATE TABLE dbw_extra.t (id int)');
    await prisma.$executeRawUnsafe(`CREATE TYPE public.dbw_mood AS ENUM ('ok')`);
    const backupsBefore = backups.length;

    const result = await workflow.reset({
      confirm: 'RESET',
      migrations: [orders],
      seeds: [{ path: 'seed.sql', sql: 'INSERT INTO public.dbw_orders VALUES (1, 5);' }],
    });

    expect(backups).toHaveLength(backupsBefore + 1);
    expect(result).toMatchObject({ dropped: ['dbw_extra'], applied: ['20260101000000_orders'], seeded: ['seed.sql'] });
    expect(await columns('dbw_orders')).toEqual(['id', 'total']);
    expect(await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_type WHERE typname = 'dbw_mood'`)).toEqual([]);
    expect(await prisma.$queryRawUnsafe('SELECT total FROM public.dbw_orders')).toEqual([{ total: expect.anything() }]);
    // Prisma's ledger, pgcrypto and the platform schemas survive.
    expect(await prisma.$queryRawUnsafe<unknown[]>('SELECT 1 FROM public._prisma_migrations LIMIT 1')).toHaveLength(1);
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid'`)).not.toHaveLength(0);

    const applied = (await history.history()).filter(h => h.status === 'applied').map(h => h.version);
    expect(applied).toEqual([orders.version]);
  });
});

describe('pgTAP', () => {
  it('says how to get pgTAP when the server does not have it', async () => {
    const installed = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_available_extensions WHERE name = 'pgtap'`);
    if (installed.length) {
      const result = await workflow.runTest({
        name: 'orders.sql',
        sql: `BEGIN; SELECT plan(2); SELECT has_table('public', 'dbw_orders', 'orders exists');
              INSERT INTO public.dbw_orders VALUES (99, 1);
              SELECT is((SELECT count(*)::int FROM public.dbw_orders WHERE id = 99), 1, 'insert visible');
              SELECT * FROM finish(); ROLLBACK;`,
      });
      expect(result).toMatchObject({ ok: true, planned: 2, passed: 2, failed: 0 });
      expect(await prisma.$queryRawUnsafe('SELECT 1 FROM public.dbw_orders WHERE id = 99')).toEqual([]);
    } else {
      await expect(workflow.runTest({ name: 't.sql', sql: 'SELECT 1' })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('postgresql-16-pgtap'),
      });
    }
  });
});
