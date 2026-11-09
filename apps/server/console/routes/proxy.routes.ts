import { Router, Request, Response, RequestHandler } from 'express';
import httpProxy from 'http-proxy';
import rateLimit from 'express-rate-limit';
import { SAFE_METHODS } from '../constants';
import { errorMessage } from '../../lib/errors';
import { requireProjectCapability, type Capability } from '../auth/capabilities';
import { sessionUser } from '../auth/session';
import { groupHasSecrets } from '../../config/settings';
import { auditMutations, type AuditMutation } from '../middlewares/audit.middleware';
import type { AuditStore } from '../services/audit.service';
import { proxyMetrics } from '../services/proxy-metrics.service';

const proxy = httpProxy.createProxyServer({});


proxy.on('proxyReq', (proxyReq: any, req: any) => {
  const body = jsonBodyForProxy(req);
  if (!body) return;
  proxyReq.setHeader('Content-Type', 'application/json');
  proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
  proxyReq.write(body);
});



export function jsonBodyForProxy(req: any): string | null {
  if (!req.body || req.readableLength) return null;

  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) return null;

  return JSON.stringify(req.body);
}

export type UpstreamProbe = (url: string) => Promise<boolean>;

const defaultProbe: UpstreamProbe = async url => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export function resolveTarget(projectId: string, originalUrl: string, target = `http://${projectId}-api:5001`) {
  const marker = `/api/projects/${projectId}/admin`;
  const rest = originalUrl.startsWith(marker) ? originalUrl.slice(marker.length) : '';
  return { target, rewrittenPath: `/api/admin${rest}` };
}

export function resolveEdgeTarget(projectId: string, originalUrl: string, target = `http://${projectId}-api:5001`) {
  const marker = `/api/projects/${projectId}/edge`;
  const rest = originalUrl.startsWith(marker) ? originalUrl.slice(marker.length) : '';
  return { target, rewrittenPath: `/api/edge${rest}` };
}

export function resolveRestTarget(projectId: string, originalUrl: string, target = `http://${projectId}-api:5001`) {
  const marker = `/api/projects/${projectId}/rest`;
  const rest = originalUrl.startsWith(marker) ? originalUrl.slice(marker.length) : '';
  return { target, rewrittenPath: `/rest${rest}` };
}

/**
 * First candidate that answers its health check, or undefined when none do.
 * Walks the whole list per attempt so a project whose `<name>-api` alias was
 * never registered still resolves via its container name or traefik IP.
 */
export async function selectUpstream(
  candidates: string[],
  probe: UpstreamProbe = defaultProbe,
  delays = [150, 300],
): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    for (const candidate of candidates) {
      if (await probe(`${candidate}/api/health-check`)) return candidate;
    }
    if (attempt >= delays.length) return undefined;
    await new Promise(resolve => setTimeout(resolve, delays[attempt]));
  }
}

// Probing on every proxied request would add a round trip to each call, so a
// resolved target is reused briefly. The proxy error handler drops the entry, so
// a container that moves or restarts is re-resolved on the next request instead
// of pinning the console to a dead address.
const UPSTREAM_TTL_MS = 10_000;

// Failures are cached too, and this is the load-bearing part: /rest and /edge
// take no session, so without it every anonymous request to a dead project pays
// a full probe sweep (candidates x attempts x the probe timeout) and a burst
// turns into a probe storm against the Docker network. Kept short because
// nothing invalidates it when the container comes back. No request reaches the
// proxy error handler while the stack is down, so it has to expire on its own.
export const UNREACHABLE_TTL_MS = 2_000;

const upstreamCache = new Map<string, { target: string; ready: boolean; expires: number }>();

// One sweep of the candidate list, no waiting between rounds.
const PUBLIC_PROBE_DELAYS: number[] = [];

export function invalidateUpstream(projectId: string): void {
  upstreamCache.delete(projectId);
}

async function candidateTargets(registry: any, projectId: string): Promise<string[]> {
  if (typeof registry?.apiTargets === 'function') {
    const targets = await registry.apiTargets(projectId);
    if (Array.isArray(targets) && targets.length) return targets;
  }
  const single = typeof registry?.apiTarget === 'function' ? await registry.apiTarget(projectId) : undefined;
  return [single ?? `http://${projectId}-api:5001`];
}

/**
 * Resolve the address to proxy to. `ready: false` means nothing answered. The
 * caller still proxies to the first candidate so the failure surfaces as the
 * usual 502 (with the upstream error logged) rather than a new error shape.
 */
