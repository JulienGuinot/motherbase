import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@motherbase/client';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import RestApiController from '../controllers/rest-api.controller';
import { createApiErrorHandler } from '../middlewares/api-error.middleware';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { RealtimeOutboxService } from '../services/realtime/realtime-outbox.service';
import { invalidateCatalog } from '../services/rest-api/catalog';
import { parsePrefer } from '../services/rest-api/http-semantics';
import { SchemaService } from '../services/admin/schema.service';

const table = 'rest_write_only';
const pool = new RlsPool();
const dispatch = vi.fn(async () => {});
const svc = new RestApiService({
  prisma,
  RlsPool: pool,
  RealtimeOutboxService: new RealtimeOutboxService({ prisma } as any),
  RealtimeBroadcastService: { captureDeleteAudience: async () => ({ mode: 'disabled' }) },
  EventDispatcherService: { dispatch },
} as any);
let server: Server;
let baseUrl: string;

const payload = (id: string) => ({ id, email: `${id}@example.test` });
const persisted = () => prisma.$queryRawUnsafe<any[]>(`SELECT * FROM ${table} ORDER BY id`);
const events = () => prisma.realtimeOutbox.findMany({ where: { dbName: table }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE TABLE ${table} (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    email text NOT NULL,
    note text DEFAULT 'database default',
    large bigint DEFAULT 9007199254740993,
    action text DEFAULT 'user data',
    size integer GENERATED ALWAYS AS (length(email)) STORED
  )`);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO anon, authenticated`);
  await prisma.$executeRawUnsafe(`CREATE POLICY submit ON ${table} FOR INSERT TO PUBLIC WITH CHECK (email LIKE '%@%')`);
  await prisma.$executeRawUnsafe(`CREATE POLICY admin_read ON ${table} FOR SELECT TO authenticated USING (true)`);
  await prisma.$executeRawUnsafe(`CREATE FUNCTION rest_write_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.note := upper(NEW.note); RETURN NEW; END; $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER apply_defaults BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION rest_write_defaults()`);
  invalidateCatalog();

  const controller = new RestApiController({ RestApiService: svc } as any);
  const app = express();
  app.use(express.json());
  app.post('/rest/v1/:model', (req, res, next) => controller.post(req, res, next));
  app.get('/rest/v1/:model', (req, res, next) => controller.get(req, res, next));
  app.use(createApiErrorHandler({ isProduction: true }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE ${table}`);
  await prisma.realtimeOutbox.deleteMany({ where: { dbName: table } });
  dispatch.mockClear();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS rest_write_defaults()');
  await prisma.realtimeOutbox.deleteMany({ where: { dbName: table } });
  invalidateCatalog();
  await pool.end();
});

describe('Supabase write-only form contract', () => {
  it('keeps internal capture triggers out of the user-managed trigger list', async () => {
    const triggers = await new SchemaService({}).listTriggers('public');
    expect(triggers.filter(trigger => trigger.table === table).map(trigger => trigger.name))
      .toEqual(['apply_defaults']);
  });

  it.each([undefined, 'supabase'] as const)('inserts without SELECT in SDK mode %s', async compat => {
    const client = createClient(baseUrl, undefined, { compat });
    expect(await client.from(table).insert(payload('form'))).toMatchObject({ data: null, error: null });
    expect((await client.from(table).select()).data).toEqual([]);
    expect(await persisted()).toMatchObject([{ ...payload('form'), note: 'DATABASE DEFAULT', size: 17 }]);
    expect(await events()).toMatchObject([{ action: 'created', payloads: [{ note: 'DATABASE DEFAULT', size: 17 }] }]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'return=minimal'])('returns HTTP 201 with no body for Prefer %s', async prefer => {
    const response = await fetch(`${baseUrl}/rest/v1/${table}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: JSON.stringify(payload('raw')),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('');
    expect(await persisted()).toHaveLength(1);
  });

  it('requires a SELECT policy only when .select() requests the inserted row, and rolls back on denial', async () => {
    const client = createClient(baseUrl);
    const result = await client.from(table).insert(payload('denied')).select();
    expect(result.error).toMatchObject({ status: 403 });
    expect(result.data).toBeNull();
    expect(await persisted()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not require even a SELECT grant for a minimal insert', async () => {
    await prisma.$executeRawUnsafe(`REVOKE SELECT ON ${table} FROM anon`);
    try {
      await expect(svc.handlePost(table, payload('grant'))).resolves.toEqual([]);
      expect(await events()).toHaveLength(1);
    } finally {
      await prisma.$executeRawUnsafe(`GRANT SELECT ON ${table} TO anon`);
    }
  });

  it('returns only requested columns to a caller who can read, while events retain the stored row', async () => {
    const rows = await svc.handlePost(table, payload('visible'), { id: 'admin', role: 'USER' }, {
      prefer: parsePrefer('return=representation'), query: { select: 'key:id' },
    });
    expect(rows).toEqual([{ key: 'visible' }]);
    expect(await events()).toMatchObject([{ payloads: [{ id: 'visible', email: 'visible@example.test', size: 20, large: '9007199254740993', action: 'user data' }] }]);
  });

  it('does not require SELECT grants on columns omitted from the requested representation', async () => {
    await prisma.$executeRawUnsafe(`REVOKE SELECT ON ${table} FROM authenticated`);
    await prisma.$executeRawUnsafe(`GRANT SELECT (id) ON ${table} TO authenticated`);
    try {
      await expect(svc.handlePost(table, payload('column_grant'), { id: 'reader' }, {
        prefer: parsePrefer('return=representation'), query: { select: 'id' },
      })).resolves.toEqual([{ id: 'column_grant' }]);
      expect(await events()).toMatchObject([{ payloads: [{ email: 'column_grant@example.test' }] }]);
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE SELECT (id) ON ${table} FROM authenticated`);
      await prisma.$executeRawUnsafe(`GRANT SELECT ON ${table} TO authenticated`);
    }
  });

  it('preserves INSERT checks and rolls back an entire bulk write, including its events', async () => {
    await expect(svc.handlePost(table, [payload('good'), { id: 'bad', email: 'invalid' }])).rejects.toMatchObject({ code: '42501' });
    expect(await persisted()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('honours restrictive policies even alongside a permissive PUBLIC INSERT policy', async () => {
    await prisma.$executeRawUnsafe(`CREATE POLICY block_submit ON ${table} AS RESTRICTIVE FOR INSERT TO anon WITH CHECK (false)`);
    try {
      await expect(svc.handlePost(table, payload('restricted'))).rejects.toMatchObject({ code: '42501' });
      expect(await persisted()).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP POLICY block_submit ON ${table}`);
    }
  });

  it.each(['return=minimal,max-affected=1', 'return=minimal,tx=rollback'])('keeps %s atomic without returned rows', async prefer => {
    const write = svc.handlePost(table, [payload('one'), payload('two')], undefined, { prefer: parsePrefer(prefer) });
    if (prefer.includes('max-affected')) await expect(write).rejects.toMatchObject({ code: 'PGRST124' });
    else await expect(write).resolves.toEqual([]);
    expect(await persisted()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('captures database-generated identifiers and separates simultaneous requests', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => svc.handlePost(table, { email: `${i}@example.test` })));
    const stored = await persisted();
    expect(stored).toHaveLength(5);
    expect((await events()).flatMap(event => (event.payloads as any[]).map(row => row.id)).sort())
      .toEqual(stored.map(row => row.id).sort());
    expect(await prisma.$queryRawUnsafe('SELECT * FROM platform.rest_write_requests')).toEqual([]);
    expect(await prisma.$queryRawUnsafe('SELECT * FROM platform.rest_write_changes')).toEqual([]);
  });

  it('rolls back a failed batch without sending events from its earlier successful writes', async () => {
    await expect(svc.handleBatch([
      { method: 'POST', model: table, body: payload('first') },
      { method: 'POST', model: table, body: { id: 'second', email: 'invalid' } },
    ], undefined, { prefer: parsePrefer('return=minimal') })).rejects.toMatchObject({ code: '42501' });
    expect(await persisted()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rolls back a complete batch dry run, including the private capture and outbox', async () => {
    await expect(svc.handleBatch([
      { method: 'POST', model: table, body: payload('first') },
      { method: 'POST', model: table, body: payload('second') },
    ], undefined, { prefer: parsePrefer('return=minimal,tx=rollback') })).resolves.toEqual([[], []]);
    expect(await persisted()).toEqual([]);
    expect(await events()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps event capture working for service_role without changing its normal RLS bypass', async () => {
    await expect(svc.handlePost(table, { id: 'service', email: 'no-at-sign' }, { serviceRole: true }))
      .resolves.toEqual([]);
    expect(await events()).toMatchObject([{ action: 'created', payloads: [{ id: 'service' }] }]);
  });

  it('fails atomically if an operator disables the internal capture trigger', async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER motherbase_capture_write`);
    try {
      await expect(svc.handlePost(table, payload('disabled'))).rejects.toThrow('Missing REST write capture trigger');
      expect(await persisted()).toEqual([]);
      expect(await events()).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER motherbase_capture_write`);
    }
  });

  it('does not mistake writes nested inside a user trigger for rows returned by the REST statement', async () => {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION rest_write_nested() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = 'parent' THEN
          INSERT INTO ${table} (id, email) VALUES ('child', 'child@example.test');
        END IF;
        RETURN NEW;
      END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER nested_write BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION rest_write_nested()`);
    try {
      await svc.handlePost(table, payload('parent'));
      expect(await persisted()).toHaveLength(2);
      const captured = await events();
      expect(captured).toHaveLength(1);
      expect(captured[0].payloads).toMatchObject([{ id: 'parent' }]);
      expect(captured[0].payloads).toHaveLength(1);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER nested_write ON ${table}`);
      await prisma.$executeRawUnsafe('DROP FUNCTION rest_write_nested()');
    }
  });

  it('captures one event for a SQL-created partitioned table, without duplicate child triggers', async () => {
    const partitioned = 'rest_write_partitioned';
    await prisma.$executeRawUnsafe(`CREATE TABLE ${partitioned} (id integer PRIMARY KEY) PARTITION BY RANGE (id)`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE rest_write_partition PARTITION OF ${partitioned} FOR VALUES FROM (0) TO (10)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE rest_write_partition_other PARTITION OF ${partitioned} DEFAULT`);
      await prisma.$executeRawUnsafe(`ALTER TABLE ${partitioned} ENABLE ROW LEVEL SECURITY`);
      await prisma.$executeRawUnsafe(`GRANT INSERT ON ${partitioned} TO anon`);
      await prisma.$executeRawUnsafe(`CREATE POLICY submit ON ${partitioned} FOR INSERT TO anon WITH CHECK (true)`);
      invalidateCatalog();
      await expect(svc.handlePost(partitioned, { id: 1 })).resolves.toEqual([]);
      const captured = await prisma.realtimeOutbox.findMany({ where: { dbName: partitioned } });
      expect(captured).toMatchObject([{ action: 'created', payloads: [{ id: 1 }] }]);
      expect(captured).toHaveLength(1);

      await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON ${partitioned} TO authenticated`);
      await prisma.$executeRawUnsafe(`CREATE POLICY manage ON ${partitioned} FOR ALL TO authenticated USING (true) WITH CHECK (true)`);
      await expect(svc.handlePatch(partitioned, { id: 'eq.1' }, { id: 20 }, { id: 'manager' }))
        .resolves.toEqual([]);
      const moved = await prisma.realtimeOutbox.findMany({ where: { dbName: partitioned, action: 'updated' } });
      expect(moved).toHaveLength(1);
      expect(moved[0].payloads).toEqual([{ id: 20 }]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE ${partitioned} CASCADE`);
      await prisma.realtimeOutbox.deleteMany({ where: { dbName: partitioned } });
      invalidateCatalog();
    }
  });

  it('denies access to the capture buffer and its private functions', async () => {
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      for (const sql of [
        'SELECT * FROM platform.rest_write_changes',
        "INSERT INTO platform.rest_write_requests VALUES (gen_random_uuid(), pg_backend_pid(), txid_current(), 0)",
        `SELECT platform.attach_rest_write_capture('${table}'::regclass)`,
      ]) {
        await expect(pool.withRlsTx({ role, claims: '{}' }, client => client.query(sql)))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
  });
});
