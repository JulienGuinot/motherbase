import BaseContext from '../../context/base-context';
import { maxCronGapMs } from '../../lib/cron-cadence';
import { computeNextRun, listAppJobs } from '../../helpers/cron.helper';
import { HttpException } from '../../exceptions/http-exception';
import type { JobRun, JobSummary } from './job-ledger.service';

/**
 * What runs on a timer in this project, declared rather than inferred.
 *
 * The console used to build this list out of the ledger alone, which can only
 * show jobs that have already run at least once: a scheduler configured and
 * never fired was indistinguishable from one that does not exist. It also had
 * no idea that `edge:<id>` in the ledger and `nightly-report` in the scheduler
 * were the same job, so every scheduled function appeared twice, the second
 * time labelled as a platform internal.
 *
 * Each scheduler declares itself here, next to the code that owns its cadence.
 */

export type JobKind = 'app' | 'edge' | 'platform';

/**
 * Explicit states, so "we don't know" never renders as "fine".
 * - `disabled`  configured off, no timer armed
 * - `scheduled` armed, no run on record yet
 * - `running`   a run is in flight
 * - `ok` / `failed` outcome of the newest finished run
 * - `unknown`   armed, but its history could not be read
 */
export type JobState = 'disabled' | 'scheduled' | 'running' | 'ok' | 'failed' | 'unknown';

/**
 * What a job is, as opposed to how it last went.
 *
 * The console could say a job ran and whether it failed, and nothing at all
 * about what it does when it fires, so a row called `realtime-outbox` was a
 * name and a green tick. Each scheduler answers for itself, next to the code
 * that owns the behaviour, rather than the console keeping a table of guesses.
 */
export interface JobDefinition {
  /** What this job actually does when it fires, in one sentence. */
  does: string;
  /** The file that owns it, so the row leads to the code behind it. */
  source: string;
  /**
   * Console route that owns its configuration, or null when it is only
   * changeable in code. The drawer links here instead of duplicating six
   * settings surfaces inside itself.
   */
  settingsHref: string | null;
}

export interface JobDescriptor {
  /** Stable identity, and the exact key this job writes to the ledger under. */
  id: string;
  /** What an operator calls it. Differs from `id` for scheduled edge functions. */
  name: string;
  kind: JobKind;
  /** Cron expression when there is one, a human cadence otherwise. */
  schedule: string | null;
  /** Configured to run at all. */
  enabled: boolean;
  /** Timer armed right now. */
  scheduled: boolean;
  running: boolean;
  nextRunAt: string | null;
  /**
   * Longest gap between successes that is still healthy, in ms. Null disables
   * the cadence rule: poll loops that only record when they claimed work are
   * silent on purpose, and alerting on their silence would page for an idle
   * queue.
   */
  maxIntervalMs: number | null;
  lastRunAt?: string | null;
  lastStatus?: 'ok' | 'error' | null;
  lastError?: string | null;
  definition: JobDefinition;
  /** Whether an operator can force a run from the console. */
  runnable: boolean;
  /**
   * Whether its cadence is data this console can write. False for a schedule
   * that is a constant in code, so the drawer offers the settings link instead
   * of an input whose Save can only 400.
   */
  configurable: boolean;
}

/** A descriptor joined to whatever the ledger knows about the same id. */
export interface JobView extends Omit<JobDescriptor, 'maxIntervalMs'> {
  state: JobState;
  runs: number;
  /** False for a job seen only in the ledger: no live scheduler claims it. */
  declared: boolean;
  medianIntervalMs: number | null;
}

/** One missed cycle of slack before a schedule is called late. */
const MISSED_CYCLES = 2;

/** Anything a scheduler can answer without the inventory knowing its internals. */
export interface DescribesJob {
  describe(): Promise<JobDescriptor[]> | JobDescriptor[];
  /**
   * Run one of this source's jobs immediately, out of band of its timer.
   *
   * Optional: a source that cannot be forced simply omits it, and its
   * descriptors report `runnable: false` rather than the console offering a
   * button that 400s.
   */
  runNow?(id: string): Promise<unknown>;
  /**
   * Change one of this source's jobs in place. Absent for a scheduler whose
   * cadence is code: the drawer sends the operator to `settingsHref` instead of
   * pretending a constant is editable.
   */
  configure?(id: string, patch: JobPatch): Promise<void>;
}

/** The only two things about a job the console is allowed to change directly. */
export interface JobPatch {
  schedule?: string | null;
  enabled?: boolean;
}

/**
 * Cadence window for a cron expression, or null when it cannot be derived.
 * Exported for the schedulers that build their own descriptor.
 */
