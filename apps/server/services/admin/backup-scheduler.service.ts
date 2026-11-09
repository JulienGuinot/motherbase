import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import type { BackupScheduleConfig } from './backup.service';
import { nodeCronScheduler, type ScheduledTask, type Scheduler } from '../../lib/schedulers';
import { computeNextRun } from '../../helpers/cron.helper';
import type { JobTrigger } from './job-ledger.service';
import { windowFor, type JobDescriptor } from './job-inventory.service';

export interface BackupRunSummary {
  ran: boolean;
  file?: string;
  offsite: boolean;
  uploaded: boolean;
  prunedLocal: string[];
  prunedRemote: string[];
}

/**
 * App-level scheduler for automatic database backups. pg_cron can't run
 * pg_dump (a shell command), so this runs in-process via node-cron. Each tick:
 *   backupDatabase → (offsite) upload → pruneLocal → (offsite) pruneRemote.
 * Overlapping runs are skipped. The schedule is rebuilt live on config change.
 */
export class BackupSchedulerService extends BaseContext {
  // Overridable in tests to fire ticks deterministically.
  protected scheduler: Scheduler = nodeCronScheduler;

  private task: ScheduledTask | null = null;
  private running = false;
  private lastError: string | null = null;
  private lastRunAt: string | null = null;

  /** Start the schedule when enabled. Safe to call repeatedly. */
  async start(): Promise<void> {
    this.stop();
    const cfg = await this.di.BackupService.config();
    if (!cfg.enabled) return;
    this.task = this.scheduler.schedule(cfg.cron, () => {
      void this.runOnce().catch(err => {
        logActivity('error', 'job', `[backup] run failed: ${errorMessage(err)}`);
      });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Rebuild the schedule after a config change. */
  async reschedule(): Promise<void> {
    await this.start();
  }

  isScheduled(): boolean {
    return this.task !== null;
  }

  /**
   * Execute one backup cycle. Guards against overlapping runs (a slow dump must
   * not stack). Returns a summary; used by both the tick and the manual /run.
   */
  async runOnce(trigger: JobTrigger = 'schedule'): Promise<BackupRunSummary> {
    if (this.running) {
      return { ran: false, offsite: false, uploaded: false, prunedLocal: [], prunedRemote: [] };
    }
    this.running = true;
    try {
      return await this.di.JobLedgerService.record('backup', () => this.runCycle(), trigger);
    } finally {
      this.running = false;
    }
  }

  /** One backup cycle, with the in-memory status fields the /status route reads. */
  private async runCycle(): Promise<BackupRunSummary> {
    try {
      const cfg: BackupScheduleConfig = await this.di.BackupService.config();
      const result = await this.di.BackupService.backupDatabase();
      let uploaded = false;
      if (cfg.offsite) {
        const up = await this.di.BackupService.uploadBackup(result.file.path, result.file.name);
        uploaded = !up.skipped;
      }
      const prunedLocal = await this.di.BackupService.pruneLocal(cfg.retention);
      const prunedRemote = cfg.offsite ? await this.di.BackupService.pruneRemote(cfg.retention) : [];
      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
      return {
        ran: true,
        file: result.file.name,
        offsite: cfg.offsite,
        uploaded,
        prunedLocal,
        prunedRemote,
      };
    } catch (err) {
      this.lastError = errorMessage(err);
      this.lastRunAt = new Date().toISOString();
      throw err;
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

  /** @see DescribesJob. Forces one backup, the same cycle the timer runs. */
  async runNow(): Promise<unknown> {
    return this.runOnce('manual');
  }

  /** @see JobInventoryService. `backup` is the key this writes to the ledger. */
  async describe(): Promise<JobDescriptor[]> {
    const cfg = await this.di.BackupService.config().catch(() => null);
    const schedule = cfg?.cron ?? null;
    return [
      {
        id: 'backup',
        name: 'Automatic backup',
        kind: 'platform',
        schedule,
        enabled: !!cfg?.enabled,
        scheduled: this.isScheduled(),
        running: this.running,
        nextRunAt: this.isScheduled() && schedule ? computeNextRun(schedule) : null,
        maxIntervalMs: windowFor(schedule),
        definition: {
          does:
            'Dumps the database on its cadence and uploads the dump to the configured destination, then prunes dumps past the retention window.',
          source: 'apps/server/services/admin/backup-scheduler.service.ts',
          settingsHref: '/settings#backups',
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
