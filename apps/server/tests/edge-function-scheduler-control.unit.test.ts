import { describe, it, expect, vi } from 'vitest';

import { EdgeFunctionSchedulerService } from '../services/admin/edge-function-scheduler.service';
import type { Scheduler } from '../lib/schedulers';
import type IContextContainer from '../context/icontext-container';

type Fn = { id: string; name: string; schedule: string | null; enabled: boolean };

function harness(fns: Fn[]) {
  const ticks = new Map<string, () => void>();
  const scheduler: Scheduler = {
    schedule: (expr, fn) => {
      ticks.set(expr, fn);
      return { stop: () => {} };
    },
  };
  const update = vi.fn(async (id: string, patch: Partial<Fn>) => {
    const fn = fns.find(f => f.id === id);
    if (fn) Object.assign(fn, patch);
  });
  const invoke = vi.fn(async () => ({ value: { rows: 2 }, stdout: 'hello', error: null, durationMs: 12 }));
  const note = vi.fn(async () => {});

  const di = {
    EdgeFunctionService: { list: async () => fns, update, invoke },
    JobLedgerService: { note },
  } as unknown as IContextContainer;

  class Testable extends EdgeFunctionSchedulerService {
    constructor() {
      super(di);
      this.scheduler = scheduler;
    }
  }
  return { service: new Testable(), update, invoke, note, ticks };
}

describe('scheduled edge functions in the console', () => {
  it('still lists a scheduled function that is turned off, without arming it', async () => {
    const { service } = harness([
      { id: 'fn1', name: 'nightly-report', schedule: '0 2 * * *', enabled: false },
    ]);
    await service.start();

    const [job] = service.describe();
    // Dropping it made disarming a job from the console look like deleting it.
    expect(job.id).toBe('edge:fn1');
    expect(job.enabled).toBe(false);
    expect(job.scheduled).toBe(false);
    expect(job.nextRunAt).toBeNull();
  });

  it('arms a scheduled function that is on', async () => {
    const { service } = harness([
      { id: 'fn1', name: 'nightly-report', schedule: '0 2 * * *', enabled: true },
    ]);
    await service.start();

    const [job] = service.describe();
    expect(job.scheduled).toBe(true);
    expect(job.configurable).toBe(true);
    expect(job.runnable).toBe(true);
  });

  it('rejects an invalid cron expression instead of silently leaving the job unarmed', async () => {
    const { service, update } = harness([
      { id: 'fn1', name: 'nightly-report', schedule: '0 2 * * *', enabled: true },
    ]);
    await service.start();

    await expect(service.configure('edge:fn1', { schedule: 'every tuesday' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('saves a new cadence and rearms the timer, so the saved value is the one running', async () => {
    const { service, update } = harness([
      { id: 'fn1', name: 'nightly-report', schedule: '0 2 * * *', enabled: true },
    ]);
    await service.start();

    await service.configure('edge:fn1', { schedule: '*/15 * * * *' });

    expect(update).toHaveBeenCalledWith('fn1', { schedule: '*/15 * * * *' });
    expect(service.describe()[0].schedule).toBe('*/15 * * * *');
  });

  it('records what a forced run printed and returned, tagged manual', async () => {
    const { service, invoke, note } = harness([
      { id: 'fn1', name: 'nightly-report', schedule: '0 2 * * *', enabled: true },
    ]);
    await service.start();

    await service.runNow('edge:fn1');

    expect(invoke).toHaveBeenCalledWith('fn1', {});
    const [job, status, error, options] = note.mock.calls[0] as unknown as [
      string,
      string,
      string | null,
      { output: { stdout?: string }; trigger: string },
    ];
    expect([job, status, error]).toEqual(['edge:fn1', 'ok', null]);
    expect(options.trigger).toBe('manual');
    expect(options.output.stdout).toBe('hello');
  });

  it('404s a function that is not scheduled here', async () => {
    const { service } = harness([]);
    await service.start();
    await expect(service.runNow('edge:gone')).rejects.toMatchObject({ statusCode: 404 });
  });
});
