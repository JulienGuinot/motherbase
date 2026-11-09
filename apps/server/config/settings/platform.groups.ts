import { z } from 'zod';
import { PROVIDERS, PROVIDER_IDS, getProvider } from '@motherbase/ai';
import { rateLimitRulesSchema } from '../../lib/rate-limit-rules';
import type { GroupDef } from './types';

export const storageProvider: GroupDef = {
  key: 'storage.provider',
  label: 'Storage provider',
  fields: [
    { key: 'driver', label: 'Driver', type: 'select', default: 'local',
      options: [{ value: 'local', label: 'Local disk' }, { value: 's3', label: 'S3-compatible' }] },
    { key: 'staticPath', label: 'Local static path', type: 'text', default: 'uploads' },
    { key: 'userPath', label: 'Local user path', type: 'text', default: 'users' },
    { key: 's3Endpoint', label: 'S3 endpoint', type: 'text', placeholder: 'https://s3.example.com' },
    { key: 's3Region', label: 'S3 region', type: 'text', default: 'us-east-1' },
    { key: 's3AccessKeyId', label: 'S3 access key ID', type: 'text' },
    { key: 's3SecretAccessKey', label: 'S3 secret access key', type: 'password', secret: true },
    { key: 's3Bucket', label: 'S3 bucket', type: 'text', default: 'uploads' },
    { key: 's3PublicUrl', label: 'S3 public URL', type: 'text', placeholder: 'https://cdn.example.com' },
  ],
  schema: z.object({
    driver: z.enum(['local', 's3']).default('local'),
    staticPath: z.string().optional().default('uploads'),
    userPath: z.string().optional().default('users'),
    s3Endpoint: z.string().optional().default(''),
    s3Region: z.string().optional().default('us-east-1'),
    s3AccessKeyId: z.string().optional().default(''),
    s3SecretAccessKey: z.string().optional().default(''),
    s3Bucket: z.string().optional().default('uploads'),
    s3PublicUrl: z.string().optional().default(''),
  }),
  envFallback: () => ({
    driver: process.env.STORAGE_DRIVER || 'local',
    staticPath: process.env.STATIC_PATH || 'uploads',
    userPath: process.env.USER_PATH || 'users',
    s3Endpoint: process.env.S3_ENDPOINT || '',
    s3Region: process.env.S3_REGION || 'us-east-1',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    s3Bucket: process.env.S3_BUCKET || 'uploads',
    s3PublicUrl: process.env.S3_PUBLIC_URL || '',
  }),
};

// Upload constraints enforced by StorageService on every upload/presign. The max
// size is additionally capped by the server MAX_UPLOAD_MB (a hard ceiling).
export const storageLimits: GroupDef = {
  key: 'storage.limits',
  label: 'Storage · Limits',
  description: 'Upload size and type constraints. Max size is also capped by the server MAX_UPLOAD_MB.',
  fields: [
    { key: 'maxUploadBytes', label: 'Max upload size (bytes)', type: 'number', default: 0,
      help: '0 uses the server default (MAX_UPLOAD_MB). A positive value is additionally capped to it.' },
    { key: 'allowedMimeTypes', label: 'Allowed MIME types', type: 'text', placeholder: 'image/*, application/pdf',
      help: 'Comma-separated. Blank allows all. Wildcards like image/* are supported.' },
  ],
  schema: z.object({
    maxUploadBytes: z.coerce.number().int().min(0).default(0),
    allowedMimeTypes: z.string().optional().default(''),
  }),
  envFallback: () => ({ maxUploadBytes: 0, allowedMimeTypes: '' }),
};

// Supabase's "Image transformations" switch. On by default: a transform only
// ever reads an object the caller could already download.
export const storageImageTransform: GroupDef = {
  key: 'storage.imageTransform',
  label: 'Storage · Image transformations',
  description: 'Resize and convert images on the fly through /storage/v1/render/image.',
  fields: [
    { key: 'enabled', label: 'Enable image transformations', type: 'bool', default: true,
      help: 'When off, every render URL answers 403 and the original object is still downloadable as usual.' },
    { key: 'maxSourceBytes', label: 'Largest source image (bytes)', type: 'number', default: 26_214_400,
      help: 'Images above this size are refused rather than decoded. 25 MB, like Supabase, by default.' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(true),
    maxSourceBytes: z.coerce.number().int().min(1).default(26_214_400),
  }),
  envFallback: () => ({ enabled: true, maxSourceBytes: 26_214_400 }),
};

