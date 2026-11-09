// MSW handlers for Queues, Vault, Wrappers and the index advisor, so
// `npm run studio:mock` renders those pages with no backend. State is kept in
// module scope and mutated by the write handlers, so a session round-trips:
// create a queue and it is listed, send to it and the message is there.
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';
import type { ForeignServer, ForeignTable, WrapperInfo } from '@/features/integrations/api/wrappers.api';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const ok = (data: unknown) => HttpResponse.json(JSON.parse(JSON.stringify({ data })));
const fail = (status: number, message: string) => HttpResponse.json({ success: false, message }, { status });
const body = async (request: Request) => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, any>;

// Same double registration as handlers.ts: bare and console-proxy prefixes.
function admin(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [http[method](`/api/admin${path}`, resolver), http[method](`/api/projects/:pid/admin${path}`, resolver)];
}

const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// ── Queues ──────────────────────────────────────────────────────────────────

interface MockMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: unknown;
  headers: null;
  archived_at?: string;
}

const queueState = { installed: true, exposed: false };
let nextMsgId = 4;
const queues = new Map([
  [
    'email_jobs',
    {
      info: { name: 'email_jobs', type: 'basic', createdAt: ago(60 * 24 * 3), rlsEnabled: true },
      messages: [1, 2, 3].map(id => ({
        msg_id: id,
        read_ct: id === 1 ? 1 : 0,
        enqueued_at: ago(10 - id),
        vt: ago(10 - id),
        message: { to: `user${id}@example.com`, template: 'welcome' },
        headers: null,
      })) as MockMessage[],
      archive: [] as MockMessage[],
      permissions: {
        rlsEnabled: true,
        roles: {
          anon: { select: false, insert: false, update: false, delete: false },
          authenticated: { select: true, insert: true, update: true, delete: false },
        },
      },
    },
  ],
]);

function queueInfo(entry: NonNullable<ReturnType<typeof queues.get>>) {
  const oldest = entry.messages.reduce<string | null>((min, m) => (!min || m.enqueued_at < min ? m.enqueued_at : min), null);
  return {
    ...entry.info,
    length: entry.messages.length,
    visibleLength: entry.messages.filter(m => m.vt <= now()).length,
    oldestMsgAgeSec: oldest ? Math.round((Date.now() - Date.parse(oldest)) / 1000) : null,
    newestMsgAgeSec: entry.messages.length ? 5 : null,
    totalMessages: entry.messages.length + entry.archive.length,
  };
}

