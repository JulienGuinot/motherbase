// Logs Explorer sources and query templates. Pure data, shared by the sidebar,
// the stream and the query mode.

/** Mirrors LOG_SERVICES in apps/server/lib/log-services.ts. */
export type LogService =
  | 'api'
  | 'rest'
  | 'postgres'
  | 'pooler'
  | 'auth'
  | 'storage'
  | 'realtime'
  | 'edge-function'
  | 'cron'
  | 'platform';

export interface LogSource {
  id: LogService;
  label: string;
  description: string;
}

/** In Supabase's order: the gateway first, then what sits behind it. */
export const LOG_SOURCES_BY_SERVICE: LogSource[] = [
  { id: 'api', label: 'API Gateway', description: 'Every HTTP request, whatever it reached.' },
  { id: 'rest', label: 'REST (Data API)', description: 'Requests to /rest/v1.' },
  { id: 'postgres', label: 'Postgres', description: 'Statements run from the SQL editor, migrations and schema changes.' },
  { id: 'pooler', label: 'Postgres connections', description: 'The data-plane pool opening, closing and losing connections.' },
  { id: 'auth', label: 'Auth', description: 'Sign-ins, sign-ups, sessions and the rest of /api/auth.' },
  { id: 'storage', label: 'Storage', description: 'Uploads, downloads and bucket operations.' },
  { id: 'realtime', label: 'Realtime', description: 'Socket connections, subscriptions and delivery.' },
  { id: 'edge-function', label: 'Edge Functions', description: 'Invocations and their console output.' },
  { id: 'cron', label: 'Cron', description: 'Scheduled jobs: backups, retention, scheduled functions.' },
  { id: 'platform', label: 'Platform', description: 'Everything else: webhooks, events, the process itself.' },
];

export function logSource(id: string | null | undefined): LogSource | undefined {
  return LOG_SOURCES_BY_SERVICE.find(source => source.id === id);
}

export interface LogQueryTemplate {
  id: string;
  label: string;
  description: string;
  sql: string;
}

/**
 * Starting points for the query mode, like Supabase's Logs Explorer
 * templates. They read `platform.request_logs`, the stored history, through
 * the read-only SQL endpoint.
 */
export const LOG_QUERY_TEMPLATES: LogQueryTemplate[] = [
  {
    id: 'recent-errors',
    label: 'Recent errors',
    description: 'The newest error lines, every source.',
    sql: `select at, service, source, message
from platform.request_logs
where level = 'error'
order by at desc
limit 100;`,
  },
  {
    id: 'status-codes',
    label: 'Requests by status code',
    description: 'How the last day of requests ended.',
    sql: `select status, count(*) as requests
from platform.request_logs
where method is not null and at > now() - interval '1 day'
group by status
order by requests desc;`,
  },
  {
    id: 'slowest-paths',
    label: 'Slowest endpoints',
    description: 'Average and worst latency per path over the last day.',
    sql: `select method, path, count(*) as requests,
  round(avg("durationMs")) as avg_ms, max("durationMs") as max_ms
from platform.request_logs
where method is not null and at > now() - interval '1 day'
group by method, path
order by avg_ms desc
limit 25;`,
  },
  {
    id: 'requests-per-minute',
    label: 'Requests per minute',
    description: 'Traffic over the last hour, split by service.',
    sql: `select date_trunc('minute', at) as minute, service, count(*) as requests
from platform.request_logs
where method is not null and at > now() - interval '1 hour'
group by 1, 2
order by 1 desc;`,
  },
  {
    id: 'auth-failures',
    label: 'Failed sign-ins',
    description: 'Auth requests that ended in 4xx, by caller address.',
    sql: `select ip, count(*) as failures, max(at) as last_seen
from platform.request_logs
where service = 'auth' and status between 400 and 499
group by ip
order by failures desc
limit 50;`,
  },
  {
    id: 'top-users',
    label: 'Most active users',
    description: 'Signed-in users by request count over the last day.',
    sql: `select "userId", count(*) as requests
from platform.request_logs
where "userId" is not null and at > now() - interval '1 day'
group by "userId"
order by requests desc
limit 25;`,
  },
  {
    id: 'edge-failures',
    label: 'Edge function failures',
    description: 'Failed invocations and their messages.',
    sql: `select at, message
from platform.request_logs
where service = 'edge-function' and level = 'error'
order by at desc
limit 100;`,
  },
];
