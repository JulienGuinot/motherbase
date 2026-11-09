import { describe, expect, it, vi } from 'vitest';
import { runBucketBatch } from './bucket-batch';

describe('runBucketBatch', () => {
  it('retains successful tokens and identifies failed buckets without retrying writes', async () => {
    const targets = ['avatars', 'documents', 'images'].map(slug => ({ slug, name: slug }));
    const action = vi.fn(async (slug: string) => {
      if (slug === 'documents') throw new Error('Permission denied');
      return slug + '-secret';
    });
    const result = await runBucketBatch(targets, action);
    expect(result.succeeded.map(item => [item.bucket.slug, item.value])).toEqual([
      ['avatars', 'avatars-secret'], ['images', 'images-secret'],
    ]);
    expect(result.failed).toEqual([{ bucket: targets[1], error: expect.any(Error) }]);
    expect(action).toHaveBeenCalledTimes(3);
  });
});
