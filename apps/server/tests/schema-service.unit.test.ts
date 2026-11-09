import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaService } from '../services/admin/schema.service';
import {
  __primeCatalogForTests,
  makeCatalogSnapshot,
  type CatalogColumn,
  type CatalogRelKind,
} from '../services/rest-api/catalog';

const { mockQueryRawUnsafe, mockExecuteRawUnsafe } = vi.hoisted(() => ({
  mockQueryRawUnsafe: vi.fn(),
  mockExecuteRawUnsafe: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  default: {
    $queryRawUnsafe: mockQueryRawUnsafe,
    $executeRawUnsafe: mockExecuteRawUnsafe,
  },
}));

// listTables now projects the shared catalog snapshot (the single table-shape
// source that REST reads too), so these tests install a snapshot rather than
// stubbing an introspection query. Snapshot fidelity against real Postgres is
// covered by catalog.integration.test.ts.
function col(name: string, pgType: string, overrides: Partial<CatalogColumn> = {}, position = 1): CatalogColumn {
  return {
    name,
    pgType,
    formattedType: pgType,
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    defaultExpr: null,
    isPk: false,
    isGenerated: false,
    isArray: false,
    enumType: null,
    typeKind: 'b',
    position,
    ...overrides,
  };
}

function fixtureTable(
  name: string,
  columns: CatalogColumn[],
  extra: { schema?: string; kind?: CatalogRelKind; primaryKey?: string[]; foreignKeys?: any[] } = {}
) {
  return {
    schema: extra.schema ?? 'public',
    name,
    kind: extra.kind ?? ('table' as CatalogRelKind),
    columns,
    primaryKey: extra.primaryKey ?? [],
    foreignKeys: extra.foreignKeys ?? [],
    rlsEnabled: false,
    rlsForced: false,
  };
}

afterAll(() => __primeCatalogForTests(null));

describe('SchemaService.listTables', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('groups columns by table', async () => {
    __primeCatalogForTests(
      makeCatalogSnapshot({
        tables: [
          fixtureTable(
            'users',
            [col('id', 'uuid', { isPk: true }, 1), col('email', 'text', {}, 2)],
            { primaryKey: ['id'] }
          ),
          fixtureTable('files', [col('id', 'uuid', { isPk: true }, 1)], { primaryKey: ['id'] }),
        ],
      })
    );

    const result = await service.listTables();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('users');
    expect(result[0].columns).toHaveLength(2);
    expect(result[0].columns[0]).toMatchObject({
      name: 'id',
      type: 'uuid',
      nullable: false,
      isPrimaryKey: true,
    });
    expect(result[1].name).toBe('files');
  });

  it('returns empty array when no tables', async () => {
    __primeCatalogForTests(makeCatalogSnapshot({ tables: [] }));

    const result = await service.listTables();

    expect(result).toEqual([]);
  });

  it('scopes the list to the requested schema', async () => {
    __primeCatalogForTests(
      makeCatalogSnapshot({
        tables: [
          fixtureTable('widgets', [col('id', 'uuid')]),
          fixtureTable('files', [col('id', 'uuid')], { schema: 'storage' }),
        ],
      })
    );

    expect((await service.listTables()).map(t => t.name)).toEqual(['widgets']);
    expect((await service.listTables('storage')).map(t => t.name)).toEqual(['files']);
  });

  it('returns mutable rows so callers cannot corrupt the shared snapshot', async () => {
    __primeCatalogForTests(
      makeCatalogSnapshot({ tables: [fixtureTable('widgets', [col('id', 'uuid')])] })
    );

    const [first] = await service.listTables();
    first.columns.push({ name: 'injected', type: 'text', nullable: true, default: null, isPrimaryKey: false });

    const [again] = await service.listTables();
    expect(again.columns.map(c => c.name)).toEqual(['id']);
  });
});

