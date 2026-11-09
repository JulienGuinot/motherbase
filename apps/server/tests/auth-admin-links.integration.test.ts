import { describe, it, expect, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AuthManager } from '../auth/auth-manager';
import { AuthLinkService } from '../services/admin/auth-link.service';
import { UserAdminService } from '../services/admin/user-admin.service';

// Postgres-gated: generateLink runs the real Better Auth flows with delivery
// captured, so every link here is verified through the real endpoint.
const prisma = new PrismaClient();
const sendMail = vi.fn(async () => {});
const settings: Record<string, unknown> = {
  'auth.methods': { emailPassword: true, magicLink: true, emailOTP: true },
  'auth.tokens': { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
  'auth.twoFactor': { enabled: true, otpChannel: 'off' },
};
const di: any = {
  prisma,
  SettingsService: { get: async (key: string) => settings[key] ?? {} },
  TransporterService: { sendMail },
  UserService: { getRandomUsername: async () => ({ data: { username: `u${Date.now()}${Math.floor(Math.random() * 1e4)}` } }) },
  AuthAuditService: { recordInBackground: () => {} },
};
di.AuthManager = new AuthManager(di);
di.UserAdminService = new UserAdminService(di);
const links = new AuthLinkService(di);
const stamp = Date.now();
const emails = ['magic', 'signup', 'recovery', 'invite', 'mfa'].map(tag => `links-${tag}-${stamp}@test.local`);

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

async function visit(url: string) {
  const auth = await di.AuthManager.current();
  return auth.handler(new Request(url, { redirect: 'manual' }));
}

describe('auth.admin.generateLink', () => {
  it('magiclink: a working sign-in link, and nothing mailed', async () => {
    const { properties } = await links.generate({ type: 'magiclink', email: emails[0], options: { redirectTo: '/done' } });
    expect(sendMail).not.toHaveBeenCalled();
    expect(properties.verification_type).toBe('magiclink');
    const res = await visit(properties.action_link!);
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('session_token');
  });

  it('signup: creates the user and returns its verification link', async () => {
    const { properties, user } = await links.generate({ type: 'signup', email: emails[1], password: 'correct-horse-1' });
    expect(user).toMatchObject({ email: emails[1], emailVerified: false });
    await visit(properties.action_link!);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: emails[1] } })).emailVerified).toBe(true);
    await expect(links.generate({ type: 'signup', email: emails[1], password: 'x' })).rejects.toThrow(/already been registered/);
  });

  it('recovery: returns the reset code instead of mailing it', async () => {
    await links.generate({ type: 'signup', email: emails[2], password: 'correct-horse-1' });
    const { properties } = await links.generate({ type: 'recovery', email: emails[2] });
    expect(properties.email_otp).toMatch(/^\d{6}$/);
    expect(properties.action_link).toBeNull();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('invite: creates the user up front', async () => {
    const { user, properties } = await links.generate({ type: 'invite', email: emails[3] });
    expect(user?.email).toBe(emails[3]);
    expect(properties.action_link).toContain('/magic-link/verify');
  });

  it('refuses email_change_*', async () => {
    await expect(links.generate({ type: 'email_change_new', email: emails[3] })).rejects.toThrow(/not supported/);
  });
});

/** RFC 6238 TOTP, enough to drive the real two-factor flow. */
function totp(base32: string, period = 30, digits = 6): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / period)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

describe('MFA factors and assurance level', () => {
  it('marks a session aal2 after TOTP, lists the factor, and deletes it', async () => {
    const auth = await di.AuthManager.current();
    const api = auth.api as any;
    const signUp = await api.signUpEmail({ body: { email: emails[4], password: 'correct-horse-1', name: 'm' }, asResponse: true });
    const headers = new Headers({ authorization: `Bearer ${signUp.headers.get('set-auth-token')}` });
    const { totpURI } = await api.enableTwoFactor({ body: { password: 'correct-horse-1' }, headers });
    const secret = new URL(totpURI).searchParams.get('secret')!;
    await api.verifyTOTP({ body: { code: totp(secret) }, headers });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: emails[4] }, include: { sessions: true } });
    expect(user.sessions.some(s => s.aal === 'aal2')).toBe(true);

    const factors = await di.UserAdminService.listFactors(user.id);
    expect(factors).toEqual([expect.objectContaining({ factor_type: 'totp', status: 'verified' })]);
    await di.UserAdminService.deleteFactor(user.id, factors[0].id);
    expect(await di.UserAdminService.listFactors(user.id)).toEqual([]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(false);
  });
});
