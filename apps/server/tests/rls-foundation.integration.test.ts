import { describe, it, expect } from 'vitest';
import prisma from '../lib/prisma';

describe('rls foundation migration', () => {
  it('creates anon and authenticated roles', async () => {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') ORDER BY rolname`
    );
    expect(rows.map(r => r.rolname)).toEqual(['anon', 'authenticated']);
  });

  it('exposes auth.uid()/auth.role() reading request.jwt.claims', async () => {
    const [row] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT set_config('request.jwt.claims', $1, true) AS _set, auth.uid() AS uid, auth.role() AS role`,
      JSON.stringify({ sub: 'user-123', role: 'authenticated' })
    );
    expect(row.uid).toBe('user-123');
    expect(row.role).toBe('authenticated');
  });

  it('dropped the api_policies table', async () => {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT to_regclass('public.api_policies')::text AS t`
    );
    expect(rows[0].t).toBeNull();
  });
});
