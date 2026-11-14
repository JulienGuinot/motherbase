import rateLimit from 'express-rate-limit';
import { isIPv6 } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { actionFromMethod, shieldTelemetry } from '../lib/shield-telemetry';
import { logActivity } from '../lib/activity-log';
import { apiErrorEnvelope } from './api-error.middleware';
import { signedInUser } from '../auth/signed-in-user';

type LimitScope = 'global' | 'auth' | 'rest' | 'edge';

export interface RateLimitLimits {
  global: number;
  auth: number;
  restRead: number;
  restWrite: number;
  edge: number;
}

// Seeded from env; overridden at boot + on every save of `security.rateLimit`.
const current: RateLimitLimits = {
  global: env.RATE_LIMIT_GLOBAL_MAX,
  auth: env.RATE_LIMIT_AUTH_MAX,
  restRead: env.RATE_LIMIT_REST_READ_MAX,
  restWrite: env.RATE_LIMIT_REST_WRITE_MAX,
  edge: env.RATE_LIMIT_EDGE_MAX,
};

/**
 * The window every limit above is counted over.
 *
 * `express-rate-limit` reads `windowMs` once at construction and hands it to the
 * store, so unlike the maxima it cannot be read through a function. It is kept
 * here instead and the limiters below rebuild themselves when it changes. See
 * `rebuildable()`. Without that, five of the six knobs in `security.rateLimit`
 * applied live and the sixth silently needed a restart.
 */
let windowMs = env.RATE_LIMIT_WINDOW_MIN * 60 * 1000;

/**
 * Rebuild hooks for every limiter created through `rebuildable()`.
 *
 * They run from `applyRateLimitLimits`, i.e. at boot and on an operator save.
 * Never while responding. Rebuilding lazily on the next request would also work,
 * but `express-rate-limit` explicitly warns about instances constructed inside a
 * request handler (ERR_ERL_CREATED_IN_REQUEST_HANDLER), and it is right to.
 */
const rebuildHooks: Array<() => void> = [];

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Apply console-managed limit overrides. Ignores non-positive / non-finite values. */
export function applyRateLimitLimits(next: Partial<RateLimitLimits> & { windowMin?: number }): void {
  for (const key of Object.keys(current) as Array<keyof RateLimitLimits>) {
    const v = next[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) current[key] = Math.floor(v);
  }

  const windowMin = next.windowMin;
  if (typeof windowMin === 'number' && Number.isFinite(windowMin) && windowMin > 0) {
    const nextWindowMs = Math.min(Math.floor(windowMin) * 60 * 1000, MAX_WINDOW_MS);
    if (nextWindowMs !== windowMs) {
      windowMs = nextWindowMs;
      // Rebuilding gives every limiter a fresh store, so counters restart. That
      // is the honest behaviour: a count of 40 means nothing once the period it
      // was counted over has changed underneath it. It also means a no-op save
      // must not rebuild, or an operator could hand every throttled caller a
      // fresh allowance just by pressing Save: hence the equality check above.
      for (const rebuild of rebuildHooks) rebuild();
      logActivity('info', 'shield', `[shield] rate-limit window changed to ${windowMin}m; counters reset`);
    }
  }
}

export function currentRateLimitLimits(): RateLimitLimits {
  return { ...current };
}

export function currentRateLimitWindowMs(): number {
  return windowMs;
}

/**
 * The identity a rate limit counts against.
 *
 * An IPv4 address is one host, so it is its own key. An IPv6 address is not: a
 * residential or cloud client is routinely handed a routed /64 and owns 2^64
 * addresses inside it, so keying on the full address lets one caller walk the
 * limiter with a fresh address per request. Collapse to the /64.
 *
 * express-rate-limit ships `ipKeyGenerator` for this, but only from v8; this
 * repo is on 7.5.1, where it exists in neither the types nor the runtime.
 * Eleven lines here beats a major upgrade of the whole limiter surface.
 */
