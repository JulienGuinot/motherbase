import { describe, expect, it, vi } from 'vitest';
import { FileStatus, FileVisibility } from '@prisma/client';
import { Readable } from 'stream';
import { StorageService } from '../services/storage/storage.service';

/**
 * An upsert used to authorize itself with the scope of the object it was about
 * to replace (`{ userId: existing.ownerId }`), which is always the owner and
 * therefore always allowed: any authenticated caller who knew a bucket/key pair
 * could overwrite someone else's object. It also deleted the old object before
 * writing the new one, so a failure on quota, disk or network lost the bytes.
 *
 * Both are decided here: the caller's own scope authorizes the write, and the
 * replacement overwrites in place so the previous object survives a failure.
 */

function readyFile(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    ownerId: 'owner',
    bucketId: 'b1',
    bucket: 'public',
    key: 'avatars/123/pic.png',
    mime: 'image/png',
    size: 10,
    visibility: FileVisibility.public,
    status: FileStatus.ready,
    url: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...over,
  } as any;
}

function service(options: { existing?: any; policies?: boolean; canWrite?: boolean } = {}) {
  const existing = 'existing' in options ? options.existing : readyFile();
  const prisma = {
    file: {
      findUnique: vi.fn(async () => existing),
      findFirst: vi.fn(async (_args: unknown) => existing),
      findMany: vi.fn(async () => []),
      delete: vi.fn(),
    },
  };
  const BucketService = {
    getBySlug: vi.fn(async () => ({ id: 'b1', slug: 'avatars', visibility: FileVisibility.public })),
    dispatchWebhook: vi.fn(),
  };
  const StoragePolicyService = {
    enabled: vi.fn(async () => Boolean(options.policies)),
    canRead: vi.fn(async () => true),
    canWrite: vi.fn(async () => options.canWrite !== false),
    visibleIds: vi.fn(async (ids: string[]) => new Set(ids)),
  };
  const svc = new StorageService({ prisma, BucketService, StoragePolicyService } as any);

  const driver = {
    put: vi.fn(async (_input: unknown) => {}),
    delete: vi.fn(async () => {}),
    publicUrl: () => 'https://cdn.test/avatars/123/pic.png',
    getSignedDownloadUrl: async () => 'https://cdn.test/signed',
  };
  const reservations = {
    reserve: vi.fn(async (input: any) => readyFile({ id: 'new', key: input.key, status: FileStatus.pending })),
    activate: vi.fn(async () => readyFile({ id: 'new' })),
    release: vi.fn(),
    assertReplacementFits: vi.fn(async () => {}),
    completeReplacement: vi.fn(async (_id: string, data: any) => readyFile({ size: data.size, mime: data.mime })),
  };
  (svc as any).driver = driver;
  (svc as any).reservations = reservations;
  return { svc, driver, reservations, prisma, StoragePolicyService };
}

function upload(svc: StorageService, over: Record<string, unknown> = {}) {
  return svc.upload({
    ownerId: 'intruder',
    filename: 'pic.png',
    body: Readable.from([Buffer.alloc(4)]),
    size: 4,
    mime: 'image/png',
    bucketSlug: 'avatars',
    objectKey: '123/pic.png',
    upsert: true,
    ...over,
  } as any);
}

