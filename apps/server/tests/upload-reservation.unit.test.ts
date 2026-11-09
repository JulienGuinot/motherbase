import { describe, expect, it, vi } from 'vitest';
import { FileStatus, FileVisibility, Prisma } from '@prisma/client';
import { UploadReservationStore } from '../services/storage/upload-reservation.store';

const future = new Date('2030-01-01T00:00:00.000Z');
const expired = new Date('2020-01-01T00:00:00.000Z');

function file(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ownerId: 'u1',
    bucketId: 'b1',
    bucket: 'uploads',
    key: `${id}.bin`,
    mime: 'application/octet-stream',
    size: 5,
    visibility: FileVisibility.private,
    status: FileStatus.pending,
    uploadExpiresAt: future,
    url: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function lifecycleHarness(initial: any[], deletionJob: { id: string } | null = null) {
  const files = new Map(initial.map(item => [item.id, { ...item }]));
  let inTransaction = false;

  const matchesStatus = (actual: FileStatus, expected: any) => {
    if (expected === undefined) return true;
    if (typeof expected === 'string') return actual === expected;
    if (expected.in) return expected.in.includes(actual);
    return true;
  };

  const delegate = {
    findUnique: vi.fn(async ({ where: { id } }: any) => files.get(id) ?? null),
    findMany: vi.fn(async () => Array.from(files.values())),
    update: vi.fn(async ({ where: { id }, data }: any) => {
      const current = files.get(id);
      if (!current) throw new Error('missing');
      const updated = { ...current, ...data };
      files.set(id, updated);
      return updated;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const current = files.get(where.id);
      if (
        !current ||
        !matchesStatus(current.status, where.status) ||
        (where.uploadExpiresAt?.lte &&
          (!current.uploadExpiresAt || current.uploadExpiresAt > where.uploadExpiresAt.lte))
      ) {
        return { count: 0 };
      }
      files.set(where.id, { ...current, ...data });
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const current = files.get(where.id);
      if (!current || !matchesStatus(current.status, where.status)) return { count: 0 };
      files.delete(where.id);
      return { count: 1 };
    }),
  };
  const tx = {
    file: delegate,
    bucketDeletionJob: { findFirst: vi.fn(async () => deletionJob) },
    $queryRawUnsafe: vi.fn(async () => [{ id: 'b1' }]),
    $queryRaw: vi.fn(async (query: any) => {
      const id = query.values[0];
      return files.has(id) ? [{ id }] : [];
    }),
  };
  const prisma = {
    file: delegate,
    $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };

  return {
    files,
    prisma,
    store: new UploadReservationStore(prisma as any),
    isInTransaction: () => inTransaction,
  };
}

describe('UploadReservationStore quota reservation', () => {
  it('locks the bucket and reserves pending bytes in one transaction', async () => {
    const create = vi.fn(async ({ data }: any) => file('f1', data));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'b1', quotaBytes: BigInt(20) }]),
      file: {
        aggregate: vi.fn(async () => ({ _sum: { size: 10 } })),
        create,
      },
      bucketDeletionJob: { findFirst: vi.fn(async () => null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    };
    const store = new UploadReservationStore(prisma as any);

    await store.reserve({
      ownerId: 'u1',
      bucketId: 'b1',
      bucket: 'uploads',
      key: 'f1.bin',
      size: 5,
      visibility: FileVisibility.private,
      uploadExpiresAt: future,
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    const lockQuery = (tx.$queryRaw as any).mock.calls[0][0];
    expect(lockQuery.strings.join(' ')).toContain('FOR UPDATE');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        size: 5,
        status: FileStatus.pending,
        uploadExpiresAt: future,
      }),
    });
  });

  it('rejects new reservations while a deletion job owns the locked bucket', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'b1', quotaBytes: null }]),
      bucketDeletionJob: { findFirst: vi.fn(async () => ({ id: 'job-1' })) },
      file: { aggregate: vi.fn(), create: vi.fn() },
    };
    const store = new UploadReservationStore({
      $transaction: async (callback: (client: any) => Promise<unknown>) => callback(tx),
    } as any);

    await expect(store.reserve({
      bucketId: 'b1',
      bucket: 'uploads',
      key: 'f1.bin',
      size: 5,
      visibility: FileVisibility.private,
      uploadExpiresAt: future,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.file.create).not.toHaveBeenCalled();
  });

  it('rejects a reservation that would exceed the locked bucket quota', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'b1', quotaBytes: BigInt(12) }]),
      file: {
        aggregate: vi.fn(async () => ({ _sum: { size: 10 } })),
        create: vi.fn(),
      },
      bucketDeletionJob: { findFirst: vi.fn(async () => null) },
    };
    const store = new UploadReservationStore({
      $transaction: async (callback: (client: any) => Promise<unknown>) => callback(tx),
    } as any);

    await expect(
      store.reserve({
        bucketId: 'b1',
        bucket: 'uploads',
        key: 'f1.bin',
        size: 5,
        visibility: FileVisibility.private,
        uploadExpiresAt: future,
      })
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(tx.file.create).not.toHaveBeenCalled();
  });
});

