import type { Application, RequestHandler } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import { storageAuth, storageScopeFor } from '../middlewares/storage-auth.middleware';
import { adminOnly } from '../middlewares/platform-admin.middleware';
import { attachResumableScope, type ResumableUploadService } from '../services/storage/resumable-upload.service';
import type { S3ProtocolService } from '../services/storage/s3-protocol.service';

/** Supabase's path, so a tus-js-client snippet written for Supabase only needs its host changed. */
export const RESUMABLE_UPLOAD_PATH = `${HTTP_ROUTES.storageV1}/upload/resumable`;
/** The Studio's twin, reached with the console's admin credentials (and through its proxy). */
export const ADMIN_RESUMABLE_UPLOAD_PATH = '/api/admin/storage/upload/resumable';
/** Supabase's S3 endpoint path. Clients use it path-style: `endpoint: <host>/storage/v1/s3, forcePathStyle: true`. */
export const S3_PROTOCOL_PATH = `${HTTP_ROUTES.storageV1}/s3`;

interface StorageProtocolServices {
  resumable: () => ResumableUploadService;
  s3: () => S3ProtocolService;
}

/**
 * Storage protocols that own their request bodies: TUS resumable uploads and
 * the S3 protocol. Mounted ahead of the app's body parsers, the
 * way Better Auth is: a parser that buffered or consumed these streams would
 * turn a 6 MB chunk into a 413, or an object body into `{}`.
 */
export function registerStorageProtocolRoutes(app: Pick<Application, 'use'>, services: StorageProtocolServices): void {
  const resumable = (mount: 'public' | 'admin', basePath: string): RequestHandler => (req, res, next) => {
    attachResumableScope(req, mount === 'admin' ? { caller: { serviceRole: true } } : storageScopeFor(req));
    services.resumable().handle(mount, basePath, req, res).catch(next);
  };

  app.use(RESUMABLE_UPLOAD_PATH, ...storageAuth, resumable('public', RESUMABLE_UPLOAD_PATH));
  app.use(ADMIN_RESUMABLE_UPLOAD_PATH, ...adminOnly, resumable('admin', ADMIN_RESUMABLE_UPLOAD_PATH));
  // SigV4 is its own authentication, so no session or API-key middleware here.
  app.use(S3_PROTOCOL_PATH, (req, res, next) => {
    services.s3().handle(req, res, S3_PROTOCOL_PATH).catch(next);
  });
}
