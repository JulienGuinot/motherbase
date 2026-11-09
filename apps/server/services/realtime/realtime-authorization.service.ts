import type { PoolClient } from 'pg';
import BaseContext from '../../context/base-context';
import { rlsContextFor, type RlsUser } from '../../lib/rls-claims';
import { withOwnerRole } from '../../lib/with-owner-role';

export type RealtimeExtension = 'broadcast' | 'presence';

export interface ExtensionAccess {
  read: boolean;
  write: boolean;
}

/** What a caller may do on one private channel, decided once at join time. */
export type ChannelAccess = Record<RealtimeExtension, ExtensionAccess>;

const EXTENSIONS: RealtimeExtension[] = ['broadcast', 'presence'];
const NO_ACCESS: ExtensionAccess = { read: false, write: false };
/** Postgres raises 42501 both for a missing grant and for a failed WITH CHECK. */
const INSUFFICIENT_PRIVILEGE = '42501';
const PROBE_EVENT = 'realtime.authorization';

export function denyAll(): ChannelAccess {
  return { broadcast: { ...NO_ACCESS }, presence: { ...NO_ACCESS } };
}

/** A private join is refused only when the caller can receive nothing at all. */
export function canJoin(access: ChannelAccess): boolean {
  return access.broadcast.read || access.presence.read;
}

/**
 * Realtime Authorization: private channels are decided by the project's RLS
 * policies on `realtime.messages`, exactly as on Supabase.
 *
 * Postgres has no "would this policy allow it" query, so the check performs
 * the operations and throws them away: inside one transaction that always
 * ends in ROLLBACK, with the caller's role and claims and `realtime.topic` set
 * to the channel,
 *   - read:  the owner inserts a probe row, then the caller SELECTs it back;
 *   - write: the caller inserts a probe row itself, under WITH CHECK.
 * Policies therefore see the same `auth.uid()`, `realtime.topic()` and
 * `extension` they would see for a real message, and nothing is left behind.
 */
export class RealtimeAuthorizationService extends BaseContext {
  async channelAccess(user: RlsUser | null, topic: string): Promise<ChannelAccess> {
    try {
      return await this.di.RlsPool.withRlsTx(
        rlsContextFor(user),
        async client => {
          await client.query(`SELECT set_config('realtime.topic', $1, true)`, [topic]);
          const access = denyAll();
          for (const extension of EXTENSIONS) {
            access[extension] = {
              read: await this.canRead(client, topic, extension),
              write: await this.canWrite(client, topic, extension),
            };
          }
          return access;
        },
        { rollback: true }
      );
    } catch {
      // Fail closed: an unreadable policy table must not open a private channel.
      return denyAll();
    }
  }

  private async canRead(client: PoolClient, topic: string, extension: RealtimeExtension): Promise<boolean> {
    const probe = await withOwnerRole(client, () =>
      client.query<{ id: string }>(
        `INSERT INTO "realtime"."messages" ("topic", "extension", "event", "private")
         VALUES ($1, $2, $3, true) RETURNING "id"`,
        [topic, extension, PROBE_EVENT]
      )
    );
    const seen = await client.query(`SELECT 1 FROM "realtime"."messages" WHERE "id" = $1`, [probe.rows[0].id]);
    return (seen.rowCount ?? 0) > 0;
  }

  private async canWrite(client: PoolClient, topic: string, extension: RealtimeExtension): Promise<boolean> {
    // A savepoint, because a refused INSERT aborts the transaction and the
    // remaining checks still have to run in it.
    await client.query('SAVEPOINT realtime_write_probe');
    try {
      await client.query(
        `INSERT INTO "realtime"."messages" ("topic", "extension", "event", "private") VALUES ($1, $2, $3, true)`,
        [topic, extension, PROBE_EVENT]
      );
      await client.query('RELEASE SAVEPOINT realtime_write_probe');
      return true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT realtime_write_probe');
      if ((error as { code?: string })?.code === INSUFFICIENT_PRIVILEGE) return false;
      throw error;
    }
  }
}
