import type { Request, Response, Router } from 'express';
import { ZodError } from 'zod';
import { errorMessage } from '../../../lib/errors';
import { SLUG_RE } from '../../../constants/regex.constants';
import { sessionUser } from '../../auth/session';
import { hasProjectScope, requireCapability, requireProjectCapability } from '../../auth/capabilities';
import { HttpError } from '../../helpers/http-error';
import { fail, ok } from '../../helpers/respond';
import { projectConfigError, projectConfigPatchSchema, resolveProjectConfig, type CreateProjectInput } from '../../lib/manifest';
import { resolveUpstream } from '../proxy.routes';
import type { PlatformDeps } from './deps';
import { guarded, requireKnownProject } from './handlers';
import { hostLimitBounds, validateLimitsPatch } from './limits';

const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart', 'update', 'rebuild'] as const;

const projectName = (p: any): string => p?.name ?? p?.id;

/** Every project the caller may see, annotated with its org, optionally narrowed to one org. */
async function listVisibleProjects(deps: PlatformDeps, req: Request) {
  const all = await deps.registry.list();
  if (!Array.isArray(all)) return all;
  const user = sessionUser(req);
  const orgId = typeof req.query.org === 'string' ? req.query.org : undefined;
  let visible = all.map((p: any) => ({ ...p, orgId: deps.orgs?.orgOfProject(projectName(p)) }));
  // Scope to a chosen org, but only if the caller belongs to it (global
  // owner/admin bypass, mirroring the rest of the platform authorization model).
  if (orgId && deps.orgs) {
    const member = user && (user.role === 'owner' || user.role === 'admin' || deps.orgs.isMember(orgId, user.id));
    if (!member) throw new HttpError(403, 'not a member of this organization');
    visible = visible.filter((p: any) => p.orgId === orgId);
  }
  // Owner/admin are global; every other role is scoped to assigned projects.
  if (user) visible = visible.filter((p: any) => hasProjectScope(user.role, user.projects, projectName(p)));
  return visible;
}

/**
 * Resolve the target org up front so we never create a project we then can't
 * place. An explicit org must exist and (unless the caller is a global owner)
 * include the caller; no org falls back to the default.
 */
function resolveTargetOrg(deps: PlatformDeps, req: Request, orgId: string | undefined): string | undefined {
  if (!deps.orgs) return undefined;
  if (!orgId) return deps.orgs.ensureDefaultOrg().id;
  if (!deps.orgs.getOrg(orgId)) throw new HttpError(400, 'unknown organization');
  const user = sessionUser(req);
  if (user && user.role !== 'owner' && !deps.orgs.isMember(orgId, user.id)) {
    throw new HttpError(403, 'not a member of this organization');
  }
  return orgId;
}

/**
 * A new project inherits its org's AI key straight away, so the assistant
 * works on first open instead of after someone notices it is the one project
 * in the org without a key. Best effort: the project exists and is running
 * either way, and the org settings page can push again.
 */
async function seedOrgAiKey(deps: PlatformDeps, name: string, orgId: string): Promise<void> {
  await deps.orgAi?.applyToProject(name, orgId).catch(() => {
    deps.logs?.push({ level: 'warn', source: 'platform', message: `could not seed the organization AI key into ${name}` });
  });
}

