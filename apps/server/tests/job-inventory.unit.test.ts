import { describe, expect, it } from 'vitest';
import { mergeJobs, windowFor, type JobDescriptor } from '../services/admin/job-inventory.service';
import type { JobSummary } from '../services/admin/job-ledger.service';

function descriptor(over: Partial<JobDescriptor> & { id: string }): JobDescriptor {
  return {
    name: over.id,
    kind: 'platform',
    schedule: '0 3 * * *',
    enabled: true,
    scheduled: true,
    running: false,
    nextRunAt: null,
    maxIntervalMs: null,
    definition: { does: 'test job', source: 'test', settingsHref: null },
    runnable: false,
    configurable: false,
    ...over,
  };
}

function summary(over: Partial<JobSummary> & { job: string }): JobSummary {
  return {
    lastRunAt: '2026-09-16T00:00:00.000Z',
    lastStatus: 'ok',
    lastError: null,
    runs: 3,
    medianIntervalMs: null,
    ...over,
  };
}

describe('mergeJobs', () => {
  it('joins a scheduled edge function to its ledger rows on the ledger key, not the name', () => {
    // The scheduler exposes `nightly-report`, the ledger records `edge:fn-123`.
    // Comparing those two strings is what produced two rows for one job, the
    // second labelled as a platform internal.
    const jobs = mergeJobs(
      [descriptor({ id: 'edge:fn-123', name: 'nightly-report', kind: 'edge' })],
      [summary({ job: 'edge:fn-123', lastStatus: 'failed', lastError: 'boom' })],
      true,
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('nightly-report');
    expect(jobs[0].kind).toBe('edge');
    expect(jobs[0].state).toBe('failed');
    expect(jobs[0].lastError).toBe('boom');
  });

  it('shows a scheduler that has never run, rather than omitting it', () => {
    const jobs = mergeJobs([descriptor({ id: 'backup' })], [], true);
    expect(jobs[0].state).toBe('scheduled');
    expect(jobs[0].runs).toBe(0);
  });

  it('says the history is unknown rather than "never run" when the ledger is unreadable', () => {
    const jobs = mergeJobs([descriptor({ id: 'backup' })], [], false);
    expect(jobs[0].state).toBe('unknown');
  });

  it('reports a disabled schedule as disabled, not as healthy', () => {
    const jobs = mergeJobs([descriptor({ id: 'backup', enabled: false, scheduled: false })], [], true);
    expect(jobs[0].state).toBe('disabled');
  });

  it('keeps a ledger-only job but marks it as claimed by no scheduler', () => {
    const jobs = mergeJobs([], [summary({ job: 'edge:deleted-fn' })], true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].declared).toBe(false);
    expect(jobs[0].enabled).toBe(false);
  });

  it('prefers a running descriptor over the last recorded outcome', () => {
    const jobs = mergeJobs([descriptor({ id: 'backup', running: true })], [summary({ job: 'backup' })], true);
    expect(jobs[0].state).toBe('running');
  });
});

describe('windowFor', () => {
  it('allows one whole missed cycle before a schedule is late', () => {
    // Daily backup: a 24h cadence gets a 48h window, so a run that is merely
    // late does not page, and a run that was skipped entirely does.
    //
    // Asserted as a range, not a constant: cron fires on local time, so when a
    // daylight-saving fall-back lands inside the scan window the real longest
    // gap between two 03:00 runs is 25 hours. Reporting that is the point, a
    // window built on a flat 24h would page every autumn.
    const window = windowFor('0 3 * * *')!;
    expect(window).toBeGreaterThanOrEqual(2 * 23 * 60 * 60_000);
    expect(window).toBeLessThanOrEqual(2 * 25 * 60 * 60_000);
  });

  it('has no window for a schedule it cannot read', () => {
    expect(windowFor(null)).toBeNull();
    expect(windowFor('every so often')).toBeNull();
  });
});
