import BaseContext from '../../context/base-context';
import { logActivity } from '../../lib/activity-log';
import { nodeCronScheduler, type ScheduledTask, type Scheduler } from '../../lib/schedulers';
import { computeNextRun } from '../../helpers/cron.helper';
import type { JobTrigger } from '../admin/job-ledger.service';
import { windowFor, type JobDescriptor } from '../admin/job-inventory.service';

const CLEANUP_SCHEDULE = '*/5 * * * *';

/** Runs expired upload cleanup without coupling timers to StorageService. */
export class StorageCleanupSchedulerService extends BaseContext {
  protected scheduler: Scheduler = nodeCronScheduler;
  private task: ScheduledTask | null = null;
  private running = false;

  async start(): Promise<void> {
    this.stop();
    this.task = this.scheduler.schedule(CLEANUP_SCHEDULE, () => {
      void this.runOnce().catch(err => {
        logActivity('error', 'job', `[storage-cleanup] run failed: ${err?.message ?? err}`);
      });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async runOnce(trigger: JobTrigger = 'schedule'): Promise<{ ran: boolean; cleaned: number }> {
    if (this.running) return { ran: false, cleaned: 0 };
    this.running = true;
    try {
      return await this.di.JobLedgerService.record(
        'storage-cleanup',
        async () => {
          const cleaned = await this.di.StorageService.cleanupExpiredReservations();
          // Abandoned resumable uploads expire after a day. Optional so a
          // container assembled without it (unit tests) keeps the old job.
          const resumable = (await this.di.ResumableUploadService?.cleanupExpired()) ?? 0;
          const multipart = (await this.di.S3ProtocolService?.cleanupExpired()) ?? 0;
          return { ran: true, cleaned: cleaned + resumable + multipart };
        },
        trigger
      );
    } finally {
      this.running = false;
    }
  }

  /** @see JobInventoryService. */
  describe(): JobDescriptor[] {
    return [
      {
        id: 'storage-cleanup',
        name: 'Expired upload cleanup',
        kind: 'platform',
        schedule: CLEANUP_SCHEDULE,
        enabled: true,
        scheduled: this.task !== null,
        running: this.running,
        nextRunAt: this.task ? computeNextRun(CLEANUP_SCHEDULE) : null,
        maxIntervalMs: windowFor(CLEANUP_SCHEDULE),
        definition: {
          does:
            'Deletes upload sessions that were started and never completed (presigned reservations, and resumable TUS and S3 multipart uploads older than a day), and the orphaned parts behind them, so an abandoned upload does not hold storage forever.',
          source: 'apps/server/services/storage/storage-cleanup-scheduler.service.ts',
          settingsHref: null,
        },
        runnable: true,
        configurable: false,
      },
    ];
  }

  /** @see DescribesJob. Forces one pass, the same one the timer fires. */
  async runNow(): Promise<unknown> {
    return this.runOnce('manual');
  }
}
