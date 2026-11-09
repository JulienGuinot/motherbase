import { describe, expect, it, vi } from 'vitest';
import { getGroup } from '../config/settings';
import {
  DataRetentionService,
  type DataRetentionConfig,
  type DataRetentionRunSummary,
} from '../services/admin/data-retention.service';
import { DataRetentionSchedulerService } from '../services/admin/data-retention-scheduler.service';

const DEFAULT_CONFIG: DataRetentionConfig = {
  enabled: true,
  cron: '15 4 * * *',
  webhookDeliveryDays: 30,
  edgeFunctionLogDays: 7,
  jobRunDays: 30,
  authAuditLogDays: 90,
  batchSize: 3,
  maxBatchesPerRun: 5,
};

type QueryCall = { sql: string; values: unknown[] };

function retentionHarness(
  webhookResponses: Array<number | Error>,
  edgeResponses: Array<number | Error>,
  config: DataRetentionConfig = DEFAULT_CONFIG,
  // Stored log lines are their own group with their own switch; off unless a
  // test is about them, so the other targets' call counts stay readable.
  logs: unknown = { enabled: false },
  // The scheduler run ledger owns its own DELETE (it is written from inside
  // scheduler catch blocks and must degrade rather than throw), so retention
  // drives it through JobLedgerService rather than a raw query here.
  jobRunResponses: number[] = [0],
  auditResponses: number[] = [0]
) {
  const calls: QueryCall[] = [];
  const pruneBatch = vi.fn(async () => jobRunResponses.shift() ?? 0);
  const deleteAuditBatch = vi.fn(async () => auditResponses.shift() ?? 0);
  const nextRows = (responses: Array<number | Error>) => {
    const response = responses.shift() ?? 0;
    if (response instanceof Error) throw response;
    return Array.from({ length: response }, (_, index) => ({ id: String(index) }));
  };
  const prisma = {
    $queryRaw: vi.fn(async (query: any) => {
      const sql = query.strings.join('?');
      calls.push({ sql, values: query.values });
      return sql.includes('webhook_deliveries') ? nextRows(webhookResponses) : nextRows(edgeResponses);
    }),
  };
  const SettingsService = {
    get: vi.fn(async (key: string) => (key === 'logs.retention' ? logs : config)),
  };
  return {
    service: new DataRetentionService({
      prisma,
      SettingsService,
      JobLedgerService: { pruneBatch },
      AuthAuditService: { deleteBatch: deleteAuditBatch },
    } as any),
    calls,
    prisma,
    pruneBatch,
    deleteAuditBatch,
  };
}

