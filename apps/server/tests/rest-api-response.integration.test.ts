import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { invalidateCatalog } from '../services/rest-api/catalog';
import { parsePrefer } from '../services/rest-api/http-semantics';

const RETURN_ROWS = { prefer: parsePrefer('return=representation') };

/**
 * Response semantics against a live Postgres: `Prefer`, `count` and
 * `Content-Range`, real `ON CONFLICT` upserts, and the CSV/single/plan modes.
 *
 * The recorded outbox and webhook calls are what make the `return=minimal` and
 * upsert cases meaningful. A write that answers 204 must still have enqueued its
 * realtime event, and an upsert that updated an existing row must have enqueued
 * `updated`, not `created`: a subscriber told a row was created when it was
 * replaced will apply the wrong local mutation.
 */

const pool = new RlsPool();

interface OutboxCall {
  model: string;
  action: string;
  rows: any[];
}

let outbox: OutboxCall[] = [];
let webhooks: OutboxCall[] = [];

const svc = new RestApiService({
  prisma,
  RlsPool: pool,
  RealtimeBroadcastService: {
    broadcast: async () => {},
    captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
  },
  RealtimeOutboxService: {
    enqueue: async (_client: unknown, model: any, action: string, rows: any[]) => {
      outbox.push({ model: model.model, action, rows });
    },
  },
  EventDispatcherService: {
    dispatch: async (model: string, action: string, rows: any[]) => {
      webhooks.push({ model, action, rows });
    },
  },
} as any);

const USER = { id: 'u1', role: 'USER' };
const MINIMAL = parsePrefer('return=minimal');
const MERGE = parsePrefer('return=representation,resolution=merge-duplicates');
const IGNORE = parsePrefer('return=representation,resolution=ignore-duplicates');
const COUNT_EXACT = parsePrefer('count=exact');

async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE resp_item`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO resp_item (id, email, label, qty) VALUES
      ('i1','a@example.test','alpha',1),
      ('i2','b@example.test','beta', 2),
      ('i3','c@example.test','gamma',3)
  `);
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS resp_item CASCADE`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE resp_item (
      id    text PRIMARY KEY,
      email text UNIQUE,
      label text,
      qty   integer,
      note  text DEFAULT 'default note'
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE resp_item ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON resp_item TO anon, authenticated`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY open_all ON resp_item FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)`
  );
  invalidateCatalog();
  await seed();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS resp_item CASCADE`);
  invalidateCatalog();
  await pool.end();
});

beforeEach(() => {
  outbox = [];
  webhooks = [];
});

// ── 2.4 count and Content-Range ──────────────────────────────────────────────

