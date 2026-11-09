import type { PoolClient } from 'pg';
import { RLS_ROLES } from './rls-claims';

/** Internal bookkeeping only. User-table statements must keep the caller's role. */
export async function withOwnerRole<T>(
  client: Pick<PoolClient, 'query'>,
  work: () => Promise<T>,
): Promise<T> {
  const result = await client.query('SELECT current_user AS "currentRole"');
  const role = String(result.rows[0]?.currentRole ?? '');
  if (!(RLS_ROLES as ReadonlySet<string>).has(role)) throw new Error('Unexpected data-plane role');
  await client.query('RESET ROLE');
  // On failure the enclosing RLS transaction rolls back; do not mask an aborted
  // statement's error with a SET ROLE in an already failed transaction.
  const value = await work();
  await client.query(`SET LOCAL ROLE ${role}`);
  return value;
}
