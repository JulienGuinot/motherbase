import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { rlsContextFor } from '../lib/rls-claims';

// The Data API roles hold USAGE on auth (for auth.uid()), storage and realtime,
// so a table privilege there is reachable from any SECURITY INVOKER function a
// project writes in `public`. Only the tables below are meant to be: their RLS
// policies are the published contract. Anything else is a leak of the kind
// 20261127100000_lock_down_system_schemas closed (auth.account, auth.session,
// auth.jwks, auth.twoFactor readable by anon).
const REACHABLE = new Set(['storage.files', 'storage.buckets', 'storage.objects', 'realtime.messages']);

describe('system schema privileges', () => {
  it('anon, authenticated and service_role hold no privilege on system tables outside the published ones', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ rel: string; role: string }>>(`
      SELECT n.nspname || '.' || c.relname AS rel, r.role
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
       WHERE n.nspname IN ('auth', 'storage', 'platform', 'realtime')
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       ORDER BY 1, 2`);
    expect(rows.filter(r => !REACHABLE.has(r.rel))).toEqual([]);
  });

  it('every system table has RLS enabled', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ rel: string }>>(`
      SELECT n.nspname || '.' || c.relname AS rel
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('auth', 'storage', 'platform', 'realtime')
         AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
       ORDER BY 1`);
    expect(rows).toEqual([]);
  });

  describe('a SECURITY INVOKER function in public', () => {
    const pool = new RlsPool();
    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.ssp_leak() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM auth.account'`
      );
    });
    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.ssp_leak()`);
      await pool.end();
    });

    for (const [label, user] of [
      ['anon', null],
      ['authenticated', { id: 'ssp-user', role: 'USER' }],
    ] as const) {
      it(`cannot read auth.account as ${label}`, async () => {
        await expect(
          pool.withRlsTx(rlsContextFor(user), c => c.query('SELECT public.ssp_leak()'))
        ).rejects.toThrow(/permission denied/);
      });
    }
  });
});
