import { parsePrefer } from '../services/rest-api/http-semantics';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestApiService } from '../services/rest-api/rest-api.service';
import {
  __primeCatalogForTests,
  makeCatalogSnapshot,
  type CatalogColumn,
  type CatalogRelKind,
} from '../services/rest-api/catalog';

const RETURN_ROWS = { prefer: parsePrefer('return=representation') };


// SQL capture and its privilege boundary are exercised against PostgreSQL in
// rest-write-only.integration.test.ts; these tests focus on service routing.
vi.mock('../services/rest-api/capture-write', () => ({
  captureWrite: async (_client: unknown, _relation: string, write: () => Promise<any>) => {
    const response = await write();
    return {
      response: { ...response, rowCount: response.rows.length },
      changes: response.rows.map((row: unknown) => ({
        action: response.command === 'UPDATE' ? 'updated' : response.command === 'DELETE' ? 'deleted' : 'created',
        row,
      })),
    };
  },
}));

/**
 * The REST service resolves models from the catalog snapshot, so these unit
 * tests install one instead of touching a database. `catalog.integration.test.ts`
 * covers the snapshot's own fidelity against real Postgres.
 */
function col(name: string, overrides: Partial<CatalogColumn> = {}, position = 1): CatalogColumn {
  return {
    name,
    pgType: 'text',
    formattedType: 'text',
    tsType: 'string',
    nullable: true,
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

function table(name: string, columns: string[], kind: CatalogRelKind = 'table') {
  return {
    schema: 'public',
    name,
    kind,
    rlsEnabled: true,
    primaryKey: ['id'],
    columns: columns.map((columnName, index) =>
      col(columnName, columnName === 'id' ? { isPk: true, nullable: false } : {}, index + 1)
    ),
  };
}

beforeEach(() => {
  __primeCatalogForTests(
    makeCatalogSnapshot({
      tables: [
        table('files', ['id', 'ownerId', 'bucket']),
        table('notes', ['id', 'ownerId', 'title']),
        // A `public` table whose name collides with a system table: the
        // defence-in-depth allowlist must still refuse it.
        table('app_settings', ['id', 'key', 'value']),
        // Views cannot carry RLS, so they are not REST-exposable.
        table('files_view', ['id', 'bucket'], 'view'),
      ],
    })
  );
});

afterAll(() => __primeCatalogForTests(null));

/**
 * Fake RlsPool double: withRlsTx runs the callback against a fake client whose
 * `query` is driven by the provided handler, recording every (sql, params) call.
 * Like the real pool, it answers the `rlsGate` it was opened with: every gated
 * table has RLS on, unless `rlsState` says otherwise.
 */
function makeFakePool(queryImpl: (sql: string, params: any[]) => any, rlsState: boolean | 'missing' = true) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const rows = await queryImpl(sql, params);
      return { rows, command: sql.split(' ')[0] };
    }),
  };
  const withRlsTx = vi.fn((_ctx: any, fn: any, options?: { rlsGate?: string[] }) =>
    fn(client, new Set(rlsState === true ? options?.rlsGate ?? [] : [])));
  return { RlsPool: { withRlsTx }, client, calls };
}

function makeService(
  rows: any[] = [{ id: 'f1', ownerId: 'u1', bucket: 'public' }],
  rlsState: boolean | 'missing' = true
) {
  const { RlsPool, client, calls } = makeFakePool(() => rows, rlsState);
  const deleteAudience = { mode: 'all' as const, socketIds: new Set(['sock1']) };
  const RealtimeBroadcastService = {
    captureDeleteAudience: vi.fn(async () => deleteAudience),
  };
  const RealtimeOutboxService = { enqueue: vi.fn(async () => {}) };
  const EventDispatcherService = { dispatch: vi.fn(async () => {}) };
  return {
    service: new RestApiService({
      prisma: {},
      RlsPool,
      RealtimeBroadcastService,
      RealtimeOutboxService,
      EventDispatcherService,
    } as any),
    RlsPool,
    client,
    RealtimeBroadcastService,
    RealtimeOutboxService,
    EventDispatcherService,
    deleteAudience,
    calls,
  };
}

