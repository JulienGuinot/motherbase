import { before, DELETE, GET, PATCH, POST, PUT, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import * as apiResponse from '../helpers/api-response.helper';
import { edgeOptionalAuthMiddleware } from '../middlewares/auth.middleware';
import { edgeInvokeGuard } from '../middlewares/edge-invoke-guard';
import { edgeInvokeLimiter } from '../middlewares/rate-limit';

/**
 * Express keeps repeated headers as arrays. The function's Headers takes strings,
 * and joining with a comma is what the Fetch spec does for repeats anyway.
 */
function plainHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * The body the function sees, as the sender wrote it.
 *
 * A webhook signature is an HMAC over the raw bytes, and JSON.parse ->
 * JSON.stringify is not byte-stable (key order, whitespace, unicode escapes),
 * so re-serialising the parsed object makes every delivery fail to verify.
 * app.ts keeps the original buffer on `rawBody` for exactly this.
 */
export function edgeRequestBody(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw !== undefined && raw.length > 0) return raw.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return JSON.stringify(req.body ?? {});
}

@route(HTTP_ROUTES.edge)
export default class EdgeInvokeController {
  constructor(private di: IContextContainer) {}

  // Every verb the function can see. The handler already forwards `req.method`
  // to the function, so a GET-only webhook receiver or a REST-shaped function
  // works; supabase-js's `functions.invoke(name, { method })` reaches these.
  @GET()
  @POST()
  @PUT()
  @PATCH()
  @DELETE()
  @route('/:route')
  @before([edgeOptionalAuthMiddleware, edgeInvokeLimiter, edgeInvokeGuard])
  async invokeByRoute(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.EdgeFunctionService.invokeRoute(req.params.route, req.body ?? {}, {
        method: req.method,
        url: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
        headers: plainHeaders(req.headers),
        body: edgeRequestBody(req),
      });

      // A function using the `(req) => Response` shape owns its own status,
      // headers and body. Wrapping that in the envelope would turn a webhook
      // handler's 400 into a 200 describing one, which the sender reads as
      // success and never retries.
      if (result.response) {
        for (const [name, value] of Object.entries(result.response.headers ?? {})) {
          // Hop-by-hop and length headers belong to this response, not the one
          // the function composed.
          if (['content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) continue;
          res.setHeader(name, value);
        }
        return res.status(result.response.status).send(result.response.body);
      }

      return apiResponse.successResponseWithData(res, 'OK', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
