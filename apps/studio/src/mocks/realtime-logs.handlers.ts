// Mock handlers for Realtime Authorization, the Logs Explorer, SQL snippets,
// edge function templates and custom reports. Mutable state lives here so
// creates and deletes round-trip within a mock session.
import type { HttpHandler } from 'msw';
import { admin, ok } from '@/mocks/msw';
import * as fx from '@/mocks/fixtures';
import type { ContentItem, ContentType } from '@/shared/lib/content';

// ── Logs Explorer ─────────────────────────────────────────────────────────
// The same classification the API applies (apps/server/lib/log-services.ts),
// so choosing a source in mock mode narrows the stream the way it does live.
const SOURCE_SERVICES: Record<string, string> = {
  sql: 'postgres', auth: 'auth', storage: 'storage', realtime: 'realtime', edge: 'edge-function', job: 'cron',
};
function serviceOf(entry: { source: string; path?: string }): string {
  if (entry.path?.startsWith('/rest/v1')) return 'rest';
  if (entry.path?.startsWith('/api/auth')) return 'auth';
  if (entry.path?.startsWith('/api/storage') || entry.path?.startsWith('/api/files')) return 'storage';
  if (entry.path?.startsWith('/api/edge')) return 'edge-function';
  if (entry.path) return 'api';
  return SOURCE_SERVICES[entry.source] ?? 'platform';
}
const mockLogs = fx.makeLogs(600).map(entry => ({ ...entry, service: serviceOf(entry) }));

function statusMatches(status: number | undefined, filter: string): boolean {
  if (status == null) return false;
  return filter.split(',').map(part => part.trim()).some(part => {
    const klass = /^([1-5])xx$/i.exec(part);
    if (klass) return Math.floor(status / 100) === Number(klass[1]);
    const [min, max = min] = part.split('-').map(Number);
    return status >= min && status <= max;
  });
}

