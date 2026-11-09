import { describe, expect, it, vi } from 'vitest';
import { BucketService } from '../services/storage/bucket.service';

describe('BucketService.list', () => {
  it('runs the bucket and file-stats queries together and merges them', async () => {
    let release!: () => void;
    const findMany = vi.fn(() => new Promise<any[]>(resolve => (release = () => resolve([{ id: 'b1' }, { id: 'b2' }]))));
    const groupBy = vi.fn(async () => [{ bucketId: 'b1', _count: { id: 3 }, _sum: { size: 10 } }]);
    const service = new BucketService({ prisma: { bucket: { findMany }, file: { groupBy } } } as any);

    const result = service.list();
    await Promise.resolve();
    expect(groupBy).toHaveBeenCalled();
    release();

    await expect(result).resolves.toEqual([
      { id: 'b1', fileCount: 3, totalBytes: BigInt(10) },
      { id: 'b2', fileCount: 0, totalBytes: BigInt(0) },
    ]);
  });
});
