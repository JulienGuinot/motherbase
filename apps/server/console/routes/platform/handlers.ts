import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SLUG_RE } from '../../../constants/regex.constants';
import { sessionUser } from '../../auth/session';
import { sendServiceError } from '../../helpers/http-error';
import { sendInternalError } from '../../helpers/internal-error.helper';
import { fail } from '../../helpers/respond';
import type { PlatformDeps } from './deps';

type AsyncHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

/**
 * An `HttpError` becomes its own status and message; any other throw becomes a
 * logged 500 that leaks nothing to the client.
 */
export function guarded(
  deps: Pick<PlatformDeps, 'logs'>,
  handler: AsyncHandler,
  context = 'platform request failed',
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error: unknown) {
      sendServiceError(res, deps.logs, context, error);
    }
  };
}

/**
 * 400 on a malformed `:id`, 404 on an unknown one. The registry entry is left
 * on `res.locals.project` for handlers that need it. Validating the slug first
 * matters: some handlers feed the id into filesystem paths.
 */
export function requireKnownProject(deps: Pick<PlatformDeps, 'registry' | 'logs'>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!SLUG_RE.test(req.params.id ?? '')) return fail(res, 400, 'invalid project id');
    try {
      if (deps.registry?.get) {
        const project = await deps.registry.get(req.params.id);
        if (!project) return fail(res, 404, 'project not found');
        res.locals.project = project;
      }
    } catch (error: unknown) {
      return sendInternalError(res, deps.logs, 'platform request failed', error);
    }
    next();
  };
}

/**
 * The projects a scoped role (developer, member, read-only) may see, or `null`
 * for the global owner/admin roles, who see everything.
 */
export function scopedProjects(req: Request): Set<string> | null {
  const user = sessionUser(req);
  if (!user || user.role === 'owner' || user.role === 'admin') return null;
  return new Set(user.projects);
}
