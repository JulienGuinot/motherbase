import { before, GET, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { storageAuth, storageScopeFor } from '../middlewares/storage-auth.middleware';
import { sendStorageObject } from '../helpers/storage-stream.helper';
import { parseTransformOptions } from '../services/storage/image-transform';

/** The key is whatever followed `/<mode>/<bucket>/`, already decoded by Express. */
const objectKeyOf = (req: Request): string => (req.params as Record<string, string>)[0] ?? '';

/** No transform options means "re-encode as is", which is what Supabase does too. */
const optionsOf = (req: Request) => parseTransformOptions(req.query as Record<string, unknown>) ?? {};

/**
 * Supabase's image render endpoints, at the same paths:
 * `/storage/v1/render/image/{public,authenticated,sign}/<bucket>/<key>`.
 * A Supabase transform URL works here once its host is swapped.
 */
@route(`${HTTP_ROUTES.storageV1}/render/image`)
export default class StorageRenderController {
  constructor(private di: IContextContainer) {}

  @GET()
  // The bucket's CORS rules come from the global delegate (bucketCors.middleware.ts).
  @route('/public/:slug/*')
  async renderPublic(req: Request, res: Response, next: NextFunction) {
    try {
      const image = await this.di.ImageRenderService.renderPublic(
        req.params.slug, objectKeyOf(req), optionsOf(req), req.headers.accept,
      );
      return await sendStorageObject(res, image);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/authenticated/:bucket/*')
  @before(storageAuth)
  async renderAuthenticated(req: Request, res: Response, next: NextFunction) {
    try {
      const image = await this.di.ImageRenderService.renderAuthenticated(
        req.params.bucket, objectKeyOf(req), storageScopeFor(req), optionsOf(req), req.headers.accept,
      );
      return await sendStorageObject(res, image);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/sign/:bucket/*')
  async renderSigned(req: Request, res: Response, next: NextFunction) {
    try {
      const image = await this.di.ImageRenderService.renderSigned(
        req.params.bucket, objectKeyOf(req), req.query.token, optionsOf(req), req.headers.accept,
      );
      return await sendStorageObject(res, image);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
