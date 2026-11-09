// Central, validated environment configuration.
// Importing this module validates process.env once and fails fast with a
// readable message when something required is missing or malformed.
import { config } from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { PROVIDER_IDS } from '@motherbase/ai';
import { parseTrustProxy } from '../lib/trust-proxy';
import { composeFileFor, domainSuffixFor, parseConsoleMode, schemeFor, DEV_PROJECTS_DIR, PROD_PROJECTS_DIR } from './mode-defaults';

config();

const numeric = (def?: number) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number({ error: 'must be a number' }));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),

  PORT: numeric(5001),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (generate with `openssl rand -hex 32`)'),
  // When set (Console/proxy mode), it must be strong. It is a bearer credential
  // granting synthetic ADMIN. Absent is allowed (single-instance mode).
  PLATFORM_SERVICE_TOKEN: z.string().min(32, 'PLATFORM_SERVICE_TOKEN must be at least 32 characters').optional(),

  // Root key (base64, 32 bytes) for encrypting Studio-managed secrets at rest.
  // Optional: when absent, non-secret settings still work; saving a secret is
  // rejected with a clear message rather than failing boot.
  CONFIG_ENCRYPTION_KEY: z.string().optional().default(''),
  // Short-lived access token lifetime (minutes) and refresh token lifetime (days).
  ACCESS_TOKEN_EXP_MIN: numeric(15),
  REFRESH_TOKEN_EXP_DAYS: numeric(30),

  STATIC_PATH: z.string().default('uploads'),
  USER_PATH: z.string().default('users'),

  EMAIL_SMTP_USERNAME: z.string().optional().default(''),
  EMAIL_SMTP_PASSWORD: z.string().optional().default(''),
  EMAIL_SMTP_HOST: z.string().optional().default(''),


  // Max upload size in MB (memory + disk multer limits). Kept low to limit the
  // memory-exhaustion DoS surface.
  MAX_UPLOAD_MB: numeric(25),

  // Separate ceiling for uploading a backup file back into BACKUP_DIR. It has
  // to be its own number: a database dump is routinely far larger than the
  // 25 MB tenant-upload limit, and raising that one to fit a backup would
  // widen the DoS surface on every public upload route to do it.
  MAX_BACKUP_UPLOAD_MB: numeric(2048),

  BASE_HOST: z.string().optional().default('localhost:5001'),

  // Interface to bind. Empty derives it from NODE_ENV: 0.0.0.0 in production
  // (containers must be reachable from outside), 127.0.0.1 otherwise.
  //
  // The default matters for more than tidiness: outside production, an
  // unrecognised error answers with its stack trace (see
  // middlewares/api-error.middleware.ts), which is deliberate and useful
  // locally and must not be reachable from a network. Binding to loopback
  // makes that structural instead of a warning nobody reads. Set this
  // explicitly to widen it: for a VM or a remote dev box.
  BIND_HOST: z.string().optional().default(''),

  // Studio SQL console. Off unless an operator opts in. Whether it may write is the project's
  // `database.sqlEditor` setting, editable in Studio: an env var here was pinned to read-only in every
  // Console-provisioned stack, with no way to change it from the product. SqlService.execute enforces
  // both, and the read-only path is a real Postgres READ ONLY transaction, not only the static check.
  CONSOLE_SQL_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform(v => v === 'true'),
  CONSOLE_LOG_BUFFER_SIZE: numeric(500),

  // Express `trust proxy` value. Rate limiting keys on req.ip, so this MUST be
  // set when a reverse proxy (Traefik, nginx, a cloud LB) terminates TLS.
  // Otherwise every client shares the proxy's IP and one caller can exhaust the
  // limit for everyone. Left unset it stays `false`, because trusting
  // X-Forwarded-For with no proxy in front lets any client forge its own IP.
  // Accepts a hop count ("1"), "loopback", or a comma-separated IP/CIDR list.
  TRUST_PROXY: z.string().optional().default(''),

  RATE_LIMIT_WINDOW_MIN: numeric(15),
  RATE_LIMIT_GLOBAL_MAX: numeric(1000),
  RATE_LIMIT_AUTH_MAX: numeric(20),
  RATE_LIMIT_REST_READ_MAX: numeric(300),
  RATE_LIMIT_REST_WRITE_MAX: numeric(120),
  RATE_LIMIT_EDGE_MAX: numeric(60),

  EDGE_PUBLIC_INVOKE_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform(v => v === 'true'),
  EDGE_INVOKE_TOKEN: z.string().optional().default(''),
  // The private Deno sidecar that runs edge functions (deploy/edge-runtime).
  // The token must match the one the edge-runtime service was started with.
  EDGE_RUNTIME_URL: z.string().url().optional().default('http://edge-runtime:9000'),
  EDGE_RUNTIME_TOKEN: z.string().optional().default(''),
  // This API as the sidecar reaches it, for the sendMail() callback.
  EDGE_RUNTIME_CALLBACK_URL: z.string().url().optional().default('http://api:5001'),
  // On by default: storing a secret has no other purpose than being readable
  // by a function, and off-by-default made every Console-installed integration
  // (Stripe, Resend, Twilio, see config/integrations-registry.ts) fail with
  // `env.X === undefined` and no error. Set to false to withhold secrets from
  // functions; Shield reports when it is on, and escalates to critical in
  // combination with EDGE_PUBLIC_INVOKE_ENABLED.
  EDGE_SECRETS_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform(v => v === 'true'),
  BACKUP_DIR: z.string().optional().default('backups'),
  // Directory for the assistant's own SQLite thread store (assistant.db),
  // separate from BACKUP_DIR so a backup restore never touches conversations.
  AI_DATA_DIR: z.string().optional().default('data'),
  // The organization-wide AI assistant credentials, written into this
  // project's .env.prod by the Console when an operator sets a key for the org
  // (see console/services/org-ai.service.ts). They are the DEFAULT: a project
  // that saves its own `ai.assistant` settings overrides them entirely.
  //
  // In a standalone deployment with no Console, these are simply the way an
  // operator configures the assistant from the environment.
  AI_ASSISTANT_ENABLED: z
    .string()
    .optional()
    .default('')
    .transform(v => v === 'true'),
  AI_PROVIDER: z.enum(PROVIDER_IDS).optional().or(z.literal('')).default(''),
  AI_MODEL: z.string().optional().default(''),
  AI_API_KEY: z.string().optional().default(''),
  AI_BASE_URL: z.string().optional().default(''),

  // Directory containing the Postgres client binaries (pg_dump / psql). Leave
  // empty to resolve them from PATH. Set this on hosts where the tools are
  // installed outside PATH (common on native Windows/macOS dev machines).
  PG_BIN_DIR: z.string().optional().default(''),

  // Scheduled automatic database backups. These are env-level seeds/defaults;
  // the effective values are runtime-editable via the `backup.schedule`
  // AppSetting group (AppSetting overrides env).
  BACKUP_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform(v => v === 'true'),
  BACKUP_CRON: z.string().optional().default('0 3 * * *'),
  BACKUP_RETENTION: numeric(7),
  BACKUP_OFFSITE: z
    .string()
    .optional()
    .default('false')
    .transform(v => v === 'true'),
  // Dedicated bucket for offsite backup uploads. NEVER the public bucket.
  BACKUP_BUCKET: z.string().optional().default('backups'),
  // Optional dedicated offsite S3 credentials. When empty, fall back to the
  // main S3_* values (same creds, dedicated bucket = the approved design).
  BACKUP_S3_ENDPOINT: z.string().optional().default(''),
  BACKUP_S3_REGION: z.string().optional().default(''),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional().default(''),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional().default(''),

  // Comma-separated list of allowed CORS origins. Empty = allow all (dev only).
  CORS_ORIGINS: z.string().optional().default(''),

  // Multi-project platform orchestration
  CONSOLE_MODE: z.enum(['dev', 'prod']).optional().default('prod'),
  PROJECTS_DIR: z.string().optional(),
  COMPOSE_FILE: z.string().optional(),
  TRAEFIK_NETWORK: z.string().optional().default('traefik_proxy'),

  // STORAGE_DRIVER selects where uploads go.
  STORAGE_DRIVER: z.enum(['local', 's3']).optional().default('local'),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_REGION: z.string().optional().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_BUCKET: z.string().optional().default('uploads'),
  // Bucket for public-visibility objects. Kept separate from the private bucket
  // so an anonymous-download policy can be scoped to public objects only.
  S3_PUBLIC_BUCKET: z.string().optional().default('public'),
  S3_PUBLIC_URL: z.string().optional().default(''),
  // The endpoint presigned URLs are signed for. A SigV4 signature covers the
  // host, so a URL signed against S3_ENDPOINT (MinIO's address on the stack's
  // private network) cannot be rewritten afterwards and fails in a browser.
  // Set it to the address clients reach the same S3 API at. Empty = S3_ENDPOINT.
  S3_PRESIGN_ENDPOINT: z.string().optional().default(''),

  // Push providers stay disabled until configured.
  FIREBASE_PROJECT_ID: z.string().optional().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().optional().default(''),
  FIREBASE_PRIVATE_KEY: z.string().optional().default(''),
  APNS_KEY: z.string().optional().default(''),
  APNS_KEY_ID: z.string().optional().default(''),
  APNS_TEAM_ID: z.string().optional().default(''),
  APNS_BUNDLE_ID: z.string().optional().default(''),
  APNS_PRODUCTION: z
    .string()
    .optional()
    .default('false')
    .transform(v => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`❌ Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;
// Mode-derived defaults live in ./mode-defaults so the Console cannot drift from
// them; it derives the same values without importing this module (which would
// exit on a missing DATABASE_URL it does not have).
const mode = parseConsoleMode(raw.CONSOLE_MODE);
const consoleDev = mode === 'dev';
const defaultComposeFile = composeFileFor(mode);

const isProduction = raw.NODE_ENV === 'production';

export const env = {
  ...raw,
  TRUST_PROXY: parseTrustProxy(raw.TRUST_PROXY),
  IS_PRODUCTION: isProduction,
  BIND_HOST: raw.BIND_HOST || (isProduction ? '0.0.0.0' : '127.0.0.1'),
  PROJECTS_DIR: raw.PROJECTS_DIR ?? (consoleDev ? path.resolve(process.cwd(), DEV_PROJECTS_DIR) : PROD_PROJECTS_DIR),
  COMPOSE_FILE: raw.COMPOSE_FILE ?? path.join(process.cwd(), 'deploy', defaultComposeFile),
  PLATFORM_SCHEME: schemeFor(mode),
  PLATFORM_DOMAIN_SUFFIX: domainSuffixFor(mode),
  /** Hard upload ceiling in bytes. Per-bucket limits are capped to this. */
  MAX_UPLOAD_BYTES: raw.MAX_UPLOAD_MB * 1024 * 1024,
  /** Ceiling for an admin uploading a backup file. See MAX_BACKUP_UPLOAD_MB. */
  MAX_BACKUP_UPLOAD_BYTES: raw.MAX_BACKUP_UPLOAD_MB * 1024 * 1024,
};
