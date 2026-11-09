// MSW handlers for the Authentication pages added with Supabase auth parity
// (Audit Logs, and the settings-backed pages whose groups live in fixtures).
// Kept out of handlers.ts so that shared file only gains one spread.
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const ok = (data: unknown) => HttpResponse.json({ data });

/** Same dual registration as handlers.ts: bare and console-proxied admin paths. */
function admin(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [http[method](`/api/admin${path}`, resolver), http[method](`/api/projects/:pid/admin${path}`, resolver)];
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const AUDIT_ENTRIES = [
  { action: 'login', log_type: 'account', actor_id: 'usr_2', actor_username: 'user2@example.com', ip: '203.0.113.7', at: 3 },
  { action: 'token_refreshed', log_type: 'token', actor_id: 'usr_2', actor_username: 'user2@example.com', ip: '203.0.113.7', at: 9 },
  { action: 'user_signedup', log_type: 'team', actor_id: 'usr_4', actor_username: 'temp-9f2c1a@anonymous.invalid', ip: '198.51.100.23', at: 300, traits: { provider: 'anonymous' } },
  { action: 'user_recovery_requested', log_type: 'user', actor_id: '', actor_username: 'operator@example.com', ip: '192.0.2.10', at: 1440 },
  { action: 'user_deleted', log_type: 'team', actor_id: '00000000-0000-0000-0000-000000000000', actor_username: 'service_role', ip: '', at: 2880, traits: { user_id: 'usr_9', user_email: 'gone@example.com' } },
  { action: 'logout', log_type: 'account', actor_id: 'usr_1', actor_username: 'operator@example.com', ip: '192.0.2.10', at: 4320 },
].map((e, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  created_at: minutesAgo(e.at),
  ip_address: e.ip,
  payload: {
    action: e.action,
    actor_id: e.actor_id,
    actor_username: e.actor_username,
    actor_via_sso: false,
    log_type: e.log_type,
    ...(e.traits ? { traits: e.traits } : {}),
  },
}));

export const authHandlers: HttpHandler[] = [
  ...admin('get', '/auth/audit-logs', ({ request }) => {
    const params = new URL(request.url).searchParams;
    const action = params.get('action');
    const actor = params.get('actor')?.toLowerCase();
    const perPage = Number(params.get('per_page')) || 50;
    const page = Number(params.get('page')) || 1;
    const matching = AUDIT_ENTRIES.filter(
      e =>
        (!action || e.payload.action === action) &&
        (!actor || `${e.payload.actor_id} ${e.payload.actor_username}`.toLowerCase().includes(actor)),
    );
    return ok({
      entries: matching.slice((page - 1) * perPage, page * perPage),
      page,
      perPage,
      total: matching.length,
      actions: [...new Set(AUDIT_ENTRIES.map(e => e.payload.action))].sort(),
    });
  }),
];
