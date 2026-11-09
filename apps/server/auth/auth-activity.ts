import { logActivity } from '../lib/activity-log';

// Auth paths that every authenticated page hit triggers. Logging them would
// drown the stream in noise that says nothing about what a user did.
const SILENT_AUTH_PATHS = ['/get-session', '/jwks', '/token', '/ok', '/error', '/list-sessions'];

/** One `auth` log line per meaningful Better Auth endpoint, success or failure. */
export function logAuthActivity(path: string, userId?: string | null, error?: string | null): void {
  if (SILENT_AUTH_PATHS.some(silent => path === silent || path.startsWith(`${silent}/`))) return;
  const action = path.replace(/^\//, '');
  const who = userId ? ` user=${userId}` : '';
  logActivity(
    error ? 'warn' : 'info',
    'auth',
    error ? `[auth] ${action} rejected${who}: ${error}` : `[auth] ${action}${who}`
  );
}
