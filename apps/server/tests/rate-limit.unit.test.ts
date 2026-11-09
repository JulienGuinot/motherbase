import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  applyRateLimitLimits,
  currentRateLimitLimits,
  currentRateLimitWindowMs,
  globalLimiter,
  rateLimitConfig,
} from '../middlewares/rate-limit';

// Restore env-seeded defaults before each test so ordering never matters.
const DEFAULTS = currentRateLimitLimits();

describe('rate-limit live overrides', () => {
  beforeEach(() => applyRateLimitLimits(DEFAULTS));

  it('applies valid positive overrides', () => {
    applyRateLimitLimits({ global: 5000, auth: 3 });
    const c = currentRateLimitLimits();
    expect(c.global).toBe(5000);
    expect(c.auth).toBe(3);
    // Untouched scopes keep their previous value.
    expect(c.restRead).toBe(DEFAULTS.restRead);
  });

  it('floors non-integer values', () => {
    applyRateLimitLimits({ edge: 12.9 });
    expect(currentRateLimitLimits().edge).toBe(12);
  });

  it('ignores non-positive / non-finite values (never opens the gate to 0)', () => {
    applyRateLimitLimits({ global: 0, auth: -10, restWrite: Number.NaN });
    const c = currentRateLimitLimits();
    expect(c.global).toBe(DEFAULTS.global);
    expect(c.auth).toBe(DEFAULTS.auth);
    expect(c.restWrite).toBe(DEFAULTS.restWrite);
  });

  it('exposes the live values through rateLimitConfig.limits', () => {
    applyRateLimitLimits({ restRead: 999 });
    expect(rateLimitConfig.limits.restRead).toBe(999);
  });
});

/**
 * `express-rate-limit` reads `windowMs` once at construction, so the window used
 * to be the one knob in `security.rateLimit` that silently needed a restart
 * while the five maxima beside it applied live. The limiters are rebuilt on a
 * window change instead.
 */
describe('rate-limit window', () => {
  const START_WINDOW_MS = currentRateLimitWindowMs();

  beforeEach(() => {
    applyRateLimitLimits({ ...DEFAULTS, windowMin: START_WINDOW_MS / 60_000 });
  });

  it('applies a new window without a restart', () => {
    applyRateLimitLimits({ windowMin: 5 });
    expect(currentRateLimitWindowMs()).toBe(5 * 60 * 1000);
    expect(rateLimitConfig.windowMs).toBe(5 * 60 * 1000);
  });

  it('ignores non-positive / non-finite windows', () => {
    applyRateLimitLimits({ windowMin: 0 });
    applyRateLimitLimits({ windowMin: -3 });
    applyRateLimitLimits({ windowMin: Number.NaN });
    expect(currentRateLimitWindowMs()).toBe(START_WINDOW_MS);
  });

  it('caps the window at a day so a typo cannot park every counter', () => {
    applyRateLimitLimits({ windowMin: 60 * 24 * 365 });
    expect(currentRateLimitWindowMs()).toBe(24 * 60 * 60 * 1000);
  });

  it('rebuilds the limiter so the new window really is in force', async () => {
    const app = express();
    app.use(globalLimiter);
    app.get('/ping', (_req, res) => { res.json({ ok: true }); });

    applyRateLimitLimits({ global: 1, windowMin: 5 });
    expect((await request(app).get('/ping')).status).toBe(200);
    // Second request in the same window is over the limit of 1.
    const limited = await request(app).get('/ping');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');

    // Changing the window rebuilds the limiter, which resets the counters.
    // The documented consequence, and the observable proof it was rebuilt at
    // all rather than still running on the window it was constructed with.
    applyRateLimitLimits({ windowMin: 7 });
    const afterRebuild = await request(app).get('/ping');
    expect(afterRebuild.status).toBe(200);
    expect(currentRateLimitWindowMs()).toBe(7 * 60 * 1000);
  });

  it('does not rebuild when the window is unchanged, so counters survive a no-op save', async () => {
    const app = express();
    app.use(globalLimiter);
    app.get('/ping', (_req, res) => { res.json({ ok: true }); });

    applyRateLimitLimits({ global: 1, windowMin: 9 });
    expect((await request(app).get('/ping')).status).toBe(200);

    // Saving the same window again must not hand every throttled caller a fresh
    // allowance, or the limit becomes trivially bypassable by an operator save.
    applyRateLimitLimits({ global: 1, windowMin: 9 });
    expect((await request(app).get('/ping')).status).toBe(429);
  });
});
