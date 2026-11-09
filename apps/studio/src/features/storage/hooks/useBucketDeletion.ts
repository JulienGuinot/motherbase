import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { storageApi } from '@/features/storage/api/storage.api';
import { refreshStorage, useBucketDeletionJob, useUnfinishedBucketDeletions } from '@/features/storage/hooks/useStorage';
import { useToast } from '@/shared/lib/toast';

/**
 * Deleting a bucket, which for a bucket with objects in it is a queued job, and
 * following that job to its end with one toast per outcome.
 */
export function useBucketDeletion(onDeleted: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const notifiedStatus = useRef<string | null>(null);

  // After a reload the local job id is gone, but the queue is durable and the
  // job is still working, so a running one is picked back up. Derived, not
  // stored: there is no second source of truth to keep in sync.
  const unfinished = useUnfinishedBucketDeletions();
  const running = unfinished.data?.find(job => job.status === 'queued' || job.status === 'running');
  const jobQuery = useBucketDeletionJob(jobId ?? running?.id ?? null);

  useEffect(() => {
    const job = jobQuery.data;
    if (!job || notifiedStatus.current === job.status) return;
    if (job.status === 'completed') {
      notifiedStatus.current = job.status;
      refreshStorage(queryClient);
      toast.push({ kind: 'success', title: 'Bucket deleted' });
    } else if (job.status === 'failed') {
      notifiedStatus.current = job.status;
      toast.push({
        kind: 'error',
        title: 'Bucket deletion failed',
        message: job.lastError ?? 'Retry the deletion to resume.',
      });
    }
  }, [jobQuery.data, queryClient, toast]);

  const deleteBucket = useMutation({
    mutationFn: ({ slug, force }: { slug: string; force: boolean }) => storageApi.deleteBucket(slug, force),
    onSuccess: result => {
      onDeleted();
      if (result.job) {
        notifiedStatus.current = null;
        setJobId(result.job.id);
        queryClient.setQueryData(['bucket-deletion', result.job.id], result.job);
        toast.push({ kind: 'info', title: 'Bucket deletion queued' });
        return;
      }
      refreshStorage(queryClient);
      toast.push({ kind: 'success', title: 'Bucket deleted' });
    },
    onError: error => toast.push({ kind: 'error', title: 'Delete failed', message: getErrorMessage(error) }),
  });

  return { deleteBucket, deletionJobQuery: jobQuery };
}
