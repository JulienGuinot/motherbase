import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createConsoleAuth, migrateConsoleAuth, consoleAuthOptions } from '../console/auth/instance';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-auth-'));

describe('createConsoleAuth', () => {
  let dir: string;
  // better-sqlite3 keeps the DB (+WAL) file handle open for the process lifetime,
  // so on Windows the temp dir can't be removed until GC closes it. Best-effort.
  afterEach(() => {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* handle still open */ }
  });

  it('boots an instance with a handler and api', () => {
    dir = tmp();
    const auth = createConsoleAuth({ projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' });
    expect(typeof auth.handler).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
  });

  // Locks the console (motherbase operator) auth to email + password only. The
  // project-side "full Better Auth power" work must never leak social providers or
  // self-service signup into the console instance.
  it('stays password-only: no social providers, signup disabled', () => {
    dir = tmp();
    const opts = consoleAuthOptions({ projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' });
    expect(opts.socialProviders ?? {}).toEqual({});
    expect(opts.emailAndPassword?.disableSignUp).toBe(true);
  });

  it('migrateConsoleAuth creates the core + organization tables', async () => {
    dir = tmp();
    const cfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
    await migrateConsoleAuth(cfg);
    await migrateConsoleAuth(cfg); // boot migrations stay idempotent
    const db = new Database(path.join(dir, 'console-auth.db'), { readonly: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name),
    );
    const userColumns = new Set(
      (db.prepare("PRAGMA table_info('user')").all() as { name: string }[]).map(column => column.name),
    );
    db.close();
    expect(userColumns.has('mustChangePassword')).toBe(true);
    for (const t of ['user', 'account', 'session', 'verification', 'organization', 'member']) {
      expect(tables.has(t), `table ${t} should exist`).toBe(true);
    }
  });

  // Organizations are the console's project scope (membership is matched by
  // organization.name), so a self-service org named after a victim project
  // would grant that project. Creation is reserved to UsersService.
  it('refuses self-service organization creation', async () => {
    dir = tmp();
    const cfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
    await migrateConsoleAuth(cfg);
    const auth = createConsoleAuth(cfg);
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: 'op@example.com', name: 'op', emailVerified: true }, { method: 'admin' });
    const session = await ctx.internalAdapter.createSession(user.id);
    const res = await auth.handler(new Request('http://localhost:4600/api/auth/organization/create', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json', origin: 'http://localhost:4600' },
      body: JSON.stringify({ name: 'victim-project', slug: 'victim-project' }),
    }));
    expect(res.status).toBe(403);
  });
});
