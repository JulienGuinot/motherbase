import { describe, it, expect, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { toNodeHandler } from 'better-auth/node';
import prisma from '../lib/prisma';
import container from '../container';
import { authMiddleware } from '../middlewares/auth.middleware';

// Proves the REAL live instance (resolved from AuthManager, as app.ts does) and
// the REAL exported authMiddleware work together over HTTP via Better Auth's
// native routes: i.e. the wiring app.ts performs. Postgres-gated.
const app = express();
app.all('/api/auth/*', async (req, res) => {
  const auth = await container.resolve('AuthManager').current();
  return toNodeHandler(auth)(req, res);
});
app.use(express.json());
app.get('/me', authMiddleware, (req, res) => res.json({ id: (req as any).user.id }));

const createdEmails: string[] = [];
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

describe('app auth wiring (native BA routes)', () => {
  it('signs up via /api/auth/sign-up/email and the token authorizes a guarded route', async () => {
    const email = `wire-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
    createdEmails.push(email);

    const signup = await request(app)
      .post('/api/auth/sign-up/email')
      .send({ email, password: 'correct-horse', name: email });
    expect(signup.status).toBe(200);
    const token = signup.headers['set-auth-token'];
    expect(token).toBeTruthy();

    const ok = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBeTruthy();

    const noauth = await request(app).get('/me');
    expect(noauth.status).toBe(401);
  });
});
