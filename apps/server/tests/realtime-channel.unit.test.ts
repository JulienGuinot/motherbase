import { describe, it, expect } from 'vitest';
import { REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';
import { createClient } from '../../../packages/client/src/index';
import type { SocketLike } from '../../../packages/client/src/index';

interface Harness {
  socket: SocketLike;
  emitted: Array<{ event: string; args: unknown[] }>;
  deliver: (event: string, payload: unknown) => void;
}

function fakeSocket(opts: { ackJoin?: boolean } = {}): Harness {
  const ackJoin = opts.ackJoin ?? true;
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const socket: SocketLike = {
    connected: true,
    on: (event, cb) => listeners.set(event, [...(listeners.get(event) ?? []), cb]),
    off: (event, cb) => {
      if (!cb) listeners.delete(event);
      else listeners.set(event, (listeners.get(event) ?? []).filter(fn => fn !== cb));
    },
    emit: (event, ...args) => {
      emitted.push({ event, args });
      if (event === REALTIME_TOPIC_EVENTS.join && ackJoin) {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') (ack as (a: unknown) => void)({ status: 'ok', postgres_changes: [] });
      }
    },
    disconnect: () => {},
  };
  return {
    socket,
    emitted,
    deliver: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

describe('RealtimeModule topic multiplexer', () => {
  it('routes rt:msg envelopes to the channel matching the topic only', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const got: unknown[] = [];
    client
      .channel('room:1')
      .on('broadcast', { event: 'ping' }, m => got.push(m))
      .subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));

    h.deliver(REALTIME_TOPIC_EVENTS.message, { topic: 'room:1', type: 'broadcast', event: 'ping', payload: { a: 1 } });
    h.deliver(REALTIME_TOPIC_EVENTS.message, { topic: 'other', type: 'broadcast', event: 'ping', payload: { a: 2 } });

    expect(got).toEqual([{ type: 'broadcast', event: 'ping', payload: { a: 1 } }]);
  });
});

describe('RealtimeChannel supabase surface', () => {
  it('subscribe emits rt:join with config derived from bindings and reaches SUBSCRIBED', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    let status = '';
    client
      .channel('room:1', { config: { broadcast: { self: true } } })
      .on('postgres_changes', { event: 'INSERT', table: 'messages' }, () => {})
      .subscribe(s => {
        status = s;
      });
    await new Promise(resolve => setTimeout(resolve, 10));

    const join = h.emitted.find(e => e.event === REALTIME_TOPIC_EVENTS.join);
    expect(join?.args[0]).toMatchObject({
      topic: 'room:1',
      config: {
        broadcast: { self: true },
        postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'messages' }],
      },
    });
    expect(status).toBe('SUBSCRIBED');
  });

  it('reaches TIMED_OUT when the join is not acked before the timeout', async () => {
    const h = fakeSocket({ ackJoin: false });
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    let status = '';
    client
      .channel('room:t')
      .on('broadcast', { event: 'x' }, () => {})
      .subscribe(s => {
        status = s;
      }, 20);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(status).toBe('TIMED_OUT');
  });

  it('unsubscribe emits rt:leave for the topic', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client
      .channel('room:1')
      .on('broadcast', { event: 'x' }, () => {})
      .subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    await channel.unsubscribe();
    expect(
      h.emitted.some(
        e => e.event === REALTIME_TOPIC_EVENTS.leave && (e.args[0] as { topic: string }).topic === 'room:1'
      )
    ).toBe(true);
  });

  it('send() emits a broadcast rt:msg envelope on the topic (fire-and-forget)', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:1').subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    const result = await channel.send({ type: 'broadcast', event: 'cursor', payload: { x: 1 } });
    expect(result).toBe('ok');
    const msg = h.emitted.find(e => e.event === REALTIME_TOPIC_EVENTS.message);
    expect(msg?.args[0]).toEqual({ topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } });
    // fire-and-forget: no ack callback passed
    expect(typeof msg?.args[1]).not.toBe('function');
  });

  it('send() with config.broadcast.ack resolves on the server ack', async () => {
    // Socket that acks any rt:msg carrying an ack callback with 'ok'.
    const h = fakeSocket();
    const baseEmit = h.socket.emit;
    h.socket.emit = (event, ...args) => {
      baseEmit(event, ...args);
      if (event === REALTIME_TOPIC_EVENTS.message) {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') (ack as (r: unknown) => void)('ok');
      }
    };
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:1', { config: { broadcast: { ack: true } } }).subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    const result = await channel.send({ type: 'broadcast', event: 'cursor', payload: { x: 1 } });
    expect(result).toBe('ok');
  });
});

