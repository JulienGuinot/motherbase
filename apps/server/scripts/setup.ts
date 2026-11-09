/**
 * Legacy local-only setup wizard.
 *
 * The supported project setup entrypoint is `./setup.sh`.
 *
 * Steps: prerequisite checks → generate .env → optional infra → migrate →
 * seed admin → print a summary with every URL you need.
 */
import { config } from 'dotenv';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import {
  parseArgs,
  defaultAnswers,
  buildEnvFile,
  generateSecret,
  parseDbHostPort,
  type SetupAnswers,
} from './setup.lib';

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// --- tiny ANSI helpers (no dependency) ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const ok = (m: string) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m: string) => console.log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m: string) => console.log(`${c.red}✗${c.reset} ${m}`);
const step = (m: string) => console.log(`\n${c.bold}${c.cyan}▸ ${m}${c.reset}`);

function commandExists(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function tcpOpen(host: string, port: number, timeout = 800): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  console.log(`${c.dim}$ ${cmd} ${args.join(' ')}${c.reset}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env, shell: process.platform === 'win32' });
  return r.status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: ts-node scripts/setup.ts [--yes]\n\n  Prefer ./setup.sh for the supported setup flow.');
    return;
  }

  console.log(`\n${c.bold}🚀 Backend Quickstart: setup wizard${c.reset}\n`);

  // 1) Prerequisites
  step('Checking prerequisites');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node} (need >= 18)`);
  const hasDocker = commandExists('docker');
  if (hasDocker) ok('Docker found');
  else warn('Docker not found, you can still use an existing PostgreSQL');

  const rl = createInterface({ input, output });
  const ask = async (q: string, def: string): Promise<string> => {
    if (args.yes) return def;
    const a = (await rl.question(`${q} ${c.dim}(${def})${c.reset} `)).trim();
    return a || def;
  };
  const askYesNo = async (q: string, def = true): Promise<boolean> => {
    if (args.yes) return def;
    const a = (await rl.question(`${q} ${c.dim}(${def ? 'Y/n' : 'y/N'})${c.reset} `)).trim().toLowerCase();
    if (!a) return def;
    return a.startsWith('y');
  };

  try {
    // 2) .env
    step('Configuring environment (.env)');
    // Seed defaults from the environment so non-interactive installs (`--yes`)
    // and CI can pass DATABASE_URL / PORT / SEED_ADMIN_* without prompts.
    let answers: SetupAnswers = { ...defaultAnswers(), ...envOverrides() };

    if (fs.existsSync(ENV_PATH)) {
      const overwrite = await askYesNo('.env already exists. Overwrite it?', false);
      if (!overwrite) {
        warn('Keeping existing .env. Skipping config generation.');
        config({ path: ENV_PATH });
        answers = { ...answers, ...readSeedFromEnv() };
      } else {
        answers = await collect(answers, ask, askYesNo);
        writeEnv(answers);
      }
    } else {
      answers = await collect(answers, ask, askYesNo);
      writeEnv(answers);
    }

    // 3) Infra: probe the database the chosen DATABASE_URL actually points at.
    const db = parseDbHostPort(answers.databaseUrl);
    const dbUp = await tcpOpen(db.host, db.port);
    if (dbUp) {
      ok(`PostgreSQL reachable on ${db.host}:${db.port}`);
    } else if (hasDocker && (await askYesNo('Start PostgreSQL + MinIO via Docker now?', true))) {
      step('Starting infra (docker compose up db minio -d)');
      if (!run('docker', ['compose', 'up', 'db', 'minio', '-d'])) {
        warn('docker compose v2 failed; trying docker-compose');
        run('docker-compose', ['up', 'db', 'minio', '-d']);
      }
      await waitForPort(db.host, db.port, 30);
    } else {
      warn('No reachable database. Set DATABASE_URL in .env, then re-run setup.');
    }

    // 4) Prisma + seed (only if DB is reachable)
    if (await tcpOpen(db.host, db.port)) {
      step('Applying database schema (prisma migrate)');
      run('npx', ['prisma', 'generate']);
      if (!run('npx', ['prisma', 'migrate', 'deploy'])) {
        run('npx', ['prisma', 'migrate', 'dev', '--name', 'init']);
      }

      if (await askYesNo('Seed the default admin user?', true)) {
        step('Seeding admin user');
        run('npx', ['ts-node', 'prisma/seed.ts']);
      }
    } else {
      warn('Skipping migrations/seed: database not reachable yet.');
    }

    // 5) Summary
    printSummary(answers);
  } finally {
    rl.close();
  }
}