// Supabase's "S3 connection" switch. On by default: without an access key,
// which only an operator can create, the endpoint authenticates nobody.
export const storageS3: GroupDef = {
  key: 'storage.s3',
  label: 'Storage · S3 connection',
  description: 'An S3-compatible endpoint at /storage/v1/s3, authenticated with S3 access keys.',
  fields: [
    { key: 'enabled', label: 'Enable the S3 protocol', type: 'bool', default: true,
      help: 'When off, every S3 request is refused. Access keys are kept and work again once it is back on.' },
  ],
  schema: z.object({ enabled: z.coerce.boolean().default(true) }),
  envFallback: () => ({ enabled: true }),
};


export const serverCors: GroupDef = {
  key: 'server.cors',
  label: 'Security · CORS',
  fields: [
    {
      key: 'origins',
      label: 'Allowed origins',
      type: 'text',
      placeholder: '*, http://localhost:3000, https://app.example.com',
      default: '',
    },
    {
      key: 'credentials',
      label: 'Allow credentials (cookies / auth headers)',
      type: 'bool',
      default: true,
    },
  ],
  schema: z.object({
    origins: z.string().optional().default(''),
    credentials: z.coerce.boolean().default(true),
  }),
  envFallback: () => ({
    origins: process.env.CORS_ORIGINS || '',
    credentials: true,
  }),
};

// Per-scope request rate limits, all console-tunable and applied live (see
// middlewares/rate-limit.ts applyRateLimitLimits). express-rate-limit reads
// `windowMs` once at construction, so the limiters are rebuilt when it changes.
// 0 is rejected: use a high number to effectively disable a scope.
export const securityRateLimit: GroupDef = {
  key: 'security.rateLimit',
  label: 'Security · Rate limits',
  description: 'Max requests per client, per scope, within the rate-limit window. Changes apply live.',
  fields: [
    { key: 'windowMin', label: 'Window (minutes)', type: 'number', default: 15,
      help: 'The period every limit below is counted over. Changing it restarts the current '
        + 'window, so in-flight counters reset to zero.' },
    { key: 'global', label: 'Global (req / window / client)', type: 'number', default: 1000 },
    { key: 'auth', label: 'Auth endpoints', type: 'number', default: 20,
      help: 'Every /api/auth call together. The per-kind limits (emails, SMS, sign-ins…) are auth.rateLimits.' },
    { key: 'restRead', label: 'REST read (GET)', type: 'number', default: 300 },
    { key: 'restWrite', label: 'REST write (POST/PATCH/DELETE)', type: 'number', default: 120 },
    { key: 'edge', label: 'Edge function invokes', type: 'number', default: 60 },
  ],
  schema: z.object({
    // A day is already an absurd rate-limit window; the cap exists so a typo
    // cannot park every counter for a year.
    windowMin: z.coerce.number().int().positive().max(1440).default(15),
    global: z.coerce.number().int().positive().default(1000),
    auth: z.coerce.number().int().positive().default(20),
    restRead: z.coerce.number().int().positive().default(300),
    restWrite: z.coerce.number().int().positive().default(120),
    edge: z.coerce.number().int().positive().default(60),
  }),
  envFallback: () => ({
    windowMin: Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15,
    global: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 1000,
    auth: Number(process.env.RATE_LIMIT_AUTH_MAX) || 20,
    restRead: Number(process.env.RATE_LIMIT_REST_READ_MAX) || 300,
    restWrite: Number(process.env.RATE_LIMIT_REST_WRITE_MAX) || 120,
    edge: Number(process.env.RATE_LIMIT_EDGE_MAX) || 60,
  }),
};

