// Mock-mode handlers for the Database section (indexes, enums, roles, column
// privileges, publications, settings). Kept out of handlers.ts so that file
// only gains one spread. State is mutable so writes round-trip in a session.
import { HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';
import * as fx from '@/mocks/fixtures';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type AdminRoute = (method: Method, path: string, resolver: HttpResponseResolver) => HttpHandler[];

const ok = (data: unknown) => HttpResponse.json({ data: JSON.parse(JSON.stringify(data)) });
const fail = (message: string, status = 400) => HttpResponse.json({ status: 0, code: 'bad_request', message }, { status });
const schemaOf = (request: Request) => new URL(request.url).searchParams.get('schema') ?? 'public';
const body = async <T>(request: Request) => (await request.json().catch(() => ({}))) as T;

const tablesIn = (schema: string) => fx.schemaTablesBySchema[schema] ?? [];

const RESERVED: Record<string, string> = {
  postgres: 'The server connects to the database as this role.',
  anon: 'Motherbase relies on this role for API access.',
  authenticated: 'Motherbase relies on this role for API access.',
  service_role: 'Motherbase relies on this role for API access.',
  pg_monitor: 'Predefined Postgres role.',
  pg_read_all_data: 'Predefined Postgres role.',
};

const role = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  canLogin: false,
  isSuperuser: false,
  canCreateDb: false,
  canCreateRole: false,
  canReplicate: false,
  canBypassRls: false,
  inheritRole: true,
  connectionLimit: -1,
  validUntil: null,
  activeConnections: 0,
  memberOf: [] as string[],
  comment: null,
  reserved: RESERVED[name] ?? null,
  ...overrides,
});

/** The list never carries a password, so a mock write must not store one either. */
function withoutPassword(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'password'));
}

let roles = [
  role('postgres', { canLogin: true, isSuperuser: true, canCreateDb: true, canCreateRole: true, canReplicate: true, canBypassRls: true, activeConnections: 7 }),
  role('anon'),
  role('authenticated'),
  role('service_role', { canBypassRls: true }),
  role('pg_monitor'),
  role('pg_read_all_data'),
  role('reporting_reader', { canLogin: true, connectionLimit: 5, activeConnections: 1, memberOf: ['pg_read_all_data'] }),
];

let enums: Record<string, Array<{ schema: string; name: string; values: string[]; comment: string | null; usedBy: string[] }>> = {
  public: [
    { schema: 'public', name: 'post_status', values: ['draft', 'published', 'archived'], comment: null, usedBy: ['posts.status'] },
    { schema: 'public', name: 'mood', values: ['happy', 'meh', 'sad'], comment: null, usedBy: [] },
  ],
};

let publications = [
  { name: 'warehouse_feed', owner: 'postgres', allTables: false, viaRoot: false, insert: true, update: true, delete: true, truncate: false, tables: [{ schema: 'public', table: 'posts' }], supabaseRealtime: false },
  { name: 'supabase_realtime', owner: 'postgres', allTables: false, viaRoot: false, insert: true, update: true, delete: true, truncate: true, tables: [], supabaseRealtime: true },
];

// role -> "schema.table" -> privilege -> granted columns ('*' = table-level)
const grants: Record<string, Record<string, Record<string, string[] | '*'>>> = {
  anon: { 'public.users': { SELECT: ['id', 'email'] } },
  authenticated: { 'public.users': { SELECT: '*', UPDATE: ['email'] } },
};

const setting = (name: string, value: string, unit: string | null, context: string, description: string, extra: Record<string, unknown> = {}) => ({
  name, value, unit, vartype: 'integer', context, category: context === 'postmaster' ? 'Resource Usage' : 'Client Connection Defaults',
  description, min: null, max: null, enumValues: null, bootValue: value, pendingRestart: false,
  scopes: context === 'user' || context === 'superuser' ? ['database', 'role', 'system'] : ['system'],
  overrides: [] as Array<{ scope: string; role?: string; value: string }>,
  ...extra,
});

