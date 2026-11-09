import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { rlsContextFor } from '../lib/rls-claims';
import { RlsService } from '../services/admin/rls.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Unique table names per concern, full teardown. RLS enabled + grants so the
// non-owner roles can reach rows that policies permit.

async function makeTable(name: string) {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE TABLE ${name} (id text PRIMARY KEY, user_id text, label text)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${name} TO anon, authenticated`);
}

describe('RLS security hardening', () => {
  const pool = new RlsPool();
  afterAll(() => pool.end());

  // ── 1. Admin-role bypass via the ADMIN JWT claim (not BYPASSRLS) ─────────────
  describe('admin-role bypass', () => {
    const T = 'rls_hard_admin';
    beforeAll(async () => {
      await makeTable(T);
      await prisma.$executeRawUnsafe(
        `CREATE POLICY owner_sel ON ${T} FOR SELECT TO authenticated USING (auth.uid() = user_id)`
      );
      await prisma.$executeRawUnsafe(
        `CREATE POLICY admin_sel ON ${T} FOR SELECT TO authenticated USING (auth.jwt() ->> 'user_role' = 'ADMIN')`
      );
      await prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES ('a1','u1','x'),('a2','u2','y'),('a3','u3','z')`);
    });
    afterAll(() => prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T} CASCADE`));

    it('an ADMIN sees rows owned by other users', async () => {
      const ids = await pool.withRlsTx(rlsContextFor({ id: 'admin1', role: 'ADMIN' }), async (c) => {
        const r = await c.query(`SELECT id FROM ${T} ORDER BY id`);
        return r.rows.map((x: any) => x.id);
      });
      expect(ids).toEqual(['a1', 'a2', 'a3']);
    });

    it('a non-admin authenticated user only sees their own row', async () => {
      const ids = await pool.withRlsTx(rlsContextFor({ id: 'u2', role: 'USER' }), async (c) => {
        const r = await c.query(`SELECT id FROM ${T} ORDER BY id`);
        return r.rows.map((x: any) => x.id);
      });
      expect(ids).toEqual(['a2']);
    });
  });

  // ── 2. DDL identifier injection is rejected by ident() ───────────────────────
  describe('DDL injection rejection', () => {
    const T = 'rls_hard_inject';
    const EVIL = 'x"; DROP TABLE secret; --';
    const svc = new RlsService({ prisma } as any);

    beforeAll(async () => {
      await makeTable(T);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_hard_secret CASCADE`);
      await prisma.$executeRawUnsafe(`CREATE TABLE rls_hard_secret (id text PRIMARY KEY)`);
      await prisma.$executeRawUnsafe(`INSERT INTO rls_hard_secret VALUES ('s1')`);
    });
    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T} CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rls_hard_secret CASCADE`);
    });

    it('setRls rejects a malicious table name (HttpException 400)', async () => {
      await expect(svc.setRls(EVIL, true)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('createPolicy rejects a malicious table name', async () => {
      await expect(
        svc.createPolicy({ table: EVIL, name: 'p', command: 'SELECT', role: 'anon' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('createPolicy rejects a malicious policy name', async () => {
      await expect(
        svc.createPolicy({ table: T, name: EVIL, command: 'SELECT', role: 'anon' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('dropPolicy rejects a malicious identifier', async () => {
      await expect(svc.dropPolicy(EVIL, 'p')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('did no damage: the secret table and its row still exist', async () => {
      const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::int AS n FROM rls_hard_secret`);
      expect(Number(r[0].n)).toBe(1);
    });
  });

  // ── 3. SET LOCAL ROLE does not leak across pooled connection checkouts ───────
  describe('role reset across pooled connections', () => {
    const T = 'rls_hard_reset';
    // Single small pool so connections are reused between tx1 and tx2.
    const small = new RlsPool();
    beforeAll(async () => {
      await makeTable(T);
      await prisma.$executeRawUnsafe(
        `CREATE POLICY owner_sel ON ${T} FOR SELECT TO authenticated USING (auth.uid() = user_id)`
      );
      // No anon SELECT policy → anon must see nothing.
      await prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES ('r1','u1','x')`);
    });
    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T} CASCADE`);
      await small.end();
    });

    it('an authenticated tx then an anon tx does not leak the role', async () => {
      for (let i = 0; i < 5; i++) {
        const authedRole = await small.withRlsTx(rlsContextFor({ id: 'u1', role: 'USER' }), async (c) => {
          const role = (await c.query(`SELECT current_user AS r`)).rows[0].r;
          const rows = await c.query(`SELECT id FROM ${T}`);
          expect(rows.rows.map((x: any) => x.id)).toEqual(['r1']);
          return role;
        });
        expect(authedRole).toBe('authenticated');

        const anonRole = await small.withRlsTx(rlsContextFor(undefined), async (c) => {
          const role = (await c.query(`SELECT current_user AS r`)).rows[0].r;
          const rows = await c.query(`SELECT id FROM ${T}`);
          // anon has no SELECT policy → zero rows; proves the prior role did not leak.
          expect(rows.rows).toEqual([]);
          return role;
        });
        expect(anonRole).toBe('anon');
      }
    });
  });

  // ── 4. WITH CHECK on UPDATE prevents moving a row out of ownership ───────────
  describe('WITH CHECK on UPDATE', () => {
    const T = 'rls_hard_check';
    beforeAll(async () => {
      await makeTable(T);
      await prisma.$executeRawUnsafe(
        `CREATE POLICY owner_upd ON ${T} FOR UPDATE TO authenticated
           USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`
      );
      await prisma.$executeRawUnsafe(
        `CREATE POLICY owner_sel ON ${T} FOR SELECT TO authenticated USING (auth.uid() = user_id)`
      );
      await prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES ('c1','u1','before')`);
    });
    afterAll(() => prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${T} CASCADE`));

    it('rejects an UPDATE that reassigns the row to another owner', async () => {
      await expect(
        pool.withRlsTx(rlsContextFor({ id: 'u1', role: 'USER' }), async (c) => {
          await c.query(`UPDATE ${T} SET user_id = 'u2' WHERE id = 'c1'`);
        })
      ).rejects.toBeTruthy(); // Postgres raises "new row violates row-level security policy".
    });

    it('the row was NOT reassigned (still owned by u1)', async () => {
      const r = await prisma.$queryRawUnsafe<{ user_id: string }[]>(
        `SELECT user_id FROM ${T} WHERE id = 'c1'`
      );
      expect(r[0].user_id).toBe('u1');
    });
  });
});