describe('DataRetentionService', () => {
  it('uses independent age thresholds and ordered bounded batches', async () => {
    const { service, calls } = retentionHarness([3, 3, 1], [2]);
    const now = new Date('2026-07-20T12:00:00.000Z');

    const result = await service.runOnce(now);

    expect(result.webhookDeliveries).toEqual({ deleted: 7, batches: 3, truncated: false });
    expect(result.edgeFunctionLogs).toEqual({ deleted: 2, batches: 1, truncated: false });
    expect(calls).toHaveLength(4);
    expect(calls[0].sql).toContain('ORDER BY "createdAt", "id"');
    expect(calls[3].sql).toContain('ORDER BY "invokedAt", "id"');
    expect(calls[0].values).toEqual([new Date('2026-06-20T12:00:00.000Z'), 3]);
    expect(calls[3].values).toEqual([new Date('2026-07-13T12:00:00.000Z'), 3]);
  });

  it('caps work per run and leaves continuation to the next scheduled tick', async () => {
    const config = { ...DEFAULT_CONFIG, batchSize: 2, maxBatchesPerRun: 2 };
    const { service, calls } = retentionHarness([2, 2], [0], config);

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(result.webhookDeliveries).toEqual({ deleted: 4, batches: 2, truncated: true });
    expect(calls.filter(call => call.sql.includes('webhook_deliveries'))).toHaveLength(2);
  });

  it('is idempotent when no expired rows remain', async () => {
    const { service } = retentionHarness([0, 0], [0, 0]);

    const first = await service.runOnce();
    const second = await service.runOnce();

    expect(first.webhookDeliveries.deleted).toBe(0);
    expect(second).toEqual(first);
  });

  it('reports partial progress and continues with the other target after an error', async () => {
    const config = { ...DEFAULT_CONFIG, batchSize: 2 };
    const { service } = retentionHarness([2, new Error('webhook delete failed')], [1], config);

    const result = await service.runOnce();

    expect(result.webhookDeliveries).toEqual({
      deleted: 2,
      batches: 1,
      truncated: false,
      error: 'webhook delete failed',
    });
    expect(result.edgeFunctionLogs).toEqual({ deleted: 1, batches: 1, truncated: false });
  });

  it('does nothing when retention is disabled', async () => {
    const { service, prisma } = retentionHarness([], [], { ...DEFAULT_CONFIG, enabled: false });

    await expect(service.runOnce()).resolves.toMatchObject({ ran: false });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('keeps safe defaults and validates operational bounds', () => {
    const group = getGroup('data.retention');
    expect(group?.schema.parse({})).toMatchObject({
      enabled: true,
      webhookDeliveryDays: 30,
      edgeFunctionLogDays: 30,
      batchSize: 500,
      maxBatchesPerRun: 20,
    });
    expect(() => group?.schema.parse({ batchSize: 1001 })).toThrow();
  });

  it('is enabled by default and supports explicit env opt-out', () => {
    const group = getGroup('data.retention')!;
    const previous = process.env.DATA_RETENTION_ENABLED;
    try {
      delete process.env.DATA_RETENTION_ENABLED;
      expect(group.envFallback().enabled).toBe(true);
      process.env.DATA_RETENTION_ENABLED = 'false';
      expect(group.envFallback().enabled).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DATA_RETENTION_ENABLED;
      else process.env.DATA_RETENTION_ENABLED = previous;
    }
  });
});

const EMPTY_SUMMARY: DataRetentionRunSummary = {
  ran: true,
  webhookDeliveries: { deleted: 0, batches: 1, truncated: false },
  edgeFunctionLogs: { deleted: 0, batches: 1, truncated: false },
  jobRuns: { deleted: 0, batches: 1, truncated: false },
  authAuditLogs: { deleted: 0, batches: 1, truncated: false },
  realtimeOutboxCompleted: { deleted: 0, batches: 1, truncated: false },
  realtimeOutboxFailed: { deleted: 0, batches: 1, truncated: false },
  realtimeMessages: { deleted: 0, batches: 1, truncated: false },
  requestLogs: { deleted: 0, batches: 1, truncated: false },
};

describe('DataRetentionService: realtime outbox', () => {
  function outboxHarness(
    completedResponses: Array<number | Error>,
    failedResponses: Array<number | Error>,
    realtime: unknown,
  ) {
    const calls: QueryCall[] = [];
    const nextRows = (responses: Array<number | Error>) => {
      const response = responses.shift() ?? 0;
      if (response instanceof Error) throw response;
      return Array.from({ length: response }, (_, index) => ({ id: String(index) }));
    };
    const prisma = {
      $queryRaw: vi.fn(async (query: any) => {
        const sql = query.strings.join('?');
        calls.push({ sql, values: query.values });
        if (!sql.includes('realtime_outbox')) return [];
        // outbox template values: [status, cutoff, batchSize]
        return query.values[0] === 'completed' ? nextRows(completedResponses) : nextRows(failedResponses);
      }),
    };
    const SettingsService = {
      get: vi.fn(async (key: string) => (key === 'realtime.retention' ? realtime : DEFAULT_CONFIG)),
    };
    return { service: new DataRetentionService({ prisma, SettingsService } as any), calls };
  }

  it('prunes completed and failed outbox rows with independent cutoffs', async () => {
    const { service, calls } = outboxHarness(
      [3, 1],
      [2],
      { enabled: true, completedDays: 7, failedDays: 30 },
    );
    const now = new Date('2026-07-20T12:00:00.000Z');

    const result = await service.runOnce(now);

    expect(result.realtimeOutboxCompleted).toEqual({ deleted: 4, batches: 2, truncated: false });
    expect(result.realtimeOutboxFailed).toEqual({ deleted: 2, batches: 1, truncated: false });
    const outboxCalls = calls.filter(c => c.sql.includes('realtime_outbox'));
    expect(outboxCalls[0].sql).toContain('ORDER BY "processedAt", "id"');
    // completed cutoff = now - 7d; failed cutoff = now - 30d
    expect(outboxCalls[0].values).toEqual(['completed', new Date('2026-07-13T12:00:00.000Z'), 3]);
    const failedCall = outboxCalls.find(c => c.values[0] === 'failed')!;
    expect(failedCall.values).toEqual(['failed', new Date('2026-06-20T12:00:00.000Z'), 3]);
  });

  it('leaves the outbox untouched when realtime retention is disabled or unset', async () => {
    const disabled = outboxHarness([], [], { enabled: false, completedDays: 7, failedDays: 30 });
    await disabled.service.runOnce();
    expect(disabled.calls.some(c => c.sql.includes('realtime_outbox'))).toBe(false);

    const unset = outboxHarness([], [], null);
    await unset.service.runOnce();
    expect(unset.calls.some(c => c.sql.includes('realtime_outbox'))).toBe(false);
  });

  it('prunes the outbox even when operational-log retention is switched off', async () => {
    // The two groups have separate Enabled switches. Turning off log retention
    // used to silently stop pruning broadcast events as well, so an outbox grew
    // without bound while its own retention still read "Enabled".
    const calls: QueryCall[] = [];
    const prisma = {
      $queryRaw: vi.fn(async (query: any) => {
        calls.push({ sql: query.strings.join('?'), values: query.values });
        return [];
      }),
    };
    const SettingsService = {
      get: vi.fn(async (key: string) =>
        key === 'realtime.retention'
          ? { enabled: true, completedDays: 7, failedDays: 30 }
          : { ...DEFAULT_CONFIG, enabled: false }),
    };
    const service = new DataRetentionService({ prisma, SettingsService } as any);

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(result.ran).toBe(true);
    expect(calls.some(c => c.sql.includes('realtime_outbox'))).toBe(true);
    // Log targets stay untouched, because their own switch is off.
    expect(calls.some(c => c.sql.includes('webhook_deliveries'))).toBe(false);
    expect(calls.some(c => c.sql.includes('edge_function_logs'))).toBe(false);
  });

  it('schedules the cron for realtime retention alone', async () => {
    const SettingsService = {
      get: vi.fn(async (key: string) =>
        key === 'realtime.retention'
          ? { enabled: true, completedDays: 7, failedDays: 30 }
          : { ...DEFAULT_CONFIG, enabled: false }),
    };
    const service = new DataRetentionService({ prisma: {}, SettingsService } as any);

    await expect(service.hasEnabledTarget()).resolves.toBe(true);
  });

  it('validates the realtime.retention group defaults and bounds', () => {
    const group = getGroup('realtime.retention')!;
    expect(group.schema.parse({})).toMatchObject({ enabled: true, completedDays: 7, failedDays: 30 });
    expect(() => group.schema.parse({ completedDays: 3651 })).toThrow();
  });
});

describe('DataRetentionService: stored log lines', () => {
  function logsHarness(responses: Array<number | Error>, logs: unknown, rowCount = 0) {
    const calls: QueryCall[] = [];
    const prisma = {
      $queryRaw: vi.fn(async (query: any) => {
        const sql = query.strings.join('?');
        calls.push({ sql, values: query.values });
        if (!sql.includes('request_logs')) return [];
        const response = responses.shift() ?? 0;
        if (response instanceof Error) throw response;
        return Array.from({ length: response }, (_, index) => ({ id: index }));
      }),
      requestLog: { count: vi.fn(async () => rowCount) },
    };
    const SettingsService = {
      get: vi.fn(async (key: string) => (key === 'logs.retention' ? logs : { ...DEFAULT_CONFIG, enabled: false })),
    };
    return { service: new DataRetentionService({ prisma, SettingsService } as any), calls, prisma };
  }

  it('purges stored lines older than the configured number of days', async () => {
    const { service, calls } = logsHarness([3, 1], { enabled: true, retentionDays: 2, maxRows: 0 });

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(result.requestLogs).toEqual({ deleted: 4, batches: 2, truncated: false });
    const first = calls.find(call => call.sql.includes('request_logs'))!;
    expect(first.sql).toContain('ORDER BY "at", "id"');
    expect(first.values).toEqual([new Date('2026-07-18T12:00:00.000Z'), 3]);
  });

  it('leaves stored lines alone when their own switch is off', async () => {
    const { service, calls } = logsHarness([5], { enabled: false, retentionDays: 2, maxRows: 0 });

    const result = await service.runOnce();

    expect(result.requestLogs).toEqual({ deleted: 0, batches: 0, truncated: false });
    expect(calls.some(call => call.sql.includes('request_logs'))).toBe(false);
  });

  it('also trims the oldest lines down to the row ceiling', async () => {
    // Age alone cannot bound the table: a traffic burst can put more rows
    // inside the retention window than the disk holds.
    const { service, prisma } = logsHarness([0, 3, 2], { enabled: true, retentionDays: 30, maxRows: 10 }, 15);

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(prisma.requestLog.count).toHaveBeenCalled();
    // 0 deleted by age, then 5 deleted by the ceiling (15 rows, ceiling 10).
    expect(result.requestLogs.deleted).toBe(5);
  });

  it('schedules the cron for stored log retention alone', async () => {
    const SettingsService = {
      get: vi.fn(async (key: string) =>
        key === 'logs.retention'
          ? { enabled: true, retentionDays: 7, maxRows: 0 }
          : { ...DEFAULT_CONFIG, enabled: false }),
    };
    const service = new DataRetentionService({ prisma: {}, SettingsService } as any);

    await expect(service.hasEnabledTarget()).resolves.toBe(true);
  });

  it('validates the logs.retention group defaults and bounds', () => {
    const group = getGroup('logs.retention')!;
    expect(group.schema.parse({})).toMatchObject({ enabled: true, retentionDays: 7, maxRows: 2_000_000 });
    expect(() => group.schema.parse({ retentionDays: 3651 })).toThrow();
  });
});

describe('DataRetentionSchedulerService', () => {
  it('does not schedule while disabled', async () => {
    const DataRetentionService = {
      config: vi.fn(async () => ({ ...DEFAULT_CONFIG, enabled: false })),
      hasEnabledTarget: vi.fn(async () => false),
      runOnce: vi.fn(),
    };
    const scheduler = new DataRetentionSchedulerService({ DataRetentionService, JobLedgerService: { record: <F>(_job: string, fn: () => Promise<F>) => fn(), note: async () => {} } } as any);
    const schedule = vi.fn();
    (scheduler as any).scheduler = { schedule };

    await scheduler.start();

    expect(schedule).not.toHaveBeenCalled();
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('stops the previous task on reschedule and executes the captured tick', async () => {
    const DataRetentionService = {
      config: vi.fn(async () => DEFAULT_CONFIG),
      hasEnabledTarget: vi.fn(async () => true),
      runOnce: vi.fn(async () => EMPTY_SUMMARY),
    };
    const scheduler = new DataRetentionSchedulerService({ DataRetentionService, JobLedgerService: { record: <F>(_job: string, fn: () => Promise<F>) => fn(), note: async () => {} } } as any);
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    let tick: (() => void) | undefined;
    (scheduler as any).scheduler = {
      schedule: vi.fn((_cron: string, fn: () => void) => {
        tick = fn;
        const stop = vi.fn();
        stops.push(stop);
        return { stop };
      }),
    };

    await scheduler.start();
    await scheduler.reschedule();
    tick?.();
    await new Promise(resolve => setImmediate(resolve));

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(DataRetentionService.runOnce).toHaveBeenCalledOnce();
    expect(scheduler.status()).toMatchObject({ scheduled: true, running: false, lastError: null });
  });

  it('skips overlapping runs', async () => {
    let resolveRun: ((value: DataRetentionRunSummary) => void) | undefined;
    const pending = new Promise<DataRetentionRunSummary>(resolve => {
      resolveRun = resolve;
    });
    const DataRetentionService = {
      config: vi.fn(async () => DEFAULT_CONFIG),
      runOnce: vi.fn(() => pending),
    };
    const scheduler = new DataRetentionSchedulerService({ DataRetentionService, JobLedgerService: { record: <F>(_job: string, fn: () => Promise<F>) => fn(), note: async () => {} } } as any);

    const first = scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ ran: false });
    resolveRun?.(EMPTY_SUMMARY);
    await expect(first).resolves.toEqual(EMPTY_SUMMARY);
  });
});

describe('scheduler run ledger retention', () => {
  it('trims platform.job_runs in bounded batches on every enabled run', async () => {
    // Nothing was trimming this table. JobLedgerService.prune existed and its
    // comment claimed the data-retention job called it, but the only caller in
    // the repo was its own test, so a ledger row per scheduler tick (five
    // minutes for storage-cleanup alone) accumulated forever.
    const { service, pruneBatch } = retentionHarness([0], [0], DEFAULT_CONFIG, { enabled: false }, [3, 3, 1]);
    const now = new Date('2026-07-20T12:00:00.000Z');

    const result = await service.runOnce(now);

    expect(result.jobRuns).toEqual({ deleted: 7, batches: 3, truncated: false });
    expect(pruneBatch).toHaveBeenCalledTimes(3);
    // 30 days back, and the operator's configured batch size, like every other
    // target in the run.
    expect(pruneBatch).toHaveBeenNthCalledWith(1, new Date('2026-06-20T12:00:00.000Z'), 3);
  });

  it('leaves the ledger alone when operational log retention is off', async () => {
    const config = { ...DEFAULT_CONFIG, enabled: false };
    const { service, pruneBatch } = retentionHarness([], [], config, { enabled: false }, [5]);

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(result.jobRuns).toEqual({ deleted: 0, batches: 0, truncated: false });
    expect(pruneBatch).not.toHaveBeenCalled();
  });
});

describe('auth audit log retention', () => {
  it('prunes auth.audit_log_entries past its own age, in bounded batches', async () => {
    const { service, deleteAuditBatch } = retentionHarness([0], [0], DEFAULT_CONFIG, { enabled: false }, [0], [3, 2]);

    const result = await service.runOnce(new Date('2026-07-20T12:00:00.000Z'));

    expect(result.authAuditLogs).toEqual({ deleted: 5, batches: 2, truncated: false });
    expect(deleteAuditBatch).toHaveBeenNthCalledWith(1, new Date('2026-04-21T12:00:00.000Z'), 3);
  });
});
