import { HTTP_ROUTES } from "@motherbase/contracts";
import { BucketOptions, TransformOptions, UploadInput } from "./types.js";

/** The wire shape of BucketOptions: the snake_case keys Supabase's API uses. */
export function bucketBody(options: BucketOptions) {
    return {
        name: options.name,
        public: options.public,
        file_size_limit: options.fileSizeLimit,
        allowed_mime_types: options.allowedMimeTypes,
    };
}

/** Bucket administration lives one level up from an object route. */
export const BUCKET_ROUTE = `${HTTP_ROUTES.files}/bucket`;

export const RENDER_ROUTE = `${HTTP_ROUTES.storageV1}/render/image`;

/** `?width=…` for a transform, in the key order the server signs. */
export function transformQuery(transform: TransformOptions): string {
    const query = new URLSearchParams();
    for (const key of ['width', 'height', 'resize', 'quality', 'format'] as const) {
        if (transform[key] !== undefined) query.set(key, String(transform[key]));
    }
    return query.toString();
}

export const encodeKey = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Supabase-compatible storage bucket handle over the authenticated
 * `/api/files` endpoints.
 *
 * Objects are addressed by path: `upload('123/pic.png')` then
 * `download('123/pic.png')`. The server-issued file id still works everywhere a
 * path does, because that is what every caller written before path addressing
 * has stored.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Preserve a typed-array view's boundaries (including Node Buffer slices). */
export function uploadBlob(file: UploadInput, contentType?: string): Blob | undefined {
    if (typeof Blob !== 'undefined' && file instanceof Blob) {
        return contentType ? file.slice(0, file.size, contentType) : file;
    }
    const bytes = file instanceof ArrayBuffer ? file
        : ArrayBuffer.isView(file) ? new Uint8Array(file.buffer, file.byteOffset, file.byteLength).slice() : undefined;
    return bytes === undefined ? undefined : new Blob([bytes], { type: contentType || 'application/octet-stream' });
}
