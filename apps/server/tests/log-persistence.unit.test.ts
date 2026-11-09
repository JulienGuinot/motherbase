import { describe, expect, it, vi } from 'vitest';
import { LogBuffer } from '../lib/log-buffer';
import { LogPersistenceService } from '../services/admin/log-persistence.service';

function harness(config: unknown, rows: any[] = []) {
  const logBuffer = new LogBuffer(10);
  const createMany = vi.fn(async (_args: { data: Record<string, unknown>[] }) => ({ count: 0 }));
  const findMany = vi.fn(async (_args: { where: { AND: unknown[] }; orderBy: unknown }) => rows);
  const prisma = { requestLog: { createMany, findMany } };
  const SettingsService = { get: vi.fn(async () => config) };
  return {
    service: new LogPersistenceService({ prisma, logBuffer, SettingsService } as any),
    logBuffer,
    createMany,
    findMany,
  };
}

describe('LogPersistenceService', () => {
  it('writes buffered lines with their structured detail', async () => {
    const { service, logBuffer, createMany } = harness({ enabled: true, retentionDays: 7, maxRows: 0 });
    await service.start();

    logBuffer.push({
      level: 'warn',
      source: 'http',
      message: 'GET /api/users → 401 (5ms)',
      method: 'GET',
      path: '/api/users',
      status: 401,
      durationMs: 5,
      ip: '203.0.113.7',
      userAgent: 'curl/8.4.0',
      requestId: 'req-1',
      userId: 'user-1',
    });

    expect(await service.flush()).toBe(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      level: 'warn',
      source: 'http',
      ip: '203.0.113.7',
      userAgent: 'curl/8.4.0',
      requestId: 'req-1',
      userId: 'user-1',
      status: 401,
      durationMs: 5,
    });
    service.stop();
  });

  it('keeps nothing while storage is switched off', async () => {
    const { service, logBuffer, createMany } = harness({ enabled: false, retentionDays: 7, maxRows: 0 });
    await service.start();

    logBuffer.push({ level: 'info', source: 'http', message: 'GET / → 200 (1ms)' });

    expect(await service.flush()).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
    service.stop();
  });

  it('drops the batch rather than the process when the write fails', async () => {
    const { service, logBuffer, createMany } = harness({ enabled: true, retentionDays: 7, maxRows: 0 });
    createMany.mockRejectedValueOnce(new Error('connection refused'));
    await service.start();

    logBuffer.push({ level: 'error', source: 'http', message: 'GET / → 500 (1ms)' });

    await expect(service.flush()).resolves.toBe(0);
    expect(service.status().lastError).toContain('connection refused');
    // The failed batch is not requeued, so a database outage cannot grow the
    // heap it was meant to spare.
    expect(service.status().pending).toBe(0);
    service.stop();
  });

  it('reads a window back oldest-first, like the buffer', async () => {
    const rows = [
      { id: 2, at: new Date('2026-09-08T10:00:01.000Z'), level: 'info', source: 'http', message: 'second',
        method: 'GET', path: '/b', status: 200, durationMs: 2, ip: null, userAgent: null, requestId: null, userId: null },
      { id: 1, at: new Date('2026-09-08T10:00:00.000Z'), level: 'info', source: 'http', message: 'first',
        method: 'GET', path: '/a', status: 200, durationMs: 1, ip: null, userAgent: null, requestId: null, userId: null },
    ];
    const { service, findMany } = harness({ enabled: true, retentionDays: 7, maxRows: 0 }, rows);

    const result = await service.query({ since: new Date('2026-09-08T09:00:00.000Z'), limit: 100, levels: ['info'] });

    expect(result.map(entry => entry.message)).toEqual(['first', 'second']);
    expect(result[0].ip).toBeUndefined();
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ at: 'desc' }, { id: 'desc' }]);
    expect(findMany.mock.calls[0][0].where.AND).toContainEqual({ level: { in: ['info'] } });
  });

  it('looks up the oldest line while the page query is still running', async () => {
    const { service, findMany } = harness({ enabled: true, retentionDays: 7, maxRows: 0 });
    let release!: () => void;
    findMany.mockImplementationOnce(() => new Promise<any[]>(resolve => (release = () => resolve([]))));
    const findFirst = vi.fn(async () => null);
    (service as any).di.prisma.requestLog.findFirst = findFirst;

    const page = service.queryPage({ limit: 10 });
    await Promise.resolve();
    expect(findFirst).toHaveBeenCalled();
    release();
    await expect(page).resolves.toMatchObject({ logs: [], hasMore: false, oldestAvailable: null });
  });
});