export function ipKey(raw: string): string {
  // Strip a zone index (fe80::1%eth0) and unwrap IPv4-mapped form.
  const ip = raw.split('%')[0].replace(/^::ffff:/i, '');
  if (!isIPv6(ip)) return ip;

  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const parts = tail === undefined
    ? headParts
    : [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'), ...tailParts];

  // Normalise each hextet so 0db8 and db8 do not become two different keys.
  return `${parts.slice(0, 4).map(h => (h.replace(/^0+/, '') || '0')).join(':')}::/64`;
}

function clientKey(req: Request): string {
  const userId = signedInUser(req)?.id;
  if (userId) return `user:${String(userId)}`;
  return `ip:${ipKey(String(req.ip || req.socket.remoteAddress || 'unknown'))}`;
}

function scopedKey(req: Request, scope: LimitScope): string {
  const params = req.params ?? {};
  if (scope === 'rest') {
    return `${scope}:${clientKey(req)}:table:${params.model ?? 'unknown'}:action:${actionFromMethod(req.method)}`;
  }
  if (scope === 'edge') {
    return `${scope}:${clientKey(req)}:route:${params.route ?? 'unknown'}:action:invoke`;
  }
  return `${scope}:${clientKey(req)}`;
}

/**
 * The request logger records the 429 itself, but not who was throttled: its
 * line has no client key, and a rate limit is only actionable once you know
 * whether one caller is hammering the API or every caller is.
 */
function logRateLimit(req: Request, scope: LimitScope): void {
  logActivity('warn', 'shield', `[shield] rate limit ${scope} ${req.method} ${req.originalUrl} key=${scopedKey(req, scope)}`);
}

/**
 * Wrap a limiter factory so the instance is replaced whenever the window
 * changes, and reused for every request in between.
 *
 * The exported limiters are installed into the express stack once at boot, so
 * they have to be stable references; only what they delegate to can change.
 */
function rebuildable(build: () => RequestHandler): RequestHandler {
  let limiter = build();
  rebuildHooks.push(() => { limiter = build(); });
  return (req: Request, res: Response, next: NextFunction) => limiter(req, res, next);
}

function createLimiter(scope: LimitScope, limitFor: () => number, message: string): RequestHandler {
  return rebuildable(() =>
    rateLimit({
      windowMs,
      limit: () => limitFor(),
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: req => scopedKey(req, scope),
      handler: (req, res, _next, options) => {
        shieldTelemetry.recordRateLimit(req, scope, scopedKey(req, scope));
        logRateLimit(req, scope);
        return res.status(options.statusCode).json(apiErrorEnvelope('RATE_LIMITED', message, req.id));
      },
    }));
}

export const authLimiter = createLimiter('auth', () => current.auth, 'Too many attempts, please try again later.');

export const globalLimiter = createLimiter('global', () => current.global, 'Too many requests, please slow down.');

// REST is the one scope whose limit depends on the request (read vs write), so
// it builds its own limiter rather than going through createLimiter's single
// `limitFor`. It is rebuilt on a window change exactly like the others.
export const restApiLimiter = rebuildable(() =>
  rateLimit({
    windowMs,
    limit: req => (req.method === 'GET' ? current.restRead : current.restWrite),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => scopedKey(req, 'rest'),
    handler: (req, res, _next, options) => {
      shieldTelemetry.recordRateLimit(req, 'rest', scopedKey(req, 'rest'));
      logRateLimit(req, 'rest');
      return res.status(options.statusCode).json(apiErrorEnvelope('RATE_LIMITED',
        'Too many REST requests for this table/action, please slow down.', req.id));
    },
  }));

export const edgeInvokeLimiter = createLimiter('edge', () => current.edge, 'Too many edge invocations, please slow down.');

export const rateLimitConfig = {
  get windowMs() {
    return windowMs;
  },
  get limits() {
    return currentRateLimitLimits();
  },
};
