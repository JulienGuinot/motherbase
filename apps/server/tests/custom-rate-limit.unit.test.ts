import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRateLimitRules,
  customRulesLimiter,
  setRateLimitIdentityResolver,
  __resetRateLimitRulesForTests,
} from '../middlewares/custom-rate-limit';
import { shieldTelemetry } from '../lib/shield-telemetry';

function appWith() {
  const app = express();
  app.use(customRulesLimiter);
  app.get('/rest/orders', (_req, res) => res.json({ ok: true }));
  app.post('/auth/sign-in', (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => __resetRateLimitRulesForTests());
afterEach(() => vi.restoreAllMocks());

describe('customRulesLimiter', () => {
  it('passes through when no rules are configured', async () => {
    const app = appWith();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/rest/orders')).status).toBe(200);
    }
  });

  it('blocks past a matching IP rule and names the rule', async () => {
    applyRateLimitRules({
      rules: [{ id: 'r1', name: 'orders cap', enabled: true, match: { pathGlob: '/rest/*' }, key: 'ip', windowSec: 60, max: 1 }],
    });
    const app = appWith();

    expect((await request(app).get('/rest/orders')).status).toBe(200);
    const blocked = await request(app).get('/rest/orders');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toContain('orders cap');
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('does not touch requests that no rule matches', async () => {
    applyRateLimitRules({
      rules: [{ id: 'r1', name: 'edge only', enabled: true, match: { pathGlob: '/edge/*' }, key: 'ip', windowSec: 60, max: 1 }],
    });
    const app = appWith();
    expect((await request(app).get('/rest/orders')).status).toBe(200);
    expect((await request(app).get('/rest/orders')).status).toBe(200);
  });

  it('ignores disabled rules', async () => {
    applyRateLimitRules({
      rules: [{ id: 'r1', name: 'off', enabled: false, match: {}, key: 'ip', windowSec: 60, max: 1 }],
    });
    const app = appWith();
    expect((await request(app).get('/rest/orders')).status).toBe(200);
    expect((await request(app).get('/rest/orders')).status).toBe(200);
  });

  it('buckets user-keyed rules per resolved identity', async () => {
    applyRateLimitRules({
      rules: [{ id: 'r1', name: 'per user', enabled: true, match: {}, key: 'user', windowSec: 60, max: 1 }],
    });
    // Resolve identity from a test header, never touching auth/DB.
    setRateLimitIdentityResolver(req => ({ userId: req.headers['x-test-user'] as string | undefined, role: 'USER' }));
    const app = appWith();

    expect((await request(app).get('/rest/orders').set('x-test-user', 'alice')).status).toBe(200);
    // bob has his own budget
    expect((await request(app).get('/rest/orders').set('x-test-user', 'bob')).status).toBe(200);
    // alice is now over hers
    expect((await request(app).get('/rest/orders').set('x-test-user', 'alice')).status).toBe(429);
  });

  it('records telemetry once when it blocks', async () => {
    const spy = vi.spyOn(shieldTelemetry, 'recordRateLimit');
    applyRateLimitRules({
      rules: [{ id: 'r1', name: 'cap', enabled: true, match: {}, key: 'ip', windowSec: 60, max: 1 }],
    });
    const app = appWith();
    await request(app).get('/rest/orders');
    await request(app).get('/rest/orders');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toContain('cap');
  });
});
