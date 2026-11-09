import { describe, it, expect, vi } from 'vitest';
import { REALTIME_TOPIC_EVENTS } from '@motherbase/contracts';
import { RealtimePresenceService } from '../services/realtime/realtime-presence.service';

function svcWithSpy() {
  const emitEnvelopeToTopic = vi.fn();
  const svc = new RealtimePresenceService({ SocketService: { emitEnvelopeToTopic } } as any);
  return { svc, emitEnvelopeToTopic };
}
const sock = (id: string) => ({ id, emit: vi.fn() }) as any;

describe('RealtimePresenceService', () => {
  it('track stores presence and emits full state grouped by key', () => {
    const { svc, emitEnvelopeToTopic } = svcWithSpy();
    const { ref } = svc.track(sock('s1'), 'room:1', { name: 'jane' }, 'user-1');
    expect(ref).toBeTruthy();
    expect(emitEnvelopeToTopic).toHaveBeenCalledWith('room:1', {
      topic: 'room:1',
      type: 'presence',
      event: 'state',
      payload: { 'user-1': [{ presence_ref: ref, name: 'jane' }] },
    });
  });

  it('multiple tracks under the same key coexist; untrack removes only this socket', () => {
    const { svc, emitEnvelopeToTopic } = svcWithSpy();
    svc.track(sock('s1'), 'room:1', { n: 1 }, 'k');
    const s2 = sock('s2');
    svc.track(s2, 'room:1', { n: 2 }, 'k');
    expect((emitEnvelopeToTopic.mock.calls.at(-1)![1] as any).payload.k).toHaveLength(2);
    svc.untrack(s2, 'room:1');
    expect((emitEnvelopeToTopic.mock.calls.at(-1)![1] as any).payload.k).toHaveLength(1);
  });

  it('a repeated track from the same socket replaces its presence instead of stacking refs', () => {
    const { svc, emitEnvelopeToTopic } = svcWithSpy();
    const s1 = sock('s1');
    svc.track(s1, 'room:1', { typing: false }, 'k');
    svc.track(sock('s2'), 'room:1', { typing: false }, 'k');
    for (let i = 0; i < 5; i += 1) svc.track(s1, 'room:1', { typing: true, i }, 'k');

    const state = (emitEnvelopeToTopic.mock.calls.at(-1)![1] as any).payload.k;
    expect(state).toHaveLength(2);
    expect(state.filter((p: any) => p.typing === true)).toEqual([
      { presence_ref: expect.any(String), typing: true, i: 4 },
    ]);
  });

  it('handleDisconnect removes the socket presences across all topics', () => {
    const { svc, emitEnvelopeToTopic } = svcWithSpy();
    const s1 = sock('s1');
    svc.track(s1, 'room:1', {}, 'k1');
    svc.track(s1, 'room:2', {}, 'k2');
    emitEnvelopeToTopic.mockClear();
    svc.handleDisconnect(s1);
    expect(emitEnvelopeToTopic).toHaveBeenCalledTimes(2);
    for (const call of emitEnvelopeToTopic.mock.calls) expect((call[1] as any).payload).toEqual({});
  });

  it('sendStateTo emits the current state to a single socket', () => {
    const { svc } = svcWithSpy();
    svc.track(sock('s1'), 'room:1', { a: 1 }, 'k');
    const s2 = sock('s2');
    svc.sendStateTo(s2, 'room:1');
    expect(s2.emit).toHaveBeenCalledWith(REALTIME_TOPIC_EVENTS.message, {
      topic: 'room:1',
      type: 'presence',
      event: 'state',
      payload: { k: [{ presence_ref: expect.any(String), a: 1 }] },
    });
  });
});
