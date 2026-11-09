import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

/**
 * The impersonation header is a privilege boundary, so the refusal paths are
 * asserted before the success path.
 *
 * The header lets a SECRET key run a request as another user, which is what
 * makes an RLS policy testable. Honoured for anything less than a secret key it
 * would be an escalation; ignored silently it would make a test pass while
 * running as service_role, proving nothing about the policy it claims to check.
 * Both are failures, so both are pinned here.
 */

const findUnique = vi.fn();

vi.mock('../lib/prisma', () => ({
  default: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

let resolvedKey: { type: string } | null = null;

vi.mock('../container', () => ({
  default: {
    resolve: (name: string) => {
      if (name === 'ApiKeyService') return { resolve: async () => resolvedKey };
      if (name === 'SettingsService') return { get: async () => ({ requireApiKey: false }) };
      throw new Error(`unexpected resolve(${name})`);
    },
  },
}));

beforeEach(() => {
  findUnique.mockReset();
  resolvedKey = null;
});

async function run(headers: Record<string, string>, user?: { id: string; role?: string; email?: string }) {
  const { apiKeyMiddleware, callerFor } = await import('../middlewares/api-key.middleware');
  const req = { headers, user } as unknown as Request;
  const resMock = {
    statusCode: 0,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  const next = vi.fn() as unknown as NextFunction;
  await apiKeyMiddleware(req, resMock as unknown as Response, next);
  return { req, res: resMock, next, caller: () => callerFor(req) };
}

describe('x-motherbase-impersonate', () => {
  it('refuses the header for a publishable key instead of ignoring it', async () => {
    resolvedKey = { type: 'publishable' };
    const { res, next, req } = await run({ apikey: 'mb_publishable_x', 'x-motherbase-impersonate': 'user-1' });

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.impersonate).toBeUndefined();
  });

  it('refuses the header with no key at all', async () => {
    const { res, next } = await run({ 'x-motherbase-impersonate': 'user-1' });

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an unknown user id rather than falling back to service_role', async () => {
    resolvedKey = { type: 'secret' };
    findUnique.mockResolvedValue(null);
    const { res, next } = await run({ apikey: 'mb_secret_x', 'x-motherbase-impersonate': 'ghost' });

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('runs as the named user, WITHOUT service_role', async () => {
    resolvedKey = { type: 'secret' };
    findUnique.mockResolvedValue({ id: 'user-1', role: 'USER', email: 'a@b.c' });
    const { caller, next } = await run({ apikey: 'mb_secret_x', 'x-motherbase-impersonate': 'user-1' });

    expect(next).toHaveBeenCalledOnce();
    // The whole point: the key that authorised this bypasses RLS, and the
    // resulting caller does not.
    expect(caller()).toEqual({ id: 'user-1', role: 'USER', email: 'a@b.c' });
    expect(caller()?.serviceRole).toBeFalsy();
  });

  it('runs as nobody for anon, even though a user token rode along', async () => {
    resolvedKey = { type: 'secret' };
    const { caller } = await run(
      { apikey: 'mb_secret_x', 'x-motherbase-impersonate': 'anon' },
      { id: 'user-9', role: 'USER', email: 'z@z.z' },
    );

    expect(caller()).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('leaves a secret key without the header as service_role', async () => {
    resolvedKey = { type: 'secret' };
    const { caller } = await run({ apikey: 'mb_secret_x' });

    expect(caller()).toEqual({ serviceRole: true });
  });
});
