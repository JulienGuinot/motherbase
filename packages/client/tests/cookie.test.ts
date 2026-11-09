import { describe, it, expect, vi } from 'vitest';
import { parseSession, serverCookieStorage } from '../src/cookies/index.js';
import type { CookieMethods, CookieToSet } from '../src/cookies/index.js';
import type { Session } from '../src/auth/types.js';

function fakeCookieJar(): CookieMethods & { jar: Map<string, string> } {
  const jar = new Map<string, string>();
  return {
    jar,
    getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
    setAll: (cookies: CookieToSet[]) => {
      for (const c of cookies) {
        if (c.options?.maxAge === 0) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
    },
  };
}

describe('serverCookieStorage', () => {
  it('round-trips a session through getAll/setAll', async () => {
    const cookies = fakeCookieJar();
    const storage = serverCookieStorage(cookies);
    const session: Session = { accessToken: 'tok123', user: { id: 'u1', email: 'a@test.dev' } };

    await storage.set(session);
    expect(cookies.jar.size).toBe(1);

    const read = await storage.get();
    expect(read).toEqual(session);
  });

  it('clears the cookie when set(null) is called', async () => {
    const cookies = fakeCookieJar();
    const storage = serverCookieStorage(cookies);
    const session: Session = { accessToken: 'tok123', user: { id: 'u1', email: 'a@test.dev' } };

    await storage.set(session);
    await storage.set(null);

    expect(cookies.jar.size).toBe(0);
    expect(await storage.get()).toBeNull();
  });

  it('writes a value the browser can still parse after the platform encodes it', async () => {
    // Next's cookies().set() percent-encodes the value on the way out and
    // decodes it on the way back in; document.cookie does neither. Writing an
    // already-encoded value here produced a double-encoded cookie that the
    // browser adapter parsed as null, dropping the bearer token on reload.
    const cookies = fakeCookieJar();
    const storage = serverCookieStorage(cookies);
    const session: Session = { accessToken: 'tok123', user: { id: 'u1', email: 'a@test.dev' } };

    await storage.set(session);
    const onTheWire = encodeURIComponent(cookies.jar.get('motherbase.session')!);
    expect(parseSession(onTheWire)).toEqual(session);
    expect(parseSession(decodeURIComponent(onTheWire))).toEqual(session);
  });

  // Off by default because createBrowserClient reads this same cookie from
  // document.cookie: an httpOnly default would sign the browser half out.
  it('leaves the cookie readable by scripts unless httpOnly is asked for', async () => {
    const cookies = fakeCookieJar();
    const written: CookieToSet[] = [];
    const spy: CookieMethods = {
      getAll: cookies.getAll,
      setAll: (c) => { written.push(...c); cookies.setAll(c); },
    };
    const session: Session = { accessToken: 'tok', user: { id: 'u1', email: 'a@test.dev' } };

    await serverCookieStorage(spy).set(session);
    expect(written.at(-1)?.options?.httpOnly).toBe(false);

    written.length = 0;
    await serverCookieStorage(spy, undefined, { httpOnly: true }).set(session);
    expect(written.at(-1)?.options?.httpOnly).toBe(true);
  });

  it('reads an existing cookie set via a custom key', async () => {
    const cookies = fakeCookieJar();
    const storage = serverCookieStorage(cookies, 'custom.key');
    const session: Session = { accessToken: 'tok456', user: { id: 'u2', email: 'b@test.dev' } };

    await storage.set(session);
    expect(cookies.jar.has('custom.key')).toBe(true);
    expect(await storage.get()).toEqual(session);
  });
});

// The failure this covers is the expensive one: a Server Component cannot set
// cookies, the documented adapter swallows the refusal in its own try/catch,
// and the result is `getSession()` returning null everywhere with nothing logged.
describe('serverCookieStorage write warnings', () => {
  // The warning fires once per module instance, so each case imports a fresh
  // one rather than depending on the order the others ran in.
  async function freshStorage(cookies: CookieMethods) {
    vi.resetModules();
    const { serverCookieStorage: fresh } = await import('../src/cookies/index.js');
    return fresh(cookies);
  }

  function readOnlyJar(swallow: boolean): CookieMethods {
    return {
      getAll: () => [],
      setAll: () => {
        if (!swallow) throw new Error('Cookies can only be modified in a Server Action or Route Handler');
      },
    };
  }

  const aSession: Session = { accessToken: 't', user: { id: 'u', email: 'a@b.c' } };

  it('warns when setAll throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (await freshStorage(readOnlyJar(false))).set(aSession);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('updateSession');
    warn.mockRestore();
  });

  it('warns when setAll silently does nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (await freshStorage(readOnlyJar(true))).set(aSession);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/proxy\.ts|middleware\.ts/);
    warn.mockRestore();
  });

  it('stays quiet when the write lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (await freshStorage(fakeCookieJar())).set(aSession);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
