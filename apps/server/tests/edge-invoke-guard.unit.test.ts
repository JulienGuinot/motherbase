import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeEqual } from '../lib/safe-equal';

const env = vi.hoisted(() => ({ EDGE_PUBLIC_INVOKE_ENABLED: false, EDGE_INVOKE_TOKEN: 'secret-token' as string | undefined }));
vi.mock('../config/env', () => ({ env }));
const publicRoutes = vi.hoisted(() => new Set<string>());
const apiKeys = vi.hoisted(() => new Map<string, 'secret' | 'publishable'>());
vi.mock('../container', () => ({
  default: {
    resolve: (name: string) => name === 'ApiKeyService'
      ? { resolve: async (token: string) => (apiKeys.has(token) ? { id: token, name: token, type: apiKeys.get(token) } : null) }
      : { isPublic: async (route: string) => publicRoutes.has(route) },
  },
}));

import { edgeInvokeGuard } from '../middlewares/edge-invoke-guard';

async function run(req: Partial<Request>) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  await edgeInvokeGuard({ headers: {}, params: { route: 'hook' }, ...req } as Request, { status, json } as unknown as Response, next);
  return { next, status, json };
}

describe('safeEqual', () => {
  it('matches equal strings only', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('edgeInvokeGuard', () => {
  beforeEach(() => {
    env.EDGE_PUBLIC_INVOKE_ENABLED = false;
    env.EDGE_INVOKE_TOKEN = 'secret-token';
    publicRoutes.clear();
    apiKeys.clear();
  });

  it('rejects an anonymous request without a token', async () => {
    const { next, status, json } = await run({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('rejects a wrong token', async () => {
    expect((await run({ headers: { 'x-motherbase-edge-token': 'nope' } })).next).not.toHaveBeenCalled();
  });

  it('accepts the right token on either header', async () => {
    expect((await run({ headers: { 'x-motherbase-edge-token': 'secret-token' } })).next).toHaveBeenCalled();
    expect((await run({ headers: { 'x-edge-invoke-token': 'secret-token' } })).next).toHaveBeenCalled();
  });

  it('never accepts an empty token when none is configured', async () => {
    env.EDGE_INVOKE_TOKEN = undefined;
    expect((await run({ headers: { 'x-edge-invoke-token': '' } })).next).not.toHaveBeenCalled();
  });

  it('lets an authenticated user or the public opt-in through', async () => {
    expect((await run({ user: { id: 'u1' } } as Partial<Request>)).next).toHaveBeenCalled();
    env.EDGE_PUBLIC_INVOKE_ENABLED = true;
    expect((await run({})).next).toHaveBeenCalled();
  });

  it('opens only the function marked public to anonymous callers', async () => {
    publicRoutes.add('stripe-webhook');
    expect((await run({ params: { route: 'stripe-webhook' } } as Partial<Request>)).next).toHaveBeenCalled();
    expect((await run({ params: { route: 'admin-report' } } as Partial<Request>)).status).toHaveBeenCalledWith(401);
  });

  it('accepts a secret project key, never a publishable or unknown one', async () => {
    apiKeys.set('mb_secret_ok', 'secret');
    apiKeys.set('mb_publishable_ok', 'publishable');
    expect((await run({ headers: { apikey: 'mb_secret_ok' } })).next).toHaveBeenCalled();
    expect((await run({ headers: { authorization: 'Bearer mb_secret_ok' } })).next).toHaveBeenCalled();
    expect((await run({ headers: { apikey: 'mb_publishable_ok' } })).status).toHaveBeenCalledWith(401);
    expect((await run({ headers: { apikey: 'mb_revoked' } })).status).toHaveBeenCalledWith(401);
  });
});
