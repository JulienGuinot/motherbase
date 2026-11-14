import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrivateKey, sign } from 'crypto';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { toNodeHandler } from 'better-auth/node';
import { createProjectAuth, type AuthInstance } from '../auth/instance';
import { makeAuthMiddleware } from '../auth/session';
import { generateSigningKey } from '../auth/signing-keys';
import { SigningKeyService } from '../services/admin/signing-key.service';

// Postgres-gated. Drives the whole lifecycle through Better Auth itself: the
// token endpoint must sign with the key in use, a rotation must switch it, and
// a revoked key's tokens must stop authenticating.
const prisma = new PrismaClient();
const service = new SigningKeyService({ prisma } as never);
const BASE_URL = 'http://localhost:3000';
let auth: AuthInstance;
let app: express.Express;
let session = '';
let userId = '';
const email = `signing-${Date.now()}@test.local`;
let before: Array<{ id: string; status: string }> = [];
const created: string[] = [];

function kidOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).kid;
}

async function accessToken(): Promise<string> {
  const res = await request(app).get('/api/auth/token').set('Authorization', `Bearer ${session}`);
  expect(res.status).toBe(200);
  return res.body.token;
}

const me = (token: string) => request(app).get('/me').set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  auth = createProjectAuth({ prisma, secret: 'x'.repeat(40), baseURL: BASE_URL, sendOtp: async () => {}, sendMagicLink: async () => {} });
  app = express();
  app.all('/api/auth/*', toNodeHandler(auth));
  app.get('/me', makeAuthMiddleware(() => auth, prisma), (req, res) => res.json({ id: (req as any).user.id }));
  const signUp = await auth.api.signUpEmail({ body: { email, password: 'correct-horse', name: 'signing' } });
  userId = signUp.user.id;
  const signIn = await auth.api.signInEmail({ body: { email, password: 'correct-horse' }, asResponse: true });
  session = signIn.headers.get('set-auth-token') ?? '';
  // A token makes sure a key is in use before the snapshot below.
  await accessToken();
  before = await prisma.jwks.findMany({ select: { id: true, status: true } });
});

afterAll(async () => {
  // Other suites share this table: put every key back the way it was found.
  await prisma.jwks.deleteMany({ where: { id: { in: created } } });
  for (const key of before) await prisma.jwks.update({ where: { id: key.id }, data: { status: key.status } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.account.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('JWT signing keys', () => {
  it('rotates, keeps old tokens verifying, then revokes them', async () => {
    const original = await accessToken();
    expect((await me(original)).status).toBe(200);

    const standby = await service.create({ algorithm: 'RS256' });
    created.push(standby.id);
    expect(standby.status).toBe('standby');
    // Published ahead of the rotation, so verifiers can cache it.
    expect((await service.jwks()).keys.map(k => k.kid)).toContain(standby.id);
    // ...but it signs nothing yet.
    expect(kidOf(await accessToken())).not.toBe(standby.id);

    const previous = kidOf(original);
    await service.rotate(standby.id);
    const rotated = await accessToken();
    expect(kidOf(rotated)).toBe(standby.id);
    expect((await me(rotated)).status).toBe(200);
    expect((await me(original)).status).toBe(200);

    await service.revoke(previous);
    expect((await me(original)).status).toBe(401);
    expect((await me(rotated)).status).toBe(200);
    expect((await service.jwks()).keys.map(k => k.kid)).not.toContain(previous);
  });

  it('accepts a token signed offline with an imported key', async () => {
    // What `motherbase gen signing-key` + `gen bearer-jwt` do on a laptop.
    const local = generateSigningKey('ES256');
    const imported = await service.create({ privateKey: { ...local.privateJwk, kid: local.kid } });
    created.push(imported.id);
    expect(imported.id).toBe(local.kid);

    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid: local.kid, typ: 'JWT' })}.${encode({ sub: userId, iss: BASE_URL, aud: BASE_URL, iat: now, exp: now + 60 })}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: createPrivateKey({ key: local.privateJwk, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');

    expect((await me(`${input}.${signature}`)).status).toBe(200);
    expect((await me(`${input}.${signature.slice(0, -4)}AAAA`)).status).toBe(401);
  });
});

// auth/server-session.ts: a session this server reads for itself must not cost
// a signature, and the header a client relies on must still be there.
describe('set-auth-jwt', () => {
  it('is still sent to a client that asks for its session over HTTP', async () => {
    const res = await request(app).get('/api/auth/get-session').set('Authorization', `Bearer ${session}`);
    expect(res.status).toBe(200);
    expect(res.headers['set-auth-jwt']).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('is not produced when the auth middleware resolves the session', async () => {
    const keyReads = vi.spyOn(prisma.jwks, 'findMany');
    try {
      expect((await me(session)).status).toBe(200);
      expect(keyReads).not.toHaveBeenCalled();
    } finally {
      keyReads.mockRestore();
    }
  });
});
