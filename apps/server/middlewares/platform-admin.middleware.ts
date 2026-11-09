import { Request, Response, NextFunction } from 'express';
import * as apiResponse from '../helpers/api-response.helper';
import { authMiddleware } from './auth.middleware';
import { requireRole } from './require-role';
import { safeEqual } from '../lib/safe-equal';

/**
 * Admin guard used by every /api/admin route. Two ways in:
 *  1. A valid `X-Platform-Token` (the Console proxy) -> synthetic ADMIN user.
 *  2. A normal user JWT with ADMIN role (local single-instance dev).
 * A present-but-wrong platform token is rejected immediately (no fall-through).
 */
export async function adminGuard(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-platform-token'] as string | undefined;
  const expected = process.env.PLATFORM_SERVICE_TOKEN;

  if (provided !== undefined) {
    if (expected && safeEqual(provided, expected)) {
      // The console names the signed-in operator next to its token (see
      // proxy.routes). Only believed here, behind a valid platform token: it
      // is what makes a private SQL snippet private to one operator.
      const operator = req.headers['x-platform-operator'];
      (req as any).user = {
        id: 'platform',
        role: 'ADMIN',
        platform: true,
        operatorId: typeof operator === 'string' && operator ? operator : undefined,
      };
      return next();
    }
    return apiResponse.unauthorizedResponse(res, 'Invalid platform token');
  }

  return authMiddleware(req, res, (err?: any) => {
    if (err) return next(err);
    return requireRole('ADMIN')(req, res, next);
  });
}

/** The `@before(...)` chain every admin controller route uses. */
export const adminOnly = [adminGuard];

/**
 * `adminGuard`, plus a secret project key as a second way in. Mount it behind
 * `apiKeyMiddleware`, which is what resolves `req.apiKey`; on its own it grants
 * nothing, so mounting it without that one fails closed.
 *
 * Only for reading the project's own logs. A 500 reaches the caller as a masked
 * envelope, and the trace that explains it lives in the log buffer, so a project
 * with no programmatic way to read that buffer cannot attach a server-side cause
 * to a bug report or alert on its own errors: the id in `x-request-id` points at
 * a line only the Studio UI could fetch.
 *
 * Deliberately not folded into `adminOnly`: the rest of `/api/admin` runs SQL,
 * DDL, backups and settings changes, and a single credential that both bypasses
 * RLS and drops tables is a far worse thing to leak than either alone (the same
 * reasoning as `requireSecretKey`). This widens exactly one read.
 *
 * `apiKeyMiddleware` is not imported here on purpose: this module is pulled in
 * by every admin controller, and that one pulls in the DI container.
 */
export function secretKeyOrAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.apiKey?.type === 'secret') return next();
  return adminGuard(req, res, next);
}
