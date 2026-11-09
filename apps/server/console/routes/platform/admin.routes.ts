import type { Router } from 'express';
import { errorMessage } from '../../../lib/errors';
import { MIN_PASSWORD } from '../../constants';
import { sessionUser } from '../../auth/session';
import { capabilitiesForRole, requireCapability } from '../../auth/capabilities';
import { requireRole } from '../../middlewares';
import { fail, ok } from '../../helpers/respond';
import { PlatformSettingsService } from '../../services/settings.service';
import { defaultableGroups } from '../../services/project-defaults.service';
import { parseAuditLimit } from '../../services/audit.service';
import type { PlatformDeps } from './deps';
import { guarded } from './handlers';

const UNCONFIGURED_VERSION = { current: 'unknown', latest: null, updateAvailable: false, configured: false };

function serverSettings(cfg: PlatformDeps['cfg']) {
  return {
    mode: cfg.mode,
    domainSuffix: cfg.domainSuffix,
    adminEmail: cfg.adminEmail ?? null,
    apiImage: cfg.apiImage ?? null,
    certResolver: cfg.certResolver ?? null,
    traefikNetwork: cfg.traefikNetwork ?? null,
    alertWebhookUrl: cfg.alertWebhookUrl ?? '',
    alertCpuThreshold: cfg.alertCpuThreshold ?? '',
    alertMemThreshold: cfg.alertMemThreshold ?? '',
  };
}

function registerSessionRoutes(r: Router, deps: PlatformDeps): void {
  r.get('/me', (req, res) => {
    const user = sessionUser(req)!;
    return ok(res, { ...user, capabilities: capabilitiesForRole(user.role) });
  });

  r.get('/info', (_req, res) =>
    ok(res, {
      mode: deps.cfg.mode,
      domainSuffix: deps.cfg.domainSuffix,
      // Absent means off: an older console that predates the flag must not have
      // the studio assume a surface it cannot serve.
      features: (deps.cfg as { features?: { billing?: boolean } }).features ?? { billing: false },
    }),
  );

  // Any authenticated user changes their OWN password. Passwords live in Better
  // Auth (via the users service); the current password is verified against the
  // stored credential hash before the new one is written.
  r.post('/account/password', guarded(deps, async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
      return fail(res, 400, `new password must be at least ${MIN_PASSWORD} characters`);
    }
    const me = sessionUser(req);
    if (!deps.users || !me) return fail(res, 401, 'Unauthorized');
    const record = await deps.users.findById(me.id);
    if (!record) return fail(res, 401, 'Unauthorized');
    if (!(await deps.users.verifyPassword(me.id, String(currentPassword ?? '')))) {
      return fail(res, 401, 'current password is incorrect');
    }
    await deps.users.setPassword(me.id, newPassword);
    deps.logs?.push({ level: 'info', source: 'console', message: `password changed for ${record.email}` });
    return ok(res, { changed: true, mustChangePassword: false });
  }));
}

function registerAuditRoutes(r: Router, deps: PlatformDeps): void {
  r.get('/audit', requireCapability('audit.read'), guarded(deps, (req, res) => {
    if (!deps.audit) return fail(res, 501, 'audit persistence not available');
    const limit = parseAuditLimit(req.query.limit);
    if (!limit) return fail(res, 400, 'limit must be an integer between 1 and 500');
    return ok(res, { events: deps.audit.list(limit) });
  }, 'audit query failed'));
}

function registerUpdateRoutes(r: Router, deps: PlatformDeps): void {
  // Self-update: current version + newest available on the release channel.
  // Read-only and non-destructive; any authenticated session may see it.
  r.get('/version', guarded(deps, async (_req, res) => {
    if (!deps.updates) return ok(res, { ...UNCONFIGURED_VERSION, checkedAt: new Date().toISOString() });
    return ok(res, await deps.updates.check());
  }));

  // Selective, guided self-update plan: read-only host commands, no destructive
  // action (the console has no socket). Owner/admin only, like /dns and /logs.
  r.get('/update/plan', requireRole('owner', 'admin'), guarded(deps, async (_req, res) => {
    if (!deps.updates?.plan) return ok(res, { ...UNCONFIGURED_VERSION, services: [], commands: [], notes: [] });
    return ok(res, await deps.updates.plan());
  }));
}

function registerSettingsRoutes(r: Router, deps: PlatformDeps): void {
  r.get('/settings', requireRole('owner'), (_req, res) => ok(res, serverSettings(deps.cfg)));

  r.put('/settings', requireRole('owner'), guarded(deps, async (req, res) => {
    if (!deps.settings) return fail(res, 501, 'settings persistence not available');
    const patch = PlatformSettingsService.pickServerKeys(req.body ?? {});
    const keys = Object.keys(patch);
    if (keys.length === 0) return fail(res, 400, 'no editable settings provided');
    await deps.settings.update(patch);
    Object.assign(deps.cfg, patch); // take effect live
    deps.logs?.push({ level: 'info', source: 'console', message: `server settings updated: ${keys.join(', ')}` });
    return ok(res, { updated: keys });
  }));

  // New-project default settings bundle. Operators (owner) set baseline values
  // that seed each newly-provisioned project. Only non-secret project groups are
  // allowed; the store validates against the project settings registry.
  r.get('/project-defaults', requireRole('owner'), guarded(deps, async (_req, res) => {
    if (!deps.projectDefaults) return fail(res, 501, 'project defaults persistence not available');
    return ok(res, { defaults: await deps.projectDefaults.load(), groups: defaultableGroups() });
  }));

  r.put('/project-defaults', requireRole('owner'), async (req, res) => {
    if (!deps.projectDefaults) return fail(res, 501, 'project defaults persistence not available');
    try {
      const saved = await deps.projectDefaults.save(req.body?.defaults ?? req.body ?? {});
      const groups = Object.keys(saved).join(', ') || '(cleared)';
      deps.logs?.push({ level: 'info', source: 'console', message: `project defaults updated: ${groups}` });
      return ok(res, { defaults: saved });
    } catch (error: unknown) {
      // The store throws on an unknown group or a secret field: the caller's mistake.
      return fail(res, 400, errorMessage(error) || 'invalid project defaults');
    }
  });
}

export function registerAdminRoutes(r: Router, deps: PlatformDeps): void {
  registerSessionRoutes(r, deps);
  registerAuditRoutes(r, deps);
  registerUpdateRoutes(r, deps);
  registerSettingsRoutes(r, deps);
}
