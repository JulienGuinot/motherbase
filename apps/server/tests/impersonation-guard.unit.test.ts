import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hasCapability, requireProjectCapability, type Capability } from '../console/auth/capabilities';
import { adminProxyCapability, classifyAdminProxyMutation } from '../console/routes/proxy.routes';
import { auditMutations } from '../console/middlewares/audit.middleware';
import { AuditStore } from '../console/services/audit.service';

// Impersonation is only as safe as two things the console owns: the capability
// the proxy demands before the request reaches the project API, and the audit
// entry it writes afterwards. Both are exercised here against the real
// middleware and a real (in-memory) AuditStore: no Postgres involved.

const START = '/api/projects/alpha/admin/users/user-42/impersonate';
const STOP = '/api/projects/alpha/admin/users/user-42/impersonate/stop';

function operator(role: 'owner' | 'admin' | 'developer' | 'member' | 'read_only') {
  return { id: `op-${role}`, email: `${role}@example.com`, role, projects: ['alpha'], mustChangePassword: false };
}

function app(store: AuditStore, role: Parameters<typeof operator>[0]) {
  const server = express();
  server.use(express.json());
  server.all('/api/projects/:id/admin/*', (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = operator(role);
    next();
  });
  server.all(
    '/api/projects/:id/admin/*',
    auditMutations(store, classifyAdminProxyMutation),
    (req, res, next) => requireProjectCapability(adminProxyCapability(req.method, req.originalUrl))(req, res, next),
    (_req, res) => res.status(200).json({ success: true }),
  );
  return server;
}

describe('impersonation capability', () => {
  it('demands secrets.manage, not an ordinary user write', () => {
    expect(adminProxyCapability('POST', START)).toBe<Capability>('secrets.manage');
    expect(adminProxyCapability('POST', STOP)).toBe<Capability>('secrets.manage');
  });

  it('is unreachable for every role without that capability', async () => {
    for (const role of ['developer', 'member', 'read_only'] as const) {
      expect(hasCapability(role, 'secrets.manage')).toBe(false);
      const store = new AuditStore(':memory:');
      const res = await request(app(store, role)).post(START);
      expect(res.status, role).toBe(403);
      store.close();
    }
  });

  it('is reachable for an owner', async () => {
    const store = new AuditStore(':memory:');
    expect((await request(app(store, 'owner')).post(START)).status).toBe(200);
    store.close();
  });
});

describe('impersonation audit trail', () => {
  it('records start and stop as distinct entries naming the target user', async () => {
    const store = new AuditStore(':memory:');
    await request(app(store, 'owner')).post(START);
    await request(app(store, 'owner')).post(STOP).send({ token: 'a-session-token' });

    const entries = store.list();
    const start = entries.find(e => e.action === 'project.admin.users.impersonate.start');
    const stop = entries.find(e => e.action === 'project.admin.users.impersonate.stop');

    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    expect(start!.success).toBe(true);
    expect(start!.actorEmail).toBe('owner@example.com');
    expect(start!.detail.targetUser).toBe('user-42');
    expect(start!.detail.capability).toBe('secrets.manage');
    expect(stop!.detail.targetUser).toBe('user-42');
    store.close();
  });

  it('records the refusal too, so a denied attempt is not invisible', async () => {
    const store = new AuditStore(':memory:');
    await request(app(store, 'developer')).post(START);
    const [entry] = store.list();
    expect(entry.action).toBe('project.admin.users.impersonate.start');
    expect(entry.success).toBe(false);
    store.close();
  });

  it('never writes the session token, whatever the body carries', async () => {
    const store = new AuditStore(':memory:');
    await request(app(store, 'owner')).post(STOP).send({ token: 'super-secret-session-token' });
    const [entry] = store.list();
    expect(JSON.stringify(entry)).not.toContain('super-secret-session-token');
    store.close();
  });
});