const config = {
  database: 'app',
  version: '16.4',
  canAlterSystem: true,
  systemOverridesReadable: true,
  settings: [
    setting('statement_timeout', '30s', 'ms', 'user', 'Sets the maximum allowed duration of any statement.', { overrides: [{ scope: 'database', value: '30s' }] }),
    setting('idle_in_transaction_session_timeout', '0', 'ms', 'user', 'Sets the maximum allowed idle time between queries, when in a transaction.'),
    setting('lock_timeout', '0', 'ms', 'user', 'Sets the maximum allowed duration of any wait for a lock.'),
    setting('work_mem', '4MB', 'kB', 'user', 'Sets the maximum memory to be used for query workspaces.'),
    setting('session_replication_role', 'origin', null, 'superuser', 'Sets the session’s behavior for triggers and rewrite rules.', { vartype: 'enum', enumValues: ['origin', 'replica', 'local'] }),
    setting('max_connections', '100', null, 'postmaster', 'Sets the maximum number of concurrent connections.'),
    setting('shared_buffers', '128MB', '8kB', 'postmaster', 'Sets the number of shared memory buffers used by the server.'),
    setting('track_commit_timestamp', 'off', null, 'postmaster', 'Collects transaction commit time.', { vartype: 'bool' }),
  ],
  connection: { user: 'postgres', database: 'app', internalHost: 'db', internalPort: 5432, hostPort: 55432, bind: '127.0.0.1', publiclyBound: false, pooler: null },
};

function columnPrivileges(schema: string, table: string) {
  const columns = tablesIn(schema).find(t => t.name === table)?.columns.map(c => c.name) ?? [];
  const grantable = roles.filter(r => !r.name.startsWith('pg_') && !r.isSuperuser).map(r => r.name);
  return {
    table,
    schema,
    columns,
    roles: grantable.map(name => ({
      role: name,
      privileges: Object.fromEntries(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].map(privilege => {
        const granted = grants[name]?.[`${schema}.${table}`]?.[privilege] ?? [];
        return [privilege, granted === '*' ? { tableLevel: true, columns } : { tableLevel: false, columns: granted }];
      })),
    })),
  };
}

