import { describe, expect, it, vi } from 'vitest';
import { realtimeTopicRoom } from '@motherbase/contracts';
import { RealtimeTopicService } from '../services/realtime/realtime-topic.service';
import { denyAll, type ChannelAccess } from '../services/realtime/realtime-authorization.service';

function access(grant: Partial<Record<'broadcast' | 'presence', { read?: boolean; write?: boolean }>>): ChannelAccess {
  const base = denyAll();
  for (const [extension, rights] of Object.entries(grant)) {
    base[extension as 'broadcast' | 'presence'] = { read: Boolean(rights?.read), write: Boolean(rights?.write) };
  }
  return base;
}

function harness(opts: { access?: ChannelAccess; privateOnly?: boolean } = {}) {
  const channelAccess = vi.fn(async () => opts.access ?? denyAll());
  const emitEnvelopeToTopic = vi.fn();
  const deps = {
    SettingsService: { get: async () => ({ enablePostgresChanges: true, maxChannelsPerClient: 100, privateOnly: opts.privateOnly }) },
    RealtimeAuthorizationService: { channelAccess },
    RealtimePostgresService: { register: vi.fn(), unregisterTopic: vi.fn(), unregisterSocket: vi.fn() },
    RealtimePresenceService: { sendStateTo: vi.fn(), track: vi.fn(), untrack: vi.fn() },
    SocketService: { emitEnvelopeToTopic },
  };
  const svc = new RealtimeTopicService(deps as any);
  const socket = {
    id: 'sid',
    data: { user: { id: 'u1', role: 'USER' } } as Record<string, unknown>,
    join: vi.fn(),
    leave: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    emit: vi.fn(),
  } as any;
  return { svc, socket, deps, channelAccess, emitEnvelopeToTopic };
}

describe('private channels', () => {
  it('refuses a private join whose policies grant no read at all', async () => {
    const { svc, socket, channelAccess } = harness();
    const ack = vi.fn();
    await svc.join(socket, { topic: 'room:1', config: { private: true } }, ack);

    expect(channelAccess).toHaveBeenCalledWith({ id: 'u1', role: 'USER' }, 'room:1');
    expect(ack).toHaveBeenCalledWith({ status: 'error', error: expect.stringContaining('Unauthorized') });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('joins the private room, not the public one, when broadcast is readable', async () => {
    const { svc, socket } = harness({ access: access({ broadcast: { read: true } }) });
    const ack = vi.fn();
    await svc.join(socket, { topic: 'room:1', config: { private: true } }, ack);

    expect(socket.join).toHaveBeenCalledWith(realtimeTopicRoom('room:1', true));
    expect(ack).toHaveBeenCalledWith({ status: 'ok', bindingIds: true, postgres_changes: [] });
    expect(svc.canReceivePrivate(socket, 'room:1', 'broadcast')).toBe(true);
    expect(svc.canReceivePrivate(socket, 'room:1', 'presence')).toBe(false);
  });

  it('never checks policies for a public join', async () => {
    const { svc, socket, channelAccess } = harness();
    await svc.join(socket, { topic: 'room:1' }, vi.fn());
    expect(channelAccess).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith(realtimeTopicRoom('room:1'));
  });

  it('refuses public channels when the project is private-only', async () => {
    const { svc, socket } = harness({ privateOnly: true });
    const ack = vi.fn();
    await svc.join(socket, { topic: 'room:1' }, ack);
    expect(ack).toHaveBeenCalledWith({ status: 'error', error: 'This project only allows private channels.' });
  });

  it('drops a broadcast sent without the INSERT policy, and routes an allowed one to readers only', async () => {
    const readOnly = harness({ access: access({ broadcast: { read: true } }) });
    await readOnly.svc.join(readOnly.socket, { topic: 'room:1', config: { private: true } }, vi.fn());
    const refused = vi.fn();
    readOnly.svc.relay(readOnly.socket, { topic: 'room:1', type: 'broadcast', event: 'x', payload: {} }, refused);
    expect(refused).toHaveBeenCalledWith('error');
    expect(readOnly.emitEnvelopeToTopic).not.toHaveBeenCalled();

    const writer = harness({ access: access({ broadcast: { read: true, write: true } }) });
    await writer.svc.join(writer.socket, { topic: 'room:1', config: { private: true } }, vi.fn());
    const sent = vi.fn();
    writer.svc.relay(writer.socket, { topic: 'room:1', type: 'broadcast', event: 'x', payload: { a: 1 } }, sent);
    expect(sent).toHaveBeenCalledWith('ok');
    expect(writer.emitEnvelopeToTopic).toHaveBeenCalledWith(
      'room:1',
      { topic: 'room:1', type: 'broadcast', event: 'x', payload: { a: 1 } },
      { extension: 'broadcast', exceptSocketId: 'sid' }
    );
  });

  it('refuses presence tracking without the presence INSERT policy', async () => {
    const { svc, socket, deps } = harness({ access: access({ presence: { read: true } }) });
    await svc.join(socket, { topic: 'room:1', config: { private: true, presence: { key: 'k' } } }, vi.fn());
    const ack = vi.fn();
    svc.relay(socket, { topic: 'room:1', type: 'presence', event: 'track', payload: { state: {} } }, ack);
    expect(ack).toHaveBeenCalledWith('error');
    expect(deps.RealtimePresenceService.track).not.toHaveBeenCalled();
  });
});

describe('deliverDatabaseBroadcasts', () => {
  it('sends a private message to the private audience and a public one to the public room', () => {
    const { svc, emitEnvelopeToTopic } = harness();
    svc.deliverDatabaseBroadcasts([
      { topic: 'room:1', event: 'INSERT', payload: { a: 1 }, private: true },
      { topic: 'room:2', event: 'ping', payload: null, private: false },
      { topic: '', event: 'dropped', payload: {}, private: false },
    ]);
    expect(emitEnvelopeToTopic.mock.calls).toEqual([
      ['room:1', { topic: 'room:1', type: 'broadcast', event: 'INSERT', payload: { a: 1 } }, { extension: 'broadcast' }],
      ['room:2', { topic: 'room:2', type: 'broadcast', event: 'ping', payload: {} }],
    ]);
  });
});
