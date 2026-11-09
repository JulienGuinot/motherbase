import type { StorageRemoveContract, StorageUploadContract } from '@motherbase/contracts';

export type FileVisibility = 'public' | 'private';

/** Lifecycle of a stored object: `ready` unless a presigned upload is pending. */
export type FileStatus = 'pending' | 'ready' | 'expired';

/**
 * A row of the storage table, as `POST /api/files/` returns it.
 *
 * This is the upload shape, not the `list()` shape: `list()` answers in the
 * supabase-js `FileObject` form, which is a different set of fields under
 * different names. Conflating the two is what the old `[key: string]: unknown`
 * hid, and `file.filename` (a field the server never sent) type-checked.
 */
export interface StoredFile {
    id: string;
    /** Bucket slug. */
    bucket: string;
    /** Object key inside the bucket, including any prefix. */
    key: string;
    mime?: string | null;
    size: number;
    visibility: FileVisibility;
    status: FileStatus;
    /** Set for public objects and for drivers that store an absolute URL. */
    url?: string | null;
    ownerId?: string | null;
    bucketId?: string | null;
    /** Deadline of a presigned upload that has not been finalised. */
    uploadExpiresAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * One object as `list()` returns it: the supabase-js `FileObject` shape, which
 * is what code ported from Supabase reads (`obj.name`, `obj.metadata.size`).
 */
export interface FileObject {
    /** Key relative to the bucket. */
    name: string;
    id: string;
    created_at: string | null;
    updated_at: string | null;
    last_accessed_at: string | null;
    metadata: {
        size: number;
        mimetype: string | null;
        cacheControl: string | null;
    };
}

/** Exact payload returned by `POST /api/files/`. */
export type StorageUploadResponse = StorageUploadContract<StoredFile>;

/** Exact payload returned by `DELETE /api/files/:id`. */
export type StorageRemoveResponse = StorageRemoveContract;

/** A file-ish value accepted by multipart uploads (browser File/Blob or RN asset). */
export type UploadInput = Blob | ArrayBuffer | ArrayBufferView | { uri: string; name?: string; type?: string };

export interface UploadOptions {
    /** Object visibility. Defaults to the backend's default (private). */
    visibility?: FileVisibility;
    /** Content type stored with the object. Overrides what the file itself declares. */
    contentType?: string;
    upsert?: boolean;
}

export interface UploadResult {
    /** The object key, exactly as passed to `upload`. */
    path: string;
    /** The server-issued file id. Still accepted anywhere a path is. */
    id: string;
    /** `bucket/key`. */
    fullPath: string;
}

/** A bucket, in the supabase-js shape. `id` is the slug. */
export interface BucketInfo {
    id: string;
    name: string;
    owner: string;
    public: boolean;
    /** Largest object the bucket accepts, in bytes. `null` defers to the project limit. */
    file_size_limit: number | null;
    /** MIME allowlist (`image/*` wildcards allowed). `null` accepts any type. */
    allowed_mime_types: string[] | null;
    created_at: string | null;
    updated_at: string | null;
}

/** supabase-js `createBucket` / `updateBucket` options. */
export interface BucketOptions {
    public?: boolean;
    name?: string;
    /** Bytes, or a string with a unit: `'20MB'`, `'1GB'`. `null` removes the limit. */
    fileSizeLimit?: number | string | null;
    /** `['image/*', 'application/pdf']`. `null` or `[]` accepts any type. */
    allowedMimeTypes?: string[] | null;
}

/** One object's metadata, in the supabase-js `info()` shape. */
export interface ObjectInfo {
    name: string;
    id: string;
    version: string | null;
    bucket_id: string;
    created_at: string | null;
    updated_at: string | null;
    last_accessed_at: string | null;
    size: number;
    content_type: string | null;
    cache_control: string | null;
    metadata: Record<string, unknown>;
}

/**
 * supabase-js image transform options. Served by `/storage/v1/render/image`,
 * resized with the same limits Supabase applies (1 to 2500 px, quality 20 to
 * 100). Without `format` the server answers WebP to clients that accept it.
 */
export interface TransformOptions {
    width?: number;
    height?: number;
    resize?: 'cover' | 'contain' | 'fill';
    quality?: number;
    format?: 'origin' | 'webp' | 'avif';
}

export interface ListOptions {
    limit?: number;
    offset?: number;
    search?: string;
    sortBy?: { column?: 'name' | 'created_at' | 'updated_at'; order?: 'asc' | 'desc' };
}
