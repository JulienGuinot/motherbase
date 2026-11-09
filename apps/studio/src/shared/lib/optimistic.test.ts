import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { optimistic } from '@/shared/lib/optimistic';
import type { PgCronJob, PgCronJobsResponse } from '@/features/database/types';

const toast = { push: vi.fn() };

function job(over: Partial<PgCronJob> = {}): PgCronJob {
  return {
    jobid: 1,
    jobname: 'nightly',
    schedule: '0 3 * * *',
    command: 'SELECT 1',
    active: true,
    database: 'app',
    username: 'postgres',
    ...over,
  };
}

/**
 * The pg_cron toggle threw `jobs.map is not a function` inside `onMutate`,
 * before its HTTP request was ever sent: the updater was typed `PgCronJob[]`
 * while the cache holds `{ jobs, extensionMissing }`.
 *
 * This is the shape check that failed. It asserts against the real response
 * envelope rather than a bare array, which is the whole point: a test built on
 * the convenient shape would have gone green while the console stayed broken.
 */
describe('optimistic writes against the pg_cron response envelope', () => {
  const key = ['cron-pg-jobs'];

  function toggle(qc: QueryClient) {
    return optimistic<PgCronJobsResponse, PgCronJob>(qc, toast, key, (current, target) => ({
      ...current,
      jobs: current.jobs.map(j => (j.jobid === target.jobid ? { ...j, active: !target.active } : j)),
    }), 'Update failed');
  }

  it('patches the jobs inside the envelope and keeps the envelope', async () => {
    const qc = new QueryClient();
    qc.setQueryData<PgCronJobsResponse>(key, { jobs: [job()], extensionMissing: false });

    await toggle(qc).onMutate(job());

    const next = qc.getQueryData<PgCronJobsResponse>(key)!;
    expect(next.jobs[0].active).toBe(false);
    expect(next.extensionMissing).toBe(false);
  });

  it('puts the envelope back when the request fails', async () => {
    const qc = new QueryClient();
    const before: PgCronJobsResponse = { jobs: [job()], extensionMissing: false };
    qc.setQueryData(key, before);

    const handlers = toggle(qc);
    const context = await handlers.onMutate(job());
    handlers.onError(new Error('nope'), job(), context);

    expect(qc.getQueryData<PgCronJobsResponse>(key)).toEqual(before);
  });

  it('does nothing when the cache is empty rather than writing a partial value', async () => {
    const qc = new QueryClient();
    await toggle(qc).onMutate(job());
    expect(qc.getQueryData(key)).toBeUndefined();
  });
});
