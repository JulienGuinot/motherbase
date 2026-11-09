import { before, DELETE, GET, POST, PUT, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { FileVisibility } from '@prisma/client';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { apiKeyMiddleware, requireSecretKey } from '../middlewares/api-key.middleware';
import * as apiResponse from '../helpers/api-response.helper';
import { HttpException } from '../exceptions/http-exception';
import { parseMimeList, parseSizeLimit } from '../services/storage/upload-limits';

/**
 * Bucket administration on the data plane, so `client.storage.listBuckets()`
 * and friends work the way they do in supabase-js.
 *
 * Every route here requires a SECRET project API key, which is the same rule
 * Supabase applies: bucket administration is a service-role operation. A
 * publishable key gets a 401, not a partial answer, and the key never belongs
 * in a browser.
 *
 * Buckets themselves are managed elsewhere too (the Studio, the console admin
 * API). Both go through BucketService, so quota accounting, slug validation and
 * the force-delete job are the same whichever door a caller came through.
 */
@route(`${HTTP_ROUTES.files}/bucket`)
export default class StorageBucketController {
  constructor(private di: IContextContainer) {}

  /** A bucket in the supabase-js shape, which is snake_case and slug-keyed. */
  private present(bucket: {
    slug: string;
    name: string;
    visibility: FileVisibility;
    fileSizeLimit: bigint | null;
    allowedMimeTypes: string[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: bucket.slug,
      name: bucket.name,
      owner: '',
      public: bucket.visibility === FileVisibility.public,
      file_size_limit: bucket.fileSizeLimit === null ? null : Number(bucket.fileSizeLimit),
      allowed_mime_types: bucket.allowedMimeTypes.length ? bucket.allowedMimeTypes : null,
      created_at: bucket.createdAt?.toISOString?.() ?? null,
      updated_at: bucket.updatedAt?.toISOString?.() ?? null,
    };
  }

  @GET()
  @route('/')
  @before([apiKeyMiddleware, requireSecretKey])
  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      const buckets = await this.di.BucketService.list();
      return apiResponse.successResponseWithData(res, 'OK', { buckets: buckets.map(b => this.present(b)) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/')
  @before([apiKeyMiddleware, requireSecretKey])
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, name, public: isPublic, file_size_limit, allowed_mime_types } = req.body ?? {};
      const slug = typeof id === 'string' ? id.trim() : '';
      if (!slug) throw new HttpException('id is required.', 400);
      const bucket = await this.di.BucketService.create({
        slug,
        name: typeof name === 'string' && name.trim() ? name.trim() : slug,
        visibility: isPublic === true ? FileVisibility.public : FileVisibility.private,
        fileSizeLimit: parseSizeLimit(file_size_limit),
        allowedMimeTypes: parseMimeList(allowed_mime_types),
      });
      return apiResponse.successResponseWithData(res, 'Bucket created.', this.present(bucket));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/:slug')
  @before([apiKeyMiddleware, requireSecretKey])
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      return apiResponse.successResponseWithData(res, 'OK', this.present(bucket));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/:slug')
  @before([apiKeyMiddleware, requireSecretKey])
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, public: isPublic, file_size_limit, allowed_mime_types } = req.body ?? {};
      const bucket = await this.di.BucketService.update(req.params.slug, {
        ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
        ...(isPublic === undefined
          ? {}
          : { visibility: isPublic === true ? FileVisibility.public : FileVisibility.private }),
        // supabase-js sends both keys on every update, null meaning "no limit".
        ...(file_size_limit === undefined ? {} : { fileSizeLimit: parseSizeLimit(file_size_limit) }),
        ...(allowed_mime_types === undefined ? {} : { allowedMimeTypes: parseMimeList(allowed_mime_types) }),
      });
      return apiResponse.successResponseWithData(res, 'Bucket updated.', this.present(bucket));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Delete every object in the bucket, keeping the bucket.
   *
   * Implemented as a force-delete job followed by a re-create under the same
   * slug would lose the bucket's settings, so instead the objects are removed
   * one by one through StorageService, which is what also releases the quota
   * and deletes the bytes rather than only the rows.
   */
  @POST()
  @route('/:slug/empty')
  @before([apiKeyMiddleware, requireSecretKey])
  async empty(req: Request, res: Response, next: NextFunction) {
    try {
      const slug = req.params.slug;
      await this.di.BucketService.getBySlug(slug);
      let removed = 0;
      // Paged from the front each time: every pass deletes what it lists, so
      // the next page is always page 1 again. A fixed offset would skip rows.
      for (;;) {
        const page = await this.di.BucketService.listFiles(slug, { page: 1, pageSize: 100 });
        if (!page.rows.length) break;
        for (const file of page.rows) {
          await this.di.StorageService.adminRemove(file.id);
          removed += 1;
        }
      }
      return apiResponse.successResponseWithData(res, 'Bucket emptied.', { emptied: true, removed });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/:slug')
  @before([apiKeyMiddleware, requireSecretKey])
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.BucketService.delete(req.params.slug, req.query.force === 'true');
      return apiResponse.successResponseWithData(res, 'Bucket deleted.', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
