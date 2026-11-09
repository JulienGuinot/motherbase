import { z } from 'zod';
import { errorMessage } from '../../lib/errors';
import { HttpError } from '../helpers/http-error';
import type { LogBuffer } from '../../lib/log-buffer';
import type { BranchInfo, ResourceLimits } from '../lib/manifest';
import {
  branchDomain,
  branchProjectName,
  effectiveBranchStatus,
  migrationDiff,
  type MigrationRecord,
} from '../lib/branches';
import type { ProjectAdminClient } from './project-admin.client';
import type { OrgStore } from './org-store';
import type { ProjectSummary as RegistryProject } from './registry.service';

export const createBranchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    gitBranch: z.string().trim().max(255).optional(),
    /** Copy the parent's rows too. Off by default, as on Supabase: branches start from migrations. */
    withData: z.boolean().default(false),
  })
  .strict();

export const updateBranchSchema = z
  .object({ gitBranch: z.string().trim().max(255).optional() })
  .strict();

/** The fields of a registry entry that branching reads. */
type ProjectSummary = Pick<RegistryProject, 'name' | 'domain' | 'status' | 'createdAt' | 'branch'>;

interface Deps {
  registry: { list(): Promise<ProjectSummary[]>; get(name: string): Promise<ProjectSummary | undefined> };
  orchestrator: {
    create(input: Record<string, unknown>): Promise<unknown>;
    destroy(name: string): Promise<void>;
    start(name: string): Promise<unknown>;
    stop(name: string): Promise<unknown>;
    readConfig(name: string): Promise<{ domain: string; apiImage: string; certResolver: string }>;
    readLimits(name: string): Promise<ResourceLimits>;
    readEnvVar(name: string, key: string): Promise<string | undefined>;
    updateBranchInfo(name: string, patch: Partial<BranchInfo>): Promise<BranchInfo>;
  };
  admin: ProjectAdminClient;
  orgs?: OrgStore;
  logs?: LogBuffer;
  /** How long a new stack may take to answer before the branch is marked failed. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

/** The shape every branch endpoint answers with, Supabase's branch fields where they map. */
export interface BranchView {
  id: string;
  name: string;
  project: string;
  parent: string;
  isDefault: boolean;
  gitBranch: string | null;
  withData: boolean;
  status: BranchInfo['status'] | 'active';
  error: string | null;
  running: boolean;
  domain: string;
  createdAt: string;
  mergedAt: string | null;
}

/**
 * Preview branches: a branch is a project of its own (own stack, database,
 * storage, domain), cut from a parent and linked back to it through its
 * manifest's `branch` record.
 *
 * Schema travels as migration history, as it does on Supabase: the parent's
 * applied migrations are replayed onto the branch, and merging replays the
 * branch's new ones onto the parent. `withData` copies the whole database
 * instead, through the parent's own backup (a `--clean` dump restored over the
 * branch's freshly migrated schema).
 *
 * Creating and resetting take minutes (a stack coming up, a dump restoring),
 * so they run in the background; the branch's status says where they are.
 */
export class BranchService {
  /** Branches whose create/reset job is running in this process. */
  private jobs = new Set<string>();

  constructor(private deps: Deps) {}

  private log(level: 'info' | 'error', message: string) {
    this.deps.logs?.push({ level, source: 'branches', message });
  }

  private view(project: ProjectSummary): BranchView {
    const info = project.branch;
    if (!info) {
      return {
        id: project.name, name: 'main', project: project.name, parent: project.name, isDefault: true,
        gitBranch: null, withData: true, status: 'active', error: null, running: project.status === 'running',
        domain: project.domain, createdAt: project.createdAt, mergedAt: null,
      };
    }
    const { status, error } = effectiveBranchStatus(info, this.jobs.has(project.name));
    return {
      id: project.name, name: info.name, project: project.name, parent: info.parent, isDefault: false,
      gitBranch: info.gitBranch ?? null, withData: info.withData, status, error: error ?? null,
      running: project.status === 'running', domain: project.domain, createdAt: info.createdAt,
      mergedAt: info.mergedAt ?? null,
    };
  }

  private async parentOf(id: string): Promise<ProjectSummary> {
    const project = await this.deps.registry.get(id);
    if (!project) throw new HttpError(404, 'project not found');
    if (project.branch) throw new HttpError(400, `${id} is itself a branch of ${project.branch.parent}; branch from the parent`);
    return project;
  }

  /** A branch of `parent`, by project slug or by display name. */
  private async branchOf(parent: string, ref: string): Promise<ProjectSummary> {
    const branch = (await this.deps.registry.list()).find(
      p => p.branch?.parent === parent && (p.name === ref || p.branch.name === ref),
    );
    if (!branch) throw new HttpError(404, `no branch ${ref} on ${parent}`);
    return branch;
  }