const queueHandlers: HttpHandler[] = [
  ...admin('get', '/queues', () =>
    ok({ available: true, version: '1.12.0', partitionedAvailable: false, ...queueState, queues: [...queues.values()].map(queueInfo) }),
  ),
  ...admin('post', '/queues/enable', () => {
    queueState.installed = true;
    return ok(queueState);
  }),
  ...admin('put', '/queues/expose', async ({ request }) => {
    queueState.exposed = Boolean((await body(request)).enabled);
    return ok(queueState);
  }),
  ...admin('post', '/queues', async ({ request }) => {
    const { name, type = 'basic', rls = true } = await body(request);
    if (queues.has(name)) return fail(409, `Queue "${name}" already exists`);
    const none = { select: false, insert: false, update: false, delete: false };
    queues.set(name, {
      info: { name, type, createdAt: now(), rlsEnabled: rls },
      messages: [],
      archive: [],
      permissions: { rlsEnabled: rls, roles: { anon: { ...none }, authenticated: { ...none } } },
    });
    return ok({ queue: queueInfo(queues.get(name)!) });
  }),
  ...admin('delete', '/queues/:name', ({ params }) => {
    queues.delete(String(params.name));
    return ok({});
  }),
  ...admin('post', '/queues/:name/purge', ({ params }) => {
    const entry = queues.get(String(params.name));
    const purged = entry?.messages.length ?? 0;
    if (entry) entry.messages = [];
    return ok({ purged });
  }),
  ...admin('get', '/queues/:name/messages', ({ params, request }) => {
    const entry = queues.get(String(params.name));
    if (!entry) return fail(404, 'Queue not found');
    const url = new URL(request.url);
    const list = url.searchParams.get('archived') === 'true' ? entry.archive : entry.messages;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return ok({ messages: [...list].reverse().slice(offset, offset + limit), total: list.length });
  }),
  ...admin('post', '/queues/:name/messages', async ({ params, request }) => {
    const entry = queues.get(String(params.name));
    if (!entry) return fail(404, 'Queue not found');
    const { message, delay = 0 } = await body(request);
    const id = nextMsgId++;
    entry.messages.push({ msg_id: id, read_ct: 0, enqueued_at: now(), vt: new Date(Date.now() + delay * 1000).toISOString(), message, headers: null });
    return ok({ msgIds: [id] });
  }),
  ...admin('post', '/queues/:name/read', async ({ params, request }) => {
    const entry = queues.get(String(params.name));
    if (!entry) return fail(404, 'Queue not found');
    const { vt = 30, qty = 1 } = await body(request);
    const read = entry.messages.filter(m => m.vt <= now()).slice(0, qty);
    for (const m of read) {
      m.read_ct += 1;
      m.vt = new Date(Date.now() + vt * 1000).toISOString();
    }
    return ok({ messages: read });
  }),
  ...admin('post', '/queues/:name/messages/:msgId/archive', ({ params }) => {
    const entry = queues.get(String(params.name));
    const message = entry?.messages.find(m => m.msg_id === Number(params.msgId));
    if (!entry || !message) return fail(404, 'Message not found');
    entry.messages = entry.messages.filter(m => m !== message);
    entry.archive.push({ ...message, archived_at: now() });
    return ok({});
  }),
  ...admin('delete', '/queues/:name/messages/:msgId', ({ params }) => {
    const entry = queues.get(String(params.name));
    if (entry) entry.messages = entry.messages.filter(m => m.msg_id !== Number(params.msgId));
    return ok({});
  }),
  ...admin('get', '/queues/:name/permissions', ({ params }) => ok(queues.get(String(params.name))?.permissions)),
  ...admin('put', '/queues/:name/permissions', async ({ params, request }) => {
    const entry = queues.get(String(params.name));
    if (!entry) return fail(404, 'Queue not found');
    const patch = await body(request);
    entry.permissions = { ...entry.permissions, ...patch, roles: { ...entry.permissions.roles, ...patch.roles } };
    entry.info.rlsEnabled = entry.permissions.rlsEnabled;
    return ok(entry.permissions);
  }),
];

// ── Vault ───────────────────────────────────────────────────────────────────

const vaultState = { enabled: true, keyConfigured: true };
const secrets = new Map([
  ['6f1c2a9e-0000-4000-8000-000000000001', { name: 'stripe_api_key', description: 'Stripe secret key', value: 'sk_test_mock_51Hc', updatedAt: ago(90) }],
  ['6f1c2a9e-0000-4000-8000-000000000002', { name: 'fdw_analytics_db', description: 'Password for foreign server "analytics_db" (Wrappers)', value: 'mock-password', updatedAt: ago(600) }],
]);

const secretView = (id: string) => {
  const s = secrets.get(id)!;
  return { id, name: s.name, description: s.description, keyId: 'mock-key', keyMatches: true, createdAt: ago(60 * 24), updatedAt: s.updatedAt };
};

const vaultHandlers: HttpHandler[] = [
  ...admin('get', '/vault', () => ok({ ...vaultState, secrets: [...secrets.keys()].map(secretView) })),
  ...admin('post', '/vault/enable', () => {
    vaultState.enabled = true;
    return ok(vaultState);
  }),
  ...admin('post', '/vault/secrets', async ({ request }) => {
    const { name, secret, description = '' } = await body(request);
    const id = crypto.randomUUID();
    secrets.set(id, { name, description, value: secret, updatedAt: now() });
    return ok({ secret: secretView(id) });
  }),
  ...admin('get', '/vault/secrets/:id/reveal', ({ params }) => ok({ secret: secrets.get(String(params.id))?.value ?? '' })),
  ...admin('patch', '/vault/secrets/:id', async ({ params, request }) => {
    const current = secrets.get(String(params.id));
    if (!current) return fail(404, 'Secret not found');
    const patch = await body(request);
    secrets.set(String(params.id), {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      value: patch.secret ?? current.value,
      updatedAt: now(),
    });
    return ok({ secret: secretView(String(params.id)) });
  }),
  ...admin('delete', '/vault/secrets/:id', ({ params }) => {
    secrets.delete(String(params.id));
    return ok({});
  }),
];

// ── Wrappers ────────────────────────────────────────────────────────────────

