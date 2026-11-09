import axios from 'axios';
import { auth } from '@/shared/lib/auth';
import { BASE_PATH, project } from '@/shared/lib/project';
import type { FieldDef } from '@/shared/lib/settings';
import type { LogEntry } from '@/features/logs/types';
import type { ProjectUsage } from '@/features/projects/types';

export const api = axios.create({ baseURL: '/api' });

/**
 * The one place that knows a project-scoped path is `/projects/<pid>/admin/…`.
 * Exported because the assistant streams over `fetch` (SSE, so it cannot go
 * through axios) and must build the same URL, see `assistant.api.ts`.
 */
export function withProjectPrefix(url: string): string {
  const pid = project.get();
  if (!pid) return url;
  if (url.startsWith('/admin') || url.startsWith('/rest/v1')) return `/projects/${pid}${url}`;
  return url;
}

api.interceptors.request.use(config => {
  if (config.url) config.url = withProjectPrefix(config.url);
  const token = auth.getAccess();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;

function isProjectAdminProxyRequest(url?: string): boolean {
  return Boolean(url?.match(/^\/projects\/[^/]+\/admin(?:\/|$)/));
}

function redirectToRequiredPasswordChange(): void {
  if (typeof window === 'undefined') return;
  // Absolute, because this is a location assignment and not a router
  // navigation: it has to carry the basePath itself. The forced-rotation
  // contract belongs to the multi-project Console; per-project auth never
  // returns this error code.
  const destination = `${BASE_PATH}/password-change-required`;
  if (window.location.pathname !== destination) window.location.assign(destination);
}

/**
 * The session is gone and the user did not ask for it. `RequireAuth` reads
 * `auth.isAuthed()`, which is a module variable and not reactive, so clearing
 * the token alone leaves the operator on a dead page whose every query fails
 * one by one. A location assignment is also what cancels the in-flight
 * react-query requests: the document unloads with them.
 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  // Absolute, because this is a location assignment and not a router
  // navigation: it has to carry the basePath itself.
  const destination = `${BASE_PATH}/login`;
  if (window.location.pathname !== destination) window.location.assign(destination);
}

async function refreshAccess(): Promise<string | null> {
  const refreshToken = auth.getRefresh();
  if (!refreshToken) return null;
  try {
    const { data } = await axios.post('/api/auth/refresh', { refreshToken });
    const access = data?.data?.accessToken ?? data?.accessToken;
    const newRefresh = data?.data?.refreshToken ?? data?.refreshToken;
    if (access) {
      auth.set(access, newRefresh);
      return access;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * One refresh at a time, however many callers race into it. The previous
 * version cleared `refreshing` right after its own await, so a second caller
 * awaiting the same promise could null it while a third was still arriving and
 * start a competing refresh, with rotating refresh tokens that second call
 * fails and signs the user out. `finally` clears it exactly once.
 */
function dedupedRefresh(): Promise<string | null> {
  refreshing ??= refreshAccess().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * The access token to send, refreshing only when there is none. For callers
 * that cannot use the axios instance (the assistant's SSE stream).
 */
export async function ensureAccessToken(): Promise<string | null> {
  return auth.getAccess() ?? (await dedupedRefresh());
}

/** Force a refresh after a 401. `null` means the session is over. */
export async function refreshAccessToken(): Promise<string | null> {
  const access = await dedupedRefresh();
  if (!access) {
    auth.clear('expired');
    redirectToLogin();
  }
  return access;
}

api.interceptors.response.use(
  r => r,
  async error => {
    const original = error.config;
    if (error.response?.status === 403 && error.response?.data?.code === 'PASSWORD_CHANGE_REQUIRED') {
      auth.requirePasswordChange();
      redirectToRequiredPasswordChange();
    }
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      const access = await dedupedRefresh();
      if (access) {
        original.headers.Authorization = `Bearer ${access}`;
        return api(original);
      }
      // The refresh failed, so this sign-out is not something the user asked
      // for. Record why, so the login screen can explain itself, and get off
      // the page: otherwise every other query in flight fails on its own and
      // the operator is left staring at a dead screen.
      //
      // A 401 from the project admin proxy is the *project's* API refusing,
      // not the Console session expiring: it must not sign the operator out.
      if (!isProjectAdminProxyRequest(original.url)) {
        auth.clear('expired');
        redirectToLogin();
      }
    }
    return Promise.reject(error);
  }
);

export interface ProjectReadiness {
  /** The console reached the project's API. The only thing worth gating on. */
  ready: boolean;
  /** Container state. 'running' still does not mean the API is listening. */
  status: 'running' | 'stopped' | string;
}

export interface PlatformProject {
  name: string;
  domain: string;
  storageDomain?: string;
  apiUrl?: string;
  createdAt?: string;
  status: 'running' | 'stopped';
  /** Set on preview branches; they are reached through the branch switcher, not listed as projects. */
  branch?: { parent: string; name: string; status: string };
}

export interface DnsCheck {
  name: string;
  target: string;
  ok: boolean;
  message: string;
}

export interface DnsResult {
  checks: DnsCheck[];
}

/** Server filesystem + per-project Docker volume sizes (GET /platform/disk). */
export interface DiskUsage {
  /** Null for scoped roles and where the console cannot stat its disk. */
  host: { path: string; total: number; used: number; free: number; percent: number } | null;
  projects: ProjectDisk[];
  measuredAt: string | null;
}

export interface ProjectDisk {
  project: string;
  size: number;
  volumes: { name: string; label: string; size: number }[];
  /** Configured disk quota in bytes. Absent when the limits could not be read. */
  quota?: number;
}

export interface ProxyMetricsRow {
  projectId: string;
  rest: number;
  edge: number;
  admin: number;
  total: number;
  lastAt: number;
}

export interface CreateProjectInput {
  name: string;
  domain?: string;
  storageDomain?: string;
  corsOrigins?: string;
  orgId?: string;
}

export interface ProjectConfig {
  domain: string;
  storageDomain: string;
  minioConsoleDomain: string;
  corsOrigins: string;
  apiImage: string;
  certResolver: string;
}

export type ProjectConfigPatch = Partial<ProjectConfig>;

export const platform = {
  me: () => api.get('/platform/me').then(r => r.data.data as PlatformSession),
  audit: (limit = 100) =>
    api
      .get('/platform/audit', { params: { limit } })
      .then(r => r.data.data.events as PlatformAuditEvent[]),
  // Optionally scope to a tenant org (undefined = all projects the caller may see).
  list: (orgId?: string) =>
    api
      .get('/platform/projects', { params: orgId ? { org: orgId } : undefined })
      .then(r => r.data.data as PlatformProject[]),
  info: () =>
    api
      .get('/platform/info')
      .then(r => r.data.data as { mode: string; domainSuffix: string; features?: { billing?: boolean } }),
  version: () =>
    api.get('/platform/version').then(
      r =>
        r.data.data as {
          current: string;
          latest: string | null;
          updateAvailable: boolean;
          configured: boolean;
          checkedAt: string;
          channel?: string;
          error?: string;
        }
    ),
  updatePlan: () => api.get('/platform/update/plan').then(r => r.data.data as UpdatePlan),
  getProjectDefaults: () =>
    api.get('/platform/project-defaults').then(r => r.data.data as ProjectDefaultsResponse),
  putProjectDefaults: (defaults: Record<string, Record<string, unknown>>) =>
    api
      .put('/platform/project-defaults', { defaults })
      .then(r => r.data.data as { defaults: Record<string, Record<string, unknown>> }),
  // Apply one default group to a specific project via its admin settings API
  // (proxied). Used post-provision to seed a new project with operator defaults.
  applyProjectDefault: (id: string, group: string, values: Record<string, unknown>) =>
    api.put(`/projects/${id}/admin/settings/${group}`, values).then(r => r.data.data),
  dns: () => api.get('/platform/dns').then(r => r.data.data as DnsResult),
  logs: () => api.get('/platform/logs?limit=300').then(r => r.data.data as { logs: LogEntry[] }),
  create: (body: CreateProjectInput) => api.post('/platform/projects', body).then(r => r.data.data),
  start: (id: string) => api.post(`/platform/projects/${id}/start`),
  stop: (id: string) => api.post(`/platform/projects/${id}/stop`),
  restart: (id: string) => api.post(`/platform/projects/${id}/restart`),
  update: (id: string) => api.post(`/platform/projects/${id}/update`),
  rebuild: (id: string) => api.post(`/platform/projects/${id}/rebuild`),
  projectDns: (id: string) => api.get(`/platform/projects/${id}/dns`).then(r => r.data.data as DnsResult),
  /** Whether the console can reach this project's API yet. See ProjectGate. */
  projectReady: (id: string) =>
    api.get(`/platform/projects/${id}/ready`).then(r => r.data.data as ProjectReadiness),
  projectShell: (id: string) =>
    api.get(`/platform/projects/${id}/shell`).then(r => r.data.data as { command: string; service: string }),
  projectLogs: (id: string) =>
    api.get(`/platform/projects/${id}/logs`).then(r => r.data.data as { stdout: string; stderr: string }),
  projectConfig: (id: string) => api.get(`/platform/projects/${id}/config`).then(r => r.data.data as ProjectConfig),
  updateProjectConfig: (id: string, patch: ProjectConfigPatch) =>
    api.patch(`/platform/projects/${id}/config`, patch).then(r => r.data.data as ProjectConfig),
  destroy: (id: string) => api.delete(`/platform/projects/${id}`, { data: { confirm: id } }),
  metrics: () => api.get('/platform/metrics').then(r => r.data.data as PlatformMetrics),
  disk: () => api.get('/platform/disk').then(r => r.data.data as DiskUsage),
  proxyMetrics: () => api.get('/platform/proxy-metrics').then(r => r.data.data as ProxyMetricsRow[]),
  settings: () => api.get('/platform/settings').then(r => r.data.data),
  updateSettings: (body: Record<string, string>) => api.put('/platform/settings', body).then(r => r.data.data),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post('/platform/account/password', { currentPassword, newPassword }).then(r => r.data.data),

  // Console users / RBAC (owner-only on the backend; the UI just calls them).
  users: {
    list: () => api.get('/platform/users').then(r => r.data.data as PlatformUser[]),
    create: (body: { email: string; password: string; role: PlatformRole; projects?: string[] }) =>
      api.post('/platform/users', body).then(r => r.data.data as PlatformUser),
    update: (id: string, patch: { role?: PlatformRole; projects?: string[]; disabled?: boolean; password?: string }) =>
      api.patch(`/platform/users/${id}`, patch).then(r => r.data.data as PlatformUser),
    revokeSessions: (id: string) => api.delete(`/platform/users/${id}/sessions`),
    remove: (id: string) => api.delete(`/platform/users/${id}`),
  },

  // Per-project resource quotas (GET current, PATCH triggers a recreate).
  projectLimits: (id: string) => api.get(`/platform/projects/${id}/limits`).then(r => r.data.data as ProjectLimits),
  setProjectLimits: (id: string, patch: Partial<ProjectLimits>) =>
    api.patch(`/platform/projects/${id}/limits`, patch).then(r => r.data.data as ProjectLimits),

  // ── Supabase import (proxied to the project's own admin API) ────────────────
  // The explicit /projects/<id>/admin/... path bypasses the axios interceptor's
  // project-scoped rewrite (which only fires for bare /admin URLs), so these work
  // on the create page before any project is "selected".

  // Cheap probe: resolves true once the freshly-provisioned API container answers
  // its admin surface. Used to poll readiness before kicking off a (non-idempotent)
  // import so we never retry a half-applied import.
  projectAdminReady: (id: string) =>
    api
      .get(`/projects/${id}/admin/session`)
      .then(() => true)
      .catch(() => false),

  // Dry-run: counts tables/policies/auth users without writing anything.
  importSupabasePreview: (id: string, body: SupabaseImportBody) =>
    api
      .post(`/projects/${id}/admin/import/supabase`, { ...body, preview: true })
      .then(r => r.data.data as SupabaseImportPreview),

  // Real import. confirm:'IMPORT' is required by the backend as a safety gate.
  importSupabase: (id: string, body: SupabaseImportBody) =>
    api
      .post(`/projects/${id}/admin/import/supabase`, { ...body, confirm: 'IMPORT' })
      .then(r => r.data.data as SupabaseImportSummary),
};

export interface UpdatePlan {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  configured: boolean;
  services: { name: string; from: string; to: string }[];
  commands: string[];
  notes: string[];
}

export interface DefaultableGroup {
  key: string;
  label: string;
  description?: string;
  fields: FieldDef[];
}
export interface ProjectDefaultsResponse {
  defaults: Record<string, Record<string, unknown>>;
  groups: DefaultableGroup[];
}

export interface SupabaseImportInclude {
  schema?: boolean;
  data?: boolean;
  auth?: boolean;
  storage?: boolean;
  edgeFunctions?: boolean;
  secrets?: boolean;
}

/**
 * The credentials the import accepts. Only the connection string is required;
 * `serviceRoleKey` unlocks storage object bytes and `managementToken` unlocks
 * edge functions and project secrets, because neither lives in the database.
 */
export interface SupabaseImportBody {
  connectionString: string;
  include?: SupabaseImportInclude;
  serviceRoleKey?: string;
  managementToken?: string;
  projectRef?: string;
  projectUrl?: string;
}

export interface SupabaseImportPreview {
  tables: { name: string; rows: number }[];
  policies: number;
  authUsers: number;
  buckets: { name: string; objects: number; bytes: number }[];
  edgeFunctions: string[];
  secrets: number;
  notes: string[];
}

export interface SupabaseImportSummary {
  status: 'success' | 'partial' | 'failed';
  schema: { applied: boolean; error?: string; warnings?: string };
  data: { applied: boolean; includedInDump: boolean; error?: string };
  auth: { imported: number; skipped: number; errors: string[] };
  storage: { buckets: number; objects: number; skipped: number; errors: string[] };
  edgeFunctions: {
    imported: number;
    enabled: number;
    needsPorting: number;
    errors: string[];
    /** Imported but left disabled, by name. */
    disabled?: string[];
  };
  secrets: {
    imported: number;
    skipped: number;
    errors: string[];
    /** Names whose value Supabase would not disclose: set each one by hand. */
    undisclosed?: string[];
  };
  verification?: {
    valid: boolean;
    checked: {
      tables: number;
      rows: boolean;
      constraints: number;
      policies: number;
    };
    errors: string[];
  };
  notes: string[];
}

export type PlatformRole = 'owner' | 'admin' | 'developer' | 'read_only' | 'member';
export type PlatformCapability =
  | 'project.read'
  | 'project.create'
  | 'content.write'
  | 'settings.write'
  | 'runtime.manage'
  | 'secrets.manage'
  | 'project.delete'
  | 'users.manage'
  | 'audit.read';

export interface PlatformAuditEvent {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  actorRole: PlatformRole | 'unknown';
  ip: string;
  action: string;
  target: string;
  success: boolean;
  detail: Record<string, unknown> | null;
}

export interface PlatformSession {
  id: string;
  email: string;
  role: PlatformRole;
  projects: string[];
  capabilities: PlatformCapability[];
}

export function isProjectScopedRole(role: PlatformRole): boolean {
  return role === 'developer' || role === 'read_only' || role === 'member';
}

export interface PlatformUser {
  id: string;
  email: string;
  role: PlatformRole;
  projects: string[];
  disabled: boolean;
  createdAt: string;
}

export interface PlatformHostMetrics {
  hostname: string;
  platform: string;
  uptimeSec: number;
  cpuCount: number;
  loadAvg: [number, number, number];
  loadPercent: number;
  memTotal: number;
  memFree: number;
  memUsed: number;
  memPercent: number;
}

/** GET /platform/metrics. Host is null for scoped roles. */
export interface PlatformMetrics {
  host: PlatformHostMetrics | null;
  containers: PlatformContainerStat[];
  projects: ProjectUsage[];
}

/** One container's live usage, as GET /platform/metrics lists it. */
export interface PlatformContainerStat {
  project: string | null;
  /** Compose service name: see PROJECT_SERVICES. */
  service: string | null;
  cpuPercent: number;
  memUsed: number;
}

export interface ProjectLimits {
  apiCpus: number;
  apiMemMb: number;
  dbCpus: number;
  dbMemMb: number;
  minioCpus: number;
  minioMemMb: number;
  edgeCpus: number;
  edgeMemMb: number;
  /** Disk quota in GiB, across the project's database, files and backups. */
  diskGb: number;
}