  /**
   * The default branch (the parent itself) first, then its branches oldest
   * first. Asked of a branch, answers for its parent: that is the list a
   * branch switcher open on the branch needs.
   */
  async list(id: string): Promise<BranchView[]> {
    const project = await this.deps.registry.get(id);
    if (!project) throw new HttpError(404, 'project not found');
    const parent = project.branch?.parent ?? id;
    const main = await this.parentOf(parent);
    const branches = (await this.deps.registry.list())
      .filter(p => p.branch?.parent === parent)
      .sort((a, b) => a.branch!.createdAt.localeCompare(b.branch!.createdAt));
    return [this.view(main), ...branches.map(b => this.view(b))];
  }

  async get(parent: string, ref: string) {
    await this.parentOf(parent);
    const branch = await this.branchOf(parent, ref);
    const view = this.view(branch);
    // Ahead/behind is only answerable while both APIs are up.
    const diff = view.status === 'active' && view.running
      ? await this.diff(parent, branch.name).catch(() => null)
      : null;
    return { ...view, migrations: diff && { ahead: diff.ahead.map(m => m.name), behind: diff.behind.map(m => m.name) } };
  }

  async create(parent: string, input: unknown): Promise<BranchView> {
    const parsed = createBranchSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => i.message).join('; '));
    const main = await this.parentOf(parent);
    let slug: string;
    try {
      slug = branchProjectName(parent, parsed.data.name);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
    if (this.jobs.has(slug) || (await this.deps.registry.get(slug))) {
      throw new HttpError(409, `a project named ${slug} already exists`);
    }
    const info: BranchInfo = {
      parent,
      name: parsed.data.name,
      ...(parsed.data.gitBranch ? { gitBranch: parsed.data.gitBranch } : {}),
      withData: parsed.data.withData,
      status: 'creating',
      createdAt: new Date().toISOString(),
    };
    const domain = branchDomain(main.domain, parent, slug);
    this.runJob(slug, () => this.provision(slug, domain, info));
    return {
      ...this.view({ name: slug, domain, status: 'stopped', createdAt: info.createdAt, branch: info }),
      status: 'creating',
    };
  }

  /** Fire-and-forget with the bookkeeping every background job needs. */
  private runJob(slug: string, job: () => Promise<void>) {
    this.jobs.add(slug);
    void job()
      .catch(async error => {
        this.log('error', `branch ${slug} failed: ${errorMessage(error)}`);
        await this.deps.orchestrator.updateBranchInfo(slug, { status: 'failed', error: errorMessage(error) }).catch(() => undefined);
      })
      .finally(() => this.jobs.delete(slug));
  }

  private async provision(slug: string, domain: string, info: BranchInfo): Promise<void> {
    const { parent } = info;
    const [config, limits] = await Promise.all([
      this.deps.orchestrator.readConfig(parent),
      this.deps.orchestrator.readLimits(parent),
    ]);
    const configEncryptionKey = info.withData
      ? await this.deps.orchestrator.readEnvVar(parent, 'CONFIG_ENCRYPTION_KEY')
      : undefined;
    this.log('info', `creating branch ${slug} of ${parent}${info.withData ? ' with data' : ''}`);
    await this.deps.orchestrator.create({
      name: slug,
      domain,
      apiImage: config.apiImage,
      certResolver: config.certResolver,
      limits,
      branch: info,
      ...(configEncryptionKey ? { configEncryptionKey } : {}),
    });
    const orgId = this.deps.orgs?.orgOfProject(parent);
    if (orgId) this.deps.orgs?.assignProject(slug, orgId);
    await this.deps.orchestrator.updateBranchInfo(slug, { status: 'seeding' });
    await this.seed(slug, info);
    await this.deps.orchestrator.updateBranchInfo(slug, { status: 'active', error: undefined });
    this.log('info', `branch ${slug} is ready`);
  }

