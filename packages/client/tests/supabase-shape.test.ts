import { describe, expect, it, vi } from 'vitest';
import { normalizeSession, normalizeUser } from '../src/utils/compat.js';
import { SessionStore, memoryStorage, keyValueStorage, isKeyValueStorage } from '../src/auth/session.js';
import { PostgrestQueryBuilder } from '../src/postgrest/index.js';
import type { HttpClient } from '../src/http/index.js';

/**
 * These pin the supabase-js shapes a migrating app reads. Every assertion here
 * corresponds to a field that, when missing, fails silently at runtime: a blank
 * profile name, a spinner that never stops, a query whose error is swallowed.
 */

describe('normalizeUser', () => {
  const better = {
    id: 'u1',
    email: 'a@b.c',
    name: 'Ada',
    image: 'https://example.test/a.png',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  it('exposes profile fields under user_metadata without removing them', () => {
    const user = normalizeUser(better)!;
    expect(user.user_metadata).toMatchObject({ name: 'Ada', image: 'https://example.test/a.png' });
    expect(user.name).toBe('Ada');
  });

  it('maps the timestamps and the audience', () => {
    const user = normalizeUser(better)!;
    expect(user.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(user.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(user.aud).toBe('authenticated');
    expect(user.role).toBe('authenticated');
  });

  it('reports email confirmation as a timestamp, and null when unverified', () => {
    expect(normalizeUser(better)!.email_confirmed_at).toBe('2026-02-01T00:00:00.000Z');
    expect(normalizeUser({ ...better, emailVerified: false })!.email_confirmed_at).toBeNull();
  });

  it('leaves app_metadata empty rather than guessing a provider', () => {
    expect(normalizeUser(better)!.app_metadata).toEqual({});
  });

  it('is idempotent: normalising twice does not nest user_metadata', () => {
    const once = normalizeUser(better)!;
    const twice = normalizeUser(once)!;
    expect(twice.user_metadata).toEqual(once.user_metadata);
    expect(twice.user_metadata!.user_metadata).toBeUndefined();
  });

  it('returns null for no user', () => {
    expect(normalizeUser(null)).toBeNull();
  });
});

describe('normalizeSession', () => {
  it('aliases the token in snake_case', () => {
    const session = normalizeSession({ accessToken: 'tok', user: { id: 'u1', email: 'a@b.c' } })!;
    expect(session.access_token).toBe('tok');
    expect(session.accessToken).toBe('tok');
    expect(session.token_type).toBe('bearer');
    expect(session.refresh_token).toBeNull();
  });

  it('omits expires_at when the backend did not date the session', () => {
    const session = normalizeSession({ accessToken: 'tok', user: { id: 'u1', email: 'a@b.c' } })!;
    expect('expires_at' in session).toBe(false);
    expect('expires_in' in session).toBe(false);
  });

  it('derives expires_in from a dated session', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const session = normalizeSession({
      accessToken: 'tok',
      expires_at: future,
      user: { id: 'u1', email: 'a@b.c' },
    })!;
    expect(session.expires_in).toBeGreaterThan(500);
    expect(session.expires_in).toBeLessThanOrEqual(600);
  });
});

describe('SessionStore', () => {
  it('normalises on the way in and on the way out', async () => {
    const store = new SessionStore(memoryStorage());
    await store.set({ accessToken: 'tok', user: { id: 'u1', email: 'a@b.c', name: 'Ada' } }, 'signIn');
    expect(store.get()!.access_token).toBe('tok');
    expect(store.get()!.user.user_metadata).toMatchObject({ name: 'Ada' });
  });

  it('normalises a session written by an older client', async () => {
    // The raw camelCase shape, as an existing cookie or localStorage entry holds it.
    const raw = { accessToken: 'old', user: { id: 'u1', email: 'a@b.c' } };
    const store = new SessionStore({ get: () => raw, set: () => {} });
    const hydrated = await store.hydrate();
    expect(hydrated!.access_token).toBe('old');
  });
});

describe('keyValueStorage', () => {
  it('adapts a supabase-js style key/value store', async () => {
    const backing = new Map<string, string>();
    const adapter = keyValueStorage(
      {
        getItem: k => backing.get(k) ?? null,
        setItem: (k, v) => void backing.set(k, v),
        removeItem: k => void backing.delete(k),
      },
      'sb-key',
    );

    await adapter.set({ accessToken: 'tok', user: { id: 'u1', email: 'a@b.c' } });
    expect(backing.has('sb-key')).toBe(true);
    expect((await adapter.get())!.accessToken).toBe('tok');

    await adapter.set(null);
    expect(backing.has('sb-key')).toBe(false);
  });

  it('treats an unparseable entry as no session instead of throwing', async () => {
    const adapter = keyValueStorage({ getItem: () => 'not json', setItem: () => {}, removeItem: () => {} });
    await expect(adapter.get()).resolves.toBeNull();
  });

  it('tells the two adapter shapes apart', () => {
    expect(isKeyValueStorage({ getItem: () => null, setItem: () => {}, removeItem: () => {} })).toBe(true);
    expect(isKeyValueStorage(memoryStorage())).toBe(false);
  });
});

describe('postgrest supabase-js modifiers', () => {
  /** A builder whose request always fails, to exercise the error path. */
  function failing(): PostgrestQueryBuilder<{ id: number }> {
    const http = {
      requestWithHeaders: () => Promise.reject(new Error('boom')),
    } as unknown as HttpClient;
    return new PostgrestQueryBuilder(http, 'widgets');
  }

  it('resolves with an error by default', async () => {
    const result = await failing().select();
    expect(result.error?.message).toBe('boom');
  });

  it('rejects once throwOnError() is set', async () => {
    await expect(failing().select().throwOnError()).rejects.toThrow('boom');
  });

  it('sends max-affected as a strict preference', () => {
    const builder = failing().update({ id: 1 }).maxAffected(5);
    expect(builder.toHeaders()['Prefer']).toContain('handling=strict');
    expect(builder.toHeaders()['Prefer']).toContain('max-affected=5');
  });

  it('sends the rollback preference', () => {
    expect(failing().delete().rollback().toHeaders()['Prefer']).toContain('tx=rollback');
  });

  it('asks for geojson', () => {
    const builder = failing().select();
    builder.geojson();
    expect(builder.toHeaders()['Accept']).toBe('application/geo+json');
  });
});

describe('onAuthStateChange INITIAL_SESSION', () => {
  async function authOver(store: SessionStore) {
    const { createAuthClient } = await import('../src/auth/index.js');
    return createAuthClient({ observedFetch: (fetchImpl: typeof fetch) => fetchImpl } as unknown as HttpClient, store, {
      url: 'http://api.test',
      fetch: globalThis.fetch,
      headers: {},
      flowType: 'implicit',
      verifiers: { get: async () => null, set: async () => {}, clear: async () => {} },
    });
  }

  it('fires once after subscribing, before any other event', async () => {
    const store = new SessionStore(memoryStorage());
    const auth = await authOver(store);

    const seen: string[] = [];
    auth.onAuthStateChange(event => void seen.push(event));
    await vi.waitFor(() => expect(seen).toEqual(['INITIAL_SESSION']));

    await store.set({ accessToken: 't', user: { id: 'u1', email: 'a@b.c' } }, 'signIn');
    expect(seen).toEqual(['INITIAL_SESSION', 'SIGNED_IN']);
  });

  it('does not fire after unsubscribing synchronously', async () => {
    const auth = await authOver(new SessionStore(memoryStorage()));
    const seen: string[] = [];
    auth.onAuthStateChange(event => void seen.push(event)).data.subscription.unsubscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });
});
