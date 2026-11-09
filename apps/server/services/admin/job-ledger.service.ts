import BaseContext from '../../context/base-context';
import { errorMessage } from '../../lib/errors';
import { logActivity } from '../../lib/activity-log';

/**
 * A ledger of scheduler runs, and the alerts derived from it.
 *
 * The schedulers already tracked `lastRunAt` and `lastError` in memory, which
 * answers "did the last run fail" and nothing else. It cannot answer the two
 * questions that actually matter operationally: has this job failed repeatedly,
 * and has it stopped running at all. A job that silently stops firing looks
 * identical to a healthy one from in-memory state, because nothing writes the
 * failure.
 *
 * So runs are persisted, and every scheduler records through the same wrapper.
 * One wrapper rather than an insert per scheduler: a ledger that some jobs write
 * to and others forget is worse than none, because the gaps read as silence.
 */

export type JobStatus = 'running' | 'ok' | 'failed';

/** What started a run. A manual test must not read as proof the timer fired. */
export type JobTrigger = 'schedule' | 'manual';

export interface JobRun {
  id: string;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  status: JobStatus;
  error: string | null;
  /** The run's own report of what it did. Null for runs recorded before this existed. */
  output: string | null;
  trigger: JobTrigger;
}

type JobAlertKind =
  | 'consecutive_failures'
  | 'missed_window'
  | 'dead_letter_depth'
  | 'backup_older_than_rpo';

export interface JobAlert {
  kind: JobAlertKind;
  job: string;
  level: 'critical' | 'warning';
  message: string;
  /** Machine-readable context, kept small: this is embedded in webhook payloads. */
  detail: Record<string, string | number>;
}

/** What a job promises about its own cadence, so a missed window is detectable. */
interface JobExpectation {
  job: string;
  /** Longest gap between successful runs that is still healthy. */
  maxIntervalMs: number;
}

export interface AlertRules {
  consecutiveFailures: number;
  deadLetterDepth: number;
  /** Recovery point objective for backups, in hours. 0 disables the rule. */
  backupRpoHours: number;
  expectations: JobExpectation[];
}

/**
 * Thresholds only. `expectations` and `backupRpoHours` are deliberately empty
 * and zero here: a window invented by this file is a window nobody configured,
 * and would alert on projects that never enabled automatic backups. `rulesFor()`
 * fills both from the schedules that are actually armed.
 */
export const DEFAULT_ALERT_RULES: AlertRules = {
  consecutiveFailures: 3,
  deadLetterDepth: 100,
  backupRpoHours: 0,
  expectations: [],
};

/** One job as the ledger knows it: its latest run and its observed cadence. */
export interface JobSummary {
  job: string;
  lastRunAt: string;
  lastStatus: JobStatus;
  lastError: string | null;
  runs: number;
  /** Median gap between recent starts, or null with fewer than two runs. */
  medianIntervalMs: number | null;
}

/** Everything the rules need, gathered once so they can be evaluated purely. */
export interface LedgerSnapshot {
  now: number;
  runs: JobRun[];
  /** Undeliverable realtime events, or null when the depth could not be read. */
  deadLetters: number | null;
}

const TABLE = 'platform.job_runs';
const MAX_ERROR_LENGTH = 2_000;
/** Batch size for `prune`, which has no cap of its own. The scheduled path goes
 *  through DataRetentionService and uses the operator's configured size. */
const PRUNE_BATCH_SIZE = 500;
/** Generous, but bounded: the drawer renders this, and one run must not be a page. */
const MAX_OUTPUT_LENGTH = 8_000;

/** Whatever a job returned, as something an operator can read. */
export function describeOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.slice(0, MAX_OUTPUT_LENGTH) || null;
  try {
    return JSON.stringify(value, null, 2)?.slice(0, MAX_OUTPUT_LENGTH) ?? null;
  } catch {
    // A cycle or a BigInt must cost the output, never the run.
    return null;
  }
}

const COLUMNS = 'id, job, started_at, finished_at, status, error, output, trigger';

function toRun(row: any): JobRun {
  return {
    id: String(row.id),
    job: row.job,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    status: row.status,
    error: row.error ?? null,
    output: row.output ?? null,
    trigger: row.trigger === 'manual' ? 'manual' : 'schedule',
  };
}

/**
 * Pure rule evaluation, separated from the queries so every rule can be tested
 * against a constructed history rather than against whatever the dev database
 * happens to contain.
 */
