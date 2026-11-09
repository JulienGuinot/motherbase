'use client';

import { Plus } from 'lucide-react';
import { EmptyState } from '@/shared/ui/EmptyState';
import { BucketSkeletons } from '@/features/storage/components/BucketSkeletons';
import { QuotaBar } from '@/features/storage/components/QuotaBar';
import { StorageFileGrid } from '@/features/storage/components/StorageFileGrid';
import { StorageFileTable } from '@/features/storage/components/StorageFileTable';
import { StorageToolbar } from '@/features/storage/components/StorageToolbar';
import type { StorageBucket, StorageFile } from '@/features/storage/components/storage.types';

/** Why the file area is empty: no files at all, or none matching the filters. */
function emptyMessage(totalFiles: number, allBuckets: boolean): string {
  if (totalFiles > 0) return 'No files match your filters.';
  return allBuckets ? 'No files yet. Upload one to get started.' : 'This bucket is empty. Upload a file to get started.';
}

export function BucketFilesPanel({
  buckets,
  loadingBuckets,
  activeBucket,
  activeBucketData,
  files,
  totalFiles,
  loadingFiles,
  filesLoaded,
  controls,
  onCreateBucket,
  onBucketSettings,
  onPreview,
  onOpenExternal,
  onDelete,
  onContextMenu,
}: {
  buckets: unknown[];
  loadingBuckets: boolean;
  activeBucket: string;
  activeBucketData: StorageBucket | null;
  files: StorageFile[];
  totalFiles: number;
  loadingFiles: boolean;
  filesLoaded: boolean;
  controls: React.ComponentProps<typeof StorageToolbar>;
  onCreateBucket: () => void;
  onBucketSettings: () => void;
  onPreview: (file: StorageFile) => void;
  onOpenExternal: (file: StorageFile) => void;
  onDelete: (file: StorageFile) => void;
  onContextMenu: (event: React.MouseEvent, file: StorageFile) => void;
}) {
  if (loadingBuckets) return <BucketSkeletons />;

  if (buckets.length === 0) {
    return (
      <EmptyState
        className="card"
        mascot="bucket"
        title="No buckets yet"
        description="Buckets group your objects and carry their own visibility, CORS, tokens and quota. Create one to start uploading files."
        action={
          <button onClick={onCreateBucket} className="btn btn-primary">
            <Plus size={12} /> Create your first bucket
          </button>
        }
      />
    );
  }

  return (
    <>
      {activeBucket !== 'all' && activeBucketData && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[18px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
              {activeBucketData.name}
            </h2>
            {activeBucketData.description && (
              <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
                {activeBucketData.description}
              </p>
            )}
          </div>
          <button className="btn" onClick={onBucketSettings}>Bucket settings</button>
        </div>
      )}

      {activeBucketData?.quotaBytes && (
        <QuotaBar usedBytes={activeBucketData.totalBytes} quotaBytes={Number(activeBucketData.quotaBytes)} />
      )}

      <StorageToolbar {...controls} />

      {controls.view === 'grid' ? (
        <StorageFileGrid files={files} onOpen={onPreview} onContextMenu={onContextMenu} />
      ) : (
        <StorageFileTable
          files={files}
          onOpen={onPreview}
          onOpenExternal={onOpenExternal}
          onDelete={onDelete}
          onContextMenu={onContextMenu}
        />
      )}

      {loadingFiles && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="shimmer aspect-square" />
          ))}
        </div>
      )}

      {filesLoaded && files.length === 0 && (
        <p className="card p-12 text-center text-sm" style={{ color: 'var(--text-mute)' }}>
          {emptyMessage(totalFiles, activeBucket === 'all')}
        </p>
      )}
    </>
  );
}
