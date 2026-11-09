import { contractPath, HTTP_ROUTES } from "@motherbase/contracts";
import { HttpClient } from "../http/index.js";
import { settle, toError, withoutTrailingSlash } from "../http/utils.js";
import { MotherbaseResponse } from "../types.js";
import { FileObject, FileVisibility, ListOptions, ObjectInfo, StorageRemoveResponse, StorageUploadResponse, TransformOptions, UploadInput, UploadOptions, UploadResult } from "./types.js";
import { UUID, uploadBlob, RENDER_ROUTE, encodeKey, transformQuery } from "./utils.js";

export class StorageBucket {
    constructor(
        private readonly http: HttpClient,
        private readonly baseUrl: string,
        private readonly bucket: string,
        /** Used only by `uploadToSignedUrl`, which PUTs straight to object storage. */
        private readonly fetchImpl: typeof fetch,
    ) { }

    /**
     * Route for one object. A bare uuid is treated as a file id (the pre-path
     * addressing form, which existing callers have stored); anything else is a
     * key inside this bucket.
     */
    private objectPath(pathOrId: string, kind: 'object' | 'object-url' | 'object-info'): string {
        if (UUID.test(pathOrId)) {
            if (kind === 'object-info') {
                throw new Error('info() addresses objects by path. Pass the key you uploaded under, not a file id.');
            }
            return contractPath.file(pathOrId, kind === 'object-url' ? 'url' : 'raw');
        }
        return `${HTTP_ROUTES.files}/${kind}/${encodeURIComponent(this.bucket)}/${encodeKey(pathOrId)}`;
    }

    /**
     * Store a file at `path` in this bucket. `upsert: true` replaces an object
     * already stored there.
     * @example client.storage.from('avatars').upload(`${userId}/me.png`, file, { contentType: 'image/png' })
     */
    upload(
        path: string,
        file: UploadInput,
        options: UploadOptions = {},
    ): Promise<MotherbaseResponse<UploadResult>> {
        return settle(async () => {
            const form = new FormData();
            const body = uploadBlob(file, options.contentType);
            if (body) {
                form.append('file', body, path);
            } else {
                form.append('file', file as unknown as Blob);
            }
            if (options.visibility) form.append('visibility', options.visibility);
            form.append('bucket', this.bucket);
            form.append('path', path);
            if (options.upsert) form.append('upsert', 'true');
            const created = await this.http.request<StorageUploadResponse>(`${HTTP_ROUTES.files}/`, { method: 'POST', form });
            return { path, id: created.file.id, fullPath: `${this.bucket}/${path}` };
        });
    }

    /**
     * Upload several objects, a few at a time, reporting progress per file.
     *
     * Uploading a folder is the common case and `Promise.all` is the common
     * mistake: a hundred parallel multipart posts saturate the connection, and
     * the server rate limiter answers 429 to the tail of them. Four at a time
     * finishes sooner in practice and fails less.
     *
     * One failing file does not cancel the rest. The result reports every entry
     * in the order it was given, each with its own error or `null`, so the caller
     * can retry exactly what failed.
     *
     * ponytail: progress is per file, not per byte. Byte-level progress needs
     * XMLHttpRequest, which does not exist outside a browser; if a progress bar
     * has to move within one large file, that is the upgrade path.
     */
    async uploadMany(
        files: Array<{ path: string; file: UploadInput; options?: UploadOptions }>,
        options: {
            /** Uploads in flight at once. Default 4. */
            concurrency?: number;
            /** Called after each file settles, with how many have settled so far. */
            onProgress?: (progress: { completed: number; total: number; path: string; error: string | null }) => void;
        } = {},
    ): Promise<MotherbaseResponse<Array<{ path: string; data: UploadResult | null; error: string | null }>>> {
        const total = files.length;
        const requestedConcurrency = options.concurrency ?? 4;
        if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
            return { data: null, error: { message: 'concurrency must be a positive integer.' } };
        }
        const concurrency = Math.min(requestedConcurrency, total || 1);
        const results = new Array<{ path: string; data: UploadResult | null; error: string | null }>(total);
        let next = 0;
        let completed = 0;

        // A shared cursor rather than fixed slices: one slow file would otherwise
        // hold up its whole slice while other workers sit idle.
        const worker = async (): Promise<void> => {
            for (; ;) {
                const index = next++;
                if (index >= total) return;
                const entry = files[index];
                const { data, error } = await this.upload(entry.path, entry.file, entry.options);
                results[index] = { path: entry.path, data: data ?? null, error: error?.message ?? null };
                completed += 1;
                options.onProgress?.({ completed, total, path: entry.path, error: error?.message ?? null });
            }
        };

