import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALERT_RULES,
  JobLedgerService,
  evaluateAlerts,
  type AlertRules,
  type JobRun,
  type LedgerSnapshot,
} from '../services/admin/job-ledger.service';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function run(over: Partial<JobRun> & { job: string; status: JobRun['status'] }): JobRun {
  return {
    id: String(Math.random()),
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    error: null,
    output: null,
    trigger: 'schedule',
    ...over,
  };
}

const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function snapshot(runs: JobRun[], deadLetters: number | null = 0): LedgerSnapshot {
  return { now: NOW, runs, deadLetters };
}

const rules = (over: Partial<AlertRules> = {}): AlertRules => ({ ...DEFAULT_ALERT_RULES, ...over });

describe('job alert rules', () => {
  it('fires on N consecutive failures and not on N-1', () => {
    const failures = [1, 2, 3].map(i =>
      run({ job: 'backup', status: 'failed', startedAt: minutesAgo(i), error: 'disk full' })
    );
    const alerts = evaluateAlerts(snapshot(failures), rules({ backupRpoHours: 0 }));
    expect(alerts.map(a => a.kind)).toEqual(['consecutive_failures']);
    expect(alerts[0].message).toContain('disk full');

    expect(evaluateAlerts(snapshot(failures.slice(0, 2)), rules({ backupRpoHours: 0 }))).toEqual([]);
  });

  it('counts only the most recent streak, so an old failure run does not resurface', () => {
    const runs = [
      run({ job: 'backup', status: 'ok', startedAt: minutesAgo(1) }),
      run({ job: 'backup', status: 'failed', startedAt: minutesAgo(2) }),
      run({ job: 'backup', status: 'failed', startedAt: minutesAgo(3) }),
      run({ job: 'backup', status: 'failed', startedAt: minutesAgo(4) }),
    ];
    expect(evaluateAlerts(snapshot(runs), rules({ backupRpoHours: 0 }))).toEqual([]);
  });

  it('ignores a still-running attempt rather than treating it as success', () => {
    const runs = [
      run({ job: 'retention', status: 'running', startedAt: minutesAgo(1), finishedAt: null }),
      run({ job: 'retention', status: 'failed', startedAt: minutesAgo(2) }),
      run({ job: 'retention', status: 'failed', startedAt: minutesAgo(3) }),
      run({ job: 'retention', status: 'failed', startedAt: minutesAgo(4) }),
    ];
    const alerts = evaluateAlerts(snapshot(runs), rules({ backupRpoHours: 0 }));
    expect(alerts.map(a => a.kind)).toEqual(['consecutive_failures']);
  });

  it('fires when a job misses its window, and when it has never run at all', () => {
    const expectations = [{ job: 'backup', maxIntervalMs: 60 * 60_000 }];

    const late = evaluateAlerts(
      snapshot([run({ job: 'backup', status: 'ok', startedAt: minutesAgo(120), finishedAt: minutesAgo(119) })]),
      rules({ expectations, backupRpoHours: 0 })
    );
    expect(late.map(a => a.kind)).toEqual(['missed_window']);
    expect(late[0].detail.sinceMinutes).toBe(119);

    // A schedule that was never started is the common case, and reads
    // differently from one that is merely late.
    const never = evaluateAlerts(snapshot([]), rules({ expectations, backupRpoHours: 0 }));
    expect(never.map(a => a.kind)).toEqual(['missed_window']);
    expect(never[0].message).toContain('no successful run on record');

    const healthy = evaluateAlerts(
      snapshot([run({ job: 'backup', status: 'ok', startedAt: minutesAgo(10), finishedAt: minutesAgo(9) })]),
      rules({ expectations, backupRpoHours: 0 })
    );
    expect(healthy).toEqual([]);
  });

  it('fires on dead-letter depth at the threshold', () => {
    expect(evaluateAlerts(snapshot([], 100), rules({ backupRpoHours: 0 })).map(a => a.kind))
      .toEqual(['dead_letter_depth']);
    expect(evaluateAlerts(snapshot([], 99), rules({ backupRpoHours: 0 }))).toEqual([]);
  });

  it('fires when the newest backup is older than the recovery objective', () => {
    const stale = run({
      job: 'backup',
      status: 'ok',
      startedAt: new Date(NOW - 30 * 3_600_000).toISOString(),
      finishedAt: new Date(NOW - 30 * 3_600_000).toISOString(),
    });
    const alerts = evaluateAlerts(snapshot([stale]), rules({ backupRpoHours: 26 }));
    expect(alerts.map(a => a.kind)).toEqual(['backup_older_than_rpo']);
    expect(alerts[0].detail.ageHours).toBe(30);

    const fresh = run({
      job: 'backup',
      status: 'ok',
      startedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
      finishedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    });
    expect(evaluateAlerts(snapshot([fresh]), rules({ backupRpoHours: 26 }))).toEqual([]);
  });
});

