import { Request } from 'express';
import { CorsOptions, CorsOptionsDelegate } from 'cors';
import { env } from '../config/env';
import { logBuffer } from '../models';

export interface ServerCorsSettings {
  origins?: unknown;
  credentials?: unknown;
}

type LoadCorsSettings = () => Promise<ServerCorsSettings>;
type FallbackCorsSettings = () => ServerCorsSettings;

const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export interface BucketCorsSettings {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  maxAgeSec: number;
}

// The CORS delegate runs on every request, so logging each decision floods the
// log buffer with identical "ALLOWED origin=…" lines. Remember which decisions
// we've already logged and only surface a decision the first time we see it.
// The origin is client-controlled, so the set is capped: past the cap it starts over.
const MAX_SEEN_CORS_DECISIONS = 500;
const seenCorsDecisions = new Set<string>();

/** Reset the CORS decision log cache. Test-only. */
export function resetCorsDecisionLog(): void {
  seenCorsDecisions.clear();
}

/** One warn line per distinct message, so a hostile origin cannot spam the buffer. */
function warnOnce(message: string): void {
  if (seenCorsDecisions.has(message)) return;
  if (seenCorsDecisions.size >= MAX_SEEN_CORS_DECISIONS) seenCorsDecisions.clear();
  seenCorsDecisions.add(message);
  logBuffer.push({ level: 'warn', source: 'cors', message });
}

export function parseCorsOrigins(origins: unknown): string[] {
  if (typeof origins !== 'string') return [];
  return origins.split(',').map(o => o.trim()).filter(Boolean);
}

export function resolveCorsOrigin(requestOrigin: string | undefined, configuredOrigins: unknown): boolean | string {
  const allowed = parseCorsOrigins(configuredOrigins);
  if (!allowed.length || allowed.includes('*')) return true;
  if (!requestOrigin) return true;
  return allowed.includes(requestOrigin) ? requestOrigin : false;
}

function resolveCorsCredentials(credentials: unknown): boolean {
  if (typeof credentials === 'boolean') return credentials;
  if (typeof credentials === 'string') return credentials.toLowerCase() === 'true';
  return true;
}

export function buildCorsOptions(requestOrigin: string | undefined, settings: ServerCorsSettings): CorsOptions {
  const origin = resolveCorsOrigin(requestOrigin, settings.origins);
  let credentials = resolveCorsCredentials(settings.credentials);
  // Reflecting any origin while allowing credentials is an account-takeover
  // vector. In production we refuse that combination outright.
  if (origin === true && credentials && env.NODE_ENV === 'production') {
    credentials = false;
    // Silently dropping credentials is worse than denying: the browser then
    // fails every `credentials: 'include'` call with an opaque CORS error, and
    // the OAuth start endpoint is one of them: its state cookie never lands and
    // the provider callback comes back as `?error=state_mismatch`. Say so once,
    // and name the setting that fixes it.
    if (requestOrigin) {
      warnOnce(
        `CREDENTIALS DISABLED origin="${requestOrigin}". No allowlist is configured, so cookies are ` +
          'refused for cross-origin calls and social sign-in fails with state_mismatch. ' +
          'Set Security · CORS > allowed origins to your app origins.',
      );
    }
  }

  // Only denials are worth surfacing. Logging allowed decisions floods the buffer
  // with identical "ALLOWED origin=…" lines: worst of all "(no origin)" for
  // same-origin / server-to-server calls that happen on every request. Denials
  // still surface (deduped, so a hostile origin hammering us doesn't spam either).
  if (origin === false) {
    const allowed = parseCorsOrigins(settings.origins);
    const originLabel = requestOrigin ?? '(no origin)';
    const configuredLabel = allowed.length ? allowed.join(', ') : '* (allow-all)';
    warnOnce(`DENIED origin="${originLabel}" configured=[${configuredLabel}]`);
  }

  return {
    origin,
    credentials,
    methods: CORS_METHODS,
    optionsSuccessStatus: 204,
  };
}

/**
 * Boot-time guard: in production an explicit CORS allowlist is mandatory.
 * Returns an error string when misconfigured (caller decides to exit), null otherwise.
 */
export function validateProdCorsConfig(): string | null {
  if (env.NODE_ENV !== 'production') return null;
  const origins = parseCorsOrigins(env.CORS_ORIGINS);
  if (!origins.length || origins.includes('*')) {
    return 'CORS_ORIGINS must be an explicit allowlist (no empty value or "*") in production.';
  }
  return null;
}

export function createCorsOptionsDelegate(
  loadSettings: LoadCorsSettings,
  fallbackSettings: FallbackCorsSettings = () => ({ origins: env.CORS_ORIGINS, credentials: true }),
  loadBucketCors?: (req: Request) => Promise<BucketCorsSettings | null>,
): CorsOptionsDelegate<Request> {
  return (req, callback) => {
    const requestOrigin = req.headers.origin as string | undefined;
    loadSettings()
      .catch(() => fallbackSettings())
      .then(async settings => {
        // App origins always retain the API's methods, headers and credentials.
        // Bucket rules only extend that baseline, on the storage routes.
        if (loadBucketCors && requestOrigin && resolveCorsOrigin(requestOrigin, settings.origins) === false) {
          const bucket = await loadBucketCors(req).catch(() => null);
          if (bucket && (bucket.allowedOrigins.includes('*') || bucket.allowedOrigins.includes(requestOrigin))) {
            return callback(null, {
              origin: requestOrigin,
              // Additional bucket origins never inherit access to session cookies.
              credentials: false,
              methods: bucket.allowedMethods,
              // Reflect requested headers for *, including Authorization, which
              // browsers do not treat as covered by a literal wildcard.
              allowedHeaders: bucket.allowedHeaders.includes('*') ? undefined : bucket.allowedHeaders,
              maxAge: bucket.maxAgeSec,
              optionsSuccessStatus: 204,
            });
          }
        }
        callback(null, buildCorsOptions(requestOrigin, settings));
      })
      .catch(callback);
  };
}
