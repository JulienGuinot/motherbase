import { before, DELETE, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../context/icontext-container';
import { adminOnly } from '../middlewares/platform-admin.middleware';
import * as apiResponse from '../helpers/api-response.helper';


@route('/api/admin/integrations')
export default class IntegrationsController {
  constructor(private di: IContextContainer) {}

  @GET()
  @before(adminOnly)
  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      const integrations = await this.di.IntegrationsService.list();
      return apiResponse.successResponseWithData(res, 'OK', { integrations });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/:key/connect')
  @before(adminOnly)
  async connect(req: Request, res: Response, next: NextFunction) {
    try {
      const { secrets, installFunctions, functions } = req.body ?? {};
      const result = await this.di.IntegrationsService.connect(
        req.params.key,
        secrets ?? {},
        installFunctions !== false,
        Array.isArray(functions) ? functions.map(String) : undefined,
      );
      return apiResponse.successResponseWithData(res, 'Connected', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/:key')
  @before(adminOnly)
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.IntegrationsService.disconnect(req.params.key, req.query.removeFunctions === 'true');
      return apiResponse.successResponse(res, 'Disconnected');
    } catch (error: unknown) {
      return next(error);
    }
  }

}
