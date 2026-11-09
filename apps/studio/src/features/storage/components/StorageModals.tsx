'use client';

import { NewBucketModal } from '@/features/storage/components/NewBucketModal';
import { PreviewSheet } from '@/features/storage/components/PreviewSheet';
import { UploadModal } from '@/features/storage/components/UploadModal';
import type { useStorageController } from '@/features/storage/hooks/useStorageController';

type Storage = ReturnType<typeof useStorageController>;

/**
 * Every overlay the object store can raise. Grouped so the page reads as
 * header, files, overlays rather than as one long ladder of conditionals.
 */
export function StorageModals({ storage }: { storage: Storage }) {
  const {
    activeBucket,
    buckets,
    createBucket,
    deleteFileMutation,
    newBucketOpen,
    preview,
    previewUrl,
    setNewBucketOpen,
    setPreview,
    setUploadOpen,
    upload,
    uploadOpen,
    uploadProgress,
  } = storage;

  const scopedToBucket = activeBucket !== 'all';

  return (
    <>
      {uploadOpen && (
        <UploadModal
          saving={upload.isPending}
          progress={uploadProgress}
          defaultBucket={scopedToBucket ? activeBucket : ''}
          buckets={buckets}
          onClose={() => setUploadOpen(false)}
          onUpload={payload => upload.mutate(payload)}
        />
      )}

      {newBucketOpen && (
        <NewBucketModal
          saving={createBucket.isPending}
          existingSlugs={buckets.map(bucket => bucket.slug)}
          onClose={() => setNewBucketOpen(false)}
          onCreate={data => createBucket.mutate(data)}
        />
      )}

      {preview && (
        <PreviewSheet
          file={preview}
          url={previewUrl}
          onClose={() => setPreview(null)}
          onDelete={() => deleteFileMutation.mutate(preview.id)}
        />
      )}
    </>
  );
}
