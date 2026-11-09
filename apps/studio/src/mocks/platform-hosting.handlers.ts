// Mock handlers for branches, custom domains, JWT signing keys, database
// access and log drains. Kept out of handlers.ts so the shared list only gains
// one spread. State is mutable so every write round-trips within a session.
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const ok = (data: unknown) => HttpResponse.json({ data: JSON.parse(JSON.stringify(data)) });
const refuse = (status: number, message: string) => HttpResponse.json({ success: false, message }, { status });
const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();
const SECRET = '__SECRET_SET__';

/** Both forms the studio calls an admin route by (bare, and through the console proxy). */
function admin(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [http[method](`/api/admin${path}`, resolver), http[method](`/api/projects/:pid/admin${path}`, resolver)];
}

// ── Branches ─────────────────────────────────────────────────────────────────

interface MockBranch {
  id: string; name: string; project: string; parent: string; isDefault: boolean; gitBranch: string | null;
  withData: boolean; status: 'creating' | 'seeding' | 'active' | 'failed'; error: string | null; running: boolean;
  domain: string; createdAt: string; mergedAt: string | null; readyAt?: number;
}

const branches: MockBranch[] = [
  {
    id: 'demo-feature-login', name: 'feature-login', project: 'demo-feature-login', parent: 'demo', isDefault: false,
    gitBranch: 'feature/login', withData: false, status: 'active', error: null, running: true,
    domain: 'demo-feature-login.localhost', createdAt: iso(86_400_000), mergedAt: null,
  },
];

/** A created branch walks creating → seeding → active over a few seconds, like the real one. */
function settle(branch: MockBranch): MockBranch {
  if (branch.readyAt && branch.status !== 'active') {
    const left = branch.readyAt - Date.now();
    branch.status = left <= 0 ? 'active' : left < 4000 ? 'seeding' : 'creating';
  }
  return branch;
}

const familyOf = (id: string) => branches.find(b => b.project === id)?.parent ?? id;
const main = (parent: string): MockBranch => ({
  id: parent, name: 'main', project: parent, parent, isDefault: true, gitBranch: null, withData: true,
  status: 'active', error: null, running: true, domain: `${parent}.localhost`, createdAt: iso(86_400_000 * 12), mergedAt: null,
});
const findBranch = (parent: string, ref: string) =>
  branches.find(b => b.parent === parent && (b.project === ref || b.name === ref));

// ── Domains ──────────────────────────────────────────────────────────────────

const domains: Record<string, { customHostname: any; vanitySubdomain: any }> = {};
const domainsOf = (id: string) => (domains[id] ??= { customHostname: null, vanitySubdomain: null });
function domainView(id: string) {
  const state = domainsOf(id);
  const projectDomain = `${id}.localhost`;
  const custom = state.customHostname;
  return {
    projectDomain,
    customHostname: custom && {
      ...custom,
      requiredRecords: [
        { type: 'CNAME', name: custom.hostname, value: projectDomain },
        { type: 'TXT', name: `_motherbase-challenge.${custom.hostname}`, value: custom.verificationToken },
      ],
    },
    vanitySubdomain: state.vanitySubdomain,
    vanitySuffix: 'motherbase.localhost',
  };
}

// ── Signing keys ─────────────────────────────────────────────────────────────

const jwk = (kid: string, alg: string) => ({ kty: alg === 'RS256' ? 'RSA' : 'EC', crv: alg === 'ES256' ? 'P-256' : undefined, x: 'mock', kid, alg, use: 'sig' });
let signingKeys = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', algorithm: 'EdDSA', status: 'previously_used', createdAt: iso(86_400_000 * 90) },
  { id: 'a1b2c3d4-0000-4000-8000-000000000002', algorithm: 'ES256', status: 'in_use', createdAt: iso(86_400_000 * 20) },
];
const signingKeysView = () => ({
  keys: signingKeys.map(k => ({ ...k, publicJwk: jwk(k.id, k.algorithm) })),
  issuer: 'http://demo.localhost',
  jwksPath: '/auth/v1/.well-known/jwks.json',
  legacy: { algorithm: 'HS256', fingerprint: '3f9a0c1d2e4b5a67', usedFor: ['session cookies', 'upload tokens', 'oauth state'] },
});

// ── Database access ──────────────────────────────────────────────────────────

let network = { dbAllowedCidrs: ['0.0.0.0/0'], dbAllowedCidrsV6: ['::/0'], status: 'applied', exposure: 'loopback' };
let ssl = { enforced: false, status: 'applied', sslActive: false, exposure: 'loopback' };

// ── Log drains ───────────────────────────────────────────────────────────────

