export interface StorageFile {
  id: string;
  bucket: string;
  bucketId: string | null;
  key: string;
  mime: string | null;
  size: number;
  visibility: 'public' | 'private';
  ownerEmail: string | null;
  createdAt: string;
}

export interface StorageBucket {
  id: string;
  slug: string;
  name: string;
  visibility: 'public' | 'private';
  quotaBytes: number | null;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[];
  fileCount: number;
  totalBytes: number;
  description: string | null;
}

/** What the server matched, not what this page happens to hold. */
export interface StorageFilePage {
  rows: StorageFile[];
  /** Files matching the current filters across every page. */
  total: number;
  page: number;
  pageSize: number;
  /** Bytes across every matching file, not just this page. */
  totalSize: number;
}

export interface StorageFileQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  category?: FileCategoryFilter;
  visibility?: VisibilityFilter;
}

export type BucketModal = 'edit' | 'cors' | 'tokens' | 'webhooks' | 'delete';
export type FileCategory = 'image' | 'video' | 'audio' | 'doc' | 'archive' | 'other';
export type FileCategoryFilter = 'all' | FileCategory;
export type StorageView = 'grid' | 'list';
export type VisibilityFilter = 'all' | StorageFile['visibility'];

type BucketDeletionStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface BucketDeletionJob {
  id: string;
  bucketSlug: string;
  status: BucketDeletionStatus;
  totalObjects: number;
  deletedObjects: number;
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BucketDeleteResult {
  deleted: boolean;
  job?: BucketDeletionJob;
}

export interface CreateBucketInput {
  slug: string;
  name: string;
  description?: string;
  visibility: StorageFile['visibility'];
  /** `null` clears a quota on edit. */
  quotaBytes?: number | null;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[];
}

export interface BucketCorsConfig {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAgeSec: number;
}

export interface BucketToken {
  id: string;
  name: string;
  permissions: string[];
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateBucketTokenInput {
  name: string;
  permissions: string[];
  expiresAt?: string;
}

export interface BucketWebhook {
  id: string;
  url: string;
  events: string[];
  /** Signs every delivery (Standard Webhooks headers). */
  secret: string;
}

export interface CreateBucketWebhookInput {
  url: string;
  events: string[];
}

export interface S3Connection {
  enabled: boolean;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
}

export interface S3AccessKey {
  id: string;
  accessKeyId: string;
  description: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The secret exists only in this response; the server keeps it encrypted and never returns it again. */
export interface CreatedS3AccessKey {
  key: S3AccessKey;
  secretAccessKey: string;
}
