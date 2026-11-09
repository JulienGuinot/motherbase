import { describe, it, expect, vi } from 'vitest';
import { REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';
import { realtimeModelRoom } from '../services/socket.service';
import { RealtimePostgresService } from '../services/realtime/realtime-postgres.service';

function svcWithSocket() {
  const emitToSocketIds = vi.fn();
  const svc = new RealtimePostgresService({ SocketService: { emitToSocketIds } } as any);
  return { svc, emitToSocketIds };
}
const sock = (id: string) => ({ id, join: vi.fn(), leave: vi.fn() }) as any;
const model = { model: 'messages', dbName: 'messages' };

describe('RealtimePostgresService', () => {
  it('registers a binding, joins the model room, and fans a matching INSERT envelope', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    const s = sock('s1');
    svc.register(s, 'room:1', { event: 'INSERT', schema: 'public', table: 'messages' });
    expect(s.join).toHaveBeenCalledWith(realtimeModelRoom('messages'));

    svc.fanToTopics(['s1'], model, 'created', { id: 7, body: 'hi' });
    expect(emitToSocketIds).toHaveBeenCalledTimes(1);
    const [ids, event, envelope] = emitToSocketIds.mock.calls[0];
    expect(ids).toEqual(['s1']);
    expect(event).toBe(REALTIME_TOPIC_EVENTS.message);
    expect(envelope).toMatchObject({
      topic: 'room:1',
      type: 'postgres_changes',
      event: 'INSERT',
      payload: { schema: 'public', table: 'messages', eventType: 'INSERT', new: { id: 7, body: 'hi' }, old: {} },
    });
  });

  it('reports which sockets received an envelope so the legacy flat event can be skipped', () => {
    const { svc } = svcWithSocket();
    svc.register(sock('s1'), 'room:1', { event: 'INSERT', table: 'messages' });
    // s2 is in the model room (legacy watchTable) but has no topic binding.
    expect(svc.fanToTopics(['s1', 's2'], model, 'created', { id: 1 })).toEqual(new Set(['s1']));
    // Filtered out rows deliver nothing, so the socket keeps the legacy event.
    expect(svc.fanToTopics(['s1', 's2'], model, 'updated', { id: 1 })).toEqual(new Set());
  });

  it('does not fan when the action does not match the binding event', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    svc.register(sock('s1'), 'room:1', { event: 'INSERT', table: 'messages' });
    svc.fanToTopics(['s1'], model, 'updated', { id: 1 });
    expect(emitToSocketIds).not.toHaveBeenCalled();
  });

  it('applies the column filter (eq) and drops non-matching rows', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    svc.register(sock('s1'), 'room:1', { event: '*', table: 'messages', filter: 'room_id=eq.42' });
    svc.fanToTopics(['s1'], model, 'created', { id: 1, room_id: 99 });
    expect(emitToSocketIds).not.toHaveBeenCalled();
    svc.fanToTopics(['s1'], model, 'created', { id: 2, room_id: 42 });
    expect(emitToSocketIds).toHaveBeenCalledTimes(1);
  });

  it('shapes a DELETE with the row under old', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    svc.register(sock('s1'), 'room:1', { event: '*', table: 'messages' });
    svc.fanToTopics(['s1'], model, 'deleted', { id: 3 });
    expect(emitToSocketIds.mock.calls[0][2].payload).toMatchObject({ eventType: 'DELETE', new: {}, old: { id: 3 } });
  });

  it('unregisterTopic leaves the model room and stops fanning once the last binding is gone', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    const s = sock('s1');
    svc.register(s, 'room:1', { event: '*', table: 'messages' });
    svc.unregisterTopic(s, 'room:1');
    expect(s.leave).toHaveBeenCalledWith(realtimeModelRoom('messages'));
    svc.fanToTopics(['s1'], model, 'created', { id: 1 });
    expect(emitToSocketIds).not.toHaveBeenCalled();
  });

  it('unregisterSocket removes every binding for the socket', () => {
    const { svc, emitToSocketIds } = svcWithSocket();
    const s = sock('s1');
    svc.register(s, 'room:1', { event: '*', table: 'messages' });
    svc.unregisterSocket(s);
    svc.fanToTopics(['s1'], model, 'created', { id: 1 });
    expect(emitToSocketIds).not.toHaveBeenCalled();
  });
});

it('preserves binding ids for distinct and overlapping subscriptions', () => {
  const { svc, emitToSocketIds } = svcWithSocket();
  const s = sock('s1');
  svc.register(s, 'topic', { event: '*', table: 'messages', filter: 'id=eq.1' }, 1);
  svc.register(s, 'topic', { event: '*', table: 'messages', filter: 'id=eq.2' }, 2);
  svc.register(s, 'topic', { event: 'INSERT', table: 'messages' }, 3);
  svc.fanToTopics(['s1'], model, 'created', { id: 1 });
  expect(emitToSocketIds.mock.calls.map(call => call[2].bindingId)).toEqual([1, 3]);
});