// Loose on purpose: POSTed drains carry whatever config the form sent.
let drains: Array<Record<string, any>> = [
  {
    id: 'drain-1', name: 'datadog-prod', type: 'datadog', config: { apiKey: SECRET, site: 'datadoghq.eu', service: 'motherbase' },
    enabled: true, deliveredCount: 18_342, failedCount: 0, droppedCount: 0, lastSuccessAt: iso(4_000), lastErrorAt: null,
    lastError: null, pending: 12, retrying: false, createdAt: iso(86_400_000 * 7),
  },
  {
    id: 'drain-2', name: 'archive-webhook', type: 'webhook', config: { url: 'https://logs.example.com/ingest', headers: { Authorization: SECRET } },
    enabled: true, deliveredCount: 912, failedCount: 500, droppedCount: 0, lastSuccessAt: iso(3_600_000), lastErrorAt: iso(20_000),
    lastError: 'HTTP 503', pending: 500, retrying: true, createdAt: iso(86_400_000 * 2),
  },
];

const body = async (request: Request) => (await request.json().catch(() => ({}))) as Record<string, any>;

export const platformHostingHandlers: HttpHandler[] = [
  http.get('/api/platform/projects/:id/branches', ({ params }) => {
    const parent = familyOf(String(params.id));
    return ok([main(parent), ...branches.filter(b => b.parent === parent).map(settle)]);
  }),
  http.post('/api/platform/projects/:id/branches', async ({ params, request }) => {
    const parent = String(params.id);
    const input = await body(request);
    const slug = `${parent}-${String(input.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (slug === `${parent}-`) return refuse(400, 'branch name must contain a letter or digit');
    if (branches.some(b => b.project === slug)) return refuse(409, `a project named ${slug} already exists`);
    const branch: MockBranch = {
      id: slug, name: input.name, project: slug, parent, isDefault: false, gitBranch: input.gitBranch ?? null,
      withData: Boolean(input.withData), status: 'creating', error: null, running: true, domain: `${slug}.localhost`,
      createdAt: iso(), mergedAt: null, readyAt: Date.now() + 8000,
    };
    branches.push(branch);
    return ok(branch);
  }),
  http.get('/api/platform/projects/:id/branches/:branch', ({ params }) => {
    const branch = findBranch(String(params.id), String(params.branch));
    if (!branch) return refuse(404, 'no such branch');
    return ok({ ...settle(branch), migrations: branch.status === 'active' ? { ahead: ['add_login_attempts'], behind: [] } : null });
  }),
  http.delete('/api/platform/projects/:id/branches/:branch', ({ params }) => {
    const branch = findBranch(String(params.id), String(params.branch));
    if (!branch) return refuse(404, 'no such branch');
    branches.splice(branches.indexOf(branch), 1);
    return ok({ id: branch.project, name: branch.name, deleted: true });
  }),
  http.post('/api/platform/projects/:id/branches/:branch/:action', ({ params }) => {
    const branch = findBranch(String(params.id), String(params.branch));
    if (!branch) return refuse(404, 'no such branch');
    switch (params.action) {
      case 'pause': branch.running = false; return ok(branch);
      case 'unpause': branch.running = true; return ok(branch);
      case 'reset': Object.assign(branch, { status: 'creating', readyAt: Date.now() + 8000, mergedAt: null }); return ok(branch);
      case 'merge': branch.mergedAt = iso(); return ok({ ...branch, applied: ['add_login_attempts'] });
      case 'rebase': return ok({ ...branch, applied: [] });
      default: return refuse(404, 'unknown action');
    }
  }),

  http.get('/api/platform/projects/:id/custom-hostname', ({ params }) => ok(domainView(String(params.id)))),
  http.get('/api/platform/projects/:id/vanity-subdomain', ({ params }) => ok(domainView(String(params.id)))),
  http.post('/api/platform/projects/:id/custom-hostname', async ({ params, request }) => {
    const id = String(params.id);
    const { hostname } = await body(request);
    domainsOf(id).customHostname = {
      hostname: String(hostname).toLowerCase(), status: 'pending_verification',
      verificationToken: 'mb-verify-0f3c9a7e21d84b56a1c3e9f7d2b4a6c8', checks: [], createdAt: iso(),
    };
    return ok(domainView(id));
  }),
  http.post('/api/platform/projects/:id/custom-hostname/reverify', ({ params }) => {
    const id = String(params.id);
    const custom = domainsOf(id).customHostname;
    if (!custom) return refuse(404, 'no custom hostname configured');
    // First check finds nothing, the next one passes: enough to see both states.
    const passed = custom.checks.length > 0;
    custom.checks = [
      { record: 'CNAME', name: custom.hostname, expected: `${id}.localhost`, found: passed ? [`${id}.localhost`] : [], ok: passed },
      { record: 'TXT', name: `_motherbase-challenge.${custom.hostname}`, expected: custom.verificationToken, found: passed ? [custom.verificationToken] : [], ok: passed },
    ];
    if (passed && custom.status === 'pending_verification') custom.status = 'verified';
    return ok(domainView(id));
  }),
  http.post('/api/platform/projects/:id/custom-hostname/activate', ({ params }) => {
    const id = String(params.id);
    const custom = domainsOf(id).customHostname;
    if (!custom || custom.status === 'pending_verification') return refuse(409, 'verify the DNS records first (reverify)');
    Object.assign(custom, { status: 'active', activatedAt: iso() });
    return ok(domainView(id));
  }),
  http.delete('/api/platform/projects/:id/custom-hostname', ({ params }) => {
    domainsOf(String(params.id)).customHostname = null;
    return ok(domainView(String(params.id)));
  }),
  http.post('/api/platform/projects/:id/vanity-subdomain/check-availability', async ({ request }) => {
    const { subdomain } = await body(request);
    return ok({ subdomain, hostname: `${subdomain}.motherbase.localhost`, available: subdomain !== 'taken' });
  }),
  http.post('/api/platform/projects/:id/vanity-subdomain', async ({ params, request }) => {
    const { subdomain } = await body(request);
    if (subdomain === 'taken') return refuse(409, 'taken.motherbase.localhost is taken');
    domainsOf(String(params.id)).vanitySubdomain = { subdomain, hostname: `${subdomain}.motherbase.localhost`, activatedAt: iso() };
    return ok(domainView(String(params.id)));
  }),
  http.delete('/api/platform/projects/:id/vanity-subdomain', ({ params }) => {
    domainsOf(String(params.id)).vanitySubdomain = null;
    return ok(domainView(String(params.id)));
  }),

  ...admin('get', '/auth/signing-keys', () => ok(signingKeysView())),
  ...admin('post', '/auth/signing-keys', async ({ request }) => {
    const input = await body(request);
    const key = {
      id: String(input.privateKey?.kid ?? crypto.randomUUID()),
      algorithm: String(input.privateKey?.alg ?? input.algorithm ?? 'ES256'),
      status: 'standby',
      createdAt: iso(),
    };
    signingKeys = [...signingKeys, key];
    return ok({ ...key, publicJwk: jwk(key.id, key.algorithm) });
  }),
  ...admin('post', '/auth/signing-keys/:kid/rotate', ({ params }) => {
    signingKeys = signingKeys.map(k =>
      k.id === params.kid ? { ...k, status: 'in_use' } : k.status === 'in_use' ? { ...k, status: 'previously_used' } : k);
    return ok(signingKeysView());
  }),
  ...admin('post', '/auth/signing-keys/:kid/revoke', ({ params }) => {
    signingKeys = signingKeys.map(k => (k.id === params.kid ? { ...k, status: 'revoked' } : k));
    return ok(signingKeysView());
  }),
  ...admin('delete', '/auth/signing-keys/:kid', ({ params }) => {
    signingKeys = signingKeys.filter(k => k.id !== params.kid);
    return ok(signingKeysView());
  }),

  ...admin('get', '/network-restrictions', () => ok(network)),
  ...admin('put', '/network-restrictions', async ({ request }) => {
    network = { ...network, ...(await body(request)) };
    return ok(network);
  }),
  ...admin('get', '/ssl-enforcement', () => ok(ssl)),
  ...admin('put', '/ssl-enforcement', async ({ request }) => {
    const { enforced } = await body(request);
    ssl = { ...ssl, enforced: Boolean(enforced), sslActive: ssl.sslActive || Boolean(enforced) };
    return ok(ssl);
  }),

  ...admin('get', '/log-drains', () => ok({ drains })),
  ...admin('post', '/log-drains', async ({ request }) => {
    const input = await body(request);
    const drain = {
      id: `drain-${Date.now()}`, name: input.name, type: input.type, config: input.config, enabled: true,
      deliveredCount: 0, failedCount: 0, droppedCount: 0, lastSuccessAt: null, lastErrorAt: null, lastError: null,
      pending: 0, retrying: false, createdAt: iso(),
    };
    drains = [...drains, drain];
    return ok(drain);
  }),
  ...admin('patch', '/log-drains/:drain', async ({ params, request }) => {
    const patch = await body(request);
    drains = drains.map(d => (d.id === params.drain ? { ...d, ...patch } : d));
    return ok(drains.find(d => d.id === params.drain));
  }),
  ...admin('delete', '/log-drains/:drain', ({ params }) => {
    drains = drains.filter(d => d.id !== params.drain);
    return ok({ id: params.drain, deleted: true });
  }),
  ...admin('post', '/log-drains/:drain/test', ({ params }) =>
    ok(params.drain === 'drain-2' ? { ok: false, status: 503, error: 'HTTP 503' } : { ok: true, status: 202 })),
];
