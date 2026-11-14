import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { PrismaClient } from '@prisma/client';
import { toNodeHandler } from 'better-auth/node';
import { createProjectAuth, type AuthInstance } from '../auth/instance';
import { makeAuthMiddleware, makeOptionalAuthMiddleware } from '../auth/session';
import { callerFor } from '../middlewares/api-key.middleware';
import { UserAdminService } from '../services/admin/user-admin.service';

// Postgres-gated. The access-token path end to end, through Better Auth itself:
// the token /api/auth/token mints must be enough to serve the data plane with
// no query, and everything that ends a session or changes its user must stop a
// token already out. The pure rules are in tests/access-tokens.unit.test.ts.
const prisma = new PrismaClient();
const admin = new UserAdminService({ prisma } as never);
const PASSWORD = 'correct-horse';
let auth: AuthInstance;
let app: express.Express;
const userIds: string[] = [];

async function signUp(tag: string): Promise<{ id: string; email: string }> {
  const email = `access-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
  const created = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: tag } });
  userIds.push(created.user.id);
  return { id: created.user.id, email };
}

/** A fresh session, as the bearer the SDK stores. */
async function signIn(email: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true });
  return res.headers.get('set-auth-token') ?? '';
}

/** What the SDK does with that session: trade it for an access token. */
async function accessToken(session: string): Promise<string> {
  const res = await request(app).get('/api/auth/token').set('Authorization', `Bearer ${session}`);
  expect(res.status).toBe(200);
  return res.body.token;
}

const data = (bearer: string) => request(app).get('/data').set('Authorization', `Bearer ${bearer}`);
const me = (bearer: string) => request(app).get('/me').set('Authorization', `Bearer ${bearer}`);

/** A token is dated in milliseconds; two steps of a test can share one. */
const nextMillisecond = () => new Promise(resolve => setTimeout(resolve, 2));

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
  // The data plane's guard, answering with the caller the REST API would run as.
  app.get('/data', makeOptionalAuthMiddleware(() => auth, prisma), (req, res) => {
    res.json({ caller: callerFor(req) ?? null, fromToken: Boolean(req.tokenUser) });
  });
  app.get('/me', makeAuthMiddleware(() => auth, prisma), (req, res) => res.json({ id: req.user!.id }));
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('access tokens', () => {
  it('serves the data plane from the token: same caller as the session, no query', async () => {
    const user = await signUp('fast');
    const session = await signIn(user.email);
    const token = await accessToken(session);

    expect(decodeJwt(token)).toMatchObject({
      sub: user.id,
      email: user.email,
      user_role: 'USER',
      user_status: 'active',
      is_anonymous: false,
      iat_ms: expect.any(Number),
    });

    const viaSession = await data(session);
    expect(viaSession.body).toMatchObject({ fromToken: false, caller: { id: user.id, role: 'USER', email: user.email } });

    // Warm the key set, then watch every table the session path reads.
    await data(token);
    const reads = [
      vi.spyOn(prisma.session, 'findFirst'),
      vi.spyOn(prisma.session, 'findMany'),
      vi.spyOn(prisma.user, 'findFirst'),
      vi.spyOn(prisma.user, 'findMany'),
      vi.spyOn(prisma.user, 'findUnique'),
      vi.spyOn(prisma.jwks, 'findMany'),
    ];
    try {
      const viaToken = await data(token);
      expect(viaToken.status).toBe(200);
      expect(viaToken.body).toEqual({ ...viaSession.body, fromToken: true });
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    } finally {
      for (const read of reads) read.mockRestore();
    }

    // A route that hands the row to a controller accepts the token too.
    expect((await me(token)).body).toEqual({ id: user.id });
  });

  it('stops honouring a token when its session is signed out', async () => {
    const user = await signUp('signout');
    const session = await signIn(user.email);
    const token = await accessToken(session);
    expect((await data(token)).status).toBe(200);

    const out = await request(app).post('/api/auth/sign-out').set('Authorization', `Bearer ${session}`)
      .set('Origin', 'http://localhost:3000');
    expect(out.status).toBe(200);

    expect((await data(token)).status).toBe(401);
    expect((await me(token)).status).toBe(401);

    // Another session of the same user is one refresh away from working again.
    await nextMillisecond();
    const again = await accessToken(await signIn(user.email));
    expect((await data(again)).status).toBe(200);
  });

  it('stops honouring a token when an operator changes the role, and the next one carries it', async () => {
    const user = await signUp('role');
    const session = await signIn(user.email);
    const token = await accessToken(session);

    await admin.setRole(user.id, 'ADMIN');
    expect((await data(token)).status).toBe(401);

    await nextMillisecond();
    const refreshed = await accessToken(session);
    expect((await data(refreshed)).body).toMatchObject({ fromToken: true, caller: { id: user.id, role: 'ADMIN' } });
  });

  it('stops honouring a token when the user is updated through Better Auth', async () => {
    const user = await signUp('update');
    const session = await signIn(user.email);
    const token = await accessToken(session);

    const updated = await request(app).post('/api/auth/update-user').set('Authorization', `Bearer ${session}`)
      .set('Origin', 'http://localhost:3000').send({ image: 'https://example.test/a.png' });
    expect(updated.status).toBe(200);
    expect((await data(token)).status).toBe(401);
  });

  it('stops honouring every token of a user whose sessions an operator revokes', async () => {
    const user = await signUp('revoke');
    const token = await accessToken(await signIn(user.email));

    await admin.revokeSessions(user.id);
    expect((await data(token)).status).toBe(401);
  });

  it('gives an inactive account a token that is re-checked against its row every time', async () => {
    const user = await signUp('inactive');
    const session = await signIn(user.email);
    // Deactivated behind the server's back (SQL by hand), session left alive.
    await prisma.user.update({ where: { id: user.id }, data: { status: 'deleted' } });

    const token = await accessToken(session);
    expect(decodeJwt(token)).toMatchObject({ user_status: 'deleted' });
    // Anonymous, exactly as the session itself is treated.
    expect((await data(token)).body).toEqual({ caller: null, fromToken: false });
    expect((await data(session)).body).toEqual({ caller: null, fromToken: false });
    expect((await me(token)).status).toBe(403);

    // Reactivated, the token works again by reading the row, until its session ends.
    await prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    expect((await data(token)).body).toMatchObject({ caller: { id: user.id }, fromToken: false });
    await admin.revokeSessions(user.id);
    expect((await data(token)).status).toBe(401);
  });

  it('dates a token from before its session was read, so one minted across a revocation is refused', async () => {
    const user = await signUp('race');
    const session = await signIn(user.email);
    // The revocation lands after the request began and before the payload is
    // built: the token says ADMIN was never taken away, and must not be believed.
    const read = vi.spyOn(prisma.session, 'findFirst').mockImplementationOnce(async function (this: unknown, ...args) {
      read.mockRestore();
      const found = await (prisma.session.findFirst as (...a: unknown[]) => Promise<unknown>).apply(prisma.session, args);
      await admin.setRole(user.id, 'ADMIN');
      await admin.setRole(user.id, 'USER');
      return found as never;
    });
    const token = await accessToken(session);
    read.mockRestore();

    expect((await data(token)).status).toBe(401);
  });

  it('is not a session: the auth endpoints still want the session token', async () => {
    const user = await signUp('notsession');
    const session = await signIn(user.email);
    const token = await accessToken(session);

    const res = await request(app).get('/api/auth/get-session').set('Authorization', `Bearer ${token}`);
    expect(res.body).toBeNull();
    expect((await request(app).get('/api/auth/get-session').set('Authorization', `Bearer ${session}`)).body.user.id).toBe(user.id);
  });
});
