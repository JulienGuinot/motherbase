import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { platformRouter } from '../console/routes/platform.routes';

function appWith(cfg: any, extras: any = {}) {
  const app = express();
  app.use(express.json());
  const registry = extras.registry ?? { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) };
  app.use(
    '/api/platform',
    platformRouter({
      orchestrator: extras.orchestrator ?? {},
      registry,
      metrics: extras.metrics,
      settings: extras.settings,
      users: extras.users,
      logs: extras.logs,
      requireSession: (req: Request, _res: Response, next: NextFunction) => { (req as any).user = extras.sessionUser ?? { id: 'u-owner', email: 'owner@example.com', role: 'owner', projects: [] }; next(); },
      cfg,
    } as any),
  );
  return { app, cfg };
}

const baseCfg = () => ({ mode: 'dev', domainSuffix: 'localhost', adminEmail: 'admin@example.com' });

describe('platform admin routes', () => {
  it('GET /settings returns server config without secrets', async () => {
    const { app } = appWith({
      ...baseCfg(),
      adminPasswordHash: 'secret-hash',
      apiImage: 'img:1',
      alertWebhookUrl: 'https://hooks.example.com/alerts',
      alertCpuThreshold: '90',
    });
    const res = await request(app).get('/api/platform/settings');
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('dev');
    expect(res.body.data.apiImage).toBe('img:1');
    expect(res.body.data.alertWebhookUrl).toBe('https://hooks.example.com/alerts');
    expect(res.body.data.alertCpuThreshold).toBe('90');
    expect(JSON.stringify(res.body)).not.toContain('secret-hash');
  });

  it('PUT /settings persists and applies editable keys live', async () => {
    const settings = { update: vi.fn().mockResolvedValue({}) };
    const { app, cfg } = appWith(baseCfg(), { settings });
    const res = await request(app).put('/api/platform/settings').send({ apiImage: 'img:2', mode: 'prod' });
    expect(res.status).toBe(200);
    expect(settings.update).toHaveBeenCalledWith({ apiImage: 'img:2' }); // mode is not editable
    expect(cfg.apiImage).toBe('img:2'); // applied live
    expect(cfg.mode).toBe('dev'); // unchanged
  });

  it('PUT /settings rejects empty patch', async () => {
    const settings = { update: vi.fn() };
    const { app } = appWith(baseCfg(), { settings });
    const res = await request(app).put('/api/platform/settings').send({ mode: 'prod' });
    expect(res.status).toBe(400);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('GET /projects/:id/config lets an assigned member inspect effective config', async () => {
    const config = {
      domain: 'api.example.com',
      storageDomain: 'storage.example.com',
      minioConsoleDomain: 'minio.example.com',
      corsOrigins: 'https://app.example.com',
      apiImage: 'motherbase-api:1.0.0',
      certResolver: 'letsencrypt',
    };
    const orchestrator = { readConfig: vi.fn().mockResolvedValue(config) };
    const registry = { get: vi.fn().mockResolvedValue({ name: 'projet-a' }), list: vi.fn() };
    const sessionUser = { id: 'u-member', email: 'member@example.com', role: 'member', projects: ['projet-a'] };
    const { app } = appWith(baseCfg(), { orchestrator, registry, sessionUser });

    const res = await request(app).get('/api/platform/projects/projet-a/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(config);
  });

  it('PATCH /projects/:id/config validates input and is owner/admin only', async () => {
    const orchestrator = { writeConfig: vi.fn().mockResolvedValue({ domain: 'new.example.com' }) };
    const registry = { get: vi.fn().mockResolvedValue({ name: 'projet-a' }), list: vi.fn() };
    const member = appWith(baseCfg(), {
      orchestrator,
      registry,
      sessionUser: { id: 'u-member', email: 'member@example.com', role: 'member', projects: ['projet-a'] },
    }).app;
    expect((await request(member).patch('/api/platform/projects/projet-a/config').send({ domain: 'new.example.com' })).status).toBe(403);

    const owner = appWith(baseCfg(), { orchestrator, registry }).app;
    expect((await request(owner).patch('/api/platform/projects/projet-a/config').send({ domain: 'bad.example.com\nAPI_IMAGE=evil' })).status).toBe(400);
    const res = await request(owner).patch('/api/platform/projects/projet-a/config').send({ domain: 'new.example.com' });
    expect(res.status).toBe(200);
    expect(orchestrator.writeConfig).toHaveBeenCalledWith('projet-a', { domain: 'new.example.com' });
  });

  // Password changes now go through the users service (Better Auth), which owns
  // the credential hash. The route verifies the current password then writes the
  // new one via setPassword.
  function usersMock(currentOk: boolean) {
    return {
      findById: vi.fn().mockResolvedValue({ id: 'u-owner', email: 'owner@example.com', role: 'owner', projects: [] }),
      verifyPassword: vi.fn().mockResolvedValue(currentOk),
      setPassword: vi.fn().mockResolvedValue({ id: 'u-owner' }),
    };
  }

  it('POST /account/password rejects wrong current password', async () => {
    const users = usersMock(false);
    const { app } = appWith(baseCfg(), { users });
    const res = await request(app).post('/api/platform/account/password')
      .send({ currentPassword: 'wrong', newPassword: 'longenough1' });
    expect(res.status).toBe(401);
    expect(users.setPassword).not.toHaveBeenCalled();
  });

  it('POST /account/password rejects short new password', async () => {
    const users = usersMock(true);
    const { app } = appWith(baseCfg(), { users });
    const res = await request(app).post('/api/platform/account/password')
      .send({ currentPassword: 'right-one', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(users.setPassword).not.toHaveBeenCalled();
  });

  it('POST /account/password sets the new password on success', async () => {
    const users = usersMock(true);
    const { app } = appWith(baseCfg(), { users });
    const res = await request(app).post('/api/platform/account/password')
      .send({ currentPassword: 'right-one', newPassword: 'a-new-password' });
    expect(res.status).toBe(200);
    expect(users.verifyPassword).toHaveBeenCalledWith('u-owner', 'right-one');
    expect(users.setPassword).toHaveBeenCalledWith('u-owner', 'a-new-password');
  });

  it('GET /metrics returns aggregated usage', async () => {
    const metrics = { perProject: vi.fn().mockResolvedValue({ host: { cpuCount: 4 }, containers: [], projects: [{ project: 'foo', cpuPercent: 1 }] }) };
    const { app } = appWith(baseCfg(), { metrics });
    const res = await request(app).get('/api/platform/metrics');
    expect(res.status).toBe(200);
    expect(res.body.data.projects[0].project).toBe('foo');
  });

  it('GET /metrics degrades gracefully without a metrics service', async () => {
    const { app } = appWith(baseCfg());
    const res = await request(app).get('/api/platform/metrics');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ host: null, containers: [], projects: [] });
  });
});
