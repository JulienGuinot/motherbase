import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { FileStatus, FileVisibility } from '@prisma/client';
import UserController from '../controllers/user.controller';
import { StorageService } from '../services/storage/storage.service';
import { UserService } from '../services/user.service';

const stableUrl = 'http://api.test/public/avatars/u1/avatar.png';

function response() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe('avatar upload controller', () => {
  it('stores avatars publicly in the dedicated user namespace and persists the stable URL', async () => {
    const upload = vi.fn(async ({ body }: { body: Readable }) => {
      for await (const _chunk of body) {
        // Consume the same stream the real driver receives.
      }
      return { file: { id: 'avatar-file' }, url: stableUrl };
    });
    const uploadPath = path.join(os.tmpdir(), `mb-avatar-${Date.now()}.png`);
    await fs.writeFile(uploadPath, 'png');
    const updateImage = vi.fn(async (image: unknown) => ({
      data: { id: 'u1', imageUrl: stableUrl },
      message: 'Profile image updated successfully.',
      image,
    }));
    const controller = new UserController({
      StorageService: { upload },
      UserService: { updateImage },
    } as any);
    const req: any = {
      user: { id: 'u1' },
      file: {
        originalname: 'avatar.png',
        mimetype: 'image/png',
        path: uploadPath,
        size: 3,
      },
    };
    const res = response();
    const next = vi.fn();

    await controller.updateImage(req, res, next);

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'u1',
        visibility: FileVisibility.public,
        namespace: 'avatars/u1',
      })
    );
    expect(updateImage).toHaveBeenCalledWith({ fileId: 'avatar-file', url: stableUrl }, req.user);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.data.imageUrl).toBe(stableUrl);
    expect(stableUrl).not.toContain('/uploads/');
  });
});

describe('UserService avatar replacement', () => {
  it('keeps the current avatar when the uploaded image has no readable URL', async () => {
    const update = vi.fn();
    const remove = vi.fn(async () => ({ deleted: true }));
    const service = new UserService({ prisma: { user: { update } }, StorageService: { remove } } as any);

    await expect(service.updateImage({ fileId: 'new-file', url: null }, { id: 'u1' } as any))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(update).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('new-file', { userId: 'u1' });
  });

  it('persists the new URL then removes the previous owned avatar best-effort', async () => {
    const remove = vi.fn(async () => ({ deleted: true }));
    const prisma = {
      user: {
        findUnique: vi.fn(async () => ({ imageUrl: 'http://api.test/public/avatars/u1/old.png' })),
        update: vi.fn(async ({ data }: any) => ({
          id: 'u1',
          email: 'u@example.test',
          status: 'active',
          ...data,
        })),
      },
      file: {
        findFirst: vi.fn(async () => ({ id: 'old-file' })),
      },
    };
    const service = new UserService({
      prisma,
      StorageService: { remove },
    } as any);

    const result = await service.updateImage({ fileId: 'new-file', url: stableUrl }, { id: 'u1' } as any);

    expect(result.data?.imageUrl).toBe(stableUrl);
    expect(prisma.file.findFirst).toHaveBeenCalledWith({
      where: {
        ownerId: 'u1',
        url: 'http://api.test/public/avatars/u1/old.png',
        key: { startsWith: 'avatars/u1/' },
      },
      select: { id: true },
    });
    expect(remove).toHaveBeenCalledWith('old-file', { userId: 'u1' });
  });

  it('removes the newly uploaded object if persisting the URL fails', async () => {
    const remove = vi.fn(async () => ({ deleted: true }));
    const service = new UserService({
      prisma: {
        user: {
          findUnique: vi.fn(async () => ({ imageUrl: null })),
          update: vi.fn(async () => {
            throw new Error('database unavailable');
          }),
        },
      },
      StorageService: { remove },
    } as any);

    // The failure propagates so the error middleware can map it to a 5xx.
    // Returning it as a `{ message }` payload used to report a dead database as
    // HTTP 200. The compensating delete still runs either way.
    await expect(
      service.updateImage({ fileId: 'new-file', url: stableUrl }, { id: 'u1' } as any),
    ).rejects.toThrow('database unavailable');

    expect(remove).toHaveBeenCalledWith('new-file', { userId: 'u1' });
  });
});

describe('avatar readability', () => {
  it('serves a ready public avatar without exposing the storage root', async () => {
    const avatar = {
      id: 'avatar-file',
      ownerId: 'u1',
      bucketId: null,
      bucket: 'public',
      key: 'avatars/u1/avatar.png',
      mime: 'image/png',
      size: 3,
      visibility: FileVisibility.public,
      status: FileStatus.ready,
      uploadExpiresAt: null,
      url: stableUrl,
    };
    const service = new StorageService({
      prisma: { file: { findUnique: vi.fn(async () => avatar) } },
      BucketService: {},
    } as any);
    (service as any).driver = {
      getObject: vi.fn(async () => ({
        body: Readable.from('png'),
        contentLength: 3,
        contentType: 'image/png',
      })),
    };

    const result = await service.streamFile('avatar-file');

    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('png');
    expect(avatar.url).toBe(stableUrl);
    expect(avatar.url).not.toContain('/uploads/');
  });
});
