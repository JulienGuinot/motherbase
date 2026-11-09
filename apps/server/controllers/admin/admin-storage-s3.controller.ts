import { before, DELETE, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { env } from '../../config/env';
import { S3_PROTOCOL_PATH } from '../../lib/storage-protocol-routes';

const createKeySchema = z.object({ description: z.string().trim().min(1).max(200) });

/**
 * Project Settings > Storage > S3 connection: the endpoint to point a client
 * at, and the access keys that authenticate it.
 */
@route('/api/admin')
export default class AdminStorageS3Controller {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/storage/s3')
  @before(adminOnly)
  async connection(_req: Request, res: Response, next: NextFunction) {
    try {
      const host = env.BASE_HOST.startsWith('http') ? env.BASE_HOST : `http://${env.BASE_HOST}`;
      return apiResponse.successResponseWithData(res, 'OK', {
        enabled: await this.di.S3ProtocolService.enabled(),
        endpoint: `${host}${S3_PROTOCOL_PATH}`,
        // Any region signs correctly; this is the one to suggest.
        region: env.S3_REGION || 'us-east-1',
        forcePathStyle: true,
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/storage/s3/keys')
  @before(adminOnly)
  async listKeys(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { keys: await this.di.S3AccessKeyService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** The only response that ever carries the secret. */
  @POST()
  @route('/storage/s3/keys')
  @before(adminOnly)
  async createKey(req: Request, res: Response, next: NextFunction) {
    try {
      const parsed = createKeySchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new HttpException('description is required (1-200 characters).', 400);
      const created = await this.di.S3AccessKeyService.create(parsed.data.description);
      return apiResponse.successResponseWithData(res, 'Created', created);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/storage/s3/keys/:id')
  @before(adminOnly)
  async revokeKey(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.S3AccessKeyService.revoke(req.params.id);
      return apiResponse.successResponse(res, 'Revoked');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
