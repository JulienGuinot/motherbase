import { Router, Request, Response, RequestHandler } from 'express';
import { sessionUser } from '../auth/session';
import { hasCapability, hasProjectScope } from '../auth/capabilities';
import type { OrgStore, OrgRole } from '../services/org-store';
import { validateOrgAiConfig, type OrgAiConfigService } from '../services/org-ai.service';
import type { PlatformUsersService } from '../services/users.service';
import { auditMutations, type AuditMutation } from '../middlewares/audit.middleware';
import type { AuditStore } from '../services/audit.service';
import type { ErrorLogSink } from '../helpers/internal-error.helper';
import { fail, ok } from '../helpers/respond';


interface Deps {
  orgs: OrgStore;
  orgAi?: OrgAiConfigService;
  users: PlatformUsersService;
  requireSession: RequestHandler;
  audit?: AuditStore;
  logs?: ErrorLogSink;
}

function safeId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : 'unknown';
}

function classifyOrgMutation(req: Request): AuditMutation {
  if (req.method === 'POST' && req.path === '/') {
    return { action: 'organization.create', target: 'organization:new' };
  }
  const member = req.path.match(/^\/([^/]+)\/members(?:\/([^/]+))?$/);
  if (member && req.method === 'POST') {
    const role = ['owner', 'admin', 'member'].includes(req.body?.role) ? req.body.role : 'member';
    return {
      action: 'organization.member.add',
      target: `organization:${safeId(member[1])}`,
      detail: { memberId: safeId(req.body?.userId), role },
    };
  }
  if (member && req.method === 'DELETE') {
    return {
      action: 'organization.member.remove',
      target: `organization:${safeId(member[1])}`,
      detail: { memberId: safeId(member[2]) },
    };
  }
  const ai = req.path.match(/^\/([^/]+)\/ai$/);
  if (ai && req.method === 'PUT') {
    return { action: 'organization.ai.update', target: `organization:${safeId(ai[1])}` };
  }
  if (ai && req.method === 'DELETE') {
    return { action: 'organization.ai.clear', target: `organization:${safeId(ai[1])}` };
  }
  const org = req.path.match(/^\/([^/]+)$/);
  if (org && req.method === 'PATCH') return { action: 'organization.update', target: `organization:${safeId(org[1])}` };
  if (org && req.method === 'DELETE') return { action: 'organization.delete', target: `organization:${safeId(org[1])}` };
  return { action: 'organization.mutation', target: 'organization:unknown' };
}

/**
 * Tenant-org management. Every route is session-guarded; org-scoped routes further
 * require the caller to be a member of the target org (a global console owner or
 * admin bypasses this, matching the rest of the platform router). Org-management
 * actions (rename/delete/member changes) additionally require an elevated role.
 */
