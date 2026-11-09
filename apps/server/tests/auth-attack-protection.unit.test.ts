import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';
import { CAPTCHA_AUTH_ENDPOINTS } from '../lib/captcha-routes';

// Offline: the captcha plugin rejects before any query, so no DB is needed.
function authWith(
  captcha?: { provider: 'hcaptcha' | 'turnstile'; secretKey: string },
  endpoints: string[] = [...CAPTCHA_AUTH_ENDPOINTS],
) {
  return createProjectAuth({
    prisma: new PrismaClient(),
    secret: 'x'.repeat(40),
    baseURL: 'http://localhost:3000',
    methods: { anonymous: true },
    captcha: captcha && { ...captcha, endpoints },
    sendOtp: async () => {},
    sendMagicLink: async () => {},
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
    body: JSON.stringify(body),
  });
}

describe('CAPTCHA protection', () => {
  it.each([
    ['/sign-up/email', { email: 'a@b.c', password: 'correct-horse', name: 'a' }],
    ['/sign-in/email', { email: 'a@b.c', password: 'correct-horse' }],
    ['/sign-in/anonymous', {}],
    ['/email-otp/send-verification-otp', { email: 'a@b.c', type: 'sign-in' }],
    ['/email-otp/request-password-reset', { email: 'a@b.c' }],
  ])('refuses %s without a token when enabled', async (path, body) => {
    const res = await authWith({ provider: 'turnstile', secretKey: 's' }).handler(post(path, body));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Missing CAPTCHA response');
  });

  it('guards only the auth endpoints the project chose', async () => {
    const auth = authWith({ provider: 'turnstile', secretKey: 's' }, ['/sign-up/email']);
    const signUp = await auth.handler(post('/sign-up/email', { email: 'a@b.c', password: 'correct-horse', name: 'a' }));
    expect(signUp.status).toBe(400);
    const anonymous = await auth.handler(post('/sign-in/anonymous', {}));
    expect((await anonymous.json().catch(() => ({}))).message).not.toBe('Missing CAPTCHA response');
  });

  it('leaves code verification unguarded, as GoTrue does', async () => {
    const res = await authWith({ provider: 'hcaptcha', secretKey: 's' }).handler(
      post('/sign-in/email-otp', { email: 'a@b.c', otp: '000000' }),
    );
    expect((await res.json().catch(() => ({}))).message).not.toBe('Missing CAPTCHA response');
  });
});