describe('Prefer: count and Content-Range', () => {
  it('returns no count and an open-ended Content-Range when none was asked for', async () => {
    const result = await svc.handleSelect('resp_item', { order: 'id.asc' }, USER);
    expect(result.count).toBeNull();
    expect(result.contentRange).toBe('0-2/*');
  });

  it('counts every matching row exactly, past the page the caller asked for', async () => {
    const result = await svc.handleSelect(
      'resp_item',
      { order: 'id.asc', limit: '2' },
      USER,
      { prefer: COUNT_EXACT },
    );
    expect(result.rows.map(row => row.id)).toEqual(['i1', 'i2']);
    expect(result.count).toBe(3);
    expect(result.contentRange).toBe('0-1/3');
  });

  it('never leaves the count window column in the returned rows', async () => {
    const result = await svc.handleSelect('resp_item', {}, USER, { prefer: COUNT_EXACT });
    expect(Object.keys(result.rows[0])).not.toContain('__mb_count');
  });

  it('counts the filtered set, not the table', async () => {
    const result = await svc.handleSelect('resp_item', { qty: 'gte.2' }, USER, { prefer: COUNT_EXACT });
    expect(result.count).toBe(2);
  });

  it('reports an offset page in Content-Range', async () => {
    const result = await svc.handleSelect(
      'resp_item',
      { order: 'id.asc', limit: '1', offset: '2' },
      USER,
      { prefer: COUNT_EXACT },
    );
    expect(result.contentRange).toBe('2-2/3');
  });

  // `count(*) OVER ()` emits nothing when the page is empty, and reading that
  // absence as a total of zero made `count=exact` report 0 past the last page:
  // the client then computed one page instead of two and the pager broke.
  it('still reports the real total past the last page', async () => {
    const offsetAtEnd = await svc.handleSelect(
      'resp_item',
      { order: 'id.asc', limit: '2', offset: '3' },
      USER,
      { prefer: COUNT_EXACT },
    );
    expect(offsetAtEnd.rows).toEqual([]);
    expect(offsetAtEnd.count).toBe(3);
    expect(offsetAtEnd.contentRange).toBe('*/3');

    const wayPast = await svc.handleSelect(
      'resp_item',
      { order: 'id.asc', limit: '2', offset: '50' },
      USER,
      { prefer: COUNT_EXACT },
    );
    expect(wayPast.count).toBe(3);
  });

  it('reports zero for a filter that matches nothing', async () => {
    const result = await svc.handleSelect('resp_item', { qty: 'gte.9999' }, USER, { prefer: COUNT_EXACT });
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('answers a head request with a count and no rows', async () => {
    const result = await svc.handleSelect('resp_item', {}, USER, { prefer: COUNT_EXACT, head: true });
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(3);
    expect(result.contentRange).toBe('*/3');
  });

  it('produces a planned count from the query plan estimate', async () => {
    const result = await svc.handleSelect('resp_item', {}, USER, { prefer: parsePrefer('count=planned') });
    expect(typeof result.count).toBe('number');
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  it('produces an estimated count from the table statistics', async () => {
    await prisma.$executeRawUnsafe(`ANALYZE resp_item`);
    const result = await svc.handleSelect('resp_item', {}, USER, { prefer: parsePrefer('count=estimated') });
    expect(result.count).toBe(3);
  });

  it('applies the Range header when no ?limit or ?offset was given', async () => {
    const result = await svc.handleSelect('resp_item', { order: 'id.asc' }, USER, {
      prefer: COUNT_EXACT,
      range: { offset: 1, limit: 2 },
    });
    expect(result.rows.map(row => row.id)).toEqual(['i2', 'i3']);
    expect(result.contentRange).toBe('1-2/3');
  });

  it('lets an explicit ?limit win over the Range header', async () => {
    const result = await svc.handleSelect('resp_item', { order: 'id.asc', limit: '1' }, USER, {
      range: { offset: 0, limit: 3 },
    });
    expect(result.rows.map(row => row.id)).toEqual(['i1']);
  });
});

// ── 2.9 select extras ────────────────────────────────────────────────────────

describe('select casts', () => {
  it('compiles a column cast', async () => {
    const rows = await svc.handleGet('resp_item', { select: 'id,qty::text', id: 'eq.i1' }, USER);
    expect(rows).toEqual([{ id: 'i1', qty: '1' }]);
  });

  it('compiles a cast under an alias', async () => {
    const rows = await svc.handleGet('resp_item', { select: 'amount:qty::text', id: 'eq.i2' }, USER);
    expect(rows).toEqual([{ amount: '2' }]);
  });

  it('refuses a cast that is not a bare type name', async () => {
    await expect(
      svc.handleGet('resp_item', { select: 'qty::text)); DROP TABLE resp_item; --' }, USER),
    ).rejects.toMatchObject({ statusCode: 400, code: 'PGRST100' });
  });
});

// ── 2.5 Prefer: return ───────────────────────────────────────────────────────

describe('Prefer: return', () => {
  it('returns the written rows when explicitly requested', async () => {
    const rows = await svc.handlePost('resp_item', { id: 'n1', email: 'n1@example.test', label: 'new' }, USER, RETURN_ROWS);
    expect(rows).toMatchObject([{ id: 'n1', note: 'default note' }]);
    await seed();
  });

  it('returns no rows for return=minimal but still fires realtime and webhooks', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      { id: 'n2', email: 'n2@example.test', label: 'quiet' },
      USER,
      { prefer: MINIMAL },
    );

    expect(rows).toEqual([]);
    // The trigger captured the row inside the transaction for internal events,
    // without adding a SELECT requirement to the caller’s INSERT.
    expect(outbox).toMatchObject([{ model: 'resp_item', action: 'created', rows: [{ id: 'n2' }] }]);
    expect(webhooks).toMatchObject([{ model: 'resp_item', action: 'created' }]);
    await seed();
  });

  it('returns no rows for a minimal update but still enqueues updated', async () => {
    const rows = await svc.handlePatch('resp_item', { id: 'eq.i1' }, { label: 'quiet' }, USER, {
      prefer: MINIMAL,
    });
    expect(rows).toEqual([]);
    expect(outbox).toMatchObject([{ action: 'updated', rows: [{ id: 'i1', label: 'quiet' }] }]);
    expect(webhooks).toMatchObject([{ action: 'updated' }]);
    await seed();
  });

  it('returns no rows for a minimal delete but still enqueues deleted', async () => {
    const rows = await svc.handleDelete('resp_item', { id: 'eq.i3' }, USER, { prefer: MINIMAL });
    expect(rows).toEqual([]);
    expect(outbox).toMatchObject([{ action: 'deleted', rows: [{ id: 'i3' }] }]);
    expect(webhooks).toMatchObject([{ action: 'deleted' }]);
    await seed();
  });

  it('treats headers-only like minimal for the body', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      { id: 'n3', email: 'n3@example.test' },
      USER,
      { prefer: parsePrefer('return=headers-only') },
    );
    expect(rows).toEqual([]);
    expect(outbox).toHaveLength(1);
    await seed();
  });
});

