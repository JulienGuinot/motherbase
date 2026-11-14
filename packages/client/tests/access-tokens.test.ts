import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient } from '../src/http/index.js';
import { isDataPlanePath, parseMinted } from '../src/http/access-token.js';
import { SessionStore, memoryStorage } from '../src/auth/session.js';
import { createClient } from '../src/index.js';
import type { Session } from '../src/auth/types.js';

/**
 * The data plane gets a JWT minted from the session, in the background, and
 * falls back to the session token whenever no fresh JWT is held. A mistake here
 * either signs users out (a refused JWT treated as a dead session) or quietly
 * puts the database round trips back, so each rule is pinned.
 */

const NOW = Date.UTC(2026, 0, 1);
const user = { id: 'u1', email: 'a@test.dev' } as Session['user'];

function jwt(lifetimeSeconds: number, iat = NOW / 1000): string {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', iat, exp: iat + lifetimeSeconds })).toString('base64url');
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.sig`;
}

/** A tick for the background mint (and its `.then` chain) to settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

interface Sent { path: string; authorization: string | undefined }

function harness(options: { accessTokens?: boolean; token?: () => Response | Promise<Response>; data?: (sent: Sent) => Response } = {}) {
  const sent: Sent[] = [];
  const mints: string[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const authorization = (init.headers as Record<string, string>)['Authorization'];
    if (path === '/api/auth/token') {
      mints.push(authorization ?? '');
      return options.token ? options.token() : Response.json({ token: jwt(900, Date.now() / 1000) });
    }
    const entry = { path, authorization };
    sent.push(entry);
    return options.data ? options.data(entry) : Response.json({ status: 1, data: [] });
  }) as typeof fetch;
  const store = new SessionStore(memoryStorage());
  const refresh = vi.fn(async () => true);
  const http = new HttpClient('http://api.test', store, {
    autoRefresh: true,
    fetch: fetchImpl,
    headers: { apikey: 'pk' },
    accessTokens: options.accessTokens ?? true,
  }, refresh);
  return {
    http, store, sent, mints, refresh,
    last: () => sent[sent.length - 1].authorization,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDataPlanePath', () => {
  it('is REST and storage, and nothing that merely shares a prefix', () => {
    for (const path of ['/rest/v1/todo?select=*', '/rest/v1/batch', '/api/files/', '/api/files/raw/b/k', '/api/storage/b/files/k', '/storage/v1/render/image/authenticated/b/k']) {
      expect(isDataPlanePath(path), path).toBe(true);
    }
    for (const path of ['/api/auth/get-session', '/api/auth/token', '/api/edge/hello', '/realtime/v1/api/broadcast', '/api/filesystem', '/rest/v10/x']) {
      expect(isDataPlanePath(path), path).toBe(false);
    }
  });
});

describe('parseMinted', () => {
  it('reads exp and iat, and refuses what it cannot use', () => {
    expect(parseMinted({ token: jwt(900) }, NOW)).toMatchObject({ expiresAt: NOW + 900_000, lifetimeMs: 900_000 });
    // A device clock an hour behind the server still gets the full lifetime.
    expect(parseMinted({ token: jwt(900, NOW / 1000 + 3600) }, NOW)?.expiresAt).toBe(NOW + 900_000);
    expect(parseMinted({ token: 'opaque' }, NOW)).toBeNull();
    expect(parseMinted({ token: 'a.!!!.c' }, NOW)).toBeNull();
    expect(parseMinted({}, NOW)).toBeNull();
    expect(parseMinted(null, NOW)).toBeNull();
    expect(parseMinted({ token: jwt(20) }, NOW)).toBeNull();
  });
});

describe('access tokens on the data plane', () => {
  it('sends the session token first, then the JWT once the background mint lands', async () => {
    const h = harness();
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');

    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBe('Bearer sess1');
    expect(h.mints).toEqual(['Bearer sess1']);

    await settle();
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toMatch(/^Bearer eyJ/);
    await h.http.request('/api/files/list/b');
    expect(h.last()).toMatch(/^Bearer eyJ/);
    expect(h.mints).toHaveLength(1);
  });

  it('keeps the session token on auth and edge function calls', async () => {
    const h = harness();
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();

    await h.http.request('/api/edge/hello', { method: 'POST', body: {} });
    expect(h.last()).toBe('Bearer sess1');
    await h.http.request('/api/auth/admin/users');
    expect(h.last()).toBe('Bearer sess1');
    await h.http.request('/rest/v1/todo', { anonymous: true });
    expect(h.last()).toBeUndefined();
  });

  it('mints once for concurrent requests', async () => {
    const h = harness();
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await Promise.all([1, 2, 3, 4].map(() => h.http.request('/rest/v1/todo')));
    expect(h.mints).toHaveLength(1);
  });

  it('re-mints ahead of expiry, and falls back to the session token in the last 30 seconds', async () => {
    const h = harness();
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();
    const first = h.mints.length;

    // 45s left: still sent, and a replacement is minted behind it.
    vi.setSystemTime(NOW + (900 - 45) * 1000);
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toMatch(/^Bearer eyJ/);
    expect(h.mints).toHaveLength(first + 1);
    await settle();

    // The replacement holds a full lifetime; let it run down to 20s left.
    vi.setSystemTime(NOW + (900 - 45) * 1000 + (900 - 20) * 1000);
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBe('Bearer sess1');
  });

  it('does not retry a failed mint immediately, and the failure surfaces nowhere', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const h = harness({ token: () => Promise.reject(new TypeError('network down')) });
      await h.store.set({ accessToken: 'sess1', user }, 'signIn');

      await expect(h.http.request('/rest/v1/todo')).resolves.toEqual([]);
      await settle();
      await h.http.request('/rest/v1/todo');
      expect(h.last()).toBe('Bearer sess1');
      expect(h.mints).toHaveLength(1);

      vi.setSystemTime(NOW + 31_000);
      await h.http.request('/rest/v1/todo');
      expect(h.mints).toHaveLength(2);
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('treats a 401 from the mint as "no JWT", without revalidating the session', async () => {
    const h = harness({ token: () => new Response('{}', { status: 401 }) });
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBe('Bearer sess1');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('discards the JWT when the session changes or ends', async () => {
    const h = harness();
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();

    await h.store.set({ accessToken: 'sess2', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBe('Bearer sess2');
    expect(h.mints).toEqual(['Bearer sess1', 'Bearer sess2']);
    await settle();

    await h.store.set(null, 'signOut');
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBeUndefined();
  });

  it('ignores a mint that lands after its session was replaced', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ token: async () => { await gate; return Response.json({ token: jwt(900) }); } });
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');

    await h.store.set({ accessToken: 'sess2', user }, 'signIn');
    release();
    await settle();

    // The late JWT was sess1's: sess2 must not be sent it.
    await h.http.request('/rest/v1/todo');
    expect(h.last()).toBe('Bearer sess2');
  });

  it('retries a refused JWT once with the session token, without revalidating', async () => {
    const h = harness({
      data: sent => sent.authorization?.startsWith('Bearer eyJ')
        ? Response.json({ message: 'expired' }, { status: 401 })
        : Response.json({ status: 1, data: ['row'] }),
    });
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();

    await expect(h.http.request('/rest/v1/todo', { method: 'POST', body: { title: 'x' } })).resolves.toEqual(['row']);
    expect(h.sent.slice(-2).map(s => s.authorization?.slice(0, 10))).toEqual(['Bearer eyJ', 'Bearer ses']);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.store.get()?.accessToken).toBe('sess1');
  });

  it('falls through to revalidation only when the session token is refused too', async () => {
    const h = harness({ data: () => Response.json({ message: 'nope' }, { status: 401 }) });
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo').catch(() => undefined);
    h.refresh.mockClear();
    await settle();

    await expect(h.http.request('/rest/v1/todo')).rejects.toMatchObject({ httpStatus: 401 });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('never mints when turned off', async () => {
    const h = harness({ accessTokens: false });
    await h.store.set({ accessToken: 'sess1', user }, 'signIn');
    await h.http.request('/rest/v1/todo');
    await settle();
    await h.http.request('/rest/v1/todo');
    expect(h.mints).toHaveLength(0);
    expect(h.last()).toBe('Bearer sess1');
  });

  it('is wired to createClient({ accessTokens: false })', async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string) => {
      paths.push(new URL(input).pathname);
      return Response.json({ status: 1, data: [] });
    }) as typeof fetch;
    const client = createClient('http://api.test', 'pk', {
      fetch: fetchImpl,
      accessTokens: false,
      storage: { get: () => ({ accessToken: 'sess1', user }), set: () => undefined },
    });
    await client.from('todo').select('*');
    await settle();
    expect(paths).not.toContain('/api/auth/token');
  });
});
