import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RealtimeBroadcastService } from '../services/realtime/realtime-broadcast.service';
import type { SubscriberIdentityGroup } from '../services/socket.service';

const pool = new RlsPool();
const groups: SubscriberIdentityGroup[] = [
  { key: 'user:u1:USER', user: { id: 'u1', role: 'USER' }, socketIds: ['s-u1'] },
  { key: 'user:u2:USER', user: { id: 'u2', role: 'USER' }, socketIds: ['s-u2'] },
  { key: 'anonymous', user: null, socketIds: ['s-anon'] },
];

const model = {
  model: 'rt_widget',
  dbName: 'rt_widget',
  delegate: 'rt_widget',
  system: false,
  dynamic: true,
  fields: [],
};

function realtimeHarness(respectRls: boolean) {
  const emitted: Array<{ socket: string; event: string; payload: any }> = [];
  const current = new Set(groups.flatMap(group => group.socketIds));
  const SocketService = {
    getSubscriberGroups: () => groups,
    getSubscriberSocketIds: () => current,
    emitToSocketIds: (ids: Iterable<string>, event: string, payload: any) => {
      for (const socket of ids) emitted.push({ socket, event, payload });
    },
  };
  const RealtimeAdminService = {
    isModelEnabled: async () => true,
    getModelConfig: async () => ({ respectRls }),
  };
  const service = new RealtimeBroadcastService({
    prisma,
    RlsPool: pool,
    RealtimeAdminService,
    SocketService,
  } as any);
  return { emitted, service, SocketService, RealtimeAdminService };
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rt_widget CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE rt_widget (id text PRIMARY KEY, user_id text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE rt_widget ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, DELETE ON rt_widget TO anon, authenticated`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY o ON rt_widget FOR SELECT TO authenticated USING (auth.uid() = user_id)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE POLICY d ON rt_widget FOR DELETE TO authenticated USING (auth.uid() = user_id)`
  );
  await prisma.$executeRawUnsafe(`INSERT INTO rt_widget VALUES ('r1','u1')`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rt_widget CASCADE`);
  await pool.end();
});

describe('realtime broadcast under RLS', () => {
  it('emits a row only to the subscribed identity that can see it', async () => {
    const harness = realtimeHarness(true);

    await harness.service.deliverPersisted(model, 'created', [{ id: 'r1', user_id: 'u1' }]);

    expect(harness.emitted.map(event => event.socket)).toEqual(['s-u1']);
  });

  it('captures delete recipients before removal and excludes other identities', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO rt_widget VALUES ('r-delete','u1')`);
    const harness = realtimeHarness(true);
    const audience = await harness.service.captureDeleteAudience(model, ['r-delete']);
    await prisma.$executeRawUnsafe(`DELETE FROM rt_widget WHERE id = 'r-delete'`);
    await harness.service.deliverPersisted(model, 'deleted', [{ id: 'r-delete' }], audience);

    expect(harness.emitted).toEqual([{ socket: 's-u1', event: 'rt_widget:deleted', payload: { id: 'r-delete' } }]);
  });

  it('emits to every subscribed socket when RLS filtering is explicitly off', async () => {
    const harness = realtimeHarness(false);

    await harness.service.deliverPersisted(model, 'created', [{ id: 'r1', user_id: 'u1' }]);

    expect(harness.emitted.map(event => event.socket).sort()).toEqual(['s-anon', 's-u1', 's-u2']);
  });
});