// ── 2.5 bulk insert ──────────────────────────────────────────────────────────

describe('bulk insert', () => {
  it('inserts an array of rows in one statement', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      [
        { id: 'b1', email: 'b1@example.test', label: 'b1' },
        { id: 'b2', email: 'b2@example.test', label: 'b2' },
      ],
      USER, RETURN_ROWS
    );
    expect(rows.map(row => row.id)).toEqual(['b1', 'b2']);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].rows).toHaveLength(2);
    await seed();
  });

  it('lets a row omit a column so the database default applies', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      [
        { id: 'b3', email: 'b3@example.test', note: 'explicit' },
        { id: 'b4', email: 'b4@example.test' },
      ],
      USER, RETURN_ROWS
    );
    expect(rows.map(row => row.note)).toEqual(['explicit', 'default note']);
    await seed();
  });

  it('rejects an unknown column in any row of the batch', async () => {
    await expect(
      svc.handlePost('resp_item', [{ id: 'b5' }, { id: 'b6', nope: 1 }], USER, RETURN_ROWS),
    ).rejects.toMatchObject({ statusCode: 400, code: 'PGRST204' });
  });
});

// ── 2.6 upsert ───────────────────────────────────────────────────────────────

describe('upsert', () => {
  it('updates a conflicting row instead of failing', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      { id: 'i1', email: 'a@example.test', label: 'replaced', qty: 99 },
      USER,
      { prefer: MERGE },
    );
    expect(rows).toMatchObject([{ id: 'i1', label: 'replaced', qty: 99 }]);
    await seed();
  });

  it('splits the outbox event: created for new rows, updated for conflicting ones', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      [
        { id: 'i1', email: 'a@example.test', label: 'was there' },
        { id: 'u9', email: 'u9@example.test', label: 'is new' },
      ],
      USER,
      { prefer: MERGE },
    );

    expect(rows.map(row => row.id).sort()).toEqual(['i1', 'u9']);
    const created = outbox.filter(call => call.action === 'created');
    const updated = outbox.filter(call => call.action === 'updated');
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(created[0].rows.map(row => row.id)).toEqual(['u9']);
    expect(updated[0].rows.map(row => row.id)).toEqual(['i1']);
    // The webhook split matches the outbox split, so an external consumer sees
    // the same two events.
    expect(webhooks.map(call => call.action).sort()).toEqual(['created', 'updated']);
    await seed();
  });

  it('never leaves the conflict marker column in the returned rows', async () => {
    const rows = await svc.handlePost('resp_item', { id: 'i2', email: 'b@example.test' }, USER, {
      prefer: MERGE,
    });
    expect(Object.keys(rows[0])).not.toContain('__mb_inserted');
    await seed();
  });

  it('resolves the conflict on ?on_conflict= rather than on the primary key', async () => {
    // Same email as i1 but a different id: with the PK as the target this would
    // be a fresh insert, with `email` it must update i1 in place.
    const rows = await svc.handlePost(
      'resp_item',
      { id: 'i1', email: 'a@example.test', label: 'by email' },
      USER,
      { prefer: MERGE, query: { on_conflict: 'email' } },
    );
    expect(rows).toMatchObject([{ id: 'i1', label: 'by email' }]);
    expect(outbox.map(call => call.action)).toEqual(['updated']);
    await seed();
  });

  it('drops the conflicting row entirely for ignore-duplicates', async () => {
    const rows = await svc.handlePost(
      'resp_item',
      [
        { id: 'i1', email: 'a@example.test', label: 'ignored' },
        { id: 'u8', email: 'u8@example.test', label: 'kept' },
      ],
      USER,
      { prefer: IGNORE },
    );
    expect(rows.map(row => row.id)).toEqual(['u8']);
    expect(outbox.map(call => call.action)).toEqual(['created']);

    const untouched = await svc.handleGet('resp_item', { id: 'eq.i1' }, USER);
    expect(untouched[0].label).toBe('alpha');
    await seed();
  });

  it('validates ?on_conflict= against the catalog', async () => {
    await expect(
      svc.handlePost('resp_item', { id: 'x1' }, USER, { prefer: MERGE, query: { on_conflict: 'nope' } }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'PGRST204' });
  });

  it('still fails a plain insert on a duplicate, because it is not an upsert', async () => {
    await expect(svc.handlePost('resp_item', { id: 'i1', email: 'a@example.test' }, USER, RETURN_ROWS)).rejects.toBeTruthy();
  });
});

