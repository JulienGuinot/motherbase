import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index.js';
import { memoryStorage } from '../src/auth/session.js';
import type { AuthChangeEvent } from '../src/auth/types.js';

/**
 * `client.auth` is Better Auth's client; what Motherbase owns is the session
 * sync around it (src/auth.ts). These pin that sync: which responses store a
 * session, which end it, and that the stored token goes out on every call.
 */

type Route = (body: any) => unknown;

function clientWith(routes: Record<string, Route>, options: { key?: string; flowType?: 'pkce' } = {}) {
  const calls: Array<{ path: string; method: string; headers: Headers; body: any; credentials?: RequestCredentials }> = [];
  const fetchSpy = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method ?? 'GET', headers: new Headers(init.headers), body, credentials: init.credentials });
    const route = routes[url.pathname];
    if (!route) return Response.json({ message: `no route ${url.pathname}` }, { status: 404 });
    return Response.json(route(body));
  });
  const client = createClient('http://api.localhost', options.key, {
    storage: memoryStorage(),
    fetch: fetchSpy as unknown as typeof fetch,
    ...(options.flowType ? { auth: { flowType: options.flowType } } : {}),
  });
  const events: AuthChangeEvent[] = [];
  client.auth.onAuthStateChange(event => events.push(event));
  return { client, calls, events };
}

const ada = { id: 'u1', email: 'ada@example.com', name: 'Ada' };
const signedIn = { '/api/auth/sign-in/email': () => ({ token: 'tok-1', user: ada, redirect: false }) };

async function signIn(client: ReturnType<typeof clientWith>['client']) {
  await client.auth.signIn.email({ email: ada.email, password: 'pw' });
}

describe('session sync', () => {
  it('stores the session a sign-in returns and sends it on the next call', async () => {
    const { client, calls, events } = clientWith({ ...signedIn, '/api/auth/list-sessions': () => [] });
    await signIn(client);

    const { data } = await client.auth.listSessions();
    expect(data).toEqual([]);
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer tok-1');
    expect(events).toContain('SIGNED_IN');
  });

  it('stores nothing while a second factor is pending, then the verified session', async () => {
    const { client, events } = clientWith({
      '/api/auth/sign-in/email': () => ({ twoFactorRedirect: true, twoFactorMethods: ['totp'] }),
      '/api/auth/two-factor/verify-totp': () => ({ token: 'tok-2fa', user: ada }),
    });
    await signIn(client);
    expect(events).not.toContain('SIGNED_IN');

    await client.auth.twoFactor.verifyTotp({ code: '123456' });
    expect(events).toContain('MFA_CHALLENGE_VERIFIED');
    let token: string | undefined;
    client.auth.onAuthStateChange((_event, session) => { token = session?.accessToken; });
    await vi.waitFor(() => expect(token).toBe('tok-2fa'));
  });

  it('stores nothing for a sign-up that waits on email verification', async () => {
    const { client, events } = clientWith({ '/api/auth/sign-up/email': () => ({ token: null, user: ada }) });
    const { data } = await client.auth.signUp.email({ email: ada.email, password: 'pw', name: 'Ada' });
    expect(data?.user.id).toBe('u1');
    await vi.waitFor(() => expect(events).toEqual(['INITIAL_SESSION']));
  });

  it('does not take a JWT from /token for the session', async () => {
    const { client, events } = clientWith({ ...signedIn, '/api/auth/token': () => ({ token: 'eyJ.jwt.sig' }) });
    await signIn(client);
    await client.auth.token();
    expect(events.filter(event => event === 'SIGNED_IN')).toHaveLength(1);
  });

  it('ends the session on sign-out, and on revoking the current session only', async () => {
    const { client, events } = clientWith({
      ...signedIn,
      '/api/auth/revoke-session': () => ({ status: true }),
      '/api/auth/sign-out': () => ({ success: true }),
    });
    await signIn(client);

    await client.auth.revokeSession({ token: 'another-device' });
    expect(events).not.toContain('SIGNED_OUT');
    await client.auth.revokeSession({ token: 'tok-1' });
    expect(events).toContain('SIGNED_OUT');

    await signIn(client);
    await client.auth.signOut();
    expect(events.filter(event => event === 'SIGNED_OUT')).toHaveLength(2);
  });

  it('clears a session the server no longer knows', async () => {
    const { client, events } = clientWith({ ...signedIn, '/api/auth/get-session': () => null });
    await signIn(client);
    await client.auth.getSession();
    expect(events).toContain('SIGNED_OUT');
  });

  it('treats the signed bearer and the bare token in a body as one session', async () => {
    // The server's bearer is `<token>.<signature>`; get-session answers with `<token>`.
    const { client, events } = clientWith({
      '/api/auth/sign-in/email': () => ({ token: 'tok-1.c2lnbmF0dXJl', user: ada }),
      '/api/auth/get-session': () => ({ session: { token: 'tok-1' }, user: ada }),
      '/api/auth/revoke-session': () => ({ status: true }),
    });
    await signIn(client);
    await client.auth.getSession();
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN']);
    expect((await client.hydrate())?.accessToken).toBe('tok-1.c2lnbmF0dXJl');

    await client.auth.revokeSession({ token: 'tok-1' });
    expect(events).toContain('SIGNED_OUT');
  });

  it('writes nothing when the server confirms the session unchanged', async () => {
    const { client, events } = clientWith({
      ...signedIn,
      '/api/auth/get-session': () => ({ session: { token: 'tok-1' }, user: ada }),
    });
    await signIn(client);
    await client.auth.getSession();
    await client.auth.getSession();
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN']);
  });

  it('reads the user back after updateUser, which answers without it', async () => {
    let name = 'Ada';
    const { client, events } = clientWith({
      ...signedIn,
      '/api/auth/update-user': body => { name = body.name; return { status: true }; },
      '/api/auth/get-session': () => ({ session: { token: 'tok-1' }, user: { ...ada, name } }),
    });
    await signIn(client);
    await client.auth.updateUser({ name: 'Ada L.' });
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED']);
    expect((await client.hydrate())?.user.name).toBe('Ada L.');
  });

  it('reports a user update without signing in again', async () => {
    const { client, events } = clientWith({
      ...signedIn,
      '/api/auth/get-session': () => ({ session: { token: 'tok-1' }, user: { ...ada, name: 'Ada L.' } }),
    });
    await signIn(client);
    await client.auth.getSession();
    expect(events.filter(event => event === 'SIGNED_IN')).toHaveLength(1);
    expect(events).toContain('USER_UPDATED');
  });
});

