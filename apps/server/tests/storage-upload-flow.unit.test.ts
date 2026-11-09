import { describe, expect, it, vi } from 'vitest';
import { FileStatus, FileVisibility } from '@prisma/client';
import { Readable } from 'stream';
import { HttpException } from '../exceptions/http-exception';
import { StorageService } from '../services/storage/storage.service';
import { StorageCleanupSchedulerService } from '../services/storage/storage-cleanup-scheduler.service';

function pendingFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    ownerId: 'u1',
    bucketId: null,
    bucket: 'uploads',
    key: 'f1.bin',
    mime: 'application/octet-stream',
    size: 5,
    visibility: FileVisibility.private,
    status: FileStatus.pending,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    url: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function service() {
  const prisma = {
    file: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  const BucketService = {
    getBySlug: vi.fn(),
    dispatchWebhook: vi.fn(),
  };
  return {
    svc: new StorageService({ prisma, BucketService } as any),
    prisma,
    BucketService,
  };
}

describe('presigned upload contract', () => {
  // Goes through the real entry point rather than a helper: size and MIME are
  // enforced by StorageService.enforceUploadLimits, which also applies the
  // per-bucket storage.limits settings on top of the env ceiling.
  it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid size %s', async value => {
    const { svc } = service();
    (svc as any).di.SettingsService = { get: async () => ({}) };

    await expect(
      svc.presignUpload({ ownerId: 'u1', filename: 'f.bin', size: value as never }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('signs the expected Content-Length and stores the same reserved size', async () => {
    const { svc } = service();
    const reserved = pendingFile({ size: 7 });
    const reserve = vi.fn(async (input: any) => ({ ...reserved, size: input.size }));
    const getSignedUploadUrl = vi.fn(async () => 'https://s3.test/upload');
    (svc as any).reservations = { reserve, release: vi.fn() };
    (svc as any).driver = { getSignedUploadUrl };

    const result = await svc.presignUpload({
      ownerId: 'u1',
      filename: 'a.bin',
      size: 7,
    });

    expect(result.uploadUrl).toBe('https://s3.test/upload');
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ size: 7 }));
    expect(getSignedUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        contentLength: 7,
      })
    );
  });
});

describe('multipart reservation failure cleanup', () => {
  it('deletes the physical object even when cleanup already removed the reservation', async () => {
    const { svc } = service();
    const reserved = pendingFile();
    const release = vi.fn(async () => false);
    const removeObject = vi.fn(async () => undefined);
    (svc as any).reservations = {
      reserve: vi.fn(async () => reserved),
      activate: vi.fn(async () => {
        throw new HttpException('Upload reservation expired', 410);
      }),
      release,
    };
    (svc as any).driver = {
      put: vi.fn(async () => undefined),
      delete: removeObject,
      publicUrl: vi.fn(),
    };

    await expect(
      svc.upload({
        ownerId: 'u1',
        filename: 'f1.bin',
        body: Readable.from('hello'),
        size: 5,
      })
    ).rejects.toMatchObject({ statusCode: 410 });

    expect(removeObject).toHaveBeenCalledWith('uploads', 'f1.bin');
    expect(release).toHaveBeenCalledWith('f1');
  });
});

describe('pending file visibility and cleanup scheduling', () => {
  it('refuses to stream a pending file', async () => {
    const { svc, prisma } = service();
    prisma.file.findUnique.mockResolvedValue(pendingFile());
    const getObject = vi.fn();
    (svc as any).driver = { getObject };

    await expect(svc.streamFile('f1', { userId: 'u1' })).rejects.toMatchObject({ statusCode: 404 });
    expect(getObject).not.toHaveBeenCalled();
  });

  it('delegates cleanup through the isolated scheduler service', async () => {
    const cleanupExpiredReservations = vi.fn(async () => 3);
    const scheduler = new StorageCleanupSchedulerService({
      StorageService: { cleanupExpiredReservations },
      JobLedgerService: { record: (_job: string, fn: () => Promise<unknown>) => fn() },
    } as any);

    await expect(scheduler.runOnce()).resolves.toEqual({ ran: true, cleaned: 3 });
    expect(cleanupExpiredReservations).toHaveBeenCalledOnce();
  });
});
