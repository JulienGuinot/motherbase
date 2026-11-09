import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { orgsRouter } from '../console/routes/orgs.routes';
import { platformRouter } from '../console/routes/platform.routes';
import { OrgStore } from '../console/services/org-store';

type SessionUser = { id: string; email: string; role: 'owner' | 'admin' | 'member'; projects: string[] };

// Console user store stub: just the surface the routers touch.
function usersStub(users: SessionUser[]) {
  return {
    list: async () => users,
    findById: async (id: string) => users.find(u => u.id === id),
  } as any;
}

function makeApp(orgs: OrgStore, users: any, current: { user: SessionUser }) {
  const app = express();
  app.use(express.json());
  const requireSession = (req: Request, _res: Response, next: NextFunction) => { (req as any).user = current.user; next(); };
  app.use('/api/platform/orgs', orgsRouter({ orgs, users, requireSession }));
  return app;
}

describe('orgs routes', () => {
  let orgs: OrgStore;
  const alice: SessionUser = { id: 'alice', email: 'alice@x.com', role: 'member', projects: [] };
  const bob: SessionUser = { id: 'bob', email: 'bob@x.com', role: 'member', projects: [] };
  const root: SessionUser = { id: 'root', email: 'root@x.com', role: 'owner', projects: [] };
  let current: { user: SessionUser };
  let app: express.Express;

  beforeEach(() => {
    orgs = new OrgStore(':memory:');
    current = { user: alice };
    app = makeApp(orgs, usersStub([alice, bob, root]), current);
  });

  it('self-heals: a caller with no orgs is joined to the default org on GET /', async () => {
    // Fresh store, no backfill: alice (global 'member') belongs to nothing.
    expect(orgs.listForUser('alice')).toHaveLength(0);
    const res = await request(app).get('/api/platform/orgs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const def = res.body.data[0];
    expect(def.slug).toBe('default-organization');
    expect(orgs.memberRole(def.id, 'alice')).toBe('member');

    // Stable across calls: same org, no duplicate membership.
    const again = await request(app).get('/api/platform/orgs');
    expect(again.body.data).toHaveLength(1);
    expect(again.body.data[0].id).toBe(def.id);
  });

  it('creates an org and lists it for the creator', async () => {
    const create = await request(app).post('/api/platform/orgs').send({ name: 'Alice Co' });
    expect(create.status).toBe(200);
    expect(create.body.data.slug).toBe('alice-co');

    const list = await request(app).get('/api/platform/orgs');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ role: 'owner', projectCount: 0 });
  });

  it('blocks non-members from an org (403) but lets a global owner in', async () => {
    const org = orgs.createOrg('Private', 'alice');

    current.user = bob;
    expect((await request(app).get(`/api/platform/orgs/${org.id}`)).status).toBe(403);

    current.user = root; // global console owner bypasses membership
    expect((await request(app).get(`/api/platform/orgs/${org.id}`)).status).toBe(200);
  });

  it('rename requires an elevated role', async () => {
    const org = orgs.createOrg('Org', 'alice');
    orgs.addMember(org.id, 'bob', 'member');

    current.user = bob;
    expect((await request(app).patch(`/api/platform/orgs/${org.id}`).send({ name: 'X' })).status).toBe(403);

    current.user = alice; // owner
    const ok = await request(app).patch(`/api/platform/orgs/${org.id}`).send({ name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(orgs.getOrg(org.id)?.name).toBe('Renamed');
  });

  it('adds and removes members, guarding the last owner', async () => {
    const org = orgs.createOrg('Org', 'alice');

    const add = await request(app).post(`/api/platform/orgs/${org.id}/members`).send({ userId: 'bob', role: 'admin' });
    expect(add.status).toBe(200);
    expect(orgs.memberRole(org.id, 'bob')).toBe('admin');

    const members = await request(app).get(`/api/platform/orgs/${org.id}/members`);
    expect(members.body.data.find((m: any) => m.userId === 'bob').email).toBe('bob@x.com');

    // nor demote them by re-adding with a lesser role
    const demote = await request(app).post(`/api/platform/orgs/${org.id}/members`).send({ userId: 'alice', role: 'member' });
    expect(demote.status).toBe(409);
    expect(orgs.memberRole(org.id, 'alice')).toBe('owner');

    // cannot remove the last owner
    const delOwner = await request(app).delete(`/api/platform/orgs/${org.id}/members/alice`);
    expect(delOwner.status).toBe(409);

    const delBob = await request(app).delete(`/api/platform/orgs/${org.id}/members/bob`);
    expect(delBob.status).toBe(200);
  });

  it('refuses to add an unknown user', async () => {
    const org = orgs.createOrg('Org', 'alice');
    const res = await request(app).post(`/api/platform/orgs/${org.id}/members`).send({ userId: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('refuses to delete an org that still owns projects', async () => {
    const org = orgs.createOrg('Org', 'alice');
    orgs.assignProject('proj', org.id);
    expect((await request(app).delete(`/api/platform/orgs/${org.id}`)).status).toBe(409);
    orgs.unassignProject('proj');
    expect((await request(app).delete(`/api/platform/orgs/${org.id}`)).status).toBe(200);
  });
});

describe('org AI key × project scope', () => {
  const dev = { id: 'dev', email: 'dev@x.com', role: 'developer', projects: ['shop'] } as unknown as SessionUser;
  const admin: SessionUser = { id: 'adm', email: 'adm@x.com', role: 'admin', projects: [] };

  it('names only the projects the caller can see, and refuses the change to a scoped developer', async () => {
    const orgs = new OrgStore(':memory:');
    const org = orgs.createOrg('Acme', 'someone');
    orgs.addMember(org.id, 'dev', 'admin');
    const orgAi = {
      view: () => ({ enabled: false, projects: ['shop', 'billing', 'internal'] }),
      save: vi.fn(),
    } as any;
    const current = { user: dev };
    const app = express();
    app.use(express.json());
    app.use('/api/platform/orgs', orgsRouter({
      orgs, orgAi, users: usersStub([]),
      requireSession: (req: Request, _res: Response, next: NextFunction) => { (req as any).user = current.user; next(); },
    }));

    const view = await request(app).get(`/api/platform/orgs/${org.id}/ai`);
    expect(view.body.data).toMatchObject({ projects: ['shop'], canManage: false });
    expect((await request(app).put(`/api/platform/orgs/${org.id}/ai`).send({})).status).toBe(403);
    expect(orgAi.save).not.toHaveBeenCalled();

    // A console admin governs every org, member or not.
    current.user = admin;
    expect((await request(app).get(`/api/platform/orgs/${org.id}/ai`)).body.data.canManage).toBe(true);
    expect((await request(app).patch(`/api/platform/orgs/${org.id}`).send({ name: 'Renamed' })).status).toBe(200);
  });
});

describe('platform projects × orgs', () => {
  let orgs: OrgStore;
  const owner: SessionUser = { id: 'root', email: 'root@x.com', role: 'owner', projects: [] };
  let current: { user: SessionUser };

  function app(registry: any, orchestrator: any) {
    const a = express();
    a.use(express.json());
    a.use('/api/platform', platformRouter({
      orchestrator, registry, orgs,
      requireSession: (req: Request, _res: Response, next: NextFunction) => { (req as any).user = current.user; next(); },
      cfg: { mode: 'dev', domainSuffix: 'localhost' },
    } as any));
    return a;
  }

  beforeEach(() => {
    orgs = new OrgStore(':memory:');
    current = { user: owner };
  });

  it('assigns a new project to the chosen org and filters the list by org', async () => {
    const acme = orgs.createOrg('Acme', 'root');
    const other = orgs.createOrg('Other', 'root');
    const registry = {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }]),
    };
    const orchestrator = { create: vi.fn().mockResolvedValue({ name: 'a' }) };
    const server = app(registry, orchestrator);

    const created = await request(server).post('/api/platform/projects').send({ name: 'a', orgId: acme.id });
    expect(created.status).toBe(200);
    expect(orgs.orgOfProject('a')).toBe(acme.id);

    // manually place 'b' in the other org, then filter
    orgs.assignProject('b', other.id);
    const acmeList = await request(server).get(`/api/platform/projects?org=${acme.id}`);
    expect(acmeList.body.data.map((p: any) => p.name)).toEqual(['a']);
    const otherList = await request(server).get(`/api/platform/projects?org=${other.id}`);
    expect(otherList.body.data.map((p: any) => p.name)).toEqual(['b']);
  });

  it('rejects an unknown org on create and a non-member org filter', async () => {
    const registry = { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) };
    const orchestrator = { create: vi.fn() };
    const server = app(registry, orchestrator);

    const bad = await request(server).post('/api/platform/projects').send({ name: 'a', orgId: 'nope' });
    expect(bad.status).toBe(400);
    expect(orchestrator.create).not.toHaveBeenCalled();

    // a member (non-owner) filtering an org they don't belong to → 403
    const secret = orgs.createOrg('Secret', 'someone-else');
    current.user = { id: 'stranger', email: 's@x.com', role: 'member', projects: [] };
    const forbidden = await request(server).get(`/api/platform/projects?org=${secret.id}`);
    expect(forbidden.status).toBe(403);
  });
});
