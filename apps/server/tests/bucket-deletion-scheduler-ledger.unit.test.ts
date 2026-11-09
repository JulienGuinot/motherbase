import { describe, it, expect, vi } from 'vitest';
import { BucketDeletionSchedulerService } from '../services/storage/bucket-deletion-scheduler.service';
import type IContextContainer from '../context/icontext-container';

// bucket-deletion polls every 2s, so a ledger row per empty tick would bury the
// runs that mean something: record() only when a run actually claimed work,
// or failed outright. This pins both branches of that decision.
describe('BucketDeletionSchedulerService job ledger wiring', () => {
  function service(processNext: () => Promise<boolean>, note = vi.fn()) {
    const di = {
      BucketDeletionService: { processNext },
      JobLedgerService: { note },
    } as unknown as IContextContainer;
    return new BucketDeletionSchedulerService(di);
  }

  it('records nothing when a poll finds no work', async () => {
    const note = vi.fn();
    await service(() => Promise.resolve(false), note).runOnce();
    expect(note).not.toHaveBeenCalled();
  });

  it('records ok when a poll actually deletes something', async () => {
    const note = vi.fn();
    await service(() => Promise.resolve(true), note).runOnce();
    // The pass's own report rides along now: "claimed 2" is the only thing
    // that distinguishes a useful poll from an idle one in the drawer.
    expect(note).toHaveBeenCalledWith('bucket-deletion', 'ok', null, {
      output: { ran: true, claimed: 2 },
      trigger: 'schedule',
    });
  });

  it('records failed and rethrows when a poll errors', async () => {
    const note = vi.fn();
    const svc = service(() => Promise.reject(new Error('minio unreachable')), note);
    await expect(svc.runOnce()).rejects.toThrow('minio unreachable');
    expect(note).toHaveBeenCalledWith('bucket-deletion', 'failed', 'minio unreachable', {
      trigger: 'schedule',
    });
  });
});