/** Pre-fill answers from environment variables when present (CI / non-interactive). */
function envOverrides(): Partial<SetupAnswers> {
  const o: Partial<SetupAnswers> = {};
  if (process.env.DATABASE_URL) o.databaseUrl = process.env.DATABASE_URL;
  if (process.env.PORT) o.port = Number(process.env.PORT) || undefined;
  if (process.env.STORAGE_DRIVER === 's3' || process.env.STORAGE_DRIVER === 'local') {
    o.storageDriver = process.env.STORAGE_DRIVER;
  }
  if (process.env.SEED_ADMIN_EMAIL) o.seedAdminEmail = process.env.SEED_ADMIN_EMAIL;
  if (process.env.SEED_ADMIN_PASSWORD) o.seedAdminPassword = process.env.SEED_ADMIN_PASSWORD;
  // strip undefined so the spread doesn't clobber defaults
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<SetupAnswers>;
}

function readSeedFromEnv(): Partial<SetupAnswers> {
  return {
    seedAdminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@example.com',
    seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || generateSecret(24),
    port: Number(process.env.PORT) || 5001,
  };
}

async function collect(
  base: SetupAnswers,
  ask: (q: string, def: string) => Promise<string>,
  askYesNo: (q: string, def?: boolean) => Promise<boolean>
): Promise<SetupAnswers> {
  const a: SetupAnswers = { ...base, jwtSecret: generateSecret() };

  // Server
  a.databaseUrl = await ask('Database URL', a.databaseUrl);
  a.port = Number(await ask('API port', String(a.port))) || a.port;

  // Storage
  const useS3 = await askYesNo('Use S3/MinIO for storage (vs local disk)?', false);
  a.storageDriver = useS3 ? 's3' : 'local';

  // CORS
  a.corsOrigins = await ask(
    'CORS allowed origins (comma-separated; leave empty to allow all. Dev only)',
    a.corsOrigins,
  );

  // SQL console
  // Restricting it to reads is a Studio setting (Database > Settings), not a setup answer.
  a.consoleSqlEnabled = await askYesNo('Enable the SQL editor in the console?', a.consoleSqlEnabled);

  // Admin seed
  a.seedAdminEmail = await ask('Admin email', a.seedAdminEmail);
  a.seedAdminPassword = await ask('Admin password', a.seedAdminPassword);

  ok('A strong JWT_SECRET was generated for you.');
  return a;
}

function writeEnv(a: SetupAnswers) {
  fs.writeFileSync(ENV_PATH, buildEnvFile(a), 'utf8');
  ok(`Wrote ${path.relative(ROOT, ENV_PATH)}`);
}

async function waitForPort(host: string, port: number, tries: number) {
  for (let i = 0; i < tries; i++) {
    if (await tcpOpen(host, port)) {
      ok(`Database is up on ${host}:${port}`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  warn(`Timed out waiting for ${host}:${port}`);
}

function printSummary(a: SetupAnswers) {
  const base = `http://localhost:${a.port}`;
  console.log(`\n${c.bold}${c.green}✅ Setup complete!${c.reset}\n`);
  console.log(`  Supported setup entrypoint:  ${c.bold}./setup.sh${c.reset}\n`);
  console.log(`  ${c.bold}URLs${c.reset}`);
  console.log(`    API           ${base}`);
  console.log(`    Admin (legacy)${base}/admin`);
  console.log(`    API docs      ${base}/api/docs`);
  console.log(`    Health        ${base}/api/health-check\n`);
}

main().catch(err => {
  fail(err?.message ?? String(err));
  process.exit(1);
});