describe('UploadReservationStore lifecycle claims', () => {
  it('blocks activation and finalization after deletion was enqueued', async () => {
    const harness = lifecycleHarness([file('f1')], { id: 'job-1' });
    const inspect = vi.fn();

    await expect(harness.store.activate('f1', null)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      harness.store.finalize('f1', 'u1', inspect, () => null, new Date('2025-01-01')),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(inspect).not.toHaveBeenCalled();
    expect(harness.files.get('f1')?.status).toBe(FileStatus.pending);
  });

  it('does HEAD outside the transaction and finalizes exactly once', async () => {
    const harness = lifecycleHarness([file('f1')]);
    const inspect = vi.fn(async () => {
      expect(harness.isInTransaction()).toBe(false);
      return { contentLength: 5, contentType: 'application/octet-stream' };
    });

    const first = await harness.store.finalize('f1', 'u1', inspect, () => null, new Date('2025-01-01'));
    const second = await harness.store.finalize('f1', 'u1', inspect, () => null, new Date('2025-01-01'));

    expect(first.finalized).toBe(true);
    expect(second.finalized).toBe(false);
    expect(inspect).toHaveBeenCalledOnce();
    expect(harness.files.get('f1')?.status).toBe(FileStatus.ready);
  });

  it('checks ownership before inspecting S3 and restores pending after a size mismatch', async () => {
    const harness = lifecycleHarness([file('f1')]);
    const inspect = vi.fn(async () => ({ contentLength: 4 }));

    await expect(
      harness.store.finalize('f1', 'other', inspect, () => null, new Date('2025-01-01'))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(inspect).not.toHaveBeenCalled();

    await expect(harness.store.finalize('f1', 'u1', inspect, () => null, new Date('2025-01-01'))).rejects.toMatchObject(
      { statusCode: 409 }
    );
    expect(harness.files.get('f1')?.status).toBe(FileStatus.pending);
  });

  it('resumes stale deleting rows even when their upload expiry is null', async () => {
    const harness = lifecycleHarness([
      file('stale', {
        status: FileStatus.deleting,
        uploadExpiresAt: null,
        updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ]);
    const remove = vi.fn(async () => undefined);
    const now = new Date('2025-01-01T00:00:00.000Z');

    await expect(harness.store.cleanupExpired(remove, now)).resolves.toBe(1);

    expect(remove).toHaveBeenCalledOnce();
    expect(harness.files.has('stale')).toBe(false);
    expect(harness.prisma.file.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: FileStatus.deleting,
              updatedAt: { lte: new Date('2024-12-31T23:45:00.000Z') },
            }),
          ]),
        },
      }),
    );
  });

  it('continues cleanup after one delete fails and performs no storage I/O in a transaction', async () => {
    const harness = lifecycleHarness([
      file('bad', { uploadExpiresAt: expired }),
      file('good', { uploadExpiresAt: expired }),
    ]);
    const remove = vi.fn(async (candidate: any) => {
      expect(harness.isInTransaction()).toBe(false);
      if (candidate.id === 'bad') throw new Error('S3 unavailable');
    });

    await expect(harness.store.cleanupExpired(remove, new Date('2025-01-01'))).rejects.toThrow('S3 unavailable');

    expect(remove).toHaveBeenCalledTimes(2);
    expect(harness.files.get('bad')?.status).toBe(FileStatus.pending);
    expect(harness.files.has('good')).toBe(false);
  });
});

describe('UploadReservationStore.reserve', () => {
  it('answers a lost race on (bucket, key) with a 409, not a server error', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    const store = new UploadReservationStore({ $transaction: async () => { throw duplicate; } } as any);
    await expect(
      store.reserve({ bucket: 'uploads', key: 'a/b.png', size: 1, visibility: FileVisibility.private, uploadExpiresAt: future }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets any other failure through untouched', async () => {
    const boom = new Error('connection lost');
    const store = new UploadReservationStore({ $transaction: async () => { throw boom; } } as any);
    await expect(
      store.reserve({ bucket: 'uploads', key: 'a/b.png', size: 1, visibility: FileVisibility.private, uploadExpiresAt: future }),
    ).rejects.toBe(boom);
  });
});
