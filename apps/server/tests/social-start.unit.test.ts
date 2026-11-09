import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSocialStartHandler, invalidRedirectTarget, parseScopes, type SocialStartAuth } from '../auth/social-start';
import { registerProjectAuthRoutes } from '../auth/routes';

/**
 * GET /api/auth/sign-in/social/:provider exists so the browser can START the
 * OAuth flow by navigation rather than by fetch. That makes the state cookie a
 * first-party write, which is the only version Safari, Firefox and incognito
 * Chrome will store.
 */

const TRUSTED = ['https://app.example.com', 'https://app.acme.test'];
const isTrustedOrigin = (url: string) => TRUSTED.some(o => url.startsWith(o)) || url.startsWith('/');

function fakeAuth(overrides: Partial<{ url: string; cookies: string[] }> = {}): SocialStartAuth {
  const { url = 'https://accounts.google.com/o/oauth2/auth?state=abc', cookies = ['better-auth.state=abc; Path=/; HttpOnly'] } = overrides;
  return {
    api: {
      signInSocial: vi.fn(async () => ({
        headers: new Headers(cookies.map(c => ['set-cookie', c] as [string, string])),
        response: { url },
      })),
    },
    // Shaped like Better Auth's own context: `isTrustedOrigin` is a method that
    // reads `this.trustedOrigins`, so destructuring it off makes it throw. An
    // arrow-function stub hid that and the route 500'd in production.
    $context: Promise.resolve({
      trustedOrigins: TRUSTED,
      isTrustedOrigin(this: { trustedOrigins: string[] }, url: string) {
        return this.trustedOrigins.some(o => url.startsWith(o)) || url.startsWith('/');
      },
    }),
  };
}

function appWith(auth: SocialStartAuth) {
  const app = express();
  registerProjectAuthRoutes(
    app,
    () => (_req, res) => res.status(404).end(),
    (_req, _res, next) => next(),
    () => '__Secure-better-auth.session_token',
    () => auth,
  );
  return app;
}

describe('invalidRedirectTarget', () => {
  it('accepts a trusted absolute URL and a relative path', () => {
    expect(invalidRedirectTarget(['https://app.example.com/cb'], isTrustedOrigin)).toBeNull();
    expect(invalidRedirectTarget(['/welcome'], isTrustedOrigin)).toBeNull();
  });

  it('skips the parameters that were not supplied', () => {
    expect(invalidRedirectTarget([undefined, undefined], isTrustedOrigin)).toBeNull();
  });

  it('rejects an untrusted host', () => {
    expect(invalidRedirectTarget(['https://evil.test/steal'], isTrustedOrigin)).toMatch(/Untrusted/);
  });

  it('rejects a repeated query key, which express hands over as an array', () => {
    // singleQueryValue turns that into '' so it can never slip through as valid.
    expect(invalidRedirectTarget([''], isTrustedOrigin)).toMatch(/Invalid/);
  });
});

describe('parseScopes', () => {
  it('splits on whitespace and commas and drops empty entries', () => {
    expect(parseScopes('email  profile,openid')).toEqual(['email', 'profile', 'openid']);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes('')).toEqual([]);
  });

  it('rejects too many, too long, or non-printable scopes', () => {
    expect(parseScopes(Array.from({ length: 21 }, (_, i) => `s${i}`).join(' '))).toBeNull();
    expect(parseScopes('a'.repeat(201))).toBeNull();
    expect(parseScopes('ok\u0000bad')).toBeNull();
    expect(parseScopes('caf\u00e9')).toBeNull();
  });
});

describe('GET /api/auth/sign-in/social/:provider', () => {
  it('forwards scopes to Better Auth and rejects malformed ones', async () => {
    const auth = fakeAuth();
    const ok = await request(appWith(auth)).get('/api/auth/sign-in/social/google').query({ scopes: 'email  profile' });
    expect(ok.status).toBe(302);
    expect(auth.api.signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ scopes: ['email', 'profile'] }) }),
    );

    const bad = await request(appWith(fakeAuth())).get('/api/auth/sign-in/social/google').query({ scopes: 'a'.repeat(201) });
    expect(bad.status).toBe(400);
  });

  it('redirects to the provider and forwards the state cookie', async () => {
    const auth = fakeAuth();
    const res = await request(appWith(auth))
      .get('/api/auth/sign-in/social/google')
      .query({ callbackURL: 'https://app.acme.test/auth/callback' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/o/oauth2/auth?state=abc');
    // Without this the callback has nothing to compare and fails state_mismatch.
    expect(res.headers['set-cookie']).toEqual(['better-auth.state=abc; Path=/; HttpOnly']);
    expect(auth.api.signInSocial).toHaveBeenCalledWith({
      body: {
        provider: 'google',
        disableRedirect: true,
        callbackURL: 'https://app.acme.test/auth/callback',
      },
      returnHeaders: true,
    });
  });

  it('refuses an untrusted callbackURL instead of becoming an open redirect', async () => {
    // Better Auth's originCheckMiddleware returns early for GET, so this route
    // is the only thing standing between a query param and the session token.
    const auth = fakeAuth();
    const res = await request(appWith(auth))
      .get('/api/auth/sign-in/social/google')
      .query({ callbackURL: 'https://evil.test/steal' });

    expect(res.status).toBe(403);
    expect(auth.api.signInSocial).not.toHaveBeenCalled();
  });

  it('checks the error and new-user redirects too', async () => {
    const auth = fakeAuth();
    const res = await request(appWith(auth))
      .get('/api/auth/sign-in/social/google')
      .query({ errorCallbackURL: 'https://evil.test/oops' });
    expect(res.status).toBe(403);
    expect(auth.api.signInSocial).not.toHaveBeenCalled();
  });

  it('works with no callbackURL at all: Better Auth falls back to baseURL', async () => {
    const res = await request(appWith(fakeAuth())).get('/api/auth/sign-in/social/google');
    expect(res.status).toBe(302);
  });

  it('reports a provider that returns no authorization URL', async () => {
    const res = await request(appWith(fakeAuth({ url: '' }))).get('/api/auth/sign-in/social/google');
    expect(res.status).toBe(502);
  });

  it('leaves POST on the same path to Better Auth', async () => {
    const res = await request(appWith(fakeAuth())).post('/api/auth/sign-in/social/google');
    expect(res.status).toBe(404);
  });
});

describe('createSocialStartHandler', () => {
  it('surfaces a thrown provider error through express rather than hanging', async () => {
    const app = express();
    const handler = createSocialStartHandler(() => {
      throw new Error('auth unavailable');
    });
    app.get('/start/:provider', (req, res, next) => {
      handler(req, res).catch(next);
    });
    const res = await request(app).get('/start/google');
    expect(res.status).toBe(500);
  });
});
