import { describe, it, expect } from 'vitest';
import { RealtimeModule } from '../src/realtime/index.js';
import type { SocketLike } from '../src/realtime/types.js';
import { SessionStore } from '../src/auth/session.js';
import type { Session, SessionStorageAdapter } from '../src/auth/types.js';

const session: Session = { accessToken: 'tok-1', user: { id: 'u1', email: 'u@x.io' } };

/** Persisted session, exactly like a page reload: present on disk, not in memory. */
function persisted(current: Session | null = session): SessionStorageAdapter {
  return { get: () => current, set: () => {} };
}

function stubSocket(): { socket: SocketLike; opts: Record<string, unknown>[] } {
  const opts: Record<string, unknown>[] = [];
  const socket: SocketLike = {
    on: () => {},
    off: () => {},
    emit: () => {},
    disconnect: () => {},
    connected: true,
  };
  return { socket, opts };
}

/** Run the `auth` option the way socket.io does: call it, capture the payload. */
function authPayload(opts: Record<string, unknown>): Record<string, unknown> {
  const auth = opts.auth as (cb: (data: Record<string, unknown>) => void) => void;
  let captured: Record<string, unknown> = {};
  auth(data => {
    captured = data;
  });
  return captured;
}

describe('realtime handshake auth', () => {
  it('sends the persisted token even when nothing hydrated the store first', async () => {
    const { socket, opts } = stubSocket();
    const store = new SessionStore(persisted());
    const rt = new RealtimeModule('http://localhost:5001', store, globalThis.fetch, (_url, o) => {
      opts.push(o);
      return socket;
    });

    await rt.connect();

    expect(authPayload(opts[0])).toEqual({ token: 'tok-1' });
  });

  it('re-reads the token on every reconnect instead of pinning the first value', async () => {
    const { socket, opts } = stubSocket();
    const store = new SessionStore(persisted(null));
    const rt = new RealtimeModule('http://localhost:5001', store, globalThis.fetch, (_url, o) => {
      opts.push(o);
      return socket;
    });

    await rt.connect();
    expect(authPayload(opts[0])).toEqual({});

    // Signing in after the socket is up must reach the next reconnect.
    await store.set(session, 'signIn');
    expect(authPayload(opts[0])).toEqual({ token: 'tok-1' });
  });
});

describe('realtime connect', () => {
  it('shares one socket between concurrent connect() calls', async () => {
    const { socket } = stubSocket();
    let created = 0;
    const rt = new RealtimeModule('http://localhost:5001', new SessionStore(persisted()), globalThis.fetch, () => {
      created++;
      return socket;
    });

    await Promise.all([rt.connect(), rt.connect()]);

    expect(created).toBe(1);
  });

  it('disconnects the socket when the attempt times out', async () => {
    let disconnected = 0;
    const socket: SocketLike = { ...stubSocket().socket, connected: false, disconnect: () => void disconnected++ };
    const rt = new RealtimeModule('http://localhost:5001', new SessionStore(persisted()), globalThis.fetch, () => socket);

    await expect(rt.connect({ timeoutMs: 5 })).rejects.toThrow('timeout');

    expect(disconnected).toBe(1);
    expect(rt.connected).toBe(false);
  });
});

describe('realtime re-auth on session change', () => {
  function counting(): { factory: (url: string, o: Record<string, unknown>) => SocketLike; sockets: SocketLike[]; closed: () => number } {
    const sockets: SocketLike[] = [];
    let closed = 0;
    return {
      sockets,
      closed: () => closed,
      factory: () => {
        const socket: SocketLike = { ...stubSocket().socket, disconnect: () => void closed++ };
        sockets.push(socket);
        return socket;
      },
    };
  }

  it('reopens an anonymous socket after a sign-in, so it stops running as anon', async () => {
    const io = counting();
    const store = new SessionStore(persisted(null));
    const rt = new RealtimeModule('http://localhost:5001', store, globalThis.fetch, io.factory);
    await rt.connect();

    await store.set(session, 'signIn');
    await Promise.resolve();
    await Promise.resolve();

    expect(io.closed()).toBe(1);
    expect(io.sockets).toHaveLength(2);
  });

  it('reopens after a sign-out, so the old user stops receiving rows', async () => {
    const io = counting();
    const store = new SessionStore(persisted());
    const rt = new RealtimeModule('http://localhost:5001', store, globalThis.fetch, io.factory);
    await rt.connect();

    await store.set(null, 'signOut');
    await Promise.resolve();
    await Promise.resolve();

    expect(io.sockets).toHaveLength(2);
  });

  it('leaves the socket alone when the token did not change', async () => {
    const io = counting();
    const store = new SessionStore(persisted());
    const rt = new RealtimeModule('http://localhost:5001', store, globalThis.fetch, io.factory);
    await rt.connect();

    await store.set({ ...session, user: { ...session.user, email: 'new@x.io' } }, 'userUpdated');

    expect(io.closed()).toBe(0);
    expect(io.sockets).toHaveLength(1);
  });

  it('opens nothing when no socket was open', async () => {
    const io = counting();
    const store = new SessionStore(persisted(null));
    new RealtimeModule('http://localhost:5001', store, globalThis.fetch, io.factory);

    await store.set(session, 'signIn');

    expect(io.sockets).toHaveLength(0);
  });
});
