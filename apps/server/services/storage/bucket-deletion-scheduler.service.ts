import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import { nodeIntervalScheduler, type IntervalScheduler } from '../../lib/schedulers';
import type { JobTrigger } from '../admin/job-ledger.service';
import type { JobDescriptor } from '../admin/job-inventory.service';

const POLL_INTERVAL_MS = 2_000;
const JOB_CONCURRENCY = 2;

/** Polls the durable queue; database leases make this safe across replicas. */
export class BucketDeletionSchedulerService extends BaseContext {
  protected scheduler: IntervalScheduler = nodeIntervalScheduler;
  private task: { stop(): void } | null = null;
  private running = false;

  async start(): Promise<void> {
    this.stop();
    await this.runOnce();
    this.task = this.scheduler.every(POLL_INTERVAL_MS, () => {
      void this.runOnce().catch(error => {
        logActivity('error', 'job', `[bucket-deletion] worker failed: ${errorMessage(error)}`);
      });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async runOnce(trigger: JobTrigger = 'schedule'): Promise<{ ran: boolean; claimed: number }> {
    if (this.running) return { ran: false, claimed: 0 };
    this.running = true;
    try {
      const claimed = await Promise.all(
        Array.from({ length: JOB_CONCURRENCY }, () => this.di.BucketDeletionService.processNext()),
      );
      const result = { ran: true, claimed: claimed.filter(Boolean).length };
      // Recorded only when it did something: this loop polls every 2s, so a row
      // per empty tick would bury the runs that matter (same call data-retention
      // and the realtime outbox worker make).
      // A manual run records even when it claimed nothing: the operator asked,
      // and "nothing to do" is the answer they came for.
      if (result.claimed || trigger === 'manual') {
        await this.di.JobLedgerService.note('bucket-deletion', 'ok', null, { output: result, trigger });
      }
      return result;
    } catch (error) {
      await this.di.JobLedgerService.note('bucket-deletion', 'failed', errorMessage(error), { trigger });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * @see JobInventoryService. No cadence window: this loop records a run only
   * when it actually claimed a deletion, so silence means an empty queue, not a
   * dead worker, and a missed-window rule here would page for an idle project.
   */
  describe(): JobDescriptor[] {
    return [
      {
        id: 'bucket-deletion',
        name: 'Bucket deletion worker',
        kind: 'platform',
        schedule: `polls every ${Math.round(POLL_INTERVAL_MS / 1000)}s`,
        enabled: true,
        scheduled: this.task !== null,
        running: this.running,
        nextRunAt: null,
        maxIntervalMs: null,
        definition: {
          does:
            'Claims buckets marked for deletion and removes their objects in batches, so deleting a large bucket does not block the request that asked for it.',
          source: 'apps/server/services/storage/bucket-deletion-scheduler.service.ts',
          settingsHref: null,
        },
        runnable: true,
        configurable: false,
      },
    ];
  }

  /** @see DescribesJob. Forces one poll, the same one the timer fires. */
  async runNow(): Promise<unknown> {
    return this.runOnce('manual');
  }
}
