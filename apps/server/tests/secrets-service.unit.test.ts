import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { SecretsService } from '../services/admin/secrets.service';

function makeService(initial: any[] = []) {
  const store = [...initial];
  const delegate = {
    findMany: vi.fn(async ({ orderBy }: any = {}) => {
      const rows = [...store];
      if (orderBy?.name) rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = store.find(r => r.name === where.name);
      if (existing) {
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      }
      const row = { id: `id-${store.length}`, ...create, updatedAt: new Date() };
      store.push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i--) if (store[i].name === where.name) store.splice(i, 1);
      return { count: before - store.length };
    }),
  };
  return { service: new SecretsService({ prisma: { edgeFunctionSecret: delegate } } as any), delegate, store };
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
});

describe('SecretsService', () => {
  it('rejects invalid names', async () => {
    const { service } = makeService();
    await expect(service.set('1bad', 'x')).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.set('with space', 'x')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects empty values', async () => {
    const { service } = makeService();
    await expect(service.set('STRIPE_KEY', '')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('stores the value encrypted, never as plaintext', async () => {
    const { service, store } = makeService();
    await service.set('STRIPE_KEY', 'sk_live_secret');
    expect(store[0].value).not.toContain('sk_live_secret');
    expect(store[0].value.startsWith('v1:')).toBe(true);
  });

  it('never returns plaintext in list', async () => {
    const { service } = makeService();
    await service.set('STRIPE_KEY', 'sk_live_secret');
    const list = await service.list();
    expect(list[0].name).toBe('STRIPE_KEY');
    expect(JSON.stringify(list)).not.toContain('sk_live_secret');
  });

  it('round-trips via resolve for sandbox injection', async () => {
    const { service } = makeService();
    await service.set('STRIPE_KEY', 'sk_live_secret');
    await service.set('API_HOST', 'https://x');
    const env = await service.resolve();
    expect(env).toEqual({ STRIPE_KEY: 'sk_live_secret', API_HOST: 'https://x' });
  });

  it('upserts existing secret rather than duplicating', async () => {
    const { service, store } = makeService();
    await service.set('TOKEN', 'a');
    await service.set('TOKEN', 'b');
    expect(store).toHaveLength(1);
    expect((await service.resolve()).TOKEN).toBe('b');
  });

  it('fails to set when encryption key missing', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    const { service } = makeService();
    await expect(service.set('TOKEN', 'a')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('resolve returns empty when encryption key missing', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    const { service } = makeService();
    expect(await service.resolve()).toEqual({});
  });
});
