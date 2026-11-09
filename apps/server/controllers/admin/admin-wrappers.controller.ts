import { before, DELETE, GET, POST, PUT, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseBody } from '../../lib/zod-body';
import { WRAPPERS } from '../../services/admin/wrapper.service';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a plain SQL identifier');
const options = z.record(z.string(), z.string()).default({});

const createServerSchema = z.object({
  name: identifier,
  wrapper: z.enum(WRAPPERS),
  options,
  user: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

const credentialsSchema = z.object({ user: z.string().min(1), password: z.string().min(1) });

const importSchema = z.object({
  remoteSchema: identifier,
  localSchema: identifier,
  tables: z.array(identifier).optional(),
});

const createTableSchema = z.object({
  server: identifier,
  schema: identifier,
  name: identifier,
  columns: z.array(z.object({ name: identifier, type: z.string().min(1) })).min(1),
  options,
});

const wrapperParam = z.enum(WRAPPERS);

/**
 * Wrappers (foreign data wrappers). Every route is `secrets.manage` in the
 * Console, reads included: a server's options name a remote host, and creating
 * one hands out credentials.
 */
@route('/api/admin')
export default class AdminWrappersController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/wrappers')
  @before(adminOnly)
  async listWrappers(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.WrapperService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/wrappers/:wrapper/enable')
  @before(adminOnly)
  async enableWrapper(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.WrapperService.enable(parseBody(wrapperParam, req.params.wrapper));
      return apiResponse.successResponse(res, 'Enabled');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/wrappers/servers')
  @before(adminOnly)
  async createForeignServer(req: Request, res: Response, next: NextFunction) {
    try {
      const server = await this.di.WrapperService.createServer(parseBody(createServerSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Created', { server });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/wrappers/servers/:name/credentials')
  @before(adminOnly)
  async setForeignServerCredentials(req: Request, res: Response, next: NextFunction) {
    try {
      const server = await this.di.WrapperService.setCredentials(
        req.params.name,
        parseBody(credentialsSchema, req.body),
      );
      return apiResponse.successResponseWithData(res, 'Updated', { server });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/wrappers/servers/:name/import')
  @before(adminOnly)
  async importForeignSchema(req: Request, res: Response, next: NextFunction) {
    try {
      const tables = await this.di.WrapperService.importSchema(req.params.name, parseBody(importSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Imported', { tables });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/wrappers/servers/:name')
  @before(adminOnly)
  async dropForeignServer(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.WrapperService.dropServer(req.params.name);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/wrappers/tables')
  @before(adminOnly)
  async createForeignTable(req: Request, res: Response, next: NextFunction) {
    try {
      const table = await this.di.WrapperService.createForeignTable(parseBody(createTableSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Created', { table });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/wrappers/tables/:schema/:name')
  @before(adminOnly)
  async dropForeignTable(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.WrapperService.dropForeignTable(req.params.schema, req.params.name);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }
}
