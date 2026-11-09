import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';
import { createPkceCodec } from '../auth/pkce';

// Postgres-gated: exchangeCodeForSession against a real session.
const prisma = new PrismaClient();
const secret = 'x'.repeat(40);
const auth = createProjectAuth({
  prisma,
  secret,
  baseURL: 'http://localhost:3000',
  sendOtp: async () => {},
  sendMagicLink: async () => {},
});
const email = `pkce-${Date.now()}@test.local`;
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

describe('POST /exchange-code', () => {
  it('trades a code and its verifier for the session, once', async () => {
    const signUp = await auth.api.signUpEmail({ body: { email, password: 'correct-horse', name: email }, asResponse: true });
    const token = signUp.headers.get('set-auth-token')!;
    const code = createPkceCodec(secret).mint(token, challenge, 's256');
    const api = auth.api as any;

    await expect(api.exchangeCode({ body: { auth_code: code, code_verifier: 'b'.repeat(64) } })).rejects.toThrow(/Invalid or expired/);

    const exchanged = await api.exchangeCode({ body: { auth_code: code, code_verifier: verifier } });
    expect(exchanged.token).toBe(token);
    expect(exchanged.user.email).toBe(email);

    await expect(api.exchangeCode({ body: { auth_code: code, code_verifier: verifier } })).rejects.toThrow(/Invalid or expired/);
  });
});
