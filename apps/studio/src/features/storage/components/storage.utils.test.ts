import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { optimistic } from '@/shared/lib/optimistic';
import { withoutS3Key } from '@/features/storage/components/storage.utils';
import type { S3AccessKey } from '@/features/storage/components/storage.types';

const key = (id: string): S3AccessKey => ({
  id,
  accessKeyId: `AK${id}`,
  description: id,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
});

describe('revoking an S3 access key optimistically', () => {
  const cacheKey = ['storage-s3-keys'];
  const setup = () => {
    const qc = new QueryClient();
    const before = [key('a'), key('b')];
    qc.setQueryData(cacheKey, before);
    const toast = { push: vi.fn() };
    return { qc, before, toast, handlers: optimistic<S3AccessKey[], string>(qc, toast, cacheKey, withoutS3Key, 'Revoke failed') };
  };

  it('drops the key from the list straight away', async () => {
    const { qc, handlers } = setup();
    await handlers.onMutate('a');
    expect(qc.getQueryData<S3AccessKey[]>(cacheKey)?.map(k => k.id)).toEqual(['b']);
  });

  it('puts the key back when the server refuses', async () => {
    const { qc, before, toast, handlers } = setup();
    const context = await handlers.onMutate('a');
    handlers.onError(new Error('nope'), 'a', context);
    expect(qc.getQueryData(cacheKey)).toEqual(before);
    expect(toast.push).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});
