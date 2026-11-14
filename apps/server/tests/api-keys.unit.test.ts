import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeyService, RESOLVED_KEY_TTL_MS } from '../services/api-key.service';
import { rlsContextFor } from '../lib/rls-claims';

// The middleware resolves its dependencies from the container at call time, so
// the container is the seam. Hoisted because vi.mock is hoisted above imports.
const stub = vi.hoisted(() => ({
  resolvedKey: null as unknown,
  requireApiKey: false,
}));

vi.mock('../container', () => ({
  default: {
    resolve: (name: string) =>
      name === 'ApiKeyService'
        ? { resolve: async () => stub.resolvedKey }
        : { get: async () => ({ requireApiKey: stub.requireApiKey }) },
  },
}));

// Static import is fine: vi.mock is hoisted above it, so the middleware sees the
// stubbed container when it resolves at call time.
import { apiKeyMiddleware, callerFor, requireSecretKey } from '../middlewares/api-key.middleware';

// The three things that would be a privilege bug if they broke:
//   1. a secret key, and only a secret key, produces the service_role context;
//   2. a secret key's clear value is never persisted;
//   3. a revoked key stops resolving.

interface Row {
  id: string;
  name: string;
  type: string;
  prefix: string;
  tokenHash: string;
  token: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** Minimal stand-in for the Prisma delegate: an array with the four calls used. */
function fakeDelegate(rows: Row[] = []) {
  let seq = 0;
  return {
    rows,
    async findUnique({ where }: any) {
      return rows.find(r => (where.id ? r.id === where.id : r.tokenHash === where.tokenHash)) ?? null;
    },
    async findFirst({ where }: any) {
      return (
        rows.find(r => r.type === where.type && (where.revokedAt === null ? r.revokedAt === null : true)) ?? null
      );
    },
    async findMany() {
      return [...rows];
    },
    async create({ data }: any) {
      const row: Row = { id: `key_${++seq}`, createdAt: new Date(), revokedAt: null, ...data };
      rows.push(row);
      return row;
    },
    async update({ where, data }: any) {
      const row = rows.find(r => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };
}

function serviceWith(delegate: ReturnType<typeof fakeDelegate>) {
  return new ApiKeyService({ prisma: { projectApiKey: delegate } } as any);
}

describe('ApiKeyService', () => {
  let delegate: ReturnType<typeof fakeDelegate>;
  let service: ApiKeyService;

  beforeEach(() => {
    delegate = fakeDelegate();
    service = serviceWith(delegate);
  });

  it('stores a publishable key in clear and a secret key only as a hash', async () => {
    const publishable = await service.create('web', 'publishable');
    const secret = await service.create('server', 'secret');

    expect(publishable.clearToken).toMatch(/^mb_publishable_/);
    expect(secret.clearToken).toMatch(/^mb_secret_/);

    const stored = delegate.rows;
    expect(stored.find(r => r.type === 'publishable')!.token).toBe(publishable.clearToken);
    expect(stored.find(r => r.type === 'secret')!.token).toBeNull();
    // The clear secret must not be recoverable from anything we persisted.
    expect(JSON.stringify(stored)).not.toContain(secret.clearToken);
    expect(stored.find(r => r.type === 'secret')!.tokenHash).toBe(ApiKeyService.hash(secret.clearToken));
  });

  it('resolves a valid token and refuses unknown, empty and revoked ones', async () => {
    const created = await service.create('server', 'secret');

    expect(await service.resolve(created.clearToken)).toMatchObject({ type: 'secret', name: 'server' });
    expect(await service.resolve('mb_secret_nope')).toBeNull();
    expect(await service.resolve('')).toBeNull();
    expect(await service.resolve(undefined)).toBeNull();

    await service.revoke(created.id);
    expect(await service.resolve(created.clearToken)).toBeNull();
  });

  it('reads a valid key once, then answers from memory until it is revoked or expires', async () => {
    const created = await service.create('server', 'secret');
    const lookups = vi.spyOn(delegate, 'findUnique');

    await service.resolve(created.clearToken);
    await service.resolve(created.clearToken);
    expect(lookups).toHaveBeenCalledTimes(1);

    // A wrong token is never remembered: it would let a flood of them grow the map.
    await service.resolve('mb_secret_nope');
    await service.resolve('mb_secret_nope');
    expect(lookups).toHaveBeenCalledTimes(3);

    // A row revoked behind the service's back (another instance, SQL by hand)
    // stops resolving once the entry expires.
    delegate.rows[0].revokedAt = new Date();
    expect(await service.resolve(created.clearToken)).not.toBeNull();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(RESOLVED_KEY_TTL_MS + 1);
      expect(await service.resolve(created.clearToken)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mints the default publishable key once and reuses it after', async () => {
    const first = await service.ensurePublishable();
    const second = await service.ensurePublishable();
    expect(second.id).toBe(first.id);
    expect(delegate.rows).toHaveLength(1);
  });

  it('rejects an unknown key type', async () => {
    await expect(service.create('x', 'admin' as any)).rejects.toThrow(/publishable/);
  });
});

describe('caller resolution', () => {
  const req = (apiKey: unknown, user?: unknown) => ({ apiKey, user }) as any;

  it('raises to service_role only for a secret key', () => {
    expect(rlsContextFor(callerFor(req(undefined))).role).toBe('anon');
    expect(rlsContextFor(callerFor(req({ id: 'k', name: 'web', type: 'publishable' }))).role).toBe('anon');
    expect(rlsContextFor(callerFor(req({ id: 'k', name: 'srv', type: 'secret' }))).role).toBe('service_role');
  });

  it('leaves an authenticated caller authenticated under a publishable key', () => {
    const ctx = rlsContextFor(callerFor(req({ id: 'k', name: 'web', type: 'publishable' }, { id: 'u1', role: 'USER' })));
    expect(ctx.role).toBe('authenticated');
    expect(JSON.parse(ctx.claims)).toMatchObject({ sub: 'u1', role: 'authenticated' });
  });

  it('keeps sub in the claims when a secret key rides along with a user token', () => {
    const ctx = rlsContextFor(callerFor(req({ id: 'k', name: 'srv', type: 'secret' }, { id: 'u1', role: 'USER' })));
    expect(ctx.role).toBe('service_role');
    expect(JSON.parse(ctx.claims)).toMatchObject({ sub: 'u1', role: 'service_role' });
  });

  it('does not let a field on the user row forge service_role', () => {
    // Only req.apiKey may decide this. A user row carrying `serviceRole` must be
    // projected away, not spread through.
    const ctx = rlsContextFor(callerFor(req(undefined, { id: 'u1', role: 'USER', serviceRole: true })));
    expect(ctx.role).toBe('authenticated');
  });
});

describe('apiKeyMiddleware', () => {
  const run = async (headers: Record<string, string>) => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as any;
    const next = vi.fn();
    const req = { headers } as any;
    await apiKeyMiddleware(req, res, next);
    return { req, res, next, json };
  };

  beforeEach(() => {
    stub.resolvedKey = null;
    stub.requireApiKey = false;
  });

  it('401s when the project requires a key and none is valid', async () => {
    stub.requireApiKey = true;
    const { res, next } = await run({});
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an anonymous caller through when enforcement is off', async () => {
    const { res, next, req } = await run({});
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('reads the apikey header', async () => {
    stub.resolvedKey = { id: 'k', name: 'srv', type: 'secret' };
    const { req } = await run({ apikey: 'mb_secret_abc' });
    expect(req.apiKey).toMatchObject({ type: 'secret' });
  });

  it('accepts a key in Authorization only when it carries the key prefix', async () => {
    stub.resolvedKey = { id: 'k', name: 'srv', type: 'secret' };
    const withKey = await run({ authorization: 'Bearer mb_secret_abc' });
    expect(withKey.req.apiKey).toMatchObject({ type: 'secret' });

    // A user access token in the same header must never be tried as a project
    // key: the stub would happily "resolve" it, so only the prefix guard stops it.
    const withUserToken = await run({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' });
    expect(withUserToken.req.apiKey).toBeUndefined();
  });
});

// The gate on /api/auth/admin/*. It grants nothing by itself, so the only thing
// worth pinning is that it fails closed for every input that is not a secret key.
describe('requireSecretKey', () => {
  const run = (apiKey: unknown) => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as any;
    const next = vi.fn();
    requireSecretKey({ apiKey } as any, res, next);
    return { res, next };
  };

  it('lets a secret key through', () => {
    const { res, next } = run({ id: 'k', name: 'srv', type: 'secret' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('401s a publishable key, an unknown type and no key at all', () => {
    for (const key of [{ id: 'k', name: 'web', type: 'publishable' }, { type: 'admin' }, undefined]) {
      const { res, next } = run(key);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });
});
