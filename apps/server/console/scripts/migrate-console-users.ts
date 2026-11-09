import fs from 'fs';
import path from 'path';
import { consoleConfig } from '../config';
import { createConsoleAuth, migrateConsoleAuth, type ConsoleAuthCfg } from '../auth/instance';
import { coerceRole } from '../auth/session';
import { PlatformUsersService, type UserRole } from '../services/users.service';

// One-shot migration of the legacy JSON operator store (console-users.json,
// used before the Better Auth cutover) into Better Auth. Existing bcrypt hashes
// are carried over verbatim via PlatformUsersService.provision, so operators keep their
// passwords. Idempotent: an email that already exists in the store is skipped.

interface LegacyUser {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  projects?: string[];
  disabled?: boolean;
  createdAt?: string;
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
}

export async function migrateConsoleUsers(opts: { jsonPath: string; users: PlatformUsersService }): Promise<MigrationResult> {
  let legacy: LegacyUser[];
  try {
    const raw = fs.readFileSync(opts.jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    legacy = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;
  for (const u of legacy) {
    const email = String(u?.email ?? '').trim();
    if (!email || !u.passwordHash) { skipped++; continue; }
    if (await opts.users.findByEmail(email)) { skipped++; continue; }
    await opts.users.provision({
      email,
      passwordHash: u.passwordHash,
      role: coerceRole(u.role),
      projects: Array.isArray(u.projects) ? u.projects : [],
      disabled: Boolean(u.disabled),
    });
    migrated++;
  }
  return { migrated, skipped };
}

// CLI: `ts-node console/scripts/migrate-console-users.ts`
if (require.main === module) {
  (async () => {
    const cfg: ConsoleAuthCfg = {
      projectsDir: consoleConfig.projectsDir,
      secret: (consoleConfig.jwtSecret || 'dev-console-secret').padEnd(32, 'x'),
      baseURL: process.env.CONSOLE_BASE_URL ?? `${consoleConfig.scheme}://localhost:${consoleConfig.port}`,
      mode: consoleConfig.mode,
    };
    await migrateConsoleAuth(cfg);
    const users = new PlatformUsersService(createConsoleAuth(cfg));
    const jsonPath = path.join(consoleConfig.projectsDir, 'console-users.json');
    const result = await migrateConsoleUsers({ jsonPath, users });
    console.log(`[console] migrated ${result.migrated} operator(s), skipped ${result.skipped}.`);
    if (result.migrated > 0 && fs.existsSync(jsonPath)) {
      const archived = `${jsonPath}.migrated`;
      fs.renameSync(jsonPath, archived);
      console.log(`[console] archived ${jsonPath} -> ${archived}`);
    }
    process.exit(0);
  })().catch(err => {
    console.error('[console] migration failed:', err);
    process.exit(1);
  });
}
