import type { LogDrain, Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { HttpException } from '../../exceptions/http-exception';
import type { LogEntry } from '../../lib/log-buffer';
import {
  MAX_ATTEMPTS,
  buildDrainRequest,
  createLogDrainSchema,
  logDrainConfigSchemas,
  maskLogDrainConfig,
  mergeLogDrainSecrets,
  retryDelayMs,
  updateLogDrainSchema,
  type LogDrainConfig,
  type LogDrainType,
} from './log-drains';

/** Cadence and size of a delivery. A drain is a bulk sink: seconds of delay cost nothing. */
const FLUSH_INTERVAL_MS = 2_000;
const BATCH_SIZE = 500;
/** Per drain. A destination that is down for long enough loses its oldest lines, not the heap. */
const MAX_QUEUE = 10_000;
const DELIVERY_TIMEOUT_MS = 10_000;

interface DrainState {
  row: LogDrain;
  queue: LogEntry[];
  /** The batch in flight or waiting for its retry. Retried as-is, so lines are never reordered. */
  batch: LogEntry[] | null;
  attempts: number;
  nextAttemptAt: number;
  sending: boolean;
  /** Lines dropped since the counters were last written. */
  dropped: number;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}

/**
 * Copies every line of the log buffer to each enabled drain.
 *
 * Subscribes to the same `entry` event LogPersistenceService does. Each drain
 * has its own queue and its own backoff, so one dead destination never holds
 * up another. A batch that keeps failing is dropped after MAX_ATTEMPTS and
 * counted, which is what the Studio shows as the drain's delivery status.
 */
export class LogDrainService extends BaseContext {
  private states = new Map<string, DrainState>();
  private listener: ((entry: LogEntry) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.reload();
    if (this.listener) return;
    this.listener = entry => this.enqueue(entry);
    this.di.logBuffer.on('entry', this.listener);
    this.timer = setInterval(() => void this.tick(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.listener) this.di.logBuffer.off('entry', this.listener);
    this.listener = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read the drains after a change, keeping what is queued for the ones that remain. */
  async reload(): Promise<void> {
    const rows = await this.di.prisma.logDrain.findMany({ where: { enabled: true } });
    const next = new Map<string, DrainState>();
    for (const row of rows) {
      const previous = this.states.get(row.id);
      next.set(row.id, previous
        ? { ...previous, row }
        : { row, queue: [], batch: null, attempts: 0, nextAttemptAt: 0, sending: false, dropped: 0 });
    }
    this.states = next;
  }

  private enqueue(entry: LogEntry): void {
    for (const state of this.states.values()) {
      if (state.queue.length >= MAX_QUEUE) state.dropped += 1;
      else state.queue.push(entry);
    }
  }

  /** One pass over every drain. Exported for tests through `flushAll`. */
  private async tick(now = Date.now()): Promise<void> {
    await Promise.all([...this.states.values()].map(state => this.flushDrain(state, now)));
  }

  /** Deliver everything that is due, now. Used by tests and at shutdown. */
  flushAll(): Promise<void> {
    return this.tick(Number.MAX_SAFE_INTEGER);
  }

  private async flushDrain(state: DrainState, now: number): Promise<void> {
    if (state.sending) return;
    if (!state.batch && state.queue.length) state.batch = state.queue.splice(0, BATCH_SIZE);
    if (!state.batch || now < state.nextAttemptAt) {
      if (state.dropped) await this.record(state, {});
      return;
    }
    state.sending = true;
    const batch = state.batch;
    try {
      const result = await this.deliver(state.row, batch);
      if (result.ok) {
        state.batch = null;
        state.attempts = 0;
        state.nextAttemptAt = 0;
        await this.record(state, { deliveredCount: { increment: batch.length }, lastSuccessAt: new Date() });
        return;
      }
      state.attempts += 1;
      const giveUp = state.attempts >= MAX_ATTEMPTS;
      if (giveUp) {
        state.batch = null;
        state.attempts = 0;
        state.nextAttemptAt = 0;
      } else {
        state.nextAttemptAt = Date.now() + retryDelayMs(state.attempts);
      }
      await this.record(state, {
        ...(giveUp ? { failedCount: { increment: batch.length } } : {}),
        lastErrorAt: new Date(),
        lastError: result.error ?? `HTTP ${result.status}`,
      });
    } finally {
      state.sending = false;
    }
  }

  /** Write the delivery counters. Best effort: the drain may have been deleted meanwhile. */
  private async record(state: DrainState, data: Prisma.LogDrainUpdateInput): Promise<void> {
    const dropped = state.dropped;
    state.dropped = 0;
    await this.di.prisma.logDrain
      .update({
        where: { id: state.row.id },
        data: { ...data, ...(dropped ? { droppedCount: { increment: dropped } } : {}) },
      })
      .catch(() => undefined);
  }

  private async deliver(row: LogDrain, entries: LogEntry[]): Promise<DeliveryResult> {
    const request = buildDrainRequest(row.type as LogDrainType, row.config as unknown as LogDrainConfig, entries);
    try {
      const response = await this.di.OutboundHttpClient.request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        timeoutMs: DELIVERY_TIMEOUT_MS,
      });
      return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Admin API ──────────────────────────────────────────────────────────────

  private describe(row: LogDrain) {
    const state = this.states.get(row.id);
    return {
      ...row,
      config: maskLogDrainConfig(row.config as Record<string, unknown>),
      pending: (state?.queue.length ?? 0) + (state?.batch?.length ?? 0),
      retrying: Boolean(state?.attempts),
    };
  }

  async list() {
    const rows = await this.di.prisma.logDrain.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(row => this.describe(row));
  }

  private validConfig(type: LogDrainType, config: unknown): LogDrainConfig {
    const parsed = logDrainConfigSchemas[type].safeParse(config);
    if (!parsed.success) throw new HttpException(zodMessage(parsed.error), 400);
    return parsed.data;
  }

  private async find(id: string): Promise<LogDrain> {
    const row = await this.di.prisma.logDrain.findUnique({ where: { id } });
    if (!row) throw new HttpException(`Log drain not found: ${id}`, 404);
    return row;
  }

  async create(input: unknown) {
    const parsed = createLogDrainSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpException(zodMessage(parsed.error), 400);
    const { name, type, enabled } = parsed.data;
    if (await this.di.prisma.logDrain.findUnique({ where: { name } })) {
      throw new HttpException(`A log drain named ${name} already exists`, 409);
    }
    const config = this.validConfig(type, parsed.data.config);
    const row = await this.di.prisma.logDrain.create({
      data: { name, type, enabled, config: config as unknown as Prisma.InputJsonValue },
    });
    await this.reload();
    return this.describe(row);
  }

  async update(id: string, input: unknown) {
    const parsed = updateLogDrainSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpException(zodMessage(parsed.error), 400);
    const current = await this.find(id);
    const config = parsed.data.config
      ? this.validConfig(
        current.type as LogDrainType,
        mergeLogDrainSecrets(parsed.data.config, current.config as Record<string, unknown>),
      )
      : undefined;
    const row = await this.di.prisma.logDrain.update({
      where: { id },
      data: {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
        ...(config ? { config: config as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    await this.reload();
    return this.describe(row);
  }

  async remove(id: string) {
    await this.find(id);
    await this.di.prisma.logDrain.delete({ where: { id } });
    await this.reload();
    return { id, deleted: true };
  }

  /** Send one synthetic line now, so an operator sees a bad URL or key immediately. */
  async test(id: string): Promise<DeliveryResult> {
    const row = await this.find(id);
    return this.deliver(row, [{
      id: 0,
      at: new Date().toISOString(),
      level: 'info',
      source: 'log-drain',
      message: `Test delivery from Motherbase log drain "${row.name}"`,
      service: 'api',
    }]);
  }
}