const wrappers: WrapperInfo[] = [
  { name: 'postgres_fdw', available: true, installed: true },
  { name: 'file_fdw', available: true, installed: false },
];
let servers: ForeignServer[] = [
  {
    name: 'analytics_db',
    wrapper: 'postgres_fdw',
    options: { host: 'analytics.internal', port: '5432', dbname: 'warehouse' },
    hasUserMapping: true,
    remoteUser: 'reporter',
    vaultSecretId: '6f1c2a9e-0000-4000-8000-000000000002',
    foreignTables: 2,
  },
];
let foreignTables: ForeignTable[] = [
  { schema: 'analytics_db', name: 'daily_revenue', server: 'analytics_db', options: { schema_name: 'public', table_name: 'daily_revenue' }, columns: 4 },
  { schema: 'analytics_db', name: 'cohorts', server: 'analytics_db', options: { schema_name: 'public', table_name: 'cohorts' }, columns: 6 },
];

const wrapperHandlers: HttpHandler[] = [
  ...admin('get', '/wrappers', () => ok({ wrappers, servers, tables: foreignTables })),
  ...admin('post', '/wrappers/:wrapper/enable', ({ params }) => {
    const wrapper = wrappers.find(w => w.name === params.wrapper);
    if (wrapper) wrapper.installed = true;
    return ok({});
  }),
  ...admin('post', '/wrappers/servers', async ({ request }) => {
    const { name, wrapper, options = {}, user, password } = await body(request);
    const server = { name, wrapper, options, hasUserMapping: Boolean(user), remoteUser: user ?? null, vaultSecretId: password ? crypto.randomUUID() : null, foreignTables: 0 };
    servers = [...servers, server];
    return ok({ server });
  }),
  ...admin('put', '/wrappers/servers/:name/credentials', async ({ params, request }) => {
    const { user } = await body(request);
    servers = servers.map(s => (s.name === params.name ? { ...s, remoteUser: user, hasUserMapping: true } : s));
    return ok({ server: servers.find(s => s.name === params.name) });
  }),
  ...admin('post', '/wrappers/servers/:name/import', async ({ params, request }) => {
    const { localSchema, tables = ['orders', 'customers'] } = await body(request);
    const imported = (tables as string[]).map(name => ({ schema: localSchema, name, server: String(params.name), options: { table_name: name }, columns: 5 }));
    foreignTables = [...foreignTables, ...imported];
    return ok({ tables: imported });
  }),
  ...admin('delete', '/wrappers/servers/:name', ({ params }) => {
    servers = servers.filter(s => s.name !== params.name);
    foreignTables = foreignTables.filter(t => t.server !== params.name);
    return ok({});
  }),
  ...admin('post', '/wrappers/tables', async ({ request }) => {
    const { server, schema, name, columns = [], options = {} } = await body(request);
    const table = { schema, name, server, options, columns: columns.length };
    foreignTables = [...foreignTables, table];
    return ok({ table });
  }),
  ...admin('delete', '/wrappers/tables/:schema/:name', ({ params }) => {
    foreignTables = foreignTables.filter(t => !(t.schema === params.schema && t.name === params.name));
    return ok({});
  }),
];

// ── Index advisor ───────────────────────────────────────────────────────────

const advisorState = { available: true, installed: false, hint: null };

const indexAdvisorHandlers: HttpHandler[] = [
  ...admin('get', '/performance/index-advisor', () => ok(advisorState)),
  ...admin('post', '/performance/index-advisor/enable', () => {
    advisorState.installed = true;
    return ok(advisorState);
  }),
  ...admin('post', '/performance/index-advisor', async ({ request }) => {
    const { query = '' } = await body(request);
    const column = /where\s+(\w+)/i.exec(query)?.[1];
    const table = /from\s+([\w.]+)/i.exec(query)?.[1] ?? 'public.orders';
    return ok({
      startupCostBefore: 0,
      startupCostAfter: 4.3,
      totalCostBefore: 1843.5,
      totalCostAfter: column ? 18.2 : 1843.5,
      indexStatements: column ? [`CREATE INDEX ON ${table} USING btree (${column})`] : [],
      errors: [],
      improvementPct: column ? 99 : 0,
    });
  }),
];

export const dbExtHandlers: HttpHandler[] = [...queueHandlers, ...vaultHandlers, ...wrapperHandlers, ...indexAdvisorHandlers];
