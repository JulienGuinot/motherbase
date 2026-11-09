import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  attachOAuthTokenToRedirect,
  isOAuthCallbackPath,
  sessionTokenFromSetCookie,
  withAccessTokenFragment,
} from '../auth/oauth-redirect';
import { registerProjectAuthRoutes } from '../auth/routes';

describe('isOAuthCallbackPath', () => {
  it('matches social and generic OAuth callbacks, which share /callback/:id', () => {
    expect(isOAuthCallbackPath('/api/auth/callback/google')).toBe(true);
    expect(isOAuthCallbackPath('/api/auth/callback/keycloak')).toBe(true);
  });

  // Each of these ends in a session cookie plus a redirect, just like OAuth.
  it('matches SSO callbacks and the magic-link landing', () => {
    expect(isOAuthCallbackPath('/api/auth/sso/callback/okta')).toBe(true);
    expect(isOAuthCallbackPath('/api/auth/sso/saml2/callback/okta')).toBe(true);
    expect(isOAuthCallbackPath('/api/auth/magic-link/verify')).toBe(true);
  });

  it('ignores every other auth endpoint', () => {
    // /sign-in/social must NOT get a token fragment: it answers with JSON.
    expect(isOAuthCallbackPath('/api/auth/sign-in/social')).toBe(false);
    expect(isOAuthCallbackPath('/api/auth/callback')).toBe(false);
    expect(isOAuthCallbackPath('/api/auth/callback/google/extra')).toBe(false);
    expect(isOAuthCallbackPath('/api/auth/get-session')).toBe(false);
  });
});

describe('withAccessTokenFragment', () => {
  it('adds the token to a plain redirect', () => {
    expect(withAccessTokenFragment('https://app.example.com/welcome', 'tok.sig')).toBe(
      'https://app.example.com/welcome#access_token=tok.sig&token_type=bearer',
    );
  });

  it('keeps the query string and an existing fragment', () => {
    const out = withAccessTokenFragment('https://app.example.com/?next=/home#tab=profile', 'tok');
    expect(out.startsWith('https://app.example.com/?next=/home#')).toBe(true);
    const params = new URLSearchParams(out.split('#')[1]);
    expect(params.get('tab')).toBe('profile');
    expect(params.get('access_token')).toBe('tok');
  });

  it('percent-encodes a token with cookie-signature characters', () => {
    const out = withAccessTokenFragment('https://app.example.com/', 'a+b/c=d');
    expect(new URLSearchParams(out.split('#')[1]).get('access_token')).toBe('a+b/c=d');
  });

  it('is idempotent and never appends a second token', () => {
    const once = withAccessTokenFragment('https://app.example.com/', 'tok');
    expect(withAccessTokenFragment(once, 'other')).toBe(once);
  });

  it('leaves the redirect alone when there is no token', () => {
    expect(withAccessTokenFragment('https://app.example.com/?error=state_mismatch', '')).toBe(
      'https://app.example.com/?error=state_mismatch',
    );
  });
});

describe('sessionTokenFromSetCookie', () => {
  const NAME = '__Secure-better-auth.session_token';

  it('picks the session cookie out of the response', () => {
    const cookies = [
      'better-auth.state=abc; Path=/; HttpOnly',
      `${NAME}=tok.sig; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`,
    ];
    expect(sessionTokenFromSetCookie(cookies, NAME)).toBe('tok.sig');
  });

  it('percent-decodes the value the way a browser would', () => {
    expect(sessionTokenFromSetCookie([`${NAME}=a%2Bb; Path=/`], NAME)).toBe('a+b');
  });

  it('ignores an expiring cookie: Max-Age=0 is a sign-out, not a session', () => {
    expect(sessionTokenFromSetCookie([`${NAME}=; Max-Age=0; Path=/`], NAME)).toBeNull();
    expect(sessionTokenFromSetCookie([`${NAME}=tok; Max-Age=0; Path=/`], NAME)).toBeNull();
  });

  it('returns null when the session cookie is absent', () => {
    expect(sessionTokenFromSetCookie(['other=1; Path=/'], NAME)).toBeNull();
  });
});

/**
 * The rewrite has to survive the real express response object, not a stub: it
 * hooks writeHead, which is where the auth handler's headers become final.
 */
describe('the auth route rewrites a provider callback redirect', () => {
  const COOKIE = '__Secure-better-auth.session_token';

  function appWith(handler: express.RequestHandler) {
    const app = express();
    registerProjectAuthRoutes(app, () => handler, (_req, _res, next) => next(), () => COOKIE);
    return app;
  }

  const signInHandler: express.RequestHandler = (_req, res) => {
    res.setHeader('set-cookie', [`${COOKIE}=tok.sig; Path=/; HttpOnly`]);
    res.redirect(302, 'https://app.example.com/welcome');
  };

  it('appends the session token to the callback redirect', async () => {
    const res = await request(appWith(signInHandler)).get('/api/auth/callback/google?code=x');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      'https://app.example.com/welcome#access_token=tok.sig&token_type=bearer',
    );
  });

  it('leaves every other auth route untouched', async () => {
    const res = await request(appWith(signInHandler)).post('/api/auth/sign-in/social');
    expect(res.headers.location).toBe('https://app.example.com/welcome');
  });

  it('hands a rejected auth handler to the error handler instead of hanging', async () => {
    const app = appWith(async () => {
      throw new Error('auth exploded');
    });
    app.use(((_err, _req, res, _next) => res.status(500).end()) as express.ErrorRequestHandler);
    const res = await request(app).get('/api/auth/get-session').timeout(2000);
    expect(res.status).toBe(500);
  });

  it('leaves a failed callback alone: no session cookie, no token', async () => {
    const app = appWith((_req, res) => res.redirect(302, 'https://app.example.com/?error=state_mismatch'));
    const res = await request(app).get('/api/auth/callback/google');
    expect(res.headers.location).toBe('https://app.example.com/?error=state_mismatch');
  });

  it('does not disturb a callback that answers with JSON instead of a redirect', async () => {
    const app = appWith((_req, res) => {
      res.setHeader('set-cookie', [`${COOKIE}=tok.sig; Path=/`]);
      res.json({ ok: true });
    });
    const res = await request(app).get('/api/auth/callback/google');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('attachOAuthTokenToRedirect', () => {
  it('still calls through when reading the headers throws', () => {
    const calls: unknown[][] = [];
    const res = {
      writeHead: (...args: unknown[]) => calls.push(args),
      getHeader: () => {
        throw new Error('boom');
      },
      setHeader: () => undefined,
    };
    attachOAuthTokenToRedirect(res as unknown as Parameters<typeof attachOAuthTokenToRedirect>[0], 'x');
    res.writeHead(302);
    expect(calls).toEqual([[302]]);
  });
});
