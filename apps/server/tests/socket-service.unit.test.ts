import { describe, expect, it, vi } from 'vitest';
import { REALTIME_SOCKET_EVENTS, REALTIME_TOPIC_EVENTS, realtimeTopicRoom } from '@motherbase/contracts';
import { realtimeModelRoom, SocketService } from '../services/socket.service';

function createHarness() {
  const sockets = new Map<string, any>();
  const rooms = new Map<string, Set<string>>();
  let connectionHandler: (socket: any) => void = () => {};
  let middleware: (socket: any, next: () => void) => void = (_socket, next) => next();

  const toEmits: Array<{ room: string; event: string; payload: unknown }> = [];
  const io: any = {
    emit: vi.fn(),
    use: vi.fn((handler: typeof middleware) => {
      middleware = handler;
    }),
    on: vi.fn((event: string, handler: typeof connectionHandler) => {
      if (event === 'connection') connectionHandler = handler;
    }),
    to: vi.fn((room: string) => ({
      emit: (event: string, payload: unknown) => toEmits.push({ room, event, payload }),
    })),
    sockets: {
      sockets,
      adapter: { rooms },
    },
  };
  const RealtimeAdminService = { setIO: vi.fn(), pushEvent: vi.fn() };
  const RealtimeTopicService = { join: vi.fn(), leave: vi.fn(), cleanup: vi.fn(), relay: vi.fn() };
  const RealtimePresenceService = { handleDisconnect: vi.fn() };
  const service = new SocketService({ RealtimeAdminService, RealtimeTopicService, RealtimePresenceService } as any);
  service.initialize(io);

  const connect = (id: string, user?: { id: string; role: string }) => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const socket: any = {
      id,
      data: user ? { user } : {},
      rooms: new Set([id]),
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
      join: vi.fn((room: string) => {
        socket.rooms.add(room);
        const members = rooms.get(room) ?? new Set<string>();
        members.add(id);
        rooms.set(room, members);
      }),
      leave: vi.fn((room: string) => {
        socket.rooms.delete(room);
        rooms.get(room)?.delete(id);
      }),
    };
    sockets.set(id, socket);
    middleware(socket, () => {});
    connectionHandler(socket);
    return { socket, receive: (event: string, ...args: any[]) => handlers.get(event)?.(...args) };
  };

  return { service, connect, RealtimeTopicService, io, rooms, toEmits };
}

describe('SocketService realtime rooms', () => {
  it('normalizes subscriptions, rejects invalid models and removes unsubscribed sockets', async () => {
    const { service, connect } = createHarness();
    const client = connect('s1', { id: 'u1', role: 'USER' });
    const ack = vi.fn();

    client.receive(REALTIME_SOCKET_EVENTS.subscribe, ' Products ', ack);
    await Promise.resolve();

    expect(client.socket.join).toHaveBeenCalledWith(realtimeModelRoom('products'));
    expect(ack).toHaveBeenCalledWith({ ok: true, model: 'products' });
    expect(service.getSubscriberGroups('PRODUCTS')).toEqual([
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['s1'] },
    ]);

    client.receive(REALTIME_SOCKET_EVENTS.subscribe, 'bad-model!', ack);
    expect(client.socket.join).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenLastCalledWith({ ok: false, error: 'Invalid realtime model.' });

    client.receive(REALTIME_SOCKET_EVENTS.unsubscribe, 'products');
    await Promise.resolve();
    expect(service.getSubscriberGroups('products')).toEqual([]);
  });

  it('groups many subscribers by stable RLS identity', async () => {
    const { service, connect } = createHarness();
    for (let index = 0; index < 100; index += 1) {
      const identity = index % 3;
      const client = connect(`s${index}`, identity === 2 ? undefined : { id: `u${identity}`, role: 'USER' });
      client.receive(REALTIME_SOCKET_EVENTS.subscribe, 'items');
    }
    await Promise.resolve();

    const groups = service.getSubscriberGroups('items');
    expect(groups).toHaveLength(3);
    expect(groups.reduce((total, group) => total + group.socketIds.length, 0)).toBe(100);
  });

  it('delegates rt:join / rt:leave / disconnect to RealtimeTopicService', () => {
    const { connect, RealtimeTopicService } = createHarness();
    const client = connect('s1', { id: 'u1', role: 'USER' });
    const ack = vi.fn();

    client.receive(REALTIME_TOPIC_EVENTS.join, { topic: 'room:1' }, ack);
    expect(RealtimeTopicService.join).toHaveBeenCalledWith(client.socket, { topic: 'room:1' }, ack);

    client.receive(REALTIME_TOPIC_EVENTS.leave, { topic: 'room:1' }, ack);
    expect(RealtimeTopicService.leave).toHaveBeenCalledWith(client.socket, { topic: 'room:1' }, ack);

    client.receive('disconnect');
    expect(RealtimeTopicService.cleanup).toHaveBeenCalledWith(client.socket);
  });

  it('delegates an rt:msg envelope to RealtimeTopicService.relay', () => {
    const { connect, RealtimeTopicService } = createHarness();
    const client = connect('s1', { id: 'u1', role: 'USER' });
    const ack = vi.fn();
    const envelope = { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } };
    client.receive(REALTIME_TOPIC_EVENTS.message, envelope, ack);
    expect(RealtimeTopicService.relay).toHaveBeenCalledWith(client.socket, envelope, ack);
  });

  it('broadcastToTopic emits an rt:msg to the topic room and returns member count', () => {
    const { service, rooms, toEmits } = createHarness();
    rooms.set(realtimeTopicRoom('room:1'), new Set(['s1', 's2', 's3']));

    const count = service.broadcastToTopic('room:1', 'cursor', { x: 1 });

    expect(count).toBe(3);
    expect(toEmits).toEqual([
      {
        room: realtimeTopicRoom('room:1'),
        event: REALTIME_TOPIC_EVENTS.message,
        payload: { topic: 'room:1', type: 'broadcast', event: 'cursor', payload: { x: 1 } },
      },
    ]);
  });
});
