import type { DataRow } from '@/shared/types/data';

// Demo data for MSW mock mode (npm run studio:mock). Pure fixtures, no logic.
// Edit freely to exercise UI states (empty lists, error levels, etc.).

const now = Date.now();
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString();

export const projects = [
  {
    name: 'demo',
    domain: 'demo.localhost',
    storageDomain: 'storage.demo.localhost',
    createdAt: iso(86_400_000 * 12),
    status: 'running' as const,
  },
  { name: 'staging', domain: 'staging.localhost', createdAt: iso(86_400_000 * 3), status: 'stopped' as const },
];

export const dns = {
  checks: [
    { name: 'A @ demo.localhost', ok: true, message: 'resolves to 127.0.0.1' },
    { name: 'CNAME storage', ok: true, message: 'ok' },
  ],
};

export const platformInfo = { mode: 'dev', domainSuffix: 'localhost', features: { billing: false } };

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const platformMetrics = {
  host: {
    hostname: 'mb-node-1',
    platform: 'linux',
    uptimeSec: 86_400 * 5 + 3_600 * 7,
    cpuCount: 8,
    loadAvg: [1.2, 1.0, 0.85] as [number, number, number],
    loadPercent: 15,
    memTotal: 16 * GIB,
    memFree: Math.round(9.4 * GIB),
    memUsed: Math.round(6.6 * GIB),
    memPercent: 41,
  },
  // demo's four services, the edge runtime among them (it counts in demo's totals).
  containers: [
    { name: 'demo-api-1', project: 'demo', service: 'api', cpuPercent: 31.2, memPercent: 2.4, memUsed: 390 * MIB, memLimit: 512 * MIB, netRx: 0, netTx: 0 },
    { name: 'demo-db-1', project: 'demo', service: 'db', cpuPercent: 24.6, memPercent: 2.1, memUsed: 340 * MIB, memLimit: 512 * MIB, netRx: 0, netTx: 0 },
    { name: 'demo-minio-1', project: 'demo', service: 'minio', cpuPercent: 4.1, memPercent: 0.7, memUsed: 112 * MIB, memLimit: 256 * MIB, netRx: 0, netTx: 0 },
    { name: 'demo-edge-runtime-1', project: 'demo', service: 'edge-runtime', cpuPercent: 2.5, memPercent: 0.4, memUsed: 80 * MIB, memLimit: 768 * MIB, netRx: 0, netTx: 0 },
  ],
  projects: [
    // Configured limits present → usage-vs-quota percentages surfaced.
    {
      project: 'demo',
      containers: 4,
      cpuPercent: 62.4,
      memUsed: Math.round(0.9 * GIB),
      memPercent: 5.6,
      cpuLimit: 1.75,
      memLimitBytes: 2048 * MIB,
      cpuPct: 35.7,
      memPct: 45.0,
    },
    // No configured limits → cpuLimit/memLimitBytes absent (renders as "default").
    { project: 'staging', containers: 0, cpuPercent: 0, memUsed: 0, memPercent: 0 },
  ],
};

export const projectLimits: Record<
  string,
  { apiCpus: number; apiMemMb: number; dbCpus: number; dbMemMb: number; minioCpus: number; minioMemMb: number; edgeCpus: number; edgeMemMb: number; diskGb: number }
> = {
  demo: { apiCpus: 0.5, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256, edgeCpus: 0.5, edgeMemMb: 768, diskGb: 10 },
  staging: { apiCpus: 0.5, apiMemMb: 512, dbCpus: 0.5, dbMemMb: 512, minioCpus: 0.25, minioMemMb: 256, edgeCpus: 0.5, edgeMemMb: 768, diskGb: 10 },
};

export const platformUsers = [
  {
    id: 'pu_1',
    email: 'owner@example.com',
    role: 'owner' as const,
    projects: [],
    disabled: false,
    createdAt: iso(86_400_000 * 90),
  },
  {
    id: 'pu_2',
    email: 'admin@example.com',
    role: 'admin' as const,
    projects: [],
    disabled: false,
    createdAt: iso(86_400_000 * 30),
  },
  {
    id: 'pu_3',
    email: 'dev@example.com',
    role: 'developer' as const,
    projects: ['demo'],
    disabled: false,
    createdAt: iso(86_400_000 * 7),
  },
  {
    id: 'pu_4',
    email: 'viewer@example.com',
    role: 'read_only' as const,
    projects: ['staging'],
    disabled: false,
    createdAt: iso(86_400_000 * 2),
  },
  {
    id: 'pu_5',
    email: 'legacy@example.com',
    role: 'member' as const,
    projects: ['demo'],
    disabled: true,
    createdAt: iso(86_400_000),
  },
];

export const session = { email: 'operator@example.com', role: 'ADMIN', projectId: 'demo' };

export const connectInfo = {
  apiUrl: 'http://demo.localhost/api',
  wsUrl: 'ws://demo.localhost/realtime',
  sdkPackage: '@motherbase/client',
  version: '1.0.0',
  projectId: 'demo',
  anonKey: 'mb_publishable_demo_key_0123456789',
};

const fields = (extra: DataRow[] = []) => [
  { name: 'id', type: 'String', kind: 'scalar', isId: true, isReadOnly: true, isRequired: true, sensitive: false },
  ...extra,
  {
    name: 'createdAt',
    type: 'DateTime',
    kind: 'scalar',
    isId: false,
    isReadOnly: true,
    isRequired: true,
    sensitive: false,
  },
];

/**
 * Every entry carries its `schema`, because the views consume it: the sidebar
 * filters on it and the read-only decision reads it. Without the field the mock
 * rendered "0 tables" in the sidebar above a grid full of rows, which hid the
 * schema-selection bug rather than showing it.
 */
export const tableMetas = [
  {
    model: 'User',
    dbName: 'users',
    schema: 'public',
    primaryKey: 'id',
    fields: fields([
      {
        name: 'email',
        type: 'String',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: true,
        sensitive: false,
      },
      {
        name: 'name',
        type: 'String',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: false,
        sensitive: false,
      },
      {
        name: 'role',
        type: 'String',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: true,
        sensitive: false,
      },
    ]),
  },
  {
    model: 'Post',
    dbName: 'posts',
    schema: 'public',
    primaryKey: 'id',
    fields: fields([
      {
        name: 'title',
        type: 'String',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: true,
        sensitive: false,
      },
      {
        name: 'published',
        type: 'Boolean',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: true,
        sensitive: false,
      },
      {
        name: 'authorId',
        type: 'String',
        kind: 'scalar',
        isId: false,
        isReadOnly: false,
        isRequired: true,
        sensitive: false,
      },
    ]),
  },
];

export const rowsByTable: Record<string, DataRow[]> = {
  User: Array.from({ length: 23 }, (_, i) => ({
    id: `usr_${i + 1}`,
    email: `user${i + 1}@example.com`,
    name: ['Ada', 'Linus', 'Grace', 'Dennis'][i % 4],
    role: i === 0 ? 'ADMIN' : 'USER',
    createdAt: iso(i * 3_600_000),
  })),
  Post: Array.from({ length: 11 }, (_, i) => ({
    id: `post_${i + 1}`,
    title: `Post number ${i + 1}`,
    published: i % 2 === 0,
    authorId: `usr_${(i % 5) + 1}`,
    createdAt: iso(i * 7_200_000),
  })),
};