function assertValidProjectConfig(deps: PlatformDeps, body: CreateProjectInput): void {
  try {
    resolveProjectConfig(body, {
      scheme: deps.cfg.mode === 'dev' ? 'http' : 'https',
      domainSuffix: deps.cfg.domainSuffix,
      apiImage: deps.cfg.apiImage,
      certResolver: deps.cfg.certResolver,
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new HttpError(400, projectConfigError(error));
    throw error;
  }
}

async function createProject(deps: PlatformDeps, req: Request, res: Response) {
  const { name, domain, orgId } = req.body ?? {};
  if (!SLUG_RE.test(name ?? '')) return fail(res, 400, 'invalid project name');
  if (!domain && deps.cfg.mode !== 'dev') return fail(res, 400, 'domain is required');

  assertValidProjectConfig(deps, req.body ?? {});
  const targetOrgId = resolveTargetOrg(deps, req, orgId);
  if (await deps.registry.get(name)) return fail(res, 409, 'project already exists');

  let created;
  try {
    created = await deps.orchestrator.create(req.body);
  } catch (error: unknown) {
    // create() already rolled the project back, so the name is free again.
    // The Docker detail goes to the logs only, like every internal error.
    deps.logs?.push({ level: 'error', source: 'console', message: `create project ${name} failed: ${errorMessage(error)}` });
    return fail(res, 500, 'Project creation failed and was cleaned up, so the name can be retried. The cause is in Platform logs.');
  }
  if (targetOrgId) {
    deps.orgs?.assignProject(name, targetOrgId);
    await seedOrgAiKey(deps, name, targetOrgId);
  }
  return ok(res, created);
}

export function registerProjectRoutes(r: Router, deps: PlatformDeps): void {
  const knownProject = requireKnownProject(deps);

  r.get('/projects', guarded(deps, async (req, res) => ok(res, await listVisibleProjects(deps, req))));

  r.post('/projects', requireCapability('project.create'), guarded(deps, (req, res) => createProject(deps, req, res)));

  for (const action of LIFECYCLE_ACTIONS) {
    r.post(`/projects/:id/${action}`, requireProjectCapability('runtime.manage'), knownProject, guarded(deps, async (req, res) => {
      await deps.orchestrator[action](req.params.id);
      return ok(res, { name: req.params.id, action });
    }));
  }

  r.get('/projects/:id/dns', requireProjectCapability('project.read'), knownProject, guarded(deps, async (_req, res) =>
    ok(res, { checks: await deps.diagnostics?.projectDns(res.locals.project) ?? [] }),
  ));

  /**
   * Can the console talk to this project's API yet?
   *
   * A project exists on disk the moment it is created, and its containers come
   * up well before the API inside them has finished migrating and can answer.
   * Between those two points every request the Studio makes is proxied to a
   * container that is not listening, which is where the burst of 502s on a
   * freshly created project came from.
   *
   * This is the same probe the proxy already runs to pick an upstream, so it
   * shares that cache (10s once ready, 2s while unreachable) and costs nothing
   * to poll. `status` is the container state; `ready` is the only thing worth
   * gating on, because a running container is not a listening API.
   */
  r.get('/projects/:id/ready', requireProjectCapability('project.read'), knownProject, guarded(deps, async (req, res) => {
    const status = res.locals.project.status ?? 'stopped';
    // Never probe a project that is not running: the answer is known, and the
    // probe would just burn its timeout on every poll.
    if (status !== 'running') return ok(res, { ready: false, status });
    const { ready } = await resolveUpstream(deps.registry, req.params.id, deps.probe);
    return ok(res, { ready, status });
  }));

  r.get('/projects/:id/shell', requireProjectCapability('runtime.manage'), knownProject, guarded(deps, (req, res) =>
    ok(res, deps.orchestrator.shell(req.params.id, String(req.query.service || 'api'))),
  ));

  r.get('/projects/:id/logs', requireProjectCapability('project.read'), knownProject, guarded(deps, async (req, res) => {
    const { stdout, stderr } = await deps.orchestrator.logsFor(req.params.id);
    return ok(res, { stdout, stderr });
  }));

  r.get('/projects/:id/config', requireProjectCapability('project.read'), knownProject, guarded(deps, async (req, res) =>
    ok(res, await deps.orchestrator.readConfig(req.params.id)),
  ));

  r.patch('/projects/:id/config', requireProjectCapability('settings.write'), knownProject, guarded(deps, async (req, res) => {
    const parsed = projectConfigPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, projectConfigError(parsed.error));
    return ok(res, await deps.orchestrator.writeConfig(req.params.id, parsed.data));
  }));

  r.get('/projects/:id/limits', requireProjectCapability('project.read'), knownProject, guarded(deps, async (req, res) =>
    ok(res, await deps.orchestrator.readLimits(req.params.id)),
  ));

  r.patch('/projects/:id/limits', requireProjectCapability('settings.write'), knownProject, guarded(deps, async (req, res) => {
    const { patch, error } = validateLimitsPatch(req.body ?? {}, await hostLimitBounds(deps.metrics));
    if (error) return fail(res, 400, error);
    return ok(res, await deps.orchestrator.writeLimits(req.params.id, patch));
  }));

  r.delete('/projects/:id', requireProjectCapability('project.delete'), knownProject, guarded(deps, async (req, res) => {
    if (req.body?.confirm !== req.params.id) return fail(res, 400, 'type the project name to confirm');
    if (await deps.branches?.hasBranches(req.params.id)) {
      return fail(res, 409, 'this project has preview branches; delete them first');
    }
    await deps.orchestrator.destroy(req.params.id);
    deps.orgs?.unassignProject(req.params.id);
    return ok(res, { name: req.params.id, action: 'destroy' });
  }));
}
