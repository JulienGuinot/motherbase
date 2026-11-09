import { Router, type Request, type RequestHandler, type Response } from 'express';
import { SLUG_RE } from '../../constants/regex.constants';
import { requireProjectCapability, type Capability } from '../auth/capabilities';
import { auditMutations } from '../middlewares/audit.middleware';
import { sendServiceError } from '../helpers/http-error';
import type { AuditStore } from '../services/audit.service';
import type { BranchService } from '../services/branch.service';
import type { CustomDomainService } from '../services/custom-domain.service';
import type { ErrorLogSink } from '../helpers/internal-error.helper';
import { fail, ok } from '../helpers/respond';

interface Deps {
  branches: BranchService;
  domains: CustomDomainService;
  registry: { get(name: string): Promise<unknown> };
  requireSession: RequestHandler;
  audit?: AuditStore;
  logs?: ErrorLogSink;
}


/** Route params are joined onto paths and names downstream; only slugs get that far. */
const safe = (value: string | undefined) => (value && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : 'unknown');

/**
 * Branching, custom domains and vanity subdomains: the Supabase "hosting"
 * surfaces that act on a project's stack from the outside.
 *
 * Mounted on /api/platform next to platformRouter, so every middleware is
 * per route: a router-level `use` would also run (and audit) every request
 * that merely passes through on its way to platformRouter.
 */
export function projectHostingRouter(deps: Deps): Router {
  const r = Router();

  const requireProject: RequestHandler = async (req, res, next) => {
    if (!SLUG_RE.test(req.params.id ?? '')) return fail(res, 400, 'invalid project id');
    try {
      if (!(await deps.registry.get(req.params.id))) return fail(res, 404, 'project not found');
      return next();
    } catch (error) {
      return sendServiceError(res, deps.logs, 'project lookup failed', error);
    }
  };

  /** Session, capability on the project, existence, and an audit entry for mutations. */
  const guard = (capability: Capability, action: string): RequestHandler[] => [
    deps.requireSession,
    requireProjectCapability(capability),
    requireProject,
    auditMutations(deps.audit, (req: Request) => ({
      action,
      target: `project:${safe(req.params.id)}`,
      ...(req.params.branch ? { detail: { branch: safe(req.params.branch) } } : {}),
    }), deps.logs),
  ];

  const handle = (context: string, run: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      return ok(res, await run(req));
    } catch (error) {
      return sendServiceError(res, deps.logs, context, error);
    }
  };

  // ── Branches ───────────────────────────────────────────────────────────────

  const branches = deps.branches;
  r.get('/projects/:id/branches', guard('project.read', 'project.branch.read'),
    handle('list branches', req => branches.list(req.params.id)));
  // Creating a branch provisions a whole stack, so it costs what creating a project costs.
  r.post('/projects/:id/branches', guard('project.create', 'project.branch.create'),
    handle('create branch', req => branches.create(req.params.id, req.body)));
  r.get('/projects/:id/branches/:branch', guard('project.read', 'project.branch.read'),
    handle('get branch', req => branches.get(req.params.id, req.params.branch)));
  r.patch('/projects/:id/branches/:branch', guard('settings.write', 'project.branch.update'),
    handle('update branch', req => branches.update(req.params.id, req.params.branch, req.body)));
  r.delete('/projects/:id/branches/:branch', guard('project.delete', 'project.branch.delete'),
    handle('delete branch', req => branches.remove(req.params.id, req.params.branch)));
  // Merge and rebase apply migrations, which the admin proxy rates content.write.
  r.post('/projects/:id/branches/:branch/merge', guard('content.write', 'project.branch.merge'),
    handle('merge branch', req => branches.merge(req.params.id, req.params.branch)));
  r.post('/projects/:id/branches/:branch/rebase', guard('content.write', 'project.branch.rebase'),
    handle('rebase branch', req => branches.rebase(req.params.id, req.params.branch)));
  r.post('/projects/:id/branches/:branch/reset', guard('runtime.manage', 'project.branch.reset'),
    handle('reset branch', req => branches.reset(req.params.id, req.params.branch)));
  r.post('/projects/:id/branches/:branch/pause', guard('runtime.manage', 'project.branch.pause'),
    handle('pause branch', req => branches.pause(req.params.id, req.params.branch)));
  r.post('/projects/:id/branches/:branch/unpause', guard('runtime.manage', 'project.branch.unpause'),
    handle('unpause branch', req => branches.unpause(req.params.id, req.params.branch)));

  // ── Custom hostname ────────────────────────────────────────────────────────

  const domains = deps.domains;
  r.get('/projects/:id/custom-hostname', guard('project.read', 'project.domain.read'),
    handle('read custom hostname', req => domains.get(req.params.id)));
  r.post('/projects/:id/custom-hostname', guard('settings.write', 'project.domain.create'),
    handle('create custom hostname', req => domains.create(req.params.id, req.body ?? {})));
  r.post('/projects/:id/custom-hostname/reverify', guard('settings.write', 'project.domain.reverify'),
    handle('verify custom hostname', req => domains.reverify(req.params.id)));
  r.post('/projects/:id/custom-hostname/activate', guard('settings.write', 'project.domain.activate'),
    handle('activate custom hostname', req => domains.activate(req.params.id)));
  r.delete('/projects/:id/custom-hostname', guard('settings.write', 'project.domain.delete'),
    handle('delete custom hostname', req => domains.remove(req.params.id)));

  // ── Vanity subdomain ───────────────────────────────────────────────────────

  r.get('/projects/:id/vanity-subdomain', guard('project.read', 'project.vanity.read'),
    handle('read vanity subdomain', req => domains.get(req.params.id)));
  r.post('/projects/:id/vanity-subdomain/check-availability', guard('project.read', 'project.vanity.check'),
    handle('check vanity subdomain', req => domains.checkVanity(req.params.id, req.body ?? {})));
  r.post('/projects/:id/vanity-subdomain', guard('settings.write', 'project.vanity.activate'),
    handle('activate vanity subdomain', req => domains.activateVanity(req.params.id, req.body ?? {})));
  r.delete('/projects/:id/vanity-subdomain', guard('settings.write', 'project.vanity.delete'),
    handle('delete vanity subdomain', req => domains.removeVanity(req.params.id)));

  return r;
}
