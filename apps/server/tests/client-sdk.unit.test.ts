import { describe, it, expect, vi } from 'vitest';
import { REALTIME_SOCKET_EVENTS } from '@motherbase/contracts';
import { createClient, memoryStorage } from '../../../packages/client/src/index';
import type {
  Session,
  SessionStorageAdapter,
  SocketLike,
  PostgresChangePayload,
} from '../../../packages/client/src/index';

/** Build a JSON Response with the auth/storage API envelope shape. */
function envelope(status: 0 | 1, body: Record<string, unknown>, httpStatus = 200) {
  return new Response(JSON.stringify({ status, message: 'ok', ...body }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a raw JSON Response (the /rest/v1 endpoints return bare JSON, no envelope). */
function json(body: unknown, httpStatus = 200) {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double driven by a queue of handlers. */
function fakeFetch(handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Better Auth's native /api/auth/* endpoints return plain JSON (no envelope):
// sign-in/sign-up → { token, user }.
const loginBody = { token: 'access-1', user: { id: 'u1', email: 'a@b.com' } };

describe('createClient signature', () => {
  it('accepts (url, key, options) and sends the key as an apikey header', async () => {
    const { fn, calls } = fakeFetch([() => json([{ id: 'p1' }])]);
    const client = createClient('http://api.test', 'anon-key-123', { fetch: fn });
    await client.from('products').select('*');
    expect((calls[0].init.headers as Record<string, string>)['apikey']).toBe('anon-key-123');
  });
});

// `client.auth` is Better Auth's client; packages/client/tests/auth-session-sync
// covers the session sync in detail. These pin the wire contract with the server.
describe('auth', () => {
  const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

  it('signs in at /api/auth/sign-in/email without a bearer, then sends the stored one', async () => {
    const { fn, calls } = fakeFetch([
      () => json(loginBody),
      () => json({ user: { id: 'u1', email: 'a@b.com' }, session: { token: 'access-1' } }),
    ]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    const { data, error } = await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });
    expect(error).toBeNull();
    expect(data?.user.email).toBe('a@b.com');
    expect(String(calls[0].url)).toBe('http://api.test/api/auth/sign-in/email');
    expect(header(calls[0], 'authorization')).toBeNull();

    await client.auth.getSession();
    expect(String(calls[1].url)).toBe('http://api.test/api/auth/get-session');
    expect(header(calls[1], 'authorization')).toBe('Bearer access-1');
  });

  it('returns an error (never throws) on bad credentials', async () => {
    const { fn } = fakeFetch([() => json({ message: 'bad creds' }, 401)]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    const { data, error } = await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });
    expect(data).toBeNull();
    expect(error?.message).toBe('bad creds');
    expect(await client.hydrate()).toBeNull();
  });

  it('emits INITIAL_SESSION / SIGNED_IN / SIGNED_OUT to onAuthStateChange', async () => {
    const events: string[] = [];
    const { fn } = fakeFetch([() => json(loginBody), () => json({ success: true })]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    const { data } = client.auth.onAuthStateChange(event => events.push(event));
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });
    await client.auth.signOut();
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT']);
    data.subscription.unsubscribe();
  });
});

describe('single-flight session revalidation on 401', () => {
  it('revalidates the session once across concurrent 401s', async () => {
    let sessionChecks = 0;
    const smart = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/sign-in/email')) return json(loginBody);
      if (url.endsWith('/api/auth/get-session')) {
        sessionChecks += 1;
        return json({ user: { id: 'u1', email: 'a@b.com' }, session: { token: 'access-1' } });
      }
      // Every REST call is unauthorized (token no longer accepted by the server).
      return json({ message: 'unauth', status: 0 }, 401);
    }) as unknown as typeof fetch;

    const client = createClient('http://api.test', undefined, { fetch: smart });
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });

    const [a, b] = await Promise.all([client.from('products').select('*'), client.from('products').select('*')]);
    // Both concurrent 401s share ONE revalidation (single-flight).
    expect(sessionChecks).toBe(1);
    // The retried REST calls still 401 → surfaced as errors, never thrown.
    expect(a.error).not.toBeNull();
    expect(b.error).not.toBeNull();
  });
});