describe('SchemaService DDL', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('addColumn executes ALTER TABLE ADD COLUMN', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.addColumn('posts', { name: 'title', type: 'text', nullable: true, default: null });

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "public"."posts" ADD COLUMN "title" text');
  });

  it('dropColumn executes ALTER TABLE DROP COLUMN', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.dropColumn('posts', 'title');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "public"."posts" DROP COLUMN "title"');
  });

  it('dropTable qualifies with the given schema', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.dropTable('orders', 'storage');

    expect(mockExecuteRawUnsafe.mock.calls[0][0]).toContain('"storage"."orders"');
  });

  it('dropTable defaults to the public schema', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.dropTable('orders');

    expect(mockExecuteRawUnsafe.mock.calls[0][0]).toContain('"public"."orders"');
  });

  it('executeRaw executes the provided SQL', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.executeRaw('CREATE TABLE "posts" (id uuid PRIMARY KEY)');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('CREATE TABLE "posts" (id uuid PRIMARY KEY)');
  });
});

describe('SchemaService executeRaw reserved-name guard', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('rejects an unqualified CREATE TABLE whose name collides with a Prisma model dbName', async () => {
    await expect(
      service.executeRaw('CREATE TABLE "users" (id uuid PRIMARY KEY)')
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a collision regardless of case', async () => {
    await expect(
      service.executeRaw('CREATE TABLE "Users" (id uuid PRIMARY KEY)')
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('allows creating a table whose name does not collide with any system table', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.executeRaw('CREATE TABLE "widgets" (id uuid PRIMARY KEY)');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('CREATE TABLE "widgets" (id uuid PRIMARY KEY)');
  });
});

describe('SchemaService indexes', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('listIndexes queries pg indexes for the table', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { indexname: 'users_email_idx', indexdef: 'CREATE UNIQUE INDEX ...', indisunique: true },
    ]);

    const result = await service.listIndexes('users');

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_index'), 'users', 'public');
    expect(result[0].name).toBe('users_email_idx');
    expect(result[0].unique).toBe(true);
  });
});

describe('SchemaService.listGraph', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('returns schema nodes and foreign key edges', async () => {
    __primeCatalogForTests(
      makeCatalogSnapshot({
        tables: [
          fixtureTable(
            'posts',
            [col('id', 'uuid', { isPk: true }, 1), col('user_id', 'uuid', {}, 2)],
            { primaryKey: ['id'] }
          ),
          fixtureTable('users', [col('id', 'uuid', { isPk: true }, 1)], { primaryKey: ['id'] }),
        ],
      })
    );
    // listGraph still reads its edges from information_schema; only the node
    // (table) side moved to the catalog.
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        constraint_name: 'posts_user_id_fkey',
        from_table: 'posts',
        from_column: 'user_id',
        to_table: 'users',
        to_column: 'id',
      },
    ]);

    const graph = await service.listGraph();

    expect(graph.nodes).toContainEqual(expect.objectContaining({ table: 'posts', primaryKey: 'id' }));
    expect(graph.edges).toEqual([
      {
        constraint: 'posts_user_id_fkey',
        fromTable: 'posts',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      },
    ]);
  });
});

describe('SchemaService functions', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('listFunctions queries pg_proc', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { name: 'get_count', return_type: 'integer', language: 'plpgsql', definition: 'CREATE OR REPLACE FUNCTION ...' },
    ]);

    const result = await service.listFunctions();

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_proc'), 'public');
    expect(result[0].name).toBe('get_count');
  });
});