describe('RealtimeChannel presence', () => {
  it('diffs server presence state into sync/join/leave and serves presenceState()', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const events: string[] = [];
    let joined: unknown = null;
    let left: { leftPresences: unknown } | null = null;
    const channel = client
      .channel('room:1', { config: { presence: { key: 'me' } } })
      .on('presence', { event: 'sync' }, () => events.push('sync'))
      .on('presence', { event: 'join' }, p => {
        events.push('join');
        joined = p;
      })
      .on('presence', { event: 'leave' }, p => {
        events.push('leave');
        left = p as { leftPresences: unknown };
      })
      .subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));

    h.deliver(REALTIME_TOPIC_EVENTS.message, {
      topic: 'room:1',
      type: 'presence',
      event: 'state',
      payload: { me: [{ presence_ref: 'r1', name: 'jane' }] },
    });
    expect(channel.presenceState()).toEqual({ me: [{ presence_ref: 'r1', name: 'jane' }] });
    expect(joined).toEqual({
      key: 'me',
      newPresences: [{ presence_ref: 'r1', name: 'jane' }],
      currentPresences: [{ presence_ref: 'r1', name: 'jane' }],
    });

    h.deliver(REALTIME_TOPIC_EVENTS.message, {
      topic: 'room:1',
      type: 'presence',
      event: 'state',
      payload: { other: [{ presence_ref: 'r2' }] },
    });
    expect(left!.leftPresences).toEqual([{ presence_ref: 'r1', name: 'jane' }]);
    expect(events.filter(e => e === 'sync')).toHaveLength(2);
  });

});

describe('RealtimeChannel postgres_changes', () => {
  it('delivers matching postgres_changes envelopes to the binding, filtered by table/schema/event', async () => {
    const h = fakeSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const received: unknown[] = [];
    client
      .channel('room:1')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => received.push(p))
      .subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));

    const insert = {
      schema: 'public',
      table: 'messages',
      eventType: 'INSERT',
      new: { id: 1 },
      old: {},
      commit_timestamp: 't',
    };
    h.deliver(REALTIME_TOPIC_EVENTS.message, { topic: 'room:1', type: 'postgres_changes', event: 'INSERT', payload: insert });
    // different table -> ignored
    h.deliver(REALTIME_TOPIC_EVENTS.message, {
      topic: 'room:1',
      type: 'postgres_changes',
      event: 'INSERT',
      payload: { ...insert, table: 'other' },
    });
    // UPDATE while binding is INSERT -> ignored
    h.deliver(REALTIME_TOPIC_EVENTS.message, {
      topic: 'room:1',
      type: 'postgres_changes',
      event: 'UPDATE',
      payload: { ...insert, eventType: 'UPDATE' },
    });

    expect(received).toEqual([insert]);
  });
});

/** fakeSocket that also acks every rt:msg with 'ok'. */
function ackingSocket() {
  const h = fakeSocket();
  const base = h.socket.emit;
  h.socket.emit = (event, ...args) => {
    base(event, ...args);
    if (event === REALTIME_TOPIC_EVENTS.message) {
      const ack = args[args.length - 1];
      if (typeof ack === 'function') (ack as (r: unknown) => void)('ok');
    }
  };
  return h;
}

