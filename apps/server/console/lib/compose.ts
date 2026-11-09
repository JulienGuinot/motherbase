import path from 'path';

export interface ComposeCtx {
  composeFile: string;
  envFile: string;
  project: string;
}

/**
 * Overlay merged into every project stack. It exists only to publish the
 * database port, which the base compose files deliberately leave unpublished.
 *
 * Included unconditionally rather than "when the project opted in", because
 * deciding that would mean reading the project's .env.prod before every compose
 * call. The overlay is written so that an absent DB_PORT is a harmless random
 * loopback port rather than an error, which makes the conditional unnecessary.
 * See the file's own header.
 */
export const DB_PORT_OVERLAY = 'docker-compose.db-port.yml';

function overlayFor(composeFile: string): string {
  return path.join(path.dirname(composeFile), DB_PORT_OVERLAY);
}

export type ComposeAction = 'up' | 'stop' | 'start' | 'restart' | 'down' | 'pull' | 'rebuild' | 'logs';

const REMOTE_IMAGE_SERVICES = ['minio', 'minio-init'] as const;

export interface ComposeOptions {
  pullApi?: boolean;
}

export function composeContextArgs(ctx: ComposeCtx): string[] {
  return [
    'compose',
    '-f',
    ctx.composeFile,
    '-f',
    overlayFor(ctx.composeFile),
    '--env-file',
    ctx.envFile,
    '-p',
    ctx.project,
  ];
}

export function composeArgs(ctx: ComposeCtx, action: ComposeAction, options: ComposeOptions = {}): string[] {
  const base = composeContextArgs(ctx);
  switch (action) {
    case 'up':
      return [...base, 'up', '-d', '--remove-orphans'];
    case 'down':
      return [...base, 'down', '-v', '--remove-orphans'];
    case 'restart':
      // Unlike `compose restart`, this also recovers a stopped/removed stack and
      // reapplies its current configuration.
      return [...base, 'up', '-d', '--force-recreate', '--remove-orphans'];
    case 'start':
      return [...base, 'up', '-d', '--remove-orphans'];
    case 'pull':
      // api/db are built and tagged locally by setup.sh. Pulling the whole stack
      // makes Compose query a registry where those images intentionally do not exist.
      return [...base, 'pull', ...REMOTE_IMAGE_SERVICES, ...(options.pullApi ? ['api'] : [])];
    case 'rebuild':
      return [...base, 'up', '--build', '-d', '--remove-orphans'];
    case 'logs':
      return [...base, 'logs', '--no-color', '--tail', '200'];
    case 'stop':
      return [...base, 'down', '--remove-orphans'];
    default:
      return [...base, action];
  }
}