const cols = (extra: DataRow[] = []) => [
  { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', isPrimaryKey: true },
  ...extra,
  { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', isPrimaryKey: false },
];

export const schemaTables = [
  {
    name: 'users',
    columns: cols([
      { name: 'email', type: 'text', nullable: false, default: null, isPrimaryKey: false },
      { name: 'name', type: 'text', nullable: true, default: null, isPrimaryKey: false },
      { name: 'role', type: 'text', nullable: false, default: "'USER'", isPrimaryKey: false },
    ]),
  },
  {
    name: 'posts',
    columns: cols([
      { name: 'title', type: 'text', nullable: false, default: null, isPrimaryKey: false },
      { name: 'published', type: 'boolean', nullable: false, default: 'false', isPrimaryKey: false },
      { name: 'author_id', type: 'uuid', nullable: false, default: null, isPrimaryKey: false },
    ]),
  },
];

export const schemaGraph = {
  nodes: schemaTables.map(t => ({ id: t.name, table: t.name, primaryKey: 'id', columns: t.columns })),
  edges: [
    {
      constraint: 'posts_author_id_fkey',
      fromTable: 'posts',
      fromColumn: 'author_id',
      toTable: 'users',
      toColumn: 'id',
    },
  ],
};

export const indexes = [
  { name: 'users_pkey', definition: 'CREATE UNIQUE INDEX users_pkey ON users(id)', unique: true },
  { name: 'users_email_key', definition: 'CREATE UNIQUE INDEX users_email_key ON users(email)', unique: true },
];

export const extensions = [
  {
    name: 'pgcrypto',
    defaultVersion: '1.3',
    installedVersion: '1.3',
    installed: true,
    comment: 'cryptographic functions',
  },
  { name: 'uuid-ossp', defaultVersion: '1.1', installedVersion: '1.1', installed: true, comment: 'UUID generation' },
  { name: 'postgis', defaultVersion: '3.4', installedVersion: null, installed: false, comment: 'spatial types' },
  {
    name: 'pg_stat_statements',
    defaultVersion: '1.10',
    installedVersion: null,
    installed: false,
    comment: 'query stats',
  },
];

export const dbFunctions = [
  {
    name: 'set_updated_at',
    returnType: 'trigger',
    language: 'plpgsql',
    definition:
      'CREATE FUNCTION set_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;',
  },
];

export const triggers = [
  {
    name: 'users_set_updated_at',
    table: 'users',
    timing: 'BEFORE' as const,
    events: ['UPDATE'],
    orientation: 'ROW' as const,
    function: 'set_updated_at',
    enabled: true,
    definition:
      'CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
  },
];

export const triggerFunctions = [{ name: 'set_updated_at', returnType: 'trigger' }];

export const rlsTables = [
  {
    table: 'users',
    rlsEnabled: true,
    policies: [
      {
        name: 'users_select_own',
        command: 'SELECT',
        roles: ['authenticated'],
        using: 'auth.uid() = id',
        withCheck: null,
        permissive: true,
      },
      {
        name: 'users_update_own',
        command: 'UPDATE',
        roles: ['authenticated'],
        using: 'auth.uid() = id',
        withCheck: 'auth.uid() = id',
        permissive: true,
      },
    ],
  },
  { table: 'posts', rlsEnabled: false, policies: [] },
];

const ownRow = (command: 'SELECT' | 'UPDATE', withCheck: string | null) => ({
  policy: `users_${command.toLowerCase()}_own`,
  command,
  restrictive: false,
  using: '(auth.uid() = id)',
  withCheck,
});
const noAccess = (blockedBy: 'grant' | 'policy' | 'read') => ({ level: 'none', blockedBy }) as const;

/** What the server derives from `rlsTables` above plus the default grants. */
export const rlsAccess = [
  {
    table: 'users',
    rlsEnabled: true,
    access: {
      anon: {
        SELECT: noAccess('grant'),
        INSERT: noAccess('grant'),
        UPDATE: noAccess('grant'),
        DELETE: noAccess('grant'),
      },
      authenticated: {
        SELECT: { level: 'some', conditions: [ownRow('SELECT', null)] },
        INSERT: noAccess('policy'),
        UPDATE: {
          level: 'some',
          conditions: [ownRow('UPDATE', '(auth.uid() = id)'), ownRow('SELECT', null)],
        },
        DELETE: noAccess('policy'),
      },
    },
  },
  {
    table: 'posts',
    rlsEnabled: false,
    access: {
      anon: { SELECT: { level: 'all' }, INSERT: { level: 'all' }, UPDATE: { level: 'all' }, DELETE: { level: 'all' } },
      authenticated: {
        SELECT: { level: 'all' },
        INSERT: { level: 'all' },
        UPDATE: { level: 'all' },
        DELETE: { level: 'all' },
      },
    },
  },
];

export const users = [
  {
    id: 'usr_1',
    email: 'operator@example.com',
    name: 'Operator',
    username: 'operator',
    role: 'ADMIN',
    status: 'active',
    providers: ['email'],
    emailVerified: true,
    createdAt: iso(86_400_000 * 30),
    lastSignInAt: iso(3_600_000),
  },
  {
    id: 'usr_2',
    email: 'user2@example.com',
    name: 'Linus',
    username: 'linus',
    role: 'USER',
    status: 'active',
    providers: ['email', 'google'],
    emailVerified: true,
    createdAt: iso(86_400_000 * 10),
    lastSignInAt: iso(86_400_000),
  },
  {
    id: 'usr_3',
    email: 'banned@example.com',
    name: 'Spammer',
    username: 'spammer',
    role: 'USER',
    status: 'banned',
    providers: ['email'],
    emailVerified: false,
    createdAt: iso(86_400_000 * 2),
    lastSignInAt: null,
  },
  {
    id: 'usr_4',
    email: 'temp-9f2c1a@anonymous.invalid',
    name: 'Anonymous',
    username: 'guest-9f2c',
    role: 'USER',
    status: 'active',
    providers: [],
    emailVerified: false,
    isAnonymous: true,
    createdAt: iso(3_600_000 * 5),
    lastSignInAt: iso(3_600_000 * 5),
  },
];

export const buckets = [
  {
    id: 'bkt_1',
    slug: 'avatars',
    name: 'Avatars',
    visibility: 'public' as const,
    quotaBytes: 1_073_741_824,
    fileSizeLimit: 5_242_880,
    allowedMimeTypes: ['image/*'],
    fileCount: 3,
    totalBytes: 245_000,
    description: 'User avatars',
  },
  {
    id: 'bkt_2',
    slug: 'private-docs',
    name: 'Private Docs',
    visibility: 'private' as const,
    quotaBytes: null,
    fileSizeLimit: null,
    allowedMimeTypes: [] as string[],
    fileCount: 2,
    totalBytes: 1_540_000,
    description: null,
  },
];

const file = (id: string, bucket: string, key: string, mime: string, size: number, vis: 'public' | 'private') => ({
  id,
  bucket,
  bucketId: null,
  key,
  mime,
  size,
  visibility: vis,
  ownerEmail: 'operator@example.com',
  createdAt: iso(Number(id.slice(-1)) * 3_600_000),
});

export const filesByBucket: Record<string, DataRow[]> = {
  avatars: [
    file('file_1', 'avatars', 'avatars/ada.png', 'image/png', 84_000, 'public'),
    file('file_2', 'avatars', 'avatars/grace.jpg', 'image/jpeg', 120_000, 'public'),
    file('file_3', 'avatars', 'avatars/linus.webp', 'image/webp', 41_000, 'public'),
  ],
  'private-docs': [
    file('file_4', 'private-docs', 'docs/contract.pdf', 'application/pdf', 540_000, 'private'),
    file('file_5', 'private-docs', 'docs/budget.xlsx', 'application/vnd.ms-excel', 1_000_000, 'private'),
  ],
};

export const edgeFunctions = [
  {
    id: 'fn_1',
    name: 'hello',
    route: '/hello',
    code: '(async (context) => ({ message: "hi " + context.name }))(context)',
    enabled: true,
    isPublic: false,
    createdAt: iso(86_400_000),
    updatedAt: iso(3_600_000),
  },
  {
    id: 'fn_2',
    name: 'webhook-relay',
    route: '/relay',
    code: '(async (context) => ({ ok: true }))(context)',
    enabled: false,
    isPublic: true,
    createdAt: iso(86_400_000 * 4),
    updatedAt: iso(86_400_000),
  },
];

export const edgeLogs = [
  {
    id: 'log_1',
    status: 200,
    durationMs: 14,
    stdout: 'invoked with {"name":"world"}',
    errorMessage: null,
    invokedAt: iso(60_000),
  },
  {
    id: 'log_2',
    status: 500,
    durationMs: 31,
    stdout: '',
    errorMessage: 'ReferenceError: foo is not defined',
    invokedAt: iso(120_000),
  },
];

export const edgeSecrets = [
  { id: 'sec_1', name: 'STRIPE_KEY', preview: 'sk_live_••••2345', updatedAt: iso(86_400_000 * 2) },
];

export const realtimeChannels = [
  { name: 'public:posts', clientCount: 4 },
  { name: 'presence:room1', clientCount: 2 },
];

export const realtimeEvents = [
  { channel: 'public:posts', event: 'INSERT', payload: { id: 'post_12', title: 'New' }, at: now - 2000 },
  { channel: 'public:posts', event: 'UPDATE', payload: { id: 'post_3', published: true }, at: now - 8000 },
];

export const realtimeConfig = {
  models: ['Post'],
  availableModels: [
    { model: 'User', dbName: 'users', dynamic: false, riskLevel: 'private' as const, respectRls: true },
    { model: 'Post', dbName: 'posts', dynamic: false, riskLevel: 'public' as const, respectRls: false },
  ],
  defaultEnabled: false,
  configured: true,
};

export const webhooks = [
  {
    id: 'wh_1',
    name: 'Slack notify',
    url: 'https://hooks.slack.com/services/xxx',
    events: ['posts.insert'],
    enabled: true,
    createdAt: iso(86_400_000 * 5),
  },
];

export const backups = [
  { name: 'backup-2026-06-25.sql.gz', size: 4_200_000, createdAt: iso(86_400_000) },
  { name: 'backup-2026-06-24.sql.gz', size: 4_100_000, createdAt: iso(86_400_000 * 2) },
];

// Backups page (Studio): richer shape than the Settings `backups` fixture above.
export const backupsList = {
  local: [
    {
      name: 'motherbase-db-2026-07-05-0300.sql',
      path: '/var/backups/demo/motherbase-db-2026-07-05-0300.sql',
      size: 4_300_000,
      createdAt: iso(3_600_000 * 6),
      kind: 'database' as const,
      restorable: true,
      extractable: false,
    },
    {
      name: 'motherbase-db-2026-07-04-0300.sql',
      path: '/var/backups/demo/motherbase-db-2026-07-04-0300.sql',
      size: 4_210_000,
      createdAt: iso(86_400_000),
      kind: 'database' as const,
      restorable: true,
      extractable: false,
    },
    // Two rows that cannot be restored, so the Restore gating is visible in
    // mock mode.
    {
      name: 'motherbase-full-2026-07-04-0100.tar',
      path: '/var/backups/demo/motherbase-full-2026-07-04-0100.tar',
      size: 91_400_000,
      createdAt: iso(86_400_000 + 7_200_000),
      kind: 'full' as const,
      restorable: false,
      extractable: true,
    },
    {
      name: 'motherbase-project-2026-07-03.json',
      path: '/var/backups/demo/motherbase-project-2026-07-03.json',
      size: 128_000,
      createdAt: iso(86_400_000 * 2),
      kind: 'export' as const,
      restorable: false,
      extractable: false,
    },
  ],
  remote: [
    {
      key: 's3://mb-offsite/demo/motherbase-db-2026-07-05-0300.sql',
      size: 4_300_000,
      lastModified: iso(3_600_000 * 5),
      kind: 'database' as const,
      restorable: true,
      extractable: false,
    },
    {
      key: 's3://mb-offsite/demo/motherbase-full-2026-07-04-0100.tar',
      size: 91_400_000,
      lastModified: iso(86_400_000),
      kind: 'full' as const,
      restorable: false,
      extractable: true,
    },
  ],
};

export const backupsConfig = { enabled: true, cron: '0 3 * * *', retention: 7, offsite: true };

// Git integration (Studio → Migrations). Starts configured but unconnected, so
// mock mode opens on the state that has something to click.
export const gitStatus = {
  configured: true,
  connected: false,
  accountLogin: null as string | null,
  owner: null as string | null,
  repo: null as string | null,
  branch: 'main',
  migrationsPath: 'migrations',
  webhookInstalled: false,
  lastSyncAt: null as string | null,
  lastSyncStatus: null as 'ok' | 'failed' | null,
  lastSyncMessage: null as string | null,
  lastSyncSha: null as string | null,
};

export const gitRepos = [
  { fullName: 'octocat/storefront', owner: 'octocat', name: 'storefront', private: false, defaultBranch: 'main', updatedAt: iso(3_600_000) },
  { fullName: 'octocat/internal-tools', owner: 'octocat', name: 'internal-tools', private: true, defaultBranch: 'develop', updatedAt: iso(3_600_000 * 30) },
  { fullName: 'acme/billing-api', owner: 'acme', name: 'billing-api', private: true, defaultBranch: 'main', updatedAt: iso(3_600_000 * 100) },
];

// Migrations page (Studio)
export const migrations = [
  {
    id: 'mig_003',
    version: '20260704120000',
    name: 'add_posts_slug',
    origin: 'studio' as const,
    status: 'pending' as const,
    checksum: 'a1b2c3d4',
    appliedAt: null,
    createdAt: iso(3_600_000 * 8),
  },
  {
    id: 'mig_002',
    version: '20260702093000',
    name: 'add_users_role_index',
    origin: 'cli' as const,
    status: 'applied' as const,
    checksum: 'e5f6a7b8',
    appliedAt: iso(86_400_000 * 3),
    createdAt: iso(86_400_000 * 3 + 3_600_000),
  },
  {
    id: 'mig_001',
    version: '20260628080000',
    name: 'init_schema',
    origin: 'git' as const,
    status: 'applied' as const,
    checksum: 'c9d0e1f2',
    appliedAt: iso(86_400_000 * 7),
    createdAt: iso(86_400_000 * 7 + 3_600_000),
  },
];

export const migrationDetails: Record<string, DataRow> = {
  mig_003: {
    ...migrations[0],
    upSql: 'ALTER TABLE posts ADD COLUMN slug text;\nCREATE UNIQUE INDEX posts_slug_key ON posts(slug);',
    downSql: 'DROP INDEX posts_slug_key;\nALTER TABLE posts DROP COLUMN slug;',
  },
  mig_002: {
    ...migrations[1],
    upSql: 'CREATE INDEX users_role_idx ON users(role);',
    downSql: 'DROP INDEX users_role_idx;',
  },
  mig_001: { ...migrations[2], upSql: 'CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL);', downSql: null },
};

export const migrationDiff = {
  diff: ['~ table posts', '  + column slug text NULL', '~ table users', '  + index users_created_at_idx'].join('\n'),
  suggestedSql: 'ALTER TABLE posts ADD COLUMN slug text;\nCREATE INDEX users_created_at_idx ON users("createdAt");',
};

export const settingsGroups = [
  { key: 'auth', label: 'Authentication', source: 'db' as const },
  { key: 'email', label: 'Email (SMTP)', source: 'db' as const },
  { key: 'storage', label: 'Storage', source: 'env' as const },
  { key: 'backup.schedule', label: 'Backups · Schedule', source: 'db' as const },
  { key: 'ai.assistant', label: 'AI assistant', source: 'db' as const },
];

/** Mirrors GET /api/admin/ai/providers (PROVIDERS in @motherbase/ai). */
export const aiProviders = [
  { id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-opus-5', requiresBaseUrl: false },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5', requiresBaseUrl: false },
  { id: 'gemini', label: 'Google Gemini', defaultModel: 'gemini-2.5-pro', requiresBaseUrl: false },
  { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', requiresBaseUrl: false, defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'qwen', label: 'Qwen (Alibaba Cloud)', defaultModel: 'qwen-plus', requiresBaseUrl: false, defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'glm', label: 'GLM (Z.ai)', defaultModel: 'glm-4.6', requiresBaseUrl: false, defaultBaseUrl: 'https://api.z.ai/api/paas/v4' },
  { id: 'moonshot', label: 'Kimi (Moonshot AI)', defaultModel: 'kimi-k2-0905-preview', requiresBaseUrl: false, defaultBaseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'mistral', label: 'Mistral AI', defaultModel: 'mistral-large-latest', requiresBaseUrl: false, defaultBaseUrl: 'https://api.mistral.ai/v1' },
  { id: 'xai', label: 'xAI (Grok)', defaultModel: 'grok-4', requiresBaseUrl: false, defaultBaseUrl: 'https://api.x.ai/v1' },
  { id: 'groq', label: 'Groq', defaultModel: 'openai/gpt-oss-120b', requiresBaseUrl: false, defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openrouter/auto', requiresBaseUrl: false, defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'compatible', label: 'OpenAI-compatible (custom base URL)', defaultModel: '', requiresBaseUrl: true },
].map(p => ({ docsUrl: '', suggestedModels: p.defaultModel ? [p.defaultModel] : [], ...p }));

export const settingsByGroup: Record<string, DataRow> = {
  'ai.assistant': {
    group: 'ai.assistant',
    label: 'AI assistant',
    description: 'Bring your own model key. Requests run on the server with your project permissions.',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
      {
        key: 'provider',
        label: 'Provider',
        type: 'select',
        options: aiProviders.map(p => ({ value: p.id, label: p.label })),
        default: 'anthropic',
      },
      { key: 'model', label: 'Model', type: 'text', placeholder: 'claude-opus-5' },
      { key: 'apiKey', label: 'API key', type: 'password', secret: true },
      { key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'http://localhost:11434/v1' },
      { key: 'maxSteps', label: 'Maximum tool steps per message', type: 'number', default: 12 },
      { key: 'autoApproveWrites', label: 'Run write actions without confirmation', type: 'bool', default: false },
    ],
    values: {
      enabled: true,
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: '__SECRET_SET__',
      baseUrl: '',
      maxSteps: 12,
      autoApproveWrites: false,
    },
  },
  'server.cors': {
    group: 'server.cors',
    label: 'Security · CORS',
    source: 'db',
    fields: [
      { key: 'origins', label: 'Allowed origins', type: 'text', placeholder: '*, http://localhost:3000, https://app.example.com', default: '' },
      { key: 'credentials', label: 'Allow credentials (cookies / auth headers)', type: 'bool', default: true },
    ],
    values: { origins: 'http://localhost:3000, https://app.example.com', credentials: true },
  },
  'security.rateLimit': {
    group: 'security.rateLimit',
    label: 'Security · Rate limits',
    description: 'Max requests per client, per scope, within the rate-limit window. Changes apply live.',
    source: 'env',
    fields: [
      { key: 'windowMin', label: 'Window (minutes)', type: 'number', default: 15 },
      { key: 'global', label: 'Global (req / window / client)', type: 'number', default: 1000 },
      { key: 'auth', label: 'Auth endpoints', type: 'number', default: 20 },
      { key: 'restRead', label: 'REST read (GET)', type: 'number', default: 300 },
      { key: 'restWrite', label: 'REST write (POST/PATCH/DELETE)', type: 'number', default: 120 },
      { key: 'edge', label: 'Edge function invokes', type: 'number', default: 60 },
    ],
    values: { windowMin: 15, global: 1000, auth: 20, restRead: 300, restWrite: 120, edge: 60 },
  },
  'security.rateLimitRules': {
    group: 'security.rateLimitRules',
    label: 'Security · Rate-limit rules',
    description: 'Custom rules on top of the built-in scopes. Every matching rule applies and the most restrictive wins; rules can only tighten limits. Changes apply live.',
    source: 'env',
    fields: [{ key: 'rules', label: 'Rules (JSON array)', type: 'json' }],
    values: { rules: [] },
  },
  'database.sqlEditor': {
    group: 'database.sqlEditor',
    label: 'Database · SQL editor',
    description: 'What the Studio SQL editor may run. Changes apply to the next query.',
    source: 'env',
    fields: [{ key: 'allowWrites', label: 'Allow writes from the SQL editor', type: 'bool', default: true }],
    values: { allowWrites: true },
  },
  'backup.schedule': {
    group: 'backup.schedule',
    label: 'Backups · Schedule',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'cron', label: 'Cron expression', type: 'text' },
      { key: 'retention', label: 'Retention (keep newest N)', type: 'number' },
      { key: 'offsite', label: 'Offsite upload to S3', type: 'bool' },
    ],
    values: { enabled: true, cron: '0 3 * * *', retention: 7, offsite: false },
  },
  auth: {
    group: 'auth',
    label: 'Authentication',
    source: 'db',
    fields: [
      { key: 'jwtExpiry', label: 'JWT Expiry (s)', type: 'number', required: true },
      { key: 'allowSignup', label: 'Allow signup', type: 'bool' },
      { key: 'jwtSecret', label: 'JWT Secret', type: 'password', secret: true },
    ],
    values: { jwtExpiry: 3600, allowSignup: true, jwtSecret: '__SECRET_SET__' },
  },
  email: {
    group: 'email',
    label: 'Email (SMTP)',
    source: 'db',
    fields: [
      { key: 'host', label: 'SMTP Host', type: 'text' },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
    ],
    values: { host: 'smtp.example.com', port: 587, password: '__SECRET_SET__' },
  },
  storage: {
    group: 'storage',
    label: 'Storage',
    source: 'env',
    fields: [{ key: 's3Bucket', label: 'S3 Bucket', type: 'text' }],
    values: { s3Bucket: 'mb-demo' },
  },
  'auth.methods': {
    group: 'auth.methods',
    label: 'Auth · Methods',
    source: 'db',
    fields: [
      { key: 'emailPassword', label: 'Email + password', type: 'bool' },
      { key: 'magicLink', label: 'Magic link', type: 'bool' },
      { key: 'emailOTP', label: 'Email OTP', type: 'bool' },
      { key: 'anonymous', label: 'Anonymous sign-ins', type: 'bool' },
    ],
    values: { emailPassword: true, magicLink: true, emailOTP: true, anonymous: false },
  },
  'auth.social': {
    group: 'auth.social',
    label: 'Auth · Social providers',
    source: 'db',
    fields: [{ key: 'providers', label: 'Providers (JSON)', type: 'json', secretKeys: ['clientSecret'] }],
    values: { providers: { google: { enabled: true, clientId: 'demo', clientSecret: '__SECRET_SET__' } } },
  },
  'auth.oauth.custom': {
    group: 'auth.oauth.custom',
    label: 'Auth · Custom OIDC',
    source: 'db',
    fields: [
      { key: 'providers', label: 'Custom OIDC providers (JSON array)', type: 'json', secretKeys: ['clientSecret'] },
    ],
    values: { providers: [] },
  },
  'auth.tokens': {
    group: 'auth.tokens',
    label: 'Auth · Token expiry',
    source: 'db',
    fields: [
      { key: 'accessTokenExpMin', label: 'Access token lifetime (minutes)', type: 'number' },
      { key: 'refreshTokenExpDays', label: 'Refresh token lifetime (days)', type: 'number' },
    ],
    values: { accessTokenExpMin: 15, refreshTokenExpDays: 30 },
  },
  'auth.twoFactor': {
    group: 'auth.twoFactor',
    label: 'Auth · Two-factor',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'issuer', label: 'Issuer', type: 'text' },
      { key: 'totpDigits', label: 'TOTP digits', type: 'number' },
      { key: 'totpPeriod', label: 'TOTP period (seconds)', type: 'number' },
      { key: 'otpChannel', label: 'OTP channel', type: 'text' },
      { key: 'otpDigits', label: 'OTP digits', type: 'number' },
      { key: 'otpPeriodMinutes', label: 'OTP validity (minutes)', type: 'number' },
      { key: 'backupCodeCount', label: 'Backup codes count', type: 'number' },
      { key: 'backupCodeLength', label: 'Backup code length', type: 'number' },
      { key: 'trustDeviceDays', label: 'Trust device (days)', type: 'number' },
    ],
    values: {
      enabled: false,
      issuer: 'MyApp',
      totpDigits: 6,
      totpPeriod: 30,
      otpChannel: 'off',
      otpDigits: 6,
      otpPeriodMinutes: 3,
      backupCodeCount: 10,
      backupCodeLength: 10,
      trustDeviceDays: 30,
    },
  },
  'auth.passkey': {
    group: 'auth.passkey',
    label: 'Auth · Passkey',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'rpId', label: 'Relying-party ID (domain)', type: 'text' },
      { key: 'rpName', label: 'Relying-party name', type: 'text' },
      { key: 'origin', label: 'Origin', type: 'text' },
    ],
    values: { enabled: false, rpId: '', rpName: '', origin: '' },
  },
  'auth.sso': {
    group: 'auth.sso',
    label: 'Auth · SSO (OIDC / SAML)',
    source: 'db',
    fields: [{ key: 'enabled', label: 'Enabled', type: 'bool' }],
    values: { enabled: false },
  },
  'api.rest': {
    group: 'api.rest',
    label: 'API · REST',
    description: 'Limits for the auto-generated REST API. Changes apply on the next request.',
    source: 'db',
    fields: [
      { key: 'maxRows', label: 'Max rows per request', type: 'number', default: 1000 },
      { key: 'rpcSecurityDefiner', label: 'Exposed SECURITY DEFINER functions', type: 'text', default: '', placeholder: 'rpc_all_widgets, rpc_search' },
    ],
    values: { maxRows: 1000, rpcSecurityDefiner: '' },
  },
  'phone.sms': {
    group: 'phone.sms',
    label: 'Phone / SMS',
    source: 'db',
    fields: [
      { key: 'provider', label: 'Provider', type: 'text' },
      { key: 'accountSid', label: 'Account SID', type: 'text' },
      { key: 'authToken', label: 'Auth token', type: 'password', secret: true },
      { key: 'from', label: 'From number', type: 'text' },
      { key: 'messagingServiceSid', label: 'Messaging Service SID (optional)', type: 'text' },
      { key: 'testNumbers', label: 'Test numbers (bypass real SMS)', type: 'text', placeholder: '+15550001111:123456' },
    ],
    values: { provider: 'twilio', accountSid: '', authToken: '', from: '', messagingServiceSid: '', testNumbers: '' },
  },
  'auth.rateLimits': {
    group: 'auth.rateLimits',
    label: 'Auth · Rate limits',
    description: "Per-kind auth limits with GoTrue's windows. Counted per IP, except email and SMS, which are per project.",
    source: 'db',
    fields: [
      { key: 'emailSentPerHour', label: 'Emails sent per hour', type: 'number', help: 'Every auth email (sign-up confirmation, magic link, OTP, recovery), across the whole project.' },
      { key: 'smsSentPerHour', label: 'SMS sent per hour', type: 'number', help: 'Every auth text message, across the whole project.' },
      { key: 'tokenRefreshPer5Min', label: 'Token refreshes per 5 minutes', type: 'number', help: 'Access tokens minted (/token) per IP.' },
      { key: 'verifyPer5Min', label: 'Verifications per 5 minutes', type: 'number', help: 'OTP, magic-link, email, MFA and PKCE verifications per IP.' },
      { key: 'signInSignUpPer5Min', label: 'Sign-ups and sign-ins per 5 minutes', type: 'number', help: 'Per IP, all methods together.' },
      { key: 'anonymousPerHour', label: 'Anonymous sign-ins per hour', type: 'number', help: 'Per IP.' },
    ],
    values: { emailSentPerHour: 30, smsSentPerHour: 30, tokenRefreshPer5Min: 150, verifyPer5Min: 30, signInSignUpPer5Min: 30, anonymousPerHour: 30 },
  },
  'auth.urls': {
    group: 'auth.urls',
    label: 'Auth · URL configuration',
    description: 'The Site URL and the redirect URLs auth flows may send users back to. Wildcards: * (within a segment), ** (anything), ? (one character).',
    source: 'db',
    fields: [
      { key: 'siteUrl', label: 'Site URL', type: 'text', placeholder: 'https://app.example.com', help: 'The default redirect when none is given or the one given is not allowed.' },
      { key: 'redirectUrls', label: 'Redirect URLs (comma separated)', type: 'text', multiline: true },
    ],
    values: { siteUrl: 'https://app.example.com', redirectUrls: 'http://localhost:3000/**, https://*-acme.vercel.app/**' },
  },
  'auth.attackProtection': {
    group: 'auth.attackProtection',
    label: 'Auth · Attack protection',
    description: 'CAPTCHA on the auth endpoints and on any other route you choose, and a leaked-password check.',
    source: 'db',
    fields: [
      { key: 'captchaEnabled', label: 'Enable CAPTCHA protection', type: 'bool', help: 'Clients must then send options.captchaToken on every guarded call.' },
      { key: 'captchaProvider', label: 'CAPTCHA provider', type: 'select', options: [{ value: 'hcaptcha', label: 'hCaptcha' }, { value: 'turnstile', label: 'Cloudflare Turnstile' }] },
      { key: 'captchaSecret', label: 'CAPTCHA secret', type: 'password', secret: true },
      { key: 'captchaSiteKey', label: 'Site key (hCaptcha, optional)', type: 'text' },
      { key: 'captchaAuthEndpoints', label: 'Guarded auth endpoints', type: 'json', default: ['/sign-up/email', '/sign-in/email', '/sign-in/anonymous', '/sign-in/magic-link', '/email-otp/send-verification-otp', '/email-otp/request-password-reset', '/phone-number/send-otp', '/request-password-reset'] },
      { key: 'captchaRoutes', label: 'Other guarded routes', type: 'json', default: [] },
      { key: 'leakedPasswordProtection', label: 'Prevent use of leaked passwords', type: 'bool', help: 'Rejects passwords found in HaveIBeenPwned. Only the first 5 characters of the SHA-1 hash are sent.' },
    ],
    values: { captchaEnabled: true, captchaProvider: 'turnstile', captchaSecret: '__SECRET_SET__', captchaSiteKey: '', captchaAuthEndpoints: ['/sign-up/email', '/sign-in/email', '/request-password-reset'], captchaRoutes: [{ methods: ['POST'], pathGlob: '/rest/v1/orders' }], leakedPasswordProtection: false },
  },
  'auth.thirdParty': {
    group: 'auth.thirdParty',
    label: 'Auth · Third-party auth',
    description: 'JWTs from Clerk, Firebase Auth, Auth0, AWS Cognito or WorkOS, accepted by the data API.',
    source: 'db',
    fields: [{ key: 'providers', label: 'Providers', type: 'json', placeholder: '[ { "id": "clerk", "type": "clerk", "issuer": "https://clerk.example.com" } ]' }],
    values: { providers: [{ id: 'clerk-1', type: 'clerk', enabled: true, issuer: 'https://acme.clerk.accounts.dev', jwksUrl: '', audience: '' }] },
  },
  'auth.hooks.signUp': {
    group: 'auth.hooks.signUp',
    label: 'Auth · Sign-up gate',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'emailDomainMode', label: 'Email domain rule', type: 'text' },
      { key: 'emailDomains', label: 'Email domains', type: 'text' },
      { key: 'webhookUrl', label: 'Verdict webhook URL', type: 'text' },
      { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
    ],
    values: { enabled: false, emailDomainMode: 'off', emailDomains: '', webhookUrl: '', webhookSecret: '' },
  },
  'auth.hooks.accessToken': {
    group: 'auth.hooks.accessToken',
    label: 'Auth · Access token claims',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'includeUserFields', label: 'User fields to include', type: 'text' },
      { key: 'staticClaims', label: 'Static claims (JSON)', type: 'json' },
    ],
    values: { enabled: false, includeUserFields: '', staticClaims: {} },
  },
  'auth.hooks.send': {
    group: 'auth.hooks.send',
    label: 'Auth · Delivery override',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'email', label: 'Override email delivery', type: 'bool' },
      { key: 'sms', label: 'Override SMS delivery', type: 'bool' },
      { key: 'webhookUrl', label: 'Delivery webhook URL', type: 'text' },
      { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
    ],
    values: { enabled: false, email: false, sms: false, webhookUrl: '', webhookSecret: '' },
  },
  'auth.hooks.events': {
    group: 'auth.hooks.events',
    label: 'Auth · Event webhook',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'events', label: 'Events', type: 'text' },
      { key: 'webhookUrl', label: 'Event webhook URL', type: 'text' },
      { key: 'webhookSecret', label: 'Webhook signing secret', type: 'password', secret: true },
    ],
    values: { enabled: false, events: '', webhookUrl: '', webhookSecret: '' },
  },
  'auth.phoneOtp': {
    group: 'auth.phoneOtp',
    label: 'Auth · Phone (SMS)',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enable phone sign-in', type: 'bool' },
      { key: 'otpLength', label: 'OTP length', type: 'number' },
      { key: 'expiresIn', label: 'OTP expiry (seconds)', type: 'number' },
      { key: 'signUpOnVerification', label: 'Create account on first verified number', type: 'bool' },
    ],
    values: { enabled: false, otpLength: 6, expiresIn: 300, signUpOnVerification: true },
  },
  'auth.organization': {
    group: 'auth.organization',
    label: 'Auth · Organizations',
    source: 'db',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
      { key: 'allowUserToCreateOrganization', label: 'Users can create orgs', type: 'bool' },
      { key: 'teamsEnabled', label: 'Teams inside organizations', type: 'bool' },
      { key: 'maxMembers', label: 'Maximum members per organization', type: 'number' },
    ],
    values: { enabled: true, allowUserToCreateOrganization: true, teamsEnabled: false, maxMembers: 0 },
  },
};