describe('storage adapter', () => {
  it('hydrates from the adapter and persists on sign-in', async () => {
    const saved: Session[] = [];
    let stored: Session | null = null;
    const adapter: SessionStorageAdapter = {
      get: () => stored,
      set: s => {
        stored = s;
        if (s) saved.push(s);
      },
    };
    const { fn } = fakeFetch([() => json(loginBody)]);
    const client = createClient('http://api.test', undefined, { fetch: fn, storage: adapter });
    await client.hydrate();
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });
    expect(saved.length).toBe(1);
    expect(saved[0].accessToken).toBe('access-1');
  });

  it('memoryStorage is the default and isolates instances', async () => {
    const a = memoryStorage();
    expect(await a.get()).toBeNull();
  });
});

describe('query builder → /rest/v1 URLs', () => {
  it('builds select/eq/in/order/limit/range and returns { data, error }', async () => {
    const { fn, calls } = fakeFetch([() => json([{ id: 'p1', name: 'Tea', price: 12 }])]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    const { data, error } = await client
      .from<{ id: string; name: string; price: number }>('products')
      .select('id,name,price')
      .eq('status', 'active')
      .in('id', ['p1', 'p2'])
      .lt('price', 50)
      .order('name', { ascending: false })
      .range(0, 9);

    expect(error).toBeNull();
    expect(data?.[0].name).toBe('Tea');
    expect(calls[0].url).toBe(
      'http://api.test/rest/v1/products?select=id%2Cname%2Cprice&status=eq.active&id=in.%28p1%2Cp2%29&price=lt.50&order=name.desc&limit=10&offset=0'
    );
  });

  it('limit maps to limit param', async () => {
    const { fn, calls } = fakeFetch([() => json([])]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    await client.from('products').select('*').limit(5);
    expect(calls[0].url).toBe('http://api.test/rest/v1/products?limit=5');
  });

  it('single() returns the row object; empty result is an error not a throw', async () => {
    const { fn } = fakeFetch([() => json([{ id: 'p1', name: 'Tea' }]), () => json([])]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    const ok = await client.from('products').select('*').eq('id', 'p1').single();
    expect(ok.error).toBeNull();
    expect((ok.data as { id: string }).id).toBe('p1');

    const empty = await client.from('products').select('*').eq('id', 'nope').single();
    expect(empty.data).toBeNull();
    expect(empty.error?.code).toBe('PGRST116');
  });

  it('maybeSingle() returns null (no error) on empty', async () => {
    const { fn } = fakeFetch([() => json([])]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    const { data, error } = await client.from('products').select('*').eq('id', 'nope').maybeSingle();
    expect(data).toBeNull();
    expect(error).toBeNull();
  });

  it('an HTTP error becomes error (no throw)', async () => {
    const { fn } = fakeFetch([() => json({ message: 'blocked by policy', status: 0 }, 403)]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    const { data, error } = await client.from('products').select('*');
    expect(data).toBeNull();
    expect(error?.message).toBe('blocked by policy');
    expect(error?.status).toBe(403);
  });

  it('insert/update/delete send the right method + URL', async () => {
    const { fn, calls } = fakeFetch([
      () => json([{ id: 'p1' }], 201),
      () => json([{ id: 'p1', name: 'Coffee' }]),
      () => json([{ id: 'p1' }]),
    ]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    await client.from('products').insert({ name: 'Coffee' });
    await client.from('products').update({ name: 'Coffee' }).eq('id', 'p1');
    await client.from('products').delete().eq('id', 'p1');

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ name: 'Coffee' }));
    expect(calls[1].url).toBe('http://api.test/rest/v1/products?id=eq.p1');
    expect(calls[1].init.method).toBe('PATCH');
    expect(calls[2].url).toBe('http://api.test/rest/v1/products?id=eq.p1');
    expect(calls[2].init.method).toBe('DELETE');
  });
});

describe('storage.from(bucket)', () => {
  it('reads the real upload HTTP payload and returns the key it was given as path', async () => {
    const { fn, calls } = fakeFetch([
      () => json(loginBody),
      () =>
        envelope(1, {
          data: {
            file: { id: 'f1', key: 'avatars/f1.png', bucket: 'public' },
            url: 'http://api.test/api/storage/avatars/files/f1',
          },
        }),
    ]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });

    const blob = new Blob(['hi'], { type: 'text/plain' });
    const { data, error } = await client.storage.from('avatars').upload('a.png', blob, { visibility: 'public' });

    expect(error).toBeNull();
    // The path is the key the caller passed, which is what makes
    // download('a.png') work later. The server id is still returned.
    expect(data?.path).toBe('a.png');
    expect(data?.id).toBe('f1');
    expect(data?.fullPath).toBe('avatars/a.png');
    expect(calls[1].url).toBe('http://api.test/api/files/');
    expect(calls[1].init.method).toBe('POST');
    const body = calls[1].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBeInstanceOf(Blob);
    expect(body.get('visibility')).toBe('public');
    expect(body.get('bucket')).toBe('avatars');
    // multipart must not set a manual JSON content-type
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns the real deletion payload for every requested file', async () => {
    const { fn, calls } = fakeFetch([
      () => envelope(1, { data: { deleted: true } }),
      () => envelope(1, { data: { deleted: true } }),
    ]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    // A bare uuid is a file id (the pre-path form); anything else is a key
    // inside the bucket, and the two take different routes.
    const id = '11111111-2222-3333-4444-555555555555';
    const { data, error } = await client.storage.from('avatars').remove([id, 'nested/pic.png']);

    expect(error).toBeNull();
    expect(data).toEqual([{ deleted: true }, { deleted: true }]);
    expect(calls.map(call => call.url)).toEqual([
      `http://api.test/api/files/${id}`,
      'http://api.test/api/files/object/avatars/nested/pic.png',
    ]);
    expect(calls.every(call => call.init.method === 'DELETE')).toBe(true);
  });

  it('getPublicUrl builds a raw URL synchronously', () => {
    const { fn } = fakeFetch([() => json([])]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    const { data } = client.storage.from('avatars').getPublicUrl('f1');
    expect(data.publicUrl).toBe('http://api.test/api/storage/avatars/files/f1');
  });
});

describe('functions.invoke', () => {
  it('uses the current session bearer for a private function', async () => {
    const { fn, calls } = fakeFetch([() => json(loginBody), () => envelope(1, { data: { ok: true } })]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });

    const { data, error } = await client.functions.invoke<{ ok: boolean }>('hello', { body: { name: 'Ada' } });

    expect(error).toBeNull();
    expect(data?.ok).toBe(true);
    expect(calls[1].url).toBe('http://api.test/api/edge/hello');
    expect(calls[1].init.method).toBe('POST');
    expect((calls[1].init.headers as Record<string, string>)['Authorization']).toBe('Bearer access-1');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ name: 'Ada' });
  });

  it('returns the private endpoint 401 when no session is available', async () => {
    const { fn } = fakeFetch([() => envelope(0, { message: 'Edge invocation requires auth' }, 401)]);
    const client = createClient('http://api.test', undefined, { fetch: fn });

    const { data, error } = await client.functions.invoke('private-function');

    expect(data).toBeNull();
    expect(error).toMatchObject({ message: 'Edge invocation requires auth', status: 401 });
  });

  it('supports an explicit public invocation without a bearer', async () => {
    const { fn, calls } = fakeFetch([() => json(loginBody), () => envelope(1, { data: { ok: true } })]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });

    const { data, error } = await client.functions.invoke<{ ok: boolean }>('public-function', {
      auth: { type: 'public' },
    });

    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });
    expect((calls[1].init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('supports a dedicated Edge token without leaking the session bearer', async () => {
    const { fn, calls } = fakeFetch([() => json(loginBody), () => envelope(1, { data: { ok: true } })]);
    const client = createClient('http://api.test', undefined, { fetch: fn });
    await client.auth.signIn.email({ email: 'a@b.com', password: 'x' });

    const { error } = await client.functions.invoke('service-function', {
      auth: { type: 'edge-token', token: 'edge-secret' },
    });

    const headers = calls[1].init.headers as Record<string, string>;
    expect(error).toBeNull();
    expect(headers['x-motherbase-edge-token']).toBe('edge-secret');
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('channel().on().subscribe()', () => {
  it('routes a simulated postgres_changes event to the callback in supabase shape', async () => {
    // A fake socket.io socket we can emit into.
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const socket: SocketLike = {
      connected: true,
      on: (event, cb) => {
        const arr = listeners.get(event) ?? [];
        arr.push(cb as (p: unknown) => void);
        listeners.set(event, arr);
      },
      off: (event, cb) => {
        if (!cb) return listeners.delete(event) as unknown as void;
        const arr = listeners.get(event) ?? [];
        listeners.set(
          event,
          arr.filter(fn => fn !== cb)
        );
      },
      emit: (event, ...args) => {
        if (event === 'rt:join') {
          const ack = args[args.length - 1];
          if (typeof ack === 'function') (ack as (a: unknown) => void)({ status: 'ok', postgres_changes: [{ id: 1 }] });
        }
      },
      disconnect: () => {},
    };
    const emit = (event: string, payload: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    };

    const { fn } = fakeFetch([() => json([])]);
    const client = createClient('http://api.test', undefined, {
      fetch: fn,
      realtimeIoFactory: () => socket,
    });

    const received: PostgresChangePayload[] = [];
    let status = '';
    const channel = client
      .channel('room-products')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, payload => {
        received.push(payload);
      })
      .subscribe(s => {
        status = s;
      });

    // let subscribe()'s async connect + attach resolve
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(status).toBe('SUBSCRIBED');

    // Server delivers postgres_changes as topic envelopes routed by topic.
    emit('rt:msg', {
      topic: 'room-products',
      type: 'postgres_changes',
      event: 'INSERT',
      payload: { schema: 'public', table: 'products', eventType: 'INSERT', new: { id: 'p1', name: 'Tea' }, old: {}, commit_timestamp: 't' },
    });
    emit('rt:msg', {
      topic: 'room-products',
      type: 'postgres_changes',
      event: 'DELETE',
      payload: { schema: 'public', table: 'products', eventType: 'DELETE', new: {}, old: { id: 'p1', name: 'Tea' }, commit_timestamp: 't' },
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      table: 'products',
      schema: 'public',
      eventType: 'INSERT',
      new: { id: 'p1', name: 'Tea' },
      old: {},
    });
    expect(received[1]).toMatchObject({
      eventType: 'DELETE',
      new: {},
      old: { id: 'p1', name: 'Tea' },
    });

    await client.removeChannel(channel);
    void channel;
  });
});

describe('realtime table room refcount', () => {
  it('subscribes once for multiple watchers and leaves after the last watcher', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    const socket: SocketLike = {
      connected: true,
      on: (event, cb) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
      off: (event, cb) => {
        if (!cb) listeners.delete(event);
        else
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter(listener => listener !== cb)
          );
      },
      emit: (event, ...args) => emitted.push({ event, args }),
      disconnect: vi.fn(),
    };
    const client = createClient('http://api.test', undefined, {
      realtimeIoFactory: () => socket,
    });
    await client.realtime.connect();

    const stopFirst = client.realtime.watchTable(' Products ', vi.fn(), { polling: false });
    const stopSecond = client.realtime.watchTable('products', vi.fn(), { polling: false });

    expect(emitted.filter(item => item.event === REALTIME_SOCKET_EVENTS.subscribe)).toEqual([
      { event: REALTIME_SOCKET_EVENTS.subscribe, args: ['products'] },
    ]);
    stopFirst();
    expect(emitted.some(item => item.event === REALTIME_SOCKET_EVENTS.unsubscribe)).toBe(false);
    stopSecond();
    expect(emitted.filter(item => item.event === REALTIME_SOCKET_EVENTS.unsubscribe)).toEqual([
      { event: REALTIME_SOCKET_EVENTS.unsubscribe, args: ['products'] },
    ]);
  });

  it('rejects invalid room models before attaching listeners', async () => {
    const socket: SocketLike = {
      connected: true,
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => socket });
    await client.realtime.connect();
    expect(() => client.realtime.watchTable('bad-model!', vi.fn(), { polling: false })).toThrow(
      'Invalid realtime model'
    );
  });
});
