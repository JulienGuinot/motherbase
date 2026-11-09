import { describe, expect, it, vi } from 'vitest';
import { RealtimeOutboxService, serializeDeleteAudience } from '../services/realtime/realtime-outbox.service';
import { RealtimeOutboxSchedulerService } from '../services/realtime/realtime-outbox-scheduler.service';

const model = { model: 'Item', dbName: 'items' };

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    model: 'Item',
    dbName: 'items',
    action: 'created',
    payloads: [{ id: 'row-1' }],
    deleteAudience: null,
    status: 'processing',
    attempts: 0,
    ...overrides,
  };
}

function workerHarness(currentEvent: ReturnType<typeof event> | null, deliver = vi.fn(async () => {})) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    $queryRawUnsafe: vi.fn(async (..._args: unknown[]) => (currentEvent ? [currentEvent] : [])),
    realtimeOutbox: { updateMany },
  };
  const service = new RealtimeOutboxService({
    prisma,
    RealtimeBroadcastService: { deliverPersisted: deliver },
  } as any);
  return { service, prisma, updateMany, deliver };
}

describe('RealtimeOutboxService', () => {
  it('temporarily elevates only after mutation and restores the data-plane role', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT current_user')) {
          return { rows: [{ currentRole: 'authenticated' }] };
        }
        return { rows: [] };
      }),
    };
    const audience = {
      mode: 'restricted' as const,
      socketIdsByRowId: new Map([['row-1', new Set(['socket-a'])]]),
    };
    const service = new RealtimeOutboxService({} as any);

    await service.enqueue(client as any, model, 'deleted', [{ id: 'row-1' }], audience);

    expect(queries.map(query => query.sql)).toEqual([
      'SELECT current_user AS "currentRole"',
      'RESET ROLE',
      expect.stringContaining('INSERT INTO "platform"."realtime_outbox"'),
      'NOTIFY realtime_outbox',
      'SET LOCAL ROLE authenticated',
    ]);
    expect(queries[2].params?.[5]).toBe(
      JSON.stringify({
        mode: 'restricted',
        socketIdsByRowId: { 'row-1': ['socket-a'] },
      })
    );
    expect(JSON.stringify(queries[2].params)).not.toContain('user');
  });

  it('accepts a service_role transaction', async () => {
    // Regression: service_role was missing from the outbox's own role list, so
    // every REST write made with a secret key threw here and rolled the data
    // write back with an opaque 500.
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return sql.startsWith('SELECT current_user')
          ? { rows: [{ currentRole: 'service_role' }] }
          : { rows: [] };
      }),
    };
    const service = new RealtimeOutboxService({} as any);

    await expect(
      service.enqueue(client as any, model, 'created', [{ id: 'row-1' }])
    ).resolves.toBeUndefined();
    expect(queries).toContain('SET LOCAL ROLE service_role');
  });

  it('rejects a transaction running as an unexpected role', async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith('SELECT current_user') ? { rows: [{ currentRole: 'postgres' }] } : { rows: [] }
      ),
    };
    const service = new RealtimeOutboxService({} as any);

    await expect(service.enqueue(client as any, model, 'created', [{ id: 'row-1' }])).rejects.toThrow(
      'Unexpected data-plane role'
    );
  });

  it('claims pending or expired processing events and acknowledges with the same lease token', async () => {
    const harness = workerHarness(event());

    await expect(harness.service.processNext()).resolves.toBe(true);

    const [claimSql, leaseToken] = harness.prisma.$queryRawUnsafe.mock.calls[0];
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('"status" = \'processing\'');
    expect(claimSql).toContain('"leaseExpiresAt" < NOW()');
    expect(claimSql).toContain('ORDER BY "createdAt", "id"');
    expect(harness.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'processing', leaseToken },
      data: expect.objectContaining({
        status: 'completed',
        leaseToken: null,
        processedAt: expect.any(Date),
      }),
    });
  });

  it('moves the eighth failed delivery to dead-letter without losing its error', async () => {
    const deliver = vi.fn(async () => {
      throw new Error('RLS visibility unavailable');
    });
    const harness = workerHarness(event({ attempts: 7 }), deliver);

    await expect(harness.service.processNext()).resolves.toBe(true);

    const leaseToken = harness.prisma.$queryRawUnsafe.mock.calls[0][1];
    expect(harness.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', status: 'processing', leaseToken },
      data: expect.objectContaining({
        status: 'failed',
        attempts: 8,
        lastError: 'RLS visibility unavailable',
        processedAt: expect.any(Date),
      }),
    });
  });

  it('serializes delete recipients as socket ids, never subscriber identities', () => {
    const serialized = serializeDeleteAudience({
      mode: 'restricted',
      socketIdsByRowId: new Map([['row-1', new Set(['socket-a'])]]),
    });

    expect(serialized).toEqual({
      mode: 'restricted',
      socketIdsByRowId: { 'row-1': ['socket-a'] },
    });
    expect(serialized).not.toHaveProperty('identity');
    expect(serialized).not.toHaveProperty('user');
  });
});

describe('RealtimeOutboxSchedulerService', () => {
  it('drains at most 100 events sequentially in one run', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const processNext = vi.fn(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return true;
    });
    const scheduler = new RealtimeOutboxSchedulerService({
      RealtimeOutboxService: { processNext },
      JobLedgerService: { note: async () => {} },
    } as any);

    // Retention is not this worker's job: it drains and stops. Pruning belongs
    // to DataRetentionService, which is what `realtime.retention` configures.
    await expect(scheduler.runOnce()).resolves.toEqual({ ran: true, claimed: 100 });

    expect(calls).toBe(100);
    expect(maxActive).toBe(1);
  });
});
