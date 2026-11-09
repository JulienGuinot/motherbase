import { POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../context/icontext-container';
import * as apiResponse from '../helpers/api-response.helper';
import { HttpException } from '../exceptions/http-exception';

/**
 * GitHub push deliveries for the connected repository (see
 * `admin-git.controller.ts` for everything an operator drives).
 *
 * Deliberately outside `/api/admin`: GitHub holds no operator session and cannot
 * traverse the Console proxy, so it posts to the project API directly. The HMAC
 * signature over the raw body IS the credential, and `GitRepoService.handlePush`
 * verifies it before parsing anything.
 */
@route('/api/git')
export default class GitWebhookController {
  constructor(private di: IContextContainer) {}

  /**
   * The response is a plain 200 carrying the outcome, including when nothing was
   * synced. A non-2xx marks the hook as failing in the repository's settings,
   * which an operator reads as "the integration is broken". The wrong message
   * for "that push was on another branch".
   */
  @POST()
  @route('/webhook')
  async webhook(req: Request, res: Response, next: NextFunction) {
    try {
      // No fallback: re-serialising req.body cannot reproduce the bytes GitHub
      // signed (key order, whitespace, unicode escapes), so it would only ever
      // 401 and read as "your webhook is broken" instead of "the express.json
      // verify hook did not run". Fail loudly on the real cause.
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!raw) throw new HttpException('Raw request body unavailable', 500);
      const outcome = await this.di.GitRepoService.handlePush(
        raw,
        req.headers['x-hub-signature-256'] as string | undefined,
        req.headers['x-github-event'] as string | undefined,
      );
      return apiResponse.successResponseWithData(res, 'OK', outcome);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