export const aiModels: Record<string, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'gpt-5-mini', label: 'gpt-5-mini' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'deepseek-chat' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
  ],
  compatible: [],
};

export const aiThreads = [
  {
    id: 't-mock',
    title: 'What tables do I have?',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

export const aiThreadMessages = [
  { role: 'user' as const, text: 'What tables do I have?' },
  {
    role: 'assistant' as const,
    text: 'Your public schema has one table: users.',
    toolCalls: [{ id: 'c1', name: 'list_tables', input: { schema: 'public' } }],
  },
  {
    role: 'tool' as const,
    results: [{ callId: 'c1', name: 'list_tables', result: [{ name: 'users' }] }],
  },
];

const counts = [
  { model: 'User', count: 23, schema: 'public' },
  { model: 'Post', count: 11, schema: 'public' },
  // A non-public table, so "user tables" on the Overview is a real filter here
  // rather than a no-op that happens to include everything.
  { model: 'reporting.daily_signups', count: 90, schema: 'reporting' },
  { model: 'Session', count: 7, schema: 'auth' },
];

export const stats = {
  counts,
  system: {
    uptimeSec: 86_400 + 3_600,
    memory: { rss: 180_000_000, heapUsed: 95_000_000, heapTotal: 130_000_000, external: 12_000_000 },
    loadAverage: [0.4, 0.5, 0.6],
    cpuCount: 8,
    platform: 'linux',
    eventLoopLagMs: 1.2,
    dbConnections: 5,
    requestThroughput: { windowMs: 10_000, requests: 420, rps: 42 },
    p95LatencyMs: 38,
  },
};

let logId = 1000;

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

const HTTP_ROUTES = [
  '/api/users', '/api/users/42', '/api/rest/v1/orders?select=*', '/api/auth/sign-in/email',
  '/api/storage/avatars/u_42.png', '/api/functions/v1/send-receipt', '/api/realtime/channels',
];
const SQL_STATEMENTS = [
  'SELECT id, email FROM auth.users ORDER BY created_at DESC LIMIT 50',
  'UPDATE public.orders SET status = $1 WHERE id = $2',
  'INSERT INTO public.events (kind, payload) VALUES ($1, $2)',
];

/**
 * Messages shaped like the ones the real producers emit, because the Logs
 * screen parses them: `middlewares/request-logger.ts` writes
 * `METHOD /path -> STATUS (12ms) [id]`, and the UI splits that into columns.
 * A fixture of "info sample log line 1234" renders down a path no real line
 * takes, which is exactly the wrong thing for a mock meant for UI work.
 */
function mockMessage(level: 'info' | 'warn' | 'error', source: string): string {
  if (source === 'http') {
    const status = level === 'error' ? pick([500, 502, 503]) : level === 'warn' ? pick([400, 401, 404, 429]) : pick([200, 201, 204, 304]);
    const ms = level === 'info' ? Math.floor(Math.random() * 120) + 3 : Math.floor(Math.random() * 1800) + 200;
    return `${pick(['GET', 'GET', 'POST', 'PATCH', 'DELETE'])} ${pick(HTTP_ROUTES)} → ${status} (${ms}ms) [req-${logId}]`;
  }
  // `sql.service.ts#audit` writes `[sql:<outcome>] <statement> (N rows)`.
  if (source === 'sql') {
    return `[sql:${level === 'error' ? 'error' : 'ok'}] ${pick(SQL_STATEMENTS)} (${Math.floor(Math.random() * 40) + 1} rows)`;
  }
  // Everything else goes through `logActivity`, which writes `[tag] rest` with
  // the duration as `in <n>ms` / `after <n>ms` and metadata as `key=value`.
  // `source: message` was never a shape any producer emits, so it exercised the
  // plain-text fallback instead of the renderer real lines take.
  const tag = source === 'job' ? `job:${pick(['storage-cleanup', 'backup', 'data-retention', 'realtime-outbox'])}` : source;
  if (level === 'error') {
    return `[${tag}] failed after ${Math.floor(Math.random() * 900) + 100}ms, ${pick([
      'connection refused',
      'timeout',
      'permission denied for relation "orders"',
    ])}`;
  }
  if (level === 'warn') {
    return `[${tag}] ${pick([
      'rate limit scope=ip route=/api/rest/v1/orders',
      'retrying attempt=2',
      'deprecated field="user_id" used',
    ])}`;
  }
  return `[${tag}] ${pick([
    `ok in ${Math.floor(Math.random() * 40) + 4}ms`,
    'ok',
    `delivered url=https://hooks.test/inbound in ${Math.floor(Math.random() * 300) + 20}ms`,
    `connect socket=sk_${Math.floor(Math.random() * 9999)} user=usr_1`,
  ])}`;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile Safari/604.1',
  'curl/8.4.0',
  'motherbase-cli/1.4.2',
  'python-requests/2.32.3',
];

/** Spread over a month so the wider log ranges have something to show. */
export const makeLogs = (n: number, spanMs = 30 * 24 * 3_600_000) =>
  Array.from({ length: n }, () => {
    const level = pick(['info', 'info', 'info', 'warn', 'error'] as const);
    const source = pick(['http', 'http', 'http', 'sql', 'auth', 'edge', 'storage', 'job', 'webhook', 'realtime', 'shield']);
    const message = mockMessage(level, source);
    // The structured twin of the message, as the request logger now records it.
    const http = source === 'http' ? /^([A-Z]+) (\S+) → (\d{3}) \((\d+)ms\) \[([^\]]+)\]$/.exec(message) : null;
    return {
      id: logId++,
      // Weighted towards the recent end: most sessions look at the last hour,
      // but a 7d or 30d range must not come back empty in the mock either.
      at: iso(Math.random() ** 3 * spanMs),
      level,
      source,
      message,
      method: http?.[1],
      path: http?.[2].split('?')[0],
      status: http ? Number(http[3]) : undefined,
      durationMs: http ? Number(http[4]) : undefined,
      ip: http ? `203.0.113.${Math.floor(Math.random() * 254) + 1}` : undefined,
      userAgent: http ? pick(USER_AGENTS) : undefined,
      requestId: http?.[5],
      userId: http && Math.random() > 0.5 ? `u_${Math.floor(Math.random() * 90) + 10}` : undefined,
    };
  });

export const shield = {
  ranAt: iso(0),
  recommendations: [
    {
      id: 'r1',
      category: 'security' as const,
      level: 'critical' as const,
      title: 'RLS disabled on posts',
      detail: 'Table posts is publicly readable without row-level security.',
      target: 'posts',
      remediation: 'Enable RLS and add a SELECT policy.',
    },
    {
      id: 'r2',
      category: 'performance' as const,
      level: 'warning' as const,
      title: 'Sequential scans on users',
      detail: 'High seq scan count.',
      target: 'users',
      remediation: 'Add an index on email.',
    },
    {
      id: 'r3',
      category: 'abuse' as const,
      level: 'info' as const,
      title: 'Rate limit headroom',
      detail: 'Auth route near limit during peak.',
      target: '/auth/login',
    },
  ],
  counts: { critical: 1, warning: 1, info: 1 },
  advisor: { findings: [], counts: { critical: 1, warning: 1, info: 1 }, ranAt: iso(0) },
  telemetry: {
    counts: { requests: 12_340, errors: 42, slow: 18, rateLimited: 3 },
    routes: [
      { route: 'GET /rest/v1/posts', source: 'rest', count: 5400, errors: 2, slow: 8, avgMs: 22, p95Ms: 60 },
      { route: 'POST /auth/login', source: 'auth', count: 800, errors: 12, slow: 1, avgMs: 90, p95Ms: 210 },
    ],
  },
  edge: { publicInvokeEnabled: true, tokenConfigured: false, secretsEnabled: true, functions: 2, enabledFunctions: 1 },
  rateLimit: { windowMs: 60_000, limits: { global: 1000, auth: 20, restRead: 300, restWrite: 100, edge: 50 } },
};

export const performance = {
  ranAt: iso(0),
  // Available, so mock mode shows the rows the index advisor hangs off.
  slowQueries: {
    available: true as const,
    byMean: [
      { query: 'SELECT * FROM public.orders WHERE customer_id = $1 ORDER BY created_at DESC', calls: 1840, meanExecTimeMs: 48.2, totalExecTimeMs: 88688, rows: 36800 },
      { query: 'SELECT count(*) FROM public.users WHERE email ILIKE $1', calls: 96, meanExecTimeMs: 31.5, totalExecTimeMs: 3024, rows: 96 },
    ],
    byTotal: [
      { query: 'SELECT * FROM public.orders WHERE customer_id = $1 ORDER BY created_at DESC', calls: 1840, meanExecTimeMs: 48.2, totalExecTimeMs: 88688, rows: 36800 },
    ],
  },
  tableScans: [
    {
      schema: 'public',
      table: 'users',
      seqScan: 1200,
      idxScan: 340,
      liveRows: 23,
      deadRows: 4,
      missingIndexCandidate: true,
      needsVacuum: false,
    },
  ],
  missingIndexCandidates: [
    {
      schema: 'public',
      table: 'users',
      seqScan: 1200,
      idxScan: 340,
      liveRows: 23,
      deadRows: 4,
      missingIndexCandidate: true,
      needsVacuum: false,
    },
  ],
  bloatCandidates: [],
  unusedIndexes: [{ schema: 'public', table: 'posts', index: 'posts_old_idx', idxScan: 0, sizeBytes: 16_384 }],
  cacheHitRatio: { ratioPct: 99.2, heapBlocksHit: 982_000, heapBlocksRead: 7_800 },
  activeQueries: [
    {
      pid: 4821,
      user: 'app',
      applicationName: 'api',
      clientAddr: '10.0.0.5',
      ageSec: 2,
      query: 'SELECT * FROM posts WHERE published = true',
    },
  ],
  slowHttpRoutes: shield.telemetry.routes,
};

/**
 * The integrations catalogue, shaped like `IntegrationsService.list()`. Mock
 * mode had no handler for it at all, so the page it feeds could not be looked
 * at without a backend, which is the one thing mock mode exists for.
 */
export const integrations = [
  ['stripe', 'Stripe', 'payments', 'Query customers and receive Stripe webhook events.', 2, true],
  ['shopify', 'Shopify', 'payments', 'Read orders from a Shopify store.', 1, false],
  ['calendly', 'Calendly', 'scheduling', 'List scheduled events and receive booking webhooks.', 2, false],
  ['airtable', 'Airtable', 'data', 'Read and write Airtable records.', 2, false],
  ['notion', 'Notion', 'data', 'Query a Notion database.', 1, false],
  ['posthog', 'PostHog', 'data', 'Send product analytics events from the backend.', 1, false],
  ['algolia', 'Algolia', 'data', 'Search and index records in Algolia.', 2, false],
  ['hubspot', 'HubSpot', 'data', 'Read and create CRM contacts.', 2, false],
  ['slack', 'Slack', 'messaging', 'Post messages to a Slack channel.', 1, true],
  ['discord', 'Discord', 'messaging', 'Post messages to a Discord channel.', 1, false],
  ['telegram', 'Telegram', 'messaging', 'Send messages from a Telegram bot and receive updates.', 2, false],
  ['resend', 'Resend', 'email', 'Send transactional email through Resend.', 1, false],
  ['sendgrid', 'SendGrid', 'email', 'Send transactional email through SendGrid.', 1, false],
  ['postmark', 'Postmark', 'email', 'Send transactional email through Postmark.', 1, false],
  ['openai', 'OpenAI', 'ai', 'Call chat completions from an edge function.', 1, false],
  ['anthropic', 'Anthropic', 'ai', 'Call Claude from an edge function.', 1, false],
  ['github', 'GitHub', 'devtools', 'Read repository activity.', 1, false],
  ['linear', 'Linear', 'devtools', 'Query and create Linear issues.', 2, false],
  ['sentry', 'Sentry', 'devtools', 'Read unresolved issues from a Sentry project.', 1, false],
  ['cloudflare', 'Cloudflare', 'devtools', 'Purge the CDN cache for a zone.', 1, false],
  ['twilio', 'Twilio', 'messaging', 'Send SMS from an edge function.', 1, false],
].map(([key, name, category, description, functionCount, connected]) => ({
  key: key as string,
  name: name as string,
  category: category as string,
  description: description as string,
  docsUrl: `https://example.com/${key}`,
  secrets: [{ name: `${String(key).toUpperCase()}_API_KEY`, label: 'API key', placeholder: 'key…', set: Boolean(connected) }],
  functions: Array.from({ length: functionCount as number }, (_, i) => ({
    name: `${key}-fn-${i + 1}`,
    route: `${key}-fn-${i + 1}`,
    description: `Prebuilt ${name} function ${i + 1}.`,
    readiness: 'production' as const,
    // Last function of each provider is a receiver, so the mock shows the
    // webhook chip and the signing-secret copy the real catalogue has.
    kind: (i === (functionCount as number) - 1 && (functionCount as number) > 1 ? 'webhook' : 'action') as
      | 'action'
      | 'webhook',
    installed: Boolean(connected),
  })),
  connected: Boolean(connected),
}));