export function windowFor(cron: string | null): number | null {
  if (!cron) return null;
  const gap = maxCronGapMs(cron);
  return gap === null ? null : gap * MISSED_CYCLES;
}

/**
 * Join declared jobs to their ledger history on `id`.
 *
 * Pure so the merge can be tested against a constructed inventory instead of
 * whatever the dev database happens to hold.
 */
export function mergeJobs(descriptors: JobDescriptor[], summaries: JobSummary[], ledgerRead: boolean): JobView[] {
  const byId = new Map(summaries.map(entry => [entry.job, entry]));
  const declared = descriptors.map(descriptor => {
    const history = byId.get(descriptor.id);
    byId.delete(descriptor.id);
    const view: JobView = {
      id: descriptor.id,
      name: descriptor.name,
      kind: descriptor.kind,
      definition: descriptor.definition,
      runnable: descriptor.runnable,
      configurable: descriptor.configurable,
      schedule: descriptor.schedule,
      enabled: descriptor.enabled,
      scheduled: descriptor.scheduled,
      running: descriptor.running || history?.lastStatus === 'running',
      nextRunAt: descriptor.nextRunAt,
      state: stateOf(descriptor, history, ledgerRead),
      runs: history?.runs ?? 0,
      medianIntervalMs: history?.medianIntervalMs ?? null,
      declared: true,
      lastRunAt: history?.lastRunAt ?? descriptor.lastRunAt ?? null,
      lastStatus: lastStatusOf(descriptor, history),
      lastError: history?.lastError ?? descriptor.lastError ?? null,
    };
    return view;
  });

  // Whatever is left in the ledger is a job no live scheduler claims: a schedule
  // that has since been turned off, or one this process did not start.
  const orphans: JobView[] = Array.from(byId.values()).map(history => ({
    id: history.job,
    name: history.job,
    kind: 'platform',
    definition: {
      does: 'Unknown: this job is only remembered by the ledger, and no scheduler in this process claims it.',
      source: 'not declared by any scheduler in this build',
      settingsHref: null,
    },
    runnable: false,
    configurable: false,
    schedule: null,
    enabled: false,
    scheduled: false,
    running: history.lastStatus === 'running',
    nextRunAt: null,
    state: history.lastStatus === 'running' ? 'running' : history.lastStatus === 'failed' ? 'failed' : 'ok',
    runs: history.runs,
    medianIntervalMs: history.medianIntervalMs,
    declared: false,
    lastRunAt: history.lastRunAt,
    lastStatus: history.lastStatus === 'failed' ? 'error' : history.lastStatus === 'ok' ? 'ok' : null,
    lastError: history.lastError,
  }));

  return [...declared, ...orphans];
}

function lastStatusOf(descriptor: JobDescriptor, history?: JobSummary): 'ok' | 'error' | null {
  if (history) return history.lastStatus === 'failed' ? 'error' : history.lastStatus === 'ok' ? 'ok' : null;
  return descriptor.lastStatus ?? null;
}

function stateOf(descriptor: JobDescriptor, history: JobSummary | undefined, ledgerRead: boolean): JobState {
  if (descriptor.running || history?.lastStatus === 'running') return 'running';
  if (!descriptor.enabled) return 'disabled';
  if (history) return history.lastStatus === 'failed' ? 'failed' : 'ok';
  if (descriptor.lastStatus) return descriptor.lastStatus === 'error' ? 'failed' : 'ok';
  // Armed with no history: only "scheduled" when the history is actually empty
  // rather than unreadable.
  return ledgerRead ? 'scheduled' : 'unknown';
}

export class JobInventoryService extends BaseContext {
  /** The scheduler services that declare jobs, in one place for describe and run. */
  protected sources(): DescribesJob[] {
    return [
      this.di.BackupSchedulerService,
      this.di.DataRetentionSchedulerService,
      this.di.StorageCleanupSchedulerService,
      this.di.BucketDeletionSchedulerService,
      this.di.RealtimeOutboxSchedulerService,
      this.di.EdgeFunctionSchedulerService,
    ];
  }