export async function resolveUpstream(
  registry: any,
  projectId: string,
  probe: UpstreamProbe = defaultProbe,
  delays?: number[],
): Promise<{ target: string; ready: boolean }> {
  const cached = upstreamCache.get(projectId);
  if (cached && cached.expires > Date.now()) return { target: cached.target, ready: cached.ready };

  const candidates = await candidateTargets(registry, projectId);
  const reachable = await selectUpstream(candidates, probe, delays);
  const resolved = { target: reachable ?? candidates[0], ready: Boolean(reachable) };

  upstreamCache.set(projectId, {
    ...resolved,
    expires: Date.now() + (resolved.ready ? UPSTREAM_TTL_MS : UNREACHABLE_TTL_MS),
  });
  return resolved;
}

export async function proxyHeaders(registry: any, projectId: string): Promise<Record<string, string>> {
  const token = await registry.platformToken(projectId);
  if (!token) throw new Error(`no platform token for ${projectId}`);
  return { 'X-Platform-Token': token };
}

/**
 * Who is calling, for per-operator state in the project (private SQL
 * snippets). Always set, from the verified session and never from the
 * browser: applyAdminProxyHeaders overwrites any `x-platform-operator` the
 * request arrived with.
 */
export function operatorHeader(req: Request): Record<string, string> {
  return { 'X-Platform-Operator': sessionUser(req)?.id ?? '' };
}

// Shared by the admin, REST and edge proxy handlers. `cookie` is the console
// session, which an upstream (edge functions run operator-authored code) must
// never receive; the platform headers are ours to set, never the browser's.
export function stripBrowserCredentials(req: Request) {
  delete req.headers.cookie;
  delete req.headers['x-platform-token'];
  delete req.headers['x-platform-operator'];
}

export function stripBrowserCorsHeaders(req: Request) {
  delete req.headers.origin;
  delete req.headers.referer;
  stripBrowserCredentials(req);
}

