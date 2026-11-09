import { Upload } from 'tus-js-client';
import { api, withProjectPrefix } from '@/shared/lib/api';
import { auth } from '@/shared/lib/auth';
import type {
  BucketCorsConfig,
  BucketDeleteResult,
  BucketDeletionJob,
  BucketToken,
  BucketWebhook,
  CreateBucketInput,
  CreateBucketTokenInput,
  CreateBucketWebhookInput,
  CreatedS3AccessKey,
  S3AccessKey,
  S3Connection,
  StorageBucket,
  StorageFile,
  StorageFilePage,
  StorageFileQuery,
} from '@/features/storage/components/storage.types';

/** Supabase's TUS chunk size; the server stages S3 parts at the same size. */
const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;
/** Above one chunk, an upload goes resumable: a dropped connection then costs one chunk, not the file. */
export const RESUMABLE_THRESHOLD_BYTES = RESUMABLE_CHUNK_BYTES;

type UploadPayload = { file: File; bucket: string; visibility: StorageFile['visibility'] };

/** Same key shape the multipart admin upload generates, so the two paths never collide on a name. */
function generatedKey(file: File): string {
  const dot = file.name.lastIndexOf('.');
  return `${crypto.randomUUID()}${dot > 0 ? file.name.slice(dot) : ''}`;
}

export const storageApi = {
  buckets: () =>
    api.get('/admin/storage/buckets').then(r => r.data.data as StorageBucket[]),
  /**
   * One page of files, filtered by the server.
   *
   * This used to send nothing at all: the server defaults to 25 rows, and the
   * console then searched and filtered that page in the browser. From the 26th
   * file onwards an object could not be found at all, and the counters
   * described the page rather than the bucket.
   */
  files: (bucket: string | 'all', params: StorageFileQuery = {}) => {
    const url = bucket === 'all'
      ? '/admin/storage/files'
      : `/admin/storage/buckets/${bucket}/files`;
    return api
      .get(url, {
        params: {
          page: params.page ?? 1,
          pageSize: params.pageSize ?? 50,
          ...(params.q?.trim() ? { q: params.q.trim() } : {}),
          ...(params.category && params.category !== 'all' ? { category: params.category } : {}),
          ...(params.visibility && params.visibility !== 'all' ? { visibility: params.visibility } : {}),
        },
      })
      .then(r => r.data.data as StorageFilePage);
  },
  /** Deletions still running, so the screen can pick one back up after a reload. */
  bucketDeletions: () =>
    api.get('/admin/storage/bucket-deletions').then(r => r.data.data.jobs as BucketDeletionJob[]),
  cors: (bucket: string) =>
    api.get(`/admin/storage/buckets/${bucket}/cors`).then(r => r.data.data as BucketCorsConfig | null),
  tokens: (bucket: string) =>
    api.get(`/admin/storage/buckets/${bucket}/tokens`).then(r => r.data.data as BucketToken[]),
  webhooks: (bucket: string) =>
    api.get(`/admin/storage/buckets/${bucket}/webhooks`).then(r => r.data.data as BucketWebhook[]),
  s3Connection: () =>
    api.get('/admin/storage/s3').then(r => r.data.data as S3Connection),
  s3Keys: () =>
    api.get('/admin/storage/s3/keys').then(r => r.data.data.keys as S3AccessKey[]),
  /**
   * A resized copy through the admin render route. Fetched as a blob because
   * an <img src> cannot carry the Authorization header the admin API needs.
   */
  thumbnail: (id: string, width: number) =>
    api
      .get(`/admin/storage/files/${id}/render`, { params: { width, height: width, resize: 'cover' }, responseType: 'blob' })
      .then(r => r.data as Blob),
  fileUrl: (id: string) =>
    api.get(`/admin/storage/files/${id}/url`).then(r => r.data?.data?.url as string | undefined),

  createBucket: (data: CreateBucketInput) => api.post('/admin/storage/buckets', data),
  updateBucket: (slug: string, data: Omit<CreateBucketInput, 'slug' | 'quotaBytes'> & { quotaBytes: number | null }) =>
    api.patch(`/admin/storage/buckets/${slug}`, data),
  deleteBucket: (slug: string, force: boolean) =>
    api.delete('/admin/storage/buckets/' + slug + '?force=' + force)
      .then(r => r.data.data as BucketDeleteResult),
  bucketDeletion: (id: string) =>
    api.get('/admin/storage/bucket-deletions/' + id)
      .then(r => r.data.data as BucketDeletionJob),
  upsertCors: (bucket: string, data: BucketCorsConfig) =>
    api.put(`/admin/storage/buckets/${bucket}/cors`, data),
  deleteCors: (bucket: string) => api.delete(`/admin/storage/buckets/${bucket}/cors`),
  createToken: (bucket: string, data: CreateBucketTokenInput) =>
    api.post(`/admin/storage/buckets/${bucket}/tokens`, data),
  revokeToken: (bucket: string, id: string) =>
    api.delete(`/admin/storage/buckets/${bucket}/tokens/${id}`),
  addWebhook: (bucket: string, data: CreateBucketWebhookInput) =>
    api.post(`/admin/storage/buckets/${bucket}/webhooks`, data),
  removeWebhook: (bucket: string, id: string) =>
    api.delete(`/admin/storage/buckets/${bucket}/webhooks/${id}`),
  /**
   * Upload over TUS to the admin resumable endpoint, reporting progress from
   * 0 to 1. tus-js-client remembers the upload by fingerprint, so picking the
   * same file again after a failure resumes it instead of starting over.
   * Needs a bucket: a resumable upload is addressed by bucket and key.
   */
  uploadResumable: (payload: UploadPayload, onProgress: (fraction: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const upload = new Upload(payload.file, {
        // Through the same prefixing as axios, so the console proxy routes it.
        endpoint: `/api${withProjectPrefix('/admin/storage/upload/resumable')}`,
        chunkSize: RESUMABLE_CHUNK_BYTES,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        removeFingerprintOnSuccess: true,
        metadata: {
          bucketName: payload.bucket,
          objectName: generatedKey(payload.file),
          contentType: payload.file.type || 'application/octet-stream',
        },
        // Read per request: a long upload outlives the token it started with.
        onBeforeRequest: request => {
          const token = auth.getAccess();
          if (token) request.setHeader('Authorization', `Bearer ${token}`);
        },
        onProgress: (sent, total) => onProgress(total ? sent / total : 0),
        onError: reject,
        onSuccess: () => resolve(),
      });
      upload.findPreviousUploads().then(previous => {
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }, reject);
    }),
  uploadFile: (payload: UploadPayload) => {
    const form = new FormData();
    form.append('file', payload.file);
    form.append('visibility', payload.visibility);
    if (payload.bucket.trim()) form.append('bucket', payload.bucket.trim());
    return api.post('/admin/storage/files', form);
  },
  createS3Key: (description: string) =>
    api.post('/admin/storage/s3/keys', { description }).then(r => r.data.data as CreatedS3AccessKey),
  revokeS3Key: (id: string) => api.delete(`/admin/storage/s3/keys/${id}`),
  deleteFile: (id: string) => api.delete(`/admin/storage/files/${id}`),
};