describe('requests', () => {
  it('sends the client headers, and an Origin on mutations outside a browser', async () => {
    const { client, calls } = clientWith(signedIn, { key: 'mb_publishable_x' });
    await signIn(client);
    expect(calls[0].headers.get('apikey')).toBe('mb_publishable_x');
    expect(calls[0].headers.get('origin')).toBe('http://api.localhost');
  });

  // React Native defines `window` but no `document`, sends no Origin, and
  // replays the session cookie from its native jar: Better Auth then refuses
  // the sign-out with `403 Missing or null Origin`.
  it('sends an Origin from React Native too, and does not read window.location there', async () => {
    vi.stubGlobal('window', {});
    try {
      const { client, calls } = clientWith({ ...signedIn, '/api/auth/sign-out': () => ({ success: true }) }, { flowType: 'pkce' });
      await signIn(client);
      await client.auth.signOut();
      expect(calls.map(call => call.headers.get('origin'))).toEqual(['http://api.localhost', 'http://api.localhost']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('includes cookies only where the next step depends on one', async () => {
    const { client, calls } = clientWith({
      ...signedIn,
      '/api/auth/list-sessions': () => [],
      '/api/auth/sign-in/social': () => ({ url: 'https://idp', redirect: false }),
    });
    await signIn(client);
    await client.auth.listSessions();
    await client.auth.signIn.social({ provider: 'google', disableRedirect: true });
    expect(calls.map(call => call.credentials)).toEqual(['include', 'same-origin', 'include']);
  });

  it('puts an S256 challenge on the callback URL, then exchanges the code with its verifier', async () => {
    const { client, calls } = clientWith(
      {
        '/api/auth/sign-in/social': () => ({ url: 'https://idp', redirect: false }),
        '/api/auth/exchange-code': () => ({ token: 'tok-pkce', user: ada }),
      },
      { flowType: 'pkce' },
    );
    await client.auth.signIn.social({ provider: 'github', callbackURL: 'http://app.localhost/done' });
    const callbackURL = new URL(calls[0].body.callbackURL);
    expect(callbackURL.origin + callbackURL.pathname).toBe('http://app.localhost/done');
    expect(callbackURL.searchParams.get('code_challenge_method')).toBe('s256');

    const { data, error } = await client.auth.exchangeCodeForSession('the-code');
    expect(error).toBeNull();
    expect(data?.session.accessToken).toBe('tok-pkce');
    const { auth_code, code_verifier } = calls[1].body;
    expect(auth_code).toBe('the-code');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier)));
    expect(Buffer.from(digest).toString('base64url')).toBe(callbackURL.searchParams.get('code_challenge'));

    // The verifier is spent.
    expect((await client.auth.exchangeCodeForSession('the-code')).error?.message).toMatch(/No PKCE code verifier/);
  });

  it('serves signIn.oauth2 through signIn.social, as Better Auth 1.7 does', async () => {
    const { client, calls } = clientWith({ '/api/auth/sign-in/social': () => ({ url: 'https://idp', redirect: false }) });
    await client.auth.signIn.oauth2({ providerId: 'keycloak', callbackURL: 'http://app.localhost/done', disableRedirect: true });
    expect(calls[0].path).toBe('/api/auth/sign-in/social');
    expect(calls[0].body).toEqual({ provider: 'keycloak', callbackURL: 'http://app.localhost/done', disableRedirect: true });
    // A cookie path, so the OAuth state cookie survives a cross-origin call.
    expect(calls[0].credentials).toBe('include');
  });

  it('leaves the implicit flow callback untouched', async () => {
    const { client, calls } = clientWith({ '/api/auth/sign-in/social': () => ({ url: 'https://idp', redirect: false }) });
    await client.auth.signIn.social({ provider: 'github', callbackURL: 'http://app.localhost/done' });
    expect(calls[0].body.callbackURL).toBe('http://app.localhost/done');
  });

  it('starts a social sign-in in a browser by navigating, not by fetch', async () => {
    const location = { href: 'http://app.localhost/login' };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('document', {});
    try {
      const { client, calls } = clientWith({});
      const { data } = await client.auth.signIn.social({
        provider: 'google',
        callbackURL: 'http://app.localhost/done',
        scopes: ['email', 'profile'],
      });
      const expected = 'http://api.localhost/api/auth/sign-in/social/google?callbackURL=http%3A%2F%2Fapp.localhost%2Fdone&scopes=email+profile';
      expect(location.href).toBe(expected);
      expect(data).toEqual({ url: expected, redirect: false });
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reaches the Motherbase admin API with its methods bound, mfa included', async () => {
    const envelope = (data: unknown) => ({ status: 1, message: 'OK', data });
    const { client, calls } = clientWith({
      '/api/auth/admin/users': () => envelope({ users: [], page: 1, perPage: 50, total: 0 }),
      '/api/auth/admin/users/u1/factors/f1': () => envelope({ id: 'f1' }),
    }, { key: 'mb_secret_x' });
    expect((await client.auth.admin.listUsers()).error).toBeNull();
    expect((await client.auth.admin.mfa.deleteFactor({ userId: 'u1', id: 'f1' })).data).toEqual({ id: 'f1' });
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /api/auth/admin/users',
      'DELETE /api/auth/admin/users/u1/factors/f1',
    ]);
  });
});