        await Promise.all(Array.from({ length: concurrency }, worker));
        return { data: results, error: null };
    }

    /** The object's bytes. With `transform`, a resized image from the render endpoint instead. */
    download(path: string, options: { transform?: TransformOptions } = {}): Promise<MotherbaseResponse<Blob>> {
        return settle(async () => {
            const route = options.transform
                ? `${RENDER_ROUTE}/authenticated/${encodeURIComponent(this.bucket)}/${encodeKey(path)}?${transformQuery(options.transform)}`
                : this.objectPath(path, 'object');
            const res = await this.http.requestRaw(route);
            return res.blob();
        });
    }

    /** Delete these objects. One result per path, in the same order. */
    remove(paths: string[]): Promise<MotherbaseResponse<StorageRemoveResponse[]>> {
        return settle(() => Promise.all(
            paths.map(p => this.http.request<StorageRemoveResponse>(
                // A file id deletes through the id route, unlike objectPath's `raw`.
                UUID.test(p) ? contractPath.file(p) : this.objectPath(p, 'object'),
                { method: 'DELETE' },
            )),
        ));
    }

    /** Objects under a prefix, in the Supabase response shape. */
    list(prefix = '', options: ListOptions = {}): Promise<MotherbaseResponse<FileObject[]>> {
        return settle(async () => {
            const query = new URLSearchParams();
            if (prefix) query.set('prefix', prefix);
            if (options.limit !== undefined) query.set('limit', String(options.limit));
            if (options.offset !== undefined) query.set('offset', String(options.offset));
            if (options.search) query.set('search', options.search);
            if (options.sortBy?.column) query.set('sortColumn', options.sortBy.column);
            if (options.sortBy?.order) query.set('sortOrder', options.sortBy.order);
            const suffix = query.toString() ? `?${query}` : '';

            const res = await this.http.request<{ objects: FileObject[] }>(
                `${HTTP_ROUTES.files}/list/${encodeURIComponent(this.bucket)}${suffix}`,
            );
            return res.objects;
        });
    }

    /**
     * Synchronous public URL (Supabase parity). Serves through the public bucket
     * endpoint, or through the render endpoint when `transform` is given.
     */
    getPublicUrl(path: string, options: { transform?: TransformOptions } = {}): { data: { publicUrl: string } } {
        const base = withoutTrailingSlash(this.baseUrl);
        const publicUrl = options.transform
            ? `${base}${RENDER_ROUTE}/public/${encodeURIComponent(this.bucket)}/${encodeKey(path)}?${transformQuery(options.transform)}`
            : `${base}${contractPath.publicFile(this.bucket, path)}`;
        return { data: { publicUrl } };
    }

    /**
     * A download URL for the object, valid for `expiresIn` seconds (default 3600,
     * maximum 7 days: the AWS SigV4 ceiling; anything outside that is a `400`).
     *
     * `expiresAt` reports when the URL actually stops working, and is `null` when
     * nothing expires: a public object's URL is permanent, and a private object on
     * the `local` storage driver resolves to the authenticated streaming endpoint,
     * which is bound to the session rather than to a clock and so cannot be handed
     * to a third party at all. Check it rather than assuming `expiresIn` applied,
     * that assumption is exactly what this used to get wrong, silently.
     */
    async createSignedUrl(
        path: string,
        expiresIn?: number,
        options: { transform?: TransformOptions } = {},
    ): Promise<MotherbaseResponse<{ signedUrl: string; expiresAt: string | null }>> {
        if (options.transform && UUID.test(path)) {
            return { data: null, error: { message: 'Transforms address objects by path. Pass the key you uploaded under, not a file id.' } };
        }
        return settle(async () => {
            // With a transform the server signs a render URL, which always expires,
            // whatever the driver: an S3 presign cannot carry a resize.
            const query = new URLSearchParams(options.transform ? transformQuery(options.transform) : '');
            if (expiresIn !== undefined) query.set('expiresIn', String(expiresIn));
            const suffix = query.toString() ? `?${query}` : '';
            const res = await this.http.request<{ url: string; expiresAt: string | null }>(
                `${this.objectPath(path, 'object-url')}${suffix}`,
            );
            return { signedUrl: res.url, expiresAt: res.expiresAt ?? null };
        });
    }

    /**
     * Sign several objects in one call.
     *
     * There is no batch endpoint behind this: it signs each key and reports per
     * entry, exactly as supabase-js does, so one missing object yields one entry
     * with an `error` rather than failing the whole batch.
     */
    async createSignedUrls(
        paths: string[],
        expiresIn?: number,
    ): Promise<MotherbaseResponse<Array<{ path: string; signedUrl: string | null; error: string | null }>>> {
        const results = await Promise.all(
            paths.map(async path => {
                const { data, error } = await this.createSignedUrl(path, expiresIn);
                return { path, signedUrl: data?.signedUrl ?? null, error: error?.message ?? null };
            }),
        );
        return { data: results, error: null };
    }

    /**
     * Replace the object at `path`. In supabase-js `update` is `upload` with
     * upsert forced on, and the same is true here.
     */
    async update(path: string, file: UploadInput, options: UploadOptions = {}): Promise<MotherbaseResponse<UploadResult>> {
        return this.upload(path, file, { ...options, upsert: true });
    }

    /** Copy an object to another key in this bucket. */
    async copy(from: string, to: string, options: { upsert?: boolean } = {}): Promise<MotherbaseResponse<{ path: string }>> {
        return this.transfer('copy', from, to, options);
    }

    /** Move an object to another key in this bucket (copy, then delete the source). */
    async move(from: string, to: string, options: { upsert?: boolean } = {}): Promise<MotherbaseResponse<{ path: string }>> {
        return this.transfer('move', from, to, options);
    }

    private transfer(
        action: 'copy' | 'move',
        from: string,
        to: string,
        options: { upsert?: boolean },
    ): Promise<MotherbaseResponse<{ path: string }>> {
        return settle(async () => {
            const res = await this.http.request<{ path: string; id: string; fullPath: string }>(
                `${HTTP_ROUTES.files}/${action}`,
                { method: 'POST', body: { bucket: this.bucket, from, to, upsert: options.upsert === true } },
            );
            return { path: res.fullPath ?? `${this.bucket}/${to}` };
        });
    }

    /** One object's metadata, without downloading it. */
    info(path: string): Promise<MotherbaseResponse<ObjectInfo>> {
        return settle(() => this.http.request<ObjectInfo>(this.objectPath(path, 'object-info')));
    }

    /**
     * Whether an object exists and this caller can read it.
     *
     * A 404 is the answer `false`, not a failure. Anything else (a 403, a network
     * error) is reported as an error rather than as "no": treating an
     * authorization failure as absence is how a UI ends up offering to create
     * something that is already there.
     */
    async exists(path: string): Promise<MotherbaseResponse<boolean>> {
        const { data, error } = await this.info(path);
        if (data) return { data: true, error: null };
        if (error?.status === 404) return { data: false, error: null };
        return { data: null, error: error ?? { message: 'Unknown storage error' } };
    }

    /**
     * Mint a URL the browser can PUT the bytes to directly, skipping this server.
     *
     * Unlike supabase-js this needs the file's `size` and content type up front:
     * the upload is reserved against the bucket quota and the signature is bound
     * to that exact length, which is what stops a signed URL from becoming an
     * unbounded write. Pair it with `uploadToSignedUrl`.
     *
     * Requires the S3 driver; the local driver has no presigned uploads.
     */
    createSignedUploadUrl(
        path: string,
        options: { size: number; contentType?: string; visibility?: FileVisibility },
    ): Promise<MotherbaseResponse<{ signedUrl: string; token: string; path: string }>> {
        return settle(async () => {
            const res = await this.http.request<{ file: { id: string }; uploadUrl: string; finalizeToken?: string }>(
                `${HTTP_ROUTES.files}/presign`,
                {
                    method: 'POST',
                    body: {
                        bucket: this.bucket,
                        path,
                        size: options.size,
                        mime: options.contentType,
                        visibility: options.visibility,
                    },
                },
            );
            // supabase-js's `token` is opaque to the caller and is handed straight
            // back to uploadToSignedUrl, so it carries what finalisation needs.
            const token = JSON.stringify({ url: res.uploadUrl, id: res.file.id, finalizeToken: res.finalizeToken, contentType: options.contentType, path, bucket: this.bucket });
            return { signedUrl: res.uploadUrl, token, path };
        });
    }

    /**
     * Upload to a URL from `createSignedUploadUrl`: PUT the bytes to storage,
     * then tell the server the object landed. The finalise step is what makes the
     * row readable, so a PUT that succeeds and a finalise that fails leaves the
     * reservation to expire rather than a half-visible object.
     */
    async uploadToSignedUrl(
        path: string,
        token: string,
        file: UploadInput,
        options: { contentType?: string } = {},
    ): Promise<MotherbaseResponse<UploadResult>> {
        let parsed: { url: string; id: string; finalizeToken?: string; contentType?: string; path?: string; bucket?: string };
        try {
            const value = JSON.parse(token);
            if (!value || typeof value !== 'object' || typeof value.url !== 'string' || typeof value.id !== 'string' || !value.id
                || !['http:', 'https:'].includes(new URL(value.url).protocol)
                || (value.path !== undefined && value.path !== path)
                || (value.bucket !== undefined && value.bucket !== this.bucket)
                || (value.contentType !== undefined && typeof value.contentType !== 'string')
                || (value.finalizeToken !== undefined && typeof value.finalizeToken !== 'string')) throw new Error('Invalid upload token');
            parsed = value;
        } catch {
            return { data: null, error: { message: 'Invalid upload token. Use the token from createSignedUploadUrl().' } };
        }
        try {
            const body = uploadBlob(file, options.contentType ?? parsed.contentType);
            if (!body) throw new Error('Signed uploads require a Blob, ArrayBuffer or typed array.');
            const put = await this.fetchImpl(parsed.url, {
                method: 'PUT',
                body,
                headers: { 'Content-Type': body.type || 'application/octet-stream' },
            });
            if (!put.ok) {
                return { data: null, error: { message: `Upload failed with status ${put.status}`, status: put.status } };
            }
            await this.http.request(`${contractPath.file(parsed.id)}/finalize`, { method: 'POST', body: { token: parsed.finalizeToken } });
            return { data: { path, id: parsed.id, fullPath: `${this.bucket}/${path}` }, error: null };
        } catch (err) {
            return { data: null, error: toError(err) };
        }
    }
}