// ── Studio content ────────────────────────────────────────────────────────
const MOCK_OPERATOR = 'op_mock';
const now = () => new Date().toISOString();
let contentSeq = 0;
function contentItem<T extends ContentType>(type: T, name: string, content: ContentItem<T>['content'], extra: Partial<ContentItem<T>> = {}): ContentItem<T> {
  contentSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(contentSeq).padStart(12, '0')}`,
    type, name, description: null, content, visibility: 'user', ownerId: MOCK_OPERATOR,
    folderId: null, favorite: false, createdAt: now(), updatedAt: now(), ...extra,
  };
}
let contentItems: ContentItem[] = [
  contentItem('sql', 'Recent users', { sql: 'SELECT id, email, "createdAt"\nFROM auth.users\nORDER BY "createdAt" DESC\nLIMIT 25;' }, { favorite: true }),
  contentItem('sql', 'Daily signups (30d)', { sql: "SELECT date_trunc('day', \"createdAt\") AS day, count(*)\nFROM auth.users\nGROUP BY 1 ORDER BY 1 DESC;" }, { visibility: 'project', ownerId: 'op_teammate' }),
  contentItem('log_sql', 'Slow REST calls', { sql: "select path, avg(\"durationMs\") from platform.request_logs\nwhere service = 'rest' group by path order by 2 desc limit 20;" }),
  contentItem('report', 'API health', { charts: [
    { id: 'c1', metric: 'requests', chart: 'bar' },
    { id: 'c2', metric: 'p95', chart: 'line' },
    { id: 'c3', metric: 'errorRate', chart: 'line' },
  ] }, { visibility: 'project' }),
];
let contentFolders: Array<{ id: string; name: string; ownerId: string; createdAt: string }> = [];

interface MockPolicy {
  name: string;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
  permissive: boolean;
}

let realtimePolicies: MockPolicy[] = [
  {
    name: 'authenticated can receive broadcasts',
    command: 'SELECT',
    roles: ['authenticated'],
    using: "extension = 'broadcast'",
    withCheck: null,
    permissive: true,
  },
];

const realtimeLimits = {
  group: 'realtime.limits',
  label: 'Realtime · Limits',
  description: 'Constraints applied when a client subscribes to a realtime topic.',
  source: 'db',
  fields: [
    { key: 'enablePostgresChanges', label: 'Enable postgres_changes', type: 'bool', default: true },
    { key: 'maxChannelsPerClient', label: 'Max channels per client', type: 'number', default: 100 },
    {
      key: 'privateOnly',
      label: 'Private channels only',
      type: 'bool',
      default: false,
      help: 'Refuse public channels. Every channel must be joined with private: true and is authorized by the policies on realtime.messages.',
    },
  ],
  values: { enablePostgresChanges: true, maxChannelsPerClient: 100, privateOnly: false },
};

const realtimeRetention = {
  group: 'realtime.retention',
  label: 'Realtime · Retention',
  description: 'Prune processed realtime outbox rows.',
  source: 'db',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: true },
    { key: 'completedDays', label: 'Keep completed events (days)', type: 'number', default: 7 },
    { key: 'failedDays', label: 'Keep failed events (days)', type: 'number', default: 30 },
  ],
  values: { enabled: true, completedDays: 7, failedDays: 30 },
};

const settingsGroups: Record<string, { values: Record<string, unknown> }> = {
  'realtime.limits': realtimeLimits,
  'realtime.retention': realtimeRetention,
};

export const realtimeLogsHandlers: HttpHandler[] = [
  // ── Logs Explorer ───────────────────────────────────────────────────────
  ...admin('get', '/logs', ({ request }) => {
    const params = new URL(request.url).searchParams;
    const since = Number(params.get('since') ?? 0);
    const service = params.get('service');
    const status = params.get('status');
    const method = params.get('method');
    const path = params.get('path')?.toLowerCase();
    const user = params.get('user');
    const limit = Number(params.get('limit')) || 500;
    // Same `<epoch ms>:<id>` keyset as lib/log-filter on the server.
    const [beforeAt, beforeId] = (params.get('before') ?? '').split(':').map(Number);
    const isOlder = (entry: (typeof mockLogs)[number]) =>
      !beforeId || Date.parse(entry.at) < beforeAt || (Date.parse(entry.at) === beforeAt && entry.id < beforeId);
    const matched = mockLogs
      .filter(entry =>
        Date.parse(entry.at) >= since
        && isOlder(entry)
        && (!service || (service === 'api' ? Boolean(entry.method) : entry.service === service))
        && (!status || statusMatches(entry.status, status))
        && (!method || entry.method === method)
        && (!path || Boolean(entry.path?.toLowerCase().includes(path)))
        && (!user || entry.userId === user)
      )
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
    const logs = matched.slice(0, limit).reverse();
    const hasMore = matched.length > limit;
    return ok({
      logs,
      persisted: true,
      retentionDays: 7,
      oldestAvailable: mockLogs.reduce((oldest, entry) => (entry.at < oldest ? entry.at : oldest), now()),
      hasMore,
      nextCursor: hasMore ? `${Date.parse(logs[0].at)}:${logs[0].id}` : null,
    });
  }),
  // Query mode: a plausible aggregate whatever the SQL, since there is no database.
  ...admin('post', '/sql/readonly', () => {
    const counts = new Map<string, number>();
    for (const entry of mockLogs) counts.set(entry.service, (counts.get(entry.service) ?? 0) + 1);
    return ok({ kind: 'read', columns: ['service', 'lines'], rows: [...counts].map(([service, lines]) => ({ service, lines })) });
  }),

  // ── Studio content (snippets, saved log queries, reports) ───────────────
  ...admin('get', '/content', ({ request }) => {
    const type = new URL(request.url).searchParams.get('type');
    const items = contentItems
      .filter(item => (!type || item.type === type) && (item.ownerId === MOCK_OPERATOR || item.visibility === 'project'))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
    return ok({ items, operator: MOCK_OPERATOR });
  }),
  ...admin('post', '/content', async ({ request }) => {
    const body = (await request.json()) as Partial<ContentItem> & { type: ContentType; name: string };
    const item = contentItem(body.type, body.name, body.content as never, {
      description: body.description ?? null, visibility: body.visibility ?? 'user', folderId: body.folderId ?? null, favorite: body.favorite ?? false,
    });
    contentItems = [item, ...contentItems];
    return ok({ item });
  }),
  ...admin('patch', '/content/:id', async ({ params, request }) => {
    const patch = (await request.json()) as Partial<ContentItem>;
    contentItems = contentItems.map(item => (item.id === params.id ? { ...item, ...patch, updatedAt: now() } as ContentItem : item));
    return ok({ item: contentItems.find(item => item.id === params.id) });
  }),
  ...admin('delete', '/content/:id', ({ params }) => {
    contentItems = contentItems.filter(item => item.id !== params.id);
    return ok({});
  }),
  ...admin('get', '/content-folders', () => ok({ folders: contentFolders })),
  ...admin('post', '/content-folders', async ({ request }) => {
    const { name } = (await request.json()) as { name: string };
    const folder = { id: `10000000-0000-4000-8000-${String(++contentSeq).padStart(12, '0')}`, name, ownerId: MOCK_OPERATOR, createdAt: now() };
    contentFolders = [...contentFolders, folder];
    return ok({ folder });
  }),
  ...admin('patch', '/content-folders/:id', async ({ params, request }) => {
    const { name } = (await request.json()) as { name: string };
    contentFolders = contentFolders.map(folder => (folder.id === params.id ? { ...folder, name } : folder));
    return ok({});
  }),
  ...admin('delete', '/content-folders/:id', ({ params }) => {
    contentFolders = contentFolders.filter(folder => folder.id !== params.id);
    contentItems = contentItems.map(item => (item.folderId === params.id ? { ...item, folderId: null } : item));
    return ok({});
  }),

  // ── Realtime Authorization ──────────────────────────────────────────────
  ...admin('get', '/realtime/policies', () => ok({ policies: realtimePolicies })),
  ...admin('post', '/realtime/policies', async ({ request }) => {
    const body = (await request.json()) as { name: string; command: string; role: string; using?: string; check?: string };
    realtimePolicies = [
      ...realtimePolicies.filter(policy => policy.name !== body.name),
      { name: body.name, command: body.command, roles: [body.role], using: body.using ?? null, withCheck: body.check ?? null, permissive: true },
    ];
    return ok({});
  }),
  ...admin('delete', '/realtime/policies/:name', ({ params }) => {
    realtimePolicies = realtimePolicies.filter(policy => policy.name !== decodeURIComponent(String(params.name)));
    return ok({});
  }),
  ...Object.entries(settingsGroups).flatMap(([key, group]) => [
    ...admin('get', `/settings/${key}`, () => ok(group)),
    ...admin('put', `/settings/${key}`, async ({ request }) => {
      group.values = { ...group.values, ...((await request.json()) as object) };
      return ok(group);
    }),
  ]),
];
