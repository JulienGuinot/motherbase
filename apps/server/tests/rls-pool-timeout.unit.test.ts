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

describe('RlsPool rlsGate', () => {
  const ctx = { role: 'anon' as const, claims: '{}' };

  function poolAnswering(rlsEnabled: string[]) {
    const queries: Array<[string, unknown[]?]> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push([sql, params]);
        return { rows: sql.includes('set_config') ? [{ rlsEnabled }] : [] };
      },
      release() {},
    };
    const pool = new RlsPool();
    (pool as unknown as { pool: unknown }).pool = { connect: async () => client };
    return { pool, queries };
  }

  it('asks the gate on the statement that sets the request context, not on one of its own', async () => {
    const { pool, queries } = poolAnswering(['notes']);
    const seen = await pool.withRlsTx(ctx, async (_client, rlsEnabled) => [...rlsEnabled], { rlsGate: ['notes', 'drafts'] });

    expect(seen).toEqual(['notes']);
    expect(queries.map(([sql]) => sql.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
    expect(queries[1][0]).toContain('c.relrowsecurity');
    expect(queries[1][1]?.[3]).toEqual(['notes', 'drafts']);
  });

  it('reports nothing enabled, and reads no catalog, when no gate was asked', async () => {
    const { pool, queries } = poolAnswering(['notes']);
    // The fake answers "notes" to anything; without a gate nothing is trusted.
    const seen = await pool.withRlsTx(ctx, async (_client, rlsEnabled) => rlsEnabled.size);

    expect(queries[1][0]).not.toContain('relrowsecurity');
    expect(queries[1][1]).toHaveLength(3);
    expect(seen).toBe(0);
  });
});
