import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuthManager } from '../auth/auth-manager';

// Postgres-gated. Better Auth sends email OTPs and SMS codes in the background
// and answers 200 even when the send throws, so a project with no SMTP told
// the SDK "code sent" and sent nothing. The request is now refused up front.
const prisma = new PrismaClient();
const settings: Record<string, unknown> = {
  'auth.methods': { emailPassword: true, magicLink: true, emailOTP: true },
  'auth.tokens': { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
};
const sent: string[] = [];
const manager = new AuthManager({
  prisma,
  SettingsService: { get: async (key: string) => settings[key] ?? {} },
  TransporterService: { sendMail: async ({ to }: { to: string }) => void sent.push(to) },
  UserService: { getRandomUsername: async () => ({ data: { username: `p${Date.now()}` } }) },
  AuthAuditService: { recordInBackground: () => {} },
} as any);
const email = `preflight-${Date.now()}@test.local`;

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { value: { contains: email } } });
  await prisma.verification.deleteMany({ where: { identifier: { contains: email } } });
  await prisma.$disconnect();
});

async function post(path: string, body: unknown) {
  const auth = await manager.current();
  return auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify(body),
    }),
  );
}

describe('auth delivery preflight', () => {
  it('refuses a magic link and an email OTP when the project cannot send email', async () => {
    for (const [path, body] of [
      ['/sign-in/magic-link', { email }],
      ['/email-otp/send-verification-otp', { email, type: 'sign-in' }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('email_provider_not_configured');
    }
    expect(sent).toEqual([]);
  });

  it('still captures generateLink messages without SMTP', async () => {
    const auth = await manager.current();
    const { messages } = await manager.captureMessages(() =>
      (auth.api as any).signInMagicLink({ body: { email }, headers: new Headers() }),
    );
    expect(messages).toHaveLength(1);
  });

  it('sends once SMTP is configured', async () => {
    settings['email.smtp'] = { host: 'smtp.test.local', username: 'mailer' };
    try {
      expect((await post('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
      await expect.poll(() => sent).toContain(email);
    } finally {
      delete settings['email.smtp'];
    }
  });
});
