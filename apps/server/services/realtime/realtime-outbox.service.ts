import type { RealtimeOutbox } from '@prisma/client';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import { withOwnerRole } from '../../lib/with-owner-role';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import BaseContext from '../../context/base-context';
import type { DeleteRealtimeAudience, RealtimeAction, RealtimeModel } from './realtime-broadcast.service';
import type { DatabaseBroadcast } from './realtime-topic.service';

/** Postgres LISTEN/NOTIFY channel used to wake the outbox worker on new events. */
export const REALTIME_OUTBOX_CHANNEL = 'realtime_outbox';

/**
 * Outbox action written by `realtime.send` (see the
 * 20260927100000_realtime_broadcast_from_database migration): a message for a
 * channel topic rather than a row change for table subscribers.
 */
export const DATABASE_BROADCAST_ACTION = 'broadcast';

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const MAX_ATTEMPTS = 8;
const MAX_ERROR_LENGTH = 1_000;

/**
 * Delete retries are intentionally scoped to captured socket ids. A reconnect
 * or process restart creates new ids, so the event is not replayed to a new
 * session whose pre-delete visibility cannot be proven.
 */
type StoredDeleteAudience =
  | { mode: 'disabled' }
  | { mode: 'all'; socketIds: string[] }
  | { mode: 'restricted'; socketIdsByRowId: Record<string, string[]> };

type RealtimeOutboxRow = RealtimeOutbox;

export function serializeDeleteAudience(audience?: DeleteRealtimeAudience): StoredDeleteAudience | null {
  if (!audience || audience.mode === 'disabled') return audience ?? null;
  if (audience.mode === 'all') {
    return { mode: 'all', socketIds: Array.from(audience.socketIds) };
  }
  return {
    mode: 'restricted',
    socketIdsByRowId: Object.fromEntries(
      Array.from(audience.socketIdsByRowId, ([rowId, socketIds]) => [rowId, Array.from(socketIds)])
    ),
  };
}

function deserializeDeleteAudience(value: unknown): DeleteRealtimeAudience | undefined {
  if (!value || typeof value !== 'object' || !('mode' in value)) return undefined;
  const audience = value as StoredDeleteAudience;
  if (audience.mode === 'disabled') return audience;
  if (audience.mode === 'all') {
    return { mode: 'all', socketIds: new Set(audience.socketIds) };
  }
  if (audience.mode === 'restricted') {
    return {
      mode: 'restricted',
      socketIdsByRowId: new Map(
        Object.entries(audience.socketIdsByRowId).map(([rowId, socketIds]) => [rowId, new Set(socketIds)])
      ),
    };
  }
  return undefined;
}

export class RealtimeOutboxService extends BaseContext {
  async enqueue(
    client: Pick<PoolClient, 'query'>,
    model: RealtimeModel,
    action: RealtimeAction,
    payloads: unknown[],
    deleteAudience?: DeleteRealtimeAudience
  ): Promise<void> {
    if (!payloads.length) return;
    await withOwnerRole(client, async () => {
      await client.query(
        [
          'INSERT INTO "platform"."realtime_outbox"',
          '("id", "model", "dbName", "action", "payloads", "deleteAudience", "updatedAt")',
          'VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())',
        ].join(' '),
        [
          randomUUID(),
          model.model,
          model.dbName,
          action,
          JSON.stringify(payloads),
          JSON.stringify(serializeDeleteAudience(deleteAudience)),
        ]
      );
      // Wake the outbox worker the instant this write commits, so realtime delivery
      // is near-instant instead of waiting up to a full poll interval. NOTIFY is
      // transactional: the signal only fires on COMMIT, when the row is visible.
      await client.query('NOTIFY ' + REALTIME_OUTBOX_CHANNEL);
    });
  }

  async processNext(): Promise<boolean> {
    const leaseToken = randomUUID();
    const event = await this.claim(leaseToken);
    if (!event) return false;

    const stopHeartbeat = this.startHeartbeat(event.id, leaseToken);
    try {
      if (event.action === DATABASE_BROADCAST_ACTION) {
        this.di.RealtimeTopicService.deliverDatabaseBroadcasts(event.payloads as unknown as DatabaseBroadcast[]);
      } else {
        await this.di.RealtimeBroadcastService.deliverPersisted(
          { model: event.model, dbName: event.dbName },
          event.action as RealtimeAction,
          event.payloads as unknown[],
          deserializeDeleteAudience(event.deleteAudience)
        );
      }
      await this.complete(event.id, leaseToken);
    } catch (error) {
      await this.retryOrFail(event, leaseToken, error);
    } finally {
      stopHeartbeat();
    }
    return true;
  }

  private async claim(leaseToken: string): Promise<RealtimeOutboxRow | null> {
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
    const rows = await this.di.prisma.$queryRawUnsafe<RealtimeOutboxRow[]>(
      [
        'WITH candidate AS (',
        ' SELECT "id" FROM "platform"."realtime_outbox"',
        ' WHERE ("status" = \'pending\' AND "availableAt" <= NOW())',
        '    OR ("status" = \'processing\' AND "leaseExpiresAt" < NOW())',
        ' ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1',
        ') UPDATE "platform"."realtime_outbox" AS outbox',
        'SET "status" = \'processing\', "leaseToken" = $1,',
        '    "leaseExpiresAt" = $2, "updatedAt" = NOW()',
        'FROM candidate WHERE outbox."id" = candidate."id"',
        'RETURNING outbox.*',
      ].join(' '),
      leaseToken,
      leaseExpiresAt
    );
    return rows[0] ?? null;
  }

  private startHeartbeat(id: string, leaseToken: string): () => void {
    const timer = setInterval(() => {
      void this.di.prisma.realtimeOutbox
        .updateMany({
          where: { id, status: 'processing', leaseToken },
          data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
        })
        .catch((error: unknown) => {
          logActivity('error', 'realtime', `[realtime-outbox] lease heartbeat failed: ${errorMessage(error)}`);
        });
    }, HEARTBEAT_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async complete(id: string, leaseToken: string): Promise<void> {
    await this.di.prisma.realtimeOutbox.updateMany({
      where: { id, status: 'processing', leaseToken },
      data: {
        status: 'completed',
        attempts: 0,
        lastError: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processedAt: new Date(),
      },
    });
  }

  private async retryOrFail(event: RealtimeOutboxRow, leaseToken: string, error: unknown): Promise<void> {
    const attempts = event.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await this.di.prisma.realtimeOutbox.updateMany({
      where: { id: event.id, status: 'processing', leaseToken },
      data: {
        status: failed ? 'failed' : 'pending',
        attempts,
        lastError: errorMessage(error).slice(0, MAX_ERROR_LENGTH),
        availableAt: new Date(Date.now() + this.retryDelay(attempts)),
        leaseToken: null,
        leaseExpiresAt: null,
        processedAt: failed ? new Date() : null,
      },
    });
  }

  private retryDelay(attempts: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  }
}
