import type { RequestHandler } from 'express';
import { FixedWindowStore } from '../lib/rate-limit-rules';
import { ipKey } from '../middlewares/rate-limit';
import type { AuthRateLimits } from './rate-limit-defaults';

export { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './rate-limit-defaults';

// Supabase's Auth · Rate Limits, enforced.
//
// The global `authLimiter` counts every /api/auth request alike. GoTrue limits
// each kind of request on its own window instead, so a burst of token
// refreshes cannot lock a user out of signing in and a sign-up flood cannot
// drain the email quota. These are those limits, with GoTrue's windows:
//
//   sign-ups + sign-ins     per IP, per 5 minutes
//   OTP / link verification per IP, per 5 minutes
//   token refresh           per IP, per 5 minutes
//   anonymous sign-ins      per IP, per hour
//   emails / SMS sent       per project, per hour (counted at delivery)
//
// Counters live in this process, like every other limiter here.

type Bucket = 'anonymous' | 'signInSignUp' | 'verify' | 'tokenRefresh';

const BUCKETS: Record<Bucket, { limit: keyof AuthRateLimits; windowSec: number }> = {
  anonymous: { limit: 'anonymousPerHour', windowSec: 3600 },
  signInSignUp: { limit: 'signInSignUpPer5Min', windowSec: 300 },
  verify: { limit: 'verifyPer5Min', windowSec: 300 },
  tokenRefresh: { limit: 'tokenRefreshPer5Min', windowSec: 300 },
};

/** Which GoTrue limit a Better Auth path (relative to /api/auth) counts against. */
export function authRateBucket(path: string): Bucket | null {
  if (path === '/sign-in/anonymous') return 'anonymous';
  // Verifying a code comes first: `/sign-in/email-otp` is a verification.
  if (
    path === '/sign-in/email-otp' ||
    path === '/verify-email' ||
    path === '/magic-link/verify' ||
    path === '/phone-number/verify' ||
    path === '/phone-number/reset-password' ||
    path === '/email-otp/verify-email' ||
    path === '/exchange-code' ||
    path.startsWith('/two-factor/verify-')
  ) {
    return 'verify';
  }
  if (path.startsWith('/sign-in/') || path.startsWith('/sign-up/')) return 'signInSignUp';
  if (path === '/token') return 'tokenRefresh';
  return null;
}

function tooMany(message: string, code: string) {
  return { status: 429, body: { code, message } };
}

/**
 * The per-IP half, mounted on /api/auth ahead of Better Auth. `limits` is read
 * per request so a Studio save applies without a restart.
 */
export function createAuthRateLimiter(
  limits: () => Promise<AuthRateLimits>,
  store = new FixedWindowStore(),
): RequestHandler {
  return async (req, res, next) => {
    const bucket = authRateBucket(req.path);
    if (!bucket || req.method === 'OPTIONS') return next();
    try {
      const { limit, windowSec } = BUCKETS[bucket];
      const max = (await limits())[limit];
      const ip = ipKey(String(req.ip || req.socket.remoteAddress || 'unknown'));
      const hit = store.hit(`auth:${bucket}:${ip}`, windowSec, max);
      if (!hit.limited) return next();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000))));
      const { status, body } = tooMany('Request rate limit reached', 'over_request_rate_limit');
      return res.status(status).json(body);
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * The per-project half: how many emails or texts auth may send in an hour.
 * Checked where a message is about to go out, so every flow that sends one is
 * covered and nothing that sends none is. Returns false when over.
 */
export class DeliveryQuota {
  constructor(private readonly store = new FixedWindowStore()) {}

  allow(channel: 'email' | 'sms', limits: AuthRateLimits): boolean {
    const max = channel === 'email' ? limits.emailSentPerHour : limits.smsSentPerHour;
    return !this.store.hit(`auth:send:${channel}`, 3600, max).limited;
  }
}
