import path from 'path';
import Database from 'better-sqlite3';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { organization, bearer, twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { hashPassword, verifyPassword } from './password';

// Confirmed against better-auth@1.6.23 type defs:
// - toNodeHandler(auth) / fromNodeHeaders(req.headers)  (better-auth/node)
// - emailAndPassword.password.{hash:(pw)=>Promise<string>, verify:(data:{password,hash})=>Promise<boolean>}
// - user.additionalFields: Record<string, DBFieldAttribute{type,required,defaultValue,input,returned}>
// - organization() plugin from better-auth/plugins

export interface ConsoleAuthCfg {
  projectsDir: string;
  secret: string;
  baseURL: string;
  mode: string;
  // Extra origins to trust for Better Auth's CSRF/origin check, on top of the
  // request's own host (see `trustedOrigins` below). Typically the public
  // console URL(s) when it differs from `baseURL` (reverse proxy / custom domain).
  trustedOrigins?: string[];
}

/**
 * The Better Auth options for the console, shared by `createConsoleAuth` (which
 * feeds them to `betterAuth`) and `migrateConsoleAuth` (which feeds the same
 * options to `getMigrations`, so schema and instance never drift). Each call
 * opens its own better-sqlite3 handle on the same file; WAL makes concurrent
 * handles safe.
 */
export function consoleAuthOptions(cfg: ConsoleAuthCfg): BetterAuthOptions {
  const db = new Database(path.join(cfg.projectsDir, 'console-auth.db'));
  db.pragma('journal_mode = WAL');
  return {
    database: db,
    secret: cfg.secret,
    baseURL: cfg.baseURL,
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
      // Console operators are provisioned by an owner, never self-service.
      disableSignUp: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    user: {
      additionalFields: {
        // Global console role, authorized by the console's own requireRole.
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
        // Mirrors the legacy `disabled` flag (kept as a field rather than ban
        // semantics so behavior is identical to the JSON store).
        disabled: { type: 'boolean', required: false, defaultValue: false, input: false },
        // Generated/bootstrap and owner-assigned passwords are temporary.
        // Existing accounts default to false for backward compatibility.
        mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    // Better Auth runs a CSRF/origin check on state-changing auth routes
    // (e.g. sign-in) whenever the request carries a cookie, which a reverse
    // proxy like Cloudflare/Traefik may inject even for CLI callers. By default
    // only `baseURL` is trusted, so a CLI hitting the public domain gets
    // "Invalid origin". We additionally trust the request's OWN host (a match is
    // same-origin, i.e. not a cross-site request) plus any explicit origins.
    // This keeps CSRF protection (a foreign site still has a different Origin)
    // while working on any deployment domain out of the box.
    trustedOrigins: async request => {
      const origins = new Set<string>(cfg.trustedOrigins ?? []);
      const host = request?.headers?.get?.('host');
      if (host) {
        origins.add(`https://${host}`);
        origins.add(`http://${host}`);
      }
      return [...origins];
    },
    advanced: {
      cookiePrefix: 'console',
      useSecureCookies: cfg.mode !== 'dev',
    },
    // Organizations ARE project scope (UsersService.projectsByUser matches
    // organization.name to a project id), so users must never create their own:
    // membership rows are written only by UsersService.
    // bearer: lets non-browser clients (the CLI) authenticate with a token
    // instead of a cookie. organization: project memberships. twoFactor: opt-in
    // TOTP for console operators (no email/SMS channel here. Authenticator app
    // + backup codes only). Enrolling changes the sign-in flow (see server.ts:
    // /api/platform/login handles the twoFactorRedirect step).
    plugins: [organization({ allowUserToCreateOrganization: false }), bearer(), twoFactor({ issuer: 'Motherbase Console' })],
  };
}

export function createConsoleAuth(cfg: ConsoleAuthCfg) {
  return betterAuth(consoleAuthOptions(cfg));
}

/**
 * Create/upgrade the console-auth SQLite schema (Better Auth core + organization
 * plugin tables). Idempotent. Safe to run at every boot. Uses Better Auth's own
 * migration engine so the schema always matches `consoleAuthOptions`.
 */
export async function migrateConsoleAuth(cfg: ConsoleAuthCfg): Promise<void> {
  const { runMigrations } = await getMigrations(consoleAuthOptions(cfg));
  await runMigrations();
}

export type AuthInstance = ReturnType<typeof createConsoleAuth>;