// ── 2.11 write paths and realtime ────────────────────────────────────────────

/**
 * Every REST write path enqueues its realtime event inside the same transaction
 * as the write, and the cases above pin that for insert, bulk insert, update,
 * delete, upsert (split into created/updated) and `return=minimal`.
 *
 * A function body is the one write path that cannot: the outbox is an
 * application-level queue, so it only sees rows this service wrote itself, and
 * a `.rpc()` whose body mutates a table is opaque to it. Capturing those would
 * mean reading the WAL, which is a different architecture, and it could not
 * carry the pre-delete audience the delete path depends on either.
 *
 * This is a documented boundary, not a bug, so it is asserted rather than left
 * unknown. If it ever changes, this test fails and the docs have to change with
 * it.
 */
describe('write paths and realtime', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION resp_rpc_writes(new_id text)
        RETURNS integer LANGUAGE sql VOLATILE
      AS $fn$ INSERT INTO resp_item (id, label, qty) VALUES (new_id, 'via rpc', 9) RETURNING qty $fn$
    `);
    await prisma.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION resp_rpc_writes(text) TO anon, authenticated`);
    invalidateCatalog();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS resp_rpc_writes(text)`);
    invalidateCatalog();
  });

  it('emits no realtime event for a write performed inside an rpc function body', async () => {
    const result = await svc.handleRpc('resp_rpc_writes', { new_id: 'r1' }, USER, { method: 'POST' });
    expect(result.rows).toEqual([9]);

    // The row really was written, so the silence below is about visibility to
    // the outbox and not about the call failing.
    const written = await svc.handleGet('resp_item', { id: 'eq.r1' }, USER);
    expect(written).toMatchObject([{ id: 'r1', label: 'via rpc' }]);

    expect(outbox).toEqual([]);
    expect(webhooks).toEqual([]);
    await seed();
  });
});
