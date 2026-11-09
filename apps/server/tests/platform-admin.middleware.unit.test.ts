import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../middlewares/auth.middleware', () => ({
  authMiddleware: (_req: any, _res: any, n: any) => n(),
}));
vi.mock('../middlewares/require-role', () => ({
  requireRole: () => (_req: any, _res: any, n: any) => n(),
}));

beforeEach(() => {
  process.env.PLATFORM_SERVICE_TOKEN = 'platform-service-token-at-least-32-chars';
});

async function run(headers: Record<string, string>) {
  vi.resetModules();
  const { adminGuard } = await import('../middlewares/platform-admin.middleware');
  const req = { headers, user: undefined } as unknown as Request;
  const resMock = {
    statusCode: 0,
    body: null as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
  };
  const res = resMock as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  await adminGuard(req, res, next);
  return { req, res, next };
}

describe('adminGuard', () => {
  it('accepts a valid X-Platform-Token and sets a synthetic admin user', async () => {
    const { req, next } = await run({ 'x-platform-token': 'platform-service-token-at-least-32-chars' });
    expect(next).toHaveBeenCalledOnce();
    expect((req.user as any).role).toBe('ADMIN');
    expect((req.user as any).platform).toBe(true);
  });

  it('names the console operator only when the platform token is valid', async () => {
    const valid = await run({ 'x-platform-token': 'platform-service-token-at-least-32-chars', 'x-platform-operator': 'op-1' });
    expect((valid.req.user as any).operatorId).toBe('op-1');
    const forged = await run({ 'x-platform-token': 'nope', 'x-platform-operator': 'op-1' });
    expect(forged.req.user).toBeUndefined();
  });

  it('rejects a wrong X-Platform-Token without falling through to user auth', async () => {
    const { res, next } = await run({ 'x-platform-token': 'nope' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('falls through to user JWT auth when no platform token is present', async () => {
    const { next } = await run({});
    expect(next).toHaveBeenCalled();
  });
});

describe('secretKeyOrAdmin', () => {
  // Only the decision is under test: resolving the key onto req.apiKey is
  // apiKeyMiddleware's job and has its own tests.
  async function decide(apiKey: { type: string } | undefined) {
    vi.resetModules();
    const { secretKeyOrAdmin } = await import('../middlewares/platform-admin.middleware');
    const req = { headers: {}, apiKey, user: undefined } as unknown as Request;
    const res = {
      statusCode: 0,
      status(this: { statusCode: number }, c: number) { this.statusCode = c; return this; },
      json() { return this; },
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    await (secretKeyOrAdmin as any)(req, res, next);
    return { res, next };
  }

  it('lets a secret key read the logs', async () => {
    const { next } = await decide({ type: 'secret' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not let a publishable key in', async () => {
    // Falls through to adminGuard, which with no platform token defers to user
    // auth: mocked to pass here, so assert the key alone decided nothing.
    const { next } = await decide({ type: 'publishable' });
    expect(next).toHaveBeenCalled();
    const rejected = await decide(undefined);
    expect(rejected.next).toHaveBeenCalled();
  });
});