export function evaluateAlerts(snapshot: LedgerSnapshot, rules: AlertRules): JobAlert[] {
  const alerts: JobAlert[] = [];
  const byJob = new Map<string, JobRun[]>();
  for (const run of snapshot.runs) {
    const list = byJob.get(run.job) ?? [];
    list.push(run);
    byJob.set(run.job, list);
  }
  // Newest first, so "consecutive failures" means the most recent ones.
  for (const list of byJob.values()) {
    list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  for (const [job, runs] of byJob) {
    let streak = 0;
    for (const run of runs) {
      if (run.status === 'failed') streak++;
      else if (run.status === 'ok') break;
      // A still-running attempt neither breaks nor extends the streak.
    }
    if (streak >= rules.consecutiveFailures) {
      alerts.push({
        kind: 'consecutive_failures',
        job,
        level: 'critical',
        message: `${job} has failed ${streak} times in a row. Last error: ${runs[0]?.error ?? 'unknown'}`,
        detail: { failures: streak, threshold: rules.consecutiveFailures },
      });
    }
  }

  for (const expectation of rules.expectations) {
    const runs = byJob.get(expectation.job) ?? [];
    const lastOk = runs.find(run => run.status === 'ok');
    const since = lastOk ? snapshot.now - Date.parse(lastOk.finishedAt ?? lastOk.startedAt) : Infinity;
    if (since <= expectation.maxIntervalMs) continue;
    alerts.push({
      kind: 'missed_window',
      job: expectation.job,
      level: 'critical',
      // A job that has never run is the more common case in practice: the
      // schedule was never started, or was started and immediately threw.
      message: lastOk
        ? `${expectation.job} last succeeded ${Math.round(since / 60_000)} minutes ago, past its ${Math.round(
            expectation.maxIntervalMs / 60_000
          )} minute window.`
        : `${expectation.job} has no successful run on record, and one was expected every ${Math.round(
            expectation.maxIntervalMs / 60_000
          )} minutes.`,
      detail: {
        maxIntervalMinutes: Math.round(expectation.maxIntervalMs / 60_000),
        sinceMinutes: Number.isFinite(since) ? Math.round(since / 60_000) : -1,
      },
    });
  }

  // `null` is "not measured", which must not read as a healthy zero: that is
  // exactly how a queue of undeliverable events stayed invisible behind a
  // mistyped relation name.
  if (rules.deadLetterDepth > 0 && snapshot.deadLetters !== null && snapshot.deadLetters >= rules.deadLetterDepth) {
    alerts.push({
      kind: 'dead_letter_depth',
      job: 'realtime-outbox',
      level: 'warning',
      message: `${snapshot.deadLetters} realtime events have exhausted their retries and will not be delivered.`,
      detail: { depth: snapshot.deadLetters, threshold: rules.deadLetterDepth },
    });
  }

  if (rules.backupRpoHours > 0) {
    const runs = byJob.get('backup') ?? [];
    const lastOk = runs.find(run => run.status === 'ok');
    const ageMs = lastOk ? snapshot.now - Date.parse(lastOk.finishedAt ?? lastOk.startedAt) : Infinity;
    if (ageMs > rules.backupRpoHours * 3_600_000) {
      alerts.push({
        kind: 'backup_older_than_rpo',
        job: 'backup',
        level: 'critical',
        message: lastOk
          ? `The newest backup is ${Math.round(ageMs / 3_600_000)} hours old, past the ${rules.backupRpoHours} hour objective.`
          : `No successful backup is on record, and the objective is ${rules.backupRpoHours} hours.`,
        detail: {
          rpoHours: rules.backupRpoHours,
          ageHours: Number.isFinite(ageMs) ? Math.round(ageMs / 3_600_000) : -1,
        },
      });
    }
  }

  return alerts;
}

export class JobLedgerService extends BaseContext {
  /** Alerts already announced, so a persistent failure is not re-sent every poll. */
  private announced = new Set<string>();

  /**
   * Run `fn`, recording the attempt either way.
   *
   * The row is written before the work starts, not after: a process killed
   * mid-run must leave a `running` row behind rather than no row at all, because
   * "no row" is indistinguishable from "never scheduled".
   */
  async record<T>(job: string, fn: () => Promise<T>, trigger: JobTrigger = 'schedule'): Promise<T> {
    const id = await this.begin(job, trigger);
    const started = Date.now();
    try {
      const result = await fn();
      // What the job returned is the only description of a *successful* run
      // there is, and it was being dropped on the floor.
      await this.finish(id, 'ok', null, describeOutput(result));
      logActivity('info', 'job', `[job:${job}] ok in ${Date.now() - started}ms`);
      return result;
    } catch (error) {
      const message = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
      await this.finish(id, 'failed', message, null);
      logActivity('error', 'job', `[job:${job}] failed after ${Date.now() - started}ms, ${message}`);
      throw error;
    }
  }

  private async begin(job: string, trigger: JobTrigger = 'schedule'): Promise<string | null> {
    try {
      const rows = await this.di.prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO ${TABLE} (job, status, trigger) VALUES ($1, 'running', $2) RETURNING id`,
        job,
        trigger
      );
      return String(rows[0]?.id ?? '');
    } catch {
      // The ledger must never take a scheduler down with it. A missing table on
      // an instance that has not migrated yet degrades to no ledger, not to a
      // backup that stops running.
      return null;
    }
  }

  private async finish(
    id: string | null,
    status: JobStatus,
    error: string | null,
    output: string | null
  ): Promise<void> {
    if (!id) return;
    try {
      await this.di.prisma.$executeRawUnsafe(
        `UPDATE ${TABLE} SET status = $1, error = $2, output = $3, finished_at = now() WHERE id = $4::bigint`,
        status,
        error,
        output,
        id
      );
    } catch {
      /* see begin() */
    }
  }

  /**
   * Record a run that has already happened.
   *
   * `record()` cannot be used everywhere: a poll-loop scheduler wakes far more
   * often than it does work, and a ledger row per empty tick would bury the runs
   * that mean something. Those callers decide after the fact whether the pass
   * was worth recording, and report it here.
   */
  async note(
    job: string,
    status: Exclude<JobStatus, 'running'>,
    error?: string | null,
    options: { output?: unknown; trigger?: JobTrigger } = {}
  ): Promise<void> {
    logActivity(
      status === 'failed' ? 'error' : 'info',
      'job',
      `[job:${job}] ${status}${error ? `, ${String(error).slice(0, MAX_ERROR_LENGTH)}` : ''}`
    );
    try {
      await this.di.prisma.$executeRawUnsafe(
        `INSERT INTO ${TABLE} (job, status, error, output, trigger, finished_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
        job,
        status,
        error ? String(error).slice(0, MAX_ERROR_LENGTH) : null,
        describeOutput(options.output),
        options.trigger ?? 'schedule'
      );
    } catch {
      /* see begin() */
    }
  }

  async list(options: { job?: string; limit?: number } = {}): Promise<JobRun[]> {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const rows = options.job
      ? await this.di.prisma.$queryRawUnsafe<any[]>(
          `SELECT ${COLUMNS} FROM ${TABLE}
            WHERE job = $1 ORDER BY started_at DESC LIMIT ${limit}`,
          options.job
        )
      : await this.di.prisma.$queryRawUnsafe<any[]>(
          `SELECT ${COLUMNS} FROM ${TABLE}
            ORDER BY started_at DESC LIMIT ${limit}`
        );
    return rows.map(toRun);
  }

  /**
   * The newest `perJob` runs of every job the ledger has seen.
   *
   * Partitioned per job rather than a flat `ORDER BY started_at DESC LIMIT n`,
   * which would let a frequent job evict an infrequent one from the window: 500
   * realtime passes would push the nightly backup out and fire the RPO rule on
   * a backup that finished minutes ago.
   */
  async recentByJob(perJob = 20): Promise<JobRun[]> {
    const limit = Math.min(Math.max(Math.floor(Number(perJob)) || 1, 1), 100);
    const rows = await this.di.prisma.$queryRawUnsafe<any[]>(
      `SELECT ${COLUMNS} FROM (
         SELECT ${COLUMNS},
                row_number() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
           FROM ${TABLE}
       ) ranked WHERE rn <= ${limit} ORDER BY started_at DESC`
    );
    return rows.map(toRun);
  }

/**
   * One entry per job the ledger has ever seen, newest run first.
   *
   * The platform's own schedulers (storage-cleanup, backup, data-retention,
   * realtime-outbox, …) record here but never register in
   * `helpers/cron.helper.ts`, whose registry is what `/cron/app/jobs` listed.
   * So the console showed "No app jobs registered" while the log stream filled
   * with `[job:storage-cleanup] ok in 16ms` every five minutes: a job the
   * operator can read about and cannot find. This is where they come from.
   */
  async summary(): Promise<JobSummary[]> {
    const runs = await this.recentByJob();
    const byJob = new Map<string, JobRun[]>();
    for (const run of runs) {
      const list = byJob.get(run.job) ?? [];
      list.push(run);
      byJob.set(run.job, list);
    }

    return Array.from(byJob.entries())
      .map(([job, history]) => {
        // `list` is already newest first, so gaps are between consecutive entries.
        const gaps = history
          .slice(0, 12)
          .map(run => Date.parse(run.startedAt))
          .flatMap((at, index, all) => (index + 1 < all.length ? [at - all[index + 1]] : []))
          .sort((a, b) => a - b);
        const last = history[0];
        return {
          job,
          lastRunAt: last.startedAt,
          lastStatus: last.status,
          lastError: last.error,
          runs: history.length,
          // The observed cadence, not a declared one: these schedulers hold
          // their interval in code, and a number this screen made up would be
          // worse than the one the ledger can actually show.
          medianIntervalMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
        };
      })
      .sort((a, b) => Date.parse(b.lastRunAt) - Date.parse(a.lastRunAt));
  }

  /** Runs are read once and the rules applied to that one snapshot. */
  async snapshot(): Promise<LedgerSnapshot> {
    const [runs, deadLetters] = await Promise.all([this.recentByJob(), this.deadLetterDepth()]);
    return { now: Date.now(), runs, deadLetters };
  }

  /**
   * Depth of the undeliverable realtime queue, or null when it cannot be read.
   *
   * Through the Prisma delegate rather than raw SQL, so the compiler checks the
   * relation name. A failure is reported as unknown, never as zero: a zero would
   * make a filling queue read healthy.
   */
  private async deadLetterDepth(): Promise<number | null> {
    try {
      return await this.di.prisma.realtimeOutbox.count({ where: { status: 'failed' } });
    } catch {
      return null;
    }
  }

  /**
   * Thresholds plus the windows the armed schedules actually imply.
   *
   * Without this, `expectations` is empty in production and the console claims a
   * protection against silently stopped jobs that no rule implements.
   */
  async rulesFor(overrides: Partial<AlertRules> = {}): Promise<AlertRules> {
    let derived: Pick<AlertRules, 'expectations' | 'backupRpoHours'> = { expectations: [], backupRpoHours: 0 };
    try {
      derived = await this.di.JobInventoryService.alertWindows();
    } catch {
      // No inventory (a scheduler that failed to start, a project mid-migration)
      // means no cadence rules, never an invented one.
    }
    return { ...DEFAULT_ALERT_RULES, ...derived, ...overrides };
  }

  async alerts(rules?: AlertRules): Promise<JobAlert[]> {
    return evaluateAlerts(await this.snapshot(), rules ?? (await this.rulesFor()));
  }

  /**
   * Evaluate and announce. Each distinct alert is dispatched once until it
   * clears: an operator paged every minute for the same broken cron stops
   * reading the alerts, which is the failure mode this is meant to avoid.
   */
  async announce(rules?: AlertRules): Promise<JobAlert[]> {
    const alerts = await this.alerts(rules);
    const keys = new Set(alerts.map(alert => `${alert.kind}:${alert.job}`));

    const fresh = alerts.filter(alert => !this.announced.has(`${alert.kind}:${alert.job}`));
    for (const alert of fresh) {
      logActivity(alert.level === 'critical' ? 'error' : 'warn', 'job', `[alert:${alert.kind}] ${alert.message}`);
    }
    if (fresh.length) {
      // Delivered through the project's own webhooks, as `job_alert.created`, so
      // there is no second notification mechanism to configure or to keep alive.
      await this.di.EventDispatcherService.dispatch('job_alert', 'created', fresh);
    }

    for (const key of this.announced) {
      if (!keys.has(key)) this.announced.delete(key);
    }
    for (const key of keys) this.announced.add(key);

    return alerts;
  }

  /**
   * Delete up to `batchSize` of the oldest runs before `cutoff`.
   *
   * The only statement in the codebase that removes a ledger row, so
   * DataRetentionService drives it through the same bounded-batch loop as the
   * log tables instead of owning a second DELETE against this table.
   *
   * Returns 0 rather than throwing on a missing or drifted table, for the same
   * reason `record` does: the ledger degrades to "no ledger", it never takes
   * the caller down.
   */
  async pruneBatch(cutoff: Date, batchSize: number): Promise<number> {
    try {
      return await this.di.prisma.$executeRawUnsafe(
        `DELETE FROM ${TABLE}
           WHERE id IN (
             SELECT id FROM ${TABLE}
             WHERE started_at < $1::timestamptz
             ORDER BY started_at, id
             LIMIT $2
           )`,
        cutoff.toISOString(),
        batchSize
      );
    } catch {
      return 0;
    }
  }

  /** Trim the ledger to `retentionDays`, in bounded batches. */
  async prune(retentionDays: number): Promise<number> {
    const days = Math.max(1, Math.floor(retentionDays));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (;;) {
      const count = await this.pruneBatch(cutoff, PRUNE_BATCH_SIZE);
      deleted += count;
      if (count < PRUNE_BATCH_SIZE) return deleted;
    }
  }
}