// Operator-defined rate-limit rules, layered on top of the fixed scopes above.
// Stored as a JSON array; validated by the shared rateLimitRulesSchema so the
// server and the console form agree on the rule shape. Applied live on save
// (see admin-settings.controller.ts → applyRateLimitRules).
export const securityRateLimitRules: GroupDef = {
  key: 'security.rateLimitRules',
  label: 'Security · Rate-limit rules',
  description:
    'Custom rules on top of the built-in scopes. Every matching rule applies and the most restrictive wins; rules can only tighten limits. Changes apply live.',
  fields: [
    {
      key: 'rules',
      label: 'Rules (JSON array)',
      type: 'json',
      placeholder:
        '[ { "name": "login burst", "match": { "pathGlob": "/auth/*", "methods": ["POST"] }, "key": "ip", "windowSec": 60, "max": 5 } ]',
      help: 'Match by method / path glob / role; bucket by ip, user, apiKey, role or global.',
    },
  ],
  schema: rateLimitRulesSchema,
  envFallback: () => ({ rules: [] }),
};


export const backupSchedule: GroupDef = {
  key: 'backup.schedule',
  label: 'Backups · Schedule',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'cron', label: 'Cron expression', type: 'text', default: '0 3 * * *', placeholder: '0 3 * * *' },
    { key: 'retention', label: 'Retention (keep newest N)', type: 'number', default: 7 },
    { key: 'offsite', label: 'Offsite upload to S3', type: 'bool', default: false },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    cron: z.string().min(1, 'cron is required').default('0 3 * * *'),
    retention: z.coerce.number().int().positive().default(7),
    offsite: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({
    enabled: process.env.BACKUP_ENABLED === 'true',
    cron: process.env.BACKUP_CRON || '0 3 * * *',
    retention: Number(process.env.BACKUP_RETENTION) || 7,
    offsite: process.env.BACKUP_OFFSITE === 'true',
  }),
};

export const dataRetention: GroupDef = {
  key: 'data.retention',
  label: 'Data · Operational log retention',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: true },
    { key: 'cron', label: 'Cron expression', type: 'text', default: '15 4 * * *', placeholder: '15 4 * * *' },
    { key: 'webhookDeliveryDays', label: 'Webhook delivery retention (days)', type: 'number', default: 30 },
    { key: 'edgeFunctionLogDays', label: 'Edge function log retention (days)', type: 'number', default: 30 },
    { key: 'jobRunDays', label: 'Scheduler run history (days)', type: 'number', default: 30,
      help: 'Rows in platform.job_runs older than this are deleted. Every scheduled job writes one per run, so this is the fastest-growing operational table.' },
    { key: 'authAuditLogDays', label: 'Auth audit log retention (days)', type: 'number', default: 90,
      help: 'Rows in auth.audit_log_entries (Authentication → Audit Logs) older than this are deleted.' },
    { key: 'batchSize', label: 'Rows per batch', type: 'number', default: 500 },
    { key: 'maxBatchesPerRun', label: 'Maximum batches per run', type: 'number', default: 20 },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(true),
    cron: z.string().min(1, 'cron is required').default('15 4 * * *'),
    webhookDeliveryDays: z.coerce.number().int().min(1).max(3650).default(30),
    edgeFunctionLogDays: z.coerce.number().int().min(1).max(3650).default(30),
    jobRunDays: z.coerce.number().int().min(1).max(3650).default(30),
    authAuditLogDays: z.coerce.number().int().min(1).max(3650).default(90),
    batchSize: z.coerce.number().int().min(1).max(1000).default(500),
    maxBatchesPerRun: z.coerce.number().int().min(1).max(100).default(20),
  }),
  envFallback: () => ({
    enabled: process.env.DATA_RETENTION_ENABLED !== 'false',
    cron: process.env.DATA_RETENTION_CRON || '15 4 * * *',
    webhookDeliveryDays: Number(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS) || 30,
    edgeFunctionLogDays: Number(process.env.EDGE_FUNCTION_LOG_RETENTION_DAYS) || 30,
    jobRunDays: Number(process.env.JOB_RUN_RETENTION_DAYS) || 30,
    authAuditLogDays: Number(process.env.AUTH_AUDIT_LOG_RETENTION_DAYS) || 90,
    batchSize: Number(process.env.DATA_RETENTION_BATCH_SIZE) || 500,
    maxBatchesPerRun: Number(process.env.DATA_RETENTION_MAX_BATCHES) || 20,
  }),
};