// -- Multi-page, multi-schema, multi-project scenarios ----------------------
//
// A mock that only ever returns one page, one schema and one project cannot
// show a pagination bug, a schema-selection bug or a cache that leaks between
// projects. These fixtures make those visible in `npm run studio:mock`.

/** Every schema the picker offers, not just `public`. */
export const schemas = ['public', 'reporting', 'auth', 'storage', 'platform'];

/** Tables per schema, so selecting a schema actually changes the list. */
export const schemaTablesBySchema: Record<string, typeof schemaTables> = {
  public: schemaTables,
  reporting: [
    {
      name: 'daily_signups',
      columns: cols([
        { name: 'day', type: 'date', nullable: false, default: null, isPrimaryKey: true },
        { name: 'signups', type: 'integer', nullable: false, default: '0', isPrimaryKey: false },
      ]),
    },
  ],
  auth: [
    {
      name: 'session',
      columns: cols([
        { name: 'token', type: 'text', nullable: false, default: null, isPrimaryKey: false },
        { name: 'userId', type: 'text', nullable: false, default: null, isPrimaryKey: false },
      ]),
    },
  ],
  storage: [],
  platform: [],
};

/** A table outside `public`, addressed by its qualified id. */
export const reportingTableMeta = {
  model: 'reporting.daily_signups',
  dbName: 'daily_signups',
  schema: 'reporting',
  primaryKey: 'day',
  dynamic: true,
  fields: [
    { name: 'day', type: 'date', kind: 'scalar' as const, isId: true, isList: false, isRequired: true, isReadOnly: false, sensitive: false },
    { name: 'signups', type: 'integer', kind: 'scalar' as const, isId: false, isList: false, isRequired: true, isReadOnly: false, sensitive: false },
  ],
};

