import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { platformRouter } from '../console/routes/platform.routes';

function appWith(orch: any, reg: any) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/platform',
    platformRouter({
      orchestrator: orch,
      registry: reg,
      requireSession: (q: any, _s: any, n: () => void) => { q.user = { id: 'u-owner', email: 'owner@example.com', role: 'owner', projects: [] }; n(); },
      cfg: { mode: 'prod', domainSuffix: '' },
    } as any),
  );
  return app;
}

describe('platform routes', () => {
  it('GET /projects returns the registry list', async () => {
    const reg = { list: vi.fn().mockResolvedValue([{ name: 'projet-a', status: 'running' }]) };
    const res = await request(appWith({}, reg)).get('/api/platform/projects');
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('projet-a');
  });

  it('POST /projects validates the name', async () => {
    const orch = { create: vi.fn() };
    const res = await request(appWith(orch, {})).post('/api/platform/projects').send({ name: 'Bad Name', domain: 'x' });
    expect(res.status).toBe(400);
    expect(orch.create).not.toHaveBeenCalled();
  });

  it('POST /projects provisions a valid project', async () => {
    const created = { name: 'project-a', status: 'running' };
    const orch = { create: vi.fn().mockResolvedValue(created) };
    const reg = { get: vi.fn().mockResolvedValue(null) };

    const input = { name: 'project-a', domain: 'project-a.example.test' };
    const res = await request(appWith(orch, reg)).post('/api/platform/projects').send(input);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created);
    expect(orch.create).toHaveBeenCalledWith(input);
  });

  it('POST /projects/:id/stop calls orchestrator.stop', async () => {
    const orch = { stop: vi.fn().mockResolvedValue({}) };
    const res = await request(appWith(orch, {})).post('/api/platform/projects/projet-a/stop');
    expect(res.status).toBe(200);
    expect(orch.stop).toHaveBeenCalledWith('projet-a');
  });
});
