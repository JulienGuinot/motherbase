import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/auth/session.js';
import type { AuthEvent, Session, SessionStorageAdapter } from '../src/auth/types.js';

// `hydrate()` is started but NOT awaited by `onAuthStateChange`, so a `set()`
// can land while it is still reading storage. Its continuation must not write
// the pre-`set()` snapshot back over the live session.
//
// The bug this guards: `setSession()` stored the token, the stale hydrate wiped
// it, and the request that followed went out unauthenticated. It surfaced as
// `setSession()` resolving with "Invalid session" and an event sequence of
// SIGNED_IN, INITIAL_SESSION, SIGNED_OUT.

const SESSION: Session = { accessToken: 'token-1', user: { id: 'u1', email: 'u1@test.local' } };

/** A storage adapter whose read resolves only when the test says so. */
function pausedStorage(): { adapter: SessionStorageAdapter; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    adapter: {
      get: async () => {
        await gate;
        return null;
      },
      set: async () => {},
    },
    release,
  };
}

describe('SessionStore.hydrate', () => {
  it('does not overwrite a session that was set while it was reading storage', async () => {
    const { adapter, release } = pausedStorage();
    const store = new SessionStore(adapter);
    const events: string[] = [];
    store.subscribe((event: AuthEvent) => void events.push(event));

    // Started, not awaited: exactly what onAuthStateChange does.
    const hydrating = store.hydrate();
    await store.set(SESSION, 'signIn');
    release();
    await hydrating;

    expect(store.get()?.accessToken).toBe('token-1');
    expect(events).toEqual(['signIn']);
  });

  it('still loads the persisted session when nothing raced it', async () => {
    const store = new SessionStore({
      get: async () => SESSION,
      set: async () => {},
    });

    expect((await store.hydrate())?.accessToken).toBe('token-1');
    expect(store.get()?.accessToken).toBe('token-1');
  });

  it('stays idempotent: a second hydrate does not re-read storage', async () => {
    let reads = 0;
    const store = new SessionStore({
      get: async () => {
        reads++;
        return SESSION;
      },
      set: async () => {},
    });

    await store.hydrate();
    await store.hydrate();
    expect(reads).toBe(1);
  });
});
