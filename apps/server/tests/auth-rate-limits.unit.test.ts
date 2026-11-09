import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { DEFAULT_AUTH_RATE_LIMITS, DeliveryQuota, authRateBucket, createAuthRateLimiter } from '../auth/rate-limits';
import { getGroup } from '../config/settings';

describe('authRateBucket', () => {
  it.each([
    ['/sign-in/anonymous', 'anonymous'],
    ['/sign-in/email', 'signInSignUp'],
    ['/sign-up/email', 'signInSignUp'],
    ['/sign-in/email-otp', 'verify'],
    ['/magic-link/verify', 'verify'],
    ['/two-factor/verify-totp', 'verify'],
    ['/exchange-code', 'verify'],
    ['/phone-number/verify', 'verify'],
    ['/phone-number/reset-password', 'verify'],
    ['/token', 'tokenRefresh'],
    ['/get-session', null],
    ['/admin/users', null],
  ])('%s -> %s', (path, bucket) => {
    expect(authRateBucket(path)).toBe(bucket);
  });
});

describe('createAuthRateLimiter', () => {
  function app(limits = { ...DEFAULT_AUTH_RATE_LIMITS, signInSignUpPer5Min: 2, anonymousPerHour: 1 }) {
    const server = express();
    server.use('/api/auth', createAuthRateLimiter(async () => limits));
    server.all('/api/auth/*', (_req, res) => res.json({ ok: true }));
    return server;
  }

  it('refuses the request past the limit with GoTrue\'s error code', async () => {
    const server = app();
    await request(server).post('/api/auth/sign-in/email').expect(200);
    await request(server).post('/api/auth/sign-up/email').expect(200);
    const res = await request(server).post('/api/auth/sign-in/email').expect(429);
    expect(res.body.code).toBe('over_request_rate_limit');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts each kind on its own', async () => {
    const server = app();
    await request(server).post('/api/auth/sign-in/anonymous').expect(200);
    await request(server).post('/api/auth/sign-in/anonymous').expect(429);
    await request(server).post('/api/auth/sign-in/email').expect(200);
    await request(server).get('/api/auth/get-session').expect(200);
  });
});

describe('DeliveryQuota', () => {
  it('caps email and SMS separately, per project', () => {
    const quota = new DeliveryQuota();
    const limits = { ...DEFAULT_AUTH_RATE_LIMITS, emailSentPerHour: 1, smsSentPerHour: 1 };
    expect(quota.allow('email', limits)).toBe(true);
    expect(quota.allow('email', limits)).toBe(false);
    expect(quota.allow('sms', limits)).toBe(true);
  });
});

describe('auth.rateLimits group', () => {
  it('defaults to GoTrue\'s limits', () => {
    expect(getGroup('auth.rateLimits')!.schema.parse({})).toEqual(DEFAULT_AUTH_RATE_LIMITS);
  });
});
