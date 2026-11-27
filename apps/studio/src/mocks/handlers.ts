// MSW request handlers for mock mode. Covers every endpoint the studio calls so
// the UI runs with zero backend. Admin routes are registered under both the bare
// `/api/admin/*` form and the console-proxy `/api/projects/:pid/admin/*` form
// (see ui/src/lib/api.ts request interceptor).
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';
import * as fx from '@/mocks/fixtures';
import { databaseCatalogHandlers } from '@/mocks/database-catalog';
import { platformHostingHandlers } from '@/mocks/platform-hosting.handlers';
import { authHandlers } from '@/mocks/auth.handlers';
import { dbExtHandlers } from '@/mocks/db-ext.handlers';
import { storageHandlers } from '@/mocks/storage-handlers';
import type { DataRow } from '@/shared/types/data';
import type { PlatformRole } from '@/shared/lib/api';
import { admin, asJson, ok, type Method } from '@/mocks/msw';
import { realtimeLogsHandlers } from '@/mocks/realtime-logs.handlers';
import type { UserDetail } from '@/features/auth/types';
const okRaw = (body: unknown) => HttpResponse.json(asJson(body));
const asRecord = (value: unknown): DataRow =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as DataRow : {};

// The named fixtures, then enough generated ones to fill several pages: the
// overview reports 87 users, and a table that fits on one page hides its pager.
const authUsers: UserDetail[] = [
  ...fx.users,
  ...Array.from({ length: 83 }, (_, i) => ({
    ...fx.users[1],
    id: `usr_gen_${i + 1}`,
    email: `member${i + 1}@example.com`,
    username: `member${i + 1}`,
    emailVerified: i % 3 !== 0,
    createdAt: new Date(Date.now() - (i + 12) * 86_400_000).toISOString(),
  })),
].map(user => ({ ...user, role: user.role === 'ADMIN' ? 'ADMIN' : 'USER', sessions: [] }));
const missingUser = () => HttpResponse.json({ message: 'User not found' }, { status: 404 });

// Mutable copy so the Backups config PUT round-trips within a mock session.
let backupsConfig = { ...fx.backupsConfig };
// Same, for the Git repository link.
let gitStatus = { ...fx.gitStatus };
// Mutable copies so console-user + project-limit mutations round-trip in a session.
interface MockPlatformUser {
  id: string;
  email: string;
  role: PlatformRole;
  projects: string[];
  disabled: boolean;
  createdAt: string;
}
const PLATFORM_ROLES: PlatformRole[] = ['owner', 'admin', 'developer', 'read_only', 'member'];
const isPlatformRole = (value: unknown): value is PlatformRole =>
  typeof value === 'string' && PLATFORM_ROLES.includes(value as PlatformRole);
let platformUsers: MockPlatformUser[] = fx.platformUsers.map(u => ({ ...u }));
// Tenant orgs, the layer above projects. Mutable so create/rename/delete
// round-trip within a session, the same way console users do.
let orgs = [
  {
    id: 'org_acme',
    name: 'Acme',
    slug: 'acme',
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    role: 'owner' as const,
    projectCount: fx.projects.length,
  },
];
// The org-wide AI key, mutable for the same reason. `hasKey` stands in for a
// key the real API never returns.
const orgAi = {
  enabled: false,
  provider: 'anthropic',
  model: '',
  baseUrl: '',
  hasKey: false,
  updatedAt: null as string | null,
  projects: fx.projects.map(p => p.name),
  canManage: true,
  providers: fx.aiProviders,
};
const projectLimits: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(fx.projectLimits));
const runtimeOptions: Record<string, Record<string, unknown>> = {};
const projectConfigs: Record<string, Record<string, string>> = Object.fromEntries(
  fx.projects.map(project => [
    project.name,
    {
      domain: project.domain,
      storageDomain: project.storageDomain ?? `${project.name}-storage.localhost`,
      minioConsoleDomain: `${project.name}-minio.localhost`,
      corsOrigins: `http://${project.domain}`,
      apiImage: 'motherbase-api:latest',
      certResolver: 'letsencrypt',
    },
  ])
);

// Evaluate the `filters` query param (same JSON contract as the backend) against
// in-memory fixture rows, so mock mode demonstrates real server-side filtering.
function applyMockFilters(rows: DataRow[], raw: string | null): DataRow[] {
  if (!raw) return rows;
  let filters: Array<{ column: string; op: string; value?: string }>;
  try { filters = JSON.parse(raw); } catch { return rows; }
  return rows.filter(row => filters.every(({ column, op, value }) => {
    const cell = row[column];
    const num = Number(value);
    switch (op) {
      case 'eq': return String(cell) === value;
      case 'neq': return String(cell) !== value;
      case 'gt': return Number(cell) > num;
      case 'gte': return Number(cell) >= num;
      case 'lt': return Number(cell) < num;
      case 'lte': return Number(cell) <= num;
      case 'like': return String(cell).includes(value ?? '');
      case 'ilike': return String(cell).toLowerCase().includes((value ?? '').toLowerCase());
      case 'in': return (value ?? '').split(',').map(s => s.trim()).includes(String(cell));
      case 'is_null': return cell == null;
      case 'not_null': return cell != null;
      default: return true;
    }
  }));
}


/**
 * Fixtures for the project in the URL.
 *
 * Every admin handler used to answer from the same fixture set whatever project
 * was addressed, so two projects were indistinguishable and a cache that leaked
 * between them looked correct.
 */
function tableMetasFor(pid: unknown): unknown[] {
  const override = fx.perProject[String(pid ?? '')];
  if (override) return override.tableMetas;
  return [...fx.tableMetas, fx.reportingTableMeta];
}

function rowsFor(pid: unknown, model: string): DataRow[] {
  const override = fx.perProject[String(pid ?? '')];
  if (override) return override.rowsByTable[model] ?? [];
  if (model === fx.reportingTableMeta.model) return fx.reportingRows;
  return fx.rowsByTable[model] ?? [];
}

