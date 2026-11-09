import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { invalidateCatalog } from '../services/rest-api/catalog';
import { parsePrefer } from '../services/rest-api/http-semantics';

/**
 * `/rest/v1/rpc/:fn`.
 *
 * The security question this suite exists to answer is `SECURITY DEFINER`. Such
 * a function runs as its owner, and the owner of these tables is not subject to
 * their policies, so publishing one at a public URL would be a complete bypass
 * of row-level security for anyone who can reach the port. `refuses a SECURITY
 * DEFINER function` and `allows a SECURITY DEFINER function once allowlisted`
 * are the two halves of that gate. The `rpc_visible_widgets` cases prove the
 * other half of the item: an invoker function's own body is filtered by the
 * caller's policies, because it executes inside the caller's RlsPool
 * transaction under the caller's role.
 */

const pool = new RlsPool();
const svc = new RestApiService({
  prisma,
  RlsPool: pool,
  RealtimeBroadcastService: {
    broadcast: async () => {},
    captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
  },
  RealtimeOutboxService: { enqueue: async () => {} },
} as any);

const U1 = { id: 'u1', role: 'USER' };
const ANON = undefined;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rpc_widget CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE rpc_widget (id text PRIMARY KEY, owner text, label text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE rpc_widget ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT ON rpc_widget TO anon, authenticated`);
  await prisma.$executeRawUnsafe(
    `CREATE POLICY owner_only ON rpc_widget FOR SELECT TO authenticated USING (auth.uid() = owner)`
  );
  await prisma.$executeRawUnsafe(`INSERT INTO rpc_widget VALUES ('w1','u1','mine'),('w2','u2','theirs')`);

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_add(a integer, b integer) RETURNS integer
    LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_greet(name text DEFAULT 'world') RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT 'hello ' || name $$
  `);
  // SECURITY INVOKER (the default): the body sees exactly what the caller sees.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_visible_widgets() RETURNS SETOF rpc_widget
    LANGUAGE sql STABLE AS $$ SELECT * FROM rpc_widget ORDER BY id $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_widget_count() RETURNS bigint
    LANGUAGE sql STABLE AS $$ SELECT count(*) FROM rpc_widget $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_report(kind text) RETURNS TABLE (id text, label text)
    LANGUAGE sql STABLE AS $$ SELECT id, label FROM rpc_widget WHERE label LIKE '%' || kind || '%' $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_from_json(payload jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE AS $$ SELECT payload ->> 'who' $$
  `);
  // Deliberately VOLATILE, so it must be refused on the read-only GET form.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_touch() RETURNS integer
    LANGUAGE sql VOLATILE AS $$ SELECT 1 $$
  `);
  // The dangerous shape: a definer function that reads past every policy.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION rpc_all_widgets() RETURNS SETOF rpc_widget
    LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT * FROM rpc_widget ORDER BY id $$
  `);
  await prisma.$executeRawUnsafe(`
    GRANT EXECUTE ON FUNCTION rpc_add(integer, integer), rpc_greet(text), rpc_visible_widgets(),
      rpc_widget_count(), rpc_report(text), rpc_from_json(jsonb), rpc_touch(), rpc_all_widgets()
      TO anon, authenticated
  `);

  invalidateCatalog();
});

afterAll(async () => {
  for (const drop of [
    'rpc_add(integer, integer)',
    'rpc_greet(text)',
    'rpc_visible_widgets()',
    'rpc_widget_count()',
    'rpc_report(text)',
    'rpc_from_json(jsonb)',
    'rpc_touch()',
    'rpc_all_widgets()',
  ]) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${drop}`);
  }
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rpc_widget CASCADE`);
  invalidateCatalog();
  await pool.end();
});

afterEach(() => {
  delete process.env.REST_RPC_SECURITY_DEFINER;
});

// ── The security gate ────────────────────────────────────────────────────────

describe('SECURITY DEFINER', () => {
  it('refuses a SECURITY DEFINER function that is not allowlisted', async () => {
    await expect(svc.handleRpc('rpc_all_widgets', {}, U1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PGRST203',
    });
  });

  it('explains why in the refusal, since the reason is not obvious', async () => {
    await expect(svc.handleRpc('rpc_all_widgets', {}, U1)).rejects.toThrow(/bypasses row-level security/);
  });

  it('refuses it for an anonymous caller too', async () => {
    await expect(svc.handleRpc('rpc_all_widgets', {}, ANON)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a SECURITY DEFINER function once an operator allowlists it', async () => {
    process.env.REST_RPC_SECURITY_DEFINER = 'rpc_all_widgets';
    const result = await svc.handleRpc('rpc_all_widgets', {}, U1);
    // Allowlisted means it really does run as its owner and really does see
    // every row, which is exactly why the default is to refuse.
    expect(result.rows.map((row: any) => row.id)).toEqual(['w1', 'w2']);
  });

  // The `api.rest` settings group used to declare only `maxRows`, so the writer's
  // schema stripped `rpcSecurityDefiner` and this branch could never be true.
  // The env var was the only working way to set a security control the UI
  // implied was configurable.
  it('allows one allowlisted from the api.rest settings group, not just the env', async () => {
    const withSetting = (rpcSecurityDefiner: string) =>
      new RestApiService({
        prisma,
        RlsPool: pool,
        SettingsService: { get: async () => ({ maxRows: 1000, rpcSecurityDefiner }) },
        RealtimeBroadcastService: {
          broadcast: async () => {},
          captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
        },
        RealtimeOutboxService: { enqueue: async () => {} },
      } as any);

    const result = await withSetting('rpc_all_widgets').handleRpc('rpc_all_widgets', {}, U1);
    expect(result.rows.map((row: any) => row.id)).toEqual(['w1', 'w2']);

    // And an empty stored value means empty: it must not silently revert to
    // the environment, or the list could never be cleared from Studio.
    process.env.REST_RPC_SECURITY_DEFINER = 'rpc_all_widgets';
    await expect(withSetting('').handleRpc('rpc_all_widgets', {}, U1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PGRST203',
    });
  });
});

// ── RLS applies to an invoker function's body ────────────────────────────────

describe('row-level security inside the function body', () => {
  it('filters a setof return by the calling user policies', async () => {
    const result = await svc.handleRpc('rpc_visible_widgets', {}, U1);
    expect(result.rows.map((row: any) => row.id)).toEqual(['w1']);
    expect(JSON.stringify(result.rows)).not.toContain('theirs');
  });

  it('returns nothing to anon, which has no select policy', async () => {
    const result = await svc.handleRpc('rpc_visible_widgets', {}, ANON);
    expect(result.rows).toEqual([]);
  });

  it('applies the same filtering to an aggregate computed inside the function', async () => {
    // node-pg renders int8 as a string; `lib/pg-int8` installs a parser that
    // turns it back into a number inside the safe-integer range, so this API
    // agrees with supabase-js and with `lib/json-bigint` on the Prisma side.
    // A count is never outside that range, so it arrives as a number.
    expect((await svc.handleRpc('rpc_widget_count', {}, U1)).rows).toEqual([1]);
    expect((await svc.handleRpc('rpc_widget_count', {}, ANON)).rows).toEqual([0]);
  });
});

// ── Return shapes and arguments ──────────────────────────────────────────────

describe('calling convention', () => {
  it('calls with named arguments and returns a scalar', async () => {
    const result = await svc.handleRpc('rpc_add', { a: 2, b: 3 }, U1);
    expect(result).toMatchObject({ rows: [5], single: true, scalar: true });
  });

  it('binds arguments rather than splicing them', async () => {
    const result = await svc.handleRpc('rpc_greet', { name: "'); DROP TABLE rpc_widget; --" }, U1);
    expect(result.rows[0]).toBe("hello '); DROP TABLE rpc_widget; --");
    // The table is still there, which is the actual assertion.
    expect((await svc.handleGet('rpc_widget', {}, U1)).length).toBe(1);
  });

  it('omits an argument that carries a default', async () => {
    expect((await svc.handleRpc('rpc_greet', {}, U1)).rows).toEqual(['hello world']);
  });

  it('returns a table-returning function as rows', async () => {
    const result = await svc.handleRpc('rpc_report', { kind: 'mine' }, U1);
    expect(result.rows).toEqual([{ id: 'w1', label: 'mine' }]);
    expect(result.single).toBe(false);
  });

  it('serialises a json argument rather than sending a record literal', async () => {
    const result = await svc.handleRpc('rpc_from_json', { payload: { who: 'ada' } }, U1);
    expect(result.rows).toEqual(['ada']);
  });

  it('accepts a whole body as one json argument for params=single-object', async () => {
    const result = await svc.handleRpc('rpc_from_json', { who: 'grace' }, U1, {
      prefer: parsePrefer('params=single-object'),
    });
    expect(result.rows).toEqual(['grace']);
  });

  it('rejects an unknown function with PGRST202', async () => {
    await expect(svc.handleRpc('rpc_missing', {}, U1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PGRST202',
    });
  });

  it('rejects an argument name the function does not declare', async () => {
    await expect(svc.handleRpc('rpc_add', { a: 1, nope: 2 }, U1)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PGRST202',
    });
  });

  it('rejects a call that omits a required argument', async () => {
    await expect(svc.handleRpc('rpc_add', { a: 1 }, U1)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('allows a stable function on the read-only GET form', async () => {
    const result = await svc.handleRpc('rpc_greet', { name: 'get' }, U1, { method: 'GET' });
    expect(result.rows).toEqual(['hello get']);
  });

  it('refuses a volatile function on GET, because a read verb must not write', async () => {
    await expect(svc.handleRpc('rpc_touch', {}, U1, { method: 'GET' })).rejects.toMatchObject({
      statusCode: 405,
    });
    // The same function is fine over POST.
    expect((await svc.handleRpc('rpc_touch', {}, U1, { method: 'POST' })).rows).toEqual([1]);
  });

  it('does not expose a function outside the public schema', async () => {
    // `auth.uid()` exists and is reachable from SQL, but not through /rpc/.
    await expect(svc.handleRpc('uid', {}, U1)).rejects.toMatchObject({ statusCode: 404 });
  });
});
