import { beforeEach, describe, expect, it, vi } from 'vitest';

// The gate resolves StoragePolicyService and reads the caller at call time.
const stub = vi.hoisted(() => ({ policiesEnabled: false }));

vi.mock('../container', () => ({
  default: { resolve: () => ({ enabled: async () => stub.policiesEnabled }) },
}));
vi.mock('../middlewares/auth.middleware', () => ({ optionalAuthMiddleware: vi.fn() }));

import { storageAuth } from '../middlewares/storage-auth.middleware';

const requireStorageCaller = storageAuth[storageAuth.length - 1] as (req: any, res: any, next: (e?: any) => void) => Promise<void>;
const run = async (req: object) => {
  const next = vi.fn();
  await requireStorageCaller(req, {}, next);
  return next.mock.calls[0][0];
};

describe('storage auth gate', () => {
  beforeEach(() => {
    stub.policiesEnabled = false;
  });

  it('blocks anonymous callers with 401 unless storage policies are enabled', async () => {
    expect(await run({})).toMatchObject({ statusCode: 401 });
    stub.policiesEnabled = true;
    expect(await run({})).toBeUndefined();
  });

  it('lets a service-role key through', async () => {
    expect(await run({ apiKey: { type: 'secret' } })).toBeUndefined();
  });

  it('lets a signed-in user through', async () => {
    expect(await run({ user: { id: 'u1', email: 'a@b.c' } })).toBeUndefined();
  });
});
