import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResult } from 'pg';
import { withOwnerRole } from '../../lib/with-owner-role';

export interface CapturedChange {
  action: 'created' | 'updated' | 'deleted';
  row: Record<string, unknown>;
}

/**
 * Capture database-trigger row images for internal events, independently of
 * RETURNING. The mutation itself ALWAYS runs as the caller, with native RLS.
 * Both the capture buffer and outbox share that transaction and its rollback.
 */
export async function captureWrite(
  client: PoolClient,
  relation: string,
  write: () => Promise<QueryResult>,
): Promise<{ response: QueryResult; changes: CapturedChange[] }> {
  const id = randomUUID();
  await withOwnerRole(client, async () => {
    const trigger = await client.query(
      `SELECT 1 FROM pg_trigger
       WHERE tgrelid = $1::regclass AND tgname = 'motherbase_capture_write'
         AND tgfoid = 'platform.capture_rest_write()'::regprocedure
         AND tgenabled IN ('O', 'A')`,
      [relation],
    );
    if (!trigger.rowCount) throw new Error(`Missing REST write capture trigger on ${relation}`);
    await client.query(
      `INSERT INTO platform.rest_write_requests (id, backend, transaction, relation)
       VALUES ($1, pg_backend_pid(), txid_current(), $2::regclass::oid::bigint)`,
      [id, relation],
    );
  });

  const response = await write();
  const changes = await withOwnerRole(client, async () => {
    // Restore PostgreSQL column types before node-postgres decodes them. Reading
    // JSON directly would round bigint identifiers and change dates/numerics.
    // Array mode keeps a user column named "action" from shadowing our metadata.
    const captured = await client.query({
      text: `SELECT captured.action, restored.*
             FROM platform.rest_write_changes captured
             CROSS JOIN LATERAL jsonb_populate_record(NULL::${relation}, captured.row) restored
             WHERE captured."requestId" = $1 ORDER BY captured.ordinal`,
      values: [id],
      rowMode: 'array',
    });
    await client.query('DELETE FROM platform.rest_write_requests WHERE id = $1', [id]);
    return captured.rows.map(values => ({
      action: values[0] as CapturedChange['action'],
      row: Object.fromEntries(captured.fields.slice(1).map((field, index) => [field.name, values[index + 1]])),
    }));
  });
  return { response, changes };
}