describe('SchemaService triggers', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('listTriggers queries pg_trigger and decodes tgtype', async () => {
    // tgtype 23 = ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        name: 'set_updated_at',
        table_name: 'posts',
        function_name: 'touch_updated_at',
        tgtype: 23,
        tgenabled: 'O',
        definition: 'CREATE TRIGGER set_updated_at ...',
      },
      {
        name: 'audit_del',
        table_name: 'posts',
        function_name: 'log_delete',
        tgtype: 8, // STATEMENT | AFTER | DELETE
        tgenabled: 'D',
        definition: 'CREATE TRIGGER audit_del ...',
      },
    ]);

    const result = await service.listTriggers();

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_trigger'), 'public');
    expect(result[0]).toMatchObject({
      name: 'set_updated_at',
      table: 'posts',
      timing: 'BEFORE',
      orientation: 'ROW',
      function: 'touch_updated_at',
      enabled: true,
    });
    expect(result[0].events).toEqual(['INSERT', 'UPDATE']);
    expect(result[1]).toMatchObject({ timing: 'AFTER', orientation: 'STATEMENT', enabled: false });
    expect(result[1].events).toEqual(['DELETE']);
  });

  it('listTriggerFunctions keeps only functions returning trigger', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { name: 'touch_updated_at', return_type: 'trigger', language: 'plpgsql', definition: '...' },
      { name: 'get_count', return_type: 'integer', language: 'plpgsql', definition: '...' },
    ]);

    const result = await service.listTriggerFunctions();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('touch_updated_at');
  });

  it('createTrigger executes the provided SQL', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.createTrigger('CREATE TRIGGER t AFTER INSERT ON "posts" FOR EACH ROW EXECUTE FUNCTION f()');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith(
      'CREATE TRIGGER t AFTER INSERT ON "posts" FOR EACH ROW EXECUTE FUNCTION f()'
    );
  });

  it('setTriggerEnabled toggles ENABLE/DISABLE with quoted idents', async () => {
    mockExecuteRawUnsafe.mockResolvedValue(0);

    await service.setTriggerEnabled('posts', 'set_updated_at', false);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "public"."posts" DISABLE TRIGGER "set_updated_at"');

    await service.setTriggerEnabled('posts', 'set_updated_at', true);
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('ALTER TABLE "public"."posts" ENABLE TRIGGER "set_updated_at"');
  });

  it('dropTrigger executes DROP TRIGGER IF EXISTS', async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(0);

    await service.dropTrigger('posts', 'set_updated_at');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('DROP TRIGGER IF EXISTS "set_updated_at" ON "public"."posts"');
  });

  it('dropTrigger rejects invalid identifiers', async () => {
    await expect(service.dropTrigger('posts', 'bad; DROP TABLE x')).rejects.toThrow();
  });
});

describe('SchemaService extensions', () => {
  let service: InstanceType<typeof SchemaService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SchemaService({} as any);
  });

  it('listExtensions queries pg_available_extensions', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { name: 'uuid-ossp', default_version: '1.1', installed_version: '1.1', comment: 'UUIDs' },
      { name: 'pg_vector', default_version: '0.7.0', installed_version: null, comment: 'vectors' },
    ]);

    const result = await service.listExtensions();

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_available_extensions'));
    expect(result[0].installed).toBe(true);
    expect(result[1].installed).toBe(false);
  });

  // Extension names are not quoteIdent-shaped: `uuid-ossp` is legal and that
  // regex rejects hyphens. The guard is an allowlist lookup instead, so these
  // tests pin both halves: a legal hyphenated name must survive, and anything
  // Postgres does not report must never reach the DDL string.
  it('enableExtension accepts a hyphenated name and quotes it', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{ name: 'uuid-ossp' }]);

    await service.enableExtension('uuid-ossp');

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_available_extensions'),
      'uuid-ossp'
    );
    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  });

  it('enableExtension rejects a name Postgres does not report, before any DDL', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);

    await expect(service.enableExtension('vector"; DROP TABLE users; --')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('enableExtension rejects an empty or oversized name without querying', async () => {
    await expect(service.enableExtension('')).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.enableExtension('x'.repeat(64))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('extension identifiers double any embedded quote', async () => {
    // Defence in depth: even if a catalog row somehow carried a quote, the
    // identifier it produces must stay a single closed identifier.
    mockQueryRawUnsafe.mockResolvedValueOnce([{ name: 'we"ird' }]);

    await service.disableExtension('we"ird');

    expect(mockExecuteRawUnsafe).toHaveBeenCalledWith('DROP EXTENSION IF EXISTS "we""ird"');
  });
});