export const reportingRows: DataRow[] = Array.from({ length: 90 }, (_, i) => ({
  day: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
  signups: 10 + ((i * 7) % 40),
}));

/**
 * 60 objects in one bucket: more than the server 25-row default page, so the
 * pager and the server-side filters are exercised. The old fixture returned
 * every file in one response, which is the shape in which a missing pager is
 * invisible.
 */
export const overflowFiles: DataRow[] = Array.from({ length: 60 }, (_, i) =>
  file(
    `file_bulk_${i + 1}`,
    'reports',
    `reports/${String(i + 1).padStart(3, '0')}-quarterly.pdf`,
    'application/pdf',
    200_000 + i * 1_000,
    i % 3 === 0 ? 'public' : 'private',
  ),
);

/** App jobs as the inventory reports them: declared, never-run, and orphaned. */
export const appJobs = [
  {
    id: 'backup',
    name: 'Automatic backup',
    kind: 'platform' as const,
    schedule: '0 3 * * *',
    enabled: true,
    scheduled: true,
    running: false,
    state: 'ok' as const,
    lastRunAt: iso(3_600_000 * 6),
    lastStatus: 'ok' as const,
    lastError: null,
    nextRunAt: iso(-3_600_000 * 18),
    runs: 14,
    declared: true,
    medianIntervalMs: 86_400_000,
    definition: {
      does: 'Dumps the database on its cadence and uploads the dump to the configured destination, then prunes dumps past the retention window.',
      source: 'apps/server/services/admin/backup-scheduler.service.ts',
      settingsHref: '/settings#backups',
    },
    runnable: true,
    configurable: false,
  },
  {
    id: 'edge:fn_nightly',
    name: 'nightly-report',
    kind: 'edge' as const,
    schedule: '0 2 * * *',
    enabled: true,
    scheduled: true,
    running: false,
    state: 'failed' as const,
    lastRunAt: iso(3_600_000 * 9),
    lastStatus: 'error' as const,
    lastError: 'TypeError: Cannot read properties of undefined (reading rows)',
    nextRunAt: iso(-3_600_000 * 15),
    runs: 6,
    declared: true,
    medianIntervalMs: 86_400_000,
    definition: {
      does: 'Invokes the edge function "nightly-report" in the same Deno runtime an HTTP call would use, with an empty request body.',
      source: 'edge function "nightly-report"',
      settingsHref: '/edge-functions',
    },
    runnable: true,
    configurable: true,
  },
  {
    // Configured and never fired: the case a ledger-only list could not show.
    id: 'data-retention',
    name: 'Data retention',
    kind: 'platform' as const,
    schedule: '30 4 * * *',
    enabled: true,
    scheduled: true,
    running: false,
    state: 'scheduled' as const,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: iso(-3_600_000 * 20),
    runs: 0,
    declared: true,
    medianIntervalMs: null,
    definition: {
      does: 'Deletes rows past the retention window configured for each enabled target, so logs and other expiring data do not grow without bound.',
      source: 'apps/server/services/admin/data-retention-scheduler.service.ts',
      settingsHref: '/settings#data.retention',
    },
    runnable: true,
    configurable: false,
  },
  {
    // In the ledger, claimed by no live scheduler.
    id: 'edge:fn_removed',
    name: 'edge:fn_removed',
    kind: 'platform' as const,
    schedule: null,
    enabled: false,
    scheduled: false,
    running: false,
    state: 'ok' as const,
    lastRunAt: iso(86_400_000 * 4),
    lastStatus: 'ok' as const,
    lastError: null,
    nextRunAt: null,
    runs: 31,
    declared: false,
    medianIntervalMs: 3_600_000,
    definition: {
      does: 'Unknown: this job is only remembered by the ledger, and no scheduler in this process claims it.',
      source: 'not declared by any scheduler in this build',
      settingsHref: null,
    },
    runnable: false,
    configurable: false,
  },
];

