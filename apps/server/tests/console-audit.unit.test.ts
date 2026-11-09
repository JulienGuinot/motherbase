import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesForRole } from '../console/auth/capabilities';
import { platformRouter } from '../console/routes/platform.routes';
import { classifyAdminProxyMutation } from '../console/routes/proxy.routes';
import { usersRouter } from '../console/routes/users.routes';
import {
  AuditStore,
  normalizeAuditIp,
  parseAuditLimit,
  sanitizeAuditDetail,
} from '../console/services/audit.service';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const actor = {
  id: 'operator-1',
  email: 'operator@example.com',
  role: 'owner' as const,
  projects: ['alpha'],
  mustChangePassword: false,
};

function append(store: AuditStore, action: string) {
  return store.append({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    ip: '192.0.2.10',
    action,
    target: 'project:alpha',
    success: true,
  });
}

function session(user = actor) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  };
}

function platformApp(audit: AuditStore, user: any = actor, extras: any = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/platform', platformRouter({
    orchestrator: extras.orchestrator ?? {},
    registry: extras.registry ?? { get: vi.fn().mockResolvedValue({ name: 'alpha' }), list: vi.fn().mockResolvedValue([]) },
    users: extras.users,
    audit,
    requireSession: session(user),
    cfg: { mode: 'dev', domainSuffix: 'localhost' },
  } as any));
  return app;
}

