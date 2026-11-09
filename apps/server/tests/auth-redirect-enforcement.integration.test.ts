import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createProjectAuth } from '../auth/instance';

// Postgres-gated (the magic link is stored before it is sent). Proves the URL
// Configuration is enforced on a real request, not only stored: the link that
// goes out carries the redirect Better Auth will use after verification.
const prisma = new PrismaClient();
const sent: string[] = [];
const email = `redirects-${Date.now()}@test.local`;

const auth = createProjectAuth({
  prisma,
  secret: 'x'.repeat(40),
  baseURL: 'http://localhost:3000',
  redirects: { siteUrl: 'https://app.example.com', allowList: ['http://localhost:5173/**'] },
  sendOtp: async () => {},
  sendMagicLink: async ({ url }) => { sent.push(url); },
});

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { value: { contains: email } } });
  await prisma.$disconnect();
});

async function magicLinkRedirect(callbackURL?: string): Promise<string | null> {
  const res = await auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email, ...(callbackURL ? { callbackURL } : {}) }),
    }),
  );
  expect(res.status).toBe(200);
  return new URL(sent.at(-1)!).searchParams.get('callbackURL');
}

describe('redirect URL enforcement', () => {
  it('keeps an allowlisted redirect', async () => {
    expect(await magicLinkRedirect('http://localhost:5173/welcome')).toBe('http://localhost:5173/welcome');
  });

  it('falls back to the Site URL for a redirect that is not allowed', async () => {
    expect(await magicLinkRedirect('https://app.example.com.evil.test/')).toBe('https://app.example.com');
  });

  it('defaults to the Site URL when no redirect is given', async () => {
    expect(await magicLinkRedirect()).toBe('https://app.example.com');
  });
});
