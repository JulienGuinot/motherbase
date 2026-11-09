import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import type { DataRetentionRunSummary } from './data-retention.service';
import { nodeCronScheduler, type ScheduledTask, type Scheduler } from '../../lib/schedulers';
import { computeNextRun } from '../../helpers/cron.helper';
import type { JobTrigger } from './job-ledger.service';
import { windowFor, type JobDescriptor } from './job-inventory.service';

/** One lifecycle and one cron job for all operational-log retention targets. */
export class DataRetentionSchedulerService extends BaseContext {
  protected scheduler: Scheduler = nodeCronScheduler;
  private task: ScheduledTask | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;

  async start(): Promise<void> {
    this.stop();
    if (!(await this.di.DataRetentionService.hasEnabledTarget())) return;
    const config = await this.di.DataRetentionService.config();

    this.task = this.scheduler.schedule(config.cron, () => {
      void this.runOnce().catch(error => {
        logActivity('error', 'job', `[data-retention] run failed: ${errorMessage(error)}`);
      });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async reschedule(): Promise<void> {
    await this.start();
  }

  isScheduled(): boolean {
    return this.task !== null;
  }

  async runOnce(trigger: JobTrigger = 'schedule'): Promise<DataRetentionRunSummary> {
    if (this.running) {
      return {
        ran: false,
        webhookDeliveries: { deleted: 0, batches: 0, truncated: false },
        edgeFunctionLogs: { deleted: 0, batches: 0, truncated: false },
        jobRuns: { deleted: 0, batches: 0, truncated: false },
        authAuditLogs: { deleted: 0, batches: 0, truncated: false },
        realtimeOutboxCompleted: { deleted: 0, batches: 0, truncated: false },
        realtimeOutboxFailed: { deleted: 0, batches: 0, truncated: false },
        realtimeMessages: { deleted: 0, batches: 0, truncated: false },
        requestLogs: { deleted: 0, batches: 0, truncated: false },
      };
    }

    this.running = true;
    try {
      return await this.di.JobLedgerService.record('data-retention', () => this.runCycle(), trigger);
    } finally {
      this.running = false;
    }
  }

  private async runCycle(): Promise<DataRetentionRunSummary> {
    try {
      const summary = await this.di.DataRetentionService.runOnce();
      // The realtime outbox targets were missing here, so a purge that failed
      // every night reported a clean run in the console.
      const errors = [
        summary.webhookDeliveries.error,
        summary.edgeFunctionLogs.error,
        summary.jobRuns.error,
        summary.authAuditLogs.error,
        summary.realtimeOutboxCompleted.error,
        summary.realtimeOutboxFailed.error,
        summary.requestLogs.error,
        summary.realtimeMessages.error,
      ].filter(Boolean);
      this.lastError = errors.length ? errors.join('; ') : null;
      this.lastRunAt = new Date().toISOString();
      return summary;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.lastRunAt = new Date().toISOString();
      throw error;
    }
  }

  status() {
    return {
      scheduled: this.isScheduled(),
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  /** @see DescribesJob. Forces one retention pass, the same cycle the timer runs. */
  async runNow(): Promise<unknown> {
    return this.runOnce('manual');
  }

  /** @see JobInventoryService. */
  async describe(): Promise<JobDescriptor[]> {
    const [enabled, config] = await Promise.all([
      this.di.DataRetentionService.hasEnabledTarget().catch(() => false),
      this.di.DataRetentionService.config().catch(() => null),
    ]);
    const schedule = config?.cron ?? null;
    return [
      {
        id: 'data-retention',
        name: 'Data retention',
        kind: 'platform',
        schedule,
        enabled,
        scheduled: this.isScheduled(),
        running: this.running,
        nextRunAt: this.isScheduled() && schedule ? computeNextRun(schedule) : null,
        maxIntervalMs: windowFor(schedule),
        definition: {
          does:
            'Deletes rows past the retention window configured for each enabled target, so logs and other expiring data do not grow without bound.',
          source: 'apps/server/services/admin/data-retention-scheduler.service.ts',
          settingsHref: '/settings#data.retention',
        },
        runnable: true,
        configurable: false,
        lastRunAt: this.lastRunAt,
        lastStatus: this.lastRunAt ? (this.lastError ? 'error' : 'ok') : null,
        lastError: this.lastError,
      },
    ];
  }
}