describe('announcing alerts', () => {
  function serviceWith(alerts: any[]) {
    const dispatch = vi.fn(async () => {});
    const svc = new JobLedgerService({ EventDispatcherService: { dispatch } } as any);
    vi.spyOn(svc, 'alerts').mockImplementation(async () => alerts as any);
    return { svc, dispatch };
  }

  it('dispatches a new alert once, not on every poll', async () => {
    const alert = { kind: 'consecutive_failures', job: 'backup', level: 'critical', message: 'x', detail: {} };
    const { svc, dispatch } = serviceWith([alert]);

    await svc.announce();
    await svc.announce();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('job_alert', 'created', [alert]);
  });

  it('dispatches again after the alert clears and returns', async () => {
    const alert = { kind: 'consecutive_failures', job: 'backup', level: 'critical', message: 'x', detail: {} };
    const alerts: any[] = [alert];
    const dispatch = vi.fn(async () => {});
    const svc = new JobLedgerService({ EventDispatcherService: { dispatch } } as any);
    vi.spyOn(svc, 'alerts').mockImplementation(async () => alerts.slice() as any);

    await svc.announce();
    alerts.length = 0;
    await svc.announce(); // recovered: nothing to send, and the memory is cleared
    alerts.push(alert);
    await svc.announce();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('still returns the alerts it did not re-dispatch', async () => {
    const alert = { kind: 'missed_window', job: 'backup', level: 'critical', message: 'x', detail: {} };
    const { svc } = serviceWith([alert]);
    await svc.announce();
    // The Studio badge polls this: suppressing the second dispatch must not
    // suppress the alert itself, or the badge would clear while still broken.
    expect(await svc.announce()).toEqual([alert]);
  });
});

describe('dead letters that could not be measured', () => {
  it('raises no depth alert when the queue could not be read', () => {
    // `null` is "not measured". The query behind it named the wrong relation
    // for months and its catch returned 0, so a queue that was filling up
    // reported healthy. Unknown must never read as a healthy zero, and it must
    // not invent an alert either.
    const alerts = evaluateAlerts(snapshot([], null), rules({ deadLetterDepth: 100 }));
    expect(alerts.filter(a => a.kind === 'dead_letter_depth')).toHaveLength(0);
  });

  it('still raises the alert on a measured depth over the threshold', () => {
    const alerts = evaluateAlerts(snapshot([], 200), rules({ deadLetterDepth: 100 }));
    expect(alerts.filter(a => a.kind === 'dead_letter_depth')).toHaveLength(1);
  });
});

describe('default rules', () => {
  it('declares no cadence expectations and no backup objective of its own', () => {
    // Both used to be hardcoded here: an empty `expectations` meant the console
    // claimed a protection against silently stopped jobs that no rule
    // implemented, and a 26-hour RPO fired on projects that never enabled
    // automatic backups. JobInventoryService fills both from the armed schedules.
    expect(DEFAULT_ALERT_RULES.expectations).toEqual([]);
    expect(DEFAULT_ALERT_RULES.backupRpoHours).toBe(0);
    expect(evaluateAlerts(snapshot([]), DEFAULT_ALERT_RULES)).toEqual([]);
  });
});