// Durable log history. Without persistence the Logs screen can only ever show
// the in-memory ring buffer (CONSOLE_LOG_BUFFER_SIZE lines, lost on restart),
// which is why no range beyond the last few minutes of traffic was answerable.
// Written by LogPersistenceService, pruned by DataRetentionService.
export const logsRetention: GroupDef = {
  key: 'logs.retention',
  label: 'Logs · History and retention',
  description:
    'Keep log lines in the database so the Logs screen can look further back than the in-memory buffer and survive a restart. Retention is applied by the data-retention job.',
  fields: [
    { key: 'enabled', label: 'Store logs in the database', type: 'bool', default: true,
      help: 'Off keeps the in-memory buffer only: history is capped by CONSOLE_LOG_BUFFER_SIZE and lost on restart.' },
    { key: 'retentionDays', label: 'Keep logs for (days)', type: 'number', default: 7,
      help: 'Lines older than this are deleted on the next data-retention run.' },
    { key: 'maxRows', label: 'Maximum stored lines', type: 'number', default: 2_000_000,
      help: 'Hard ceiling regardless of age; the oldest lines above it are deleted. 0 disables the cap.' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(true),
    retentionDays: z.coerce.number().int().min(1).max(3650).default(7),
    maxRows: z.coerce.number().int().min(0).max(100_000_000).default(2_000_000),
  }),
  envFallback: () => ({
    enabled: process.env.LOG_PERSISTENCE_ENABLED !== 'false',
    retentionDays: Number(process.env.LOG_RETENTION_DAYS) || 7,
    maxRows: Number(process.env.LOG_MAX_ROWS) || 2_000_000,
  }),
};

// Prune processed realtime outbox rows (platform.realtime_outbox). Only terminal
// rows (completed / failed) are ever removed (pending/processing are untouched) 
// via the realtime_outbox_retention_idx. Consumed by DataRetentionService.runOnce.
export const realtimeRetention: GroupDef = {
  key: 'realtime.retention',
  label: 'Realtime · Retention',
  description: 'Prune processed realtime outbox rows. Only completed/failed (terminal) rows are removed; pending and processing rows are never touched.',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: true },
    { key: 'completedDays', label: 'Keep delivered events (days)', type: 'number', default: 7,
      help: 'Completed realtime events, and messages sent with realtime.send, older than this are purged.' },
    { key: 'failedDays', label: 'Keep failed events (days)', type: 'number', default: 30,
      help: 'Failed realtime events are kept longer for debugging.' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(true),
    completedDays: z.coerce.number().int().min(0).max(3650).default(7),
    failedDays: z.coerce.number().int().min(0).max(3650).default(30),
  }),
  envFallback: () => ({
    enabled: process.env.REALTIME_RETENTION_ENABLED !== 'false',
    completedDays: Number(process.env.REALTIME_OUTBOX_COMPLETED_DAYS) || 7,
    failedDays: Number(process.env.REALTIME_OUTBOX_FAILED_DAYS) || 30,
  }),
};

/**
 * A comma-separated list of Postgres function names.
 *
 * Deliberately NOT folded to lower case and not restricted to the unquoted
 * identifier shape: names are compared against `pg_proc.proname` verbatim, and
 * `CREATE FUNCTION "MyFn"` really is stored as `MyFn`. Normalising here would
 * make such a function impossible to allowlist.
 *
 * What is checked is only what could never be a function name: an entry longer
 * than Postgres' 63-byte identifier limit, or one carrying control characters.
 * A typo simply leaves the function blocked, which is the safe direction and
 * surfaces as an explicit 403 at call time.
 */
const functionNameList = z
  .string()
  .default('')
  .transform(raw => raw.split(',').map(name => name.trim()).filter(Boolean))
  .superRefine((names, ctx) => {
    for (const name of names) {
      if (Buffer.byteLength(name, 'utf8') > 63) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${name}" is longer than Postgres' 63-byte identifier limit.`,
        });
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1F\x7F]/.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${name}" contains a control character and cannot be a function name.`,
        });
      }
    }
  })
  .transform(names => [...new Set(names)].join(','));

