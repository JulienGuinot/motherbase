import { z } from 'zod';
import { HTTP_METHODS, globToRegExp } from './rate-limit-rules';

// What CAPTCHA guards, and how a token is checked. Pure apart from the one
// fetch in verifyCaptchaToken, so the matching is unit-tested in isolation; the
// Express glue is middlewares/captcha-guard.ts.
//
// Two lists, because two things enforce them. The auth endpoints are guarded by
// Better Auth's captcha plugin, which takes endpoint names. Every other route
// (the REST API of a table a project created, an edge function, storage) is
// guarded by our own middleware, which takes method + path globs.

/**
 * Every endpoint GoTrue guards with CAPTCHA, in Better Auth's names: sign-up,
 * password sign-in, anonymous sign-in, the OTP / magic-link / SMS requests,
 * and password recovery. Verifying a code is not guarded, as in GoTrue: the
 * request that sent it already was. Matched by substring, so `/sign-in/email`
 * would also catch `/sign-in/email-otp`; the plugin exempts that one itself.
 */
export const CAPTCHA_AUTH_ENDPOINTS = [
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/anonymous',
  '/sign-in/magic-link',
  '/email-otp/send-verification-otp',
  '/email-otp/request-password-reset',
  '/phone-number/send-otp',
  '/request-password-reset',
] as const;

/** The header the SDK sends the token in, on auth calls and `.setHeader()` alike. */
export const CAPTCHA_HEADER = 'x-captcha-response';

/** Bounds the per-request matching cost, like the rate-limit rules. */
const MAX_ROUTES = 50;

export const captchaRouteSchema = z.object({
  methods: z.array(z.enum(HTTP_METHODS)).optional(),
  pathGlob: z.string().trim().min(1).startsWith('/', 'Paths start with /, e.g. /rest/v1/orders'),
});

export type CaptchaRoute = z.infer<typeof captchaRouteSchema>;

export const captchaRoutesSchema = z.array(captchaRouteSchema).max(MAX_ROUTES);

/**
 * True when a request must carry a CAPTCHA token. A route with no methods
 * guards every method but OPTIONS: a preflight cannot carry the token, and
 * refusing it would refuse the real request behind it.
 */
export function matchesCaptchaRoute(routes: CaptchaRoute[], method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === 'OPTIONS') return false;
  return routes.some(route =>
    (!route.methods?.length || (route.methods as string[]).includes(verb))
    && globToRegExp(route.pathGlob).test(path));
}

export interface CaptchaVerifier {
  provider: 'hcaptcha' | 'turnstile';
  secretKey: string;
  siteKey?: string;
}

const SITE_VERIFY_URL: Record<CaptchaVerifier['provider'], string> = {
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
};

export type CaptchaOutcome = 'verified' | 'rejected' | 'unavailable';

/**
 * Ask the provider whether a token is genuine, with the same parameters Better
 * Auth's plugin sends, so a token behaves the same on an auth call and on a
 * table. `unavailable` is the provider failing, which the caller must not read
 * as the visitor failing.
 */
export async function verifyCaptchaToken(
  verifier: CaptchaVerifier,
  token: string,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaOutcome> {
  const body = new URLSearchParams({ secret: verifier.secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  if (verifier.provider === 'hcaptcha' && verifier.siteKey) body.set('sitekey', verifier.siteKey);
  try {
    const res = await fetchImpl(SITE_VERIFY_URL[verifier.provider], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return 'unavailable';
    const data = (await res.json()) as { success?: boolean };
    return data.success === true ? 'verified' : 'rejected';
  } catch {
    return 'unavailable';
  }
}
