import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { PlatformUsersService, User } from '../console/services/users.service';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from '../console/auth/instance';
import type { SessionUser } from '../console/auth/session';
import { platformRouter } from '../console/routes/platform.routes';
import { usersRouter } from '../console/routes/users.routes';
import { proxyRouter } from '../console/routes/proxy.routes';

const cfg = {
  mode: 'dev' as const,
  domainSuffix: 'localhost',
  jwtSecret: 's3cr3t',
  adminEmail: '',
  projectsDir: '/tmp/rbac-test',
};

// A test session identifier is just the user id; the guard below reloads the
// live identity from the store on every request, exactly as the real
// requireSession does via Better Auth's getSession. This decouples the route
// authorization matrix (what this suite covers) from the cookie/session
// transport (covered by console-server + console-users-service).
function tokenFor(u: User) {
  return u.id;
}

/** Faithful stand-in for requireSession: live reload + disabled/deleted → 401. */
function testGuard(store: PlatformUsersService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const uid = req.headers['x-test-uid'];
    if (!uid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const u = await store.findById(String(uid));
    if (!u || u.disabled) return res.status(401).json({ success: false, message: 'Unauthorized' });
    (req as any).user = { id: u.id, email: u.email, role: u.role, projects: u.projects } as SessionUser;
    return next();
  };
}

let users: PlatformUsersService;
let owner: User, admin: User, developer: User, readOnly: User, member: User;
let orchestrator: any;
let dir: string;

