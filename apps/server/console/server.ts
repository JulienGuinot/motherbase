import express, { type Express, type Request, type Response } from 'express';
import '../lib/express-async-errors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { toNodeHandler } from 'better-auth/node';
import { consoleConfig, assertConsoleSecret } from './config';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from './auth/instance';
import { enforcePasswordRotation, requireSession } from './auth/session';
import { Orchestrator } from './services/orchestrator.service';
import { Registry } from './services/registry.service';
import { UpdateService } from './services/update.service';
import { platformRouter } from './routes/platform.routes';
import { proxyRouter } from './routes/proxy.routes';
import { previewRouter, sweepPreviews } from './routes/preview.routes';
import { usersRouter } from './routes/users.routes';
import { PlatformUsersService } from './services/users.service';
import { OrgStore } from './services/org-store';
import { orgsRouter } from './routes/orgs.routes';
import { OrgAiConfigService } from './services/org-ai.service';
import { LogBuffer } from '../lib/log-buffer';
import { DiagnosticsService } from './services/diagnostics.service';
import { PlatformSettingsService } from './services/settings.service';
import { ProjectDefaultsStore } from './services/project-defaults.service';
import { PlatformMetricsService } from './services/metrics.service';
import { AlertsService } from './services/alerts.service';
import { AutoPauseService } from './services/auto-pause.service';
import { proxyMetrics } from './services/proxy-metrics.service';
import { OrchestrationClient, createOrchestrationExec } from './orchestration/client';
import { AuditStore } from './services/audit.service';
import { findStudioDir, mountStudio, STUDIO_MOUNT } from '../lib/studio-next';
import { projectHostingRouter } from './routes/project-hosting.routes';
import { BranchService } from './services/branch.service';
import { CustomDomainService } from './services/custom-domain.service';
import { ProjectAdminClient } from './services/project-admin.client';
import { platformLoginHandler } from './routes/login.routes';
import { applyHttpHardening, createAuthLimiter } from './http-hardening';

type ConsoleConfig = typeof consoleConfig;

interface ConsoleOverrides {
  registry?: any;
  orchestrator?: any;
}

