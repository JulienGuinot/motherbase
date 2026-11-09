import { describe, it, expect, vi } from 'vitest';

import {
  JobInventoryService,
  type DescribesJob,
  type JobDescriptor,
} from '../services/admin/job-inventory.service';
import { describeOutput } from '../services/admin/job-ledger.service';
import type IContextContainer from '../context/icontext-container';

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
    runnable: true,
    configurable: false,
    ...over,
  };
}

/**
 * A JobInventoryService whose only sources are the ones a test hands it, so the
 * routing can be exercised without standing up six real schedulers.
 */
function inventoryOf(...sources: DescribesJob[]): JobInventoryService {
  class Testable extends JobInventoryService {
    protected override sources(): DescribesJob[] {
      return sources;
    }
  }
  return new Testable({} as IContextContainer);
}

describe('running a job on demand', () => {
  it('routes the run to the scheduler that declared the id', async () => {
    const runNow = vi.fn().mockResolvedValue({ ran: true, cleaned: 4 });
    const other = { describe: () => [descriptor({ id: 'backup' })], runNow: vi.fn() };
    const owner = { describe: () => [descriptor({ id: 'storage-cleanup' })], runNow };

    const result = await inventoryOf(other, owner).run('storage-cleanup');

    expect(runNow).toHaveBeenCalledWith('storage-cleanup');
    expect(other.runNow).not.toHaveBeenCalled();
    expect(result).toEqual({ output: { ran: true, cleaned: 4 } });
  });

  it('refuses a job whose source cannot force a run, rather than reporting a run that did not happen', async () => {
    const source = { describe: () => [descriptor({ id: 'cleanup-tokens', runnable: false })] };
    await expect(inventoryOf(source).run('cleanup-tokens')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s an id no scheduler claims', async () => {
    const source = { describe: () => [descriptor({ id: 'backup' })], runNow: vi.fn() };
    await expect(inventoryOf(source).run('edge:gone')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps looking when one source cannot describe itself', async () => {
    const runNow = vi.fn().mockResolvedValue(null);
    const broken: DescribesJob = {
      describe: () => {
        throw new Error('config unreadable');
      },
    };
    const owner = { describe: () => [descriptor({ id: 'backup' })], runNow };

    await inventoryOf(broken, owner).run('backup');
    expect(runNow).toHaveBeenCalledWith('backup');
  });
});

describe('configuring a job', () => {
  it('refuses a job whose cadence is a constant in code', async () => {
    const source = { describe: () => [descriptor({ id: 'storage-cleanup', configurable: false })] };
    await expect(inventoryOf(source).configure('storage-cleanup', { schedule: '0 5 * * *' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('passes the patch to the source that owns the job', async () => {
    const configure = vi.fn().mockResolvedValue(undefined);
    const source = {
      describe: () => [descriptor({ id: 'edge:fn1', kind: 'edge' as const, configurable: true })],
      configure,
    };

    await inventoryOf(source).configure('edge:fn1', { schedule: '0 5 * * *', enabled: false });
    expect(configure).toHaveBeenCalledWith('edge:fn1', { schedule: '0 5 * * *', enabled: false });
  });
});

describe('describeOutput', () => {
  it('renders what a job returned', () => {
    expect(describeOutput({ ran: true, cleaned: 2 })).toBe('{\n  "ran": true,\n  "cleaned": 2\n}');
  });

  it('keeps a string as it is', () => {
    expect(describeOutput('deleted 4 objects')).toBe('deleted 4 objects');
  });

  it('is null for a job that returned nothing, so the drawer shows no empty block', () => {
    expect(describeOutput(undefined)).toBeNull();
    expect(describeOutput(null)).toBeNull();
    expect(describeOutput('')).toBeNull();
  });

  it('costs the output rather than the run when the value cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeOutput(cyclic)).toBeNull();
    expect(describeOutput({ big: 1n })).toBeNull();
  });
});