/** Service whose control-plane existence probe answers `existsResult`. */
function makeExistsProbeService(existsResult: boolean) {
  const { RlsPool } = makeFakePool(() => []);
  const prisma = {
    $queryRawUnsafe: vi.fn(async () => [{ exists: existsResult }]),
  };
  const service = new RestApiService({
    prisma,
    RlsPool,
    RealtimeBroadcastService: { captureDeleteAudience: vi.fn(async () => ({ mode: 'disabled' as const })) },
    RealtimeOutboxService: { enqueue: vi.fn(async () => {}) },
  } as any);
  return { service, prisma };
}

describe('RestApiService', () => {
  it('resolves models by table name and builds a filtered SQL query', async () => {
    const { service, calls } = makeService([{ id: 'f1', ownerId: 'u1', bucket: 'public' }]);
    const result = await service.handleGet('files', { bucket: 'eq.public', limit: '5' }, { id: 'u1' });
    const selectCall = calls.find(call => call.sql.startsWith('SELECT * FROM'))!;
    expect(selectCall.sql).toContain('SELECT * FROM "public"."files"');
    expect(selectCall.sql).toContain('WHERE "bucket" = $1');
    expect(selectCall.sql).toContain('LIMIT 5');
    expect(selectCall.params).toEqual(['public']);
    expect(result).toEqual([{ id: 'f1', ownerId: 'u1', bucket: 'public' }]);
  });

  it('lists every REST-exposable public table and nothing else', async () => {
    const { service } = makeService();
    const models = await service.listModels();

    expect(models.map(m => m.model).sort()).toEqual(['app_settings', 'files', 'notes']);
    expect(models.every(m => m.schema === 'public')).toBe(true);
    expect(models.find(m => m.model === 'files')?.fields.map(f => f.name)).toEqual([
      'id',
      'ownerId',
      'bucket',
    ]);
    // The blocked name is listed but flagged, so the advisor and realtime admin
    // can still see it while the handlers refuse it.
    expect(models.find(m => m.model === 'app_settings')?.system).toBe(true);
  });

  it('refuses a table whose name is on the defence-in-depth block list', async () => {
    const { service } = makeService();
    await expect(service.handleGet('app_settings', {}, { id: 'u1' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('does not expose views, which cannot carry row-level security', async () => {
    const { service } = makeService();
    await expect(service.handleGet('files_view', {}, { id: 'u1' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('clamps the GET row limit to the configured api.rest.maxRows', async () => {
    const { RlsPool, calls } = makeFakePool(() => [{ id: 'f1', ownerId: 'u1', bucket: 'public' }]);
    const service = new RestApiService({
      prisma: {},
      RlsPool,
      RealtimeBroadcastService: { captureDeleteAudience: vi.fn(async () => ({ mode: 'all', socketIds: new Set() })) },
      RealtimeOutboxService: { enqueue: vi.fn(async () => {}) },
      EventDispatcherService: { dispatch: vi.fn(async () => {}) },
      SettingsService: { get: vi.fn(async () => ({ maxRows: 10 })) },
    } as any);

    await service.handleGet('files', { limit: '500' }, { id: 'u1' });

    const selectCall = calls.find(call => call.sql.startsWith('SELECT * FROM'))!;
    expect(selectCall.sql).toContain('LIMIT 10');
  });

  // A select with no limit used to default to 100 regardless of maxRows, which
  // silently truncated a list ported from Supabase. PostgREST returns up to
  // db-max-rows, so an unbounded read now takes the whole ceiling.
  it('defaults an unbounded GET to api.rest.maxRows rather than to 100', async () => {
    const { RlsPool, calls } = makeFakePool(() => [{ id: 'f1', ownerId: 'u1', bucket: 'public' }]);
    const service = new RestApiService({
      prisma: {},
      RlsPool,
      RealtimeBroadcastService: { captureDeleteAudience: vi.fn(async () => ({ mode: 'all', socketIds: new Set() })) },
      RealtimeOutboxService: { enqueue: vi.fn(async () => {}) },
      EventDispatcherService: { dispatch: vi.fn(async () => {}) },
      SettingsService: { get: vi.fn(async () => ({ maxRows: 250 })) },
    } as any);

    await service.handleGet('files', {}, { id: 'u1' });

    const selectCall = calls.find(call => call.sql.startsWith('SELECT * FROM'))!;
    expect(selectCall.sql).toContain('LIMIT 250');
  });

  it('runs reads inside an RLS transaction scoped to the request user', async () => {
    const authed = makeService();
    await authed.service.handleGet('files', {}, { id: 'u1' });
    expect(authed.RlsPool.withRlsTx).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'authenticated' }),
      expect.any(Function),
      { rlsGate: ['files'] },
    );

    const anon = makeService();
    await anon.service.handleGet('files', {}, undefined);
    expect(anon.RlsPool.withRlsTx).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'anon' }),
      expect.any(Function),
      { rlsGate: ['files'] },
    );
  });

  it.each([
    ['GET', (service: RestApiService) => service.handleGet('files', {}, { id: 'u1' })],
    ['POST', (service: RestApiService) => service.handlePost('files', { bucket: 'b' }, { id: 'u1' }, RETURN_ROWS)],
    [
      'PATCH',
      (service: RestApiService) =>
        service.handlePatch('files', { id: 'eq.f1' }, { bucket: 'b' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS),
    ],
    ['DELETE', (service: RestApiService) => service.handleDelete('files', { id: 'eq.f1' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)],
  ])('refuses %s before data SQL when public-table RLS is disabled', async (_method, request) => {
    const { service, calls, RlsPool } = makeService([], false);

    await expect(request(service)).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toHaveLength(0);
    // The gate is asked by the statement that opens the transaction.
    expect(RlsPool.withRlsTx.mock.calls[0][2]).toEqual({ rlsGate: ['files'] });
  });

  it('fails closed when the public-table RLS state cannot be resolved', async () => {
    const { service, calls } = makeService([], 'missing');

    await expect(service.handleGet('files', {}, { id: 'u1' })).rejects.toMatchObject({ statusCode: 403 });
    expect(calls).toHaveLength(0);
  });

  it('handles post patch and delete', async () => {
    const { service, calls } = makeService([{ id: 'new', bucket: 'b', ownerId: 'u1' }]);
    await expect(service.handlePost('files', { bucket: 'b' }, { id: 'u1' }, RETURN_ROWS)).resolves.toEqual([
      { id: 'new', bucket: 'b', ownerId: 'u1' },
    ]);
    await service.handlePatch('files', { id: 'eq.f1' }, { bucket: 'c' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS);
    await service.handleDelete('files', { id: 'eq.f1' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS);

    const insertCall = calls.find(c => c.sql.startsWith('INSERT INTO'));
    const updateCall = calls.find(c => c.sql.startsWith('UPDATE'));
    const deleteCall = calls.find(c => c.sql.startsWith('DELETE'));
    expect(insertCall?.sql).toContain('INSERT INTO "public"."files"');
    expect(updateCall?.sql).toContain('WHERE "id" = $2');
    expect(deleteCall?.sql).toContain('WHERE ("id" = $1) AND xmin::text = ANY($2::text[])');
  });

  it('reports a policy block to an admin when a scoped mutation affects no rows but the row exists', async () => {
    const { service, prisma } = makeExistsProbeService(true);

    await expect(
      service.handlePatch('files', { id: 'eq.f1' }, { bucket: 'c' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT EXISTS (SELECT 1 FROM "public"."files" WHERE "id" = $1 LIMIT 1) AS "exists"',
      'f1'
    );
  });

  it('reports a policy block to an admin when a scoped delete affects no rows but the row exists', async () => {
    const { service, prisma } = makeExistsProbeService(true);

    await expect(service.handleDelete('files', { id: 'eq.f1' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('returns the same 404 to non-admins for missing and RLS-hidden rows without a privileged lookup', async () => {
    const { service, prisma } = makeExistsProbeService(true);

    await expect(
      service.handlePatch('files', { id: 'eq.hidden' }, { bucket: 'c' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.handleDelete('files', { id: 'eq.missing' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports not found when an admin mutation matches no rows at all', async () => {
    const { service } = makeExistsProbeService(false);

    await expect(
      service.handlePatch('files', { id: 'eq.missing' }, { bucket: 'c' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports a policy block when a scoped dynamic mutation returns no rows but the row exists', async () => {
    const { service, prisma } = makeExistsProbeService(true);

    await expect(
      service.handlePatch('notes', { id: 'eq.r1' }, { title: 'changed' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.$queryRawUnsafe).toHaveBeenLastCalledWith(
      'SELECT EXISTS (SELECT 1 FROM "public"."notes" WHERE "id" = $1 LIMIT 1) AS "exists"',
      'r1'
    );
  });

  it('reports a policy block when a scoped dynamic delete returns no rows but the row exists', async () => {
    const { service } = makeExistsProbeService(true);

    await expect(service.handleDelete('notes', { id: 'eq.r1' }, { id: 'u1', role: 'ADMIN' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses an unfiltered bulk mutation from a non-admin', async () => {
    const { service } = makeService();

    await expect(service.handlePatch('files', {}, { bucket: 'c' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service.handleDelete('files', {}, { id: 'u1', role: 'USER' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('captures delete audience and persists it with the delete transaction client', async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT "id", xmin')) {
          order.push('select');
          return { rows: [{ id: 'f1', _restXmin: '42' }] };
        }
        if (sql.startsWith('DELETE')) {
          order.push('delete');
          return { rows: [{ id: 'f1' }], command: 'DELETE' };
        }
        return { rows: [] };
      }),
    };
    const RlsPool = { withRlsTx: vi.fn(async (_ctx: any, run: any) => run(client, new Set(['files']))) };
    const audience = { mode: 'restricted' as const, socketIdsByRowId: new Map() };
    const RealtimeBroadcastService = {
      captureDeleteAudience: vi.fn(async () => {
        order.push('capture');
        return audience;
      }),
    };
    const RealtimeOutboxService = {
      enqueue: vi.fn(async (usedClient: unknown) => {
        expect(usedClient).toBe(client);
        order.push('outbox');
      }),
    };
    const EventDispatcherService = {
      dispatch: vi.fn(async () => order.push('webhook')),
    };
    const service = new RestApiService({
      prisma: {},
      RlsPool,
      RealtimeBroadcastService,
      RealtimeOutboxService,
      EventDispatcherService,
    } as any);

    await service.handleDelete('files', { id: 'eq.f1' }, { id: 'u1', role: 'USER' }, RETURN_ROWS);

    expect(order).toEqual(['select', 'capture', 'delete', 'outbox', 'webhook']);
    expect(RealtimeOutboxService.enqueue).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ model: 'files', dbName: 'files' }),
      'deleted',
      [{ id: 'f1' }],
      audience
    );
  });

  it('rejects empty patch bodies instead of returning a fake success', async () => {
    const { service } = makeService();

    await expect(service.handlePatch('files', { id: 'eq.f1' }, {}, { id: 'u1' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('persists created rows before dispatching post-commit webhooks', async () => {
    const harness = makeService([{ id: 'new', bucket: 'b' }]);
    await harness.service.handlePost('files', { bucket: 'b' }, { id: 'u1' }, RETURN_ROWS);

    expect(harness.RealtimeOutboxService.enqueue).toHaveBeenCalledWith(
      harness.client,
      expect.objectContaining({ model: 'files' }),
      'created',
      [{ id: 'new', bucket: 'b' }]
    );
    expect(harness.EventDispatcherService.dispatch).toHaveBeenCalledOnce();
  });

  it('rejects unknown models', async () => {
    await expect(makeService().service.handleGet('Nope', {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('resolves table names case-sensitively, the way Postgres does', async () => {
    await expect(makeService().service.handleGet('Files', {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('validates fields for dynamic tables', async () => {
    const { service, calls } = makeService([{ id: 'r1', ownerId: 'u1', title: 'hello' }]);
    const result = await service.handleGet('notes', { title: 'eq.hello', order: 'id.asc' }, { id: 'u1' });
    const selectCall = calls.find(call => call.sql.startsWith('SELECT * FROM'))!;
    expect(selectCall.sql).toContain('WHERE "title" = $1');
    expect(selectCall.params).toEqual(['hello']);
    expect(result).toEqual([{ id: 'r1', ownerId: 'u1', title: 'hello' }]);

    await expect(service.handleGet('notes', { 'bad-field': 'eq.x' }, { id: 'u1' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
