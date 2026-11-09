import { describe, it, expect } from 'vitest';
import { StoragePolicyService, type StorageObjectRef } from '../services/storage/storage-policy.service';

// Storage authorization moving from a hardcoded rule to PostgreSQL policies.
// The Postgres side is proven by the migration and the integration suite; what
// these pin is the decision layer: who is asked, what a refusal looks like, and
// that a real failure is never reported as a denial.

const OBJECT: StorageObjectRef = { id: 'f1', key: 'avatars/u1/me.png', bucketId: 'b1', ownerId: 'u1' };

/**
 * Stand-in for RlsPool. `rows` is what the SELECT finds; `insertError` is thrown
 * by the INSERT path so the WITH CHECK behaviour can be driven.
 */
function poolWith({ rows = [] as unknown[], insertError = null as unknown } = {}) {
  const seen: { role?: string; claims?: unknown; options?: any; sql: string[] } = { sql: [] };
  return {
    seen,
    async withRlsTx(ctx: any, fn: any, options: any) {
      seen.role = ctx.role;
      seen.claims = JSON.parse(ctx.claims);
      seen.options = options;
      const client = {
        query: async (sql: string) => {
          seen.sql.push(sql);
          if (/^\s*INSERT/i.test(sql)) {
            if (insertError) throw insertError;
            return { rows: [] };
          }
          return { rows, rowCount: rows.length };
        },
      };
      return fn(client);
    },
  } as any;
}

const service = (pool: any, enabled = true) =>
  new StoragePolicyService({
    RlsPool: pool,
    SettingsService: { get: async () => ({ enabled }) },
  } as any);

describe('StoragePolicyService.enabled', () => {
  it('is off when the settings group says so', async () => {
    expect(await service(poolWith(), false).enabled()).toBe(false);
  });

  it('does not silently disable policies when settings cannot be read', async () => {
    const svc = new StoragePolicyService({
      RlsPool: poolWith(),
      SettingsService: { get: async () => { throw new Error('db down'); } },
    } as any);
    await expect(svc.enabled()).rejects.toThrow('db down');
  });
});

describe('StoragePolicyService.canRead', () => {
  it('asks Postgres under the caller role and honours the answer', async () => {
    const visible = poolWith({ rows: [{ '?column?': 1 }] });
    expect(await service(visible).canRead(OBJECT, { id: 'u1' })).toBe(true);
    expect(visible.seen.role).toBe('authenticated');
    expect(visible.seen.claims).toMatchObject({ sub: 'u1', role: 'authenticated' });

    const hidden = poolWith({ rows: [] });
    expect(await service(hidden).canRead(OBJECT, { id: 'u2' })).toBe(false);
  });

  it('runs an anonymous caller as anon', async () => {
    const pool = poolWith({ rows: [] });
    await service(pool).canRead(OBJECT);
    expect(pool.seen.role).toBe('anon');
  });

  it('short-circuits service_role without a round trip', async () => {
    const pool = poolWith({ rows: [] });
    // BYPASSRLS would answer yes anyway; skipping saves the query on the path
    // trusted server code uses most.
    expect(await service(pool).canRead(OBJECT, { serviceRole: true })).toBe(true);
    expect(pool.seen.sql).toHaveLength(0);
  });

  it('always rolls back, and caps the statement', async () => {
    const pool = poolWith({ rows: [] });
    await service(pool).canRead(OBJECT, { id: 'u1' });
    expect(pool.seen.options).toMatchObject({ rollback: true });
    expect(pool.seen.options.statementTimeoutMs).toBeGreaterThan(0);
  });
});

describe('StoragePolicyService.canWrite', () => {
  it('checks insert by attempting the row and rolling it back', async () => {
    const pool = poolWith();
    expect(await service(pool).canWrite('insert', OBJECT, { id: 'u1' })).toBe(true);
    expect(pool.seen.sql.some((s: string) => /INSERT INTO storage\.files/.test(s))).toBe(true);
    expect(pool.seen.options).toMatchObject({ rollback: true });
  });

  it('reads a policy violation as a denial', async () => {
    const violation = Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
    expect(await service(poolWith({ insertError: violation })).canWrite('insert', OBJECT, { id: 'u1' })).toBe(false);
  });

  it('re-throws a real failure instead of reporting it as denied', async () => {
    // A broken migration must surface as a 500, not hide behind a 403 that sends
    // the operator looking at their policies.
    const broken = Object.assign(new Error('relation storage.files does not exist'), { code: '42P01' });
    await expect(service(poolWith({ insertError: broken })).canWrite('insert', OBJECT, { id: 'u1' })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('executes UPDATE and DELETE under RLS instead of inferring write rights from SELECT', async () => {
    const hidden = poolWith({ rows: [] });
    expect(await service(hidden).canWrite('delete', OBJECT, { id: 'u2' })).toBe(false);
    expect(hidden.seen.sql).toEqual([expect.stringMatching(/^DELETE FROM storage\.files/)]);

    const visible = poolWith({ rows: [{ '?column?': 1 }] });
    expect(await service(visible).canWrite('update', OBJECT, { id: 'u1' })).toBe(true);
    expect(visible.seen.sql).toEqual([expect.stringMatching(/^UPDATE storage\.files/)]);
    expect(visible.seen.options).toMatchObject({ rollback: true });
  });

  it('short-circuits service_role for writes too', async () => {
    const pool = poolWith();
    expect(await service(pool).canWrite('delete', OBJECT, { serviceRole: true })).toBe(true);
    expect(pool.seen.sql).toHaveLength(0);
  });
});

describe('parameterisation', () => {
  it('never interpolates the key into SQL', async () => {
    const pool = poolWith({ rows: [] });
    const nasty: StorageObjectRef = { key: "x'; DROP TABLE storage.files; --" };
    await service(pool).canRead(nasty, { id: 'u1' });
    for (const sql of pool.seen.sql) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toMatch(/\$\d/);
    }
  });
});
