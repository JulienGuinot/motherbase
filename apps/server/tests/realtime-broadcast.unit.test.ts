import { describe, expect, it, vi } from 'vitest';
import { RealtimeBroadcastService } from '../services/realtime/realtime-broadcast.service';
import type { SubscriberIdentityGroup } from '../services/socket.service';

const model = { model: 'Item', dbName: 'items' };

function makeDeliveryHarness(groups: SubscriberIdentityGroup[], topicSubscribers: string[] = []) {
  const emitted: Array<{ socketIds: string[]; event: string; payload: unknown }> = [];
  let currentSubscribers = new Set(groups.flatMap(group => group.socketIds));
  const withRlsTx = vi.fn(async (ctx: any, run: any) => {
    const claims = JSON.parse(ctx.claims);
    return run({
      query: vi.fn(async (_sql: string, params: unknown[][]) => {
        const ids = params[0].map(String);
        const visible = claims.sub === 'u1' ? ids : claims.sub === 'u2' ? ids.filter(id => id === 'r2') : [];
        return { rows: visible.map(id => ({ id })) };
      }),
    });
  });
  const SocketService = {
    getSubscriberGroups: vi.fn(() => groups),
    getSubscriberSocketIds: vi.fn(() => currentSubscribers),
    emitToSocketIds: vi.fn((socketIds: Iterable<string>, event: string, payload: unknown) => {
      emitted.push({ socketIds: Array.from(socketIds), event, payload });
    }),
  };
  const RealtimeAdminService = {
    isModelEnabled: vi.fn(async () => true),
    getModelConfig: vi.fn(async () => ({ respectRls: true })),
  };
  // Stands in for RealtimePostgresService: the listed sockets have a matching
  // postgres_changes binding, so they get the rt:msg envelope for the row.
  const RealtimePostgresService = {
    fanToTopics: vi.fn(
      (socketIds: Iterable<string>) => new Set(Array.from(socketIds).filter(id => topicSubscribers.includes(id)))
    ),
  };
  const service = new RealtimeBroadcastService({
    RlsPool: { withRlsTx },
    SocketService,
    RealtimeAdminService,
    ...(topicSubscribers.length ? { RealtimePostgresService } : {}),
  } as any);

  return {
    service,
    emitted,
    RealtimePostgresService,
    withRlsTx,
    SocketService,
    RealtimeAdminService,
    setCurrentSubscribers: (ids: string[]) => {
      currentSubscribers = new Set(ids);
    },
  };
}

describe('RealtimeBroadcastService', () => {
  it('batches visibility once per identity for 100 sockets and multiple rows', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: [] },
      { key: 'user:u2:USER', user: { id: 'u2', role: 'USER' }, socketIds: [] },
      { key: 'anonymous', user: null, socketIds: [] },
    ];
    for (let index = 0; index < 100; index += 1) groups[index % groups.length].socketIds.push(`s${index}`);
    const harness = makeDeliveryHarness(groups);

    await harness.service.deliverPersisted(model, 'created', [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);

    expect(harness.withRlsTx).toHaveBeenCalledTimes(3);
    expect(harness.emitted.flatMap(item => item.socketIds).length).toBe(
      groups[0].socketIds.length * 3 + groups[1].socketIds.length
    );
    expect(harness.emitted.every(item => item.event === 'item:created')).toBe(true);
  });

  it('propagates RLS visibility errors for persisted delivery retries', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['s1'] },
    ];
    const harness = makeDeliveryHarness(groups);
    harness.withRlsTx.mockRejectedValueOnce(new Error('RLS unavailable'));

    await expect(harness.service.deliverPersisted(model, 'created', [{ id: 'r1' }])).rejects.toThrow('RLS unavailable');
    expect(harness.emitted).toEqual([]);
  });

  it('skips delivery when realtime is disabled for the model', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['s1'] },
    ];
    const harness = makeDeliveryHarness(groups);
    harness.RealtimeAdminService.isModelEnabled.mockResolvedValue(false);

    await harness.service.deliverPersisted(model, 'created', [{ id: 'r1' }]);

    expect(harness.withRlsTx).not.toHaveBeenCalled();
    expect(harness.emitted).toEqual([]);
  });

  it('captures a delete audience before removal and honors a later unsubscribe', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['owner-a', 'owner-b'] },
      { key: 'user:u2:USER', user: { id: 'u2', role: 'USER' }, socketIds: ['other'] },
    ];
    const harness = makeDeliveryHarness(groups);
    const audience = await harness.service.captureDeleteAudience(model, ['r1']);
    const visibilityQueries = harness.withRlsTx.mock.calls.length;

    harness.setCurrentSubscribers(['owner-b', 'late-subscriber']);
    await harness.service.deliverPersisted(model, 'deleted', [{ id: 'r1' }], audience);

    expect(harness.withRlsTx).toHaveBeenCalledTimes(visibilityQueries);
    expect(harness.emitted).toEqual([{ socketIds: ['owner-b'], event: 'item:deleted', payload: { id: 'r1' } }]);
  });

  it('does not send the legacy flat event to a socket that got the rt:msg envelope for the same row', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['watch-only', 'channel-and-watch'] },
    ];
    const harness = makeDeliveryHarness(groups, ['channel-and-watch']);

    await harness.service.deliverPersisted(model, 'created', [{ id: 'r1' }]);

    // The channel socket is served by fanToTopics only; watchTable-only keeps the flat event.
    expect(harness.emitted).toEqual([{ socketIds: ['watch-only'], event: 'item:created', payload: { id: 'r1' } }]);
    expect(harness.RealtimePostgresService.fanToTopics).toHaveBeenCalledTimes(1);
  });

  it('applies the same dedup to deletes', async () => {
    const groups: SubscriberIdentityGroup[] = [
      { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['watch-only', 'channel-and-watch'] },
    ];
    const harness = makeDeliveryHarness(groups, ['channel-and-watch']);
    const audience = await harness.service.captureDeleteAudience(model, ['r1']);

    await harness.service.deliverPersisted(model, 'deleted', [{ id: 'r1' }], audience);

    expect(harness.emitted).toEqual([{ socketIds: ['watch-only'], event: 'item:deleted', payload: { id: 'r1' } }]);
  });

  it('captures the subscribed socket snapshot when RLS filtering is disabled', async () => {
    const groups: SubscriberIdentityGroup[] = [{ key: 'anonymous', user: null, socketIds: ['existing'] }];
    const harness = makeDeliveryHarness(groups);
    harness.RealtimeAdminService.getModelConfig.mockResolvedValue({ respectRls: false });

    const audience = await harness.service.captureDeleteAudience(model, ['r1']);
    harness.setCurrentSubscribers(['existing', 'late']);
    await harness.service.deliverPersisted(model, 'deleted', [{ id: 'r1' }], audience);

    expect(harness.withRlsTx).not.toHaveBeenCalled();
    expect(harness.emitted[0].socketIds).toEqual(['existing']);
  });
});
