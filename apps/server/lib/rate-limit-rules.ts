import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Custom, operator-defined rate-limit rules. These layer on top of the fixed
// built-in scopes (middlewares/rate-limit.ts) and can only ADD restriction:
// every rule that matches a request is evaluated and the request is blocked as
// soon as any of them is over its budget (most-restrictive-wins). Everything in
// this module is pure and side-effect-free so it can be unit-tested in isolation;
// the Express glue lives in middlewares/custom-rate-limit.ts.

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'] as const;
const RULE_KEYS = ['ip', 'user', 'apiKey', 'role', 'global'] as const;

/** Max number of rules: bounds the per-request evaluation cost. */
const MAX_RULES = 100;
/** One day, in seconds: an upper bound on a rule's window. */
const MAX_WINDOW_SEC = 86_400;

export const rateLimitRuleSchema = z.object({
  id: z.string().min(1).default(() => ruleId()),
  name: z.string().min(1, 'name is required').max(80),
  enabled: z.boolean().default(true),
  match: z
    .object({
      methods: z.array(z.enum(HTTP_METHODS)).optional(),
      pathGlob: z.string().min(1).optional(),
      roles: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  key: z.enum(RULE_KEYS),
  windowSec: z.coerce.number().int().positive().max(MAX_WINDOW_SEC),
  max: z.coerce.number().int().positive(),
});

export type RateLimitRule = z.infer<typeof rateLimitRuleSchema>;

export const rateLimitRulesSchema = z.object({
  rules: z.array(rateLimitRuleSchema).max(MAX_RULES).default([]),
});

export interface RequestCtx {
  method: string;
  path: string;
  /** Resolved role, or 'anon' when unauthenticated. */
  role: string;
  ip: string;
  userId?: string;
  /** A stable, non-secret identifier for the presented API key (e.g. a hash). */
  apiKeyId?: string;
}

// ── glob matching ─────────────────────────────────────────────────────────────
// A tiny glob: `*` = any run of chars, `?` = one char. Anchored full-match.
// Shared with the CAPTCHA route guard, so a path glob means one thing everywhere.
const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`, 'i');
  globCache.set(glob, re);
  return re;
}

// ── matching ──────────────────────────────────────────────────────────────────
export function matchRule(rule: RateLimitRule, ctx: RequestCtx): boolean {
  if (!rule.enabled) return false;
  const { methods, pathGlob, roles } = rule.match;
  if (methods && methods.length && !methods.includes(ctx.method.toUpperCase() as (typeof HTTP_METHODS)[number])) {
    return false;
  }
  if (pathGlob && !globToRegExp(pathGlob).test(ctx.path)) return false;
  if (roles && roles.length && !roles.includes(ctx.role)) return false;
  return true;
}

/** The counter bucket for a rule + request. user/apiKey fall back to IP so an
 *  anonymous caller cannot bypass the rule by withholding its identity. */
export function bucketKey(rule: RateLimitRule, ctx: RequestCtx): string {
  const suffix = (() => {
    switch (rule.key) {
      case 'ip':
        return ctx.ip;
      case 'user':
        return ctx.userId ?? `ip:${ctx.ip}`;
      case 'apiKey':
        return ctx.apiKeyId ?? `ip:${ctx.ip}`;
      case 'role':
        return ctx.role;
      case 'global':
        return 'all';
    }
  })();
  return `${rule.id}:${rule.key}:${suffix}`;
}

/** True when any enabled rule needs the caller's identity resolved (user/role/
 *  apiKey key or a role filter). Lets the middleware skip identity resolution
 *  entirely for purely IP/global rule sets. */
export function ruleNeedsIdentity(rules: RateLimitRule[]): boolean {
  return rules.some(
    r => r.enabled && (r.key === 'user' || r.key === 'apiKey' || r.key === 'role' || !!r.match.roles?.length),
  );
}

// ── in-memory fixed-window store ──────────────────────────────────────────────
interface Window {
  count: number;
  resetAt: number; // epoch ms
}

export interface HitResult {
  limited: boolean;
  remaining: number;
  resetAt: number;
}

export class FixedWindowStore {
  private windows = new Map<string, Window>();
  private lastSweep = 0;

  hit(key: string, windowSec: number, max: number, now = Date.now()): HitResult {
    this.maybeSweep(now);
    const windowMs = windowSec * 1000;
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const limited = w.count > max;
    return { limited, remaining: Math.max(0, max - w.count), resetAt: w.resetAt };
  }

  /** Drop expired windows so the map cannot grow unbounded. Runs at most once a minute. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(key);
    }
  }

  clear(): void {
    this.windows.clear();
    this.lastSweep = 0;
  }
}

// ── evaluation (most-restrictive-wins) ───────────────────────────────────────
export interface EvalResult {
  limited: boolean;
  /** The rule that triggered the block (the first matched rule found over budget). */
  rule?: RateLimitRule;
  retryAfterSec?: number;
  resetAt?: number;
}

export function evaluateRules(
  rules: RateLimitRule[],
  ctx: RequestCtx,
  store: FixedWindowStore,
  now = Date.now(),
): EvalResult {
  let blocked: EvalResult | null = null;
  // Every matching rule is counted (each tracks its own budget); the first one
  // found over its limit becomes the reported trigger.
  for (const rule of rules) {
    if (!matchRule(rule, ctx)) continue;
    const res = store.hit(bucketKey(rule, ctx), rule.windowSec, rule.max, now);
    if (res.limited && !blocked) {
      blocked = {
        limited: true,
        rule,
        retryAfterSec: Math.max(1, Math.ceil((res.resetAt - now) / 1000)),
        resetAt: res.resetAt,
      };
    }
  }
  return blocked ?? { limited: false };
}

// A stable, unique handle for a rule. Not a secret and never used as one: the
// name says `rule`, not `crypto`, so nobody reaches for it as a token source.
function ruleId(): string {
  return `rule_${randomUUID()}`;
}
