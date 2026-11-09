import { describe, it, expect, vi } from 'vitest';
import AdminStorageController from '../controllers/admin/admin-storage.controller';

// The key-addressed admin routes behind `motherbase storage ls|cp|mv|rm`. What
// matters is that they act as the service role (the admin API has no owning
// user, so an owner check would refuse every object) and that the key, which
// contains slashes, reaches the service whole.

function fakeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

const SERVICE_ROLE = { caller: { serviceRole: true } };

describe('AdminStorageController objects by key', () => {
  it('moves as the service role, passing both keys and upsert through', async () => {
    const moveObject = vi.fn(async () => ({ path: 'b/c.txt' }));
    const controller = new AdminStorageController({ StorageService: { moveObject } } as any);
    const next = vi.fn();

    await controller.moveBucketObject(
      { params: { slug: 'docs' }, body: { from: 'a/b.txt', to: 'b/c.txt', upsert: true } } as any,
      fakeRes(),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(moveObject).toHaveBeenCalledWith('docs', 'a/b.txt', 'b/c.txt', SERVICE_ROLE, { upsert: true });
  });

  it('refuses a copy without both keys, before touching storage', async () => {
    const copyObject = vi.fn();
    const controller = new AdminStorageController({ StorageService: { copyObject } } as any);
    const next = vi.fn();

    await controller.copyBucketObject({ params: { slug: 'docs' }, body: { from: 'a.txt' } } as any, fakeRes(), next);

    expect(copyObject).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
  });

  it('deletes the whole wildcard key', async () => {
    const removeByKey = vi.fn(async () => ({ deleted: true }));
    const controller = new AdminStorageController({ StorageService: { removeByKey } } as any);

    await controller.removeBucketObject({ params: { slug: 'docs', 0: 'deep/dir/file.txt' } } as any, fakeRes(), vi.fn());

    expect(removeByKey).toHaveBeenCalledWith('docs', 'deep/dir/file.txt', SERVICE_ROLE);
  });

  it('lists under a prefix as the service role', async () => {
    const listObjects = vi.fn(async () => []);
    const controller = new AdminStorageController({ StorageService: { listObjects } } as any);

    await controller.listBucketObjects(
      { params: { slug: 'docs' }, query: { prefix: 'deep/', limit: '1000', offset: '0' } } as any,
      fakeRes(),
      vi.fn(),
    );

    expect(listObjects).toHaveBeenCalledWith('docs', { prefix: 'deep/', limit: 1000, offset: 0 }, SERVICE_ROLE);
  });
});
