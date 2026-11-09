import BaseContext from '../../context/base-context';
import { rlsContextFor, type RlsUser } from '../../lib/rls-claims';

export interface StorageListQuery {
  prefix: string;
  search?: string;
  take: number;
  skip: number;
  column: 'key' | 'createdAt' | 'updatedAt';
  order: 'asc' | 'desc';
}

export type StorageAction = 'select' | 'insert' | 'update' | 'delete';

/** The parts of an object a policy can decide on. */
export interface StorageObjectRef {
  id?: string;
  bucketId?: string | null;
  /** Bucket-prefixed key, as stored. */
  key: string;
  ownerId?: string | null;
  visibility?: string;
  bucket?: string;
  size?: number;
  mime?: string | null;
}

/**
 * Evaluates PostgreSQL policies on `storage.files` for a storage operation.
 *
 * The point is that Postgres decides, not this file. Every check runs the real
 * statement inside `RlsPool.withRlsTx` under the caller's role and claims, so a
 * policy an operator writes behaves for storage exactly as it does for a table:
 * same `auth.uid()`, same `USING` / `WITH CHECK` split, same debugging story.
 *
 * Reads are answered by asking whether the row is visible. Writes are answered by
 * asking Postgres to *attempt* the write and then rolling back, because `WITH
 * CHECK` cannot be evaluated any other way without reimplementing the expression
 *, and a second implementation of a policy engine is exactly the thing that ends
 * up disagreeing with the first one on the row that matters.
 */
export class StoragePolicyService extends BaseContext {
  /** Whether the operator has opted into policy-based storage authorization. */
  async enabled(): Promise<boolean> {
    const cfg = await this.di.SettingsService?.get<{ enabled?: boolean }>('storage.policies');
    return Boolean(cfg?.enabled);
  }

  /**
   * Can `caller` read this object?
   *
   * A `service_role` caller short-circuits: the role holds BYPASSRLS, so the
   * query below would answer "yes" anyway, and skipping it saves a round trip on
   * the path trusted server code uses most.
   */
  async canRead(object: StorageObjectRef, caller?: RlsUser | null): Promise<boolean> {
    if (caller?.serviceRole) return true;
    return this.visible(object, caller);
  }

  /**
   * Can `caller` perform this write?
   *
   * `insert` is checked against a candidate row that does not exist yet, so the
   * row is inserted and rolled back. The other actions run against the stored
   * row. Either way the transaction never commits: this decides, it does not
   * perform.
   */
  async canWrite(action: Exclude<StorageAction, 'select'>, object: StorageObjectRef, caller?: RlsUser | null): Promise<boolean> {
    if (caller?.serviceRole) return true;
    if (action === 'insert') return this.insertAllowed(object, caller);
    return this.mutationAllowed(action, object, caller);
  }

  /**
   * Which of these object ids the caller can see, in one round trip.
   *
   * Listing asks the same question as a read, just for many rows at once, and
   * asking it row by row would open a transaction per object.
   */
  async visibleIds(ids: string[], caller?: RlsUser | null): Promise<Set<string>> {
    if (!ids.length) return new Set();
    if (caller?.serviceRole) return new Set(ids);
    return this.di.RlsPool.withRlsTx(
      rlsContextFor(caller),
      async client => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM storage.files WHERE id = ANY($1::text[])',
          [ids],
        );
        return new Set(rows.map(row => row.id));
      },
      { rollback: true, statementTimeoutMs: 5000 },
    );
  }

  /** Apply RLS before LIMIT/OFFSET, so hidden objects never consume a page. */
  async listVisibleObjects(bucketId: string, query: StorageListQuery, caller?: RlsUser) {
    const column = query.column === 'createdAt' ? 'createdAt' : query.column === 'updatedAt' ? 'updatedAt' : 'key';
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    return this.di.RlsPool.withRlsTx(rlsContextFor(caller), async client => {
      const result = await client.query(
        `SELECT id, key, size, mime, "createdAt", "updatedAt" FROM storage.files
         WHERE "bucketId" = $1 AND status = 'ready' AND starts_with(key, $2)
           AND ($3::text IS NULL OR strpos(key, $3) > 0)
         ORDER BY "${column}" ${order}, id LIMIT $4 OFFSET $5`,
        [bucketId, query.prefix, query.search ?? null, query.take, query.skip],
      );
      return result.rows;
    }, { rollback: true, statementTimeoutMs: 5000 });
  }

  private async visible(object: StorageObjectRef, caller?: RlsUser | null): Promise<boolean> {
    return this.di.RlsPool.withRlsTx(
      rlsContextFor(caller),
      async client => {
        const { rows } = object.id
          ? await client.query('SELECT 1 FROM storage.files WHERE id = $1 LIMIT 1', [object.id])
          : await client.query('SELECT 1 FROM storage.files WHERE key = $1 LIMIT 1', [object.key]);
        return rows.length > 0;
      },
      // Nothing here writes, but rolling back is free and removes any question
      // about what a future edit to this method could leave behind.
      { rollback: true, statementTimeoutMs: 5000 },
    );
  }

  private async insertAllowed(object: StorageObjectRef, caller?: RlsUser | null): Promise<boolean> {
    try {
      return await this.di.RlsPool.withRlsTx(
        rlsContextFor(caller),
        async client => {
          await client.query(
            `INSERT INTO storage.files (id, bucket, key, "bucketId", "ownerId", visibility, status, size, mime, "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"storage"."FileVisibility", 'pending', $6, $7, now())`,
            [
              object.bucket ?? 'uploads',
              object.key,
              object.bucketId ?? null,
              object.ownerId ?? null,
              object.visibility ?? 'private',
              object.size ?? 0,
              object.mime ?? null,
            ],
          );
          return true;
        },
        { rollback: true, statementTimeoutMs: 5000 },
      );
    } catch (err) {
      // A policy violation is Postgres error 42501. Anything else is a real
      // failure and must not be reported to the caller as "denied", which would
      // hide a broken migration behind a 403.
      if ((err as { code?: string })?.code === '42501') return false;
      throw err;
    }
  }

  private async mutationAllowed(action: 'update' | 'delete', object: StorageObjectRef, caller?: RlsUser | null): Promise<boolean> {
    try {
      return await this.di.RlsPool.withRlsTx(rlsContextFor(caller), async client => {
        // SELECT alone proves neither a DELETE USING nor an UPDATE WITH CHECK.
        // Exercise the actual statement, then roll back every change.
        const predicate = object.id ? 'id = $1' : 'key = $1';
        const value = object.id ?? object.key;
        const result = action === 'delete'
          ? await client.query(`DELETE FROM storage.files WHERE ${predicate}`, [value])
          : await client.query(
            `UPDATE storage.files SET size = COALESCE($2::integer, size), mime = COALESCE($3::text, mime)
             WHERE ${predicate}`,
            [value, object.size ?? null, object.mime ?? null],
          );
        return (result.rowCount ?? 0) > 0;
      }, { rollback: true, statementTimeoutMs: 5000 });
    } catch (error) {
      if ((error as { code?: string })?.code === '42501') return false;
      throw error;
    }
  }
}
