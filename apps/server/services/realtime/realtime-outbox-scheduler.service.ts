import { Client } from 'pg';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import BaseContext from '../../context/base-context';
import { REALTIME_OUTBOX_CHANNEL } from './realtime-outbox.service';
import { nodeIntervalScheduler, type IntervalScheduler } from '../../lib/schedulers';
import type { JobTrigger } from '../admin/job-ledger.service';
import type { JobDescriptor } from '../admin/job-inventory.service';

const POLL_INTERVAL_MS = 2_000;
const WORKER_CONCURRENCY = 1;
const MAX_EVENTS_PER_RUN = 100;
// How long to wait before rebuilding the LISTEN connection after it drops. The
// 2s poll keeps delivering meanwhile, so this only affects push latency, never
// correctness.
const LISTEN_RETRY_MS = 2_000;

type RunResult = { ran: boolean; claimed: number };

/*
 * This worker delivers; it does not prune. Retention for platform.realtime_outbox
 * lives in DataRetentionService, which is what the operator-facing
 * `realtime.retention` group configures. A second purge used to run from here on
 * an hourly timer with 7/30 days hardcoded and a hard cap of 100 rows, so it
 * both ignored whatever the operator had set and could not keep up with a busy
 * project. One purge, one place, one set of settings.
 */

export class RealtimeOutboxSchedulerService extends BaseContext {
  protected scheduler: IntervalScheduler = nodeIntervalScheduler;
  private task: { stop(): void } | null = null;
  private currentRun: Promise<RunResult> | null = null;
  private listenClient: Client | null = null;
  private listenStopped = false;
  private rerunRequested = false;

  async start(): Promise<void> {
    await this.stop();
    this.listenStopped = false;
    await this.runOnce();
    this.task = this.scheduler.every(POLL_INTERVAL_MS, () => {
      void this.runOnce().catch(error => {
        logActivity('error', 'realtime', `[realtime-outbox] worker failed: ${errorMessage(error)}`);
      });
    });
    this.startListener();
  }

  async stop(): Promise<void> {
    this.listenStopped = true;
    this.task?.stop();
    this.task = null;
    await this.teardownListener();
    await this.currentRun;
  }

  async runOnce(trigger: JobTrigger = 'schedule'): Promise<RunResult> {
    // Coalesce a concurrent trigger (poll tick vs. LISTEN notification) into a
    // follow-up pass instead of dropping it: a NOTIFY that lands mid-drain would
    // otherwise wait for the next poll. FOR UPDATE SKIP LOCKED already makes
    // overlapping claims safe, so the worst case is a redundant empty drain.
    if (this.currentRun) {
      this.rerunRequested = true;
      return { ran: false, claimed: 0 };
    }
    let result: RunResult = { ran: false, claimed: 0 };
    do {
      this.rerunRequested = false;
      const run = this.execute(trigger);
      this.currentRun = run;
      try {
        result = await run;
      } finally {
        this.currentRun = null;
      }
    } while (this.rerunRequested);
    return result;
  }

  /** Open a dedicated connection that LISTENs for outbox NOTIFYs and drains on each. */
  private startListener(): void {
    if (this.listenStopped) return;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    this.listenClient = client;

    const onFailure = (error: unknown) => {
      if (this.listenClient !== client) return; // already replaced/torn down
      logActivity('error', 'realtime', `[realtime-outbox] LISTEN connection lost: ${errorMessage(error)}`);
      this.listenClient = null;
      client.removeAllListeners();
      void client.end().catch(() => {});
      if (!this.listenStopped) setTimeout(() => this.startListener(), LISTEN_RETRY_MS).unref();
    };

    client.on('notification', () => {
      void this.runOnce().catch(error => {
        logActivity('error', 'realtime', `[realtime-outbox] drain on notify failed: ${errorMessage(error)}`);
      });
    });
    client.on('error', onFailure);

    client
      .connect()
      .then(() => client.query(`LISTEN ${REALTIME_OUTBOX_CHANNEL}`))
      // Drain anything enqueued during the connect/reconnect gap, when NOTIFYs
      // could not have been observed.
      .then(() => {
        void this.runOnce().catch(() => {});
      })
      .catch(onFailure);
  }

  private async teardownListener(): Promise<void> {
    const client = this.listenClient;
    this.listenClient = null;
    if (!client) return;
    client.removeAllListeners();
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }

  /**
   * A pass is recorded in the job ledger only when it did something or threw.
   * This loop also wakes on every NOTIFY, so a row per pass would be thousands
   * of empty entries burying the ones that matter. Depth of undeliverable events
   * is watched separately, by the dead-letter rule.
   */
  private async execute(trigger: JobTrigger): Promise<RunResult> {
    try {
      const result = await this.drain();
      // A manual run records even on an empty pass: the operator asked, and
      // "the queue was empty" is the answer they came for.
      if (result.claimed || trigger === 'manual') {
        await this.di.JobLedgerService.note('realtime-outbox', 'ok', null, { output: result, trigger });
      }
      return result;
    } catch (error) {
      await this.di.JobLedgerService.note('realtime-outbox', 'failed', errorMessage(error), { trigger });
      throw error;
    }
  }

  private async drain(): Promise<RunResult> {
    let next = 0;
    let claimed = 0;
    const drainWorker = async () => {
      while (next < MAX_EVENTS_PER_RUN) {
        next += 1;
        if (!(await this.di.RealtimeOutboxService.processNext())) return;
        claimed += 1;
      }
    };
    await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, () => drainWorker()));
    return { ran: true, claimed };
  }

  /**
   * @see JobInventoryService. No cadence window, for the same reason as the
   * bucket-deletion worker: an empty outbox records nothing. Undelivered depth
   * is watched by the dead-letter rule instead.
   */
  describe(): JobDescriptor[] {
    return [
      {
        id: 'realtime-outbox',
        name: 'Realtime delivery worker',
        kind: 'platform',
        schedule: `polls every ${Math.round(POLL_INTERVAL_MS / 1000)}s, plus on NOTIFY`,
        enabled: true,
        scheduled: this.task !== null,
        running: this.currentRun !== null,
        nextRunAt: null,
        maxIntervalMs: null,
        definition: {
          does:
            'Drains the realtime outbox: delivers queued change events to connected subscribers and retries the ones that failed, up to their retry budget.',
          source: 'apps/server/services/realtime/realtime-outbox-scheduler.service.ts',
          settingsHref: null,
        },
        runnable: true,
        configurable: false,
      },
    ];
  }

  /** @see DescribesJob. Forces one drain, the same one the timer fires. */
  async runNow(): Promise<unknown> {
    return this.runOnce('manual');
  }
}