function headerHosts(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value;
  return String(raw ?? '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

export function isSameOriginProxyRequest(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return false;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    return [...headerHosts(req.headers.host), ...headerHosts(req.headers['x-forwarded-host'])].includes(originHost);
  } catch {
    return false;
  }
}

export function stripSameOriginCorsHeaders(req: Request) {
  // A top-level navigation sends no Origin, so the credentials go regardless.
  stripBrowserCredentials(req);
  if (isSameOriginProxyRequest(req)) stripBrowserCorsHeaders(req);
}

export function applyAdminProxyHeaders(req: Request, headers: Record<string, string>) {
  delete req.headers.authorization;
  // Admin proxy calls are server-to-server. Do not let the project API's CORS
  // middleware evaluate the Console origin.
  stripBrowserCorsHeaders(req);
  for (const [key, value] of Object.entries(headers)) {
    req.headers[key.toLowerCase()] = value;
  }
}

interface Deps {
  registry: any;
  requireSession: RequestHandler;
  logs?: { push: (entry: { level: 'info' | 'warn' | 'error'; source: string; message: string }) => void };
  probe?: UpstreamProbe;
  audit?: AuditStore;
}


/** `/api/projects/:id/admin<rest>`, anchored so a project id such as `admin-shop` is not the admin surface. */
const ADMIN_PATH = /^\/api\/projects\/[^/]+\/admin(?=\/|\?|$)(\/[^?]*)?/;

// The segment reaches here already decoded (see `decodedAdminPath`), and a path
// whose encoding was ambiguous never reaches here at all.
function settingsGroupHasSecrets(segment: string): boolean {
  return groupHasSecrets(segment);
}

/**
 * The path the capability regexes read, percent-decoded once.
 *
 * Without this the capability decision and the upstream's own route matching
 * are two independent matchers over one string: `/admin/%65dge-secrets` misses
 * `/^\/edge-secrets/` here and, on a GET, falls through to SAFE_METHODS ->
 * project.read, while naming the same surface upstream.
 *
 * Returns null for anything whose encoding could still mean two things (a
 * failed decode, an encoded separator, a traversal). The caller demands the
 * highest capability for those rather than guessing: a malformed encoding must
 * never downgrade a request to project.read.
 */
export function decodedAdminPath(originalUrl: string): string | null {
  const raw = originalUrl.match(ADMIN_PATH)?.[1] ?? '/';
  if (/%2f|%5c/i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.includes('..') ? null : decoded;
}

/** Capability required by a proxied project-admin request. Keep this mapping
 * centralized so adding a new privileged surface cannot silently inherit write access.
 *
 * The checks are ORDERED and the first match wins, `/users` deliberately appears
 * in three of them, narrowest first:
 *   1. `/users` itself and its credential-adjacent actions (reset-password,
 *      revoke-sessions, delete a session)  -> secrets.manage
 *   2. `/users/:id/promote|demote`, which grants privilege                -> settings.write
 *   3. everything else under `/users` (ordinary profile edits)            -> content.write
 * Reordering these branches changes who can rotate a password. */
export function adminProxyCapability(method: string, originalUrl: string): Capability {
  const adminPath = decodedAdminPath(originalUrl);
  if (adminPath === null) return 'secrets.manage';
  if (/^\/edge-secrets(?:\/|$)/.test(adminPath)
    || /^\/api-keys(?:\/|$)/.test(adminPath)
    || /^\/database\/connection$/.test(adminPath)
    || /^\/storage\/connection$/.test(adminPath)
    // S3 access keys: creating one returns a credential that signs as the project.
    || /^\/storage\/s3(?:\/|$)/.test(adminPath)
    || /^\/storage\/buckets\/[^/]+\/tokens(?:\/|$)/.test(adminPath)
    || /^\/integrations(?:\/|$)/.test(adminPath)
    // The Vault list names what is stored and `reveal` returns plaintext; a
    // foreign server is a remote host plus the credentials to reach it. All of
    // it is credentials, reads included.
    || /^\/vault(?:\/|$)/.test(adminPath)
    || /^\/wrappers(?:\/|$)/.test(adminPath)
    // The whole /git surface manages an OAuth token and a webhook secret, and
    // its reads (repository list, connection status) exist to drive that. Same
    // treatment as /integrations rather than a read/write split.
    || /^\/git(?:\/|$)/.test(adminPath)
    || /^\/import\/supabase(?:\/|$)/.test(adminPath)
    // Impersonation mints a working session token for another user, which is the
    // same class of thing as rotating their password. Never a content.write.
    || /^\/users(?:$|\/[^/]+\/(?:reset-password|email-verification|revoke-sessions|impersonate|impersonate\/stop|sessions\/[^/]+)$)/.test(adminPath)) {
    return 'secrets.manage';
  }

  const settingsGroup = adminPath.match(/^\/settings\/([^/]+)$/)?.[1];
  if (settingsGroup && settingsGroupHasSecrets(settingsGroup)) return 'secrets.manage';

  // A backup file is a full dump of the database, so even this GET is
  // backup-class (see `/backups` below), not a read.
  if (/^\/backups\/download(?:\/|$)/.test(adminPath)) return 'runtime.manage';

  // Safe methods are read-only only after excluding endpoints that disclose
  // credentials or secret-backed configuration.
  if (SAFE_METHODS.has(method.toUpperCase())) return 'project.read';

  // A Postgres role can carry a login password, so writing one mints a
  // credential. Reading the list does not: it never includes passwords.
  if (/^\/database\/roles(?:\/|$)/.test(adminPath)) return 'secrets.manage';

  if (settingsGroup) return 'settings.write';

  // Minting, importing, rotating or revoking the keys every access token is
  // signed with. Reading the list is fine (it holds public keys only), but a
  // write decides who can forge a session, which is a credential decision.
  if (/^\/auth\/signing-keys(?:\/|$)/.test(adminPath)) return 'secrets.manage';

  if (/^\/settings(?:\/|$)/.test(adminPath)
    || /^\/webhooks(?:\/|$)/.test(adminPath)
    || /^\/realtime\/config(?:\/|$)/.test(adminPath)
    || /^\/backups\/config$/.test(adminPath)
    || /^\/(?:network-restrictions|ssl-enforcement|log-drains)(?:\/|$)/.test(adminPath)
    || /^\/users\/[^/]+\/(?:promote|demote)$/.test(adminPath)) return 'settings.write';

  // Forcing a job to run and rearming its cadence are operational, not content:
  // `POST /jobs/backup/run` fires the same backup `/backups` already rates
  // `runtime.manage`, and rating it lower would be a way around that.
  if (/^\/backups(?:\/|$)/.test(adminPath) || /^\/jobs(?:\/|$)/.test(adminPath)) return 'runtime.manage';
  // `db dump` hands back every row, and `db reset` empties the database: both
  // are backup-class operations, not content edits.
  if (/^\/db\/(?:dump|reset)$/.test(adminPath)) return 'runtime.manage';

  // Realtime Authorization policies are RLS policies like any other.
  if (/^\/(?:tables|schema|rls|sql|edge-functions|cron|queues|performance|migrations|db|storage|users|realtime\/policies|content|content-folders)(?:\/|$)/.test(adminPath)) {
    return 'content.write';
  }

  // Fail closed for future mutation routes: developers never inherit an unknown write.
  return 'settings.write';
}

const requireAdminProxyCapability: RequestHandler = (req, res, next) =>
  requireProjectCapability(adminProxyCapability(req.method, req.originalUrl))(req, res, next);

/**
 * Surfaces an audit entry may name. An allowlist rather than the raw path
 * segment, because the segment is caller-controlled and must never be persisted
 * as-is.
 *
 * It has to cover every MUTATING admin route, or that mutation is recorded as
 * `project.admin.unknown.<method>` and becomes unfindable in the audit log.
 * `api-keys` was missing, so minting and revoking a project's API keys, which
 * `adminProxyCapability` above rates `secrets.manage`, logged as `unknown`.
 * `admin-rbac-contract.unit.test.ts` now joins this against the route manifest.
 */
const AUDITABLE_ADMIN_SURFACES = new Set([
  'api-keys', 'auth', 'backups', 'cron', 'database', 'db', 'edge-functions', 'edge-secrets', 'git', 'import',
  'integrations', 'jobs', 'log-drains', 'migrations', 'network-restrictions', 'performance', 'queues', 'realtime',
  'rls', 'schema', 'settings', 'sql', 'ssl-enforcement', 'storage', 'tables', 'users', 'vault', 'webhooks', 'wrappers',
  'content', 'content-folders',
]);

/** Proxy audit metadata is intentionally coarse: never persist URLs or bodies. */
export function classifyAdminProxyMutation(req: Request): AuditMutation {
  const id = /^[a-z0-9][a-z0-9-]*$/.test(req.params.id ?? '') ? req.params.id : 'unknown';
  const adminPath = req.originalUrl.match(ADMIN_PATH)?.[1] ?? '';
  const firstSegment = adminPath.split('/')[1]?.toLowerCase();
  const surface = firstSegment && AUDITABLE_ADMIN_SURFACES.has(firstSegment) ? firstSegment : 'unknown';
  const capability = adminProxyCapability(req.method, req.originalUrl);

  // Impersonation gets its own action rather than folding into
  // `project.admin.users.post`: "an operator signed in as someone else" is the
  // one entry a reviewer has to be able to find, and start and stop have to be
  // separable to bound the window. `targetUser` is an id, never a credential.
  const impersonation = adminPath.match(/^\/users\/([^/]+)\/impersonate(\/stop)?$/);
  if (impersonation) {
    const targetUser = /^[a-zA-Z0-9_-]{1,128}$/.test(impersonation[1]) ? impersonation[1] : 'unknown';
    return {
      action: `project.admin.users.impersonate.${impersonation[2] ? 'stop' : 'start'}`,
      target: `project:${id}`,
      detail: { capability, targetUser },
    };
  }

  return {
    action: `project.admin.${surface}.${req.method.toLowerCase()}`,
    target: `project:${id}`,
    detail: { capability },
  };
}

export function proxyErrorBody(status: 500 | 502) {
  return {
    success: false,
    message: status === 502 ? 'Project service unavailable' : 'Proxy request failed',
  };
}

// Also on stderr, not just the in-memory ring buffer: the buffer is only
// readable through the console UI, so an operator holding a shell had no way to
// see why a 502 happened, and a 502 often means the UI itself is degraded.
// Neither of these lines carries a token or a request body.
function logProxyFailure(deps: Deps, message: string): void {
  console.error(message);
  deps.logs?.push({ level: 'error', source: 'proxy', message });
}

// The client body stays generic (it is also served to unauthenticated REST/edge
// callers), so the address we gave up on is recorded here. This log line is the
// operator's only way to tell "container is down" from "alias never registered".
function logUnreachable(deps: Deps, projectId: string, target: string): void {
  const message = `[proxy] no reachable upstream for ${projectId}; falling back to ${target}`;
  console.warn(message);
  deps.logs?.push({ level: 'warn', source: 'proxy', message });
}

export function proxyRouter(deps: Deps): Router {
  const r = Router();
  // /rest and /edge need no console session, so anyone can reach them. Per-IP
  // cap on top of the project API's own limits.
  const publicProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.CONSOLE_RATE_LIMIT_PROXY_MAX ?? 600),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({ success: false, message: 'Too many requests, please try again later.' }),
  });
  // REST Data API: no console session required; project API handles its own auth
  r.all('/projects/:id/rest/*', publicProxyLimiter, async (req: Request, res: Response) => {
    const id = req.params.id;
    try {
      const project = await deps.registry.get(id);
      if (!project) return res.status(404).json({ success: false, message: 'unknown project' });
      proxyMetrics.record(id, 'rest');
      // No retry backoff on the unauthenticated routes: waiting out a starting
      // container is an operator concern (the admin route below does it), and
      // here it would just hold an anonymous request open for seconds.
      const { target, ready } = await resolveUpstream(deps.registry, id, deps.probe, PUBLIC_PROBE_DELAYS);
      if (!ready) logUnreachable(deps, id, target);
      const { rewrittenPath } = resolveRestTarget(id, req.originalUrl, target);
      stripSameOriginCorsHeaders(req);
      req.url = rewrittenPath;
      proxy.web(req, res, { target, ignorePath: false }, error => {
        invalidateUpstream(id);
        logProxyFailure(deps, `[proxy] REST upstream failure → ${target}${rewrittenPath}: ${errorMessage(error)}`);
        res.status(502).json(proxyErrorBody(502));
      });
    } catch (error: unknown) {
      logProxyFailure(deps, `[proxy] REST request failure: ${errorMessage(error)}`);
      res.status(500).json(proxyErrorBody(500));
    }
  });

  r.all('/projects/:id/edge/*', publicProxyLimiter, async (req: Request, res: Response) => {
    const id = req.params.id;
    try {
      const project = await deps.registry.get(id);
      if (!project) return res.status(404).json({ success: false, message: 'unknown project' });
      proxyMetrics.record(id, 'edge');
      const { target, ready } = await resolveUpstream(deps.registry, id, deps.probe, PUBLIC_PROBE_DELAYS);
      if (!ready) logUnreachable(deps, id, target);
      const { rewrittenPath } = resolveEdgeTarget(id, req.originalUrl, target);
      delete req.headers.authorization;
      stripSameOriginCorsHeaders(req);
      req.url = rewrittenPath;
      proxy.web(req, res, { target, ignorePath: false }, error => {
        invalidateUpstream(id);
        logProxyFailure(deps, `[proxy] Edge upstream failure → ${target}${rewrittenPath}: ${errorMessage(error)}`);
        res.status(502).json(proxyErrorBody(502));
      });
    } catch (error: unknown) {
      logProxyFailure(deps, `[proxy] Edge request failure: ${errorMessage(error)}`);
      res.status(500).json(proxyErrorBody(500));
    }
  });

  r.all(
    '/projects/:id/admin/*',
    deps.requireSession,
    auditMutations(deps.audit, classifyAdminProxyMutation, deps.logs),
    requireAdminProxyCapability,
    async (req: Request, res: Response) => {
    const id = req.params.id;
    try {
      const project = await deps.registry.get(id);
      if (!project) return res.status(404).json({ success: false, message: 'unknown project' });
      proxyMetrics.record(id, 'admin');
      const headers = { ...(await proxyHeaders(deps.registry, id)), ...operatorHeader(req) };
      // Probing the candidate addresses also smooths over the window where a
      // just-started container is not yet reachable. On repeated failure we still
      // proxy and let the error handler below emit the 502.
      const { target, ready } = await resolveUpstream(deps.registry, id, deps.probe);
      if (!ready) logUnreachable(deps, id, target);
      const { rewrittenPath } = resolveTarget(id, req.originalUrl, target);
      applyAdminProxyHeaders(req, headers);
      req.url = rewrittenPath;
      proxy.web(req, res, { target, headers, ignorePath: false }, error => {
        invalidateUpstream(id);
        const targetUrl = `${target}${rewrittenPath}`;
        logProxyFailure(deps, `[proxy] 502 → ${targetUrl}: ${errorMessage(error)}`);
        res.status(502).json(proxyErrorBody(502));
      });
    } catch (error: unknown) {
      logProxyFailure(deps, `[proxy] Admin request failure: ${errorMessage(error)}`);
      res.status(500).json(proxyErrorBody(500));
    }
    },
  );
  return r;
}