export function orgsRouter(deps: Deps): Router {
  const r = Router();
  r.use(deps.requireSession);
  r.use(auditMutations(deps.audit, classifyOrgMutation, deps.logs));

  // Console owners and admins already reach every project, so they govern
  // every org too: an admin could create an org and then not manage it.
  const isGlobalAdmin = (req: Request) => ['owner', 'admin'].includes(sessionUser(req)?.role ?? '');

  // Resolve the caller's effective authority over an org: their org role, or a
  // synthetic 'owner' for a global console owner or admin.
  function authority(req: Request, orgId: string): OrgRole | undefined {
    if (isGlobalAdmin(req)) return 'owner';
    const uid = sessionUser(req)?.id;
    return uid ? deps.orgs.memberRole(orgId, uid) : undefined;
  }

  const canManage = (role?: OrgRole) => role === 'owner' || role === 'admin';

  r.get('/', (req: Request, res: Response) => {
    const user = sessionUser(req);
    const uid = user?.id;
    if (!uid) return fail(res, 401, 'Unauthorized');
    // Self-heal: every operator always belongs to at least one org. Boot backfill
    // only covers users present at boot, so a user created later (or a fresh install
    // whose backfill was skipped) would otherwise see none. Lazily join them to the
    // default org on first read.
    if (deps.orgs.listForUser(uid).length === 0) {
      const def = deps.orgs.ensureDefaultOrg();
      deps.orgs.addMember(def.id, uid, user?.role === 'owner' ? 'owner' : 'member');
    }
    // A global owner or admin sees every org (each annotated with their own role if any).
    if (isGlobalAdmin(req)) {
      const mine = new Map(deps.orgs.listForUser(uid).map(o => [o.id, o]));
      const all = deps.orgs.listAllOrgs().map(o => mine.get(o.id) ?? {
        ...o, role: 'owner' as OrgRole, projectCount: deps.orgs.projectsOfOrg(o.id).length,
      });
      return ok(res, all);
    }
    return ok(res, deps.orgs.listForUser(uid));
  });

  r.post('/', (req: Request, res: Response) => {
    const uid = sessionUser(req)?.id;
    if (!uid) return fail(res, 401, 'Unauthorized');
    const name = String(req.body?.name ?? '').trim();
    if (!name) return fail(res, 400, 'name is required');
    return ok(res, deps.orgs.createOrg(name, uid));
  });

  // Guard for org-scoped routes: 404 unknown org, 403 non-member.
  const requireOrgMember: RequestHandler = (req, res, next) => {
    const org = deps.orgs.getOrg(req.params.id);
    if (!org) return fail(res, 404, 'organization not found');
    if (!authority(req, org.id)) return fail(res, 403, 'not a member of this organization');
    next();
  };

  r.get('/:id', requireOrgMember, (req: Request, res: Response) => {
    const org = deps.orgs.getOrg(req.params.id)!;
    return ok(res, { ...org, role: authority(req, org.id), projectCount: deps.orgs.projectsOfOrg(org.id).length });
  });

  r.patch('/:id', requireOrgMember, (req: Request, res: Response) => {
    if (!canManage(authority(req, req.params.id))) return fail(res, 403, 'requires org admin');
    const name = String(req.body?.name ?? '').trim();
    if (!name) return fail(res, 400, 'name is required');
    return ok(res, deps.orgs.renameOrg(req.params.id, name));
  });

  r.delete('/:id', requireOrgMember, (req: Request, res: Response) => {
    if (authority(req, req.params.id) !== 'owner') return fail(res, 403, 'requires org owner');
    const result = deps.orgs.deleteOrg(req.params.id);
    if (!result.ok) return fail(res, 409, result.reason ?? 'cannot delete');
    return ok(res, { deleted: true });
  });

  r.get('/:id/members', requireOrgMember, async (req: Request, res: Response) => {
    const members = deps.orgs.listMembers(req.params.id);
    // Join with the console user store for email/global-role display.
    const all = await deps.users.list().catch(() => []);
    const byId = new Map(all.map(u => [u.id, u]));
    return ok(res, members.map(m => ({
      userId: m.userId,
      role: m.role,
      createdAt: m.createdAt,
      email: byId.get(m.userId)?.email ?? null,
    })));
  });

  r.post('/:id/members', requireOrgMember, async (req: Request, res: Response) => {
    if (!canManage(authority(req, req.params.id))) return fail(res, 403, 'requires org admin');
    const userId = String(req.body?.userId ?? '').trim();
    const role = (['owner', 'admin', 'member'].includes(req.body?.role) ? req.body.role : 'member') as OrgRole;
    if (!userId) return fail(res, 400, 'userId is required');
    // Adding an existing member changes their role, which must not demote the only owner.
    if (role !== 'owner' && deps.orgs.isLastOwner(req.params.id, userId)) return fail(res, 409, 'cannot demote the last owner');
    const user = await deps.users.findById(userId).catch(() => undefined);
    if (!user) return fail(res, 404, 'user not found');
    deps.orgs.addMember(req.params.id, userId, role);
    return ok(res, { userId, role });
  });

  r.delete('/:id/members/:userId', requireOrgMember, (req: Request, res: Response) => {
    if (!canManage(authority(req, req.params.id))) return fail(res, 403, 'requires org admin');
    const result = deps.orgs.removeMember(req.params.id, req.params.userId);
    if (!result.ok) return fail(res, 409, result.reason ?? 'cannot remove');
    return ok(res, { removed: true });
  });

  // ── Org-wide AI assistant key ──────────────────────────────────────────────
  //
  // One key for every project the org owns. A project that sets its own key in
  // its `ai.assistant` settings still wins; this is the default the others
  // inherit. Reading it is a member right (the console shows which provider the
  // assistant runs on), limited to the projects the caller can already see.
  // Changing it writes a secret into, and recreates the API container of, every
  // project in the org, so it takes an org admin who also holds secrets.manage:
  // a developer scoped to one project must not restart the other seven.

  const canManageAi = (req: Request) => {
    const user = sessionUser(req);
    return Boolean(user && hasCapability(user.role, 'secrets.manage') && canManage(authority(req, req.params.id)));
  };

  r.get('/:id/ai', requireOrgMember, (req: Request, res: Response) => {
    if (!deps.orgAi) return fail(res, 501, 'organization AI configuration is not available');
    const user = sessionUser(req)!;
    const view = deps.orgAi.view(req.params.id);
    return ok(res, {
      ...view,
      projects: view.projects.filter(project => hasProjectScope(user.role, user.projects, project)),
      canManage: canManageAi(req),
    });
  });

  r.put('/:id/ai', requireOrgMember, async (req: Request, res: Response) => {
    if (!deps.orgAi) return fail(res, 501, 'organization AI configuration is not available');
    if (!canManageAi(req)) return fail(res, 403, 'requires org admin with secrets.manage');
    let input;
    try {
      input = validateOrgAiConfig(req.body);
    } catch (error: unknown) {
      return fail(res, 400, (error as Error).message);
    }
    const { view, failed } = await deps.orgAi.save(req.params.id, input);
    return ok(res, { ...view, failed });
  });

  r.delete('/:id/ai', requireOrgMember, async (req: Request, res: Response) => {
    if (!deps.orgAi) return fail(res, 501, 'organization AI configuration is not available');
    if (!canManageAi(req)) return fail(res, 403, 'requires org admin with secrets.manage');
    const { failed } = await deps.orgAi.clear(req.params.id);
    return ok(res, { ...deps.orgAi.view(req.params.id), failed });
  });

  return r;
}
