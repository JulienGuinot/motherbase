import type { RequestHandler } from 'express';
import { HTTP_ROUTES } from '@motherbase/contracts';
import {
  CAPTCHA_HEADER,
  captchaRoutesSchema,
  matchesCaptchaRoute,
  verifyCaptchaToken,
  type CaptchaRoute,
  type CaptchaVerifier,
} from '../lib/captcha-routes';
import { apiErrorEnvelope } from './api-error.middleware';

// Express glue for CAPTCHA on routes outside /api/auth: the REST API of a table a
// project created, an edge function, storage. The rules and the verification
// are lib/captcha-routes.ts; this file owns the live config, applied from
// `auth.attackProtection` at boot and on every save, like the rate-limit rules.

interface LiveConfig {
  verifier: CaptchaVerifier;
  routes: CaptchaRoute[];
}

let live: LiveConfig | null = null;

interface AttackProtection {
  captchaEnabled?: boolean;
  captchaProvider?: CaptchaVerifier['provider'];
  captchaSecret?: string;
  captchaSiteKey?: string;
  captchaRoutes?: unknown;
}

/**
 * Replace the live config. Off, without a secret, or without routes, the guard
 * is a no-op. Invalid routes are dropped rather than half-applied: the settings
 * layer validates first, this is defence in depth.
 */
export function applyCaptchaConfig(input: AttackProtection | null | undefined): void {
  const routes = captchaRoutesSchema.safeParse(input?.captchaRoutes ?? []);
  if (!input?.captchaEnabled || !input.captchaSecret || !routes.success || !routes.data.length) {
    live = null;
    return;
  }
  live = {
    verifier: {
      provider: input.captchaProvider === 'turnstile' ? 'turnstile' : 'hcaptcha',
      secretKey: input.captchaSecret,
      siteKey: input.captchaSiteKey || undefined,
    },
    routes: routes.data,
  };
}

export const captchaGuard: RequestHandler = async (req, res, next) => {
  const config = live;
  if (!config) return next();
  // Auth calls are Better Auth's plugin's to check. Verifying here as well would
  // spend the single-use token before the plugin saw it.
  if (req.path === HTTP_ROUTES.auth || req.path.startsWith(`${HTTP_ROUTES.auth}/`)) return next();
  if (!matchesCaptchaRoute(config.routes, req.method, req.path)) return next();

  // The codes, messages and statuses are Better Auth's, so a client handles a
  // refused table write exactly like a refused sign-up.
  const token = req.get(CAPTCHA_HEADER);
  if (!token) return res.status(400).json(apiErrorEnvelope('MISSING_RESPONSE', 'Missing CAPTCHA response', req.id));

  const outcome = await verifyCaptchaToken(config.verifier, token, req.ip);
  if (outcome === 'verified') return next();
  if (outcome === 'rejected') return res.status(403).json(apiErrorEnvelope('VERIFICATION_FAILED', 'Captcha verification failed', req.id));
  return res.status(503).json(apiErrorEnvelope('SERVICE_UNAVAILABLE', 'CAPTCHA service unavailable', req.id));
};
