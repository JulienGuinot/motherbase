import type { Request, Response } from 'express';

type TrafficSource = 'auth' | 'rest' | 'edge' | 'files' | 'api';

interface HttpTrafficEvent {
  id: number;
  at: string;
  method: string;
  path: string;
  source: TrafficSource;
  status: number;
  durationMs: number;
  ip: string;
  userId?: string;
  table?: string;
  action?: string;
}

interface RateLimitHit {
  id: number;
  at: string;
  scope: string;
  key: string;
  ip: string;
  userId?: string;
  method: string;
  path: string;
  table?: string;
  action?: string;
}

export interface RouteMetric {
  route: string;
  source: TrafficSource;
  count: number;
  errors: number;
  slow: number;
  avgMs: number;
  p95Ms: number;
}

interface AbuseCandidate {
  key: string;
  count: number;
  errors: number;
  rateLimited: number;
  topPath: string;
}

const DEFAULT_CAPACITY = 2000;
const SLOW_MS = 1000;

function clientIp(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

function requestUserId(req: Request): string | undefined {
  const user = (req as any).user;
  return user?.id ? String(user.id) : undefined;
}

function sourceFromPath(path: string): TrafficSource {
  if (path.startsWith('/api/auth')) return 'auth';
  if (path.startsWith('/rest/v1')) return 'rest';
  if (path.startsWith('/api/edge')) return 'edge';
  if (path.startsWith('/api/files')) return 'files';
  return 'api';
}

/**
 * HTTP method mapped to the data-plane verb used in rate-limit bucket keys and
 * traffic events. Exported so the limiter and the telemetry cannot disagree
 * about what a PUT counts as.
 */
export function actionFromMethod(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'select';
    case 'POST':
      return 'insert';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return method.toLowerCase();
  }
}