export const appJobRuns = [
  { id: 'r4', job: 'edge:fn_nightly', startedAt: iso(600_000), finishedAt: iso(600_000 - 420), status: 'ok' as const, error: null, output: '{\n  "durationMs": 412,\n  "stdout": "fetched 128 rows\\nwrote report to reports/2026-09-16.csv",\n  "value": { "rows": 128 }\n}', trigger: 'manual' as const },
  { id: 'r3', job: 'edge:fn_nightly', startedAt: iso(3_600_000 * 9), finishedAt: iso(3_600_000 * 9 - 800), status: 'failed' as const, error: 'TypeError: Cannot read properties of undefined (reading rows)', output: null, trigger: 'schedule' as const },
  { id: 'r2', job: 'edge:fn_nightly', startedAt: iso(3_600_000 * 33), finishedAt: iso(3_600_000 * 33 - 700), status: 'failed' as const, error: 'TypeError: Cannot read properties of undefined (reading rows)', output: null, trigger: 'schedule' as const },
  { id: 'r1', job: 'edge:fn_nightly', startedAt: iso(3_600_000 * 57), finishedAt: iso(3_600_000 * 57 - 650), status: 'ok' as const, error: null, output: '{\n  "durationMs": 650,\n  "value": { "rows": 96 }\n}', trigger: 'schedule' as const },
];

