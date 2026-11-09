import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServerClient } from '../src/server.js';
import { createBrowserClient } from '../src/browser.js';
import { SESSION_COOKIE_KEY } from '../src/index.js';
import type { CookieMethods, CookieToSet, Session } from '../src/index.js';

function jar(): CookieMethods & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getAll: () => Array.from(store.entries()).map(([name, value]) => ({ name, value })),
    setAll: (cookies: CookieToSet[]) => {
      for (const c of cookies) {
        if (c.options?.maxAge === 0) store.delete(c.name);
        else store.set(c.name, c.value);
      }
    },
  };
}

const session: Session = { accessToken: 'tok', user: { id: 'u1', email: 'a@test.dev' } };

afterEach(() => vi.unstubAllGlobals());

describe('cookieKey', () => {
  it('defaults to the shared SESSION_COOKIE_KEY', async () => {
    const cookies = jar();
    const client = createServerClient('http://api.test', undefined, { cookies, fetch: vi.fn() });
    await client['store'].set(session, 'signedIn');
    expect([...cookies.store.keys()]).toEqual([SESSION_COOKIE_KEY]);
  });

  // The option was typed but only honoured on the browser half, so setting it
  // moved the cookie somewhere the server never looked and every getSession()
  // came back null. Both halves have to read the same name.
  it('is honoured end to end when overridden', async () => {
    const cookies = jar();
    const client = createServerClient('http://api.test', undefined, {
      cookies,
      cookieKey: 'macle',
      fetch: vi.fn(),
    });
    await client['store'].set(session, 'signedIn');
    expect([...cookies.store.keys()]).toEqual(['macle']);

    const reader = createServerClient('http://api.test', undefined, {
      cookies,
      cookieKey: 'macle',
      fetch: vi.fn(),
    });
    expect((await reader.hydrate())?.accessToken).toBe('tok');
  });

  it('passes the key to the browser cookie adapter', async () => {
    const doc = { cookie: '' };
    vi.stubGlobal('document', doc);
    const client = createBrowserClient('http://api.test', undefined, { cookieKey: 'macle', fetch: vi.fn() });
    await client['store'].set(session, 'signedIn');
    expect(doc.cookie.startsWith('macle=')).toBe(true);
  });
});
