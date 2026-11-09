import { HttpClient } from "../http/index.js";
import { settle } from "../http/utils.js";
import { MotherbaseResponse } from "../types.js";
import { StorageBucket } from "./bucket.js";
import { BucketInfo, BucketOptions } from "./types.js";
import { BUCKET_ROUTE, bucketBody } from "./utils.js";
import type { BucketName, GenericDatabase } from "../database/types.js";

const bucketPath = (id: string) => `${BUCKET_ROUTE}/${encodeURIComponent(id)}`;

/** Supabase-compatible storage client: `client.storage.from(bucket)`. */
export class StorageClient<Database = GenericDatabase> {
    constructor(
        private readonly http: HttpClient,
        private readonly baseUrl: string,
        private readonly fetchImpl: typeof fetch,
    ) { }

    /** The files of one bucket: upload, download, list, sign URLs. */
    from(bucket: BucketName<Database>): StorageBucket {
        return new StorageBucket(this.http, this.baseUrl, bucket, this.fetchImpl);
    }

    /**
     * Bucket administration, supabase-js shaped.
     *
     * Every method here needs a SECRET project API key, which is the same rule
     * Supabase applies (bucket administration is a service-role operation). With
     * a publishable key they resolve with a 401 error, so keep them in server
     * code and setup scripts, never in a browser bundle.
     */
    listBuckets(): Promise<MotherbaseResponse<BucketInfo[]>> {
        return settle(async () => (await this.http.request<{ buckets: BucketInfo[] }>(BUCKET_ROUTE)).buckets);
    }

    /** One bucket's settings. Secret key only. */
    getBucket(id: BucketName<Database>): Promise<MotherbaseResponse<BucketInfo>> {
        return settle(() => this.http.request<BucketInfo>(bucketPath(id)));
    }

    /** Create a bucket, private unless `public: true`. Secret key only. */
    createBucket(id: string, options: BucketOptions = {}): Promise<MotherbaseResponse<BucketInfo>> {
        const body = { id, ...bucketBody(options), public: options.public === true };
        return settle(() => this.http.request<BucketInfo>(BUCKET_ROUTE, { method: 'POST', body }));
    }

    /** Change a bucket's visibility, size limit or allowed file types. Secret key only. */
    updateBucket(id: BucketName<Database>, options: BucketOptions): Promise<MotherbaseResponse<BucketInfo>> {
        return settle(() => this.http.request<BucketInfo>(bucketPath(id), { method: 'PUT', body: bucketBody(options) }));
    }

    /** Delete every object in the bucket, keeping the bucket itself. */
    emptyBucket(id: BucketName<Database>): Promise<MotherbaseResponse<{ emptied: boolean; removed: number }>> {
        return settle(() => this.http.request<{ emptied: boolean; removed: number }>(`${bucketPath(id)}/empty`, { method: 'POST' }));
    }

    /**
     * Delete the bucket. A bucket that still holds objects is a `409` unless
     * `force` is set, which queues a background deletion of its contents: an
     * accidental `deleteBucket` must not be able to destroy a project's files in
     * one unqualified call.
     */
    deleteBucket(id: BucketName<Database>, options: { force?: boolean } = {}): Promise<MotherbaseResponse<{ deleted: boolean }>> {
        const query = options.force ? '?force=true' : '';
        return settle(() => this.http.request<{ deleted: boolean }>(`${bucketPath(id)}${query}`, { method: 'DELETE' }));
    }
}
