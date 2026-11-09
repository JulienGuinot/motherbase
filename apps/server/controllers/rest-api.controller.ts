import { before, DELETE, GET, HEAD, PATCH, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import { optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { apiKeyMiddleware, callerFor } from '../middlewares/api-key.middleware';
import { restApiLimiter } from '../middlewares/rate-limit';
import { HttpException } from '../exceptions/http-exception';
import {
  contentRange,
  CSV_MEDIA_TYPE,
  negotiate,
  parsePrefer,
  parseRange,
  toCsv,
  toSingleObject,
  wantsPlan,
  type Preferences,
} from '../services/rest-api/http-semantics';
import { assertTableProfile } from '../services/rest-api/rest-model';

/**
 * HTTP surface of the REST dialect.
 *
 * The controller owns exactly one thing: turning headers into options and rows
 * into a response. Every decision that can affect WHICH rows exist (RLS, the
 * relrowsecurity gate, the outbox, masking) lives in the service, so a new
 * response format can never widen what a caller is allowed to see.
 */
@route(HTTP_ROUTES.rest)
export default class RestApiController {
  constructor(private di: IContextContainer) {}

  // `/rpc/:fn` is declared before `/:model` for readability only: the two
  // patterns have different segment counts, so express cannot confuse them.

  @POST()
  @route('/rpc/:fn')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async rpcPost(req: Request, res: Response, next: NextFunction) {
    try {
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined, 'representation');
      const args = (req.body ?? {}) as Record<string, unknown>;
      const result = await this.di.RestApiService.handleRpc(req.params.fn, args, callerFor(req), {
        method: 'POST',
        prefer,
        schema: profileOf(req, 'content-profile'),
      });
      return this.sendRpc(req, res, result, prefer);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * `POST /rest/v1/batch`: several writes in one transaction, all or nothing.
   *
   * Declared before `/:model` so a table named `batch` cannot shadow it. That
   * collision is real (a project may have such a table), and the resolution is
   * deliberate: the endpoint wins, and a table of that name stays reachable
   * through the batch body like any other.
   */
  @POST()
  @route('/batch')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async batch(req: Request, res: Response, next: NextFunction) {
    try {
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined, 'representation');
      const body = req.body as { operations?: unknown };
      const results = await this.di.RestApiService.handleBatch(
        (body?.operations ?? []) as never,
        callerFor(req),
        { prefer },
      );
      return res.status(200).json({ status: 1, message: 'OK', data: { results } });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/rpc/:fn')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async rpcGet(req: Request, res: Response, next: NextFunction) {
    try {
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined, 'representation');
      const args = flattenQuery(req.query);
      const result = await this.di.RestApiService.handleRpc(req.params.fn, args, callerFor(req), {
        method: 'GET',
        prefer,
        schema: profileOf(req, 'accept-profile'),
      });
      return this.sendRpc(req, res, result, prefer);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/:model')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async get(req: Request, res: Response, next: NextFunction) {
    return this.read(req, res, next, false);
  }

  /**
   * `HEAD` is how supabase-js asks for a count with no rows. Express would
   * otherwise answer a HEAD through the GET handler, which still runs the row
   * query; routing it explicitly lets the service skip that work entirely.
   */
  @HEAD()
  @route('/:model')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async head(req: Request, res: Response, next: NextFunction) {
    return this.read(req, res, next, true);
  }

  private async read(req: Request, res: Response, next: NextFunction, head: boolean) {
    try {
      assertTableProfile(profileOf(req, 'accept-profile'));
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined);
      const explain = wantsPlan(req.headers.accept);
      if (explain && req.user?.role !== 'ADMIN') {
        // EXPLAIN exposes row estimates and index names for rows the caller may
        // not be allowed to read, so it is an operator tool, not a public one.
        throw new HttpException('EXPLAIN is available to admin callers only.', 403, 'PGRST103', { expose: true });
      }

      const result = await this.di.RestApiService.handleSelect(req.params.model, req.query, callerFor(req), {
        prefer,
        range: parseRange(req.headers.range),
        head,
        explain,
      });

      res.setHeader('Content-Range', result.contentRange);
      res.setHeader('Range-Unit', 'items');
      if (explain) return res.json(result.plan);
      if (head) return res.status(200).end();

      const encoding = negotiate(req.headers.accept);
      if (encoding === 'csv') {
        res.type(CSV_MEDIA_TYPE);
        return res.send(toCsv(result.rows));
      }
      if (encoding === 'single-object') return res.json(toSingleObject(result.rows));
      return res.json(result.rows);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/:model')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async post(req: Request, res: Response, next: NextFunction) {
    try {
      assertTableProfile(profileOf(req, 'content-profile'));
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined);
      const rows = await this.di.RestApiService.handlePost(req.params.model, req.body, callerFor(req), {
        prefer,
        query: req.query,
      });
      return this.sendWrite(req, res, rows, prefer, 201);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/:model')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async patch(req: Request, res: Response, next: NextFunction) {
    try {
      assertTableProfile(profileOf(req, 'content-profile'));
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined);
      const rows = await this.di.RestApiService.handlePatch(req.params.model, req.query, req.body, callerFor(req), {
        prefer,
      });
      return this.sendWrite(req, res, rows, prefer, 200);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/:model')
  @before([optionalAuthMiddleware, apiKeyMiddleware, restApiLimiter])
  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      assertTableProfile(profileOf(req, 'content-profile'));
      const prefer = parsePrefer(req.headers.prefer as string | string[] | undefined);
      const rows = await this.di.RestApiService.handleDelete(req.params.model, req.query, callerFor(req), { prefer });
      return this.sendWrite(req, res, rows, prefer, 200);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Minimal writes have no body; internal event capture is independent of RETURNING. */
  private sendWrite(
    req: Request,
    res: Response,
    rows: unknown[],
    prefer: Preferences,
    createdStatus: number,
  ): Response {
    if (prefer.return !== 'representation') return res.status(createdStatus === 201 ? 201 : 204).end();
    const encoding = negotiate(req.headers.accept);
    res.status(createdStatus);
    if (encoding === 'csv') {
      res.type(CSV_MEDIA_TYPE);
      return res.send(toCsv(rows as Array<Record<string, unknown>>));
    }
    if (encoding === 'single-object') return res.json(toSingleObject(rows));
    return res.json(rows);
  }

  private sendRpc(
    req: Request,
    res: Response,
    result: { rows: any[]; single: boolean; scalar: boolean },
    prefer: Preferences,
  ): Response {
    // A set-returning call is a collection like a table read, so it answers with
    // a Content-Range, as PostgREST does. The whole result is always returned
    // (there is no paging on /rpc/), so the exact count is the row count and
    // costs nothing. Without it `rpc(fn, args, { count: 'exact' })` resolved
    // `count: null` while the rows were right there.
    if (!result.single) {
      res.setHeader('Content-Range', contentRange(0, result.rows.length, prefer.count ? result.rows.length : null));
    }
    if (prefer.return !== 'representation') return res.status(204).end();
    const encoding = negotiate(req.headers.accept);
    // A scalar or single-composite return is one value, not a collection, which
    // is how PostgREST renders it and what the typed `rpc()` in the SDK expects.
    const body = result.single ? result.rows[0] ?? null : result.rows;
    if (encoding === 'csv') {
      res.type(CSV_MEDIA_TYPE);
      const asRows = Array.isArray(body) ? body : body == null ? [] : [body];
      return res.send(toCsv(asRows as Array<Record<string, unknown>>));
    }
    if (encoding === 'single-object' && Array.isArray(body)) return res.json(toSingleObject(body));
    return res.json(body);
  }
}

/**
 * The schema a request names, the way PostgREST reads it: `Content-Profile` on a
 * request with a body, `Accept-Profile` on a read. Absent means `public`.
 */
function profileOf(req: Request, header: 'content-profile' | 'accept-profile'): string | undefined {
  const value = req.headers[header];
  const name = (Array.isArray(value) ? value[0] : value)?.trim();
  return name || undefined;
}

/** express query values may be arrays; an rpc argument takes the last one. */
function flattenQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    out[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  return out;
}