export function databaseCatalogHandlers(admin: AdminRoute): HttpHandler[] {
  return [
    ...admin('get', '/schema/table-stats', ({ request }) =>
      ok({
        tables: tablesIn(schemaOf(request)).map((table, index) => ({
          name: table.name,
          kind: 'table',
          columns: table.columns.length,
          rowsEstimate: index === 0 ? 1240 : index * 380 - 1,
          totalBytes: (index + 1) * 98_304,
          rlsEnabled: index % 2 === 0,
          comment: null,
        })),
      })),
    ...admin('get', '/schema/indexes', ({ request }) =>
      ok({
        indexes: tablesIn(schemaOf(request)).flatMap(table => {
          const pk = table.columns.find(c => c.isPrimaryKey);
          return pk
            ? [{ name: `${table.name}_pkey`, table: table.name, method: 'btree', unique: true, primary: true, columns: [pk.name], sizeBytes: 16_384, definition: `CREATE UNIQUE INDEX ${table.name}_pkey ON ${table.name} USING btree (${pk.name})` }]
            : [];
        }),
      })),

    ...admin('get', '/schema/enums', ({ request }) => ok({ enums: enums[schemaOf(request)] ?? [] })),
    ...admin('post', '/schema/enums', async ({ request }) => {
      const schema = schemaOf(request);
      const { name, values } = await body<{ name: string; values: string[] }>(request);
      enums = { ...enums, [schema]: [...(enums[schema] ?? []), { schema, name, values, comment: null, usedBy: [] }] };
      return ok({});
    }),
    ...admin('patch', '/schema/enums/:name', async ({ request, params }) => {
      const schema = schemaOf(request);
      const change = await body<{ action: string; value?: string; from?: string; to?: string; name?: string }>(request);
      enums = {
        ...enums,
        [schema]: (enums[schema] ?? []).map(type => {
          if (type.name !== params.name) return type;
          if (change.action === 'add-value') return { ...type, values: [...type.values, change.value!] };
          if (change.action === 'rename-value') return { ...type, values: type.values.map(v => (v === change.from ? change.to! : v)) };
          return { ...type, name: change.name! };
        }),
      };
      return ok({});
    }),
    ...admin('delete', '/schema/enums/:name', ({ request, params }) => {
      const schema = schemaOf(request);
      const type = (enums[schema] ?? []).find(t => t.name === params.name);
      if (type?.usedBy.length) return fail(`cannot drop type ${type.name} because other objects depend on it`);
      enums = { ...enums, [schema]: (enums[schema] ?? []).filter(t => t.name !== params.name) };
      return ok({});
    }),

    ...admin('get', '/database/roles', () => ok({ roles })),
    ...admin('post', '/database/roles', async ({ request }) => {
      const input = await body<Record<string, unknown> & { name: string }>(request);
      if (RESERVED[input.name]) return fail(`"${input.name}" is a reserved role name.`);
      roles = [...roles, role(input.name, withoutPassword(input))];
      return ok({});
    }),
    ...admin('patch', '/database/roles/:name', async ({ request, params }) => {
      if (RESERVED[String(params.name)]) return fail('Role cannot be changed from the console.', 403);
      const input = withoutPassword(await body<Record<string, unknown>>(request));
      roles = roles.map(r => (r.name === params.name ? { ...r, ...input } : r));
      return ok({});
    }),
    ...admin('delete', '/database/roles/:name', ({ params }) => {
      if (RESERVED[String(params.name)]) return fail('Role cannot be changed from the console.', 403);
      roles = roles.filter(r => r.name !== params.name);
      return ok({});
    }),

    ...admin('get', '/database/column-privileges', ({ request }) => {
      const url = new URL(request.url);
      return ok(columnPrivileges(url.searchParams.get('schema') ?? 'public', url.searchParams.get('table') ?? ''));
    }),
    ...admin('put', '/database/column-privileges', async ({ request }) => {
      const change = await body<{ schema: string; table: string; role: string; privilege: string; columns: string[]; grant: boolean }>(request);
      const all = tablesIn(change.schema).find(t => t.name === change.table)?.columns.map(c => String(c.name)) ?? [];
      const key = `${change.schema}.${change.table}`;
      const forRole = (grants[change.role] ??= {});
      const forTable = (forRole[key] ??= {});
      const existing = forTable[change.privilege];
      const current: string[] = existing === '*' ? all : existing ?? [];
      forTable[change.privilege] = change.grant
        ? [...new Set([...current, ...change.columns])]
        : current.filter(column => !change.columns.includes(column));
      return ok(columnPrivileges(change.schema, change.table));
    }),

    ...admin('get', '/database/publications', () => ok({ publications, walLevel: 'replica' })),
    ...admin('post', '/database/publications', async ({ request }) => {
      const input = await body<{ name: string; allTables?: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>(request);
      publications = [...publications, { owner: 'postgres', viaRoot: false, tables: [], supabaseRealtime: false, allTables: false, ...input }];
      return ok({});
    }),
    ...admin('patch', '/database/publications/:name', async ({ request, params }) => {
      const { addTables = [], dropTables = [], ...flags } = await body<{ addTables?: Array<{ schema: string; table: string }>; dropTables?: Array<{ schema: string; table: string }> }>(request);
      const same = (a: { schema: string; table: string }) => (b: { schema: string; table: string }) => a.schema === b.schema && a.table === b.table;
      publications = publications.map(p => p.name !== params.name ? p : {
        ...p,
        ...flags,
        tables: [...p.tables.filter(t => !dropTables.some(same(t))), ...addTables.filter(t => !p.tables.some(same(t)))],
      });
      return ok({});
    }),
    ...admin('delete', '/database/publications/:name', ({ params }) => {
      publications = publications.filter(p => p.name !== params.name);
      return ok({});
    }),

    ...admin('get', '/database/config', () => ok(config)),
    ...admin('patch', '/database/config', async ({ request }) => {
      const { changes } = await body<{ changes: Array<{ name: string; value: string | null; scope?: string; role?: string }> }>(request);
      const applied = changes.map(change => {
        const target = config.settings.find(s => s.name === change.name)!;
        const scope = change.scope ?? target.scopes[0];
        const rest = target.overrides.filter(o => !(o.scope === scope && o.role === change.role));
        target.overrides = change.value === null ? rest : [...rest, { scope, value: change.value, ...(change.role ? { role: change.role } : {}) }];
        if (change.value !== null && target.context !== 'postmaster') target.value = change.value;
        return { name: change.name, scope, ...(change.role ? { role: change.role } : {}) };
      });
      const restartRequired = changes.filter(c => config.settings.find(s => s.name === c.name)?.context === 'postmaster').map(c => c.name);
      return ok({ applied, restartRequired });
    }),
  ];
}
