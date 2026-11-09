import { describe, it, expect, vi } from 'vitest';
import express, {Request, Response, NextFunction} from 'express';
import request from 'supertest';
import { platformRouter } from '../console/routes/platform.routes';

function appWith(mode: 'dev' | 'prod', orchestrator: any, extras: any = {}) {
  const app = express();
  app.use(express.json());
  const registry = extras.registry ?? { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) };
  const user = extras.user ?? { id: 'u-owner', email: 'owner@example.com', role: 'owner', projects: [] };
  app.use(
    '/api/platform',
    platformRouter({
      orchestrator,
      registry,
      metrics: extras.metrics,
      diagnostics: extras.diagnostics,
      updates: extras.updates,
      logs: extras.logs,
      requireSession: (req: Request, _res: Response, next: NextFunction) => { (req as any).user = user; next(); },
      cfg: { mode, domainSuffix: mode === 'dev' ? 'localhost' : '' },
    } as any),
  );
  return app;
}

describe('platform routes', () => {
  it('rejects missing domain in prod', async () => {
    const app = appWith('prod', { create: vi.fn() });
    const res = await request(app).post('/api/platform/projects').send({ name: 'foo' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/domain is required/i);
  });

  it('allows missing domain in dev', async () => {
    const orchestrator = { create: vi.fn().mockResolvedValue({ name: 'foo', domain: 'foo.localhost' }) };
    const app = appWith('dev', orchestrator);
    const res = await request(app).post('/api/platform/projects').send({ name: 'foo' });
    expect(res.status).toBe(200);
    expect(orchestrator.create).toHaveBeenCalledWith({ name: 'foo' });
  });

  it('tells the user a failed create was cleaned up and logs the cause', async () => {
    const orchestrator = { create: vi.fn().mockRejectedValue(new Error('Orchestration operation failed: port is already allocated')) };
    const logs = { push: vi.fn() };
    const app = appWith('dev', orchestrator, { logs });
    const res = await request(app).post('/api/platform/projects').send({ name: 'foo' });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/cleaned up.*retried/);
    expect(res.body.message).not.toContain('port is already allocated');
    expect(logs.push).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('port is already allocated'),
    }));
  });

  it('GET /info reports mode, domainSuffix and optional surfaces', async () => {
    const app = appWith('dev', { create: vi.fn() });
    const res = await request(app).get('/api/platform/info');
    expect(res.status).toBe(200);
    // Billing defaults off. The studio reads this to decide whether the surface
    // exists at all, so a config that omits it must read as off, not undefined.
    expect(res.body.data).toEqual({ mode: 'dev', domainSuffix: 'localhost', features: { billing: false } });
  });

  it('GET /dns returns console DNS diagnostics', async () => {
    const diagnostics = { consoleDns: vi.fn().mockResolvedValue([{ name: 'console host', ok: true }]) };
    const app = appWith('dev', { create: vi.fn() }, { diagnostics });
    const res = await request(app).get('/api/platform/dns');
    expect(res.status).toBe(200);
    expect(res.body.data.checks[0].ok).toBe(true);
    expect(diagnostics.consoleDns).toHaveBeenCalled();
  });

  it('GET /projects/:id/shell returns the project shell command', async () => {
    const registry = { get: vi.fn().mockResolvedValue({ name: 'foo', domain: 'foo.localhost' }), list: vi.fn() };
    const orchestrator = { shell: vi.fn().mockReturnValue({ command: 'docker compose exec api sh' }) };
    const app = appWith('dev', orchestrator, { registry });
    const res = await request(app).get('/api/platform/projects/foo/shell');
    expect(res.status).toBe(200);
    expect(res.body.data.command).toContain('exec api sh');
  });

  it('DELETE /projects/:id destroys an existing project after confirmation', async () => {
    const registry = { get: vi.fn().mockResolvedValue({ name: 'foo', domain: 'foo.localhost' }), list: vi.fn() };
    const orchestrator = { destroy: vi.fn().mockResolvedValue(undefined) };
    const app = appWith('dev', orchestrator, { registry });

    const res = await request(app).delete('/api/platform/projects/foo').send({ confirm: 'foo' });

    expect(res.status).toBe(200);
    expect(orchestrator.destroy).toHaveBeenCalledWith('foo');
  });

  it('DELETE /projects/:id returns 404 when the project is unknown', async () => {
    const registry = { get: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const orchestrator = { destroy: vi.fn() };
    const app = appWith('dev', orchestrator, { registry });

    const res = await request(app).delete('/api/platform/projects/foo').send({ confirm: 'foo' });

    expect(res.status).toBe(404);
    expect(orchestrator.destroy).not.toHaveBeenCalled();
  });

  it('GET /update/plan returns the guided update plan', async () => {
    const updates = {
      check: vi.fn(),
      currentVersion: vi.fn().mockReturnValue('1.0.0'),
      plan: vi.fn().mockResolvedValue({
        current: '1.0.0', latest: '1.2.0', updateAvailable: true, configured: true,
        services: [{ name: 'console', from: '1.0.0', to: '1.2.0' }],
        commands: ['docker compose -f deploy/console/docker-compose.yml pull console orchestrator'],
        notes: ['note'],
      }),
    };
    const app = appWith('prod', { create: vi.fn() }, { updates });
    const res = await request(app).get('/api/platform/update/plan');
    expect(res.status).toBe(200);
    expect(res.body.data.updateAvailable).toBe(true);
    expect(res.body.data.commands[0]).toContain('docker compose');
    expect(updates.plan).toHaveBeenCalled();
  });

  it('GET /update/plan degrades gracefully when updates is absent', async () => {
    const app = appWith('prod', { create: vi.fn() });
    const res = await request(app).get('/api/platform/update/plan');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ updateAvailable: false, configured: false });
    expect(res.body.data.commands).toEqual([]);
  });
});