// Limits for the auto-generated REST API. maxRows tightens the hard 1000-row
// ceiling the query parser already enforces; consumed live by RestApiService.
// Whether the data plane refuses callers that present no valid project API key.
// Its own group rather than a field on api.rest: the REST page renders api.rest
// and the API keys panel renders this one, so neither surface shows a form that
// also edits settings it does not talk about.
// Whether PostgreSQL policies decide storage access, instead of the built-in
// public-or-owner rule. Off by default: turning it on changes who can read every
// object in the project, which is not something an upgrade gets to do silently.
export const storagePolicies: GroupDef = {
  key: 'storage.policies',
  label: 'Storage · Policies',
  description: 'Authorize storage with PostgreSQL row level security instead of the built-in owner rule.',
  fields: [
    { key: 'enabled', label: 'Use RLS policies for storage', type: 'bool', default: false,
      help: 'When on, every read and write is decided by the policies on storage.files, the same way '
        + 'table access is. The migration installs policies reproducing the built-in behaviour, so '
        + 'turning this on changes nothing until you write your own. When off, the built-in rule '
        + 'applies: an object is readable if it is public or if you own it.' },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({ enabled: process.env.STORAGE_RLS_POLICIES === 'true' }),
};

export const apiKeys: GroupDef = {
  key: 'api.keys',
  label: 'API · Keys',
  description: 'Whether a project API key is required to reach the REST API.',
  fields: [
    { key: 'requireApiKey', label: 'Require a project API key', type: 'bool', default: false,
      help: 'When on, every REST request must carry a valid publishable or secret key in the '
        + 'apikey header. Off by default so an app running against an older version keeps '
        + 'working across an upgrade. Turn it on once your clients send the key: revoking a key '
        + 'then cuts that caller off without touching a single policy.' },
  ],
  schema: z.object({
    requireApiKey: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({ requireApiKey: process.env.REST_REQUIRE_API_KEY === 'true' }),
};

export const apiRest: GroupDef = {
  key: 'api.rest',
  label: 'API · REST',
  description: 'Limits for the auto-generated REST API. Changes apply on the next request.',
  fields: [
    { key: 'maxRows', label: 'Max rows per request', type: 'number', default: 1000,
      help: 'Upper bound on rows a single GET returns. The parser also enforces a hard ceiling of 1000.' },
    { key: 'rpcSecurityDefiner', label: 'Exposed SECURITY DEFINER functions', type: 'text', default: '',
      placeholder: 'rpc_all_widgets, rpc_search',
      help: 'Comma-separated function names reachable over /rest/v1/rpc/. A SECURITY DEFINER '
        + 'function runs as its owner and bypasses the caller\'s row-level security, so each one '
        + 'must be listed here explicitly. Empty means none are exposed.' },
  ],
  schema: z.object({
    maxRows: z.coerce.number().int().min(1).max(1000).default(1000),
    rpcSecurityDefiner: functionNameList,
  }),
  // Seeds from env only while no row exists, like every other group: once the
  // group is saved, the stored value wins and REST_RPC_SECURITY_DEFINER is no
  // longer read. That is what makes clearing the allowlist from Studio work.
  envFallback: () => ({
    maxRows: Number(process.env.REST_MAX_ROWS) || 1000,
    rpcSecurityDefiner: process.env.REST_RPC_SECURITY_DEFINER ?? '',
  }),
};

// Whether Studio's SQL editor may write. CONSOLE_SQL_ENABLED stays the operator's
// env switch for the editor as a whole; restricting it to reads is a project
// decision, made here, so it can be changed from the product rather than from an
// env file nobody edits.
// The AI assistant's run_select never reads this: /sql/readonly is read-only
// whatever is saved here.
export const databaseSqlEditor: GroupDef = {
  key: 'database.sqlEditor',
  label: 'Database · SQL editor',
  description: 'What the Studio SQL editor may run. Changes apply to the next query.',
  fields: [
    { key: 'allowWrites', label: 'Allow writes from the SQL editor', type: 'bool', default: true,
      help: 'On, the editor runs anything, as the database owner. Off, every statement runs in a Postgres '
        + 'READ ONLY transaction and INSERT, UPDATE, DELETE and DDL are refused.' },
  ],
  schema: z.object({ allowWrites: z.coerce.boolean().default(true) }),
  envFallback: () => ({ allowWrites: true }),
};

// Realtime delivery constraints, applied when a client subscribes to a topic.
// Read live (short-lived cache) by RealtimeTopicService.
export const realtimeLimits: GroupDef = {
  key: 'realtime.limits',
  label: 'Realtime · Limits',
  description: 'Constraints applied when a client subscribes to a realtime topic.',
  fields: [
    { key: 'enablePostgresChanges', label: 'Enable postgres_changes', type: 'bool', default: true,
      help: 'When off, database-change subscriptions are ignored. Broadcast and presence still work.' },
    { key: 'maxChannelsPerClient', label: 'Max channels per client', type: 'number', default: 100,
      help: 'Reject further channel subscriptions from a single connection past this count.' },
    { key: 'privateOnly', label: 'Private channels only', type: 'bool', default: false,
      help: 'Refuse public channels. Every channel must be joined with private: true and is authorized by the policies on realtime.messages.' },
  ],
  schema: z.object({
    enablePostgresChanges: z.coerce.boolean().default(true),
    maxChannelsPerClient: z.coerce.number().int().min(1).max(100_000).default(100),
    privateOnly: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({ enablePostgresChanges: true, maxChannelsPerClient: 100, privateOnly: false }),
};

// Bring-your-own-key AI assistant. The operator picks a provider and pastes
// their own API key; AiConfigService resolves this over the (not yet built)
// console-global default. See services/admin/ai-config.service.ts.
export const aiAssistant: GroupDef = {
  key: 'ai.assistant',
  label: 'AI assistant',
  description:
    'Bring your own model key. The assistant runs server side and can only do what your account can do.',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    {
      key: 'provider',
      label: 'Provider',
      type: 'select',
      options: PROVIDERS.map(p => ({ value: p.id, label: p.label })),
      default: 'anthropic',
    },
    {
      key: 'model',
      label: 'Model',
      type: 'text',
      placeholder: 'claude-opus-5',
      help: 'Any model id the provider accepts. Leave blank to use the provider default.',
    },
    { key: 'apiKey', label: 'API key', type: 'password', secret: true },
    {
      key: 'baseUrl',
      label: 'Base URL',
      type: 'text',
      placeholder: 'http://localhost:11434/v1',
      help: 'Leave blank to use the provider\'s own endpoint. Required for a custom OpenAI-compatible server (Ollama, vLLM, LiteLLM).',
    },
    {
      key: 'maxSteps',
      label: 'Maximum tool steps per message',
      type: 'number',
      default: 12,
    },
    {
      key: 'autoApproveWrites',
      label: 'Run write actions without confirmation',
      type: 'bool',
      default: false,
      help: 'Off by default. When off, the assistant proposes changes and you press Run.',
    },
  ],
  schema: z
    .object({
      enabled: z.coerce.boolean().default(false),
      provider: z.enum(PROVIDER_IDS).default('anthropic'),
      model: z.string().optional().default(''),
      apiKey: z.string().optional().default(''),
      baseUrl: z.string().url().optional().or(z.literal('')).default(''),
      maxSteps: z.coerce.number().int().min(1).max(50).default(12),
      autoApproveWrites: z.coerce.boolean().default(false),
    })
    .refine(v => !getProvider(v.provider).requiresBaseUrl || Boolean(v.baseUrl), {
      message: 'A base URL is required for OpenAI-compatible providers',
      path: ['baseUrl'],
    }),
  envFallback: () => ({}),
};


// Credentials for the GitHub OAuth App that lets an operator connect a
// repository to this project (see git-repo.service.ts).
//
// The callback URL is asked for rather than derived. Behind a proxy the server
// cannot see its own public origin, and a redirect_uri that does not match the
// one registered on the OAuth App is rejected by GitHub with an error that says
// nothing useful, so the operator states it once, and it is the same string
// they pasted into GitHub.
export const gitGithub: GroupDef = {
  key: 'git.github',
  label: 'Git · GitHub',
  description:
    'A GitHub OAuth App (Settings → Developer settings → OAuth Apps). Its Authorization callback URL must be exactly the callback URL below.',
  fields: [
    { key: 'clientId', label: 'Client ID', type: 'text', placeholder: 'Iv1.0123456789abcdef' },
    { key: 'clientSecret', label: 'Client secret', type: 'password', secret: true },
    {
      key: 'callbackUrl',
      label: 'Authorization callback URL',
      type: 'text',
      placeholder: 'https://your-domain.example/studio/git/callback',
      help: 'The Studio page GitHub returns the browser to. Its origin is also where the push webhook is delivered.',
    },
  ],
  schema: z.object({
    clientId: z.string().optional().default(''),
    clientSecret: z.string().optional().default(''),
    callbackUrl: z.string().url().optional().or(z.literal('')).default(''),
  }),
  envFallback: () => ({
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL || '',
  }),
};
