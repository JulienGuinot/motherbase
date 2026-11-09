import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { SchemaService } from '../services/admin/schema.service';
import { SqlService } from '../services/admin/sql.service';
import { RlsService } from '../services/admin/rls.service';

import { invalidateCatalog } from '../services/rest-api/catalog';

// Proves the DDL choke point: a schema change made through the admin surfaces is
// visible to the REST layer on the very next request, with no process restart
// and no manual cache call anywhere in the test.

const pool = new RlsPool();
const schema = new SchemaService({});
const rls = new RlsService({ prisma } as any);
const sql = new SqlService({ prisma, RlsService: rls } as any);

const rest = new RestApiService({
  prisma,
  RlsPool: pool,
  RealtimeBroadcastService: { captureDeleteAudience: async () => ({ mode: 'disabled' as const }) },
  RealtimeOutboxService: { enqueue: async () => {} },
} as any);

const TABLE = 'cat_ddl_widget';
const SQL_TABLE = 'cat_ddl_from_console';

async function openUpForRest(table: string): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT ON "${table}" TO anon, authenticated`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY read_all ON "${table}" FOR SELECT TO anon, authenticated USING (true)`
  );
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SQL_TABLE}" CASCADE`);
  invalidateCatalog();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SQL_TABLE}" CASCADE`);
  invalidateCatalog();
  await pool.end();
});

describe('catalog invalidation on DDL', () => {
  it('does not expose a table that does not exist yet', async () => {
    await expect(rest.handleGet(TABLE, {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sees a table created through SchemaService.executeRaw on the next request', async () => {
    // Exactly what admin-schema.controller#createTable runs.
    await schema.executeRaw(
      `CREATE TABLE "${TABLE}" (id text PRIMARY KEY, label text, doomed text)`
    );
    await openUpForRest(TABLE);

    const rows = await rest.handleGet(TABLE, {}, undefined);
    expect(rows).toEqual([]);

    const models = await rest.listModels();
    expect(models.map(m => m.model)).toContain(TABLE);
  });

  it('sees a column added through SchemaService.addColumn on the next request', async () => {
    await expect(rest.handleGet(TABLE, { note: 'eq.x' }, undefined)).rejects.toMatchObject({ statusCode: 400 });

    await schema.addColumn(TABLE, { name: 'note', type: 'text', nullable: true, default: null });

    await expect(rest.handleGet(TABLE, { note: 'eq.x' }, undefined)).resolves.toEqual([]);
  });

  it('rejects a dropped column as unknown on the next request', async () => {
    await expect(rest.handleGet(TABLE, { doomed: 'eq.x' }, undefined)).resolves.toEqual([]);

    await schema.dropColumn(TABLE, 'doomed');

    await expect(rest.handleGet(TABLE, { doomed: 'eq.x' }, undefined)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('sees a table created through the SQL console on the next request', async () => {
    // The mode is explicit because this case is about catalog invalidation, not
    // about the console's flags: a database that had the `database.sqlEditor`
    // setting restricted would refuse the call, and the failure would read as a
    // catalog bug.
    await sql.execute(`CREATE TABLE "${SQL_TABLE}" (id text PRIMARY KEY, body text)`, {
      enabled: true,
      readonly: false,
    });
    // SqlService turns RLS on for tables it creates; grant + policy so the read
    // is reachable rather than merely permitted.
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "${SQL_TABLE}" TO anon, authenticated`);
    await prisma.$executeRawUnsafe(
      `CREATE POLICY read_all ON "${SQL_TABLE}" FOR SELECT TO anon, authenticated USING (true)`
    );

    await expect(rest.handleGet(SQL_TABLE, {}, undefined)).resolves.toEqual([]);
  });

  it('stops exposing a table dropped through SchemaService.dropTable', async () => {
    await schema.dropTable(SQL_TABLE);
    await expect(rest.handleGet(SQL_TABLE, {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('transactional snapshots', () => {
  const MIGRATION_TABLE = 'cat_ddl_migrated';

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${MIGRATION_TABLE}" CASCADE`);
    invalidateCatalog();
  });

  it('sees uncommitted DDL when listTables is given the transaction client', async () => {
    // This is exactly what SchemaMigrationService.snapshot(tx) does: apply the
    // migration DDL, then snapshot the schema from inside the same transaction,
    // before commit. The catalog must be read through that client and NOT served
    // from the process cache.
    const inside = await prisma.$transaction(async tx => {
      await schema.executeRaw(`CREATE TABLE "${MIGRATION_TABLE}" (id text PRIMARY KEY, label text)`, tx);
      const tables = await schema.listTables('public', tx);
      return tables.find(t => t.name === MIGRATION_TABLE);
    });

    expect(inside?.columns.map(c => c.name)).toEqual(['id', 'label']);

    // The cached path also reflects it once the transaction has committed,
    // because execDdl invalidated on the way through.
    const cached = await schema.listTables('public');
    expect(cached.map(t => t.name)).toContain(MIGRATION_TABLE);
  });

  it('does not leak a rolled-back table into the cached snapshot', async () => {
    const ghost = 'cat_ddl_rolled_back';
    await prisma
      .$transaction(async tx => {
        await schema.executeRaw(`CREATE TABLE "${ghost}" (id text PRIMARY KEY)`, tx);
        throw new Error('deliberate rollback');
      })
      .catch(() => {});

    const tables = await schema.listTables('public');
    expect(tables.map(t => t.name)).not.toContain(ghost);
  });
});

describe('one source of truth for table shape', () => {
  it('Studio table list and the REST model list agree for the public schema', async () => {
    const [tables, models] = await Promise.all([schema.listTables('public'), rest.listModels()]);

    const byName = new Map(tables.map(t => [t.name, t]));
    // REST exposes base tables only, so it is a subset of the Studio list, and
    // every shared table must have an identical column set.
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const table = byName.get(model.dbName);
      expect(table, `REST exposes ${model.dbName} but Studio does not list it`).toBeDefined();
      expect(model.fields.map(f => f.name)).toEqual(table!.columns.map(c => c.name));
      expect(model.fields.map(f => f.type)).toEqual(table!.columns.map(c => c.type));
    }

    const fixture = models.find(m => m.model === TABLE);
    expect(fixture?.fields.map(f => f.name)).toEqual(byName.get(TABLE)!.columns.map(c => c.name));
  });

  it('never exposes the auth, storage or platform schemas over REST', async () => {
    const models = await rest.listModels();
    expect(models.every(m => m.schema === 'public')).toBe(true);

    // The Prisma-managed tables live outside `public`, so they are unreachable.
    for (const systemTable of ['users', 'session', 'files', 'app_settings', 'realtime_outbox']) {
      await expect(rest.handleGet(systemTable, {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
    }
  });
});