describe('getSessionFromUrl', () => {
  it('does nothing and reports no error when the URL carries no token', async () => {
    const { client, calls } = clientWith({});
    expect(await client.auth.getSessionFromUrl('http://app.localhost/')).toEqual({ data: null, error: null });
    expect(calls).toHaveLength(0);
  });

  it('adopts the token the OAuth callback left in the fragment', async () => {
    const { client, calls, events } = clientWith({ '/api/auth/get-session': () => ({ session: { token: 'tok-oauth' }, user: ada }) });
    const { data, error } = await client.auth.getSessionFromUrl('http://app.localhost/#access_token=tok-oauth&token_type=bearer');
    expect(error).toBeNull();
    expect(data?.session.accessToken).toBe('tok-oauth');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok-oauth');
    expect(events).toContain('SIGNED_IN');
  });

  it('keeps the stored session when a stale token in the URL is rejected', async () => {
    const { client, events } = clientWith({ ...signedIn, '/api/auth/get-session': () => null });
    await signIn(client);
    await client.auth.getSessionFromUrl('http://app.localhost/#access_token=stale');
    expect(events).not.toContain('SIGNED_OUT');
    expect((await client.hydrate())?.accessToken).toBe('tok-1');
  });

  it('stores nothing for a token the server rejects', async () => {
    const { client, events } = clientWith({ '/api/auth/get-session': () => null });
    const { data, error } = await client.auth.getSessionFromUrl('http://app.localhost/#access_token=stale');
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(events).not.toContain('SIGNED_IN');
  });
});
