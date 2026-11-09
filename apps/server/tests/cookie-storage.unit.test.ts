import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeFakeDocument() {
  let store: Record<string, string> = {};
  return {
    get cookie() {
      return Object.entries(store)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    },
    set cookie(val: string) {
      const [pair, ...attrs] = val.split(';').map(s => s.trim());
      const eqIdx = pair.indexOf('=');
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      const maxAge = attrs.find(a => a.toLowerCase().startsWith('max-age='));
      if (maxAge && parseInt(maxAge.split('=')[1]) <= 0) {
        delete store[key];
      } else {
        store[key] = value;
      }
    },
    _reset() { store = {}; },
  };
}

describe('cookieStorage (browser)', () => {
  const fakeDoc = makeFakeDocument();

  beforeEach(() => {
    fakeDoc._reset();
    vi.stubGlobal('document', fakeDoc);
  });

  it('returns null when cookie is absent', async () => {
    const { cookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = cookieStorage();
    expect(adapter.get()).toBeNull();
  });

  it('persists and retrieves a session', async () => {
    const { cookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = cookieStorage();
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await adapter.set(session);
    expect(adapter.get()).toEqual(session);
  });

  it('removes the cookie when set to null', async () => {
    const { cookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = cookieStorage();
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await adapter.set(session);
    await adapter.set(null);
    expect(adapter.get()).toBeNull();
  });

  it('uses a custom key when provided', async () => {
    const { cookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = cookieStorage({ key: 'my.app.session' });
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await adapter.set(session);
    expect(fakeDoc.cookie).toContain('my.app.session=');
    expect(adapter.get()).toEqual(session);
  });

  it('falls back to memory storage when document is unavailable', async () => {
    vi.stubGlobal('document', undefined);
    const { cookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = cookieStorage();
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await adapter.set(session);
    expect(adapter.get()).toEqual(session);
  });
});

describe('serverCookieStorage (server)', () => {
  function makeMockAdapter() {
    const store = new Map<string, string>();
    return {
      getAll: () => Array.from(store.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cookies: Array<{ name: string; value: string; options?: { path?: string; maxAge?: number; sameSite?: string } }>) => {
        for (const c of cookies) {
          if (c.options?.maxAge === 0) store.delete(c.name);
          else store.set(c.name, c.value);
        }
      },
      store,
    };
  }

  it('returns null when cookie is absent', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = makeMockAdapter();
    const storage = serverCookieStorage(adapter);
    expect(storage.get()).toBeNull();
  });

  it('persists and retrieves a session', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = makeMockAdapter();
    const storage = serverCookieStorage(adapter);
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await storage.set(session);
    expect(storage.get()).toEqual(session);
  });

  it('removes the cookie when set to null', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = makeMockAdapter();
    const storage = serverCookieStorage(adapter);
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await storage.set(session);
    await storage.set(null);
    expect(storage.get()).toBeNull();
    expect(adapter.store.has('motherbase.session')).toBe(false);
  });

  it('uses a custom key when provided', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const adapter = makeMockAdapter();
    const storage = serverCookieStorage(adapter, 'my.app.session');
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await storage.set(session);
    expect(adapter.store.has('my.app.session')).toBe(true);
    expect(adapter.store.has('motherbase.session')).toBe(false);
    expect(storage.get()).toEqual(session);
  });

  it('calls adapter.set with path and sameSite options', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const setAllCalls: Array<Array<{ name: string; value: string; options?: unknown }>> = [];
    const adapter = {
      getAll: () => [],
      setAll: (cookies: Array<{ name: string; value: string; options?: unknown }>) => { setAllCalls.push(cookies); },
    };
    const storage = serverCookieStorage(adapter);
    const session = { accessToken: 'at', refreshToken: 'rt', user: { id: '1' } as any };
    await storage.set(session);
    expect(setAllCalls[0][0].options).toMatchObject({ path: '/', sameSite: 'lax' });
  });

  it('calls adapter.setAll with maxAge 0 when cleared', async () => {
    const { serverCookieStorage } = await import('../../../packages/client/src/cookies/index.js');
    const setAllCalls: Array<Array<{ name: string; value: string; options?: unknown }>> = [];
    const adapter = {
      getAll: () => [],
      setAll: (cookies: Array<{ name: string; value: string; options?: unknown }>) => { setAllCalls.push(cookies); },
    };
    const storage = serverCookieStorage(adapter);
    await storage.set(null);
    expect(setAllCalls[0]).toEqual([
      { name: 'motherbase.session', value: '', options: { path: '/', maxAge: 0 } },
    ]);
  });
});
