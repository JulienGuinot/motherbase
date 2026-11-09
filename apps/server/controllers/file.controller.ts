import { before, DELETE, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { FileVisibility } from '@prisma/client';
import { HTTP_ROUTES } from '@motherbase/contracts';
import type { StorageRemoveContract, StorageUploadContract } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { storageAuth, storageIdentity, storageScopeFor } from '../middlewares/storage-auth.middleware';
import { removeUploadedFile, streamUpload, uploadedFileSource } from '../helpers/multer.helper';
import { sendStorageObject } from '../helpers/storage-stream.helper';
import * as apiResponse from '../helpers/api-response.helper';
import { HttpException } from '../exceptions/http-exception';
import { parseExpiresIn } from '../services/storage/storage.service';
import { parseTransformOptions } from '../services/storage/image-transform';

const parseVisibility = (value: unknown): FileVisibility =>
  value === 'public' ? FileVisibility.public : FileVisibility.private;

const parseBucketSlug = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The object key is whatever followed `/object/<bucket>/`. Express exposes that
 * as params[0] for a wildcard route; the URL is decoded so a key containing a
 * space or a plus survives the round trip.
 */
function objectKeyOf(req: Request): string {
  // Express has already decoded the route parameter once.
  return (req.params as Record<string, string>)[0] ?? '';
}

@route(HTTP_ROUTES.files)
export default class FileController {
  constructor(private di: IContextContainer) {}

  // Multipart upload (field name: "file") is streamed through the configured driver.
  @POST()
  @route('/')
  @before([...storageAuth, streamUpload.single('file')])
  async upload(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new HttpException('No file provided (field "file").', 400);
      const source = uploadedFileSource(req.file);
      const result = await this.di.StorageService.upload({
        ownerId: storageScopeFor(req).userId,
        filename: req.file.originalname,
        body: source.body,
        size: source.size,
        mime: req.file.mimetype,
        visibility: parseVisibility(req.body?.visibility),
        bucketSlug: parseBucketSlug(req.body?.bucket),
        // `path` is the Supabase-shaped object key. Absent means the server
        // generates one, which is what every pre-6.5 caller does.
        objectKey: typeof req.body?.path === 'string' && req.body.path.trim() ? req.body.path.trim() : undefined,
        upsert: req.body?.upsert === 'true' || req.body?.upsert === true,
        scope: storageScopeFor(req),
      });
      const payload: StorageUploadContract<typeof result.file> = result;
      return apiResponse.successResponseWithData(res, 'File uploaded successfully.', payload);
    } catch (error: unknown) {
      return next(error);
    } finally {
      await removeUploadedFile(req.file);
    }
  }

  /**
   * Key-addressed reads and deletes: `/api/files/object/<bucket>/<key...>`.
   *
   * The key can contain slashes, which is the whole point, so the route ends in
   * a wildcard and the key is read from the unmatched remainder. These are
   * declared before the `/:id` routes so a request for `object` is never read
   * as a file id.
   */
  @GET()
  @route('/object/:bucket/*')
  @before(storageAuth)
  async rawByKey(req: Request, res: Response, next: NextFunction) {
    try {
      const object = await this.di.StorageService.streamFileByKey(req.params.bucket, objectKeyOf(req), storageScopeFor(req));
      return await sendStorageObject(res, object);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/object-url/:bucket/*')
  @before(storageAuth)
  async urlByKey(req: Request, res: Response, next: NextFunction) {
    try {
      // `createSignedUrl(path, exp, { transform })` signs a render URL instead:
      // an S3 presign cannot carry a resize.
      const transform = parseTransformOptions(req.query as Record<string, unknown>);
      const expiresIn = parseExpiresIn(req.query.expiresIn);
      const { url, expiresAt } = transform
        ? await this.di.ImageRenderService.signedUrl(req.params.bucket, objectKeyOf(req), storageScopeFor(req), transform, expiresIn)
        : await this.di.StorageService.getDownloadUrlByKey(req.params.bucket, objectKeyOf(req), storageScopeFor(req), expiresIn);
      return apiResponse.successResponseWithData(res, 'Download URL created.', { url, expiresAt });
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** One object's metadata, without its body. Backs `storage.from(b).info()`. */
  @GET()
  @route('/object-info/:bucket/*')
  @before(storageAuth)
  async infoByKey(req: Request, res: Response, next: NextFunction) {
    try {
      const info = await this.di.StorageService.statObject(req.params.bucket, objectKeyOf(req), storageScopeFor(req));
      return apiResponse.successResponseWithData(res, 'OK', info);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Copy and move, keyed by path. Both take their two keys in the body rather
   * than in the URL: a destination key contains slashes too, and two wildcards
   * in one route cannot be told apart.
   */
  @POST()
  @route('/copy')
  @before(storageAuth)
  async copyObject(req: Request, res: Response, next: NextFunction) {
    try {
      const { bucket, from, to, upsert } = req.body ?? {};
      if (!bucket || !from || !to) throw new HttpException('bucket, from and to are required.', 400);
      const result = await this.di.StorageService.copyObject(
        String(bucket),
        String(from),
        String(to),
        storageScopeFor(req),
        { upsert: upsert === true || upsert === 'true' },
      );
      return apiResponse.successResponseWithData(res, 'Object copied.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/move')
  @before(storageAuth)
  async moveObject(req: Request, res: Response, next: NextFunction) {
    try {
      const { bucket, from, to, upsert } = req.body ?? {};
      if (!bucket || !from || !to) throw new HttpException('bucket, from and to are required.', 400);
      const result = await this.di.StorageService.moveObject(
        String(bucket),
        String(from),
        String(to),
        storageScopeFor(req),
        { upsert: upsert === true || upsert === 'true' },
      );
      return apiResponse.successResponseWithData(res, 'Object moved.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/object/:bucket/*')
  @before(storageAuth)
  async removeByKey(req: Request, res: Response, next: NextFunction) {
    try {
      const result: StorageRemoveContract = await this.di.StorageService.removeByKey(
        req.params.bucket,
        objectKeyOf(req),
        storageScopeFor(req)
      );
      return apiResponse.successResponseWithData(res, 'File deleted.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Objects under a prefix, in the Supabase `list()` shape. */
  @GET()
  @route('/list/:bucket')
  @before(storageAuth)
  async listObjects(req: Request, res: Response, next: NextFunction) {
    try {
      const objects = await this.di.StorageService.listObjects(
        req.params.bucket,
        {
          prefix: typeof req.query.prefix === 'string' ? req.query.prefix : undefined,
          limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
          offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
          search: typeof req.query.search === 'string' ? req.query.search : undefined,
          sortBy: {
            column: typeof req.query.sortColumn === 'string' ? req.query.sortColumn : undefined,
            order: req.query.sortOrder === 'desc' ? 'desc' : 'asc',
          },
        },
        storageScopeFor(req)
      );
      return apiResponse.successResponseWithData(res, 'OK', { objects });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Presigned PUT URL for direct client-to-storage upload (S3 driver only).
  @POST()
  @route('/presign')
  @before(storageAuth)
  async presign(req: Request, res: Response, next: NextFunction) {
    try {
      const { filename, size, mime, visibility, path: objectKey } = req.body ?? {};
      if (!filename && !objectKey) throw new HttpException('filename is required.', 400);
      const result = await this.di.StorageService.presignUpload({
        ownerId: storageScopeFor(req).userId,
        filename: filename || String(objectKey).split('/').pop(),
        size,
        mime,
        visibility: parseVisibility(visibility),
        bucketSlug: parseBucketSlug(req.body?.bucket),
        objectKey: typeof objectKey === 'string' && objectKey ? objectKey : undefined,
        scope: storageScopeFor(req),
      });
      return apiResponse.successResponseWithData(res, 'Upload URL created.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/:id/finalize')
  @before(storageIdentity)
  async finalize(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.StorageService.finalizeUpload(req.params.id, storageScopeFor(req), req.body?.token);
      return apiResponse.successResponseWithData(res, 'Upload finalized.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/:id/url')
  @before(storageAuth)
  async getUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const { url, expiresAt } = await this.di.StorageService.getDownloadUrl(
        req.params.id,
        storageScopeFor(req),
        parseExpiresIn(req.query.expiresIn),
      );
      return apiResponse.successResponseWithData(res, 'Download URL created.', { url, expiresAt });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Authenticated streaming of a private object (used by the local driver, which
  // has no presigned URLs). Access control is enforced in StorageService.
  @GET()
  @route('/:id/raw')
  @before(storageAuth)
  async raw(req: Request, res: Response, next: NextFunction) {
    try {
      const object = await this.di.StorageService.streamFile(req.params.id, storageScopeFor(req));
      return await sendStorageObject(res, object);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/:id')
  @before(storageAuth)
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const result: StorageRemoveContract = await this.di.StorageService.remove(req.params.id, storageScopeFor(req));
      return apiResponse.successResponseWithData(res, 'File deleted.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
