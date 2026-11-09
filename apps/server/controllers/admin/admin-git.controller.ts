import { before, DELETE, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';

/**
 * Connect a GitHub repository to this project, Vercel-style, and import the
 * migrations it holds. The workflow lives in `GitRepoService`.
 *
 * Everything an operator drives sits under `/api/admin`, including the OAuth
 * code exchange: GitHub redirects the browser back to a **Studio** page, which
 * then POSTs the code here over the normal admin session. So no endpoint that
 * touches a token is reachable without one, and every route proxies through the
 * Console like the rest of the admin surface.
 *
 * The push delivery cannot live here: GitHub holds no session. It is
 * `git-webhook.controller.ts`, authenticated by its HMAC signature alone.
 */
@route('/api/admin')
export default class AdminGitController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/git/status')
  @before(adminOnly)
  async gitStatus(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.GitRepoService.status());
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** The GitHub URL to send the operator's browser to. */
  @GET()
  @route('/git/authorize')
  @before(adminOnly)
  async gitAuthorize(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.GitRepoService.authorize());
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Exchange the `code` the Studio callback page received for an access token. */
  @POST()
  @route('/git/callback')
  @before(adminOnly)
  async gitCallback(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, state } = req.body as { code?: string; state?: string };
      const status = await this.di.GitRepoService.completeAuthorization(String(code ?? ''), String(state ?? ''));
      return apiResponse.successResponseWithData(res, 'Connected', status);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/git/repos')
  @before(adminOnly)
  async gitRepos(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { repos: await this.di.GitRepoService.listRepos() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/git/link')
  @before(adminOnly)
  async gitLink(req: Request, res: Response, next: NextFunction) {
    try {
      const status = await this.di.GitRepoService.link(req.body ?? {});
      return apiResponse.successResponseWithData(res, 'Linked', status);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/git/link')
  @before(adminOnly)
  async gitUnlink(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Disconnected', await this.di.GitRepoService.unlink());
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** "Deploy now": the same import a push triggers, run by hand. */
  @POST()
  @route('/git/sync')
  @before(adminOnly)
  async gitSync(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.GitRepoService.sync());
    } catch (error: unknown) {
      return next(error);
    }
  }
}
