import { Prisma } from '@prisma/client';
import { errorMessage } from '../../lib/errors';
import BaseContext from '../../context/base-context';
import { parseOutboxRetention } from '../realtime/realtime-outbox-retention';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DataRetentionConfig {
  enabled: boolean;
  cron: string;
  webhookDeliveryDays: number;
  edgeFunctionLogDays: number;
  jobRunDays: number;
  authAuditLogDays: number;
  batchSize: number;
  maxBatchesPerRun: number;
}

export interface RetentionTargetResult {
  deleted: number;
  batches: number;
  truncated: boolean;
  error?: string;
}

export interface DataRetentionRunSummary {
  ran: boolean;
  webhookDeliveries: RetentionTargetResult;
  edgeFunctionLogs: RetentionTargetResult;
  jobRuns: RetentionTargetResult;
  authAuditLogs: RetentionTargetResult;
  realtimeOutboxCompleted: RetentionTargetResult;
  realtimeOutboxFailed: RetentionTargetResult;
  /** `realtime.messages`, written by `realtime.send`; kept as long as delivered outbox events. */
  realtimeMessages: RetentionTargetResult;
  requestLogs: RetentionTargetResult;
}

type DeleteBatch = (cutoff: Date, batchSize: number) => Promise<number>;

interface ExpiringTable {
  table: string;
  timestampColumn: string;
  /** Narrows the rows eligible for deletion, beyond their age. */
  where?: Prisma.Sql;
}

interface RealtimeRetention {
  enabled?: boolean;
}

interface RequestLogRetention {
  enabled?: boolean;
  retentionDays?: number;
  maxRows?: number;
}