async function buildApp() {
  dir = path.join(os.tmpdir(), `rbac-matrix-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const authCfg: ConsoleAuthCfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
  await migrateConsoleAuth(authCfg);
  users = new PlatformUsersService(createConsoleAuth(authCfg));
  owner = await users.create({ email: 'owner@x.com', password: 'password1', role: 'owner', projects: [] });
  admin = await users.create({ email: 'admin@x.com', password: 'password1', role: 'admin', projects: [] });
  developer = await users.create({ email: 'developer@x.com', password: 'password1', role: 'developer', projects: ['alpha'] });
  readOnly = await users.create({ email: 'readonly@x.com', password: 'password1', role: 'read_only', projects: ['alpha'] });
  member = await users.create({ email: 'member@x.com', password: 'password1', role: 'member', projects: ['alpha'] });

  orchestrator = {
    stop: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ name: 'newproj', domain: 'newproj.localhost' }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const known = ['alpha', 'beta', 'gamma'];
  const registry = {
    get: vi.fn(async (id: string) => (known.includes(id) ? { name: id } : null)),
    list: vi.fn().mockResolvedValue([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]),
    // Unroutable target so a granted proxy request fails fast (ECONNREFUSED → 502)
    // rather than hitting the real network.
    apiTarget: vi.fn().mockResolvedValue('http://127.0.0.1:9'),
    platformToken: vi.fn().mockResolvedValue('tok'),
  };
  const settings = { update: vi.fn().mockResolvedValue({}) };

  const guard = testGuard(users);
  const app = express();
  app.use(express.json());
  app.use('/api/platform/users', usersRouter({ users, requireSession: guard }));
  app.use('/api/platform', platformRouter({ orchestrator, registry, settings, users, requireSession: guard, cfg } as any));
  app.use('/api', proxyRouter({ registry, requireSession: guard, probe: async () => true }));
  return app;
}

let app: express.Express;
beforeEach(async () => { app = await buildApp(); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* db handle open */ } });

const auth = (t: string) => ({ 'x-test-uid': t });

describe('RBAC: member', () => {
  it('is blocked (403) from creating projects', async () => {
    const res = await request(app).post('/api/platform/projects').set(auth(tokenFor(member))).send({ name: 'x' });
    expect(res.status).toBe(403);
  });
  it('is blocked (403) from deleting projects', async () => {
    const res = await request(app).delete('/api/platform/projects/alpha').set(auth(tokenFor(member))).send({ confirm: 'alpha' });
    expect(res.status).toBe(403);
    expect(orchestrator.destroy).not.toHaveBeenCalled();
  });
  it('is blocked (403) from server settings', async () => {
    expect((await request(app).get('/api/platform/settings').set(auth(tokenFor(member)))).status).toBe(403);
    expect((await request(app).put('/api/platform/settings').set(auth(tokenFor(member))).send({ apiImage: 'i' })).status).toBe(403);
  });
  it('is blocked (403) from user management', async () => {
    expect((await request(app).get('/api/platform/users').set(auth(tokenFor(member)))).status).toBe(403);
    expect((await request(app).post('/api/platform/users').set(auth(tokenFor(member))).send({ email: 'n@x.com', password: 'password1', role: 'member' })).status).toBe(403);
  });
  it('cannot operate an assigned project lifecycle', async () => {
    const res = await request(app).post('/api/platform/projects/alpha/stop').set(auth(tokenFor(member)));
    expect(res.status).toBe(403);
    expect(orchestrator.stop).not.toHaveBeenCalled();
  });
  it('is blocked (403) on a non-assigned project (lifecycle)', async () => {
    const res = await request(app).post('/api/platform/projects/beta/stop').set(auth(tokenFor(member)));
    expect(res.status).toBe(403);
    expect(orchestrator.stop).not.toHaveBeenCalled();
  });
  it('reaches the admin proxy for an assigned project but is 403 on a non-assigned one', async () => {
    // Access granted → falls through to proxy/registry (404 here since our mock has no live upstream lookup path)
    const granted = await request(app).get('/api/projects/alpha/admin/tables').set(auth(tokenFor(member)));
    expect(granted.status).not.toBe(403);
    const denied = await request(app).get('/api/projects/beta/admin/tables').set(auth(tokenFor(member)));
    expect(denied.status).toBe(403);
  });
  it('sees only assigned projects in GET /projects', async () => {
    const res = await request(app).get('/api/platform/projects').set(auth(tokenFor(member)));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ name: 'alpha' }]);
  });
});

describe('RBAC: developer and read-only', () => {
  it('exposes identity and capabilities from GET /me', async () => {
    const res = await request(app).get('/api/platform/me').set(auth(tokenFor(developer)));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: developer.id, role: 'developer' });
    expect(res.body.data.capabilities).toEqual(['project.read', 'content.write']);
  });

  it('scopes both roles to assigned projects', async () => {
    for (const user of [developer, readOnly]) {
      const res = await request(app).get('/api/platform/projects').set(auth(tokenFor(user)));
      expect(res.body.data).toEqual([{ name: 'alpha' }]);
    }
  });

  it('allows developer content writes but blocks settings/runtime and unassigned projects', async () => {
    const content = await request(app).post('/api/projects/alpha/admin/tables').set(auth(tokenFor(developer))).send({});
    expect(content.status).not.toBe(403);
    expect((await request(app).put('/api/projects/alpha/admin/settings/server.cors').set(auth(tokenFor(developer))).send({})).status).toBe(403);
    expect((await request(app).post('/api/platform/projects/alpha/stop').set(auth(tokenFor(developer)))).status).toBe(403);
    expect((await request(app).post('/api/projects/beta/admin/tables').set(auth(tokenFor(developer))).send({})).status).toBe(403);
  });

  it('allows read-only safe proxy methods and blocks mutations', async () => {
    expect((await request(app).get('/api/projects/alpha/admin/tables').set(auth(tokenFor(readOnly)))).status).not.toBe(403);
    expect((await request(app).get('/api/projects/alpha/admin/edge-secrets').set(auth(tokenFor(readOnly)))).status).toBe(403);
    expect((await request(app).get('/api/projects/alpha/admin/settings/email.smtp').set(auth(tokenFor(readOnly)))).status).toBe(403);
    expect((await request(app).post('/api/projects/alpha/admin/tables').set(auth(tokenFor(readOnly))).send({})).status).toBe(403);
  });
});

describe('RBAC: admin', () => {
  it('can create projects', async () => {
    const res = await request(app).post('/api/platform/projects').set(auth(tokenFor(admin))).send({ name: 'newproj' });
    expect(res.status).toBe(200);
    expect(orchestrator.create).toHaveBeenCalled();
  });
  it('can operate any project', async () => {
    const res = await request(app).post('/api/platform/projects/gamma/stop').set(auth(tokenFor(admin)));
    expect(res.status).toBe(200);
  });
  it('sees all projects', async () => {
    const res = await request(app).get('/api/platform/projects').set(auth(tokenFor(admin)));
    expect(res.body.data).toHaveLength(3);
  });
  it('can delete projects', async () => {
    const res = await request(app).delete('/api/platform/projects/alpha').set(auth(tokenFor(admin))).send({ confirm: 'alpha' });
    expect(res.status).toBe(200);
    expect(orchestrator.destroy).toHaveBeenCalledWith('alpha');
  });
  it('is blocked (403) from settings and user management', async () => {
    expect((await request(app).get('/api/platform/settings').set(auth(tokenFor(admin)))).status).toBe(403);
    expect((await request(app).get('/api/platform/users').set(auth(tokenFor(admin)))).status).toBe(403);
  });
});

describe('RBAC: owner', () => {
  it('can delete projects, read settings, and manage users', async () => {
    expect((await request(app).delete('/api/platform/projects/alpha').set(auth(tokenFor(owner))).send({ confirm: 'alpha' })).status).toBe(200);
    expect((await request(app).get('/api/platform/settings').set(auth(tokenFor(owner)))).status).toBe(200);
    const list = await request(app).get('/api/platform/users').set(auth(tokenFor(owner)));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(5);
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
  });
  it('can create a user', async () => {
    const res = await request(app).post('/api/platform/users').set(auth(tokenFor(owner)))
      .send({ email: 'new@x.com', password: 'password1', role: 'member', projects: ['alpha'] });
    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe('new@x.com');
    expect(res.body.data.passwordHash).toBeUndefined();
  });
  it('can revoke another operator sessions but not its own', async () => {
    const revoked = await request(app)
      .delete(`/api/platform/users/${developer.id}/sessions`)
      .set(auth(tokenFor(owner)));
    expect(revoked.status).toBe(200);

    const self = await request(app)
      .delete(`/api/platform/users/${owner.id}/sessions`)
      .set(auth(tokenFor(owner)));
    expect(self.status).toBe(400);
  });
  it.each(['developer', 'read_only'] as const)('can create the %s role', async role => {
    const res = await request(app).post('/api/platform/users').set(auth(tokenFor(owner)))
      .send({ email: `${role}@new.test`, password: 'password1', role, projects: ['alpha'] });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe(role);
  });
});

describe('RBAC: session liveness', () => {
  it('rejects (401) a token whose user was disabled after issuance', async () => {
    const t = tokenFor(member);
    await users.update(member.id, { disabled: true });
    const res = await request(app).get('/api/platform/projects').set(auth(t));
    expect(res.status).toBe(401);
  });
  it('rejects (401) a token whose user was deleted after issuance', async () => {
    const t = tokenFor(member);
    await users.delete(member.id);
    const res = await request(app).get('/api/platform/projects').set(auth(t));
    expect(res.status).toBe(401);
  });
  it('reflects a role change live (member promoted to owner can manage users)', async () => {
    await users.update(member.id, { role: 'owner' });
    // Old token still says member, but requireSession reloads the live role.
    const res = await request(app).get('/api/platform/users').set(auth(tokenFor(member)));
    expect(res.status).toBe(200);
  });
});

describe('RBAC: user management guards', () => {
  it('refuses to delete the last owner', async () => {
    // owner deletes admin (fine), then someone tries to delete the sole remaining owner
    const secondOwner = await users.create({ email: 'o2@x.com', password: 'password1', role: 'owner' });
    // remove the seeded owner first via the second owner
    const delFirst = await request(app).delete(`/api/platform/users/${owner.id}`).set(auth(tokenFor(secondOwner)));
    expect(delFirst.status).toBe(200);
    // now secondOwner is the last owner; deleting them must fail (also self-delete guard)
    const delLast = await request(app).delete(`/api/platform/users/${secondOwner.id}`).set(auth(tokenFor(secondOwner)));
    expect(delLast.status).toBe(400);
  });
  it('refuses an owner deleting their own account', async () => {
    const res = await request(app).delete(`/api/platform/users/${owner.id}`).set(auth(tokenFor(owner)));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/your own account/i);
  });
});
