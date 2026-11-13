import { Request, Response, NextFunction } from 'express';
import { logBuffer } from '../models';
import { shieldTelemetry } from '../lib/shield-telemetry';
import { requestMeter } from '../services/admin/request-metrics.service';

// Studio-internal routes that are too noisy to surface in the Logs screen.
// These are either self-referential (polling the log buffer itself) or
// Studio meta-browsing that is not meaningful to the server owner.
// SQL operations are still captured via source:'sql' by SqlService.audit.
const SKIP_PREFIXES = [
  '/api/admin/',   // Studio internal management (logs polling, table browsing, schema introspection…)
  '/api/health-check', // Health probes
];

/**
 * Redirect target for the log line. The fragment is dropped on purpose: the
 * OAuth callback puts the session token there (see auth/oauth-redirect.ts) and
 * the log buffer is readable from Studio. Long targets are cut; the point is to
 * see *where* a 3xx went, not to archive the URL.
 */
export function redirectTargetForLog(location: number | string | string[] | undefined): string | null {
  if (typeof location !== 'string' || !location) return null;
  const clean = scrubUrlForLog(location.split('#')[0]);
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

const SENSITIVE_QUERY_PARAM = /([?&][^=&]*(?:token|code|secret|key|password|otp|sig)[^=&]*=)[^&]*/gi;
const RESET_TOKEN_SEGMENT = /(\/reset-password\/)[^/?#]+/gi;

/**
 * A URL with its credentials masked: the reset-password token path segment and
 * the value of any `?token=`/`code=`/`key=`-style parameter. Other parameters
 * stay, because `?error=state_mismatch` is the reason a request was bounced.
 */
export function scrubUrlForLog(url: string): string {
  return url.replace(RESET_TOKEN_SEGMENT, '$1[redacted]').replace(SENSITIVE_QUERY_PARAM, '$1[redacted]');
}

/**
 * Caller address. `req.ip` already honours `trust proxy` (set from
 * TRUST_PROXY in app.ts), so behind a reverse proxy this is the real client
 * and not the proxy. Same derivation as shield-telemetry and the rate limiter.
 */
function clientIp(req: Request): string | undefined {
  return String(req.ip || req.socket.remoteAddress || '') || undefined;
}

/** User agents are unbounded attacker-controlled input; the column is not. */
function userAgent(req: Request): string | undefined {
  const raw = req.get('user-agent');
  if (!raw) return undefined;
  return raw.length > 512 ? `${raw.slice(0, 512)}…` : raw;
}

/**
 * Records one log line per finished HTTP request into the shared LogBuffer so
 * the Studio Logs screen can show recent activity. Complements morgan, which
 * still writes to the console.
 *
 * Only logs requests to user-facing API routes. Studio-internal traffic
 * (admin panel, health checks) is deliberately excluded so the Logs screen
 * surfaces real external usage rather than the owner's own Studio activity.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const url = req.originalUrl;

  // In-memory per-process request meter (total + req/min). Counts all traffic
  // except health probes, which are frequent and not meaningful usage. Runs
  // before the Studio-noise skip so admin/console API calls are still metered.
  if (!url.startsWith('/api/health-check')) {
    requestMeter.record();
  }

  if (SKIP_PREFIXES.some(prefix => url.startsWith(prefix))) {
    return next();
  }

  // What is left is the project being used, which is what auto-pause waits on.
  requestMeter.touch();

  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    shieldTelemetry.recordRequest(req, res, ms);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const redirect = res.statusCode >= 300 && res.statusCode < 400 ? redirectTargetForLog(res.getHeader('location')) : null;
    logBuffer.push({
      level,
      source: 'http',
      // Structured twin of the message. The Logs screen shows these as
      // selectable columns; the sentence below stays the human summary.
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: ms,
      ip: clientIp(req),
      userAgent: userAgent(req),
      requestId: req.id ? String(req.id) : undefined,
      userId: req.user?.id,
      // The id is echoed to the caller as `x-request-id`, so a report naming
      // one failing call can be found in this buffer instead of guessed at.
      // A 3xx says nothing without its target: an auth failure redirects to
      // /api/auth/error?error=… and that reason is only in the Location header.
      message: `${req.method} ${scrubUrlForLog(req.originalUrl)} → ${res.statusCode} (${ms}ms)${redirect ? ` ⇢ ${redirect}` : ''}${req.id ? ` [${req.id}]` : ''}`,
    });
  });
  next();
};
