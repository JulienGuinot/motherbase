import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { createClient, type MotherbaseClient } from '@motherbase/client';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { SocketService } from '../services/socket.service';
import { RealtimeTopicService } from '../services/realtime/realtime-topic.service';
import { RealtimePresenceService } from '../services/realtime/realtime-presence.service';
import { RealtimePostgresService } from '../services/realtime/realtime-postgres.service';
import { RealtimeOutboxService } from '../services/realtime/realtime-outbox.service';
import { RealtimeAuthorizationService } from '../services/realtime/realtime-authorization.service';
import { RlsService } from '../services/admin/rls.service';

/**
 * The whole path of Realtime Broadcast from Database, with nothing mocked but
 * the settings store: SQL calls `realtime.send` (directly and through a
 * `realtime.broadcast_changes` trigger), the outbox worker claims the event,
 * and the real SDK receives it over a real socket. Private channels are
 * authorized by RLS policies on `realtime.messages`.
 */

const TOKENS: Record<string, { id: string; role: string }> = { 'token-u1': { id: 'u1', role: 'USER' } };

const pool = new RlsPool();
const deps: Record<string, unknown> = {
  prisma,
  RlsPool: pool,
  SettingsService: { get: async () => ({ enablePostgresChanges: true, maxChannelsPerClient: 100, privateOnly: false }) },
  RealtimeAdminService: { setIO: () => {}, pushEvent: () => {} },
};
for (const [name, Service] of Object.entries({
  SocketService,
  RealtimeTopicService,
  RealtimePresenceService,
  RealtimePostgresService,
  RealtimeOutboxService,
  RealtimeAuthorizationService,
})) {
  deps[name] = new Service(deps as any);
}
const outbox = deps.RealtimeOutboxService as RealtimeOutboxService;

let http: HttpServer;
let io: Server;
let url: string;
const clients: MotherbaseClient[] = [];

function client(token?: string): MotherbaseClient {
  const session = token ? { accessToken: token, user: { id: TOKENS[token].id } } : null;
  const created = createClient(url, undefined, { storage: { get: () => session as any, set: () => {} } });
  clients.push(created);
  return created;
}

function subscribed(channel: ReturnType<MotherbaseClient['channel']>): Promise<string> {
  return new Promise(resolve => channel.subscribe((status, err) => resolve(err ? `${status}: ${err.message}` : status)));
}

async function drainOutbox(): Promise<void> {
  while (await outbox.processNext()) {
    /* deliver everything committed so far */
  }
}

function nextBroadcast(channel: ReturnType<MotherbaseClient['channel']>, event: string): Promise<unknown> {
  return new Promise(resolve => channel.on('broadcast', { event }, message => resolve(message.payload)));
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "platform"."realtime_outbox"`);
  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS rt_test_read ON realtime.messages`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY rt_test_read ON realtime.messages FOR SELECT TO authenticated
       USING (realtime.topic() = 'private:room' AND extension = 'broadcast' AND auth.uid() = 'u1')`
  );
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rt_broadcast_notes CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE rt_broadcast_notes (id int PRIMARY KEY, body text)`);
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION rt_broadcast_notes_changes() RETURNS trigger
    SECURITY DEFINER LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM realtime.broadcast_changes('private:room', TG_OP, TG_OP, TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD);
      RETURN NULL;
    END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER rt_broadcast_notes_changes AFTER INSERT ON rt_broadcast_notes
    FOR EACH ROW EXECUTE FUNCTION rt_broadcast_notes_changes()`);

  http = createServer();
  io = new Server(http, { path: '/ws' });
  // Stands in for the session lookup in app.ts: a known token is a user.
  io.use((socket, next) => {
    const user = TOKENS[String((socket.handshake.auth as { token?: string })?.token)];
    if (user) socket.data.user = user;
    next();
  });
  (deps.SocketService as SocketService).initialize(io);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.realtime.disconnect();
  io?.close();
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rt_broadcast_notes CASCADE`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS rt_broadcast_notes_changes()`);
  await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS rt_test_read ON realtime.messages`);
  await prisma.$executeRawUnsafe(`DELETE FROM realtime.messages`);
  await pool.end();
});

describe('realtime broadcast from the database', () => {
  it('delivers realtime.send on a public topic to public subscribers only', async () => {
    const channel = client().channel('public:lobby');
    const received = nextBroadcast(channel, 'hello');
    expect(await subscribed(channel)).toBe('SUBSCRIBED');

    await prisma.$executeRawUnsafe(`SELECT realtime.send('{"n": 1}'::jsonb, 'hello', 'public:lobby', false)`);
    await drainOutbox();

    expect(await received).toEqual({ n: 1 });
  });

  it('refuses a private join the policies do not allow', async () => {
    expect(await subscribed(client().channel('private:room', { config: { private: true } }))).toMatch(
      /^CHANNEL_ERROR: Unauthorized/
    );
    expect(await subscribed(client().channel('private:elsewhere', { config: { private: true } }))).toMatch(
      /^CHANNEL_ERROR/
    );
  });

  it('delivers a broadcast_changes trigger message to the authorized private subscriber', async () => {
    const authorized = client('token-u1').channel('private:room', { config: { private: true } });
    const publicTwin = client('token-u1').channel('private:room');
    const received = nextBroadcast(authorized, 'INSERT');
    let leaked = false;
    publicTwin.on('broadcast', { event: 'INSERT' }, () => { leaked = true; });
    expect(await subscribed(authorized)).toBe('SUBSCRIBED');
    expect(await subscribed(publicTwin)).toBe('SUBSCRIBED');

    await prisma.$executeRawUnsafe(`INSERT INTO rt_broadcast_notes VALUES (1, 'hi')`);
    await drainOutbox();

    expect(await received).toEqual({
      operation: 'INSERT',
      table: 'rt_broadcast_notes',
      schema: 'public',
      record: { id: 1, body: 'hi' },
      old_record: null,
    });
    // The public channel of the same name is a different audience.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(leaked).toBe(false);
  });

  it('refuses a client broadcast on a private channel without an INSERT policy', async () => {
    const channel = client('token-u1').channel('private:room', { config: { private: true, broadcast: { ack: true } } });
    expect(await subscribed(channel)).toBe('SUBSCRIBED');
    expect(await channel.send({ type: 'broadcast', event: 'typing', payload: {} })).toBe('error');
  });
});

describe('realtime policies from Studio', () => {
  const rls = new RlsService({ prisma } as any);
  const authz = deps.RealtimeAuthorizationService as RealtimeAuthorizationService;

  it('creates a policy on realtime.messages that authorizes sending, and drops it again', async () => {
    const user = { id: 'u1' };
    expect((await authz.channelAccess(user, 'private:room')).broadcast.write).toBe(false);

    await rls.createRealtimePolicy({
      name: 'rt_test_send',
      command: 'INSERT',
      role: 'authenticated',
      check: "realtime.topic() = 'private:room' AND extension = 'broadcast'",
    });
    expect((await rls.listRealtimePolicies()).map(p => p.name)).toContain('rt_test_send');
    expect((await authz.channelAccess(user, 'private:room')).broadcast).toEqual({ read: true, write: true });
    expect((await authz.channelAccess(user, 'private:other')).broadcast.write).toBe(false);

    await rls.dropRealtimePolicy('rt_test_send');
    expect((await rls.listRealtimePolicies()).map(p => p.name)).not.toContain('rt_test_send');
  });
});
