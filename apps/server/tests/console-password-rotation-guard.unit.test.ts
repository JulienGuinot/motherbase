import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { enforcePasswordRotation } from '../console/auth/session';

function appFor(mustChangePassword: boolean) {
  const auth = {
    api: {
      getSession: vi.fn().mockResolvedValue({ user: { mustChangePassword } }),
    },
  };
  const app = express();
  app.use(enforcePasswordRotation(auth as never));
  app.all('*', (_req, res) => res.status(204).end());
  return { app, auth };
}

describe('Console password rotation guard', () => {
  it.each([
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-out'],
    ['POST', '/api/auth/two-factor/verify-totp'],
    ['POST', '/api/auth/two-factor/verify-otp'],
    ['POST', '/api/auth/two-factor/verify-backup-code'],
  ])('allows %s %s while rotation is pending', async (method, path) => {
    const { app } = appFor(true);
    expect((await request(app)[method.toLowerCase() as 'get' | 'post'](path)).status).toBe(204);
  });

  it('requires both an allowlisted path and its expected method', async () => {
    const { app } = appFor(true);
    expect((await request(app).post('/api/auth/get-session')).status).toBe(403);
  });

  it('blocks other authenticated Better Auth actions', async () => {
    const { app } = appFor(true);
    const response = await request(app).post('/api/auth/two-factor/enable');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      message: 'Password change required',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  });

  it('leaves Better Auth behavior unchanged without a pending rotation', async () => {
    const { app } = appFor(false);
    expect((await request(app).post('/api/auth/two-factor/enable')).status).toBe(204);
  });
});
