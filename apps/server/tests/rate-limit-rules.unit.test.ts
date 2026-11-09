import { describe, it, expect } from 'vitest';
import {
  rateLimitRuleSchema,
  matchRule,
  bucketKey,
  FixedWindowStore,
  evaluateRules,
  ruleNeedsIdentity,
  type RateLimitRule,
  type RequestCtx,
} from '../lib/rate-limit-rules';

function rule(partial: Partial<RateLimitRule> = {}): RateLimitRule {
  return rateLimitRuleSchema.parse({
    id: 'r1',
    name: 'test',
    enabled: true,
    match: {},
    key: 'ip',
    windowSec: 60,
    max: 5,
    ...partial,
  });
}

function ctx(partial: Partial<RequestCtx> = {}): RequestCtx {
  return { method: 'GET', path: '/rest/orders', role: 'anon', ip: '1.2.3.4', ...partial };
}

// ── schema ───────────────────────────────────────────────────────────────────
describe('rateLimitRuleSchema', () => {
  it('rejects a non-positive window or max', () => {
    expect(() => rule({ windowSec: 0 })).toThrow();
    expect(() => rule({ max: 0 })).toThrow();
  });

  it('defaults an empty match to match-anything', () => {
    const r = rule();
    expect(r.match.methods ?? []).toEqual([]);
    expect(r.match.pathGlob).toBeUndefined();
  });
});

// ── matchRule ────────────────────────────────────────────────────────────────
describe('matchRule', () => {
  it('matches any request when no filters are set', () => {
    expect(matchRule(rule(), ctx())).toBe(true);
  });

  it('filters by HTTP method (case-insensitive)', () => {
    const r = rule({ match: { methods: ['POST'] } });
    expect(matchRule(r, ctx({ method: 'post' }))).toBe(true);
    expect(matchRule(r, ctx({ method: 'GET' }))).toBe(false);
  });

  it('filters by path glob', () => {
    const r = rule({ match: { pathGlob: '/auth/*' } });
    expect(matchRule(r, ctx({ path: '/auth/sign-in' }))).toBe(true);
    expect(matchRule(r, ctx({ path: '/rest/orders' }))).toBe(false);
  });

  it('matches the path glob case-insensitively, like the router does', () => {
    const r = rule({ match: { pathGlob: '/api/auth/*' } });
    expect(matchRule(r, ctx({ path: '/API/Auth/sign-in' }))).toBe(true);
  });

  it('filters by role, including the anon pseudo-role', () => {
    const r = rule({ match: { roles: ['ADMIN'] } });
    expect(matchRule(r, ctx({ role: 'ADMIN' }))).toBe(true);
    expect(matchRule(r, ctx({ role: 'USER' }))).toBe(false);
    const anon = rule({ match: { roles: ['anon'] } });
    expect(matchRule(anon, ctx({ role: 'anon' }))).toBe(true);
  });

  it('never matches a disabled rule', () => {
    expect(matchRule(rule({ enabled: false }), ctx())).toBe(false);
  });
});

// ── bucketKey ────────────────────────────────────────────────────────────────
describe('bucketKey', () => {
  it('buckets by IP', () => {
    expect(bucketKey(rule({ key: 'ip' }), ctx({ ip: '9.9.9.9' }))).toBe('r1:ip:9.9.9.9');
  });

  it('buckets by user id, falling back to IP when anonymous', () => {
    const r = rule({ key: 'user' });
    expect(bucketKey(r, ctx({ userId: 'u42' }))).toBe('r1:user:u42');
    expect(bucketKey(r, ctx({ ip: '5.5.5.5' }))).toBe('r1:user:ip:5.5.5.5');
  });

  it('buckets globally with one shared counter', () => {
    expect(bucketKey(rule({ key: 'global' }), ctx({ ip: 'x' }))).toBe('r1:global:all');
  });
});

// ── FixedWindowStore ─────────────────────────────────────────────────────────
describe('FixedWindowStore', () => {
  it('counts hits within a window and blocks past the max', () => {
    const store = new FixedWindowStore();
    const t0 = 1_000_000;
    expect(store.hit('k', 60, 2, t0).limited).toBe(false);
    expect(store.hit('k', 60, 2, t0 + 1).limited).toBe(false);
    expect(store.hit('k', 60, 2, t0 + 2).limited).toBe(true);
  });

  it('resets the counter after the window elapses', () => {
    const store = new FixedWindowStore();
    const t0 = 1_000_000;
    store.hit('k', 60, 1, t0);
    expect(store.hit('k', 60, 1, t0).limited).toBe(true);
    // Past the 60s window → fresh budget.
    expect(store.hit('k', 60, 1, t0 + 60_001).limited).toBe(false);
  });

  it('keeps independent buckets separate', () => {
    const store = new FixedWindowStore();
    const t0 = 1_000_000;
    store.hit('a', 60, 1, t0);
    expect(store.hit('b', 60, 1, t0).limited).toBe(false);
  });
});

// ── evaluateRules (most-restrictive-wins) ────────────────────────────────────
describe('evaluateRules', () => {
  it('blocks as soon as any matching rule is over its limit', () => {
    const store = new FixedWindowStore();
    const loose = rule({ id: 'loose', max: 100, windowSec: 60 });
    const strict = rule({ id: 'strict', max: 1, windowSec: 60 });
    const t0 = 1_000_000;

    const first = evaluateRules([loose, strict], ctx(), store, t0);
    expect(first.limited).toBe(false);
    const second = evaluateRules([loose, strict], ctx(), store, t0 + 1);
    expect(second.limited).toBe(true);
    expect(second.rule?.id).toBe('strict'); // the restrictive one triggered
  });

  it('ignores rules that do not match the request', () => {
    const store = new FixedWindowStore();
    const other = rule({ id: 'other', max: 1, match: { pathGlob: '/edge/*' } });
    const t0 = 1_000_000;
    evaluateRules([other], ctx({ path: '/rest/orders' }), store, t0);
    const again = evaluateRules([other], ctx({ path: '/rest/orders' }), store, t0 + 1);
    expect(again.limited).toBe(false); // never counted → never limited
  });
});

// ── ruleNeedsIdentity ────────────────────────────────────────────────────────
describe('ruleNeedsIdentity', () => {
  it('is true only when a rule keys by or filters on identity', () => {
    expect(ruleNeedsIdentity([rule({ key: 'ip' })])).toBe(false);
    expect(ruleNeedsIdentity([rule({ key: 'user' })])).toBe(true);
    expect(ruleNeedsIdentity([rule({ key: 'role' })])).toBe(true);
    expect(ruleNeedsIdentity([rule({ key: 'apiKey' })])).toBe(true);
    expect(ruleNeedsIdentity([rule({ key: 'ip', match: { roles: ['ADMIN'] } })])).toBe(true);
    expect(ruleNeedsIdentity([rule({ enabled: false, key: 'user' })])).toBe(false);
  });
});
