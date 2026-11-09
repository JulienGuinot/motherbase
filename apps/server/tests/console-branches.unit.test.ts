import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { branchDomain, branchProjectName, effectiveBranchStatus, migrationDiff, type MigrationRecord } from '../console/lib/branches';
import { BranchService } from '../console/services/branch.service';
import { projectHostingRouter } from '../console/routes/project-hosting.routes';
import { DEFAULT_LIMITS, type BranchInfo } from '../console/lib/manifest';

const migration = (name: string, appliedAt: string, checksum = `sum-${name}`): MigrationRecord => ({
  id: `id-${name}`, name, upSql: `-- ${name}`, downSql: null, checksum, status: 'applied', appliedAt,
});

describe('branch naming', () => {
  it('derives a DNS-safe slug from a git branch name', () => {
    expect(branchProjectName('shop', 'feature/Login-Form')).toBe('shop-feature-login-form');
    expect(branchProjectName('shop', 'x'.repeat(80))).toHaveLength(63);
    expect(() => branchProjectName('shop', '///')).toThrow(/letter or digit/);
    // "ab--" would read as an IDNA label, which certificate authorities refuse.
    expect(() => branchProjectName('ab', '-x')).not.toThrow();
  });

  it('moves the parent domain to the branch', () => {
    expect(branchDomain('shop.example.com', 'shop', 'shop-dev')).toBe('shop-dev.example.com');
    expect(branchDomain('api.example.com', 'shop', 'shop-dev')).toBe('api-dev.example.com');
  });
});

describe('migrationDiff', () => {
  it('finds what a merge and a rebase must replay, in applied order', () => {
    const base = [migration('init', '2026-01-01')];
    const parent = [...base, migration('parent-only', '2026-03-01')];
    const branch = [migration('branch-2', '2026-02-02'), ...base, migration('branch-1', '2026-02-01')];
    const { ahead, behind } = migrationDiff(parent, branch);
    expect(ahead.map(m => m.name)).toEqual(['branch-1', 'branch-2']);
    expect(behind.map(m => m.name)).toEqual(['parent-only']);
  });

  it('treats an edited migration as a different one', () => {
    const { ahead, behind } = migrationDiff([migration('init', '2026-01-01')], [migration('init', '2026-01-01', 'edited')]);
    expect([ahead.length, behind.length]).toEqual([1, 1]);
  });

  it('ignores migrations that were never applied', () => {
    const pending = { ...migration('draft', '2026-01-01'), status: 'pending', appliedAt: null };
    expect(migrationDiff([], [pending]).ahead).toEqual([]);
  });
});

describe('effectiveBranchStatus', () => {
  const info = { status: 'seeding' } as BranchInfo;
  it('reports a job nobody is running any more as failed', () => {
    expect(effectiveBranchStatus(info, true).status).toBe('seeding');
    expect(effectiveBranchStatus(info, false)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) });
  });
});

/** A registry + orchestrator pair backed by one in-memory project list. */
function fakes(migrations: Record<string, MigrationRecord[]>) {
  const projects = new Map<string, any>([
    ['shop', { name: 'shop', domain: 'shop.example.com', status: 'running', createdAt: '2026-01-01' }],
  ]);
  const registry = {
    list: vi.fn(async () => [...projects.values()]),
    get: vi.fn(async (name: string) => projects.get(name)),
  };
  const orchestrator = {
    create: vi.fn(async (input: any) => {
      projects.set(input.name, { name: input.name, domain: input.domain, status: 'running', createdAt: 'now', branch: input.branch });
    }),
    destroy: vi.fn(async (name: string) => void projects.delete(name)),
    start: vi.fn(), stop: vi.fn(),
    readConfig: vi.fn(async () => ({ domain: 'shop.example.com', apiImage: 'img', certResolver: 'le' })),
    readLimits: vi.fn(async () => ({ ...DEFAULT_LIMITS })),
    readEnvVar: vi.fn(async () => 'parent-key'),
    updateBranchInfo: vi.fn(async (name: string, patch: any) => {
      const project = projects.get(name);
      project.branch = { ...project.branch, ...patch };
      return project.branch;
    }),
  };
  const calls: string[] = [];
  const admin = {
    ready: vi.fn(async () => true),
    request: vi.fn(async (project: string, method: string, path: string, body?: any) => {
      calls.push(`${project} ${method} ${path}`);
      if (method === 'GET' && path === '/migrations') return { migrations: migrations[project] ?? [] };
      if (method === 'POST' && path === '/migrations') {
        (migrations[project] ??= []).push({ ...migration(body.name, new Date().toISOString()), checksum: `sum-${body.name}` });
        return { migration: { id: `new-${body.name}` } };
      }
      if (method === 'POST' && path === '/backups') return { file: { name: body.file } };
      return {};
    }),
    download: vi.fn(async () => Buffer.from('dump')),
    upload: vi.fn(async () => 'motherbase-uploaded-1.sql'),
  };
  const service = new BranchService({ registry, orchestrator, admin: admin as any, pollMs: 1 });
  const settle = () => vi.waitFor(() => expect(projects.get('shop-dev')?.branch?.status).toMatch(/active|failed/));
  return { service, projects, orchestrator, admin, calls, settle };
}