describe('project resource limits', () => {
  const existing = { get: vi.fn().mockResolvedValue({ name: 'foo', domain: 'foo.localhost' }), list: vi.fn() };

  it('GET /projects/:id/limits returns current limits', async () => {
    const limits = { apiCpus: 1, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256 };
    const orchestrator = { readLimits: vi.fn().mockResolvedValue(limits) };
    const app = appWith('dev', orchestrator, { registry: existing });
    const res = await request(app).get('/api/platform/projects/foo/limits');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(limits);
  });

  it('PATCH applies a valid patch and triggers a recreate', async () => {
    const applied = { apiCpus: 4, apiMemMb: 2048, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256 };
    const orchestrator = { writeLimits: vi.fn().mockResolvedValue(applied) };
    const app = appWith('dev', orchestrator, { registry: existing });
    const res = await request(app).patch('/api/platform/projects/foo/limits').send({ apiCpus: 4, apiMemMb: 2048 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(applied);
    expect(orchestrator.writeLimits).toHaveBeenCalledWith('foo', { apiCpus: 4, apiMemMb: 2048 });
  });

  it('PATCH applies only the provided services (partial patch)', async () => {
    const orchestrator = { writeLimits: vi.fn().mockResolvedValue({}) };
    const app = appWith('dev', orchestrator, { registry: existing });
    await request(app).patch('/api/platform/projects/foo/limits').send({ dbCpus: 2 });
    expect(orchestrator.writeLimits).toHaveBeenCalledWith('foo', { dbCpus: 2 });
  });

  it.each([
    ['cpus 0', { apiCpus: 0 }],
    ['negative cpus', { dbCpus: -1 }],
    ['mem below floor', { apiMemMb: 64 }],
    ['NaN cpus', { minioCpus: 'abc' }],
    ['disk below floor', { diskGb: 0 }],
    ['fractional disk', { diskGb: 10.5 }],
    ['disk larger than the server', { diskGb: 81 }],
  ])('PATCH rejects out-of-bounds input: %s', async (_label, body) => {
    const orchestrator = { writeLimits: vi.fn() };
    const metrics = { hostDisk: vi.fn().mockResolvedValue({ total: 80 * 1024 ** 3 }) };
    const app = appWith('dev', orchestrator, { registry: existing, metrics });
    const res = await request(app).patch('/api/platform/projects/foo/limits').send(body);
    expect(res.status).toBe(400);
    expect(orchestrator.writeLimits).not.toHaveBeenCalled();
  });

  it('PATCH accepts a disk quota up to the server disk', async () => {
    const orchestrator = { writeLimits: vi.fn().mockResolvedValue({}) };
    const metrics = { hostDisk: vi.fn().mockResolvedValue({ total: 80 * 1024 ** 3 }) };
    const app = appWith('dev', orchestrator, { registry: existing, metrics });
    const res = await request(app).patch('/api/platform/projects/foo/limits').send({ diskGb: 80 });
    expect(res.status).toBe(200);
    expect(orchestrator.writeLimits).toHaveBeenCalledWith('foo', { diskGb: 80 });
  });

  it('GET /disk joins each project quota in bytes', async () => {
    const registry = { get: vi.fn(), list: vi.fn().mockResolvedValue([{ name: 'foo' }, { name: 'bar' }]) };
    const orchestrator = {
      readLimits: vi.fn(async (name: string) => {
        if (name === 'bar') throw new Error('unreadable');
        return { diskGb: 10 };
      }),
    };
    const metrics = {
      disk: vi.fn().mockResolvedValue({
        host: null,
        measuredAt: null,
        projects: [{ project: 'foo', size: 1, volumes: [] }, { project: 'bar', size: 2, volumes: [] }],
      }),
    };
    const app = appWith('dev', orchestrator, { registry, metrics });
    const res = await request(app).get('/api/platform/disk');
    expect(res.status).toBe(200);
    expect(res.body.data.projects[0].quota).toBe(10 * 1024 ** 3);
    expect(res.body.data.projects[1].quota).toBeUndefined();
  });

  it('PATCH forbids a member acting on a project they do not own (403)', async () => {
    const orchestrator = { writeLimits: vi.fn() };
    const member = { id: 'u-mem', email: 'm@example.com', role: 'member', projects: ['other'] };
    const app = appWith('dev', orchestrator, { registry: existing, user: member });
    const res = await request(app).patch('/api/platform/projects/foo/limits').send({ apiCpus: 2 });
    expect(res.status).toBe(403);
    expect(orchestrator.writeLimits).not.toHaveBeenCalled();
  });

  it('GET /metrics joins per-project limits into usage figures', async () => {
    const registry = {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([{ name: 'foo' }]),
    };
    const limits = { apiCpus: 1, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256 };
    const orchestrator = { readLimits: vi.fn().mockResolvedValue(limits) };
    const metrics = {
      host: () => ({ cpuCount: 8 }),
      perProject: vi.fn(async (byProj: any) => ({
        host: { cpuCount: 8 },
        containers: [],
        projects: [{ project: 'foo', cpuLimit: byProj?.foo ? 1.75 : undefined }],
      })),
    };
    const app = appWith('dev', orchestrator, { registry, metrics });
    const res = await request(app).get('/api/platform/metrics');
    expect(res.status).toBe(200);
    expect(metrics.perProject).toHaveBeenCalledWith({ foo: limits });
    expect(res.body.data.projects[0].cpuLimit).toBe(1.75);
  });
});
