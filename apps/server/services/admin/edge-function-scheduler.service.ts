import cron from 'node-cron';
import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';
import { nodeCronScheduler, type ScheduledTask, type Scheduler } from '../../lib/schedulers';
import { computeNextRun } from '../../helpers/cron.helper';
import { HttpException } from '../../exceptions/http-exception';
import type { JobTrigger } from './job-ledger.service';
import { windowFor, type JobDescriptor } from './job-inventory.service';

export interface AppJobStatus {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
}

interface Entry {
  /** Null for a function that has a schedule but is turned off: listed, not armed. */
  task: ScheduledTask | null;
  status: AppJobStatus;
  /** The ledger key this entry's runs are written under. */
  jobId: string;
  enabled: boolean;
  running: boolean;
}

/**
 * Lets an edge function run on a timer instead of (or as well as) on demand,
 * reusing the exact same Deno runtime as a normal HTTP invocation
 * (EdgeFunctionService.invoke). This is the dashboard-facing equivalent of the
 * hardcoded jobs in helpers/cron.helper.ts: since operators can already run
 * arbitrary JS from the Edge Functions page and arbitrary SQL from the SQL
 * editor, scheduling one of those same sandboxed functions isn't a new trust
 * boundary: it's just a timer on a capability that already exists.
 */
export class EdgeFunctionSchedulerService extends BaseContext {
  protected scheduler: Scheduler = nodeCronScheduler;
  private entries = new Map<string, Entry>();

  /** (Re)build every scheduled task from the current DB state. Safe to call repeatedly. */
  async start(): Promise<void> {
    this.stop();
    const fns = await this.di.EdgeFunctionService.list();
    for (const fn of fns) {
      // A disabled function that still carries a schedule is listed without a
      // timer. Dropping it made turning one off from the console look like the
      // job had been deleted, which is the opposite of what the operator did.
      if (!fn.schedule) continue;
      this.scheduleOne(fn.id, fn.name, fn.schedule, fn.enabled);
    }
  }

  stop(): void {
    for (const entry of this.entries.values()) entry.task?.stop();
    this.entries.clear();
  }

  /** Rebuild after an edge function's schedule/enabled/code changed. */
  async reschedule(): Promise<void> {
    await this.start();
  }

  listStatuses(): AppJobStatus[] {
    return Array.from(this.entries.values())
      .filter(e => e.enabled)
      .map(e => e.status);
  }

  /**
   * @see JobInventoryService.
   *
   * `id` is `edge:<functionId>`, which is the key {@link runOne} writes to the
   * ledger under, while `name` stays the function's own name. Reporting the
   * name as the identity is what made every scheduled function appear twice in
   * the console: once from this list and once from the ledger, the second copy
   * labelled as a platform internal because the two strings never matched.
   */
  describe(): JobDescriptor[] {
    return Array.from(this.entries.values()).map(entry => ({
      id: entry.jobId,
      name: entry.status.name,
      kind: 'edge' as const,
      definition: {
        does: `Invokes the edge function "${entry.status.name}" in the same Deno runtime an HTTP call would use, with an empty request body.`,
        source: `edge function "${entry.status.name}"`,
        // The function's own editor already owns its code, route and schedule.
        // Linking there beats a second editor in the drawer that can disagree
        // with it.
        settingsHref: '/edge-functions',
      },
      runnable: true,
      configurable: true,
      schedule: entry.status.schedule,
      enabled: entry.enabled,
      scheduled: entry.task !== null,
      running: entry.running,
      nextRunAt: entry.task ? computeNextRun(entry.status.schedule) : null,
      maxIntervalMs: windowFor(entry.status.schedule),
      lastRunAt: entry.status.lastRunAt,
      lastStatus: entry.status.lastStatus,
      lastError: entry.status.lastError,
    }));
  }

  /** The ledger key is `edge:<functionId>`; the entry map is keyed by the bare id. */
  private functionIdOf(id: string): string {
    return id.startsWith('edge:') ? id.slice('edge:'.length) : id;
  }

  private scheduleOne(id: string, name: string, schedule: string, enabled: boolean) {
    if (!cron.validate(schedule)) {
      logActivity(
        'warn',
        'job',
        `[edge-function-scheduler] invalid cron expression for "${name}": "${schedule}". Skipping`,
      );
      return;
    }
    const status: AppJobStatus = {
      name,
      schedule,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
    };
    // The callback closes over `entry`, which is built from the task the
    // callback belongs to. Declared first, assigned once.
    const entry = { status, jobId: `edge:${id}`, enabled, running: false } as Entry;
    // `runOne` rejects now that a manual run has to surface its failure to the
    // caller. The timer must still swallow it: an unhandled rejection here
    // takes the process down, and the failure is already in the ledger.
    entry.task = enabled
      ? this.scheduler.schedule(schedule, () => { void this.runOne(id, entry).catch(() => {}); })
      : null;
    this.entries.set(id, entry);
  }

  /**
   * @see ConfiguresJob.
   *
   * A scheduled edge function is the one kind of job whose cadence is data
   * rather than code, so it is the one the console can change in place. The
   * write goes through EdgeFunctionService, the same path its own editor uses,
   * and then rebuilds the timers: a schedule saved but not rearmed is exactly
   * the silent-job failure this inventory exists to make visible.
   */
  async configure(id: string, patch: { schedule?: string | null; enabled?: boolean }): Promise<void> {
    const functionId = this.functionIdOf(id);
    if (patch.schedule !== undefined && patch.schedule !== null && !cron.validate(patch.schedule)) {
      throw new HttpException(`"${patch.schedule}" is not a valid cron expression`, 400);
    }
    await this.di.EdgeFunctionService.update(functionId, {
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    await this.reschedule();
  }

  /**
   * @see DescribesJob.
   *
   * `id` is the ledger key (`edge:<functionId>`), which is what the console
   * holds; the entry map is keyed by the bare function id.
   */
  async runNow(id: string): Promise<unknown> {
    const functionId = this.functionIdOf(id);
    const entry = this.entries.get(functionId);
    if (!entry) throw new HttpException(`"${id}" is not a scheduled edge function`, 404);
    return this.runOne(functionId, entry, 'manual');
  }

  private async runOne(id: string, entry: Entry, trigger: JobTrigger = 'schedule'): Promise<unknown> {
    const status = entry.status;
    entry.running = true;
    try {
      const result = await this.di.EdgeFunctionService.invoke(id, {});
      status.lastRunAt = new Date().toISOString();
      status.lastStatus = result.error ? 'error' : 'ok';
      status.lastError = result.error ?? null;
      // `stdout` and the returned value are the whole point of a test run, and
      // both were discarded the moment the status flag was set. Recorded even
      // for a failed run: what the function logged before it threw is the most
      // useful thing there is about a failure.
      await this.di.JobLedgerService.note(entry.jobId, result.error ? 'failed' : 'ok', result.error ?? null, {
        output: {
          durationMs: result.durationMs,
          status: result.response?.status,
          stdout: result.stdout || undefined,
          value: result.value,
        },
        trigger,
      });
      return result;
    } catch (err) {
      status.lastRunAt = new Date().toISOString();
      status.lastStatus = 'error';
      status.lastError = errorMessage(err);
      await this.di.JobLedgerService.note(entry.jobId, 'failed', status.lastError, { trigger });
      throw err;
    } finally {
      entry.running = false;
    }
  }
}
