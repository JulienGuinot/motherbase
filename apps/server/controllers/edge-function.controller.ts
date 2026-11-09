import { before, DELETE, GET, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../context/icontext-container';
import { adminOnly } from '../middlewares/platform-admin.middleware';
import * as apiResponse from '../helpers/api-response.helper';


@route('/api/admin/edge-functions')
export default class EdgeFunctionController {
  constructor(private di: IContextContainer) {}

  @GET()
  @before(adminOnly)
  async list(_req: Request, res: Response, next: NextFunction) {
    try {
      const functions = await this.di.EdgeFunctionService.list();
      return apiResponse.successResponseWithData(res, 'OK', { functions });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/:id')
  @before(adminOnly)
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const fn = await this.di.EdgeFunctionService.get(req.params.id);
      return apiResponse.successResponseWithData(res, 'OK', { function: fn });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @before(adminOnly)
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const fn = await this.di.EdgeFunctionService.create(req.body);
      await this.di.EdgeFunctionSchedulerService.reschedule();
      return apiResponse.successResponseWithData(res, 'Created', { function: fn });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/:id')
  @before(adminOnly)
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const fn = await this.di.EdgeFunctionService.update(req.params.id, req.body);
      await this.di.EdgeFunctionSchedulerService.reschedule();
      return apiResponse.successResponseWithData(res, 'Updated', { function: fn });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/:id')
  @before(adminOnly)
  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.EdgeFunctionService.delete(req.params.id);
      await this.di.EdgeFunctionSchedulerService.reschedule();
      return apiResponse.successResponseWithData(res, 'Deleted', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/:id/invoke')
  @before(adminOnly)
  async invoke(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.EdgeFunctionService.invoke(req.params.id, req.body ?? {});
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/:id/logs')
  @before(adminOnly)
  async logs(req: Request, res: Response, next: NextFunction) {
    try {
      const logs = await this.di.EdgeFunctionService.getLogs(req.params.id);
      return apiResponse.successResponseWithData(res, 'OK', { logs });
    } catch (error: unknown) {
      return next(error);
    }
  }

}
