import path from 'path';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { Server, type ServerOptions } from '@tus/server';
import { S3Store } from '@tus/s3-store';
import { FileStore } from '@tus/file-store';
import type { Upload } from '@tus/utils';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import { logActivity } from '../../lib/activity-log';
import { errorMessage } from '../../lib/errors';
import type { FileAccessScope } from './storage.service';

/** Supabase's chunk size, and what its docs tell tus-js-client to use. */
export const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;
/** An unfinished upload is resumable for a day, as on Supabase. */
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
/**
 * Where partial uploads live until they finish, named so no object key can
 * collide with it (stored keys always start with a bucket slug): a prefix in
 * the private physical bucket on S3, a directory under the storage root
 * locally. Locally it has to be the store's own directory rather than a
 * prefix, because the file store only lists its top level when expiring.
 */
const STAGING = '.resumable';
const UPLOAD_ID = /^[0-9a-f-]{36}$/;

/** The caller of a resumable request, attached by the route before tus runs. */
const SCOPE = Symbol('storage.resumable.scope');
type ScopedRequest = IncomingMessage & { [SCOPE]?: FileAccessScope };

export function attachResumableScope(req: IncomingMessage, scope: FileAccessScope): void {
  (req as ScopedRequest)[SCOPE] = scope;
}

/** What an upload was created by. Stored with the upload, compared on every later request. */
export function ownerTag(scope: FileAccessScope): string {
  if (scope.caller?.serviceRole) return 'service';
  if (scope.userId) return `user:${scope.userId}`;
  return 'anon';
}

/**
 * The object an upload targets, read from Supabase's metadata keys
 * (`bucketName`, `objectName`, `contentType`) and its `x-upsert` header.
 */
export function parseUploadTarget(metadata: Upload['metadata'], upsertHeader: string | null) {
  const bucketName = metadata?.bucketName?.trim();
  const objectName = metadata?.objectName?.trim();
  if (!bucketName || !objectName) {
    throw new HttpException('Upload-Metadata must carry bucketName and objectName', 400);
  }
  return {
    bucketName,
    objectName,
    contentType: metadata?.contentType?.trim() || 'application/octet-stream',
    upsert: upsertHeader === 'true',
  };
}

type Mount = 'public' | 'admin';
/** Both stores can read an assembled upload back, which the base StagingStore does not promise. */
type StagingStore = S3Store | FileStore;

/**
 * Resumable uploads over TUS 1.0.0, at Supabase's `/storage/v1/upload/resumable`
 * (and an admin twin for the Studio).
 *
 * @tus/server speaks the protocol (creation, PATCH offsets, HEAD, termination,
 * expiration) and @tus/s3-store or @tus/file-store hold the partial bytes, so
 * this class owns only what is Motherbase's:
 *
 * - At creation, `StorageService.preflightUpload` answers everything the final
 *   write would refuse (size and MIME limits, key collision, RLS policy,
 *   quota), so a client learns it is refused before sending the bytes.
 * - Every later request must come from whoever created the upload.
 * - On the last byte, the assembled object is streamed through
 *   `StorageService.upload`, the same path a multipart POST takes, so the row,
 *   quota, webhook and policies are exactly those of any other upload. The
 *   staging copy is then removed.
 *
 * ponytail: finishing reads the staged object back once. A same-driver copy
 * (S3 CopyObject, a local rename) would skip that, at the cost of a second
 * finalisation path to keep in step with `upload()`.
 */
export class ResumableUploadService extends BaseContext {
  private staging?: { store: StagingStore; prefix: string };
  private readonly servers = new Map<Mount, Server>();

  private store(): StagingStore {
    return this.stagingArea().store;
  }

  private stagingArea(): { store: StagingStore; prefix: string } {
    if (this.staging) return this.staging;
    this.staging = env.STORAGE_DRIVER === 's3'
      ? { prefix: `${STAGING}/`, store: new S3Store({
          partSize: RESUMABLE_CHUNK_BYTES,
          expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS,
          s3ClientConfig: {
            bucket: env.S3_BUCKET || 'uploads',
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT || undefined,
            forcePathStyle: Boolean(env.S3_ENDPOINT),
            credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
          },
        }) }
      : { prefix: '', store: new FileStore({
          directory: path.resolve(env.STATIC_PATH || 'uploads', STAGING),
          expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS,
        }) };
    return this.staging;
  }

