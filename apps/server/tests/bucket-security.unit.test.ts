import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BucketService } from '../services/storage/bucket.service';
import { BucketDeletionService } from '../services/storage/bucket-deletion.service';
import { BucketDeletionSchedulerService } from '../services/storage/bucket-deletion-scheduler.service';
import AdminStorageController from '../controllers/admin/admin-storage.controller';

afterEach(() => vi.restoreAllMocks());

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bucket-1',
    slug: 'assets',
    name: 'Assets',
    description: null,
    visibility: 'private',
    quotaBytes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function deletionJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    bucketId: 'bucket-1',
    bucketSlug: 'assets',
    status: 'running',
    totalObjects: 20,
    deletedObjects: 0,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseToken: 'lease',
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

describe('BucketDeletionService durable worker', () => {
  it('keeps failed metadata and bounds physical delete concurrency', async () => {
    let files = Array.from({ length: 20 }, (_, index) => ({
      id: 'file-' + index,
      bucket: 'objects',
      key: 'key-' + index,
    }));
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const jobUpdates: any[] = [];
    const fileDelegate = {
      findMany: vi.fn(async () => files),
      deleteMany: vi.fn(async ({ where }: any) => {
        events.push('metadata');
        const ids = new Set(where.id.in);
        const before = files.length;
        files = files.filter(file => !ids.has(file.id));
        return { count: before - files.length };
      }),
    };
    const prisma: any = {
      file: fileDelegate,
      bucketDeletionJob: { updateMany: vi.fn() },
      $queryRawUnsafe: vi.fn(async () => [deletionJob()]),
      $transaction: vi.fn(async (callback: any) =>
        callback({
          file: fileDelegate,
          bucketDeletionJob: {
            updateMany: vi.fn(async ({ data }: any) => {
              jobUpdates.push(data);
              return { count: 1 };
            }),
          },
        })
      ),
    };
    const service = new BucketDeletionService({ prisma } as any);
    (service as any).driver = {
      delete: vi.fn(async (_bucket: string, key: string) => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push('physical:' + key);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        if (key === 'key-5') throw new Error('storage unavailable');
      }),
    };

    await expect(service.processNext()).resolves.toBe(true);

    expect(files.map(file => file.id)).toEqual(['file-5']);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(maxActive).toBeGreaterThan(1);
    const lastPhysical = events.reduce((last, event, index) => (event.startsWith('physical:') ? index : last), -1);
    expect(events.lastIndexOf('metadata')).toBeGreaterThan(lastPhysical);
    expect(jobUpdates[0]).toEqual(
      expect.objectContaining({
        status: 'queued',
        deletedObjects: { increment: 19 },
        attempts: 1,
      })
    );
    expect(jobUpdates[0].lastError).toContain('storage unavailable');
  });

  it('claims queued and expired running jobs with a database lease', async () => {
    const prisma: any = {
      $queryRawUnsafe: vi.fn(async () => []),
    };
    const service = new BucketDeletionService({ prisma } as any);

    await expect(service.processNext()).resolves.toBe(false);

    const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('"status" = \'running\'');
    expect(sql).toContain('"leaseExpiresAt" < NOW()');
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toEqual(expect.any(String));
  });

  it('delegates force deletion to an idempotent queued job', async () => {
    const job = deletionJob({ status: 'queued', leaseToken: null });
    const enqueue = vi.fn(async () => {
      const { leaseToken: _leaseToken, ...view } = job;
      return view;
    });
    const prisma: any = {
      bucket: { findUnique: vi.fn(async () => bucket()), delete: vi.fn() },
    };
    const service = new BucketService({ prisma, BucketDeletionService: { enqueue } } as any);

    await expect(service.delete('assets', true)).resolves.toEqual({
      deleted: false,
      job: expect.objectContaining({ id: 'job-1', status: 'queued' }),
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'bucket-1' }));
    expect(prisma.bucket.delete).not.toHaveBeenCalled();
  });

  it('migration enforces one active job per bucket without deleting job history', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../prisma/migrations/20260720040000_bucket_deletion_jobs/migration.sql'),
      'utf8'
    );
    expect(sql).toContain('CREATE INDEX "bucket_deletion_jobs_bucketId_createdAt_idx"');
    expect(sql).toContain('bucket_deletion_jobs_one_active_per_bucket');
    expect(sql).toContain("WHERE \"status\" IN ('queued', 'running')");
    expect(sql).not.toContain('REFERENCES "storage"."buckets"');
  });
});
describe('Admin bucket deletion API', () => {
  it('returns 202 with the durable job for force deletion', async () => {
    const job = deletionJob({ status: 'queued', leaseToken: null });
    const result = { deleted: false as const, job };
    const controller = new AdminStorageController({
      BucketService: { delete: vi.fn(async () => result) },
    } as any);
    const json = vi.fn();
    const response = { status: vi.fn(() => response), json } as any;
    const next = vi.fn();

    await controller.deleteBucket({ params: { slug: 'assets' }, query: { force: 'true' } } as any, response, next);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Bucket deletion queued',
        data: result,
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});
describe('BucketDeletionSchedulerService', () => {
  it('processes at most two jobs per tick and prevents overlapping ticks', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const processNext = vi.fn(async () => {
      await pending;
      return true;
    });
    const scheduler = new BucketDeletionSchedulerService({
      BucketDeletionService: { processNext },
      JobLedgerService: { note: vi.fn() },
    } as any);

    const first = scheduler.runOnce();
    await Promise.resolve();
    await expect(scheduler.runOnce()).resolves.toEqual({ ran: false, claimed: 0 });
    expect(processNext).toHaveBeenCalledTimes(2);

    release?.();
    await expect(first).resolves.toEqual({ ran: true, claimed: 2 });
  });
});
describe('BucketService indexed tokens', () => {
  function tokenService(tokenRecord?: any) {
    const prisma: any = {
      bucket: { findUnique: vi.fn(async () => bucket()) },
      bucketToken: {
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: any) => ({
          id: 'token-1',
          createdAt: new Date(),
          ...data,
        })),
        findUnique: vi.fn(async () => tokenRecord ?? null),
        findMany: vi.fn(async () => []),
      },
    };
    prisma.$queryRawUnsafe = vi.fn(async () => [{ id: 'bucket-1' }]);
    prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
    return { service: new BucketService({ prisma } as any), prisma };
  }

  it('marks preserved legacy records as needing rotation without exposing hashes', async () => {
    const { service, prisma } = tokenService();
    prisma.bucketToken.findMany.mockResolvedValue([
      { id: 'legacy', lookupId: null, token: 'legacy-hash' },
      { id: 'current', lookupId: 'lookup_identifier_123', token: 'current-hash' },
    ]);

    await expect(service.listTokens('bucket-1')).resolves.toEqual([
      { id: 'legacy', lookupId: null, needsRotation: true },
      { id: 'current', lookupId: 'lookup_identifier_123', needsRotation: false },
    ]);
  });

  it('creates lookupId.secret tokens and hashes only the secret', async () => {
    const { service, prisma } = tokenService();
    const hash = vi.spyOn(service as any, 'hashToken').mockResolvedValue('hashed-secret');

    const result = await service.createToken('bucket-1', {
      name: 'uploader',
      permissions: ['write'],
    });

    const [lookupId, secret] = result.raw.split('.');
    expect(lookupId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(hash).toHaveBeenCalledOnce();
    expect(hash).toHaveBeenCalledWith(secret);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT id FROM "storage"."buckets" WHERE id = $1 FOR UPDATE',
      'bucket-1'
    );
    expect(prisma.bucketToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lookupId, token: 'hashed-secret' }),
    });
    expect(result.tokenRecord).not.toHaveProperty('token');
  });

  it('performs one indexed lookup and one bcrypt comparison', async () => {
    const record = {
      id: 'token-1',
      bucketId: 'bucket-1',
      lookupId: 'lookup_identifier_123',
      token: 'hashed-secret',
      permissions: ['read'],
      expiresAt: null,
      createdAt: new Date(),
      name: 'reader',
    };
    const { service, prisma } = tokenService(record);
    const compare = vi.spyOn(service as any, 'compareToken').mockResolvedValue(true);

    await expect(
      service.verifyToken('lookup_identifier_123.secret_value_that_is_long_enough', 'assets', 'read')
    ).resolves.toBe(record);

    expect(prisma.bucketToken.findUnique).toHaveBeenCalledOnce();
    expect(prisma.bucketToken.findUnique).toHaveBeenCalledWith({
      where: { lookupId: 'lookup_identifier_123' },
    });
    expect(compare).toHaveBeenCalledOnce();
    expect(compare).toHaveBeenCalledWith('secret_value_that_is_long_enough', 'hashed-secret');
  });

  it('rejects legacy and malformed tokens without scanning or hashing', async () => {
    const { service, prisma } = tokenService();
    const compare = vi.spyOn(service as any, 'compareToken');

    await expect(service.verifyToken('a'.repeat(64), 'assets', 'read')).rejects.toMatchObject({
      statusCode: 401,
    });

    expect(prisma.bucket.findUnique).not.toHaveBeenCalled();
    expect(prisma.bucketToken.findUnique).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('enforces the active-token limit inside the locked transaction', async () => {
    const { service, prisma } = tokenService();
    const hash = vi.spyOn(service as any, 'hashToken').mockResolvedValue('hashed-secret');
    prisma.bucketToken.count.mockResolvedValue(50);

    await expect(service.createToken('bucket-1', { name: 'too-many', permissions: ['read'] })).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(hash).toHaveBeenCalledOnce();
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledOnce();
    expect(prisma.bucketToken.create).not.toHaveBeenCalled();
  });

  it('migration preserves unconvertible legacy rows for explicit rotation', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../prisma/migrations/20260720023000_secure_bucket_tokens/migration.sql'),
      'utf8'
    );
    expect(sql).not.toContain('DELETE FROM "storage"."bucket_tokens"');
    expect(sql).toContain('ADD COLUMN "lookupId" TEXT');
    expect(sql).not.toContain('ADD COLUMN "lookupId" TEXT NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX "bucket_tokens_lookupId_key"');
  });
});
