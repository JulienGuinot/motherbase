import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuthManager } from '../auth/auth-manager';

// Postgres-gated: the hourly email quota refuses the request that would send
// one email too many, and a captured (generateLink) message never counts.
const prisma = new PrismaClient();
const settings: Record<string, unknown> = {
  'auth.methods': { emailPassword: true, magicLink: true, emailOTP: true },
  'auth.tokens': { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
  'auth.rateLimits': { emailSentPerHour: 1 },
  // A project that can send: without SMTP the request is refused before the quota.
  'email.smtp': { host: 'smtp.test.local', username: 'mailer' },
};
const manager = new AuthManager({
  prisma,
  SettingsService: { get: async (key: string) => settings[key] ?? {} },
  TransporterService: { sendMail: async () => {} },
  UserService: { getRandomUsername: async () => ({ data: { username: `q${Date.now()}` } }) },
  AuthAuditService: { recordInBackground: () => {} },
} as any);
const email = `quota-${Date.now()}@test.local`;

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { value: { contains: email } } });
  await prisma.$disconnect();
});

async function requestLink() {
  const auth = await manager.current();
  return auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email }),
    }),
  );
}

describe('email send quota', () => {
  it('lets captured messages through, then refuses the second real send', async () => {
    const auth = await manager.current();
    await manager.captureMessages(() => (auth.api as any).signInMagicLink({ body: { email }, headers: new Headers() }));
    expect((await requestLink()).status).toBe(200);
    const refused = await requestLink();
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('over_email_send_rate_limit');
  });
});
