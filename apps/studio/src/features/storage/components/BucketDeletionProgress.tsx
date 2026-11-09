import type { BucketDeletionJob } from './storage.types';

interface BucketDeletionProgressProps {
  job: BucketDeletionJob;
}

export function BucketDeletionProgress({ job }: BucketDeletionProgressProps) {
  const progress = job.totalObjects === 0
    ? (job.status === 'completed' ? 100 : 0)
    : Math.min(100, Math.round((job.deletedObjects / job.totalObjects) * 100));
  const failed = job.status === 'failed';

  return (
    <div
      aria-live="polite"
      className="mx-3 rounded-lg border px-3 py-2 text-[12px]"
      style={{
        borderColor: failed ? 'var(--danger)' : 'var(--border)',
        background: 'var(--surface)',
        color: failed ? 'var(--danger)' : 'var(--text-dim)',
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <span>
          Deleting <strong>{job.bucketSlug}</strong>: {job.status}
        </span>
        <span className="mono">{job.deletedObjects}/{job.totalObjects} ({progress}%)</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
        <div
          className="h-full transition-[width]"
          style={{
            width: progress + '%',
            background: failed ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </div>
      {job.lastError && <p className="mt-2">{job.lastError}</p>}
    </div>
  );
}