  /** Every timer this process has armed, platform and user-defined alike. */
  async describe(): Promise<JobDescriptor[]> {
    const sources = this.sources();

    const described = await Promise.all(
      sources.map(async source => {
        try {
          return await source.describe();
        } catch {
          // One scheduler that cannot describe itself must not empty the list.
          return [] as JobDescriptor[];
        }
      })
    );

    // Application jobs registered through helpers/cron.helper.ts.
    const app: JobDescriptor[] = listAppJobs().map(status => ({
      id: status.name,
      name: status.name,
      kind: 'app' as const,
      schedule: status.schedule,
      enabled: true,
      scheduled: true,
      running: false,
      nextRunAt: status.nextRunAt ?? computeNextRun(status.schedule),
      maxIntervalMs: windowFor(status.schedule),
      definition: {
        does: 'Registered in application code. Its behaviour is whatever the registered callback does.',
        source: 'apps/server/helpers/cron.helper.ts',
        settingsHref: null,
      },
      // Code-registered jobs hand `register()` a closure the registry keeps no
      // handle to. Forcing one would mean holding the callback, which is a
      // change to the extension point, not to this list.
      runnable: false,
      configurable: false,
      lastRunAt: status.lastRunAt,
      lastStatus: status.lastStatus,
      lastError: status.lastError,
    }));

    return [...app, ...described.flat()];
  }

  /** The full list an operator sees: declared jobs joined to their history. */
  async list(): Promise<{ jobs: JobView[]; partial: boolean }> {
    const descriptors = await this.describe();
    let summaries: JobSummary[] = [];
    let ledgerRead = true;
    try {
      summaries = await this.di.JobLedgerService.summary();
    } catch {
      // A project that has not migrated `platform.job_runs` still gets the
      // declared jobs, but must be told its history is missing rather than
      // shown a list that silently has no outcomes in it.
      ledgerRead = false;
    }
    return { jobs: mergeJobs(descriptors, summaries, ledgerRead), partial: !ledgerRead };
  }

  /**
   * Force one job to run now.
   *
   * Routed back to the scheduler that declared the id, so the run goes through
   * exactly the same path the timer uses and lands in the ledger the same way.
   * A separate "manual" code path would be a second implementation that can
   * drift from the one that actually runs in production.
   */
  async run(id: string): Promise<{ output: unknown }> {
    const { source, descriptor } = await this.locate(id);
    if (!source.runNow || !descriptor.runnable) {
      throw new HttpException(`"${id}" cannot be run on demand`, 400);
    }
    return { output: await source.runNow(id) };
  }

  /** The scheduler that declares `id`, or a 404 naming the id that is unknown. */
  private async locate(id: string): Promise<{ source: DescribesJob; descriptor: JobDescriptor }> {
    for (const source of this.sources()) {
      let descriptors: JobDescriptor[] = [];
      try {
        // try/catch, not `.catch()`: a scheduler that throws synchronously
        // escapes a promise handler entirely, and one unreadable config must
        // not hide every job declared after it.
        descriptors = await source.describe();
      } catch {
        continue;
      }
      const descriptor = descriptors.find(d => d.id === id);
      if (descriptor) return { source, descriptor };
    }
    throw new HttpException(`unknown job "${id}"`, 404);
  }

  /**
   * Change a job's cadence or whether it is armed.
   *
   * Only sources that own their schedule as data implement this. Everything
   * else answers 400 and the console shows the link to the settings that do own
   * it, which is honest about where the value actually lives.
   */
  async configure(id: string, patch: JobPatch): Promise<void> {
    const { source } = await this.locate(id);
    if (!source.configure) {
      throw new HttpException(`"${id}" is defined in code and cannot be changed from here`, 400);
    }
    await source.configure(id, patch);
  }

  /** Recent runs of one job, newest first. */
  async runs(job: string, limit?: number): Promise<JobRun[]> {
    return this.di.JobLedgerService.list({ job, limit });
  }

  /**
   * Alert windows derived from the schedules that are armed right now.
   *
   * A disabled schedule contributes nothing: alerting on the cadence of a job
   * the operator turned off is noise, and that is precisely what a hardcoded
   * 26-hour backup objective did on projects with no automatic backup.
   */
  async alertWindows(): Promise<{
    expectations: Array<{ job: string; maxIntervalMs: number }>;
    backupRpoHours: number;
  }> {
    const descriptors = await this.describe();
    const expectations = descriptors
      .filter(d => d.enabled && d.scheduled && d.maxIntervalMs !== null)
      .map(d => ({ job: d.id, maxIntervalMs: d.maxIntervalMs as number }));

    const backup = descriptors.find(d => d.id === 'backup');
    const backupRpoHours =
      backup?.enabled && backup.scheduled && backup.maxIntervalMs !== null ? backup.maxIntervalMs / 3_600_000 : 0;

    // The backup gets its own objective; a second identical missed-window rule
    // would just page twice for one late dump.
    return { expectations: expectations.filter(e => e.job !== 'backup'), backupRpoHours };
  }
}