describe('storage upsert authorization', () => {
  it('allows service_role to replace another owner’s object without policies', async () => {
    const { svc, driver } = service();
    await expect(upload(svc, { scope: { caller: { serviceRole: true } } })).resolves.toMatchObject({ file: { size: 4 } });
    expect(driver.put).toHaveBeenCalledOnce();
  });

  it('refuses a move before creating a destination when deletion is forbidden', async () => {
    const { svc, driver, reservations } = service();
    await expect(svc.moveObject('avatars', '123/pic.png', 'copy.png', { userId: 'intruder' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(driver.put).not.toHaveBeenCalled();
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it('keeps the owner when service_role moves an object, but not when it copies one', async () => {
    const { svc, driver, reservations, prisma } = service();
    const source = readyFile();
    prisma.file.findFirst.mockImplementation(async ({ where }: any) => (where.key === source.key ? source : null));
    (driver as any).getObject = vi.fn(async () => ({ body: Readable.from([Buffer.alloc(10)]) }));
    const serviceRole = { caller: { serviceRole: true } };

    await svc.copyObject('avatars', '123/pic.png', 'copy.png', serviceRole);
    await svc.moveObject('avatars', '123/pic.png', 'moved.png', serviceRole);

    expect(reservations.reserve.mock.calls.map(([input]: any[]) => [input.key, input.ownerId])).toEqual([
      ['avatars/copy.png', undefined],
      ['avatars/moved.png', 'owner'],
    ]);
  });

  it('refuses to overwrite an object the caller has no claim on', async () => {
    const { svc, driver, reservations } = service();

    await expect(upload(svc, { scope: { userId: 'intruder' } })).rejects.toMatchObject({ statusCode: 403 });
    // The decisive part: nothing was written and, above all, nothing was deleted.
    expect(driver.put).not.toHaveBeenCalled();
    expect(driver.delete).not.toHaveBeenCalled();
    expect(reservations.completeReplacement).not.toHaveBeenCalled();
  });

  it('lets the owner replace their own object', async () => {
    const { svc, driver, reservations } = service();

    const result = await upload(svc, { scope: { userId: 'owner' } });

    expect(driver.put).toHaveBeenCalledTimes(1);
    expect(driver.put.mock.calls[0][0]).toMatchObject({ bucket: 'public', key: 'avatars/123/pic.png' });
    expect(reservations.assertReplacementFits).toHaveBeenCalled();
    expect(result.file.size).toBe(4);
  });

  it('never deletes the previous object, and keeps it when the write fails', async () => {
    const { svc, driver, reservations, prisma } = service();
    driver.put.mockRejectedValueOnce(new Error('disk full'));

    await expect(upload(svc, { scope: { userId: 'owner' } })).rejects.toThrow('disk full');

    expect(driver.delete).not.toHaveBeenCalled();
    expect(prisma.file.delete).not.toHaveBeenCalled();
    expect(reservations.completeReplacement).not.toHaveBeenCalled();
  });

  it('checks quota before writing a single byte', async () => {
    const { svc, driver, reservations } = service();
    const order: string[] = [];
    reservations.assertReplacementFits.mockImplementationOnce(async () => {
      order.push('quota');
      throw Object.assign(new Error('Bucket quota exceeded'), { statusCode: 413 });
    });
    driver.put.mockImplementation(async () => {
      order.push('put');
    });

    await expect(upload(svc, { scope: { userId: 'owner' } })).rejects.toThrow('Bucket quota exceeded');
    expect(order).toEqual(['quota']);
  });

  it('asks the policy engine for an UPDATE when policies are on', async () => {
    const { svc, StoragePolicyService } = service({ policies: true });

    await upload(svc, { scope: { userId: 'anyone', caller: { id: 'anyone' } } });

    expect(StoragePolicyService.canWrite).toHaveBeenCalledWith(
      'update',
      expect.objectContaining({ key: 'avatars/123/pic.png' }),
      expect.objectContaining({ id: 'anyone' }),
    );
  });

  it('refuses the upsert when the UPDATE policy says no', async () => {
    const { svc, driver } = service({ policies: true, canWrite: false });

    await expect(upload(svc, { scope: { userId: 'anyone', caller: { id: 'anyone' } } }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(driver.put).not.toHaveBeenCalled();
  });
});

describe('storage insert authorization', () => {
  it('asks the policy engine for an INSERT on a fresh upload', async () => {
    const { svc, StoragePolicyService, reservations } = service({ existing: null, policies: true });

    await upload(svc, { upsert: false, scope: { userId: 'u2', caller: { id: 'u2' } } });

    expect(StoragePolicyService.canWrite).toHaveBeenCalledWith(
      'insert',
      expect.objectContaining({ key: 'avatars/123/pic.png', ownerId: 'intruder' }),
      expect.objectContaining({ id: 'u2' }),
    );
    expect(reservations.reserve).toHaveBeenCalled();
  });

  it('refuses a fresh upload the INSERT policy rejects, before reserving anything', async () => {
    const { svc, reservations, driver } = service({ existing: null, policies: true, canWrite: false });

    await expect(upload(svc, { upsert: false, scope: { userId: 'u2', caller: { id: 'u2' } } }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(driver.put).not.toHaveBeenCalled();
  });

  it('still refuses a colliding key without upsert', async () => {
    const { svc } = service();
    await expect(upload(svc, { upsert: false, scope: { userId: 'owner' } }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
