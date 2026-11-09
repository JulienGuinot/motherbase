import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { QueueService } from '../services/admin/queue.service';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { invalidateCatalog } from '../services/rest-api/catalog';

/**
 * Queues end to end, on the pgmq the database image ships.
 *
 * The admin half is plumbing. The half that matters is the API: a queue is
 * reachable over `/rest/v1/rpc` through `pgmq_public` only once exposed, and
 * then only as far as the caller's own grants and the queue's RLS allow,
 * because the wrappers are SECURITY INVOKER. Those are the cases below.
 *
 * CI runs a stock Postgres without pgmq, so the file skips itself there
 * rather than fail on an image it cannot build.
 */

const queues = new QueueService({ prisma } as never);
const pool = new RlsPool();
const rest = new RestApiService({ prisma, RlsPool: pool } as never);

const OPEN = 'it_queue_open';
const LOCKED = 'it_queue_rls';
const SERVICE = { serviceRole: true };

describe('queues', async () => {
  const pgmq = (await queues.status()).available;

  const sendAs = (queue: string, caller?: typeof SERVICE) =>
    rest.handleRpc('send', { queue_name: queue, message: { hello: queue } }, caller as never, {
      method: 'POST',
      schema: 'pgmq_public',
    });

  beforeAll(async () => {
    if (!pgmq) return;
    await queues.enable();
    for (const name of [OPEN, LOCKED]) {
      await prisma.$queryRawUnsafe('SELECT pgmq.drop_queue($1)', name).catch(() => undefined);
    }
    await queues.setExposed(true);
    await queues.create({ name: OPEN, type: 'basic', rls: false });
    await queues.create({ name: LOCKED, type: 'unlogged', rls: true });
    invalidateCatalog();
  });

  afterAll(async () => {
    if (pgmq) for (const name of [OPEN, LOCKED]) await queues.drop(name).catch(() => undefined);
    await pool.end();
  });

  describe.skipIf(!pgmq)('queue admin', () => {
    it('lists queues with their type, RLS state and metrics', async () => {
      const { installed, exposed, queues: list } = await queues.list();
      expect(installed).toBe(true);
      expect(exposed).toBe(true);
      expect(list.find(q => q.name === OPEN)).toMatchObject({ type: 'basic', rlsEnabled: false, length: 0 });
      expect(list.find(q => q.name === LOCKED)).toMatchObject({ type: 'unlogged', rlsEnabled: true });
    });

    it('sends, browses without consuming, reads, archives and deletes', async () => {
      const [first] = await queues.send(OPEN, { n: 1 });
      const [second] = await queues.send(OPEN, 'plain string');

      const browsed = await queues.messages(OPEN);
      expect(browsed.total).toBe(2);
      expect(browsed.messages.map(m => m.read_ct)).toEqual([0, 0]);

      const [read] = await queues.read(OPEN, 30, 1);
      expect(read).toMatchObject({ msg_id: first, read_ct: 1, message: { n: 1 } });

      await queues.archive(OPEN, first);
      await queues.deleteMessage(OPEN, second);
      expect((await queues.messages(OPEN)).total).toBe(0);
      expect((await queues.messages(OPEN, { archived: true })).messages[0]).toMatchObject({ msg_id: first });
      await expect(queues.deleteMessage(OPEN, second)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('purges a queue and reports how many messages went', async () => {
      await queues.send(OPEN, 1);
      await queues.send(OPEN, 2);
      expect(await queues.purge(OPEN)).toBe(2);
    });

    it('refuses a duplicate and a queue that does not exist', async () => {
      await expect(queues.create({ name: OPEN, type: 'basic', rls: false })).rejects.toMatchObject({ statusCode: 409 });
      await expect(queues.messages('it_queue_missing')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe.skipIf(!pgmq)('queues over the REST API (pgmq_public)', () => {
    it('lets service_role send once exposed', async () => {
      const result = await sendAs(OPEN, SERVICE);
      expect(result.rows).toHaveLength(1);
    });

    it('refuses anon until the queue grants it, then honours the grant', async () => {
      await queues.setPermissions(OPEN, {
        roles: { anon: { select: false, insert: false, update: false, delete: false } },
      });
      await expect(sendAs(OPEN)).rejects.toThrow(/permission denied/);

      const granted = await queues.setPermissions(OPEN, {
        roles: { anon: { select: true, insert: true, update: true, delete: false } },
      });
      expect(granted.roles.anon).toEqual({ select: true, insert: true, update: true, delete: false });
      expect((await sendAs(OPEN)).rows).toHaveLength(1);
    });

    it('filters a granted role through the queue\'s RLS', async () => {
      await queues.setPermissions(LOCKED, {
        roles: { anon: { select: true, insert: true, update: true, delete: true } },
      });
      // Granted, but RLS is on and no policy admits anon.
      await expect(sendAs(LOCKED)).rejects.toThrow(/row-level security/);
    });

    it('stops serving pgmq_public the moment it is un-exposed', async () => {
      await queues.setExposed(false);
      try {
        await expect(sendAs(OPEN, SERVICE)).rejects.toMatchObject({ statusCode: 406, code: 'PGRST106' });
      } finally {
        await queues.setExposed(true);
      }
    });
  });
});
