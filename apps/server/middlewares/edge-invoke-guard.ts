import type { NextFunction, Request, Response } from 'express';
import container from '../container';
import { env } from '../config/env';
import { safeEqual } from '../lib/safe-equal';
import { apiErrorEnvelope } from './api-error.middleware';
import { presentedToken } from './api-key.middleware';

function header(req: Request, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : String(value ?? '');
}

/**
 * A secret project API key is the server-to-server credential: it is minted and
 * revoked in Studio, so a backend job or a cron needs no env var to call a
 * function. A publishable key is not enough: it ships in client bundles.
 */
async function isSecretKey(req: Request): Promise<boolean> {
  const token = presentedToken(req);
  if (!token) return false;
  const resolved = await container.resolve('ApiKeyService').resolve(token);
  return resolved?.type === 'secret';
}

export async function edgeInvokeGuard(req: Request, res: Response, next: NextFunction) {
  if (env.EDGE_PUBLIC_INVOKE_ENABLED) return next();
  if ((req as any).user?.id) return next();

  const token = header(req, 'x-motherbase-edge-token') || header(req, 'x-edge-invoke-token');
  if (env.EDGE_INVOKE_TOKEN && token && safeEqual(token, env.EDGE_INVOKE_TOKEN)) return next();

  // The lookups come last, so a session or the static token never pays for them.
  try {
    if (await isSecretKey(req)) return next();
    if (await container.resolve('EdgeFunctionService').isPublic(req.params.route)) return next();
  } catch (error) {
    return next(error);
  }

  return res.status(401).json(apiErrorEnvelope('UNAUTHORIZED',
    'Edge invocation requires a user session or a secret project API key. Mark the function public in the console to open it to anonymous callers.', req.id));
}
