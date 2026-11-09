import path from 'path';
// Shared with config/env.ts so the two configs cannot drift. This module does
// NOT import config/env.ts: that would validate the project env schema and exit
// on a missing DATABASE_URL, which the Console has no reason to hold.
import {
  composeFileFor,
  domainSuffixFor,
  parseConsoleMode,
  schemeFor,
  DEV_PROJECTS_DIR,
  PROD_PROJECTS_DIR,
} from '../config/mode-defaults';

const mode = parseConsoleMode(process.env.CONSOLE_MODE);
const dev = mode === 'dev';

const defaultComposeFile = composeFileFor(mode);
const defaultProjectsDir = dev ? path.resolve(process.cwd(), DEV_PROJECTS_DIR) : PROD_PROJECTS_DIR;

// The bcrypt hash contains '$' (e.g. $2b$10$...), which Docker Compose mangles via
// its ${} interpolation on both the --env-file flag and the env_file: directive.
// So we transport the hash base64-encoded (alphabet has no '$') and decode here.
// CONSOLE_ADMIN_PASSWORD_HASH (raw) stays as a fallback for non-Compose setups.
function envFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[name]?.trim() ?? '');
}

function resolveAdminPasswordHash(): string {
  const b64 = process.env.CONSOLE_ADMIN_PASSWORD_HASH_B64;
  const raw = b64
    ? Buffer.from(b64, 'base64').toString('utf8').trim()
    : (process.env.CONSOLE_ADMIN_PASSWORD_HASH ?? '');
  // Self-heal: a valid bcrypt hash ($2a/$2b/$2y$NN$...) never contains consecutive
  // '$'. If Compose interpolation or a stray escaping step doubled them ($$), collapse
  // back so login keeps working instead of failing with a corrupted hash.
  return raw.replace(/\$\$+/g, '$');
}

/**
 * Fail closed when the console would sign owner sessions with a weak or absent
 * secret. Called from the server bootstrap, not at import: an operator running
 * `node console/server.js` with no CONSOLE_JWT_SECRET must not silently fall
 * back to a constant anyone can read in this repo. The shipped compose files
 * already pass `${CONSOLE_JWT_SECRET:?required}`, so this only closes the
 * bare-node path.
 */
export function assertConsoleSecret(cfg: { mode: 'dev' | 'prod'; jwtSecret: string }): void {
  if (cfg.mode === 'dev') return;
  if (!cfg.jwtSecret) {
    throw new Error('CONSOLE_JWT_SECRET is required in prod mode (generate with `openssl rand -hex 32`)');
  }
  if (cfg.jwtSecret.length < 32) {
    throw new Error('CONSOLE_JWT_SECRET must be at least 32 characters (generate with `openssl rand -hex 32`)');
  }
}

export const consoleConfig = {
  mode,
  scheme: schemeFor(mode),
  domainSuffix: domainSuffixFor(mode, process.env.PLATFORM_DOMAIN_SUFFIX ?? ''),
  port: Number(process.env.CONSOLE_PORT ?? 5500),
  // No production fallback: this signs console owner sessions, and a hardcoded
  // default is a public credential. Empty in prod is rejected at boot by
  // assertConsoleSecret() rather than at import time (config is imported by
  // tests and tooling that never serve traffic).
  jwtSecret: process.env.CONSOLE_JWT_SECRET ?? (dev ? 'dev-console-secret' : ''),
  adminEmail: process.env.CONSOLE_ADMIN_EMAIL ?? 'admin@example.com',
  adminPasswordHash: resolveAdminPasswordHash(),
  // Missing means false so existing installations are never locked unexpectedly.
  adminPasswordTemporary: envFlag('CONSOLE_ADMIN_PASSWORD_TEMPORARY'),
  projectsDir: process.env.PROJECTS_DIR ?? defaultProjectsDir,
  apiImage: process.env.API_IMAGE ?? 'motherbase-api:1.0.0',
  composeFile: path.resolve(
    process.env.COMPOSE_FILE ?? path.join(__dirname, '..', 'deploy', defaultComposeFile),
  ),
  traefikNetwork: process.env.TRAEFIK_NETWORK ?? 'traefik_proxy',
  certResolver: process.env.CERT_RESOLVER ?? 'letsencrypt',
  // Self-update release channel: a URL returning the newest published version
  // (manifest `{ version }`, `{ tags: [...] }`, or a Docker Hub tags response).
  // Empty = update checks disabled.
  updateCheckUrl: process.env.UPDATE_CHECK_URL ?? '',
  // Optional console surfaces. Off by default: a self-hosted install has no
  // metered vendor billing, so a Billing tab in the default nav is a promise the
  // product does not make. Operators reselling projects to clients turn it back
  // on with CONSOLE_BILLING_ENABLED=true.
  features: {
    billing: envFlag('CONSOLE_BILLING_ENABLED'),
  },
  // Preview projects: one isolated stack per pull request. Off unless a webhook
  // secret is configured, because a receiver with no secret verifies nothing.
  preview: {
    enabled: envFlag('PREVIEW_ENABLED') && Boolean(process.env.PREVIEW_GITHUB_SECRET),
    secret: process.env.PREVIEW_GITHUB_SECRET ?? '',
    // Needed only to post the "preview ready" comment back on the PR.
    githubToken: process.env.PREVIEW_GITHUB_TOKEN ?? '',
    // `owner/repo`, comma separated. Empty means no repository may provision:
    // an open receiver would let anyone who learns the URL spend this host's disk.
    repoAllowlist: (process.env.PREVIEW_REPO_ALLOWLIST ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
    // Sweeps stacks whose teardown webhook never arrived. 0 disables the sweep.
    ttlHours: Number(process.env.PREVIEW_TTL_HOURS ?? 72),
  },
};
