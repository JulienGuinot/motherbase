import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from '../console/auth/instance';
import { PlatformUsersService } from '../console/services/users.service';
import { migrateConsoleUsers } from '../console/scripts/migrate-console-users';

let dir: string;
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* db handle open */ } });

async function setup() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-migrate-'));
  const cfg: ConsoleAuthCfg = { projectsDir: dir, secret: 'x'.repeat(40), baseURL: 'http://localhost:4600', mode: 'dev' };
  await migrateConsoleAuth(cfg);
  const auth = createConsoleAuth(cfg);
  return { auth, users: new PlatformUsersService(auth) };
}

describe('migrateConsoleUsers', () => {
  it('imports legacy operators, preserving role/projects/disabled and bcrypt passwords', async () => {
    const { auth, users } = await setup();
    const jsonPath = path.join(dir, 'console-users.json');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { id: 'o1', email: 'owner@x.io', passwordHash: bcrypt.hashSync('ownerpass', 10), role: 'owner', projects: [], disabled: false, createdAt: new Date().toISOString() },
      { id: 'm1', email: 'member@x.io', passwordHash: bcrypt.hashSync('memberpass', 10), role: 'member', projects: ['alpha'], disabled: true, createdAt: new Date().toISOString() },
    ]));

    const result = await migrateConsoleUsers({ jsonPath, users });
    expect(result).toEqual({ migrated: 2, skipped: 0 });

    const owner = await users.findByEmail('owner@x.io');
    expect(owner?.role).toBe('owner');
    const member = await users.findByEmail('member@x.io');
    expect(member?.projects).toEqual(['alpha']);
    expect(member?.disabled).toBe(true);

    // The carried-over bcrypt hash still authenticates.
    const ok = await auth.api.signInEmail({ body: { email: 'owner@x.io', password: 'ownerpass' }, asResponse: true });
    expect(ok.status).toBe(200);
  });

  it('is idempotent: a second run skips already-migrated operators', async () => {
    const { users } = await setup();
    const jsonPath = path.join(dir, 'console-users.json');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { id: 'o1', email: 'dup@x.io', passwordHash: bcrypt.hashSync('pw', 10), role: 'admin', projects: [] },
    ]));

    expect(await migrateConsoleUsers({ jsonPath, users })).toEqual({ migrated: 1, skipped: 0 });
    expect(await migrateConsoleUsers({ jsonPath, users })).toEqual({ migrated: 0, skipped: 1 });
  });

  it('returns zero counts when the file is missing', async () => {
    const { users } = await setup();
    const result = await migrateConsoleUsers({ jsonPath: path.join(dir, 'nope.json'), users });
    expect(result).toEqual({ migrated: 0, skipped: 0 });
  });
});
