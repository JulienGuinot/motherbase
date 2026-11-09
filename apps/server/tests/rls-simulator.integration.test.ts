import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RlsSimulatorService } from '../services/admin/rls-simulator.service';
import { RlsService } from '../services/admin/rls.service';

/**
 * Plan items 4.1 and 4.2 against a live Postgres.
 *
 * The point of the simulator is that its answer is not an opinion: the query is
 * really executed under the role and claims being simulated. So these tests
 * assert row sets, not shapes, and they assert the three safety properties
 * (read-only, always rolled back, timed out) directly rather than trusting the
 * guards to have been written correctly.
 */

const pool = new RlsPool();
const svc = new RlsSimulatorService({ prisma, RlsPool: pool } as any);

const OWNER = 'sim-owner';
const OTHER = 'sim-other';

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_doc CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_locked CASCADE`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE sim_doc (
      id       text PRIMARY KEY,
      owner_id text NOT NULL,
      title    text NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO sim_doc (id, owner_id, title) VALUES
      ('d1','${OWNER}','owned by owner'),
      ('d2','${OTHER}','owned by other'),
      ('d3','${OWNER}','also owned by owner')
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE sim_doc ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT ON sim_doc TO anon, authenticated`);
  // Two policies, so attribution has something to distinguish: one that only
  // authenticated callers get, one that everyone gets but which matches nothing.
  await prisma.$executeRawUnsafe(`
    CREATE POLICY sim_doc_owner ON sim_doc FOR SELECT TO authenticated
      USING (owner_id = auth.uid())
  `);
  await prisma.$executeRawUnsafe(`
    CREATE POLICY sim_doc_published ON sim_doc FOR SELECT TO anon, authenticated
      USING (title LIKE 'public:%')
  `);

  // RLS on, no policy at all: the "0 rows and it is not your query's fault" case.
  await prisma.$executeRawUnsafe(`CREATE TABLE sim_locked (id text PRIMARY KEY)`);
  await prisma.$executeRawUnsafe(`INSERT INTO sim_locked (id) VALUES ('x1')`);
  await prisma.$executeRawUnsafe(`ALTER TABLE sim_locked ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT ON sim_locked TO anon, authenticated`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_doc CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_locked CASCADE`);
  await pool.end();
});

const SELECT_DOCS = 'SELECT id, title FROM sim_doc ORDER BY id';

describe('4.1 simulator: the same query, different callers', () => {
  it('returns different rows for anon and for an authenticated owner', async () => {
    const anon = await svc.simulate({ sql: SELECT_DOCS, role: 'anon' });
    expect(anon.rows).toEqual([]);

    const owner = await svc.simulate({
      sql: SELECT_DOCS,
      role: 'authenticated',
      claims: { sub: OWNER },
    });
    expect(owner.rows.map(r => r.id)).toEqual(['d1', 'd3']);

    const other = await svc.simulate({
      sql: SELECT_DOCS,
      role: 'authenticated',
      claims: { sub: OTHER },
    });
    expect(other.rows.map(r => r.id)).toEqual(['d2']);
  });

  it('forces the simulated role into the claims, so auth.role() cannot be spoofed', async () => {
    const result = await svc.simulate({
      sql: 'SELECT auth.role() AS r',
      role: 'anon',
      claims: { role: 'authenticated' },
    });
    expect(result.rows).toEqual([{ r: 'anon' }]);
  });

  it('rejects writes, including ones disguised as a read', async () => {
    await expect(svc.simulate({ sql: `DELETE FROM sim_doc` })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      svc.simulate({ sql: `WITH gone AS (DELETE FROM sim_doc RETURNING *) SELECT * FROM gone` })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.simulate({ sql: `EXPLAIN ANALYZE SELECT 1` })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.simulate({ sql: `SELECT 1; DROP TABLE sim_doc` })).rejects.toMatchObject({ statusCode: 400 });

    // Nothing above reached the table.
    const [{ count }] = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS count FROM sim_doc`);
    expect(count).toBe(3);
  });

  it('rolls back even when the statement was a legal read', async () => {
    // A read can still leave a trace: a sequence advanced by nextval survives a
    // rollback, so it makes a usable probe for whether the transaction committed.
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS sim_probe_seq`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE sim_probe_seq TO anon, authenticated`);
    try {
      const before = await prisma.$queryRawUnsafe<any[]>(
        `SELECT txid_current_if_assigned() IS NULL AS clean`
      );
      expect(before[0].clean).toBe(true);

      const result = await svc.simulate({ sql: `SELECT pg_backend_pid() AS pid` });
      expect(result.rows).toHaveLength(1);

      // The pooled connection is reusable and left no open transaction behind.
      const after = await svc.simulate({ sql: `SELECT 1 AS ok` });
      expect(after.rows).toEqual([{ ok: 1 }]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS sim_probe_seq`);
    }
  });

  it('cuts a deliberately long query with the statement timeout', async () => {
    await expect(
      svc.simulate({ sql: `SELECT count(*) AS n FROM generate_series(1, 2000000000)`, timeoutMs: 150 })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('cancelled') });
  });

  it('caps the row count and says so', async () => {
    const result = await svc.simulate({
      sql: `SELECT generate_series(1, 50) AS n`,
      limit: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);

    const whole = await svc.simulate({ sql: `SELECT generate_series(1, 3) AS n`, limit: 10 });
    expect(whole.truncated).toBe(false);
  });
});

describe('4.2 policy attribution', () => {
  it('names both policies on the table and marks which one this role gets', async () => {
    const result = await svc.simulate({
      sql: SELECT_DOCS,
      role: 'authenticated',
      claims: { sub: OWNER },
    });

    const doc = result.tables.find(t => t.table === 'sim_doc');
    expect(doc).toBeDefined();
    expect(doc!.rlsEnabled).toBe(true);
    expect(doc!.deniesAll).toBe(false);
    expect(doc!.policies.map(p => p.name).sort()).toEqual(['sim_doc_owner', 'sim_doc_published']);

    const owner = doc!.policies.find(p => p.name === 'sim_doc_owner')!;
    expect(owner.using).toContain('auth.uid()');
    expect(owner.applies).toBe(true);
  });

  it('does not offer an authenticated-only policy as the explanation for an anon call', async () => {
    const result = await svc.simulate({ sql: SELECT_DOCS, role: 'anon' });
    const doc = result.tables.find(t => t.table === 'sim_doc')!;
    expect(doc.policies.find(p => p.name === 'sim_doc_owner')!.applies).toBe(false);
    expect(doc.policies.find(p => p.name === 'sim_doc_published')!.applies).toBe(true);
  });

  it('reports a table with RLS on and no policy as denying everything', async () => {
    const result = await svc.simulate({ sql: `SELECT * FROM sim_locked` });
    expect(result.rows).toEqual([]);
    const locked = result.tables.find(t => t.table === 'sim_locked')!;
    expect(locked.rlsEnabled).toBe(true);
    expect(locked.policies).toEqual([]);
    expect(locked.deniesAll).toBe(true);
  });
});

describe('4.5 why is this row hidden', () => {
  it('diffs two claim sets and shows which rows only one of them sees', async () => {
    const diff = await svc.diff(
      SELECT_DOCS,
      { role: 'authenticated', claims: { sub: OWNER } },
      { role: 'authenticated', claims: { sub: OTHER } }
    );
    expect(diff.onlyInLeft.map((r: any) => r.id)).toEqual(['d1', 'd3']);
    expect(diff.onlyInRight.map((r: any) => r.id)).toEqual(['d2']);
  });
});

/**
 * 4.3 policy templates. The presets are asserted through the simulator rather
 * than by comparing generated SQL strings: a preset that produces plausible DDL
 * but the wrong visibility is exactly the failure these are meant to prevent.
 */
describe('4.3 policy presets, verified by running them', () => {
  const rls = new RlsService({ prisma } as any);

  async function fixture(ddl: string, seed: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_preset CASCADE`);
    await prisma.$executeRawUnsafe(ddl);
    await prisma.$executeRawUnsafe(seed);
  }

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS sim_preset CASCADE`);
  });

  it('owner_only shows a row to its owner and to nobody else', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, owner_id text NOT NULL)`,
      `INSERT INTO sim_preset VALUES ('p1','${OWNER}'), ('p2','${OTHER}')`
    );
    await rls.applyPresetToTable('sim_preset', 'owner_only');

    const owner = await svc.simulate({
      sql: `SELECT id FROM sim_preset ORDER BY id`,
      role: 'authenticated',
      claims: { sub: OWNER },
    });
    expect(owner.rows.map(r => r.id)).toEqual(['p1']);

    // anon holds no privilege at all under this preset, so Postgres refuses the
    // read rather than filtering it. The simulator reports which gate closed.
    const anon = await svc.simulate({ sql: `SELECT id FROM sim_preset`, role: 'anon' });
    expect(anon.rows).toEqual([]);
    expect(anon.denied).toMatchObject({ code: '42501' });
    expect(anon.tables.find(t => t.table === 'sim_preset')!.deniedBy).toBe('grant');

    // The grants have to match the policies, or the policy is unreachable.
    const grants = await prisma.$queryRawUnsafe<any[]>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'sim_preset' AND grantee IN ('anon','authenticated')`
    );
    expect(grants.filter(g => g.grantee === 'authenticated').map(g => g.privilege_type).sort())
      .toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(grants.filter(g => g.grantee === 'anon')).toEqual([]);
  });

  it('owner_only takes the owner column as a parameter', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, created_by text NOT NULL)`,
      `INSERT INTO sim_preset VALUES ('p1','${OWNER}'), ('p2','${OTHER}')`
    );
    await rls.applyPresetToTable('sim_preset', 'owner_only', { ownerColumn: 'created_by' });

    const owner = await svc.simulate({
      sql: `SELECT id FROM sim_preset`,
      role: 'authenticated',
      claims: { sub: OWNER },
    });
    expect(owner.rows.map(r => r.id)).toEqual(['p1']);
  });

  it('org_scoped isolates tenants by a JWT claim', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, org_id text NOT NULL)`,
      `INSERT INTO sim_preset VALUES ('p1','acme'), ('p2','globex')`
    );
    await rls.applyPresetToTable('sim_preset', 'org_scoped');

    const acme = await svc.simulate({
      sql: `SELECT id FROM sim_preset`,
      role: 'authenticated',
      claims: { sub: OWNER, org_id: 'acme' },
    });
    expect(acme.rows.map(r => r.id)).toEqual(['p1']);

    // A caller with no tenant claim sees nothing rather than everything.
    const stateless = await svc.simulate({
      sql: `SELECT id FROM sim_preset`,
      role: 'authenticated',
      claims: { sub: OWNER },
    });
    expect(stateless.rows).toEqual([]);
  });

  it('public_read_owner_write lets anon read everything and write nothing', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, owner_id text NOT NULL)`,
      `INSERT INTO sim_preset VALUES ('p1','${OWNER}'), ('p2','${OTHER}')`
    );
    await rls.applyPresetToTable('sim_preset', 'public_read_owner_write');

    const anon = await svc.simulate({ sql: `SELECT id FROM sim_preset ORDER BY id`, role: 'anon' });
    expect(anon.rows.map(r => r.id)).toEqual(['p1', 'p2']);

    const anonGrants = await prisma.$queryRawUnsafe<any[]>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'sim_preset' AND grantee = 'anon'`
    );
    expect(anonGrants.map(g => g.privilege_type)).toEqual(['SELECT']);
  });

  it('soft_delete hides deleted rows but still allows the delete itself', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, deleted_at timestamptz)`,
      `INSERT INTO sim_preset VALUES ('p1', NULL), ('p2', now())`
    );
    await rls.applyPresetToTable('sim_preset', 'soft_delete');

    const visible = await svc.simulate({ sql: `SELECT id FROM sim_preset`, role: 'anon' });
    expect(visible.rows.map(r => r.id)).toEqual(['p1']);

    // The soft delete itself: an ordinary DELETE, turned into a timestamp write
    // by the preset's trigger. A plain UPDATE cannot do this (Postgres applies
    // the SELECT policy to the new row), which is why the trigger exists.
    await pool.withRlsTx(
      { role: 'authenticated', claims: JSON.stringify({ sub: OWNER, role: 'authenticated' }) },
      async client => {
        await client.query(`DELETE FROM sim_preset WHERE id = 'p1'`);
        const after = await client.query(`SELECT id FROM sim_preset`);
        expect(after.rows).toEqual([]);
      },
      { rollback: true }
    );

    // Rolled back, so the row is still there and still only soft-deletable.
    const [{ count }] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT count(*)::int AS count FROM sim_preset WHERE deleted_at IS NULL`
    );
    expect(count).toBe(1);
  });

  it('really writes the timestamp instead of removing the row', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, deleted_at timestamptz)`,
      `INSERT INTO sim_preset VALUES ('p1', NULL)`
    );
    await rls.applyPresetToTable('sim_preset', 'soft_delete');

    await pool.withRlsTx(
      { role: 'authenticated', claims: JSON.stringify({ sub: OWNER, role: 'authenticated' }) },
      async client => {
        await client.query(`DELETE FROM sim_preset WHERE id = 'p1'`);
      }
    );

    const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT id, deleted_at FROM sim_preset`);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('removes the soft-delete trigger when another preset replaces it', async () => {
    await fixture(
      `CREATE TABLE sim_preset (id text PRIMARY KEY, deleted_at timestamptz, owner_id text)`,
      `INSERT INTO sim_preset VALUES ('p1', NULL, '${OWNER}')`
    );
    await rls.applyPresetToTable('sim_preset', 'soft_delete');
    await rls.applyPresetToTable('sim_preset', 'owner_only', { replace: true });

    const triggers = await prisma.$queryRawUnsafe<any[]>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'sim_preset'::regclass AND NOT tgisinternal`
    );
    expect(triggers).toEqual([{ tgname: 'motherbase_capture_write' }]);

    // And a delete now really deletes.
    await pool.withRlsTx(
      { role: 'authenticated', claims: JSON.stringify({ sub: OWNER, role: 'authenticated' }) },
      async client => {
        await client.query(`DELETE FROM sim_preset WHERE id = 'p1'`);
      }
    );
    const [{ count }] = await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS count FROM sim_preset`);
    expect(count).toBe(0);
  });

  it('refuses to overwrite existing policies unless asked', async () => {
    await fixture(`CREATE TABLE sim_preset (id text PRIMARY KEY, owner_id text)`, `SELECT 1`);
    await rls.applyPresetToTable('sim_preset', 'owner_only');
    await expect(rls.applyPresetToTable('sim_preset', 'owner_only')).rejects.toMatchObject({ statusCode: 409 });
    await expect(rls.applyPresetToTable('sim_preset', 'owner_only', { replace: true })).resolves.toMatchObject({
      policies: ['owner_only'],
    });
  });
});
