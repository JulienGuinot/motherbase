import { describe, it, expect, vi } from 'vitest';
import { realtimeTopicRoom, REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';
import { RealtimeTopicService } from '../services/realtime/realtime-topic.service';

function topicDeps() {
  return {
    RealtimePostgresService: { register: vi.fn(), unregisterTopic: vi.fn(), unregisterSocket: vi.fn() },
    RealtimePresenceService: { sendStateTo: vi.fn() },
  };
}

function fakeSocket() {
  const rooms = new Set<string>(['sid']);
  return {
    id: 'sid',
    data: {} as Record<string, unknown>,
    rooms,
    join: vi.fn((room: string) => {
      rooms.add(room);
    }),
    leave: vi.fn((room: string) => {
      rooms.delete(room);
    }),
  } as any;
}

describe('RealtimeTopicService · limits', () => {
  it('rejects a join over the per-connection channel limit', async () => {
    const deps = { ...topicDeps(), SettingsService: { get: async () => ({ enablePostgresChanges: true, maxChannelsPerClient: 2 }) } };
    const svc = new RealtimeTopicService(deps as any);
    await svc.reloadLimits();
    const socket = fakeSocket();

    await svc.join(socket, { topic: 'room:1' });
    await svc.join(socket, { topic: 'room:2' });
    const ack = vi.fn();
    await svc.join(socket, { topic: 'room:3' }, ack);

    expect(ack).toHaveBeenCalledWith({ status: 'error', error: expect.stringContaining('Channel limit') });
    expect(svc.joinedTopics(socket)).toEqual(['room:1', 'room:2']);
  });

  it('holds the channel limit under concurrent joins and acks a failed authorization lookup', async () => {
    const channelAccess = vi.fn(async () => {
      throw new Error('db down');
    });
    const deps = {
      ...topicDeps(),
      RealtimeAuthorizationService: { channelAccess },
      SettingsService: { get: async () => ({ maxChannelsPerClient: 2 }) },
    };
    const svc = new RealtimeTopicService(deps as any);
    const socket = fakeSocket();
    const acks = [vi.fn(), vi.fn(), vi.fn()];

    await Promise.all(acks.map((ack, i) => svc.join(socket, { topic: `room:${i}` }, ack)));
    expect(svc.joinedTopics(socket)).toHaveLength(2);
    expect(acks[2]).toHaveBeenCalledWith({ status: 'error', error: expect.stringContaining('Channel limit') });

    const ack = vi.fn();
    const other = fakeSocket();
    await svc.join(other, { topic: 'secret', config: { private: true } }, ack);
    expect(ack).toHaveBeenCalledWith({ status: 'error', error: 'Realtime join failed.' });
    expect(svc.joinedTopics(other)).toEqual([]);
  });

  // `join` used to fire `reloadLimits()` and decide against the permissive
  // in-memory defaults, so the very first subscription after a restart could
  // exceed maxChannelsPerClient or register postgres_changes bindings while the
  // feature was off. The first join has to wait for the real settings.
  it('enforces the configured limits on the very first join, before any reload', async () => {
    let resolveSettings: (value: unknown) => void = () => {};
    const pending = new Promise(resolve => { resolveSettings = resolve; });
    const deps = { ...topicDeps(), SettingsService: { get: () => pending } };
    const svc = new RealtimeTopicService(deps as any);
    const socket = fakeSocket();
    const ack = vi.fn();

    const joining = svc.join(socket, { topic: 'room:1', config: { postgres_changes: [{ event: '*', table: 'messages' }] } }, ack);
    expect(ack).not.toHaveBeenCalled();

    resolveSettings({ enablePostgresChanges: false, maxChannelsPerClient: 100 });
    await joining;

    expect(deps.RealtimePostgresService.register).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ status: 'ok', bindingIds: true, postgres_changes: [] });
  });

  it('skips postgres_changes registration when disabled', async () => {
    const deps = { ...topicDeps(), SettingsService: { get: async () => ({ enablePostgresChanges: false, maxChannelsPerClient: 100 }) } };
    const svc = new RealtimeTopicService(deps as any);
    await svc.reloadLimits();
    const socket = fakeSocket();
    const ack = vi.fn();

    await svc.join(socket, { topic: 'room:1', config: { postgres_changes: [{ event: '*', table: 'messages' }] } }, ack);

    expect(deps.RealtimePostgresService.register).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ status: 'ok', bindingIds: true, postgres_changes: [] });
  });
});

