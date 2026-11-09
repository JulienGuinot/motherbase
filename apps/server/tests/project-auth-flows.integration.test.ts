import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { toNodeHandler } from 'better-auth/node';
import { createProjectAuth, type AuthInstance } from '../auth/instance';
import { makeAuthMiddleware, makeOptionalAuthMiddleware } from '../auth/session';

// Postgres-gated: exercises real signup/login/getSession + bcrypt-import login
// against the project DB. Uses unique emails and cleans up created rows.
const prisma = new PrismaClient();
let auth: AuthInstance;
let app: express.Express;
const createdEmails: string[] = [];

beforeAll(() => {
  auth = createProjectAuth({
    prisma,
    secret: 'x'.repeat(40),
    baseURL: 'http://localhost:3000',
    sendOtp: async () => {},
    sendMagicLink: async () => {},
  });
  app = express();
  app.all('/api/auth/*', toNodeHandler(auth));
  app.use(express.json());
  app.get('/me', makeAuthMiddleware(() => auth, prisma), (req, res) => {
    res.json({ id: (req as any).user.id, email: (req as any).user.email });
  });
  // The data plane's guard (REST, storage, realtime broadcast).
  app.get('/data', makeOptionalAuthMiddleware(() => auth, prisma), (req, res) => {
    res.json({ user: (req as any).user?.id ?? null });
  });
});

afterEach(async () => {
  for (const email of createdEmails.splice(0)) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) {
      await prisma.session.deleteMany({ where: { userId: u.id } });
      await prisma.account.deleteMany({ where: { userId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
  }
});
afterAll(async () => { await prisma.$disconnect(); });

function uniqueEmail(tag: string) {
  const email = `ba-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
  createdEmails.push(email);
  return email;
}

async function bearerToken(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.get('set-auth-token') ?? '';
}

describe('project auth flows', () => {
  it('signs up, then a bearer token authorizes a guarded route', async () => {
    const email = uniqueEmail('signup');
    await auth.api.signUpEmail({ body: { email, password: 'correct-horse', name: email } });
    const token = await bearerToken(email, 'correct-horse');
    expect(token).toBeTruthy();

    const ok = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.email).toBe(email);

    const noauth = await request(app).get('/me');
    expect(noauth.status).toBe(401);

    const bad = await request(app).get('/me').set('Authorization', 'Bearer not-a-real-token');
    expect(bad.status).toBe(401);
  });

  it('refuses a revoked session on the data plane instead of serving it as anonymous', async () => {
    const email = uniqueEmail('revoked');
    await auth.api.signUpEmail({ body: { email, password: 'correct-horse', name: email } });
    const token = await bearerToken(email, 'correct-horse');

    const live = await request(app).get('/data').set('Authorization', `Bearer ${token}`);
    expect(live.body.user).toBeTruthy();
    expect((await request(app).get('/data')).body).toEqual({ user: null });

    await prisma.session.deleteMany({ where: { user: { email } } });
    // Anonymous rows here were what kept a dead client "signed in": the SDK
    // only revalidates its session on a 401.
    const dead = await request(app).get('/data').set('Authorization', `Bearer ${token}`);
    expect(dead.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const email = uniqueEmail('wrongpw');
    await auth.api.signUpEmail({ body: { email, password: 'right-pass-1', name: email } });
    const res = await auth.api.signInEmail({ body: { email, password: 'nope' }, asResponse: true });
    expect(res.status).not.toBe(200);
  });

  it('creates an organization for a signed-up user (phase 2c org plugin)', async () => {
    const email = uniqueEmail('org');
    await auth.api.signUpEmail({ body: { email, password: 'correct-horse', name: email } });
    const token = await bearerToken(email, 'correct-horse');
    const headers = new Headers({ authorization: `Bearer ${token}` });

    const slug = `org-${Date.now()}`;
    const org = await (auth.api as any).createOrganization({ body: { name: 'Acme', slug }, headers });
    expect((org as any)?.slug).toBe(slug);

    const list = await (auth.api as any).listOrganizations({ headers });
    expect((list as any[]).some(o => o.slug === slug)).toBe(true);

    // Cleanup the org (user cleanup handled by afterEach).
    await prisma.member.deleteMany({ where: { organizationId: (org as any).id } });
    await prisma.organization.delete({ where: { id: (org as any).id } });
  });

  it('logs in a user imported with a legacy bcrypt password (Supabase compat)', async () => {
    const email = uniqueEmail('bcrypt');
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: email, emailVerified: true } as any, { method: 'admin' });
    await ctx.internalAdapter.linkAccount({
      userId: String(user.id),
      providerId: 'credential',
      accountId: String(user.id),
      password: bcrypt.hashSync('legacy-secret', 10),
    } as any);

    const token = await bearerToken(email, 'legacy-secret');
    expect(token).toBeTruthy();
    const ok = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
  });
});