const joins = (h: Harness) => h.emitted.filter(e => e.event === REALTIME_TOPIC_EVENTS.join);
const presenceMsgs = (h: Harness) =>
  h.emitted.filter(e => e.event === REALTIME_TOPIC_EVENTS.message && (e.args[0] as { type: string }).type === 'presence');

describe('RealtimeChannel reconnect', () => {
  it('replays rt:join and re-tracks presence when the socket reconnects', async () => {
    const h = ackingSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const statuses: string[] = [];
    const channel = client
      .channel('room:1', { config: { presence: { key: 'me' } } })
      .on('postgres_changes', { event: 'INSERT', table: 'messages' }, () => {})
      .subscribe(s => statuses.push(s));
    await channel.track({ name: 'jane' });

    expect(joins(h)).toHaveLength(1);
    expect(presenceMsgs(h)).toHaveLength(1);

    h.deliver('connect', undefined);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(joins(h)).toHaveLength(2);
    expect(joins(h)[1].args[0]).toEqual(joins(h)[0].args[0]);
    expect(presenceMsgs(h)).toHaveLength(2);
    expect(presenceMsgs(h)[1].args[0]).toMatchObject({ event: 'track', payload: { state: { name: 'jane' } } });
    expect(statuses).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);
  });

  it('does not resurrect a removed channel on reconnect', async () => {
    const h = ackingSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:gone').subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    await client.removeChannel(channel);

    h.deliver('connect', undefined);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(joins(h)).toHaveLength(1);
  });
});

describe('RealtimeChannel subscribe is not awaitable', () => {
  it('queues send()/track() issued before the join ack instead of failing silently', async () => {
    const h = ackingSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:q', { config: { presence: { key: 'me' } } }).subscribe();

    // No await between subscribe() and these: the old code emitted them before
    // the topic existed server-side and the server answered 'error'.
    const [sent, tracked] = await Promise.all([
      channel.send({ type: 'broadcast', event: 'hi', payload: {} }),
      channel.track({ name: 'jane' }),
    ]);

    expect([sent, tracked]).toEqual(['ok', 'ok']);
    const order = h.emitted.filter(e => e.event === REALTIME_TOPIC_EVENTS.join || e.event === REALTIME_TOPIC_EVENTS.message);
    expect(order[0].event).toBe(REALTIME_TOPIC_EVENTS.join);
  });

  it('resolves error rather than emitting into the void when the channel is not subscribed', async () => {
    const h = ackingSocket();
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:never');
    expect(await channel.send({ type: 'broadcast', event: 'hi' })).toBe('error');
    expect(h.emitted.filter(e => e.event === REALTIME_TOPIC_EVENTS.message)).toHaveLength(0);
  });
});

describe('RealtimeChannel presence track', () => {
  it('track() emits a presence track rt:msg carrying the state payload', async () => {
    const h = fakeSocket();
    const base = h.socket.emit;
    h.socket.emit = (event, ...args) => {
      base(event, ...args);
      if (event === REALTIME_TOPIC_EVENTS.message) {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') (ack as (r: unknown) => void)('ok');
      }
    };
    const client = createClient('http://api.test', undefined, { realtimeIoFactory: () => h.socket });
    const channel = client.channel('room:1', { config: { presence: { key: 'me' } } }).subscribe();
    await new Promise(resolve => setTimeout(resolve, 10));
    const result = await channel.track({ name: 'jane' });
    expect(result).toBe('ok');
    const msg = h.emitted.find(
      e => e.event === REALTIME_TOPIC_EVENTS.message && (e.args[0] as { type: string }).type === 'presence'
    );
    expect(msg?.args[0]).toMatchObject({
      topic: 'room:1',
      type: 'presence',
      event: 'track',
      payload: { state: { name: 'jane' } },
    });
  });
});
