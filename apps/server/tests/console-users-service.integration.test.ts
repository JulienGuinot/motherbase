import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from '../console/auth/instance';
import { PlatformUsersService } from '../console/services/users.service';

async function freshService(): Promise<{ dir: string; svc: PlatformUsersService; auth: ReturnType<typeof createConsoleAuth> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-users-'));
  const cfg: ConsoleAuthCfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
  await migrateConsoleAuth(cfg);
  const auth = createConsoleAuth(cfg);
  return { dir, svc: new PlatformUsersService(auth), auth };
}

describe('PlatformUsersService (Better Auth backed)', () => {
  let dir: string;
  let svc: PlatformUsersService;
  let auth: ReturnType<typeof createConsoleAuth>;

  beforeEach(async () => {
    const f = await freshService();
    dir = f.dir; svc = f.svc; auth = f.auth;
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* handle still open */ }
  });

  it('creates a user and finds it by email with role + projects', async () => {
    const u = await svc.create({ email: 'op@x.io', password: 'pw123456', role: 'admin', projects: ['p1', 'p2'] });
    expect(u.role).toBe('admin');
    expect(u.projects.sort()).toEqual(['p1', 'p2']);
    const found = await svc.findByEmail('op@x.io');
    expect(found?.id).toBe(u.id);
    expect((await svc.projectsOf(u.id)).sort()).toEqual(['p1', 'p2']);
  });

  it('rejects a duplicate email', async () => {
    await svc.create({ email: 'dup@x.io', password: 'pw123456', role: 'member' });
    await expect(svc.create({ email: 'dup@x.io', password: 'pw123456', role: 'member' })).rejects.toThrow(/exists/);
  });

  it('updates projects atomically by diffing memberships', async () => {
    const u = await svc.create({ email: 'a@x.io', password: 'pw123456', role: 'member', projects: ['p1'] });
    const ctx = await auth.$context;
    const transaction = vi.spyOn(ctx.adapter, 'transaction');

    await svc.update(u.id, { projects: ['p2', 'p3'] });

    expect(transaction).toHaveBeenCalledOnce();
    expect((await svc.projectsOf(u.id)).sort()).toEqual(['p2', 'p3']);
  });

  it('loads all user memberships with two bounded queries', async () => {
    await svc.create({ email: 'one@x.io', password: 'pw123456', role: 'member', projects: ['p1', 'p2'] });
    await svc.create({ email: 'two@x.io', password: 'pw123456', role: 'member', projects: ['p2'] });
    const ctx = await auth.$context;
    const findMany = vi.spyOn(ctx.adapter, 'findMany');

    const users = await svc.list();

    expect(users).toHaveLength(2);
    const membershipQueries = findMany.mock.calls
      .map(([query]) => query.model)
      .filter(model => model === 'member' || model === 'organization');
    expect(membershipQueries).toEqual(['member', 'organization']);
  });

  it('keeps membership lookup bounded for 100 Console users', async () => {
    const passwordHash = bcrypt.hashSync('pw123456', 8);
    for (let index = 0; index < 100; index += 1) {
      await svc.provision({
        email: `user-${index}@x.io`,
        passwordHash,
        role: 'member',
        projects: ['shared-project'],
      });
    }
    const ctx = await auth.$context;
    const findMany = vi.spyOn(ctx.adapter, 'findMany');

    const users = await svc.list();

    expect(users).toHaveLength(100);
    const membershipQueries = findMany.mock.calls.filter(([query]) =>
      query.model === 'member' || query.model === 'organization',
    );
    expect(membershipQueries).toHaveLength(2);
  });

  it('disables and re-enables a user', async () => {
    const u = await svc.create({ email: 'b@x.io', password: 'pw123456', role: 'member' });
    await svc.update(u.id, { disabled: true });
    expect((await svc.findById(u.id))?.disabled).toBe(true);
    await svc.update(u.id, { disabled: false });
    expect((await svc.findById(u.id))?.disabled).toBe(false);
  });

  it('counts owners', async () => {
    await svc.create({ email: 'o@x.io', password: 'pw123456', role: 'owner' });
    await svc.create({ email: 'm@x.io', password: 'pw123456', role: 'member' });
    expect(await svc.ownerCount()).toBe(1);
  });

  it('deletes a user and its memberships', async () => {
    const u = await svc.create({ email: 'del@x.io', password: 'pw123456', role: 'member', projects: ['p9'] });
    expect(await svc.delete(u.id)).toBe(true);
    expect(await svc.findById(u.id)).toBeUndefined();
    expect(await svc.projectsOf(u.id)).toEqual([]);
  });

  it('created credentials work with Better Auth sign-in', async () => {
    await svc.create({ email: 'signin@x.io', password: 'correct-horse', role: 'admin' });
    const ok = await auth.api.signInEmail({ body: { email: 'signin@x.io', password: 'correct-horse' }, asResponse: true });
    expect(ok.status).toBe(200);
    const bad = await auth.api.signInEmail({ body: { email: 'signin@x.io', password: 'wrong' }, asResponse: true });
    expect(bad.status).not.toBe(200);
  });

  it('seedOwnerWithHash provisions an owner from an existing bcrypt hash and signs in', async () => {
    const hash = bcrypt.hashSync('legacy-pass', 10);
    const owner = await svc.seedOwnerWithHash({ email: 'legacy@x.io', passwordHash: hash });
    expect(owner?.role).toBe('owner');
    // Idempotent: a second seed does nothing because the store is non-empty.
    expect(await svc.seedOwnerWithHash({ email: 'other@x.io', passwordHash: hash })).toBeUndefined();
    const ok = await auth.api.signInEmail({ body: { email: 'legacy@x.io', password: 'legacy-pass' }, asResponse: true });
    expect(ok.status).toBe(200);
  });

  it('marks owner-assigned credentials temporary and clears the flag on self-change', async () => {
    const user = await svc.create({
      email: 'temporary@x.io',
      password: 'temporary-123',
      role: 'member',
      passwordTemporary: true,
    });
    expect(user.mustChangePassword).toBe(true);

    await svc.setPassword(user.id, 'chosen-password-456');

    expect((await svc.findById(user.id))?.mustChangePassword).toBe(false);
  });

  it('rolls back the credential when clearing the rotation flag fails', async () => {
    const user = await svc.create({
      email: 'atomic@x.io',
      password: 'temporary-123',
      role: 'member',
      passwordTemporary: true,
    });
    const db = new Database(path.join(dir, 'console-auth.db'));
    db.exec(`
      CREATE TRIGGER fail_password_rotation
      BEFORE UPDATE OF mustChangePassword ON user
      BEGIN SELECT RAISE(ABORT, 'forced rotation failure'); END;
    `);
    db.close();

    await expect(svc.setPassword(user.id, 'chosen-password-456')).rejects.toThrow();

    expect((await svc.findById(user.id))?.mustChangePassword).toBe(true);
    expect((await auth.api.signInEmail({
      body: { email: user.email, password: 'temporary-123' },
      asResponse: true,
    })).status).toBe(200);
    expect((await auth.api.signInEmail({
      body: { email: user.email, password: 'chosen-password-456' },
      asResponse: true,
    })).status).not.toBe(200);
  });

  it('marks an administrative password reset temporary', async () => {
    const user = await svc.create({ email: 'reset@x.io', password: 'chosen-123', role: 'member' });
    const ctx = await auth.$context;
    await ctx.internalAdapter.createSession(user.id);

    await svc.update(user.id, { password: 'reset-password-456' });

    expect((await svc.findById(user.id))?.mustChangePassword).toBe(true);
    expect(await ctx.internalAdapter.listSessions(user.id)).toHaveLength(0);
  });

  it('revokes every session for an existing user', async () => {
    const user = await svc.create({ email: 'sessions@x.io', password: 'chosen-123', role: 'member' });
    const ctx = await auth.$context;
    await ctx.internalAdapter.createSession(user.id);
    await ctx.internalAdapter.createSession(user.id);

    await expect(svc.revokeSessions(user.id)).resolves.toBe(true);
    expect(await ctx.internalAdapter.listSessions(user.id)).toHaveLength(0);
    await expect(svc.revokeSessions('missing')).resolves.toBe(false);
  });

  it('changes a password and the new one signs in', async () => {
    const u = await svc.create({ email: 'pw@x.io', password: 'old-pass-123', role: 'member' });
    await svc.setPassword(u.id, 'new-pass-456');
    const ok = await auth.api.signInEmail({ body: { email: 'pw@x.io', password: 'new-pass-456' }, asResponse: true });
    expect(ok.status).toBe(200);
    const old = await auth.api.signInEmail({ body: { email: 'pw@x.io', password: 'old-pass-123' }, asResponse: true });
    expect(old.status).not.toBe(200);
  });
});
