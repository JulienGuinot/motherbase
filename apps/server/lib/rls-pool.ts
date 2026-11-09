// lib/rls-pool.ts
import { Pool, type PoolClient } from 'pg';
import { RLS_ROLES, type RlsContext, type RlsRole } from './rls-claims';
import { APPLICATION_NAME } from './instance';
import { installInt8Parser } from './pg-int8';
import { logActivity } from './activity-log';
import { errorMessage } from './errors';

// Process-wide (node-postgres keeps parsers on the module), installed here
// because this pool is the one that serves REST reads. See lib/pg-int8.
installInt8Parser();

const ALLOWED_ROLES = RLS_ROLES;

/**
 * Ceiling for any statement run as anon/authenticated/service_role. The anon key
 * is public, and the pool is small: without a ceiling a handful of regex, FTS or
 * unindexed-sort requests hold every connection and the data plane stops.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** How long a request waits for a free connection before failing instead of hanging. */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Dedicated data-plane connection pool. Separate from Prisma (which stays on the
 * superuser control plane). Every query runs inside a transaction that switches to
 * a non-owner role so Postgres RLS is enforced.
 *
 * Note: this class takes no constructor parameters so it can be safely registered
 * with awilix's `asClass(RlsPool).singleton()`. Awilix (PROXY injection mode, the
 * container default here) always invokes the constructor with the dependency
 * cradle as its sole argument; a declared parameter with a default value (e.g.
 * `connectionString = process.env.DATABASE_URL`) would silently receive the cradle
 * object instead of the default. Reading `process.env.DATABASE_URL` directly in
 * the constructor body avoids that trap.
 */
export class RlsPool {
  private pool: Pool;

  constructor() {
    // application_name tags every backend with this process's id, which is how
    // `countApiInstances()` notices a second replica attached to the same
    // database: the situation in which the in-memory rate limiter, log buffer
    // and telemetry each hold only their own share. See lib/instance.ts.
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      application_name: APPLICATION_NAME,
    });
    // The Logs Explorer's "Postgres connections" source (Supabase's pooler
    // logs): when the data plane opens and loses connections, and why.
    this.pool.on('connect', () => logActivity('info', 'pooler', `[pooler] opened a connection (${this.usage()})`));
    this.pool.on('remove', () => logActivity('info', 'pooler', `[pooler] closed a connection (${this.usage()})`));
    this.pool.on('error', error => logActivity('error', 'pooler', `[pooler] idle connection failed: ${errorMessage(error)}`));
  }

  private usage(): string {
    return `total=${this.pool.totalCount} idle=${this.pool.idleCount} waiting=${this.pool.waitingCount}`;
  }

  assertRole(role: RlsRole): void {
    if (!ALLOWED_ROLES.has(role)) throw new Error(`Illegal RLS role: ${role}`);
  }

  /**
   * `rollback` ends the transaction with ROLLBACK even when `fn` succeeds. The
   * RLS simulator runs caller-supplied SQL and must not be able to leave a trace
   * behind: the read-only guards in front of it are static analysis, and this is
   * the guarantee that does not depend on them being complete.
   *
   * `readOnly` opens a READ ONLY transaction, which also refuses nextval()/setval() and
   * other writes that a rollback would not undo (sequences are not transactional).
   *
   * `statementTimeoutMs` is applied with SET LOCAL after the role switch, so it
   * covers the caller's statement and dies with the transaction.
   */
  async withRlsTx<T>(
    ctx: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
    options: { rollback?: boolean; readOnly?: boolean; statementTimeoutMs?: number } = {}
  ): Promise<T> {
    this.assertRole(ctx.role);
    const client = await this.pool.connect();
    // A client whose ROLLBACK failed may still hold the transaction (and the
    // SET LOCAL ROLE), so it is destroyed instead of going back to the pool.
    let discard = false;
    try {
      await client.query(options.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      // The whole request context in one round trip, every value bound:
      // `set_config('role', …, true)` is `SET LOCAL ROLE` (what PostgREST sends),
      // and the role is still allowlisted above. Three separate statements here
      // were three of the seven round trips of every REST read.
      const timeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
      await client.query(
        `SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('statement_timeout', $3, true)`,
        [ctx.role, ctx.claims, String(Math.max(1, Math.floor(timeoutMs)))],
      );
      const result = await fn(client);
      await client.query(options.rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw err;
    } finally {
      client.release(discard);
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}