  private async waitReady(project: string): Promise<void> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? 5 * 60_000);
    while (!(await this.deps.admin.ready(project))) {
      if (Date.now() > deadline) throw new Error(`${project} did not answer in time`);
      await new Promise(resolve => setTimeout(resolve, this.deps.pollMs ?? 3_000));
    }
  }

  private async seed(slug: string, info: BranchInfo): Promise<void> {
    await Promise.all([this.waitReady(info.parent), this.waitReady(slug)]);
    if (info.withData) await this.copyData(info.parent, slug);
    else await this.replay(slug, (await this.migrations(info.parent)).filter(m => m.status === 'applied'));
  }

  private async copyData(from: string, to: string): Promise<void> {
    const name = `motherbase-branch-${to}-${Date.now()}.sql`;
    const { file } = await this.deps.admin.request<{ file: { name: string } }>(from, 'POST', '/backups', { file: name, clean: true });
    const stored = await this.deps.admin.upload(to, await this.deps.admin.download(from, file.name), name);
    await this.deps.admin.request(to, 'POST', '/backups/restore', { file: stored, confirm: 'RESTORE' });
  }

  private async migrations(project: string): Promise<MigrationRecord[]> {
    return (await this.deps.admin.request<{ migrations: MigrationRecord[] }>(project, 'GET', '/migrations')).migrations;
  }

  /**
   * Create and apply each migration on the target, in order. Each apply is
   * its own transaction on the target, so a failure stops the replay with
   * everything before it applied and nothing of the failed one.
   */
  private async replay(target: string, migrations: MigrationRecord[]): Promise<string[]> {
    const done: string[] = [];
    for (const migration of [...migrations].sort((a, b) => Date.parse(a.appliedAt ?? '') - Date.parse(b.appliedAt ?? ''))) {
      const { migration: created } = await this.deps.admin.request<{ migration: { id: string } }>(target, 'POST', '/migrations', {
        name: migration.name,
        upSql: migration.upSql,
        downSql: migration.downSql,
      });
      try {
        await this.deps.admin.request(target, 'POST', `/migrations/${encodeURIComponent(created.id)}/apply`);
      } catch (error) {
        throw new HttpError(409, `${migration.name} failed on ${target} after ${done.length} applied: ${errorMessage(error)}`);
      }
      done.push(migration.name);
    }
    return done;
  }

  private async diff(parent: string, slug: string) {
    const [onParent, onBranch] = await Promise.all([this.migrations(parent), this.migrations(slug)]);
    return migrationDiff(onParent, onBranch);
  }

  private async activeBranch(parent: string, ref: string): Promise<ProjectSummary> {
    await this.parentOf(parent);
    const branch = await this.branchOf(parent, ref);
    const view = this.view(branch);
    if (view.status !== 'active') throw new HttpError(409, `branch ${view.name} is ${view.status}`);
    if (!view.running) throw new HttpError(409, `branch ${view.name} is paused; unpause it first`);
    return branch;
  }

  /**
   * Apply the branch's new migrations to the parent. Refused while the parent
   * has migrations the branch lacks: the branch's were written against a
   * schema the parent no longer has, and replaying them blind is how a merge
   * breaks production. Rebase first.
   */
  async merge(parent: string, ref: string) {
    const branch = await this.activeBranch(parent, ref);
    const { ahead, behind } = await this.diff(parent, branch.name);
    if (behind.length) {
      throw new HttpError(409, `${branch.branch!.name} is ${behind.length} migration(s) behind ${parent}; rebase it first`);
    }
    const applied = await this.replay(parent, ahead);
    await this.deps.orchestrator.updateBranchInfo(branch.name, { mergedAt: new Date().toISOString() });
    return { ...this.view(branch), applied };
  }

  /** Bring the parent's newer migrations onto the branch. */
  async rebase(parent: string, ref: string) {
    const branch = await this.activeBranch(parent, ref);
    const { behind } = await this.diff(parent, branch.name);
    return { ...this.view(branch), applied: await this.replay(branch.name, behind) };
  }

  /** Throw the branch away and cut it again from the parent as it is now. */
  async reset(parent: string, ref: string): Promise<BranchView> {
    const main = await this.parentOf(parent);
    const branch = await this.branchOf(parent, ref);
    if (this.jobs.has(branch.name)) throw new HttpError(409, `branch ${branch.branch!.name} is still being prepared`);
    const info: BranchInfo = { ...branch.branch!, status: 'creating', error: undefined, mergedAt: undefined, createdAt: new Date().toISOString() };
    this.runJob(branch.name, async () => {
      await this.deps.orchestrator.destroy(branch.name);
      await this.provision(branch.name, branchDomain(main.domain, parent, branch.name), info);
    });
    return { ...this.view({ ...branch, branch: info }), status: 'creating' };
  }

  async update(parent: string, ref: string, input: unknown): Promise<BranchView> {
    const parsed = updateBranchSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => i.message).join('; '));
    await this.parentOf(parent);
    const branch = await this.branchOf(parent, ref);
    const info = await this.deps.orchestrator.updateBranchInfo(branch.name, parsed.data);
    return this.view({ ...branch, branch: info });
  }

  async pause(parent: string, ref: string) {
    const branch = await this.branchOf(parent, ref);
    await this.deps.orchestrator.stop(branch.name);
    return this.view({ ...branch, status: 'stopped' });
  }

  async unpause(parent: string, ref: string) {
    const branch = await this.branchOf(parent, ref);
    await this.deps.orchestrator.start(branch.name);
    return this.view({ ...branch, status: 'running' });
  }

  async remove(parent: string, ref: string) {
    await this.parentOf(parent);
    const branch = await this.branchOf(parent, ref);
    if (this.jobs.has(branch.name)) throw new HttpError(409, `branch ${branch.branch!.name} is still being prepared`);
    await this.deps.orchestrator.destroy(branch.name);
    this.deps.orgs?.unassignProject(branch.name);
    return { id: branch.name, name: branch.branch!.name, deleted: true };
  }

  /** Branches keep a parent's name in theirs: deleting the parent first would orphan them. */
  async hasBranches(project: string): Promise<boolean> {
    return (await this.deps.registry.list()).some(p => p.branch?.parent === project);
  }
}
