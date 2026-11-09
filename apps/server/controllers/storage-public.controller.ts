import { before, DELETE, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { removeUploadedFile, streamUpload, uploadedFileSource } from '../helpers/multer.helper';
import { sendStorageObject } from '../helpers/storage-stream.helper';
import * as apiResponse from '../helpers/api-response.helper';
import { bucketTokenGuard } from '../middlewares/bucketToken.middleware';
import { HttpException } from '../exceptions/http-exception';

@route(`${HTTP_ROUTES.storage}/:slug`)
export default class StoragePublicController {
  constructor(private di: IContextContainer) {}

  @POST()
  @route('/upload')
  @before([bucketTokenGuard('write'), streamUpload.single('file')])
  async upload(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new HttpException('No file provided (field "file").', 400, 'BAD_REQUEST');
      const source = uploadedFileSource(req.file);
      const result = await this.di.StorageService.upload({
        filename: req.file.originalname,
        body: source.body,
        size: source.size,
        mime: req.file.mimetype,
        bucketSlug: req.params.slug,
        // The write token proves authority over this bucket and nothing else.
        scope: { bucketId: req.bucket?.id },
      });
      return apiResponse.successResponseWithData(res, 'Uploaded', result);
    } catch (error: unknown) {
      return next(error);
    } finally {
      await removeUploadedFile(req.file);
    }
  }

  @GET()
  @route('/files/:id')
  async download(req: Request, res: Response, next: NextFunction) {
    try {
      // Resolve the bucket before deciding whether a read token is required.
      const bucket = await this.di.BucketService.getBySlug(req.params.slug);
      // Public bucket: no token needed
      if (bucket.visibility !== 'public') {
        // The guard reports a missing or bad token through next(), so that
        // call must be awaited as a result: dropping it serves the file.
        const denied = await new Promise<unknown>(resolve => {
          void bucketTokenGuard('read')(req, res, resolve);
        });
        if (denied) throw denied;
      }
      // Scope to this bucket: a token for one bucket must not read another's
      // objects, and a public bucket exposes only the files it contains.
      // `:id` carries either a file id or an object key: `getPublicUrl(path)`
      // builds the second form.
      const object = await this.di.StorageService.streamFileByIdOrKey(req.params.slug, req.params.id, {
        bucketId: bucket.id,
      });
      return await sendStorageObject(res, object);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/files/:id')
  @before([bucketTokenGuard('delete')])
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      // The delete token proves authority over :slug only. Scope the delete to
      // that bucket so it cannot reach another bucket's (or a user's) files.
      // `bucketTokenGuard('delete')` ran as a route guard, so the bucket is set.
      await this.di.StorageService.removeByIdOrKey(req.params.slug, req.params.id, {
        bucketId: req.bucket?.id,
      });
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
