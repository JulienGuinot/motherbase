import { describe, expect, it, vi } from 'vitest';
import { BucketDeletionService } from '../services/storage/bucket-deletion.service';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    bucketId: 'bucket-1',
    bucketSlug: 'assets',
    status: 'running',
    totalObjects: 2,
    deletedObjects: 0,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: 'database-lease',
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

describe('durable bucket deletion job invariants', () => {
  it('returns the active job while holding the bucket lock', async () => {
    const active = job({ status: 'queued', leaseToken: null });
    const events: string[] = [];
    const tx = {
      $queryRawUnsafe: vi.fn(async () => {
        events.push('lock');
        return [{ id: 'bucket-1' }];
      }),
      bucketDeletionJob: {
        findFirst: vi.fn(async () => {
          events.push('lookup');
          return active;
        }),
        create: vi.fn(),
      },
      file: { count: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    };
    const service = new BucketDeletionService({ prisma } as any);

    const [first, second] = await Promise.all([
      service.enqueue({ id: 'bucket-1', slug: 'assets' }),
      service.enqueue({ id: 'bucket-1', slug: 'assets' }),
    ]);

    expect(first.id).toBe('job-1');
    expect(second.id).toBe('job-1');
    expect(tx.bucketDeletionJob.create).not.toHaveBeenCalled();
    expect(events).toEqual(['lock', 'lock', 'lookup', 'lookup']);
  });

  it('serializes empty finalization and records completion after bucket deletion', async () => {
    const events: string[] = [];
    const current = job({ totalObjects: 0 });
    const tx = {
      bucketDeletionJob: {
        findFirst: vi.fn(async () => current),
        update: vi.fn(async ({ data }: any) => {
          events.push('job:' + data.status);
          return { ...current, ...data };
        }),
      },
      $queryRawUnsafe: vi.fn(async () => {
        events.push('bucket-lock');
        return [{ id: 'bucket-1' }];
      }),
      file: {
        count: vi.fn(async () => 0),
        findFirst: vi.fn(),
      },
      bucket: {
        delete: vi.fn(async () => {
          events.push('bucket-delete');
          return {};
        }),
      },
    };
    const prisma = {
      file: { findMany: vi.fn(async () => []) },
      $queryRawUnsafe: vi.fn(async () => [current]),
      bucketDeletionJob: { updateMany: vi.fn() },
      $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    };
    const service = new BucketDeletionService({ prisma } as any);

    await expect(service.processNext()).resolves.toBe(true);

    expect(events).toEqual(['bucket-lock', 'bucket-delete', 'job:completed']);
    expect(tx.bucketDeletionJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'completed',
        deletedObjects: 0,
        completedAt: expect.any(Date),
      }),
    });
  });

  it('does not let a stale lease overwrite the current worker state', async () => {
    let currentLease = 'new-worker';
    let status = 'running';
    const updateMany = vi.fn(async ({ where, data }: any) => {
      if (where.leaseToken !== currentLease) return { count: 0 };
      status = data.status;
      currentLease = data.leaseToken;
      return { count: 1 };
    });
    const prisma = { bucketDeletionJob: { updateMany } };
    const service = new BucketDeletionService({ prisma } as any);

    await (service as any).recordFailure(job(), 'stale-worker', new Error('late failure'));

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseToken: 'stale-worker', status: 'running' }),
    }));
    expect(status).toBe('running');
    expect(currentLease).toBe('new-worker');
  });

  it('waits until the nearest live upload reservation expires', async () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const current = job();
    const update = vi.fn(async () => current);
    const tx = {
      bucketDeletionJob: {
        findFirst: vi.fn(async () => current),
        update,
      },
      $queryRawUnsafe: vi.fn(async () => [{ id: 'bucket-1' }]),
      file: {
        count: vi.fn(async () => 1),
        findFirst: vi.fn(async () => ({ uploadExpiresAt: expiresAt })),
      },
      bucket: { delete: vi.fn() },
    };
    const prisma = {
      file: { findMany: vi.fn(async () => []) },
      $queryRawUnsafe: vi.fn(async () => [current]),
      bucketDeletionJob: { updateMany: vi.fn() },
      $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    };
    const service = new BucketDeletionService({ prisma } as any);

    await expect(service.processNext()).resolves.toBe(true);

    expect(tx.bucket.delete).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'queued',
        nextAttemptAt: expiresAt,
        leaseExpiresAt: null,
        leaseToken: null,
      }),
    });
  });
});
