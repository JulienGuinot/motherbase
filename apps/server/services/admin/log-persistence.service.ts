import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import type { LogEntry, LogLevel } from '../../lib/log-buffer';
import { logFilterWhere, type LogFilter } from '../../lib/log-filter';
import type { LogService } from '../../lib/log-services';

export interface LogRetentionConfig {
  enabled: boolean;
  retentionDays: number;
  maxRows: number;
}

export interface LogQuery extends LogFilter {
  limit: number;
}

/** Batch size and cadence of the writer. One INSERT per request would put a
 *  database round-trip in the path of every response; the Logs screen polls
 *  every 2s, so a 1s flush is already faster than anyone can see. */
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH = 500;
/** Ceiling on the pending queue. If the database is unreachable the lines are
 *  dropped rather than allowed to grow into the heap they were meant to spare. */
const MAX_QUEUE = 10_000;

/**
 * Durable log history.
 *
 * The ring buffer in `lib/log-buffer.ts` holds a few hundred lines and dies
 * with the process, which is why the Logs screen could not look back past the
 * last few minutes of traffic on a busy server, and past a restart at all.
 * This subscribes to the same buffer and copies each line into
 * `platform.request_logs` in batches, so the screen can query a real time
 * range. DataRetentionService prunes the table.
 */
export class LogPersistenceService extends BaseContext {
  private queue: LogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private listener: ((entry: LogEntry) => void) | null = null;
  private flushing = false;
  private dropped = 0;
  private lastError: string | null = null;
  /** Cached so the synchronous buffer listener can decide without awaiting. */
  private enabled = false;

  async config(): Promise<LogRetentionConfig> {
    return this.di.SettingsService.get<LogRetentionConfig>('logs.retention');
  }

  /** Subscribe to the buffer and start the flush timer. Idempotent. */
  async start(): Promise<void> {
    this.enabled = (await this.config().catch(() => null))?.enabled ?? false;
    if (this.listener) return;

    this.listener = (entry: LogEntry) => this.enqueue(entry);
    this.di.logBuffer.on('entry', this.listener);
    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        /* recorded in lastError by flush itself */
      });
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.listener) this.di.logBuffer.off('entry', this.listener);
    this.listener = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read the enabled flag after the operator changed the settings group. */
  async reload(): Promise<void> {
    this.enabled = (await this.config().catch(() => null))?.enabled ?? false;
    if (!this.enabled) this.queue = [];
  }

  private enqueue(entry: LogEntry): void {
    if (!this.enabled) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped += 1;
      return;
    }
    this.queue.push(entry);
    if (this.queue.length >= FLUSH_BATCH) void this.flush().catch(() => undefined);
  }

  /** Write everything queued. Never throws: a failed log write must not be
   *  able to fail anything else, and must not requeue forever either. */
  async flush(): Promise<number> {
    if (this.flushing || this.queue.length === 0) return 0;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.di.prisma.requestLog.createMany({
        data: batch.map(entry => ({
          at: new Date(entry.at),
          level: entry.level,
          source: entry.source,
          service: entry.service,
          message: entry.message,
          method: entry.method ?? null,
          path: entry.path ?? null,
          status: entry.status ?? null,
          durationMs: entry.durationMs ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          requestId: entry.requestId ?? null,
          userId: entry.userId ?? null,
        })),
      });
      this.lastError = null;
      return batch.length;
    } catch (error) {
      this.lastError = errorMessage(error);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Oldest line still retained, whatever the current filter is. Not the first
   * row of a query result: with a limit hit, that is only the oldest line
   * *returned*. Returns null when the table is empty or unreadable.
   */
  async oldestAt(): Promise<string | null> {
    try {
      const row = await this.di.prisma.requestLog.findFirst({ orderBy: [{ at: 'asc' }, { id: 'asc' }] });
      return row?.at.toISOString() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * One page of history plus whether more matched than was returned.
   *
   * `hasMore` is what lets the console say "showing the newest N of a larger
   * match" rather than presenting a truncated list as the whole answer.
   */
  async queryPage(options: LogQuery): Promise<{ logs: LogEntry[]; hasMore: boolean; oldestAvailable: string | null }> {
    // One extra row is the cheapest possible "is there more": no second COUNT
    // over a table that is by construction the largest in the project.
    const [logs, oldestAvailable] = await Promise.all([this.query({ ...options, limit: options.limit + 1 }), this.oldestAt()]);
    const hasMore = logs.length > options.limit;
    return {
      // `query` returns oldest-first, so the extra row is at the FRONT.
      logs: hasMore ? logs.slice(logs.length - options.limit) : logs,
      hasMore,
      oldestAvailable,
    };
  }

  /**
   * Read back a window of history. Filtering happens in SQL rather than in the
   * browser: a 30-day range is far more rows than the screen can be handed.
   * Returned oldest-first, like `LogBuffer.recent`, so both sources render the
   * same way.
   */
  async query(options: LogQuery): Promise<LogEntry[]> {
    const { limit, ...filter } = options;
    const where = logFilterWhere(filter);

    // Newest first in SQL (that is what an index on `at` can serve and what a
    // limit should keep), reversed once here so callers get buffer order.
    const rows = await this.di.prisma.requestLog.findMany({
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return rows.reverse().map(row => ({
      id: row.id,
      at: row.at.toISOString(),
      level: row.level as LogLevel,
      source: row.source,
      service: row.service as LogService,
      message: row.message,
      method: row.method ?? undefined,
      path: row.path ?? undefined,
      status: row.status ?? undefined,
      durationMs: row.durationMs ?? undefined,
      ip: row.ip ?? undefined,
      userAgent: row.userAgent ?? undefined,
      requestId: row.requestId ?? undefined,
      userId: row.userId ?? undefined,
    }));
  }

  status() {
    return { enabled: this.enabled, pending: this.queue.length, dropped: this.dropped, lastError: this.lastError };
  }
}
