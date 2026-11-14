import type { Request, RequestHandler } from 'express';
import { shieldTelemetry } from '../lib/shield-telemetry';
import {
  FixedWindowStore,
  bucketKey,
  evaluateRules,
  rateLimitRulesSchema,
  ruleNeedsIdentity,
  type RateLimitRule,
  type RequestCtx,
} from '../lib/rate-limit-rules';
import { apiErrorEnvelope } from './api-error.middleware';
import { signedInUser } from '../auth/signed-in-user';

// Express glue for the operator-defined rate-limit rules engine. The matching
// and counting logic is the pure module in lib/rate-limit-rules.ts; this file
// owns the module-level live state (current rules + the in-memory counter store)
// and the one middleware mounted in app.ts.

interface ResolvedIdentity {
  userId?: string;
  role?: string;
  /** A stable, non-secret identifier for the presented API key (e.g. a hash). */
  apiKeyId?: string;
}

type IdentityResolver = (req: Request) => Promise<ResolvedIdentity> | ResolvedIdentity;

let currentRules: RateLimitRule[] = [];
let needsIdentity = false;
let resolveIdentity: IdentityResolver | null = null;
const store = new FixedWindowStore();

/**
 * Replace the live rule set. Invalid input is ignored (previous rules kept) so a
 * bad save can never disable limiting: the settings layer validates first, this
 * is defence in depth.
 */
export function applyRateLimitRules(input: unknown): void {
  const parsed = rateLimitRulesSchema.safeParse(input ?? {});
  if (!parsed.success) return;
  currentRules = parsed.data.rules;
  needsIdentity = ruleNeedsIdentity(currentRules);
}

/**
 * Inject how identity is resolved from a request (user id / role / api-key id).
 * Kept as a dependency so this module stays decoupled from auth + the container
 * and remains unit-testable. Resolution runs only when a rule actually needs it.
 */
export function setRateLimitIdentityResolver(fn: IdentityResolver | null): void {
  resolveIdentity = fn;
}

export function __resetRateLimitRulesForTests(): void {
  currentRules = [];
  needsIdentity = false;
  resolveIdentity = null;
  store.clear();
}

function clientIp(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

export const customRulesLimiter: RequestHandler = async (req, res, next) => {
  const enabled = currentRules.filter(r => r.enabled);
  if (!enabled.length) return next();

  // Resolve identity lazily: only when at least one enabled rule keys by or
  // filters on it. Purely IP/global rule sets add zero per-request cost.
  let identity: ResolvedIdentity = {};
  if (needsIdentity && resolveIdentity) {
    try {
      identity = (await resolveIdentity(req)) ?? {};
    } catch {
      identity = {};
    }
  }

  const userId = identity.userId ?? signedInUser(req)?.id;
  const role = identity.role ?? signedInUser(req)?.role ?? 'anon';

  const ctx: RequestCtx = {
    method: req.method,
    path: req.path,
    role: String(role),
    ip: clientIp(req),
    userId: userId ? String(userId) : undefined,
    apiKeyId: identity.apiKeyId,
  };

  const result = evaluateRules(enabled, ctx, store);
  if (result.limited && result.rule) {
    shieldTelemetry.recordRateLimit(req, `custom:${result.rule.name}`, bucketKey(result.rule, ctx));
    if (result.retryAfterSec) res.setHeader('Retry-After', String(result.retryAfterSec));
    return res.status(429).json(apiErrorEnvelope('RATE_LIMITED',
      `Rate limit "${result.rule.name}" exceeded, please slow down.`, req.id));
  }
  return next();
};
