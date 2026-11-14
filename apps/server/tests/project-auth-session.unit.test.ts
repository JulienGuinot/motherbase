import { describe, it, expect, vi } from 'vitest';
import { makeAuthMiddleware, makeOptionalAuthMiddleware } from '../auth/session';

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

// What a signed-in browser sends; the session itself comes from the mocked getSession.
const SIGNED_IN = { cookie: "better-auth.session_token=t" };

function deps(sessionUserId: string | null, user: any) {
  const auth: any = {
    options: { baseURL: 'http://localhost:3000' },
    api: { getSession: vi.fn(async () => (sessionUserId ? { user: { id: sessionUserId } } : null)) },
  };
  // No signing key on file: a JWT-shaped bearer is nobody's access token here
  // (tests/access-tokens.unit.test.ts covers the ones that are).
  const prisma: any = { user: { findUnique: vi.fn(async () => user) }, jwks: { findMany: vi.fn(async () => []) } };
  return { auth, prisma };
}

describe('makeAuthMiddleware', () => {
  it('401s without a session', async () => {
    const { auth, prisma } = deps(null, null);
    const mw = makeAuthMiddleware(() => auth, prisma);
    const r = res(); const next = vi.fn();
    await mw({ headers: {} } as any, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the full Prisma user for an active account', async () => {
    const user = { id: 'u1', email: 'a@b.c', status: 'active', role: 'USER' };
    const { auth, prisma } = deps('u1', user);
    const mw = makeAuthMiddleware(() => auth, prisma);
    const req: any = { headers: SIGNED_IN }; const r = res(); const next = vi.fn();
    await mw(req, r, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBe(user);
  });

  it('rejects an inactive account via the error path (403)', async () => {
    const user = { id: 'u2', status: 'deleted' };
    const { auth, prisma } = deps('u2', user);
    const mw = makeAuthMiddleware(() => auth, prisma);
    const req: any = { headers: SIGNED_IN }; const r = res(); const next = vi.fn();
    await mw(req, r, next);
    const err = next.mock.calls[0][0];
    expect(err?.statusCode).toBe(403);
    expect(req.user).toBeUndefined();
  });
});

describe('makeOptionalAuthMiddleware', () => {
  it('proceeds anonymously when there is no session', async () => {
    const { auth, prisma } = deps(null, null);
    const mw = makeOptionalAuthMiddleware(() => auth, prisma);
    const req: any = { headers: {} }; const next = vi.fn();
    await mw(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('does not ask Better Auth about a request that carries no credentials', async () => {
    // getSession builds a full endpoint context only to answer null: profiled
    // at ~9% of an anonymous REST read's CPU.
    const { auth, prisma } = deps('u9', { id: 'u9', status: 'active' });
    const mw = makeOptionalAuthMiddleware(() => auth, prisma);
    const req: any = { headers: { apikey: 'mb_publishable_x' } }; const next = vi.fn();
    await mw(req, res(), next);
    expect(auth.api.getSession).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('enriches req.user for an active account', async () => {
    const user = { id: 'u3', status: 'active' };
    const { auth, prisma } = deps('u3', user);
    const mw = makeOptionalAuthMiddleware(() => auth, prisma);
    const req: any = { headers: SIGNED_IN }; const next = vi.fn();
    await mw(req, res(), next);
    expect(req.user).toBe(user);
  });

  it('only offers JWT-shaped bearers to the third-party resolver', async () => {
    const { auth, prisma } = deps(null, null);
    const resolver = vi.fn(async () => null);
    const mw = makeOptionalAuthMiddleware(() => auth, prisma, resolver);

    await mw({ headers: { authorization: 'Bearer mb_secret_test' } } as any, res(), vi.fn());
    expect(resolver).not.toHaveBeenCalled();

    await mw({ headers: { authorization: 'Bearer a.b.c' } } as any, res(), vi.fn());
    expect(resolver).toHaveBeenCalledWith('a.b.c');
  });

  it('401s a user token that names no session, instead of serving it as anonymous', async () => {
    const { auth, prisma } = deps(null, null);
    const mw = makeOptionalAuthMiddleware(() => auth, prisma);
    const r = res(); const next = vi.fn();
    await mw({ headers: { authorization: 'Bearer revoked.c2ln' } } as any, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a project key, and an unknown bearer where allowed, through as anonymous', async () => {
    const { auth, prisma } = deps(null, null);
    const next = vi.fn();
    await makeOptionalAuthMiddleware(() => auth, prisma)({ headers: { authorization: 'Bearer mb_secret_x' } } as any, res(), next);
    const lenient = makeOptionalAuthMiddleware(() => auth, prisma, undefined, { allowUnknownBearer: true });
    await lenient({ headers: { authorization: 'Bearer cron-secret' } } as any, res(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
