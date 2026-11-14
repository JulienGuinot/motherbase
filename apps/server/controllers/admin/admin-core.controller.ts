import { before, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { env } from '../../config/env';
import { localApiUrl } from '../../lib/local-api-url';


@route('/api/admin')
export default class AdminCoreController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/session')
  @before(adminOnly)
  async session(req: Request, res: Response) {
    const { passwordHash, ...safe } = req.user as any;
    return apiResponse.successResponseWithData(res, 'OK', safe);
  }

  // Connection details for the Studio "Connect" panel: the URLs and package a
  // client app needs to talk to this backend. Derived from the request host so
  // the values shown match however the operator reached Studio.

  @GET()
  @route('/connect-info')
  @before(adminOnly)
  async connectInfo(req: Request, res: Response) {
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'http';
    // BASE_HOST is set in the project .env to the project's own domain (e.g. test.example.com).
    // Using req.headers.host would return the console proxy's domain when the request is proxied.
    const configuredHost = env.BASE_HOST || req.headers.host || `localhost:${env.PORT}`;
    const hostOnly = configuredHost.split(':')[0];
    const apiUrl = localApiUrl(process.env.API_PORT) ?? `${proto}://${configuredHost}`;
    const wsUrl = apiUrl;
    // The snippets on the Connect page have always referenced an ANON_KEY env
    // var; this is the value that fills it. Minted on first read rather than at
    // provisioning time so projects created before API keys existed get one too.
    const publishable = await this.di.ApiKeyService.ensurePublishable().catch(() => null);
    return apiResponse.successResponseWithData(res, 'OK', {
      apiUrl,
      wsUrl,
      sdkPackage: '@motherbase/client',
      version: process.env.npm_package_version || '1.0.0',
      projectId: hostOnly.split('.')[0] || hostOnly,
      anonKey: publishable?.token ?? null,
    });
  }

  @GET()
  @route('/tables')
  @before(adminOnly)
  async tables(_req: Request, res: Response) {
    return apiResponse.successResponseWithData(res, 'OK', { tables: await this.di.AdminService.listTables() });
  }

  @POST()
  @route('/sql')
  @before(adminOnly)
  async sql(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.SqlService.execute(req.body?.sql);
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Dedicated read-only entry point for the AI assistant's run_select tool.
  // `readonly: true` is hardcoded here, never read from the request body, so
  // nothing the model emits can turn it off: SqlService wraps execution in a
  // real Postgres READ ONLY transaction, which is the hard backstop behind
  // the assistant's own static isReadOnlySql pre-check.
  @POST()
  @route('/sql/readonly')
  @before(adminOnly)
  async sqlReadonly(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.SqlService.execute(req.body?.sql, { enabled: true, readonly: true });
      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
