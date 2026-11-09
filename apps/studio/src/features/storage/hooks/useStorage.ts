import { useQuery, type QueryClient } from '@tanstack/react-query';
import { keepPreviousFor } from '@/shared/lib/query';
import { storageApi } from '@/features/storage/api/storage.api';
import type { StorageFileQuery } from '@/features/storage/components/storage.types';

/** Files and buckets move together: a bucket's counts are a sum over its files. */
export function refreshStorage(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['storage-files'] });
  queryClient.invalidateQueries({ queryKey: ['storage-buckets'] });
}

export function useBuckets() {
  return useQuery({
    queryKey: ['storage-buckets'],
    queryFn: storageApi.buckets,
  });
}

/**
 * One page of files for the browser, filtered and counted by the server.
 *
 * The filters are part of the key because they are part of the request: a page
 * filtered in the browser can only ever match what the first page happened to
 * contain, which is how a bucket's older files became unreachable.
 */
export function useStorageFiles(activeBucket: string | 'all', query: StorageFileQuery) {
  return useQuery({
    // Keep the previous result on screen while the new selection loads.
    placeholderData: keepPreviousFor(`${activeBucket}:${query.pageSize ?? ''}`),
    queryKey: [
      'storage-files',
      activeBucket,
      query.page ?? 1,
      query.pageSize ?? 50,
      query.q ?? '',
      query.category ?? 'all',
      query.visibility ?? 'all',
    ],
    queryFn: () => storageApi.files(activeBucket, query),
  });
}

/**
 * Deletions still in flight, whoever started them.
 *
 * The screen used to keep a single job id in component state, handed back by
 * the DELETE response: a reload, a second deletion or another tab lost the only
 * handle on a job that was still working.
 */
export function useUnfinishedBucketDeletions() {
  return useQuery({
    queryKey: ['bucket-deletions'],
    queryFn: storageApi.bucketDeletions,
    refetchInterval: 5000,
  });
}

export function useS3Connection() {
  return useQuery({ queryKey: ['storage-s3'], queryFn: storageApi.s3Connection });
}

export function useS3Keys() {
  return useQuery({ queryKey: ['storage-s3-keys'], queryFn: storageApi.s3Keys });
}

export function useFileUrl(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['file-url', id],
    queryFn: () => storageApi.fileUrl(id),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * A server-side thumbnail. `retry: false` because the usual failure is a
 * permanent one (transforms switched off, a type sharp cannot decode), and the
 * caller falls back to the full object instead of waiting on retries.
 */
export function useFileThumbnail(id: string, width: number, enabled: boolean) {
  return useQuery({
    queryKey: ['file-thumbnail', id, width],
    queryFn: () => storageApi.thumbnail(id, width),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useBucketDeletionJob(jobId: string | null) {
  return useQuery({
    queryKey: ['bucket-deletion', jobId],
    queryFn: () => storageApi.bucketDeletion(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: query => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' ? false : 1_000;
    },
  });
}