  /** Serve one TUS request. `basePath` is the mount the router answers on. */
  async handle(mount: Mount, basePath: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.server(mount, basePath).handle(req, res);
  }

  /** Drop expired partial uploads. Called by the storage cleanup scheduler. */
  async cleanupExpired(): Promise<number> {
    return this.store().deleteExpired();
  }

  private server(mount: Mount, basePath: string): Server {
    const existing = this.servers.get(mount);
    if (existing) return existing;
    const server = new Server({ ...this.options(mount, basePath), datastore: this.store() });
    this.servers.set(mount, server);
    return server;
  }

  private options(mount: Mount, basePath: string): Omit<ServerOptions, 'locker'> {
    const { prefix } = this.stagingArea();
    const scopeOf = (req: { runtime?: { node?: { req: unknown } } }): FileAccessScope =>
      (req.runtime?.node?.req as ScopedRequest | undefined)?.[SCOPE] ?? {};

    return {
      path: basePath,
      maxSize: env.MAX_UPLOAD_BYTES,
      // CORS stays with the app-wide middleware, which already answered the
      // preflight. tus would otherwise stamp `*` over the configured origin.
      allowedOrigins: () => false,
      // Ids carry the staging prefix; URLs do not, so an id stays one path segment.
      namingFunction: () => `${prefix}${randomUUID()}`,
      getFileIdFromRequest: (_req, lastPath) => (lastPath && UPLOAD_ID.test(lastPath) ? `${prefix}${lastPath}` : undefined),
      generateUrl: (_req, { proto, host, path: base, id }) => {
        const segment = id.slice(prefix.length);
        // The admin mount is reached through the console proxy under another
        // prefix, so it answers a path-relative Location that resolves against
        // whichever URL the client used. tus-js-client resolves it that way.
        return mount === 'admin' ? `${path.posix.basename(base)}/${segment}` : `${proto}://${host}${base}/${segment}`;
      },

      onIncomingRequest: async (req, id) => {
        if (req.method === 'POST') return;
        const upload = await this.store().getUpload(id);
        if (upload.metadata?.owner !== ownerTag(scopeOf(req))) {
          throw { status_code: 404, body: 'Upload not found\n' };
        }
      },

      onUploadCreate: async (req, upload) => {
        if (upload.sizeIsDeferred) throw { status_code: 400, body: 'Upload-Length is required\n' };
        const scope = scopeOf(req);
        const target = parseUploadTarget(upload.metadata, req.headers.get('x-upsert'));
        await this.di.StorageService.preflightUpload({
          ownerId: scope.userId,
          bucketSlug: target.bucketName,
          objectKey: target.objectName,
          size: upload.size,
          mime: target.contentType,
          upsert: target.upsert,
          scope,
        });
        return {
          metadata: {
            ...upload.metadata,
            contentType: target.contentType,
            upsert: String(target.upsert),
            owner: ownerTag(scope),
          },
        };
      },

      onUploadFinish: async (req, upload) => {
        const scope = scopeOf(req);
        const target = parseUploadTarget(upload.metadata, upload.metadata?.upsert ?? null);
        const store = this.store();
        try {
          const body = await store.read(upload.id);
          await this.di.StorageService.upload({
            ownerId: scope.userId,
            filename: path.posix.basename(target.objectName),
            body,
            size: upload.size ?? 0,
            mime: target.contentType,
            bucketSlug: target.bucketName,
            objectKey: target.objectName,
            upsert: target.upsert,
            scope,
          });
        } finally {
          // Finished or refused, the staged bytes have served their purpose:
          // a refused upload cannot be resumed into an accepted one.
          await store.remove(upload.id).catch(error => {
            logActivity('error', 'storage', `[storage] failed to remove staged upload ${upload.id}: ${errorMessage(error)}`);
          });
        }
        return {};
      },

      // Our errors are HttpExceptions; tus only knows `{ status_code, body }`.
      onResponseError: (_req, error) =>
        error instanceof HttpException ? { status_code: error.statusCode, body: `${error.message}\n` } : undefined,
    };
  }
}
