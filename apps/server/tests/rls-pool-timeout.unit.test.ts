import { describe, it, expect } from 'vitest';
import { RlsPool, DEFAULT_STATEMENT_TIMEOUT_MS } from '../lib/rls-pool';

function poolWithFakeClient() {
  const queries: Array<[string, unknown[]?]> = [];
  const client = { query: async (sql: string, params?: unknown[]) => { queries.push([sql, params]); return { rows: [] }; }, release() {} };
  const pool = new RlsPool();
  (pool as unknown as { pool: unknown }).pool = { connect: async () => client };
  return { pool, queries };
}

describe('RlsPool statement timeout', () => {
  const ctx = { role: 'anon' as const, claims: '{}' };
  const timeoutOf = (queries: Array<[string, unknown[]?]>) =>
    queries.find(([sql]) => sql.includes("'statement_timeout'"))?.[1]?.[2];

  it('caps every transaction, so a public key cannot hold a connection indefinitely', async () => {
    const { pool, queries } = poolWithFakeClient();
    await pool.withRlsTx(ctx, async () => undefined);
    expect(timeoutOf(queries)).toBe(String(DEFAULT_STATEMENT_TIMEOUT_MS));
  });

  it('lets a caller ask for a tighter ceiling', async () => {
    const { pool, queries } = poolWithFakeClient();
    await pool.withRlsTx(ctx, async () => undefined, { statementTimeoutMs: 150 });
    expect(timeoutOf(queries)).toBe('150');
  });

  it('opens a READ ONLY transaction on request, so sequences cannot be advanced behind a rollback', async () => {
    const { pool, queries } = poolWithFakeClient();
    await pool.withRlsTx(ctx, async () => undefined, { readOnly: true, rollback: true });
    expect(queries[0][0]).toBe('BEGIN READ ONLY');
    expect(queries.at(-1)![0]).toBe('ROLLBACK');
  });
});