// Synchronous boot-time merge of persisted overrides so the shared cfg object is
// correct before any service is constructed. Runtime edits go through PlatformSettingsService.
function loadSettingsSync(projectsDir: string): Record<string, any> {
  try {
    const raw = fs.readFileSync(path.join(projectsDir, 'console-settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function consoleAuthConfig(cfg: ConsoleConfig): ConsoleAuthCfg {
  // Better Auth secret must be >=32 chars; pad the short dev secret
  // deterministically so dev/test still work. In prod assertConsoleSecret has
  // already required >=32 real characters, so the pad is a no-op there.
  const secret = cfg.jwtSecret.padEnd(32, 'x');
  const baseURL = process.env.CONSOLE_BASE_URL ?? `${cfg.scheme}://localhost:${cfg.port}`;
  return { projectsDir: cfg.projectsDir, secret, baseURL, mode: cfg.mode, trustedOrigins: trustedAuthOrigins(cfg) };
}

/**
 * Public origins to trust for auth (in addition to the request's own host):
 * the configured base URL and the conventional console.<domain> host. Guards
 * against proxies that rewrite the Host header. CONSOLE_TRUSTED_ORIGINS lets an
 * operator add more (comma-separated).
 */
function trustedAuthOrigins(cfg: ConsoleConfig): string[] {
  return [
    ...(process.env.CONSOLE_BASE_URL ? [process.env.CONSOLE_BASE_URL] : []),
    ...(cfg.domainSuffix ? [`${cfg.scheme}://console.${cfg.domainSuffix}`] : []),
    ...(process.env.CONSOLE_TRUSTED_ORIGINS?.split(',') ?? []),
  ]
    .map(o => { try { return new URL(o.trim()).origin; } catch { return ''; } })
    .filter(Boolean);
}

function orchestrationExec() {
  const secret = process.env.ORCHESTRATION_SECRET ??
    (process.env.NODE_ENV === 'test' ? 'test-orchestration-secret-at-least-32-characters' : '');
  const client = new OrchestrationClient(process.env.ORCHESTRATION_URL ?? 'http://orchestrator:5501', secret);
  return createOrchestrationExec(client);
}

/**
 * Tenant orgs sit above projects (Supabase-style). Backfill migrates existing
 * single-tenant installs into a default org so the switcher always has an org
 * and current logins keep seeing their projects. registry.list() may be empty
 * when docker is unavailable (tests): projects then assign lazily on next boot.
 */
async function backfillOrgs(orgs: OrgStore, users: PlatformUsersService, registry: any, logs: LogBuffer) {
  try {
    const allUsers = await users.list();
    const projectNames = (await registry.list().catch(() => [])).map((p: any) => p.name);
    orgs.backfill({ users: allUsers.map(u => ({ id: u.id, role: u.role })), projectNames });
  } catch (e: any) {
    logs.push({ level: 'warn', source: 'console', message: `org backfill skipped: ${e?.message ?? e}` });
  }
}

async function createConsoleServices(cfg: ConsoleConfig, authCfg: ConsoleAuthCfg, overrides?: ConsoleOverrides) {
  const logs = new LogBuffer(1000);
  // Ensure the console-auth SQLite schema exists before serving (idempotent).
  await migrateConsoleAuth(authCfg);
  const auth = createConsoleAuth(authCfg);

  const users = new PlatformUsersService(auth);
  // Back-compat: seed the single env admin as the first `owner` when the store
  // is empty. The env admin supplies a bcrypt hash, not a plaintext.
  await users.seedOwnerWithHash({
    email: cfg.adminEmail,
    passwordHash: cfg.adminPasswordHash,
    passwordTemporary: cfg.adminPasswordTemporary,
  });

  const exec = orchestrationExec();
  const settings = new PlatformSettingsService(cfg, fsp as any);
  const metrics = new PlatformMetricsService(exec, cfg.projectsDir);
  const registry = overrides?.registry ?? new Registry(cfg, fsp as any, exec);
  const orchestrator = overrides?.orchestrator ?? new Orchestrator(cfg, fsp as any, exec, undefined, logs);
  new AlertsService(settings, metrics, registry, orchestrator).start();
  new AutoPauseService({ registry, orchestrator, admin: new ProjectAdminClient(registry), proxy: proxyMetrics, logs }).start();

  const orgs = OrgStore.open(cfg.projectsDir);
  await backfillOrgs(orgs, users, registry, logs);

  return {
    cfg,
    logs,
    auth,
    users,
    settings,
    metrics,
    registry,
    orchestrator,
    orgs,
    // The org-wide AI key. Sealed with the console session secret (see
    // helpers/secret-box) and pushed into each project's .env.prod by the
    // orchestrator, so a project API needs no route back here to read it.
    orgAi: new OrgAiConfigService(orgs, orchestrator, authCfg.secret),
    audit: AuditStore.open(cfg.projectsDir, { maxEntries: Number(process.env.CONSOLE_AUDIT_MAX_ENTRIES) }),
    projectDefaults: new ProjectDefaultsStore(cfg, fsp as any),
    diagnostics: new DiagnosticsService(cfg),
    updates: new UpdateService({
      updateCheckUrl: cfg.updateCheckUrl,
      stackComposePath: process.env.CONSOLE_STACK_COMPOSE || 'deploy/console/docker-compose.yml',
      stackServices: (process.env.CONSOLE_STACK_SERVICES || 'console orchestrator').split(/\s+/).filter(Boolean),
    }),
  };
}

type ConsoleServices = Awaited<ReturnType<typeof createConsoleServices>>;

function mountAuthRoutes(app: Express, { auth, users, audit, logs }: ConsoleServices): void {
  const authLimiter = createAuthLimiter();
  // The Better Auth handler owns /api/auth/* and MUST be mounted before
  // express.json(): it reads the raw request body itself.
  app.all('/api/auth/*', authLimiter, enforcePasswordRotation(auth), toNodeHandler(auth));
  // `verify` keeps the exact bytes alongside the parsed body. The GitHub
  // webhook authenticates by HMAC over them, and re-serialising the parsed
  // object does not reproduce what was signed.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(cookieParser());
  app.post('/api/platform/login', authLimiter, platformLoginHandler({ auth, users, audit, logs }));
}

function previewConfig(cfg: ConsoleConfig) {
  return {
    enabled: cfg.preview.enabled,
    repoAllowlist: cfg.preview.repoAllowlist,
    ttlHours: cfg.preview.ttlHours,
    secret: cfg.preview.secret,
    githubToken: cfg.preview.githubToken,
    scheme: cfg.mode === 'dev' ? 'http' as const : 'https' as const,
    domainSuffix: cfg.domainSuffix,
  };
}

function mountApiRoutes(app: Express, services: ConsoleServices): void {
  const { cfg, auth, users, registry, orchestrator, orgs, orgAi, logs, audit } = services;
  const guard = requireSession(auth, (id: string) => users.projectsOf(id));
  // Mounted before the session-guarded routers: GitHub has no console account,
  // and this router authenticates by signature instead.
  app.use('/api/preview', previewRouter({ orchestrator, registry, logs, config: previewConfig(cfg) }));

  const branches = new BranchService({ registry, orchestrator, admin: new ProjectAdminClient(registry), orgs, logs });
  const domains = new CustomDomainService(cfg, fsp as any, orchestrator);
  app.use('/api/platform', projectHostingRouter({ branches, domains, registry, requireSession: guard, logs, audit }));
  app.use('/api/platform/users', usersRouter({ users, requireSession: guard, logs, audit }));
  app.use('/api/platform/orgs', orgsRouter({ orgs, orgAi, users, requireSession: guard, logs, audit }));
  app.use('/api/platform', platformRouter({ ...services, branches, requireSession: guard }));
  app.use('/api', proxyRouter({ registry, requireSession: guard, logs, audit }));
}

async function mountStudioRoutes(app: Express): Promise<void> {
  app.get('/docs/sdk.md', (_req: Request, res: Response) => res.sendFile(path.join(process.cwd(), 'docs', 'sdk.md')));

  // The app is mounted under /studio (next.config.mjs basePath). Its former root
  // and the legacy /console mount are sent under it so old links and bookmarks
  // still resolve.
  app.get(['/console', '/console/*'], (req: Request, res: Response) =>
    res.redirect(308, `${STUDIO_MOUNT}${req.originalUrl.slice('/console'.length)}`));

  const studioDir = findStudioDir();
  if (studioDir) await mountStudio(app, studioDir);

  // Anything left is a console route from the era when the app was mounted at
  // the root. The bare root is special-cased so it lands on /studio, not
  // /studio/, which next would then redirect again.
  app.get('*', (req: Request, res: Response) => {
    const target = req.originalUrl === '/' ? STUDIO_MOUNT : `${STUDIO_MOUNT}${req.originalUrl}`;
    res.redirect(308, target);
  });
}

/**
 * Sweep preview stacks whose teardown webhook never arrived: a failed
 * delivery, a deleted repository, or a PR closed while the console was down.
 * Without this those stacks live forever and the operator finds out through
 * disk usage.
 */
function schedulePreviewSweep({ cfg, orchestrator, registry, logs }: ConsoleServices): void {
  if (!cfg.preview.enabled || cfg.preview.ttlHours <= 0) return;
  const previewDeps = { orchestrator, registry, logs, config: cfg.preview };
  const timer = setInterval(() => {
    void sweepPreviews(previewDeps).catch(() => undefined);
  }, 60 * 60 * 1000);
  // Never hold the process open for a housekeeping timer.
  timer.unref();
}

export async function createConsoleApp(overrides?: ConsoleOverrides) {
  // Mutable copy of the env-derived config, shared by reference across every
  // service. Persisted overrides are merged in; runtime edits mutate it live.
  const cfg: ConsoleConfig = { ...consoleConfig, ...loadSettingsSync(consoleConfig.projectsDir) };
  assertConsoleSecret(cfg);
  const services = await createConsoleServices(cfg, consoleAuthConfig(cfg), overrides);

  const app = express();
  applyHttpHardening(app);
  mountAuthRoutes(app, services);
  mountApiRoutes(app, services);
  await mountStudioRoutes(app);
  schedulePreviewSweep(services);
  return app;
}

if (require.main === module) {
  createConsoleApp()
    .then(app => app.listen(consoleConfig.port, () => console.log(`Console on :${consoleConfig.port}`)))
    .catch(err => {
      console.error('[console] failed to start:', err);
      process.exit(1);
    });
}