function allMockFiles(): DataRow[] {
  return [...Object.values(fx.filesByBucket).flat(), ...fx.overflowFiles];
}

function filesInBucket(slug: string): DataRow[] {
  return slug === 'reports' ? fx.overflowFiles : fx.filesByBucket[slug] ?? [];
}

/** Category rules mirroring the server's `file-query.ts`. */
const MOCK_CATEGORY: Record<string, (mime: string) => boolean> = {
  image: mime => mime.startsWith('image/'),
  video: mime => mime.startsWith('video/'),
  audio: mime => mime.startsWith('audio/'),
  doc: mime => /pdf|word|excel|sheet|presentation|text/.test(mime),
  archive: mime => /zip|tar|gzip|rar|7z/.test(mime),
  other: mime =>
    !/^(image|video|audio)\//.test(mime) && !/pdf|word|excel|sheet|presentation|text|zip|tar|gzip|rar|7z/.test(mime),
};

/** Filter THEN page, in that order, which is the whole point of the fix. */
function pageFiles(rows: DataRow[], url: URL) {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const category = url.searchParams.get('category');
  const visibility = url.searchParams.get('visibility');

  let matched = rows;
  if (q) {
    matched = matched.filter(row =>
      [row.key, row.bucket, row.ownerEmail].some(value => String(value ?? '').toLowerCase().includes(q)),
    );
  }
  if (category && category !== 'all') {
    const test = MOCK_CATEGORY[category];
    if (test) matched = matched.filter(row => test(String(row.mime ?? '')));
  }
  if (visibility && visibility !== 'all') matched = matched.filter(row => row.visibility === visibility);

  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 25));
  const start = (page - 1) * pageSize;

  return {
    rows: matched.slice(start, start + pageSize),
    total: matched.length,
    page,
    pageSize,
    totalSize: matched.reduce((sum, row) => sum + Number(row.size ?? 0), 0),
  };
}

// REST proxy (api.ts also rewrites /rest/v1 → /projects/:pid/rest/v1).
function rest(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [
    http[method](`/api/rest/v1${path}`, resolver),
    http[method](`/api/projects/:pid/rest/v1${path}`, resolver),
  ];
}

