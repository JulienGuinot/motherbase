import { normalizeSession } from '../utils/compat.js';
import type {
  AuthEvent,
  AuthListener,
  KeyValueStorageAdapter,
  Session,
  SessionStorageAdapter,
} from './types.js';

/**
 * The key every built-in storage adapter defaults to, for both the cookie and
 * localStorage. Defined once: it is a contract between the browser half of an
 * app and the server half, and a second copy of the literal is how the two
 * drift apart. Re-exported from `cookie.ts` and from the package root.
 */
export const SESSION_COOKIE_KEY = 'motherbase.session';

/** In-memory adapter. Safe everywhere (SSR, tests); does not survive reloads. */
export function memoryStorage(): SessionStorageAdapter {
  let current: Session | null = null;
  return {
    get: () => current,
    set: (s) => {
      current = s;
    },
  };
}

/**
 * Browser localStorage adapter. Falls back to memory when localStorage is
 * unavailable (SSR, private mode), so it never throws on import or use.
 */
export function localStorageStorage(key = SESSION_COOKIE_KEY): SessionStorageAdapter {
  const ls = browserLocalStorage();
  if (!ls) return memoryStorage();
  // Reading the property, getItem and setItem can all throw (blocked site data,
  // quota, Safari private mode). The session then lives in memory instead.
  const fallback = memoryStorage();
  return {
    get: () => {
      try {
        const raw = ls.getItem(key);
        return raw ? (JSON.parse(raw) as Session) : fallback.get();
      } catch {
        return fallback.get();
      }
    },
    set: (s) => {
      fallback.set(s);
      try {
        if (s) ls.setItem(key, JSON.stringify(s));
        else ls.removeItem(key);
      } catch {
        // kept in memory only
      }
    },
  };
}

/** `globalThis.localStorage`, or undefined when absent or when merely touching it throws. */
export function browserLocalStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Wrap a supabase-js style key/value store (localStorage, React Native's
 * AsyncStorage, a cookie shim) as a session adapter.
 *
 * This is what lets `createClient(url, key, { auth: { storage: AsyncStorage } })`
 * work verbatim on a ported app. A value that will not parse is treated as no
 * session rather than thrown: a corrupt entry must not brick every launch.
 */
export function keyValueStorage(store: KeyValueStorageAdapter, key = SESSION_COOKIE_KEY): SessionStorageAdapter {
  return {
    get: async () => {
      const raw = await store.getItem(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Session;
      } catch {
        return null;
      }
    },
    set: async (s) => {
      if (s) await store.setItem(key, JSON.stringify(s));
      else await store.removeItem(key);
    },
  };
}

/** Tell the two adapter shapes apart: supabase-js's is a key/value store. */
export function isKeyValueStorage(
  value: KeyValueStorageAdapter | SessionStorageAdapter,
): value is KeyValueStorageAdapter {
  return typeof (value as KeyValueStorageAdapter).getItem === 'function';
}

/**
 * Holds the live session in memory, mirrors it to a storage adapter, and
 * notifies listeners of auth changes. The in-memory copy is the source of truth
 * for synchronous reads (e.g. attaching the bearer header).
 */
export class SessionStore {
  private current: Session | null = null;
  private readonly listeners = new Set<AuthListener>();
  private hydrated = false;
  private revision = 0;

  constructor(private readonly storage: SessionStorageAdapter) { }

  /** Load the persisted session once. Idempotent. */
  async hydrate(): Promise<Session | null> {
    if (this.hydrated) return this.current;
    // A session read back from storage was written by an older version (or by
    // the server half of an SSR app), so it is normalised on the way in too:
    // the aliases must not depend on which code path produced the session.
    const loaded = await this.storage.get();

    // Re-check AFTER the await. `hydrate()` is started but not awaited by
    // `onAuthStateChange`, so a `set()` can land while this one is still
    // reading storage, and `loaded` is then a snapshot from before that write.
    // Assigning it anyway is a lost update, and it presents as the opposite of
    // a storage bug: `setSession()` resolves with "Invalid session" because the
    // token it just stored was wiped out from under the request that used it.
    if (this.hydrated) return this.current;

    this.current = normalizeSession(loaded);
    this.hydrated = true;
    return this.current;
  }

  get(): Session | null {
    return this.current;
  }

  getRevision(): number {
    return this.revision;
  }

  async set(session: Session | null, event: AuthEvent): Promise<void> {
    const next = normalizeSession(session);
    // Only identity changes invalidate in-flight auth requests. A metadata
    // refresh must not discard a concurrent sign-in or sign-out response.
    if (next?.accessToken !== this.current?.accessToken || event === 'signOut') this.revision += 1;
    this.current = next;
    this.hydrated = true;
    await this.storage.set(this.current);
    this.emit(event);
  }

  /** Replace only the tokens, keeping the existing user (used after refresh). */
  async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    if (!this.current) return;
    await this.set({ ...this.current, accessToken, refreshToken }, 'tokenRefreshed');
  }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AuthEvent): void {
    for (const l of this.listeners) l(event, this.current);
  }
}
