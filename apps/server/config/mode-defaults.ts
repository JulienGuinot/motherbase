/**
 * Defaults derived from CONSOLE_MODE, shared by the project API (`config/env.ts`)
 * and the Platform Console (`console/config.ts`).
 *
 * The two configs stay separate on purpose: importing `config/env.ts` from the
 * Console would validate the project schema and `process.exit(1)` on a missing
 * DATABASE_URL, which the Console does not have. This module holds only the
 * values both of them derive from the mode, so they cannot drift apart.
 *
 * Callers resolve the compose file against their own base directory: the API
 * uses `process.cwd()`, the Console its runtime directory.
 */
export type ConsoleMode = 'dev' | 'prod';

export const DEV_PROJECTS_DIR = '.dev-projects';
export const PROD_PROJECTS_DIR = '/srv/projects';

export function parseConsoleMode(value: string | undefined): ConsoleMode {
  return value === 'dev' ? 'dev' : 'prod';
}

/** Compose file name (not path) used for project stacks in this mode. */
export function composeFileFor(mode: ConsoleMode): string {
  return mode === 'dev' ? 'docker-compose.dev-multi.yml' : 'docker-compose.prod.yml';
}

export function schemeFor(mode: ConsoleMode): 'http' | 'https' {
  return mode === 'dev' ? 'http' : 'https';
}

/** Base domain new project hostnames hang off. Dev resolves locally. */
export function domainSuffixFor(mode: ConsoleMode, configured = ''): string {
  return mode === 'dev' ? 'localhost' : configured;
}
