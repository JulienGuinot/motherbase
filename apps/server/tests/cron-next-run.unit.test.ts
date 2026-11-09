import { describe, expect, it } from 'vitest';
import { computeNextRun } from '../helpers/cron.helper';

/**
 * This used to build a task, stop it and return null unconditionally, so every
 * job in the admin panel reported "no next run". node-cron 4 answers the
 * question, so the helper does too.
 */
describe('computeNextRun', () => {
  it('returns the next occurrence as an ISO timestamp', () => {
    const next = computeNextRun('*/5 * * * *');
    expect(next).toBeTypeOf('string');
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('returns null for an expression node-cron refuses, rather than throwing', () => {
    expect(computeNextRun('not a cron expression')).toBeNull();
  });
});
