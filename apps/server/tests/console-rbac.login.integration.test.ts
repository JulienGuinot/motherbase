import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from '../console/auth/instance';
import { PlatformUsersService } from '../console/services/users.service';
import { AuditStore } from '../console/services/audit.service';

// Each case runs createConsoleApp against an isolated temp projects dir so the
// console-auth SQLite store is controlled. Env is set before importing the
// module because config.ts reads it at load time.
function freshDir() {
  const dir = path.join(os.tmpdir(), `console-rbac-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadApp(dir: string) {
  process.env.CONSOLE_MODE = 'dev';
  process.env.PROJECTS_DIR = dir;
  process.env.CONSOLE_JWT_SECRET = 'itest-secret';
  vi.resetModules();
  const { createConsoleApp } = await import('../console/server');
  return createConsoleApp({ registry: { list: vi.fn().mockResolvedValue([]) }, orchestrator: {} } as any);
}

// Provision a user straight into the store (bypassing the app) so we can set up
// disabled/active fixtures. Password rows are secret-independent, so any secret
// works for the backing instance.
async function seedUser(dir: string, u: {
  email: string;
  password: string;
  role: 'owner' | 'admin' | 'member';
  disabled?: boolean;
  passwordTemporary?: boolean;
}) {
  const cfg: ConsoleAuthCfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
  await migrateConsoleAuth(cfg);
  const svc = new PlatformUsersService(createConsoleAuth(cfg));
  await svc.provision({
    email: u.email,
    passwordHash: bcrypt.hashSync(u.password, 8),
    role: u.role,
    disabled: u.disabled ?? false,
    mustChangePassword: u.passwordTemporary ?? false,
  });
}

// Flip an operator's Better Auth `twoFactorEnabled` flag straight in the store,
// so sign-in must take the two-factor challenge path without us having to drive a
// full TOTP enrollment (which needs a live authenticator code).
function enable2fa(dir: string, email: string) {
  const db = new Database(path.join(dir, 'console-auth.db'));
  db.pragma('journal_mode = WAL');
  db.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE email = ?').run(email);
  db.close();
}

function readAudit(dir: string) {
  const audit = AuditStore.open(dir);
  try {
    return audit.list();
  } finally {
    audit.close();
  }
}

beforeEach(() => { vi.resetModules(); });

// Booting the console app is what costs: `loadApp` imports the server module,
// migrates the SQLite auth store and initialises Better Auth, and the cases that
// log in also pay for bcrypt. That fits in vitest's 5 s default on an idle
// machine and does not inside the full suite, where this file is one of ~280
// worker processes -- `npm run verify` timed out here on two consecutive runs
// and every case passed when the file was run alone. Set on the suite rather
// than on the case that happened to lose the race first. Same value as the
// other slow integration suites (`integration-webhooks`, `edge-runtime`).
const SLOW = 60_000;

describe('console login + bootstrap', { timeout: SLOW }, () => {
  it('seeds one owner from the env admin when the store is empty, and that admin can log in', async () => {
    const dir = freshDir();
    process.env.CONSOLE_ADMIN_EMAIL = 'seed@example.com';
    process.env.CONSOLE_ADMIN_PASSWORD_HASH = bcrypt.hashSync('seedpass1', 8);

    const app = await loadApp(dir);
    const agent = request.agent(app);

    const login = await agent.post('/api/platform/login').send({ email: 'seed@example.com', password: 'seedpass1' });
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'] ?? '')).toContain('console');

    const ok = await agent.get('/api/platform/projects');
    expect(ok.status).toBe(200);

    expect(readAudit(dir)[0]).toMatchObject({
      actorEmail: 'seed@example.com',
      actorRole: 'owner',
      action: 'auth.login',
      target: 'account:seed@example.com',
      success: true,
      detail: { outcome: 'authenticated' },
    });
    expect(JSON.stringify(readAudit(dir))).not.toContain('seedpass1');

    // The seeded identity is an owner.
    const svc = new PlatformUsersService(createConsoleAuth({ projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' }));
    const seeded = await svc.findByEmail('seed@example.com');
    expect(seeded?.role).toBe('owner');
  });

  it('rejects login for a disabled user (401) and accepts an active one', async () => {
    const dir = freshDir();
    await seedUser(dir, { email: 'active@example.com', password: 'activepass1', role: 'owner' });
    await seedUser(dir, { email: 'blocked@example.com', password: 'blockedpw1', role: 'member', disabled: true });

    // Store already non-empty → env admin is NOT seeded (back-compat no-op).
    process.env.CONSOLE_ADMIN_EMAIL = 'ignored@example.com';
    process.env.CONSOLE_ADMIN_PASSWORD_HASH = bcrypt.hashSync('whatever1', 8);

    const app = await loadApp(dir);

    const disabled = await request(app).post('/api/platform/login').send({ email: 'blocked@example.com', password: 'blockedpw1' });
    expect(disabled.status).toBe(401);

    const active = await request(app).post('/api/platform/login').send({ email: 'active@example.com', password: 'activepass1' });
    expect(active.status).toBe(200);
    const unknown = await request(app).post('/api/platform/login').send({ email: 'nobody@example.com', password: 'do-not-store-me' });
    expect(unknown.status).toBe(401);

    expect(readAudit(dir)).toMatchObject([
      { actorId: 'unknown', actorEmail: 'nobody@example.com', actorRole: 'unknown', success: false },
      { actorEmail: 'active@example.com', actorRole: 'owner', success: true },
      { actorEmail: 'blocked@example.com', actorRole: 'member', success: false, detail: { outcome: 'disabled' } },
    ]);
    expect(JSON.stringify(readAudit(dir))).not.toContain('do-not-store-me');

    const svc = new PlatformUsersService(createConsoleAuth({ projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' }));
    expect(await svc.findByEmail('ignored@example.com')).toBeUndefined();
  });

  it('blocks business routes until a temporary password is changed', async () => {
    const dir = freshDir();
    await seedUser(dir, {
      email: 'temporary@example.com',
      password: 'temporary-pass-123',
      role: 'owner',
      passwordTemporary: true,
    });
    process.env.CONSOLE_ADMIN_EMAIL = 'ignored@example.com';
    process.env.CONSOLE_ADMIN_PASSWORD_HASH = bcrypt.hashSync('whatever1', 8);

    const app = await loadApp(dir);
    const agent = request.agent(app);
    const login = await agent.post('/api/platform/login').send({
      email: 'temporary@example.com',
      password: 'temporary-pass-123',
    });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    expect((await agent.get('/api/auth/get-session')).body.user.mustChangePassword).toBe(true);

    const blocked = await agent.get('/api/platform/projects');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await agent.post('/api/platform/account/password').send({
      currentPassword: 'temporary-pass-123',
      newPassword: 'chosen-password-456',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.mustChangePassword).toBe(false);
    expect((await agent.get('/api/auth/get-session')).body.user.mustChangePassword).toBe(false);
    expect((await agent.get('/api/platform/projects')).status).toBe(200);
  });

  it('returns the twoFactor challenge (never a session token) when the operator has 2FA enrolled', async () => {
    const dir = freshDir();
    await seedUser(dir, { email: '2fa@example.com', password: 'twofapass1', role: 'owner' });
    enable2fa(dir, '2fa@example.com');

    process.env.CONSOLE_ADMIN_EMAIL = 'ignored@example.com';
    process.env.CONSOLE_ADMIN_PASSWORD_HASH = bcrypt.hashSync('whatever1', 8);

    const app = await loadApp(dir);
    const agent = request.agent(app);

    const login = await agent.post('/api/platform/login').send({ email: '2fa@example.com', password: 'twofapass1' });
    expect(login.status).toBe(200);
    // The password step must NOT hand back a session token, 2FA is unverified.
    // Better Auth deletes the pre-2FA session, so any token it leaked via
    // set-auth-token points at nothing and the next request would 401.
    expect(login.body?.data?.token).toBeUndefined();
    expect(login.body?.data?.twoFactor).toBe(true);

    // A short-lived two-factor cookie is set to scope the follow-up verify call.
    expect(String(login.headers['set-cookie'] ?? '')).toContain('two_factor');
  });
});