describe('RealtimeTopicService', () => {
  it('joins the topic room, stores config, acks ok with postgres_changes ids', async () => {
    const svc = new RealtimeTopicService(topicDeps() as any);
    const socket = fakeSocket();
    const ack = vi.fn();
    await svc.join(socket, { topic: 'room:1', config: { postgres_changes: [{ event: '*', table: 'messages' }] } }, ack);
    expect(socket.join).toHaveBeenCalledWith(realtimeTopicRoom('room:1'));
    expect(ack).toHaveBeenCalledWith({ status: 'ok', bindingIds: true, postgres_changes: [{ id: 1 }] });
    expect(svc.joinedTopics(socket)).toEqual(['room:1']);
  });

  it('rejects an invalid topic without joining', async () => {
    const svc = new RealtimeTopicService(topicDeps() as any);
    const socket = fakeSocket();
    const ack = vi.fn();
    await svc.join(socket, { topic: '' }, ack);
    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ status: 'error', error: 'Invalid realtime topic.' });
  });

  it('leave removes the room and drops config; cleanup clears all', async () => {
    const svc = new RealtimeTopicService(topicDeps() as any);
    const socket = fakeSocket();
    await svc.join(socket, { topic: 'room:1' });
    await svc.join(socket, { topic: 'room:2' });
    const ack = vi.fn();
    svc.leave(socket, { topic: 'room:1' }, ack);
    await Promise.resolve();
    expect(socket.leave).toHaveBeenCalledWith(realtimeTopicRoom('room:1'));
    expect(ack).toHaveBeenCalledWith({ status: 'ok' });
    expect(svc.joinedTopics(socket)).toEqual(['room:2']);
    svc.cleanup(socket);
    expect(svc.joinedTopics(socket)).toEqual([]);
  });
});

function relaySocket(config: unknown) {
  const roomEmits: Array<{ room: string; event: string; payload: unknown }> = [];
  const selfEmits: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    data: { rtTopics: config === undefined ? new Map() : new Map([['room:1', config]]) },
    to: vi.fn((room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push({ room, event, payload }),
    })),
    emit: vi.fn((event: string, payload: unknown) => selfEmits.push({ event, payload })),
  } as any;
  return { socket, roomEmits, selfEmits };
}

describe('RealtimeTopicService.relay (broadcast)', () => {
  const svc = new RealtimeTopicService({} as any);

  it('fans a broadcast to the topic room and not to the sender when self is off', () => {
    const { socket, roomEmits, selfEmits } = relaySocket({ broadcast: { self: false } });
    const ack = vi.fn();
    svc.relay(socket, { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } }, ack);
    expect(socket.to).toHaveBeenCalledWith(realtimeTopicRoom('room:1'));
    expect(roomEmits).toEqual([
      { room: realtimeTopicRoom('room:1'), event: REALTIME_TOPIC_EVENTS.message, payload: { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } } },
    ]);
    expect(selfEmits).toEqual([]);
    expect(ack).toHaveBeenCalledWith('ok');
  });

  it('also echoes to the sender when self is on', () => {
    const { socket, selfEmits } = relaySocket({ broadcast: { self: true } });
    svc.relay(socket, { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } });
    expect(selfEmits).toEqual([
      { event: REALTIME_TOPIC_EVENTS.message, payload: { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } } },
    ]);
  });

  it('rejects a broadcast to a topic the socket has not joined', () => {
    const { socket, roomEmits } = relaySocket(undefined);
    const ack = vi.fn();
    svc.relay(socket, { topic: 'room:1', type: 'broadcast', event: 'x', payload: {} }, ack);
    expect(roomEmits).toEqual([]);
    expect(ack).toHaveBeenCalledWith('error');
  });

  it('ignores unknown-type and invalid-topic envelopes', () => {
    const { socket, roomEmits } = relaySocket({ broadcast: { self: true } });
    svc.relay(socket, { topic: 'room:1', type: 'weird', event: 'x', payload: {} });
    svc.relay(socket, { topic: '', type: 'broadcast', event: 'x', payload: {} });
    expect(roomEmits).toEqual([]);
  });
});

describe('RealtimeTopicService.relay (presence dispatch)', () => {
  it('dispatches presence track/untrack to RealtimePresenceService with the config key', () => {
    const track = vi.fn();
    const untrack = vi.fn();
    const svc = new RealtimeTopicService({ RealtimePresenceService: { track, untrack } } as any);
    const socket = {
      id: 'sid',
      data: { rtTopics: new Map([['room:1', { presence: { key: 'k1' } }]]) },
      to: vi.fn(() => ({ emit: vi.fn() })),
      emit: vi.fn(),
    } as any;
    const ack = vi.fn();

    svc.relay(socket, { topic: 'room:1', type: 'presence', event: 'track', payload: { state: { n: 1 } } }, ack);
    expect(track).toHaveBeenCalledWith(socket, 'room:1', { n: 1 }, 'k1', false);
    expect(ack).toHaveBeenCalledWith('ok');

    svc.relay(socket, { topic: 'room:1', type: 'presence', event: 'untrack' }, ack);
    expect(untrack).toHaveBeenCalledWith(socket, 'room:1', false);
  });

  it('falls back to socket.id as the presence key when the config has none', () => {
    const track = vi.fn();
    const svc = new RealtimeTopicService({ RealtimePresenceService: { track } } as any);
    const socket = { id: 'sid', data: { rtTopics: new Map([['room:1', {}]]) } } as any;
    svc.relay(socket, { topic: 'room:1', type: 'presence', event: 'track', payload: { state: {} } });
    expect(track).toHaveBeenCalledWith(socket, 'room:1', {}, 'sid', false);
  });
});