/** pg_cron, which had no handler at all: the page always showed "No cron jobs yet". */
export const pgCronJobs = {
  jobs: [
    { jobid: 1, jobname: 'refresh_matviews', schedule: '*/15 * * * *', command: 'REFRESH MATERIALIZED VIEW reporting.daily_signups', active: true, database: 'demo', username: 'postgres' },
    { jobid: 2, jobname: 'vacuum_events', schedule: '0 5 * * 0', command: 'VACUUM ANALYZE public.events', active: false, database: 'demo', username: 'postgres' },
  ],
  extensionMissing: false,
};

export const realtimeQueue = {
  queue: {
    pending: 3,
    processing: 1,
    failed: 12,
    oldestPendingAt: iso(45_000),
    lastFailure: {
      at: iso(300_000),
      model: 'Post',
      action: 'updated',
      error: 'delivery exhausted after 5 attempts',
    },
    measured: true,
  },
  inspectorRetained: 200,
};

/** The events a webhook can subscribe to that are not row changes. */
export const systemEvents = [
  ...['sign-in', 'sign-up', 'sign-out', 'forget-password', 'reset-password', 'verify-email', 'two-factor'].map(
    action => ({ spec: `auth.${action}`, label: `Auth / ${action}`, description: `Fires on the ${action} auth flow.` }),
  ),
  {
    spec: 'job_alert.created',
    label: 'Job alerts',
    description: 'A scheduled job failed repeatedly, stopped running, or a backup fell past its objective.',
  },
];