describe('persistent operator audit store', () => {
  it('persists structured events independently and returns newest first', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'motherbase-audit-'));
    tempDirs.push(dir);
    const first = AuditStore.open(dir);
    const file = path.join(dir, 'console-audit.db');
    expect(existsSync(file)).toBe(true);
    append(first, 'project.create');
    if (process.platform !== 'win32') {
      for (const auditFile of [file, `${file}-wal`, `${file}-shm`]) {
        if (existsSync(auditFile)) expect(statSync(auditFile).mode & 0o777).toBe(0o600);
      }
    }
    first.close();

    const reopened = AuditStore.open(dir);
    append(reopened, 'project.delete');
    expect(reopened.list()).toMatchObject([
      { action: 'project.delete', actorEmail: actor.email, success: true, detail: {} },
      { action: 'project.create', actorEmail: actor.email, success: true, detail: {} },
    ]);
    reopened.close();
  });

  it('enforces bounded retention on every append', () => {
    const store = new AuditStore(':memory:', { maxEntries: 2 });
    append(store, 'one');
    append(store, 'two');
    append(store, 'three');
    expect(store.list().map(event => event.action)).toEqual(['three', 'two']);
    store.close();
  });

  it('adds the IP column when opening an audit database created by an older schema', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'motherbase-audit-legacy-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'console-audit.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE audit_event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        actorId TEXT NOT NULL,
        actorEmail TEXT NOT NULL,
        actorRole TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        success INTEGER NOT NULL,
        detail TEXT NOT NULL
      )
    `);
    legacy.close();

    const migrated = AuditStore.open(dir);
    append(migrated, 'project.create');
    expect(migrated.list()[0].ip).toBe('192.0.2.10');
    migrated.close();
  });

  it('drops sensitive detail keys and credential-like values', () => {
    const detail = sanitizeAuditDetail({
      statusCode: 200,
      fields: ['role', 'passwordReset'],
      password: 'never-store-me',
      accessToken: 'never-store-this-either',
      harmless: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature123',
      nestedBody: { secret: 'hidden' },
    });
    expect(detail).toEqual({ statusCode: 200, fields: ['role', 'passwordReset'] });
    expect(JSON.stringify(detail)).not.toContain('never-store');
  });

  it('validates API limits strictly', () => {
    expect(parseAuditLimit(undefined)).toBe(100);
    expect(parseAuditLimit('1')).toBe(1);
    expect(parseAuditLimit('500')).toBe(500);
    for (const invalid of ['0', '501', '1.5', 'abc', ['10']]) expect(parseAuditLimit(invalid)).toBeUndefined();
  });

  it('normalizes IPv4, mapped IPv4 and IPv6 without accepting arbitrary input', () => {
    expect(normalizeAuditIp('192.0.2.10')).toBe('192.0.2.10');
    expect(normalizeAuditIp('::ffff:192.0.2.10')).toBe('192.0.2.10');
    expect(normalizeAuditIp('2001:DB8::A')).toBe('2001:db8::a');
    expect(normalizeAuditIp('198.51.100.4\nsecret')).toBe('unknown');
    expect(normalizeAuditIp('not-an-ip')).toBe('unknown');
  });
});

describe('operator audit routes and instrumentation', () => {
  it('protects GET /audit with audit.read and validates limit', async () => {
    const audit = new AuditStore(':memory:');
    append(audit, 'seed');

    const admin = { ...actor, role: 'admin' as const };
    expect(capabilitiesForRole(admin.role)).toContain('audit.read');
    const ok = await request(platformApp(audit, admin)).get('/api/platform/audit?limit=1');
    expect(ok.status).toBe(200);
    expect(ok.body.data.events).toHaveLength(1);
    expect(Object.keys(ok.body.data.events[0]).sort()).toEqual([
      'action', 'actorEmail', 'actorId', 'actorRole', 'at', 'detail', 'id', 'ip', 'success', 'target',
    ]);
    expect((await request(platformApp(audit, admin)).get('/api/platform/audit?limit=501')).status).toBe(400);

    const readOnly = { ...actor, role: 'read_only' as const };
    expect((await request(platformApp(audit, readOnly)).get('/api/platform/audit')).status).toBe(403);
    audit.close();
  });

  it('records successful and denied platform mutations without password bodies', async () => {
    const audit = new AuditStore(':memory:');
    const users = {
      findById: vi.fn().mockResolvedValue(actor),
      verifyPassword: vi.fn().mockResolvedValue(true),
      setPassword: vi.fn().mockResolvedValue(actor),
    };
    const password = await request(platformApp(audit, actor, { users }))
      .post('/api/platform/account/password')
      .send({ currentPassword: 'old-password-secret', newPassword: 'new-password-secret' });
    expect(password.status).toBe(200);

    const developer = { ...actor, role: 'developer' as const };
    const denied = await request(platformApp(audit, developer))
      .patch('/api/platform/projects/alpha/config')
      .send({ domain: 'api.example.com' });
    expect(denied.status).toBe(403);

    const events = audit.list();
    expect(events).toMatchObject([
      { action: 'project.settings.update', target: 'project:alpha', ip: '127.0.0.1', success: false, detail: { statusCode: 403 } },
      { action: 'account.password.change', target: 'account:self', ip: '127.0.0.1', success: true, detail: { statusCode: 200 } },
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('old-password-secret');
    expect(serialized).not.toContain('new-password-secret');
    audit.close();
  });

  it('records user management while replacing password with a non-sensitive field label', async () => {
    const audit = new AuditStore(':memory:');
    const users = {
      findById: vi.fn().mockResolvedValue({ ...actor, id: 'target-user', role: 'developer' }),
      ownerCount: vi.fn().mockResolvedValue(2),
      update: vi.fn().mockResolvedValue({ ...actor, id: 'target-user', role: 'developer' }),
    };
    const app = express();
    app.use(express.json());
    app.use('/api/platform/users', usersRouter({ users: users as any, requireSession: session(), audit }));

    const response = await request(app)
      .patch('/api/platform/users/target-user')
      .send({ disabled: true, password: 'temporary-password' });
    expect(response.status).toBe(200);
    expect(audit.list()[0]).toMatchObject({
      action: 'user.update',
      target: 'user:target-user',
      success: true,
      detail: { fields: ['disabled', 'passwordReset'], statusCode: 200 },
    });
    expect(JSON.stringify(audit.list()[0])).not.toContain('temporary-password');
    audit.close();
  });

  it('classifies admin proxy mutations without retaining URL suffixes or bodies', () => {
    const mutation = classifyAdminProxyMutation({
      method: 'POST',
      params: { id: 'alpha' },
      originalUrl: '/api/projects/alpha/admin/edge-secrets/private-name?token=super-secret',
      body: { token: 'super-secret' },
    } as any);
    expect(mutation).toEqual({
      action: 'project.admin.edge-secrets.post',
      target: 'project:alpha',
      detail: { capability: 'secrets.manage' },
    });
    expect(JSON.stringify(mutation)).not.toContain('super-secret');
    expect(JSON.stringify(mutation)).not.toContain('private-name');
  });
});
