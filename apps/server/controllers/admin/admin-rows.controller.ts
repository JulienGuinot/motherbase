import { before, GET, POST, PATCH, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseRowFilters } from '../../services/admin/row-filters';


@route('/api/admin')
export default class AdminRowsController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/tables/:model/rows')
  @before(adminOnly)
  async rows(req: Request, res: Response, next: NextFunction) {
    try {
      const { model } = req.params;
      const { page, pageSize, sort, order, filters } = req.query as Record<string, string>;
      const result = await this.di.AdminService.listRows(model, {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        sort,
        order: order === 'desc' ? 'desc' : 'asc',
        filters: parseRowFilters(filters),
      });
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/tables/:model/rows')
  @before(adminOnly)
  async createRow(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await this.di.AdminService.createRow(req.params.model, req.body);
      return apiResponse.successResponseWithData(res, 'Created', row);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/tables/:model/rows/:id')
  @before(adminOnly)
  async updateRow(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await this.di.AdminService.updateRow(req.params.model, req.params.id, req.body);
      return apiResponse.successResponseWithData(res, 'Updated', row);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/tables/:model/rows/:id')
  @before(adminOnly)
  async deleteRow(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.AdminService.deleteRow(req.params.model, req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
