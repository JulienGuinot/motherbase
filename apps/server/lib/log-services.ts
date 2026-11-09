/**
 * The log sources of the Logs Explorer, named after Supabase's.
 *
 * `source` on a line is whatever the subsystem that wrote it calls itself
 * (`http`, `sql`, `job`, `edge`, ...) and is free-form; `service` is this
 * fixed taxonomy, so a screen, the CLI and the MCP `get_logs` tool can ask for
 * "Auth logs" without knowing which subsystem tags exist today.
 *
 * `api` is the API gateway: asked for, it means every HTTP request whatever
 * it reached, the way Supabase's edge logs are. A request line is stored under
 * the service it reached (`rest`, `auth`, `storage`, ...), and under `api`
 * only when it reached none of them.
 */
export const LOG_SERVICES = [
  'api',
  'rest',
  'postgres',
  'pooler',
  'auth',
  'storage',
  'realtime',
  'edge-function',
  'cron',
  'platform',
] as const;

export type LogService = (typeof LOG_SERVICES)[number];

export function isLogService(value: unknown): value is LogService {
  return typeof value === 'string' && (LOG_SERVICES as readonly string[]).includes(value);
}

/** Request paths, first match wins. Mirrors HTTP_ROUTES in @motherbase/contracts. */
const PATH_SERVICES: Array<[RegExp, LogService]> = [
  [/^\/rest\/v1(?:\/|$)/, 'rest'],
  [/^\/api\/auth(?:\/|$)/, 'auth'],
  [/^\/api\/(?:storage|files)(?:\/|$)/, 'storage'],
  [/^\/realtime\/v1(?:\/|$)/, 'realtime'],
  [/^\/api\/edge(?:\/|$)/, 'edge-function'],
];

/** Subsystem tags that already say which service they belong to. */
const SOURCE_SERVICES: Record<string, LogService> = {
  sql: 'postgres',
  schema: 'postgres',
  pooler: 'pooler',
  auth: 'auth',
  storage: 'storage',
  realtime: 'realtime',
  edge: 'edge-function',
  job: 'cron',
};

/**
 * The service a line belongs to. A request line is classified by the path it
 * called, anything else by the subsystem that wrote it; what matches neither
 * (console, process, webhook delivery, ...) is `platform`. An explicit
 * `service` on the line always wins.
 */
export function logServiceOf(line: { source: string; path?: string; service?: LogService }): LogService {
  if (line.service) return line.service;
  if (line.path) {
    for (const [pattern, service] of PATH_SERVICES) if (pattern.test(line.path)) return service;
    if (line.source === 'http') return 'api';
  }
  return SOURCE_SERVICES[line.source] ?? 'platform';
}