export const handlers: HttpHandler[] = [
  // First: MSW takes the first match, and `/api/platform/projects/:id/:action`
  // below would otherwise swallow the branch and domain routes.
  ...platformHostingHandlers,
  // First, so a feature module can answer a path the generic handlers below also match.
  ...realtimeLogsHandlers,
  // ── Auth ────────────────────────────────────────────────────────────────
  http.post('/api/platform/login', () => ok({ token: 'mock-platform-token' })),
  http.post('/api/auth/refresh', () => ok({ accessToken: 'mock-access', refreshToken: 'mock-refresh' })),
  http.get('/api/auth/list-sessions', () =>
    okRaw([
      {
        id: 'session-current',
        token: 'mock-access',
        userId: 'pu_2',
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ipAddress: '127.0.0.1',
        userAgent: 'Motherbase mock browser',
      },
    ])
  ),
  // Better Auth session shape, read by the 2FA panel and the session guards.
  http.get('/api/auth/get-session', () =>
    okRaw({
      session: {
        id: 'session-current',
        userId: 'pu_2',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      user: { id: 'pu_2', email: 'admin@example.com', name: 'Mock admin', twoFactorEnabled: false },
    })
  ),
  http.post('/api/auth/revoke-session', () => okRaw({ status: true })),
  http.post('/api/auth/revoke-other-sessions', () => okRaw({ status: true })),

  // ── Platform (console / multi-project) ──────────────────────────────────
  http.get('/api/platform/projects', () => ok(fx.projects)),
  http.get('/api/platform/orgs', () => ok(orgs)),
  http.post('/api/platform/orgs', async ({ request }) => {
    const body = asRecord(await request.json());
    const name = String(body.name ?? 'New org');
    const org = {
      id: `org_${Date.now()}`,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      createdAt: new Date().toISOString(),
      role: 'owner' as const,
      projectCount: 0,
    };
    orgs = [...orgs, org];
    return ok(org);
  }),
  http.patch('/api/platform/orgs/:id', async ({ params, request }) => {
    const body = asRecord(await request.json());
    orgs = orgs.map(org => (org.id === params.id ? { ...org, name: String(body.name ?? org.name) } : org));
    return ok(orgs.find(org => org.id === params.id) ?? null);
  }),
  http.delete('/api/platform/orgs/:id', ({ params }) => {
    orgs = orgs.filter(org => org.id !== params.id);
    return ok({ ok: true });
  }),
  http.get('/api/platform/orgs/:id/members', () =>
    ok(platformUsers.map(u => ({ userId: u.id, role: u.role === 'owner' ? 'owner' : 'member', createdAt: u.createdAt, email: u.email })))
  ),
  http.post('/api/platform/orgs/:id/members', () => ok({ ok: true })),
  // The org-wide AI key. The key itself is never returned, only whether one is
  // stored, which is what the real route does.
  http.get('/api/platform/orgs/:id/ai', () => ok(orgAi)),
  http.put('/api/platform/orgs/:id/ai', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    Object.assign(orgAi, {
      enabled: Boolean(body.enabled),
      provider: String(body.provider ?? 'anthropic'),
      model: String(body.model ?? ''),
      baseUrl: String(body.baseUrl ?? ''),
      hasKey: orgAi.hasKey || Boolean(body.apiKey),
      updatedAt: new Date().toISOString(),
    });
    return ok({ ...orgAi, failed: [] });
  }),
  http.delete('/api/platform/orgs/:id/ai', () => {
    Object.assign(orgAi, { enabled: false, model: '', baseUrl: '', hasKey: false, updatedAt: null });
    return ok({ ...orgAi, failed: [] });
  }),
  http.delete('/api/platform/orgs/:id/members/:userId', () => ok({ ok: true })),
  http.get('/api/platform/me', () =>
    ok({
      id: 'pu_2',
      email: 'admin@example.com',
      role: 'admin',
      projects: [],
      capabilities: [
        'project.read',
        'project.create',
        'content.write',
        'settings.write',
        'runtime.manage',
        'secrets.manage',
        'project.delete',
        'audit.read',
      ],
    })
  ),
  http.get('/api/platform/info', () => ok(fx.platformInfo)),
  http.get('/api/platform/version', () => ok({ current: '1.0.0', latest: '1.1.0', updateAvailable: true, configured: true, checkedAt: new Date().toISOString(), channel: 'https://registry.example/tags' })),
  http.get('/api/platform/update/plan', () =>
    ok({
      current: '1.0.0', latest: '1.1.0', updateAvailable: true, configured: true,
      services: [
        { name: 'console', from: '1.0.0', to: '1.1.0' },
        { name: 'orchestrator', from: '1.0.0', to: '1.1.0' },
      ],
      commands: [
        'docker compose -f deploy/console/docker-compose.yml pull console orchestrator',
        'docker compose -f deploy/console/docker-compose.yml up -d console orchestrator',
        'docker compose -f deploy/console/docker-compose.yml run --rm console npx prisma migrate deploy',
      ],
      notes: ['Run these on the host where the console stack lives.'],
    }),
  ),
  http.get('/api/platform/dns', () => ok(fx.dns)),
  // Shape matches the console router: { logs: [...] }, not a bare array.
  http.get('/api/platform/logs', () => ok({ logs: fx.makeLogs(60) })),
  http.get('/api/platform/audit', () =>
    ok({
      events: [
        {
          id: 'audit-3',
          at: new Date().toISOString(),
          actorId: 'pu_2',
          actorEmail: 'admin@example.com',
          actorRole: 'admin',
          ip: '192.0.2.10',
          action: 'project.runtime.restart',
          target: 'project:demo',
          success: true,
          detail: { statusCode: 200 },
        },
        {
          id: 'audit-2',
          at: new Date(Date.now() - 180_000).toISOString(),
          actorId: 'pu_1',
          actorEmail: 'owner@example.com',
          actorRole: 'owner',
          ip: '2001:db8::10',
          action: 'user.sessions.revoke',
          target: 'user:pu_3',
          success: true,
          detail: { statusCode: 200 },
        },
      ],
    })
  ),
  http.get('/api/platform/metrics', () => ok(fx.platformMetrics)),
  http.get('/api/platform/disk', () => ok(fx.platformDisk)),
  http.get('/api/platform/settings', () => ok({ DOMAIN_SUFFIX: 'localhost', MODE: 'dev' })),
  http.put('/api/platform/settings', () => ok({ DOMAIN_SUFFIX: 'localhost', MODE: 'dev' })),
  http.get('/api/platform/project-defaults', () =>
    ok({
      defaults: {},
      groups: [
        {
          key: 'auth.signup',
          label: 'Auth · Sign-up & passwords',
          description: 'Registration and password policy applied to new projects.',
          fields: [
            { key: 'allowNewUsers', label: 'Allow new sign-ups', type: 'bool', default: true },
            { key: 'requireEmailVerification', label: 'Require email verification', type: 'bool', default: false },
            { key: 'minPasswordLength', label: 'Minimum password length', type: 'number', default: 8 },
          ],
        },
      ],
    })),
  http.put('/api/platform/project-defaults', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { defaults?: unknown };
    return ok({ defaults: body?.defaults ?? {} });
  }),
  http.post('/api/platform/account/password', () => ok({ ok: true })),

  // ── Console users / RBAC ────────────────────────────────────────────────
  http.get('/api/platform/users', () => ok(platformUsers)),
  http.post('/api/platform/users', async ({ request }) => {
    const body = asRecord(await request.json().catch(() => ({})));
    const user: MockPlatformUser = {
      id: `pu_${Date.now()}`,
      email: typeof body.email === 'string' ? body.email : 'new@example.com',
      role: isPlatformRole(body.role) && body.role !== 'member' ? body.role : 'developer',
      projects: Array.isArray(body.projects) ? body.projects.filter((value): value is string => typeof value === 'string') : [],
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    platformUsers = [...platformUsers, user];
    return ok(user);
  }),
  http.patch('/api/platform/users/:id', async ({ params, request }) => {
    const patch = asRecord(await request.json().catch(() => ({})));
    platformUsers = platformUsers.map(user => {
      if (user.id !== params.id) return user;
      return {
        ...user,
        ...(isPlatformRole(patch.role) ? { role: patch.role } : {}),
        ...(Array.isArray(patch.projects) ? { projects: patch.projects.filter((value): value is string => typeof value === 'string') } : {}),
        ...(typeof patch.disabled === 'boolean' ? { disabled: patch.disabled } : {}),
      };
    });
    const updated = platformUsers.find(u => u.id === params.id);
    return ok(updated);
  }),
  http.delete('/api/platform/users/:id/sessions', () => ok({ revoked: true })),
  http.delete('/api/platform/users/:id', ({ params }) => {
    platformUsers = platformUsers.filter(u => u.id !== params.id);
    return ok({ ok: true });
  }),

  // ── Per-project runtime switches ────────────────────────────────────────
  http.get('/api/platform/projects/:id/runtime-options', ({ params }) =>
    ok(runtimeOptions[String(params.id)] ?? { edgeRuntime: true, autoPauseMinutes: 0 })),
  http.patch('/api/platform/projects/:id/runtime-options', async ({ params, request }) => {
    const id = String(params.id);
    const patch = asRecord(await request.json().catch(() => ({})));
    runtimeOptions[id] = { ...(runtimeOptions[id] ?? { edgeRuntime: true, autoPauseMinutes: 0 }), ...patch };
    return ok(runtimeOptions[id]);
  }),

  // ── Per-project resource limits ─────────────────────────────────────────
  http.get('/api/platform/projects/:id/limits', ({ params }) =>
    ok(projectLimits[String(params.id)] ?? { apiCpus: 0.5, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256, edgeCpus: 0.5, edgeMemMb: 768, diskGb: 10 })),
  http.patch('/api/platform/projects/:id/limits', async ({ params, request }) => {
    const patch = asRecord(await request.json().catch(() => ({})));
    const id = String(params.id);
    const numericPatch: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'number') numericPatch[key] = value;
    }
    projectLimits[id] = { ...(projectLimits[id] ?? {}), ...numericPatch };
    return ok(projectLimits[id]);
  }),

  http.get('/api/platform/projects/:id/config', ({ params }) => ok(projectConfigs[String(params.id)])),
  http.patch('/api/platform/projects/:id/config', async ({ params, request }) => {
    const patch = asRecord(await request.json().catch(() => ({})));
    const id = String(params.id);
    const stringPatch: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string') stringPatch[key] = value;
    }
    projectConfigs[id] = { ...(projectConfigs[id] ?? {}), ...stringPatch };
    return ok(projectConfigs[id]);
  }),

  // What the shell gate and the health dots poll (useProjectReadiness).
  http.get('/api/platform/projects/:id/ready', () => ok({ ready: true, status: 'running' })),
  http.post('/api/platform/projects', () => ok(fx.projects[0])),
  http.post('/api/platform/projects/:id/:action', () => ok({ ok: true })),
  http.get('/api/platform/projects/:id/dns', () => ok(fx.dns)),
  http.get('/api/platform/projects/:id/shell', () => ok({ command: 'docker exec -it demo_api sh' })),
  http.get('/api/platform/projects/:id/logs', () => ok(fx.makeLogs(40))),
  http.delete('/api/platform/projects/:id', () => ok({ ok: true })),

  // ── Session / connect ───────────────────────────────────────────────────
  ...admin('get', '/session', () => ok(fx.session)),
  ...admin('get', '/connect-info', () => ok(fx.connectInfo)),

  // ── Supabase import ─────────────────────────────────────────────────────
  // One endpoint, two modes: api.ts sends `preview: true` for the dry-run and
  // `confirm: 'IMPORT'` for the real thing (see importSupabasePreview /
  // importSupabase). Shapes mirror SupabaseImportPreview / SupabaseImportSummary.
  ...admin('post', '/import/supabase', async ({ request }) => {
    const body = asRecord(await request.json().catch(() => ({})));
    if (body.preview) {
      return ok({
        tables: [
          { name: 'profiles', rows: 128 },
          { name: 'posts', rows: 542 },
          { name: 'comments', rows: 1904 },
        ],
        policies: 6,
        authUsers: 87,
        buckets: [
          { name: 'avatars', objects: 87, bytes: 12_400_000 },
          { name: 'post-media', objects: 341, bytes: 890_000_000 },
        ],
        edgeFunctions: ['stripe-webhook', 'send-welcome-email'],
        secrets: 3,
        notes: body.serviceRoleKey
          ? []
          : ['No service_role key given: the buckets will be created but their objects will not be copied.'],
      });
    }
    const include = asRecord(body.include);
    const withKey = Boolean(body.serviceRoleKey);
    const withToken = Boolean(body.managementToken);
    return ok({
      status: withToken ? 'partial' : 'success',
      schema: { applied: include.schema !== false },
      data: { applied: include.data !== false, includedInDump: include.data !== false },
      auth: { imported: 85, skipped: 2, errors: [] },
      storage:
        include.storage === false
          ? { buckets: 0, objects: 0, skipped: 0, errors: [] }
          : { buckets: 2, objects: withKey ? 428 : 0, skipped: withKey ? 0 : 428, errors: [] },
      edgeFunctions:
        include.edgeFunctions === false || !withToken
          ? { imported: 0, enabled: 0, needsPorting: 0, errors: [], disabled: [] }
          : {
              imported: 3,
              enabled: 2,
              needsPorting: 1,
              errors: ['send-sms: a function with that name or route already exists'],
              disabled: ['send-sms'],
            },
      secrets:
        include.secrets === false || !withToken
          ? { imported: 0, skipped: 0, errors: [], undisclosed: [] }
          : {
              imported: 0,
              skipped: 7,
              errors: [],
              undisclosed: ['STRIPE_SECRET_KEY', 'MTARGET_PASSWORD', 'SAMIRPAY_API_KEY'],
            },
      verification: {
        valid: true,
        checked: { tables: 3, rows: include.data !== false, constraints: 4, policies: 6 },
        errors: [],
      },
      notes: withToken
        ? [
            'Supabase never discloses secret values: its API returns a hash of each one, so 3 secret(s) were NOT imported and must be set here by hand before the functions that read them are enabled.',
            'Imported DISABLED because they failed the deploy check: send-sms (Module not found "https://deno.land/x/twilio/mod.ts").',
          ]
        : ['No Supabase personal access token given: edge functions and project secrets were skipped.'],
    });
  }),

  // ── Overview / logs / stats ─────────────────────────────────────────────
  ...admin('get', '/stats', () => ok(fx.stats)),
  ...admin('get', '/metrics/timeseries', () => {
    const now = Date.now();
    const samples = Array.from({ length: 60 }, (_, i) => {
      const t = now - (59 - i) * 10_000;
      return {
        at: new Date(t).toISOString(),
        rps: Math.round((2 + Math.sin(i / 6) + Math.random()) * 100) / 100,
        p95: Math.round(40 + Math.cos(i / 5) * 15 + Math.random() * 10),
        errorRate: Math.max(0, Math.round((0.02 + Math.sin(i / 9) * 0.02) * 1000) / 1000),
        memMb: Math.round((180 + i * 0.4 + Math.random() * 6) * 10) / 10,
        reqs: Math.round(120 + Math.sin(i / 6) * 40),
      };
    });
    return ok({ samples });
  }),
  ...admin('get', '/logs', ({ request }) => {
    const since = Number(new URL(request.url).searchParams.get('since') ?? 0);
    const logs = fx.makeLogs(400).filter(entry => Date.parse(entry.at) >= since);
    return ok({
      logs: logs.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
      persisted: true,
      retentionDays: 7,
      oldestAvailable: logs[0]?.at ?? null,
    });
  }),

  // ── Tables (Prisma-model view) ──────────────────────────────────────────
  ...admin('get', '/tables', ({ params }) => ok({ tables: tableMetasFor(params.pid) })),
  ...admin('get', '/tables/:model/rows', ({ params, request }) => {
    const model = String(params.model);
    const url = new URL(request.url);
    let all = rowsFor(params.pid, model);

    // Mirror the backend's server-side filtering so the demo behaves like prod.
    all = applyMockFilters(all, url.searchParams.get('filters'));

    const sort = url.searchParams.get('sort');
    if (sort) {
      const dir = url.searchParams.get('order') === 'desc' ? -1 : 1;
      all = [...all].sort((a, b) => String(a[sort] ?? '').localeCompare(String(b[sort] ?? '')) * dir);
    }

    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 50);
    const start = (page - 1) * pageSize;
    return ok({ rows: all.slice(start, start + pageSize), total: all.length, page, pageSize });
  }),
  ...admin('post', '/tables/:model/rows', () => ok({ ok: true })),
  ...admin('patch', '/tables/:model/rows/:id', () => ok({ ok: true })),
  ...admin('delete', '/tables/:model/rows/:id', () => ok({ ok: true })),

  // ── Schema (raw Postgres) ───────────────────────────────────────────────
  // More than one schema, and a different table list per schema: with a single
  // `public` the console's schema picker could not be exercised at all.
  ...admin('get', '/schema/schemas', () => ok({ schemas: fx.schemas })),
  ...admin('get', '/schema/tables', ({ request }) => {
    const schema = new URL(request.url).searchParams.get('schema') ?? 'public';
    return ok({ tables: fx.schemaTablesBySchema[schema] ?? [] });
  }),
  ...admin('get', '/schema/tables/:t/indexes', () => ok({ indexes: fx.indexes })),
  ...admin('get', '/schema/graph', () => ok(fx.schemaGraph)),
  ...admin('post', '/schema/tables', () => ok({ ok: true })),
  ...admin('delete', '/schema/tables/:t', () => ok({ ok: true })),
  ...admin('post', '/schema/tables/:t/columns', () => ok({ ok: true })),
  ...admin('delete', '/schema/tables/:t/columns/:c', () => ok({ ok: true })),
  ...admin('patch', '/schema/tables/:t/columns/:c/rename', () => ok({ ok: true })),
  ...admin('patch', '/schema/tables/:t/columns/:c/nullable', () => ok({ ok: true })),
  ...admin('patch', '/schema/tables/:t/columns/:c/default', () => ok({ ok: true })),
  ...admin('post', '/schema/tables/:t/indexes', () => ok({ ok: true })),
  ...admin('delete', '/schema/indexes/:name', () => ok({ ok: true })),
  ...admin('get', '/integrations', () => ok({ integrations: fx.integrations })),
  ...admin('post', '/integrations/:key/connect', () => ok({ installed: [], skipped: [] })),
  ...admin('delete', '/integrations/:key', () => ok({ ok: true })),
  ...admin('get', '/schema/extensions', () => ok({ extensions: fx.extensions })),
  ...admin('post', '/schema/extensions/:name', () => ok({ ok: true })),
  ...admin('delete', '/schema/extensions/:name', () => ok({ ok: true })),
  ...admin('get', '/schema/functions', () => ok({ functions: fx.dbFunctions })),
  ...admin('post', '/schema/functions', () => ok({ ok: true })),
  ...admin('delete', '/schema/functions/:name', () => ok({ ok: true })),
  ...admin('get', '/schema/triggers', () => ok({ triggers: fx.triggers })),
  ...admin('post', '/schema/triggers', () => ok({ ok: true })),
  ...admin('post', '/schema/triggers/:name/enabled', () => ok({ ok: true })),
  ...admin('delete', '/schema/triggers/:name', () => ok({ ok: true })),
  ...admin('get', '/schema/trigger-functions', () => ok({ functions: fx.triggerFunctions })),
  ...databaseCatalogHandlers(admin),

  // ── SQL editor ──────────────────────────────────────────────────────────
  ...admin('post', '/sql', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { sql?: string };
    const sql = (body.sql ?? '').trim().toLowerCase();
    if (sql.startsWith('select')) {
      return ok({ kind: 'read', columns: ['id', 'email', 'role'], rows: fx.rowsByTable.User.slice(0, 5).map(r => ({ id: r.id, email: r.email, role: r.role })) });
    }
    if (!sql) return ok({ kind: 'empty' });
    return ok({ kind: 'write', rowsAffected: 1, newRoutes: [], wrote: true });
  }),

  // ── RLS / policies ──────────────────────────────────────────────────────
  ...admin('get', '/rls/tables', () => ok(fx.rlsTables)),
  ...admin('get', '/rls/access', () => ok(fx.rlsAccess)),
  ...admin('post', '/rls/policies', () => ok({ ok: true })),
  ...admin('put', '/rls/policies', () => ok({ ok: true })),
  ...admin('delete', '/rls/policies', () => ok({ ok: true })),
  ...admin('post', '/rls/tables/:t/rls', () => ok({ ok: true })),

  // ── Auth users ──────────────────────────────────────────────────────────
  // Pages and filters like the server when `page` is sent, the whole list otherwise.
  ...admin('get', '/users', ({ request }) => {
    const params = new URL(request.url).searchParams;
    if (!params.has('page')) return ok({ users: authUsers });
    const page = Number(params.get('page')) || 1;
    const perPage = Number(params.get('per_page')) || 50;
    const q = params.get('q')?.toLowerCase();
    const flag = (name: string) => (params.has(name) ? params.get(name) === 'true' : undefined);
    const [role, verified, anonymous] = [params.get('role'), flag('verified'), flag('anonymous')];
    const matched = authUsers.filter(user =>
      (!q || user.email.toLowerCase().includes(q) || Boolean(user.username?.toLowerCase().includes(q)))
      && (!role || user.role === role)
      && (verified === undefined || user.emailVerified === verified)
      && (anonymous === undefined || Boolean(user.isAnonymous) === anonymous)
    );
    return ok({ users: matched.slice((page - 1) * perPage, page * perPage), page, perPage, total: matched.length });
  }),
  ...admin('get', '/users/sessions', () => ok({ sessions: [] })),
  ...admin('get', '/users/:id', ({ params }) => {
    const user = authUsers.find(user => user.id === params.id);
    return user ? ok(user) : missingUser();
  }),
  ...admin('patch', '/users/:id', async ({ params, request }) => {
    const user = authUsers.find(user => user.id === params.id);
    if (!user) return missingUser();
    const body = asRecord(await request.json());
    for (const field of ['firstName', 'lastName', 'username', 'status'] as const) {
      if (typeof body[field] === 'string') user[field] = body[field].trim();
    }
    if (user.status !== 'active') user.sessions = [];
    return ok(user);
  }),
  ...admin('post', '/users/:id/email-verification', async ({ params, request }) => {
    const user = authUsers.find(user => user.id === params.id);
    if (!user) return missingUser();
    const body = asRecord(await request.json());
    if (typeof body.emailVerified !== 'boolean') return HttpResponse.json({ message: 'emailVerified must be a boolean' }, { status: 400 });
    user.emailVerified = body.emailVerified;
    return ok(user);
  }),
  ...admin('post', '/users', () => ok({ user: fx.users[0], tempPassword: 'Temp-1234' })),
  ...admin('post', '/users/:id/reset-password', () => ok({ ok: true })),
  ...admin('post', '/users/:id/:action', ({ params }) => {
    const user = authUsers.find(user => user.id === params.id);
    if (!user) return missingUser();
    if (params.action === 'promote') user.role = 'ADMIN';
    if (params.action === 'demote') user.role = 'USER';
    if (params.action === 'revoke-sessions') user.sessions = [];
    return ok(user);
  }),
  ...admin('delete', '/users/:id', () => ok({ ok: true })),

  // ── Storage ─────────────────────────────────────────────────────────────
  ...storageHandlers,
  ...admin('get', '/storage/buckets', () => ok(fx.buckets)),
  // Both listings page and filter exactly like the server. Returning everything
  // in one response is the shape in which a missing pager and browser-side
  // filtering look correct.
  ...admin('get', '/storage/files', ({ request }) =>
    ok(pageFiles(allMockFiles(), new URL(request.url)))),
  ...admin('get', '/storage/buckets/:slug/files', ({ params, request }) =>
    ok(pageFiles(filesInBucket(String(params.slug)), new URL(request.url)))),
  ...admin('get', '/storage/bucket-deletions', () => ok({ jobs: [] })),
  ...admin('get', '/storage/buckets/:slug/cors', () => ok({ allowedOrigins: ['*'], allowedMethods: ['GET', 'PUT'], maxAgeSeconds: 3600 })),
  ...admin('get', '/storage/buckets/:slug/tokens', () => ok({ tokens: [{ id: 'tok_1', name: 'upload', scope: 'write', createdAt: new Date().toISOString() }] })),
  ...admin('get', '/storage/buckets/:slug/webhooks', () => ok({ webhooks: [] })),
  ...admin('post', '/storage/buckets', () => ok({ ok: true })),
  ...admin('delete', '/storage/buckets/:slug', () => ok({ ok: true })),
  ...admin('put', '/storage/buckets/:slug/cors', () => ok({ ok: true })),
  ...admin('delete', '/storage/buckets/:slug/cors', () => ok({ ok: true })),
  ...admin('post', '/storage/buckets/:slug/tokens', () => ok({ token: 'mb_tok_demo', id: 'tok_2' })),
  ...admin('delete', '/storage/buckets/:slug/tokens/:id', () => ok({ ok: true })),
  ...admin('post', '/storage/buckets/:slug/webhooks', () => ok({ ok: true })),
  ...admin('delete', '/storage/buckets/:slug/webhooks/:id', () => ok({ ok: true })),
  ...admin('post', '/storage/files', () => ok({ ok: true })),
  ...admin('delete', '/storage/files/:id', () => ok({ ok: true })),
  ...admin('get', '/storage/files/:id/url', () => ok({ url: 'https://picsum.photos/seed/mb/400/300' })),

  // ── Jobs, cron and the catalogues the console reads ─────────────────────
  //
  // None of these had a handler, so mock mode answered them with an unhandled
  // request: the pages rendered their empty state and the screens they are
  // meant to exercise could not be looked at at all.
  ...admin('get', '/cron/pg/jobs', () => ok(fx.pgCronJobs)),
  ...admin('patch', '/cron/pg/jobs/:id', () => ok({ ok: true })),
  ...admin('delete', '/cron/pg/jobs/:id', () => ok({ ok: true })),
  ...admin('post', '/cron/pg/jobs', () => ok({ ok: true })),
  ...admin('get', '/cron/pg/jobs/:id/runs', () => ok({ runs: [] })),
  ...admin('get', '/cron/app/jobs', () => ok({ jobs: fx.appJobs, partial: false })),
  ...admin('get', '/jobs/runs', ({ request }) => {
    const job = new URL(request.url).searchParams.get('job');
    return ok({ runs: fx.appJobRuns.filter(run => !job || run.job === job) });
  }),
  ...admin('post', '/jobs/:id/run', () => ok({ output: { ran: true, claimed: 0 } })),
  ...admin('patch', '/jobs/:id', () => ok({})),
  ...admin('get', '/jobs/alerts', () => ok({ alerts: [] })),
  ...admin('get', '/rest/resources', () => ok({ resources: fx.restResources })),
  ...admin('get', '/webhooks/events', () => ok({ events: fx.systemEvents })),
  ...admin('get', '/realtime/queue', () => ok(fx.realtimeQueue)),
  ...admin('post', '/backups/extract', () => ok({ database: { name: 'motherbase-full-2026-07-04-0100-database.sql' }, files: ['storage/avatars/ada.png'] })),

  // ── Edge functions ──────────────────────────────────────────────────────
  ...admin('get', '/edge-functions', () => ok({ functions: fx.edgeFunctions })),
  ...admin('get', '/edge-functions/:id/logs', () => ok({ logs: fx.edgeLogs })),
  ...admin('post', '/edge-functions', () => ok({ function: fx.edgeFunctions[0] })),
  ...admin('patch', '/edge-functions/:id', () => ok({ function: fx.edgeFunctions[0] })),
  ...admin('delete', '/edge-functions/:id', () => ok({ ok: true })),
  ...admin('post', '/edge-functions/:id/invoke', () => ok({ value: { message: 'Hello from world' }, stdout: 'invoked with {"name":"world"}', error: null, durationMs: 12 })),
  ...admin('get', '/edge-secrets', () => ok({ secrets: fx.edgeSecrets })),
  ...admin('put', '/edge-secrets', () => ok({ ok: true })),
  ...admin('delete', '/edge-secrets/:name', () => ok({ ok: true })),

  // ── Realtime ────────────────────────────────────────────────────────────
  ...admin('get', '/realtime/channels', () => ok({ channels: fx.realtimeChannels })),
  ...admin('get', '/realtime/events', () => ok({ events: fx.realtimeEvents })),
  ...admin('get', '/realtime/channels/:name/presence', () => ok({ users: ['usr_1', 'usr_2'] })),
  ...admin('get', '/realtime/config', () => ok(fx.realtimeConfig)),
  ...admin('patch', '/realtime/config', () => ok({ ok: true })),
  ...admin('patch', '/realtime/config/respect-rls', () => ok({ ok: true })),

  // ── Webhooks ────────────────────────────────────────────────────────────
  ...admin('get', '/webhooks', () => ok({ webhooks: fx.webhooks })),
  ...admin('post', '/webhooks', () => ok({ ok: true })),
  ...admin('patch', '/webhooks/:id', () => ok({ ok: true })),
  ...admin('delete', '/webhooks/:id', () => ok({ ok: true })),
  ...admin('post', '/webhooks/:id/test', () => ok({ ok: true, status: 200, ms: 142 })),
  ...admin('post', '/webhooks/:id/rotate-secret', () =>
    ok({ ...fx.webhooks[0], secret: 'whsec_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) })),

  // ── Backups (Settings) ──────────────────────────────────────────────────
  ...admin('get', '/backups', () => ok({ backups: fx.backups })),
  ...admin('post', '/backups', () => ok({ ok: true })),
  ...admin('post', '/backups/export', () => ok({ ok: true })),
  ...admin('post', '/backups/restore', () => ok({ ok: true })),
  ...admin('post', '/backups/clone-staging', () => ok({ ok: true })),

  // ── Backups (Studio page) ───────────────────────────────────────────────
  ...admin('get', '/backups/list', () => ok(fx.backupsList)),
  ...admin('get', '/backups/config', () => ok(backupsConfig)),
  ...admin('put', '/backups/config', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<typeof backupsConfig>;
    backupsConfig = { ...backupsConfig, ...body };
    return ok(backupsConfig);
  }),
  ...admin('post', '/backups/run', () => ok({ ok: true })),
  ...admin('post', '/backups/upload', () => ok({ file: { name: 'motherbase-uploaded-2026-07-04-0100.sql', kind: 'database', restorable: true } })),

  // ── Migrations (Studio page) ────────────────────────────────────────────
  // Shapes mirror the controller's wrappers; a bare array here is what let the
  // real page ship broken while mock mode looked fine.
  ...admin('get', '/migrations', () => ok({ migrations: fx.migrations })),
  ...admin('get', '/migrations/diff', () => ok(fx.migrationDiff)),
  ...admin('post', '/migrations', () => ok({ ok: true })),
  ...admin('get', '/migrations/:id', ({ params }) => ok({ migration: fx.migrationDetails[String(params.id)] ?? fx.migrationDetails.mig_001 })),
  ...admin('post', '/migrations/:id/apply', () => ok({ ok: true })),
  ...admin('post', '/migrations/:id/rollback', () => ok({ ok: true })),
  ...admin('post', '/db/migrations/:version/repair', () => ok({ migration: {} })),

  // Git integration. Mutable so the whole flow (configure, connect, pick a
  // repo, deploy, disconnect) round-trips in a mock session and can actually be
  // looked at without a GitHub.
  ...admin('get', '/git/status', () => ok(gitStatus)),
  ...admin('get', '/git/authorize', () => ok({ url: `${location.origin}/studio/git/callback?code=mock&state=mock` })),
  ...admin('post', '/git/callback', () => {
    gitStatus = { ...gitStatus, accountLogin: 'octocat' };
    return ok(gitStatus);
  }),
  ...admin('get', '/git/repos', () => ok({ repos: fx.gitRepos })),
  ...admin('post', '/git/link', async ({ request }) => {
    const body = asRecord(await request.json()) as unknown as {
      owner: string; repo: string; branch: string; migrationsPath: string;
    };
    gitStatus = { ...gitStatus, ...body, connected: true, webhookInstalled: true };
    return ok(gitStatus);
  }),
  ...admin('delete', '/git/link', () => {
    gitStatus = { ...fx.gitStatus };
    return ok(gitStatus);
  }),
  ...admin('post', '/git/sync', () => {
    gitStatus = {
      ...gitStatus,
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'ok',
      lastSyncMessage: 'Applied 1 migration(s): 20260816120000_add_orders',
      lastSyncSha: 'c0ffee1234567890',
    };
    return ok({ applied: ['20260816120000_add_orders'], skipped: [], failed: null, sha: gitStatus.lastSyncSha });
  }),

  // ── Settings groups ─────────────────────────────────────────────────────
  ...admin('get', '/settings', () => ok({ groups: fx.settingsGroups })),
  ...admin('get', '/settings/:group', ({ params }) => ok(fx.settingsByGroup[String(params.group)] ?? fx.settingsByGroup.auth)),
  ...admin('put', '/settings/:group', ({ params }) => ok(fx.settingsByGroup[String(params.group)] ?? fx.settingsByGroup.auth)),
  ...admin('delete', '/settings/:group', ({ params }) => {
    const current = fx.settingsByGroup[String(params.group)] ?? fx.settingsByGroup.auth;
    return ok({ ...current, source: 'env' });
  }),
  ...admin('post', '/settings/email/test', () => ok({ ok: true, ms: 320 })),
  ...admin('post', '/settings/sms/test', () => ok({ ok: true, ms: 410 })),

  // ── AI assistant ────────────────────────────────────────────────────────
  ...admin('get', '/ai/threads', () => ok(fx.aiThreads)),
  ...admin('get', '/ai/threads/:id', ({ params }) => {
    const thread = fx.aiThreads.find(item => item.id === String(params.id));
    return thread
      ? ok({ ...thread, messages: fx.aiThreadMessages })
      : HttpResponse.json({ message: 'Thread not found' }, { status: 404 });
  }),
  ...admin('patch', '/ai/threads/:id', () => ok({ ok: true })),
  ...admin('delete', '/ai/threads/:id', () => ok({ ok: true })),
  ...admin('get', '/ai/providers', () => ok(fx.aiProviders)),
  ...admin('post', '/ai/models', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { provider?: string };
    const provider = body?.provider || 'anthropic';
    const models = fx.aiModels[provider] ?? [];
    return ok({
      configured: true,
      provider,
      model: models[0]?.id ?? '',
      source: 'project',
      models,
      catalogue: models.length ? 'provider' : 'fallback',
    });
  }),
  ...admin('post', '/ai/test', () =>
    ok({ ok: true, model: 'claude-opus-5', latencyMs: 210 })),
  ...admin('post', '/ai/chat', () => {
    const frames = [
      { type: 'thread', threadId: 't-mock' },
      { type: 'tool_call', call: { id: 'c1', name: 'list_tables', input: { schema: 'public' } } },
      { type: 'tool_result', callId: 'c1', name: 'list_tables', result: [{ name: 'users' }] },
      // Markdown, because that is what the real models answer with: mock mode
      // has to exercise the renderer, not a single unformatted sentence.
      {
        type: 'text_delta',
        text: [
          "**Quiet night, no errors, no failed jobs.** Window 03:15-08:20 UTC.",
          '',
          '## What ran',
          '',
          '| Job | Cadence | Result |',
          '|---|---|---|',
          '| `storage-cleanup` | every 5 min | all `ok`, 9-25ms |',
          '| `data-retention` | once, 04:15 | `ok` in 169ms |',
          '| `realtime-outbox` | after each write | `ok` every time |',
          '',
          '### Notes',
          '',
          '- Only **4** event inserts, so this is heartbeat traffic.',
          '- Sources: `18.210.22.1`, `3.236.66.154`, `44.211.50.53`.',
          '',
          'Count the rows yourself with:',
          '',
          '```sql',
          "SELECT count(*) FROM public.events WHERE created_at > now() - interval '1 day';",
          '```',
        ].join('\n'),
      },
      { type: 'done', stopReason: 'end_turn' },
    ];
    const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
    return new HttpResponse(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }),

  ...admin('get', '/auth/status', () => ok({
    items: [
      { id: 'magic link', kind: 'method', enabled: true, configured: false, missing: ['email.smtp.host', 'email.smtp.username'] },
      { id: 'google', kind: 'social', enabled: true, configured: true, missing: [], callbackUrl: 'http://localhost/api/auth/callback/google' },
      { id: 'github', kind: 'social', enabled: true, configured: false, missing: ['clientSecret'], callbackUrl: 'http://localhost/api/auth/callback/github' },
      { id: 'passkey', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'twoFactor', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'signUpGate', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'accessTokenHook', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'sendHook', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'eventHook', kind: 'plugin', enabled: false, configured: true, missing: [] },
      { id: 'phone', kind: 'method', enabled: false, configured: false, missing: [] },
      { id: 'sso', kind: 'plugin', enabled: true, configured: true, missing: [] },
    ],
  })),

  // ── Advisor ─────────────────────────────────────────────────────────────
  ...admin('get', '/shield', () => ok(fx.shield)),
  ...admin('get', '/performance', () => ok(fx.performance)),

  // ── Queues, Vault, Wrappers, index advisor ──────────────────────────────
  ...dbExtHandlers,

  // ── API explorer schema ─────────────────────────────────────────────────
  // (already covered by /schema/tables above)

  // ── Authentication parity pages (audit logs, …) ────────────────────────
  ...authHandlers,

  // ── REST passthrough demo (API explorer "Try it") ───────────────────────
  ...rest('get', '/*', () => ok([])),
];
