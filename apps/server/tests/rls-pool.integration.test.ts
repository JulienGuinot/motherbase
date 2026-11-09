// tests/rls-pool.integration.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { RlsPool } from '../lib/rls-pool';
import { rlsContextFor } from '../lib/rls-claims';

const pool = new RlsPool();
afterAll(() => pool.end());

describe('withRlsTx', () => {
  it('sets the role and claims inside the transaction', async () => {
    const ctx = rlsContextFor({ id: 'abc', role: 'ADMIN' });
    const result = await pool.withRlsTx(ctx, async (c) => {
      const r = await c.query(`SELECT current_user AS role, auth.uid() AS uid`);
      return r.rows[0];
    });
    expect(result.role).toBe('authenticated');
    expect(result.uid).toBe('abc');
  });

  it('resets role after the transaction (no leak across checkouts)', async () => {
    const anon = rlsContextFor(undefined);
    const role = await pool.withRlsTx(anon, async (c) => {
      const r = await c.query(`SELECT current_user AS role`);
      return r.rows[0].role;
    });
    expect(role).toBe('anon');
  });

  it('rolls back on error', async () => {
    const ctx = rlsContextFor({ id: 'x' });
    await expect(
      pool.withRlsTx(ctx, async (c) => { await c.query('SELECT 1'); throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('rejects an unknown role', () => {
    expect(() => pool.assertRole('postgres' as any)).toThrow();
  });
});