function tableFromPath(path: string): string | undefined {
  return path.match(/^\/rest\/v1\/([^/?]+)/)?.[1] ?? path.match(/^\/api\/edge\/([^/?]+)/)?.[1];
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function pushBounded<T>(list: T[], item: T, capacity: number): void {
  list.push(item);
  if (list.length > capacity) list.splice(0, list.length - capacity);
}

class ShieldTelemetry {
  private seq = 0;
  private rateSeq = 0;
  private traffic: HttpTrafficEvent[] = [];
  private rateLimitHits: RateLimitHit[] = [];

  constructor(private capacity = DEFAULT_CAPACITY) {}

  recordRequest(req: Request, res: Response, durationMs: number): HttpTrafficEvent {
    const path = req.originalUrl || req.url;
    const event: HttpTrafficEvent = {
      id: ++this.seq,
      at: new Date().toISOString(),
      method: req.method,
      path,
      source: sourceFromPath(path),
      status: res.statusCode,
      durationMs,
      ip: clientIp(req),
      userId: requestUserId(req),
      table: tableFromPath(path),
      action: actionFromMethod(req.method),
    };
    pushBounded(this.traffic, event, this.capacity);
    return event;
  }

  recordRateLimit(req: Request, scope: string, key: string): RateLimitHit {
    const path = req.originalUrl || req.url;
    const hit: RateLimitHit = {
      id: ++this.rateSeq,
      at: new Date().toISOString(),
      scope,
      key,
      ip: clientIp(req),
      userId: requestUserId(req),
      method: req.method,
      path,
      table: tableFromPath(path),
      action: actionFromMethod(req.method),
    };
    pushBounded(this.rateLimitHits, hit, this.capacity);
    return hit;
  }

  recentTraffic(limit?: number): HttpTrafficEvent[] {
    const events = [...this.traffic];
    if (limit === undefined || limit >= events.length) return events;
    return events.slice(events.length - limit);
  }

  recentRateLimits(limit?: number): RateLimitHit[] {
    const hits = [...this.rateLimitHits];
    if (limit === undefined || limit >= hits.length) return hits;
    return hits.slice(hits.length - limit);
  }

  /**
   * Requests and errors in the half-open interval `(from, to]`.
   *
   * Distinct from {@link runtimeSummary}, which counts a trailing window and so
   * overlaps with its own previous call. The metrics sampler needs counts that
   * can be summed: a 10s sampler reading a 60s window put every request into six
   * consecutive samples, and the console added those up and displayed roughly
   * six times the traffic the project actually served.
   */
  countsBetween(fromMs: number, toMs: number): { requests: number; errors: number } {
    let requests = 0;
    let errors = 0;
    for (const event of this.traffic) {
      const at = Date.parse(event.at);
      if (at <= fromMs || at > toMs) continue;
      requests++;
      if (event.status >= 400) errors++;
    }
    return { requests, errors };
  }

  runtimeSummary(windowMs = 60 * 1000) {
    const since = Date.now() - windowMs;
    const traffic = this.traffic.filter(event => Date.parse(event.at) >= since);
    const durations = traffic.map(event => event.durationMs);

    return {
      windowMs,
      requests: traffic.length,
      throughputRps: Math.round((traffic.length / (windowMs / 1000)) * 100) / 100,
      p95Ms: percentile(durations, 95),
    };
  }

  summarize(windowMs = 60 * 60 * 1000) {
    const since = Date.now() - windowMs;
    const traffic = this.traffic.filter(event => Date.parse(event.at) >= since);
    const rateLimits = this.rateLimitHits.filter(hit => Date.parse(hit.at) >= since);

    const byRoute = new Map<string, HttpTrafficEvent[]>();
    for (const event of traffic) {
      const route = this.routeKey(event);
      const list = byRoute.get(route) ?? [];
      list.push(event);
      byRoute.set(route, list);
    }

    const routes: RouteMetric[] = Array.from(byRoute.entries())
      .map(([route, events]) => {
        const durations = events.map(event => event.durationMs);
        return {
          route,
          source: events[0].source,
          count: events.length,
          errors: events.filter(event => event.status >= 400).length,
          slow: events.filter(event => event.durationMs >= SLOW_MS).length,
          avgMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / events.length),
          p95Ms: percentile(durations, 95),
        };
      })
      .sort((a, b) => b.errors - a.errors || b.slow - a.slow || b.count - a.count);

    const abuse = this.abuseCandidates(traffic, rateLimits);

    return {
      windowMs,
      counts: {
        requests: traffic.length,
        errors: traffic.filter(event => event.status >= 400).length,
        slow: traffic.filter(event => event.durationMs >= SLOW_MS).length,
        rateLimited: rateLimits.length,
      },
      routes: routes.slice(0, 20),
      abuse: abuse.slice(0, 20),
      rateLimits: rateLimits.slice(-50).reverse(),
    };
  }

  reset(): void {
    this.traffic = [];
    this.rateLimitHits = [];
  }

  // Grouped per table or function, and shown as the path that was called:
  // `/rest/v1/projects?id=eq.1` and `/rest/v1/projects/rpc` both count as `/rest/v1/projects`.
  private routeKey(event: HttpTrafficEvent): string {
    if (event.source === 'rest' && event.table) return `${event.method} /rest/v1/${event.table}`;
    if (event.source === 'edge' && event.table) return `${event.method} /api/edge/${event.table}`;
    return `${event.method} ${event.path.split('?')[0]}`;
  }

  private abuseCandidates(traffic: HttpTrafficEvent[], hits: RateLimitHit[]): AbuseCandidate[] {
    const map = new Map<string, { events: HttpTrafficEvent[]; hits: RateLimitHit[] }>();
    for (const event of traffic) {
      const key = event.userId ? `user:${event.userId}` : `ip:${event.ip}`;
      const bucket = map.get(key) ?? { events: [], hits: [] };
      bucket.events.push(event);
      map.set(key, bucket);
    }
    for (const hit of hits) {
      const key = hit.userId ? `user:${hit.userId}` : `ip:${hit.ip}`;
      const bucket = map.get(key) ?? { events: [], hits: [] };
      bucket.hits.push(hit);
      map.set(key, bucket);
    }

    return Array.from(map.entries())
      .map(([key, bucket]) => {
        const pathCounts = new Map<string, number>();
        for (const event of bucket.events) pathCounts.set(event.path, (pathCounts.get(event.path) ?? 0) + 1);
        for (const hit of bucket.hits) pathCounts.set(hit.path, (pathCounts.get(hit.path) ?? 0) + 1);
        const topPath = Array.from(pathCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
        return {
          key,
          count: bucket.events.length,
          errors: bucket.events.filter(event => event.status >= 400).length,
          rateLimited: bucket.hits.length,
          topPath,
        };
      })
      .filter(item => item.rateLimited > 0 || item.errors >= 5 || item.count >= 250)
      .sort((a, b) => b.rateLimited - a.rateLimited || b.errors - a.errors || b.count - a.count);
  }
}

export type ShieldTelemetrySummary = ReturnType<ShieldTelemetry['summarize']>;

export const shieldTelemetry = new ShieldTelemetry();
