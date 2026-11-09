import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth, type AuthInstance } from '../auth/instance';

// Postgres-gated: the Supabase anonymous flow end to end against a real
// Better Auth instance. Sign in as a guest, then upgrade the SAME row with an
// email and a password, then replace that password with a reauthentication nonce.
const prisma = new PrismaClient();
let auth: AuthInstance;
const createdIds: string[] = [];
const nonces: string[] = [];

beforeAll(() => {
  auth = createProjectAuth({
    prisma,
    secret: 'x'.repeat(40),
    baseURL: 'http://localhost:3000',
    methods: { anonymous: true },
    sendOtp: async () => {},
    sendMagicLink: async () => {},
    sendReauthenticationNonce: async ({ nonce }) => { nonces.push(nonce); },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
});

// Plugins are chosen at runtime from settings, so their endpoints are not part of
// AuthInstance's static type.
type AnonymousApi = { signInAnonymous(options: { asResponse: true }): Promise<Response> };

async function signInAsGuest(): Promise<{ id: string; headers: Headers }> {
  const res = await (auth.api as unknown as AnonymousApi).signInAnonymous({ asResponse: true });
  expect(res.status).toBe(200);
  const body = await res.json();
  createdIds.push(body.user.id);
  return { id: body.user.id, headers: new Headers({ authorization: `Bearer ${res.headers.get('set-auth-token')}` }) };
}

describe('anonymous sign-ins', () => {
  it('creates a guest flagged is_anonymous, on an address that cannot receive mail', async () => {
    const guest = await signInAsGuest();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: guest.id } });
    expect(row.isAnonymous).toBe(true);
    expect(row.email.endsWith('@anonymous.invalid')).toBe(true);

    const { token } = await (auth.api as any).getToken({ headers: guest.headers });
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.is_anonymous).toBe(true);
  });

  it('upgrades the guest in place: same id, email set, no longer anonymous', async () => {
    const guest = await signInAsGuest();
    const email = `anon-upgrade-${Date.now()}@test.local`;
    await (auth.api as any).updateUserCredentials({ body: { email }, headers: guest.headers });
    // First password on the account: no nonce needed.
    await (auth.api as any).updateUserCredentials({ body: { password: 'correct-horse-1' }, headers: guest.headers });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: guest.id } });
    expect(row).toMatchObject({ email, isAnonymous: false });
    const signIn = await auth.api.signInEmail({ body: { email, password: 'correct-horse-1' }, asResponse: true });
    expect(signIn.status).toBe(200);
  });

  it('refuses a password on a guest that has no email yet', async () => {
    const guest = await signInAsGuest();
    await expect(
      (auth.api as any).updateUserCredentials({ body: { password: 'correct-horse-1' }, headers: guest.headers }),
    ).rejects.toThrow(/email address before a password/);
  });

  it('replaces an existing password only with the reauthentication nonce', async () => {
    const guest = await signInAsGuest();
    const email = `anon-nonce-${Date.now()}@test.local`;
    await (auth.api as any).updateUserCredentials({ body: { email }, headers: guest.headers });
    await (auth.api as any).updateUserCredentials({ body: { password: 'first-password-1' }, headers: guest.headers });

    await expect(
      (auth.api as any).updateUserCredentials({ body: { password: 'second-password-2' }, headers: guest.headers }),
    ).rejects.toThrow(/Reauthentication required/);

    await (auth.api as any).reauthenticate({ headers: guest.headers });
    const nonce = nonces.at(-1)!;
    await (auth.api as any).updateUserCredentials({ body: { password: 'second-password-2', nonce }, headers: guest.headers });
    const signIn = await auth.api.signInEmail({ body: { email, password: 'second-password-2' }, asResponse: true });
    expect(signIn.status).toBe(200);

    // Single use.
    await expect(
      (auth.api as any).updateUserCredentials({ body: { password: 'third-password-3', nonce }, headers: guest.headers }),
    ).rejects.toThrow(/Reauthentication required/);
  });
});