/** What the REST router serves, with real keys. Not every table in every schema. */
export const restResources = [
  {
    name: 'posts',
    path: '/rest/v1/posts',
    primaryKey: ['id'],
    rlsEnabled: true,
    columns: [
      { name: 'id', type: 'uuid', nullable: false, hasDefault: true, isPrimaryKey: true, isGenerated: false },
      { name: 'title', type: 'text', nullable: false, hasDefault: false, isPrimaryKey: false, isGenerated: false },
      { name: 'published', type: 'boolean', nullable: false, hasDefault: true, isPrimaryKey: false, isGenerated: false },
    ],
  },
  {
    // Keyed on something other than `id`, so a hardcoded `id=eq.:id` filter
    // would be visibly wrong here.
    name: 'page_views',
    path: '/rest/v1/page_views',
    primaryKey: ['day', 'path'],
    rlsEnabled: true,
    columns: [
      { name: 'day', type: 'date', nullable: false, hasDefault: false, isPrimaryKey: true, isGenerated: false },
      { name: 'path', type: 'text', nullable: false, hasDefault: false, isPrimaryKey: true, isGenerated: false },
      { name: 'views', type: 'integer', nullable: false, hasDefault: true, isPrimaryKey: false, isGenerated: false },
    ],
  },
];

/**
 * Per-project overrides, so switching projects visibly changes the data.
 * Every admin handler used to answer from one set of fixtures whatever project
 * was in the URL, which made a cache leaking between projects invisible.
 */
export const perProject: Record<string, { tableMetas: unknown[]; rowsByTable: Record<string, DataRow[]> }> = {
  staging: {
    tableMetas: [
      {
        model: 'Ticket',
        dbName: 'tickets',
        schema: 'public',
        primaryKey: 'id',
        fields: tableMetas[1].fields,
      },
    ],
    rowsByTable: {
      Ticket: Array.from({ length: 4 }, (_, i) => ({
        id: `tkt_${i + 1}`,
        title: `Staging ticket ${i + 1}`,
        published: false,
        createdAt: iso(i * 7_200_000),
      })),
    },
  },
};

export const platformDisk = {
  host: { path: '/srv/projects', total: 80 * GIB, used: Math.round(52.3 * GIB), free: Math.round(23.6 * GIB), percent: 69 },
  projects: [
    {
      project: 'demo',
      size: Math.round(6.4 * GIB),
      quota: 10 * GIB,
      volumes: [
        { name: 'minio_data', label: 'Storage files', size: Math.round(4.1 * GIB) },
        { name: 'db_data', label: 'Database', size: Math.round(1.9 * GIB) },
        { name: 'api_backups', label: 'Backups', size: 380 * MIB },
        { name: 'api_data', label: 'App data', size: 24 * MIB },
      ],
    },
    {
      project: 'staging',
      size: 310 * MIB,
      quota: 10 * GIB,
      volumes: [
        { name: 'db_data', label: 'Database', size: 260 * MIB },
        { name: 'minio_data', label: 'Storage files', size: 50 * MIB },
      ],
    },
  ],
  measuredAt: iso(90_000),
};
