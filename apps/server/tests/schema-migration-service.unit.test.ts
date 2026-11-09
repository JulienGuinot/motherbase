import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { SchemaMigrationService, type Snapshot } from '../services/admin/schema-migration.service';

// ── In-memory prisma mock (schemaMigration delegate + $transaction) ────────────

const { store, mockPrisma } = vi.hoisted(() => {
  const store: any[] = [];
  let seq = 0;
  const delegate = {
    findMany: vi.fn(async ({ orderBy }: any = {}) => {
      const rows = [...store];
      if (orderBy?.createdAt === 'desc') rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows;
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      store.find(r => (where.id ? r.id === where.id : r.version === where.version)) ?? null),
    findFirst: vi.fn(async ({ where }: any = {}) => {
      const rows = store.filter(row => !where?.status || row.status === where.status);
      return rows.sort((a, b) => {
        const applied = Number(b.appliedAt ?? 0) - Number(a.appliedAt ?? 0);
        return applied || b.createdAt - a.createdAt;
      })[0] ?? null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `mig-${seq}`,
        origin: 'studio',
        appliedAt: null,
        snapshot: null,
        snapshotChecksum: null,
        createdAt: seq,
        ...data,
      };
      seq += 1;
      store.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.find(r => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = store.find(r => r.id === where.id && r.status === where.status);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const mockPrisma = {
    schemaMigration: delegate,
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
  };
  return { store, mockPrisma };
});

vi.mock('../lib/prisma', () => ({ default: mockPrisma }));

function makeSchemaService(tables: any[], indexesByTable: Record<string, any[]> = {}) {
  return {
    listTables: vi.fn(async () => tables),
    listIndexes: vi.fn(async (t: string) => indexesByTable[t] ?? []),
  };
}

function service(schema: any = makeSchemaService([])) {
  return new SchemaMigrationService({ SchemaService: schema } as any);
}

beforeEach(() => {
  store.length = 0;
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

// ── snapshot() ─────────────────────────────────────────────────────────────────

describe('SchemaMigrationService.snapshot', () => {
  it('excludes internal/system tables and sorts deterministically', async () => {
    const schema = makeSchemaService(
      [
        // system (prisma model dbName) (excluded
        { name: 'users', columns: [{ name: 'id', type: 'uuid', nullable: false, default: null }] },
        // internal) excluded
        { name: '_prisma_migrations', columns: [{ name: 'id', type: 'text', nullable: false, default: null }] },
        { name: 'pg_stat', columns: [{ name: 'x', type: 'int', nullable: true, default: null }] },
        // user tables: kept, and intentionally out of order
        {
          name: 'zebra',
          columns: [
            { name: 'name', type: 'text', nullable: true, default: null },
            { name: 'id', type: 'uuid', nullable: false, default: null },
          ],
        },
        { name: 'apple', columns: [{ name: 'id', type: 'uuid', nullable: false, default: null }] },
      ],
      {
        zebra: [{ name: 'zebra_name_idx', definition: 'CREATE INDEX zebra_name_idx ON public.zebra USING btree (name)', unique: false }],
      }
    );

    const snap = await service(schema).snapshot();

    expect(snap.tables.map(t => t.name)).toEqual(['apple', 'zebra']);
    // columns sorted by name
    expect(snap.tables[1].columns.map(c => c.name)).toEqual(['id', 'name']);
    // index columns parsed from definition
    expect(snap.tables[1].indexes).toEqual([{ name: 'zebra_name_idx', columns: ['name'], unique: false }]);
  });
});

describe('SchemaMigrationService.liveDiff', () => {
  it('uses the latest applied snapshot as its baseline', async () => {
    const baselineTable = {
      name: 'existing',
      columns: [{ name: 'id', type: 'uuid', nullable: false, default: null }],
    };
    const schema = makeSchemaService([baselineTable]);
    const svc = service(schema);
    const row = await svc.create({
      name: 'baseline',
      upSql: 'CREATE TABLE existing (id uuid)',
    });

    const applied = await svc.apply(row.id);
    expect(applied.snapshot).toEqual({
      tables: [{ name: 'existing', columns: baselineTable.columns, indexes: [] }],
    });
    expect(applied.snapshotChecksum).toMatch(/^[a-f0-9]{64}$/);

    schema.listTables.mockResolvedValue([
      baselineTable,
      {
        name: 'new_table',
        columns: [{ name: 'id', type: 'uuid', nullable: false, default: null }],
      },
    ]);
    const result = await svc.liveDiff();

    expect(result.diff.addedTables.map(table => table.name)).toEqual(['new_table']);
    expect(result.diff.addedTables.map(table => table.name)).not.toContain('existing');
  });
});

// ── diff() ───────────────────────────────────────────────────────────────────

describe('SchemaMigrationService.diff', () => {
  const svc = service();
  const col = (name: string, over: Partial<any> = {}) => ({ name, type: 'text', nullable: true, default: null, ...over });

  it('detects added/dropped tables', () => {
    const from: Snapshot = { tables: [{ name: 'gone', columns: [col('id')], indexes: [] }] };
    const to: Snapshot = { tables: [{ name: 'fresh', columns: [col('id')], indexes: [] }] };
    const d = svc.diff(from, to);
    expect(d.addedTables.map(t => t.name)).toEqual(['fresh']);
    expect(d.droppedTables.map(t => t.name)).toEqual(['gone']);
  });

  it('detects added/dropped/changed columns and indexes', () => {
    const from: Snapshot = {
      tables: [{
        name: 't',
        columns: [col('id', { nullable: false }), col('old'), col('age', { type: 'int4' })],
        indexes: [{ name: 'idx_old', columns: ['old'], unique: false }],
      }],
    };
    const to: Snapshot = {
      tables: [{
        name: 't',
        columns: [col('id', { nullable: false }), col('added'), col('age', { type: 'int8' })],
        indexes: [{ name: 'idx_new', columns: ['added'], unique: true }],
      }],
    };
    const d = svc.diff(from, to);
    const ct = d.changedTables[0];
    expect(ct.addedColumns.map(c => c.name)).toEqual(['added']);
    expect(ct.droppedColumns.map(c => c.name)).toEqual(['old']);
    expect(ct.changedColumns.map(c => c.name)).toEqual(['age']);
    expect(ct.changedColumns[0].to.type).toBe('int8');
    expect(ct.addedIndexes.map(i => i.name)).toEqual(['idx_new']);
    expect(ct.droppedIndexes.map(i => i.name)).toEqual(['idx_old']);
  });
});

// ── diffToDdl() ──────────────────────────────────────────────────────────────

describe('SchemaMigrationService.diffToDdl', () => {
  const svc = service();
  const col = (name: string, over: Partial<any> = {}) => ({ name, type: 'text', nullable: true, default: null, ...over });

  it('emits quoted DDL for each change kind in a safe order', () => {
    const from: Snapshot = {
      tables: [
        { name: 'drop_me', columns: [col('id')], indexes: [] },
        {
          name: 'alter_me',
          columns: [col('id', { nullable: false }), col('gone'), col('age', { type: 'int4', nullable: false })],
          indexes: [{ name: 'idx_gone', columns: ['gone'], unique: false }],
        },
      ],
    };
    const to: Snapshot = {
      tables: [
        { name: 'brand_new', columns: [col('id', { nullable: false }), col('label')], indexes: [{ name: 'bn_idx', columns: ['label'], unique: true }] },
        {
          name: 'alter_me',
          columns: [col('id', { nullable: false }), col('added', { default: "'x'" }), col('age', { type: 'int8', nullable: true })],
          indexes: [{ name: 'idx_added', columns: ['added'], unique: false }],
        },
      ],
    };

    const sql = svc.diffToDdl(svc.diff(from, to));

    expect(sql).toContain('REVIEW BEFORE APPLYING');
    // drops
    expect(sql).toContain('DROP INDEX IF EXISTS "idx_gone";');
    expect(sql).toContain('ALTER TABLE "alter_me" DROP COLUMN "gone";');
    expect(sql).toContain('DROP TABLE IF EXISTS "drop_me" CASCADE;');
    // create table (parent) with quoted cols
    expect(sql).toContain('CREATE TABLE "brand_new"');
    expect(sql).toContain('"id" text NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "bn_idx" ON "brand_new" ("label");');
    // add column + alterations
    expect(sql).toContain('ALTER TABLE "alter_me" ADD COLUMN "added" text DEFAULT \'x\';');
    expect(sql).toContain('ALTER TABLE "alter_me" ALTER COLUMN "age" TYPE int8');
    expect(sql).toContain('ALTER TABLE "alter_me" ALTER COLUMN "age" DROP NOT NULL;');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_added" ON "alter_me" ("added");');

    // Ordering: dropping the table comes before creating the new one.
    expect(sql.indexOf('DROP TABLE IF EXISTS "drop_me"')).toBeLessThan(sql.indexOf('CREATE TABLE "brand_new"'));
  });

  it('reports no changes for identical snapshots', () => {
    const snap: Snapshot = { tables: [{ name: 't', columns: [col('id')], indexes: [] }] };
    expect(svc.diffToDdl(svc.diff(snap, snap))).toContain('No changes detected');
  });
});

// ── lifecycle: create / apply / rollback / drift ───────────────────────────────

describe('SchemaMigrationService lifecycle', () => {
  it('create validates and computes a sha256 checksum', async () => {
    const svc = service();
    await expect(svc.create({ name: '', upSql: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.create({ name: 'ok', upSql: '  ' })).rejects.toMatchObject({ statusCode: 400 });

    const row = await svc.create({ name: 'add_col', upSql: 'ALTER TABLE t ADD COLUMN c text' });
    expect(row.status).toBe('pending');
    expect(row.checksum).toBe(createHash('sha256').update('ALTER TABLE t ADD COLUMN c text').digest('hex'));
  });

  it('apply runs upSql in a transaction, marks applied, and refuses double-apply', async () => {
    const svc = service();
    const row = await svc.create({ name: 'm', upSql: 'CREATE TABLE t (id int)' });

    const applied = await svc.apply(row.id);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith('CREATE TABLE t (id int)');
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeInstanceOf(Date);

    await expect(svc.apply(row.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('serializes concurrent apply calls and applies DDL once', async () => {
    const svc = service();
    const row = await svc.create({ name: 'once', upSql: 'CREATE TABLE once (id int)' });
    let tail = Promise.resolve();
    mockPrisma.$transaction.mockImplementation((fn: any) => {
      const run = tail.then(() => fn(mockPrisma));
      tail = run.then(() => undefined, () => undefined);
      return run;
    });

    const results = await Promise.allSettled([svc.apply(row.id), svc.apply(row.id)]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409 });
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT 1 FROM pg_advisory_xact_lock(hashtext($1))',
      'motherbase:schema-migrations',
    );
  });

  it('apply leaves status unchanged when the DDL fails', async () => {
    const svc = service();
    const row = await svc.create({ name: 'boom', upSql: 'BAD SQL' });
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('syntax error'));

    await expect(svc.apply(row.id)).rejects.toMatchObject({ statusCode: 400 });
    expect((await svc.get(row.id)).status).toBe('pending');
  });

  it('apply re-syncs checksum when the SQL was edited after creation (drift)', async () => {
    const svc = service();
    const row = await svc.create({ name: 'm', upSql: 'CREATE TABLE t (id int)' });
    // Simulate an edit to upSql after creation, leaving the old checksum stale.
    store[0].upSql = 'CREATE TABLE t (id bigint)';

    const applied = await svc.apply(row.id);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith('CREATE TABLE t (id bigint)');
    expect(applied.checksum).toBe(createHash('sha256').update('CREATE TABLE t (id bigint)').digest('hex'));
  });

  it('rollback requires downSql and a prior applied state', async () => {
    const svc = service();
    const noDown = await svc.create({ name: 'm', upSql: 'CREATE TABLE t (id int)' });

    // not applied yet
    await expect(svc.rollback(noDown.id)).rejects.toMatchObject({ statusCode: 409 });

    await svc.apply(noDown.id);
    // applied but no downSql
    await expect(svc.rollback(noDown.id)).rejects.toMatchObject({ statusCode: 400 });

    const withDown = await svc.create({ name: 'm2', upSql: 'CREATE TABLE u (id int)', downSql: 'DROP TABLE u' });
    await svc.apply(withDown.id);
    const rolled = await svc.rollback(withDown.id);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith('DROP TABLE u');
    expect(rolled.status).toBe('rolledback');
  });

  it('rejects rollback when a later migration is still applied', async () => {
    const svc = service();
    const first = await svc.create({
      name: 'first',
      upSql: 'CREATE TABLE first (id int)',
      downSql: 'DROP TABLE first',
    });
    const second = await svc.create({
      name: 'second',
      upSql: 'CREATE TABLE second (id int)',
      downSql: 'DROP TABLE second',
    });
    await svc.apply(first.id);
    await svc.apply(second.id);

    await expect(svc.rollback(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.find(row => row.id === first.id)?.status).toBe('applied');
  });

  it('get throws 404 for an unknown id', async () => {
    await expect(service().get('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ── versions, push and repair: the CLI's half of the history ──────────────────

describe('SchemaMigrationService versions', () => {
  it('runs a multi-statement migration one statement at a time', async () => {
    // Prisma prepares raw SQL, and Postgres refuses two commands in one prepared
    // statement, so the whole file in one call failed on every real migration.
    const svc = service();
    const row = await svc.create({ name: 'two', upSql: 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);' });
    await svc.apply(row.id);
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenNthCalledWith(1, 'CREATE TABLE a (id int)');
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenNthCalledWith(2, 'CREATE TABLE b (id int)');
  });

  it('stamps a Studio migration with a free version, and refuses a taken one', async () => {
    const svc = service();
    const first = await svc.create({ name: 'a', upSql: 'SELECT 1' });
    const second = await svc.create({ name: 'b', upSql: 'SELECT 1' });
    expect(first.version).toMatch(/^\d{14}$/);
    expect(second.version > first.version).toBe(true);
    expect(first.origin).toBe('studio');

    await expect(svc.create({ name: 'c', upSql: 'SELECT 1', version: first.version })).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.create({ name: 'c', upSql: 'SELECT 1', version: '2026-01' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('push records and applies a file in one step, and refuses to apply it twice', async () => {
    const svc = service();
    const row = await svc.push({ version: '20260101000000', name: 'init', sql: 'CREATE TABLE t (id int)' });
    expect(row).toMatchObject({ version: '20260101000000', name: 'init', origin: 'cli', status: 'applied' });

    await expect(svc.push({ version: '20260101000000', name: 'init', sql: 'CREATE TABLE t (id int)' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('push records nothing when the SQL fails', async () => {
    const svc = service();
    mockPrisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('syntax error'));

    await expect(svc.push({ version: '20260101000000', name: 'bad', sql: 'NOPE' })).rejects.toMatchObject({ statusCode: 400 });
    expect(store).toHaveLength(0);
  });

  it('push takes over a pending row with the same version', async () => {
    const svc = service();
    await svc.create({ name: 'draft', upSql: 'SELECT 1', version: '20260101000000' });
    const row = await svc.push({ version: '20260101000000', name: 'init', sql: 'CREATE TABLE t (id int)' });
    expect(store).toHaveLength(1);
    expect(row).toMatchObject({ status: 'applied', upSql: 'CREATE TABLE t (id int)', origin: 'studio' });
  });

  it('repair marks applied without running SQL, and reverted without deleting the row', async () => {
    const svc = service();
    const applied = await svc.repair('20260101000000', { status: 'applied', name: 'by_hand', sql: 'CREATE TABLE t (id int)' });
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(applied).toMatchObject({ status: 'applied', name: 'by_hand', origin: 'cli' });
    expect(applied.snapshotChecksum).toBeTruthy();

    const reverted = await svc.repair('20260101000000', { status: 'reverted' });
    expect(reverted).toMatchObject({ status: 'rolledback', appliedAt: null });
    expect(store).toHaveLength(1);
    await expect(svc.repair('20269999999999', { status: 'reverted' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('stores a comment-only down section as no down SQL, so rollback refuses instead of doing nothing', async () => {
    const svc = service();
    const row = await svc.push({ version: '1', name: 'a', sql: 'SELECT 1', downSql: '-- Optional: undo it here.' });
    expect(row.downSql).toBeNull();
  });

  it('lists newest version first, with version and origin but without the snapshot', async () => {
    const svc = service();
    await svc.push({ version: '1', name: 'a', sql: 'SELECT 1' });
    const [row] = await svc.list();
    expect(mockPrisma.schemaMigration.findMany).toHaveBeenLastCalledWith({ orderBy: { version: 'desc' } });
    expect(row).toMatchObject({ version: '1', origin: 'cli', status: 'applied' });
    expect(row).not.toHaveProperty('snapshot');
  });

  it('history lists oldest version first, with the statements split out', async () => {
    const svc = service();
    await svc.push({ version: '2', name: 'second', sql: 'SELECT 2' });
    await svc.push({ version: '1', name: 'first', sql: 'SELECT 1; SELECT 11' });
    const findMany = mockPrisma.schemaMigration.findMany;
    findMany.mockImplementationOnce(async () => [...store].sort((a, b) => a.version.localeCompare(b.version)));

    const history = await svc.history();
    expect(findMany).toHaveBeenLastCalledWith({ orderBy: { version: 'asc' } });
    expect(history.map(h => h.version)).toEqual(['1', '2']);
    expect(history[0].statements).toEqual(['SELECT 1', 'SELECT 11']);
  });
});