function emptyTarget(): RetentionTargetResult {
  return { deleted: 0, batches: 0, truncated: false };
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function mergeResults(a: RetentionTargetResult, b: RetentionTargetResult): RetentionTargetResult {
  return {
    deleted: a.deleted + b.deleted,
    batches: a.batches + b.batches,
    truncated: a.truncated || b.truncated,
    error: a.error ?? b.error,
  };
}

/**
 * Applies retention to operational logs. Each target uses small ordered DELETE
 * batches and the whole run is capped, so maintenance never opens a long-lived
 * transaction. A failed target does not prevent the others from being purged.
 *
 * Three settings groups each switch their own targets on: `data.retention`
 * (operational logs), `realtime.retention` (the outbox) and `logs.retention`
 * (stored request logs). None is gated on another, so turning one off never
 * lets a table the others govern grow without bound.
 */
export class DataRetentionService extends BaseContext {
  config(): Promise<DataRetentionConfig> {
    return this.di.SettingsService.get<DataRetentionConfig>('data.retention');
  }

  /**
   * Whether the cron is worth scheduling at all. The cron expression comes from
   * `data.retention`, since there is one job for all targets.
   */
  async hasEnabledTarget(): Promise<boolean> {
    const [config, realtime, logs] = await Promise.all([
      this.config(),
      this.optionalSettings<RealtimeRetention>('realtime.retention'),
      this.optionalSettings<RequestLogRetention>('logs.retention'),
    ]);
    return config.enabled || Boolean(realtime?.enabled) || Boolean(logs?.enabled);
  }

  async runOnce(now = new Date()): Promise<DataRetentionRunSummary> {
    const config = await this.config();
    const operational = await this.purgeOperationalLogs(now, config);
    const realtime = await this.purgeRealtime(now, config);
    const requestLogs = await this.purgeRequestLogs(now, config);
    return {
      ran: operational.ran || realtime.ran || requestLogs.ran,
      ...operational.results,
      ...realtime.results,
      requestLogs: requestLogs.result,
    };
  }

  private async purgeOperationalLogs(now: Date, config: DataRetentionConfig) {
    const results = {
      webhookDeliveries: emptyTarget(),
      edgeFunctionLogs: emptyTarget(),
      jobRuns: emptyTarget(),
      authAuditLogs: emptyTarget(),
    };
    if (!config.enabled) return { ran: false, results };

    results.webhookDeliveries = await this.purgeTarget(daysBefore(now, config.webhookDeliveryDays), config,
      this.deleteExpiredBatch({ table: '"platform"."webhook_deliveries"', timestampColumn: '"createdAt"' }));
    results.edgeFunctionLogs = await this.purgeTarget(daysBefore(now, config.edgeFunctionLogDays), config,
      this.deleteExpiredBatch({ table: '"platform"."edge_function_logs"', timestampColumn: '"invokedAt"' }));
    // Every scheduled job writes a ledger row, so this grows fastest of all.
    results.jobRuns = await this.purgeTarget(daysBefore(now, config.jobRunDays), config,
      (cutoff, batchSize) => this.di.JobLedgerService.pruneBatch(cutoff, batchSize));
    results.authAuditLogs = await this.purgeTarget(daysBefore(now, config.authAuditLogDays ?? 90), config,
      (cutoff, batchSize) => this.di.AuthAuditService.deleteBatch(cutoff, batchSize));
    return { ran: true, results };
  }

  private async purgeRealtime(now: Date, config: DataRetentionConfig) {
    const results = {
      realtimeOutboxCompleted: emptyTarget(),
      realtimeOutboxFailed: emptyTarget(),
      realtimeMessages: emptyTarget(),
    };
    const settings = await this.optionalSettings<RealtimeRetention>('realtime.retention');
    const retention = settings?.enabled ? parseOutboxRetention(settings) : null;
    if (!retention) return { ran: false, results };

    const outbox = (status: 'completed' | 'failed'): ExpiringTable => ({
      table: '"platform"."realtime_outbox"',
      timestampColumn: '"processedAt"',
      where: Prisma.sql`"status" = ${status}`,
    });
    results.realtimeOutboxCompleted = await this.purgeTarget(daysBefore(now, retention.completedDays), config,
      this.deleteExpiredBatch(outbox('completed')));
    results.realtimeOutboxFailed = await this.purgeTarget(daysBefore(now, retention.failedDays), config,
      this.deleteExpiredBatch(outbox('failed')));
    results.realtimeMessages = await this.purgeTarget(daysBefore(now, retention.completedDays), config,
      this.deleteExpiredBatch({ table: '"realtime"."messages"', timestampColumn: '"inserted_at"' }));
    return { ran: true, results };
  }

  private async purgeRequestLogs(now: Date, config: DataRetentionConfig) {
    const settings = await this.optionalSettings<RequestLogRetention>('logs.retention');
    if (!settings?.enabled) return { ran: false, result: emptyTarget() };

    const days = Number(settings.retentionDays) || 7;
    const expired = await this.purgeTarget(daysBefore(now, days), config,
      this.deleteExpiredBatch({ table: '"platform"."request_logs"', timestampColumn: '"at"' }));
    const maxRows = Number(settings.maxRows) || 0;
    if (maxRows <= 0) return { ran: true, result: expired };
    return { ran: true, result: mergeResults(expired, await this.trimRequestLogsToMaxRows(maxRows, config)) };
  }

  private optionalSettings<T>(key: string): Promise<T | null> {
    return this.di.SettingsService.get<T>(key).catch(() => null);
  }

  private async purgeTarget(
    cutoff: Date,
    config: DataRetentionConfig,
    deleteBatch: DeleteBatch
  ): Promise<RetentionTargetResult> {
    let deleted = 0;
    let batches = 0;

    while (batches < config.maxBatchesPerRun) {
      let count: number;
      try {
        count = await deleteBatch(cutoff, config.batchSize);
      } catch (error) {
        return { deleted, batches, truncated: false, error: errorMessage(error) };
      }
      deleted += count;
      batches += 1;
      if (count < config.batchSize) return { deleted, batches, truncated: false };
    }

    return { deleted, batches, truncated: true };
  }

  /** Identifiers are hard-coded by the callers above, never user input. */
  private deleteExpiredBatch({ table, timestampColumn, where }: ExpiringTable): DeleteBatch {
    const relation = Prisma.raw(table);
    const timestamp = Prisma.raw(timestampColumn);
    const filter = where ? Prisma.sql`${where} AND ` : Prisma.empty;
    return async (cutoff, batchSize) => {
      const rows = await this.di.prisma.$queryRaw<Array<{ id: unknown }>>(Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM ${relation}
          WHERE ${filter}${timestamp} < ${cutoff}
          ORDER BY ${timestamp}, "id"
          LIMIT ${batchSize}
        )
        DELETE FROM ${relation} AS expired
        USING candidates
        WHERE expired."id" = candidates."id"
        RETURNING expired."id"
      `);
      return rows.length;
    };
  }

  /**
   * Age-based retention alone cannot bound the table: a burst of traffic can
   * put more rows inside the window than the disk holds. This deletes the
   * oldest rows above the configured ceiling, in the same bounded batches.
   */
  private async trimRequestLogsToMaxRows(
    maxRows: number,
    config: DataRetentionConfig
  ): Promise<RetentionTargetResult> {
    let excess = (await this.di.prisma.requestLog.count()) - maxRows;
    if (excess <= 0) return emptyTarget();

    return this.purgeTarget(new Date(0), config, async (_cutoff, batchSize) => {
      const take = Math.min(batchSize, excess);
      if (take <= 0) return 0;
      const rows = await this.di.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM "platform"."request_logs"
          ORDER BY "at", "id"
          LIMIT ${take}
        )
        DELETE FROM "platform"."request_logs" AS logs
        USING candidates
        WHERE logs."id" = candidates."id"
        RETURNING logs."id"
      `);
      excess -= rows.length;
      // Always the real count: purgeTarget adds it up and stops on a short
      // batch, and the next `take` is 0 once the ceiling is met.
      return rows.length;
    });
  }
}
