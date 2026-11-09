/**
 * One resource the REST router actually serves, as `GET /admin/rest/resources`
 * reports it. Mirrors `RestResource` in
 * apps/server/services/rest-api/rest-api.service.ts.
 */
export interface RestResource {
  name: string;
  path: string;
  /** The real key columns. Empty when the table has none. */
  primaryKey: string[];
  rlsEnabled: boolean;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
  }>;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface Endpoint {
  group: string;
  method: Method;
  path: string;
  desc: string;
  sampleBody?: string;
}

export const METHOD_COLOR: Record<Method, string> = {
  GET: 'var(--lime)',
  POST: 'var(--accent)',
  PATCH: 'var(--violet)',
  DELETE: 'var(--danger)',
};

/** Columns the server fills in, so they never belong in a sample body. */
const AUTO_COLUMNS = new Set(['id', 'createdAt', 'updatedAt', 'created_at', 'updated_at']);

function typePlaceholder(pgType: string): unknown {
  const type = pgType.toLowerCase();
  if (/int|numeric|float|double|decimal/.test(type)) return 0;
  if (type.includes('bool')) return false;
  return 'string';
}

/**
 * The PostgREST identity filter for a resource, built from its real key.
 *
 * This was hardcoded to `id=eq.:id`, so a table keyed on `uuid`, `slug` or a
 * composite key got documented mutations that filter on a column it does not
 * have. A table with no key at all gets no filter placeholder and says so:
 * PostgREST will not accept an unscoped PATCH or DELETE anyway.
 */
export function identityFilter(primaryKey: string[]): string {
  if (primaryKey.length === 0) return '';
  return primaryKey.map(column => `${column}=eq.:${column}`).join('&');
}

function tableEndpoints(resource: RestResource): Endpoint[] {
  const basePath = resource.path;
  const filter = identityFilter(resource.primaryKey);
  const filteredPath = filter ? `${basePath}?${filter}` : basePath;
  // Generated and defaulted key columns are the server's to fill in.
  const writeFields = resource.columns.filter(
    c => !c.isPrimaryKey && !c.isGenerated && !AUTO_COLUMNS.has(c.name),
  );
  const body: Record<string, unknown> = {};
  writeFields.forEach(c => {
    body[c.name] = typePlaceholder(c.type);
  });
  const sampleBody = writeFields.length ? JSON.stringify(body, null, 2) : undefined;
  const group = resource.name;
  const keyNote = filter
    ? ''
    : ' This table has no primary key, so a filter has to be supplied by hand.';

  return [
    { group, method: 'GET', path: basePath, desc: `List ${group} rows. Supports ?filter, ?limit, ?offset, ?sort.` },
    { group, method: 'POST', path: basePath, desc: `Insert a ${group} row.`, sampleBody },
    { group, method: 'PATCH', path: filteredPath, desc: `Update ${group} rows matching filters.${keyNote}`, sampleBody },
    { group, method: 'DELETE', path: filteredPath, desc: `Delete ${group} rows matching filters.${keyNote}` },
  ];
}

/** The table a REST path addresses, or null for the static admin routes. */
export function restTableFromPath(path: string): string | null {
  return path.match(/^\/rest\/v1\/([^/?]+)/)?.[1] ?? null;
}

export const STATIC_ENDPOINTS: Endpoint[] = [
  { group: 'Session', method: 'GET', path: '/admin/session', desc: 'Current admin user.' },
  { group: 'Database', method: 'GET', path: '/admin/tables', desc: 'List Prisma models with metadata.' },
  { group: 'Database', method: 'GET', path: '/admin/tables/User/rows?page=1&pageSize=25', desc: 'Read rows for a model.' },
  { group: 'Database', method: 'POST', path: '/admin/tables/User/rows', desc: 'Create a row.', sampleBody: '{\n  "email": "new@example.com",\n  "username": "new"\n}' },
  { group: 'Database', method: 'PATCH', path: '/admin/tables/User/rows/:id', desc: 'Update a row.', sampleBody: '{\n  "username": "updated"\n}' },
  { group: 'Database', method: 'DELETE', path: '/admin/tables/User/rows/:id', desc: 'Delete a row.' },
  { group: 'Auth', method: 'GET', path: '/admin/users', desc: 'List all users.' },
  { group: 'Auth', method: 'POST', path: '/admin/users/:id/promote', desc: 'Promote a user to admin.' },
  { group: 'Auth', method: 'POST', path: '/admin/users/:id/demote', desc: 'Demote an admin to user.' },
  { group: 'Auth', method: 'POST', path: '/admin/users/:id/revoke-sessions', desc: 'Revoke all refresh tokens.' },
  { group: 'Auth', method: 'POST', path: '/admin/users/:id/reset-password', desc: 'Set a new password.', sampleBody: '{\n  "password": "new-strong-pwd"\n}' },
  { group: 'SQL', method: 'POST', path: '/admin/sql', desc: 'Execute a raw SQL statement.', sampleBody: '{\n  "sql": "SELECT 1"\n}' },
  { group: 'Storage', method: 'GET', path: '/admin/storage/files', desc: 'List uploaded files.' },
  { group: 'Storage', method: 'POST', path: '/admin/storage/files', desc: 'Upload a file from the console. Use the Storage page for multipart upload.' },
  { group: 'Storage', method: 'GET', path: '/admin/storage/files/:id/url', desc: 'Get a signed download URL.' },
  { group: 'Storage', method: 'DELETE', path: '/admin/storage/files/:id', desc: 'Delete a file.' },
  { group: 'Observability', method: 'GET', path: '/admin/logs?limit=100', desc: 'Recent log entries.' },
  { group: 'Observability', method: 'GET', path: '/admin/stats', desc: 'Counts per Prisma model.' },
];

/**
 * Static admin routes plus one REST group per resource the router serves.
 *
 * The list used to be the Studio table list for the SELECTED schema, minus a
 * hand-written blacklist of six internal names. REST exposes `public` base
 * tables only, so picking `auth` or a custom schema in the picker documented
 * `/rest/v1/<name>` endpoints that answer 404 or 403, and the blacklist never
 * covered the auth, storage and platform tables at all. This takes the list the
 * router itself reports.
 */
export function buildEndpoints(resources: RestResource[] | undefined): Endpoint[] {
  return [...STATIC_ENDPOINTS, ...(resources ?? []).flatMap(tableEndpoints)];
}

export function endpointGroups(endpoints: Endpoint[]): string[] {
  return Array.from(new Set(endpoints.map(e => e.group)));
}

/**
 * The fixed admin-API groups, which are routes under `/admin` rather than
 * tables of any schema. The catalogue lists them next to the REST groups, and
 * calling the whole list "schema public" was wrong: `Auth` and `Storage` here
 * are console routes, and the auth and storage tables they touch live in their
 * own schemas.
 */
export const STATIC_GROUPS = new Set(STATIC_ENDPOINTS.map(e => e.group));

/** The request as a runnable cURL line, for pasting into a terminal. */
export function endpointAsCurl(endpoint: Endpoint, origin: string): string {
  const parts = [`curl -X ${endpoint.method} '${origin}${endpoint.path}'`, `-H 'Content-Type: application/json'`];
  if (endpoint.sampleBody && (endpoint.method === 'POST' || endpoint.method === 'PATCH')) {
    parts.push(`-d '${endpoint.sampleBody.replace(/\n/g, '').replace(/\s+/g, ' ')}'`);
  }
  return parts.join(' \\n  ');
}
