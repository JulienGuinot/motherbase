import { before, DELETE, GET, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseBody } from '../../lib/zod-body';
import {
  CONTENT_TYPES,
  contentCreateSchema,
  contentUpdateSchema,
  folderSchema,
  operatorOf,
  type ContentType,
} from '../../services/admin/content.service';
import { HttpException } from '../../exceptions/http-exception';

function typeParam(raw: unknown): ContentType | undefined {
  if (raw === undefined) return undefined;
  if (!(CONTENT_TYPES as readonly unknown[]).includes(raw)) {
    throw new HttpException(`type must be one of: ${CONTENT_TYPES.join(', ')}`, 400);
  }
  return raw as ContentType;
}

/** Studio content: SQL snippets, saved log queries and custom reports. */
@route('/api/admin')
export default class AdminContentController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/content')
  @before(adminOnly)
  async listContent(req: Request, res: Response, next: NextFunction) {
    try {
      const items = await this.di.ContentService.list(operatorOf(req), typeParam(req.query.type));
      return apiResponse.successResponseWithData(res, 'OK', { items, operator: operatorOf(req) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/content/:id')
  @before(adminOnly)
  async getContent(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { item: await this.di.ContentService.get(operatorOf(req), req.params.id) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/content')
  @before(adminOnly)
  async createContent(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await this.di.ContentService.create(operatorOf(req), parseBody(contentCreateSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Created', { item });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/content/:id')
  @before(adminOnly)
  async updateContent(req: Request, res: Response, next: NextFunction) {
    try {
      const item = await this.di.ContentService.update(operatorOf(req), req.params.id, parseBody(contentUpdateSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Updated', { item });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/content/:id')
  @before(adminOnly)
  async deleteContent(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.ContentService.remove(operatorOf(req), req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/content-folders')
  @before(adminOnly)
  async listFolders(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { folders: await this.di.ContentService.listFolders(operatorOf(req)) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/content-folders')
  @before(adminOnly)
  async createFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const { name } = parseBody(folderSchema, req.body);
      return apiResponse.successResponseWithData(res, 'Created', { folder: await this.di.ContentService.createFolder(operatorOf(req), name) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/content-folders/:id')
  @before(adminOnly)
  async renameFolder(req: Request, res: Response, next: NextFunction) {
    try {
      const { name } = parseBody(folderSchema, req.body);
      const folder = await this.di.ContentService.renameFolder(operatorOf(req), req.params.id, name);
      return apiResponse.successResponseWithData(res, 'Updated', { folder });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/content-folders/:id')
  @before(adminOnly)
  async deleteFolder(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.ContentService.removeFolder(operatorOf(req), req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
