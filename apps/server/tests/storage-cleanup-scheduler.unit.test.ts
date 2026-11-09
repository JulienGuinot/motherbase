import { describe, it, expect, vi } from 'vitest';

// A real LogBuffer, but not the one in models/, that module pulls in Prisma.
vi.mock('../models', async () => {
  const { LogBuffer } = await import('../lib/log-buffer');
  return { logBuffer: new LogBuffer(50) };
});

import { StorageCleanupSchedulerService } from '../services/storage/storage-cleanup-scheduler.service';
import type { Scheduler } from '../lib/schedulers';
import type IContextContainer from '../context/icontext-container';

describe('StorageCleanupSchedulerService', () => {
  it('surfaces a failing cleanup run in the Logs buffer, not just on stdout', async () => {
    let tick: (() => void) | undefined;
    const scheduler: Scheduler = {
      schedule: (_expr, fn) => {
        tick = fn;
        return { stop: () => {} };
      },
    };

    const di = {
      StorageService: {
        cleanupExpiredReservations: () => Promise.reject(new Error('minio unreachable')),
      },
      // record() just runs fn() and lets its rejection propagate, same as the
      // real ledger does once it has written the 'running' row.
      JobLedgerService: {
        record: (_job: string, fn: () => Promise<unknown>) => fn(),
      },
    } as unknown as IContextContainer;

    class Testable extends StorageCleanupSchedulerService {
      constructor() {
        super(di);
        this.scheduler = scheduler;
      }
    }

    await new Testable().start();
    tick!();
    await new Promise(resolve => setImmediate(resolve));

    const { logBuffer } = await import('../models');
    const line = logBuffer.recent().find(e => e.message.includes('[storage-cleanup] run failed'));
    expect(line).toBeDefined();
    expect(line!.level).toBe('error');
    expect(line!.source).toBe('job');
    expect(line!.message).toContain('minio unreachable');
  });
});