describe('BranchService', () => {
  it('cuts a branch from the parent migration history, not its data', async () => {
    const { service, orchestrator, calls, settle, projects } = fakes({ shop: [migration('init', '2026-01-01')] });
    const created = await service.create('shop', { name: 'dev' });
    expect(created).toMatchObject({ project: 'shop-dev', status: 'creating', domain: 'shop-dev.example.com' });
    await settle();
    expect(projects.get('shop-dev').branch.status).toBe('active');
    expect(orchestrator.create.mock.calls[0][0]).not.toHaveProperty('configEncryptionKey');
    expect(calls).toContain('shop-dev POST /migrations');
    expect(calls).toContain('shop-dev POST /migrations/new-init/apply');
    expect(calls.some(c => c.includes('/backups'))).toBe(false);

    const list = await service.list('shop');
    expect(list.map(b => [b.name, b.isDefault])).toEqual([['main', true], ['dev', false]]);
    // Asked from the branch, the answer is the same family.
    expect(await service.list('shop-dev')).toEqual(list);
  });

  it('copies data through a clean dump and inherits the encryption key', async () => {
    const { service, orchestrator, admin, calls, settle } = fakes({ shop: [] });
    await service.create('shop', { name: 'dev', withData: true });
    await settle();
    expect(orchestrator.create.mock.calls[0][0]).toMatchObject({ configEncryptionKey: 'parent-key' });
    expect(admin.request).toHaveBeenCalledWith('shop', 'POST', '/backups', expect.objectContaining({ clean: true }));
    expect(calls).toContain('shop-dev POST /backups/restore');
  });

  it('refuses to merge a branch that is behind, and replays only what is new', async () => {
    const history = { shop: [migration('init', '2026-01-01')], 'shop-dev': [] as MigrationRecord[] };
    const { service, settle, calls } = fakes(history);
    await service.create('shop', { name: 'dev' });
    await settle();

    history.shop.push(migration('hotfix', '2026-05-01'));
    history['shop-dev'].push(migration('feature', '2026-04-01'));
    await expect(service.merge('shop', 'dev')).rejects.toThrow(/behind shop; rebase/);

    await service.rebase('shop', 'dev');
    calls.length = 0;
    const merged = await service.merge('shop', 'dev');
    expect(merged.applied).toEqual(['feature']);
    expect(calls).toEqual(expect.arrayContaining(['shop POST /migrations', 'shop POST /migrations/new-feature/apply']));
  });

  it('will not branch a branch, and names the conflict on a duplicate', async () => {
    const { service, settle } = fakes({ shop: [] });
    await service.create('shop', { name: 'dev' });
    await settle();
    await expect(service.create('shop-dev', { name: 'x' })).rejects.toThrow(/itself a branch/);
    await expect(service.create('shop', { name: 'DEV' })).rejects.toThrow(/already exists/);
  });
});

describe('project hosting routes', () => {
  function app(role: string) {
    const server = express();
    server.use(express.json());
    const { service } = fakes({ shop: [] });
    server.use('/api/platform', projectHostingRouter({
      branches: service,
      domains: {} as never,
      registry: { get: async (name: string) => (name === 'shop' ? { name } : undefined) },
      requireSession: (req: Request, _res: Response, next: NextFunction) => {
        (req as any).user = { id: 'u', email: 'u@x', role, projects: ['shop'] };
        next();
      },
    }));
    return server;
  }

  it('answers 404 for an unknown project and 403 for a role that cannot create stacks', async () => {
    expect((await request(app('owner')).get('/api/platform/projects/nope/branches')).status).toBe(404);
    expect((await request(app('developer')).post('/api/platform/projects/shop/branches').send({ name: 'x' })).status).toBe(403);
    const listed = await request(app('read_only')).get('/api/platform/projects/shop/branches');
    expect(listed.status).toBe(200);
    expect(listed.body.data[0]).toMatchObject({ name: 'main', isDefault: true });
  });

  it('turns a service refusal into its status and message', async () => {
    const res = await request(app('owner')).post('/api/platform/projects/shop/branches').send({ name: '///' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/letter or digit/);
  });
});
