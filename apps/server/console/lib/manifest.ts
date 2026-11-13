import { randomBytes } from 'crypto';
import { SLUG_RE } from '../../constants/regex.constants';
import { z } from 'zod';

// Per-project resource quotas. cpu/mem are enforced by docker compose
// `deploy.resources.limits` via the env vars emitted below; disk is enforced as a
// MinIO bucket quota by `minio-init` and metered against all the project's volumes.
// The same values are surfaced back to the console for usage-vs-quota metering.
// cpus are fractional cores, mem is in MiB, disk in GiB.
export interface ResourceLimits {
  apiCpus: number;
  apiMemMb: number;
  dbCpus: number;
  dbMemMb: number;
  minioCpus: number;
  minioMemMb: number;
  /** The edge-runtime sidecar: its own container, but part of the project's quota. */
  edgeCpus: number;
  edgeMemMb: number;
  diskGb: number;
}

// "Small" tier: the default every new project inherits unless the caller overrides.
export const DEFAULT_LIMITS: ResourceLimits = {
  apiCpus: 0.5,
  apiMemMb: 512,
  dbCpus: 0.5,
  dbMemMb: 512,
  minioCpus: 0.25,
  minioMemMb: 256,
  edgeCpus: 0.5,
  edgeMemMb: 768,
  diskGb: 10,
};

// Maps each limit field to its .env.prod var and whether it is a bare number or a
// memory (`<n>M`) value. Single source of truth for render + parse + rewrite.
const LIMIT_FIELDS: ReadonlyArray<readonly [keyof ResourceLimits, string, 'number' | 'mem']> = [
  ['apiCpus', 'API_CPUS', 'number'],
  ['apiMemMb', 'API_MEM', 'mem'],
  ['dbCpus', 'DB_CPUS', 'number'],
  ['dbMemMb', 'DB_MEM', 'mem'],
  ['minioCpus', 'MINIO_CPUS', 'number'],
  ['minioMemMb', 'MINIO_MEM', 'mem'],
  ['edgeCpus', 'EDGE_RUNTIME_CPUS', 'number'],
  ['edgeMemMb', 'EDGE_RUNTIME_MEM', 'mem'],
  ['diskGb', 'DISK_GB', 'number'],
];

/** Render a limits object into its `.env.prod` `KEY=value` pairs (mem as `<n>M`). */
export function limitsToEnv(l: ResourceLimits): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key, kind] of LIMIT_FIELDS) {
    out[key] = kind === 'mem' ? `${l[field]}M` : String(l[field]);
  }
  return out;
}

/** Parse the limit vars back out of a raw `.env.prod` string. Missing vars fall
 *  back to `base` (defaults), so old projects without the vars still read sensibly. */
export function parseLimits(env: string, base: ResourceLimits = DEFAULT_LIMITS): ResourceLimits {
  const out: ResourceLimits = { ...base };
  const lines = env.split('\n');
  for (const [field, key] of LIMIT_FIELDS) {
    const line = lines.find(l => l.startsWith(`${key}=`));
    if (!line) continue;
    const raw = line.slice(key.length + 1).trim();
    const num = parseFloat(raw.replace(/M$/i, ''));
    if (Number.isFinite(num)) out[field] = num;
  }
  return out;
}

/**
 * Per-project runtime switches. Both live in `.env.prod`: compose reads the
 * first, and keeping the second beside it leaves one file to back up.
 */
export interface RuntimeOptions {
  /** Whether the stack runs the edge-runtime container at all. */
  edgeRuntime: boolean;
  /** Stop the stack after this many minutes without a request. 0 = never. */
  autoPauseMinutes: number;
}

// Both defaults are "as before": a project that predates the switches, or one
// created without them, keeps its edge runtime and is never stopped for it.
export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = { edgeRuntime: true, autoPauseMinutes: 0 };

const EDGE_REPLICAS_ENV = 'EDGE_RUNTIME_REPLICAS';
const AUTO_PAUSE_ENV = 'AUTO_PAUSE_MINUTES';
// Shorter than this and a project is stopped between two page loads of the
// person using it; longer than 30 days is "never" with extra steps.
export const AUTO_PAUSE_MIN_MINUTES = 5;
export const AUTO_PAUSE_MAX_MINUTES = 30 * 24 * 60;

export const runtimeOptionsPatchSchema = z.object({
  edgeRuntime: z.boolean(),
  autoPauseMinutes: z.number().int().max(AUTO_PAUSE_MAX_MINUTES)
    .refine(n => n === 0 || n >= AUTO_PAUSE_MIN_MINUTES, `autoPauseMinutes must be 0 (never) or at least ${AUTO_PAUSE_MIN_MINUTES}`),
}).partial().strict().refine(
  value => Object.keys(value).length > 0,
  'no runtime option provided',
);

export function runtimeOptionsToEnv(o: RuntimeOptions): Record<string, string> {
  return { [EDGE_REPLICAS_ENV]: o.edgeRuntime ? '1' : '0', [AUTO_PAUSE_ENV]: String(o.autoPauseMinutes) };
}

/** Read the switches back out of a raw `.env.prod`. A missing or unreadable var is its default. */
export function parseRuntimeOptions(env: string): RuntimeOptions {
  const value = (key: string) => env.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim();
  const minutes = Number(value(AUTO_PAUSE_ENV));
  return {
    edgeRuntime: value(EDGE_REPLICAS_ENV) !== '0',
    autoPauseMinutes: Number.isInteger(minutes) && minutes >= AUTO_PAUSE_MIN_MINUTES ? minutes : 0,
  };
}

export interface CreateProjectInput {
  name: string;
  /** Leave the edge-runtime container out of the new stack. Defaults to running it. */
  edgeRuntime?: boolean;
  /** Host port for this project's PostgreSQL. Allocate with `allocateDbPort`. */
  dbPort?: number;
  domain?: string;
  storageDomain?: string;
  minioConsoleDomain?: string;
  corsOrigins?: string;
  apiImage?: string;
  certResolver?: string;
  limits?: Partial<ResourceLimits>;
  /** Set when the project is a preview branch of another (see services/branch.service.ts). */
  branch?: BranchInfo;
  /**
   * Reuse another stack's key instead of generating one. Only a branch that
   * copies its parent's data sets it: the copied rows are encrypted with the
   * parent's key and would be unreadable under a fresh one.
   */
  configEncryptionKey?: string;
}

export type BranchStatus = 'creating' | 'seeding' | 'active' | 'failed';

/** A preview branch's link to its parent, stored in the branch's manifest.json. */
export interface BranchInfo {
  parent: string;
  /** Display name, usually the git branch; the project slug is derived from it. */
  name: string;
  gitBranch?: string;
  withData: boolean;
  status: BranchStatus;
  error?: string;
  createdAt: string;
  mergedAt?: string;
}

export interface ProjectConfig {
  domain: string;
  storageDomain: string;
  minioConsoleDomain: string;
  corsOrigins: string;
  apiImage: string;
  certResolver: string;
}

export const PROJECT_CONFIG_ENV: Readonly<Record<keyof ProjectConfig, string>> = {
  domain: 'PROJECT_DOMAIN',
  storageDomain: 'STORAGE_DOMAIN',
  minioConsoleDomain: 'MINIO_CONSOLE_DOMAIN',
  corsOrigins: 'CORS_ORIGINS',
  apiImage: 'API_IMAGE',
  certResolver: 'CERT_RESOLVER',
};

const hostname = (label: string) => z.string().trim()
  .min(1, `${label} is required`)
  .max(253, `${label} is too long`)
  .refine(value => value.split('.').every(part => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(part)), `${label} must be a valid hostname`)
  .refine(value => !/[\r\n]/.test(value), `${label} must not contain line breaks`)
  .transform(value => value.toLowerCase());

const corsOrigins = z.string().trim()
  .refine(value => !/[\r\n]/.test(value), 'corsOrigins must not contain line breaks')
  .refine(value => {
  if (!value) return true;
  return value.split(',').every(raw => {
    const origin = raw.trim();
    if (!origin) return false;
    try {
      const url = new URL(origin);
      return (url.protocol === 'http:' || url.protocol === 'https:')
        && url.origin === origin.replace(/\/$/, '')
        && (url.pathname === '/' || url.pathname === '')
        && !url.search
        && !url.hash;
    } catch {
      return false;
    }
  });
  }, 'corsOrigins must be a comma-separated list of HTTP(S) origins');

const dockerImage = z.string().trim()
  .min(1, 'apiImage is required')
  .max(255, 'apiImage is too long')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/, 'apiImage must be a valid container image reference')
  .refine(value => !/[\r\n]/.test(value), 'apiImage must not contain line breaks');

const resolver = z.string().trim()
  .min(1, 'certResolver is required')
  .max(64, 'certResolver is too long')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'certResolver contains invalid characters')
  .refine(value => !/[\r\n]/.test(value), 'certResolver must not contain line breaks');

export const projectConfigSchema = z.object({
  domain: hostname('domain'),
  storageDomain: hostname('storageDomain'),
  minioConsoleDomain: hostname('minioConsoleDomain'),
  corsOrigins,
  apiImage: dockerImage,
  certResolver: resolver,
}).strict();

export const projectConfigPatchSchema = projectConfigSchema.partial().refine(
  value => Object.keys(value).length > 0,
  'no editable project settings provided',
);

export function projectConfigError(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}

export interface ProjectManifest {
  name: string;
  domain: string;
  storageDomain: string;
  minioConsoleDomain: string;
  corsOrigins: string;
  apiImage: string;
  certResolver: string;
  jwtSecret: string;
  postgresPassword: string;
  configEncryptionKey: string;
  platformServiceToken: string;
  /** Shared by the API and its edge-runtime sidecar. */
  edgeRuntimeToken: string;
  minioRootUser: string;
  minioRootPassword: string;
  limits: ResourceLimits;
  runtime: RuntimeOptions;
  /**
   * Host port the project's PostgreSQL is published on, so external tools (an
   * ORM, psql, a BI client) can reach it. Bound to 127.0.0.1 by default: see
   * deploy/docker-compose.db-port.yml. Absent on projects created before this
   * existed, which keeps working: they get a random loopback port instead.
   */
  dbPort?: number;
  branch?: BranchInfo;
  createdAt: string;
}

// Range the Console allocates project database ports from. Deliberately high and
// contiguous so an operator can allowlist or firewall the whole block in one rule.
export const DB_PORT_RANGE = { first: 54320, last: 54419 } as const;

/**
 * Lowest free port in the range, given the ports already taken by other
 * projects. Throws rather than wrapping or reusing: two projects sharing a host
 * port means the second stack silently fails to bind, and a clear error at
 * creation is much cheaper to diagnose than that.
 */
export function allocateDbPort(taken: Iterable<number>): number {
  const used = new Set(taken);
  for (let port = DB_PORT_RANGE.first; port <= DB_PORT_RANGE.last; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(
    `no free database port left in ${DB_PORT_RANGE.first}-${DB_PORT_RANGE.last}. `
      + 'Free one by deleting an unused project, or widen the range.',
  );
}

/** Read `DB_PORT` back out of a raw `.env.prod`. Undefined when absent or unparseable. */
export function parseDbPort(env: string): number | undefined {
  const line = env.split('\n').find(l => l.startsWith('DB_PORT='));
  if (!line) return undefined;
  const port = Number(line.slice('DB_PORT='.length).trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export type SecretGen = (bytes: number) => string;
export const generateSecret: SecretGen = n => randomBytes(n).toString('hex');

export interface BuildOptions {
  scheme?: 'http' | 'https';
  domainSuffix?: string;
  certResolver?: string;
  apiImage?: string;
}

export function resolveProjectConfig(input: CreateProjectInput, opts: BuildOptions = {}): ProjectConfig {
  const scheme = opts.scheme ?? 'https';
  const explicitDomain = input.domain === undefined ? undefined : hostname('domain').parse(input.domain);
  const domain = explicitDomain || (opts.domainSuffix ? `${input.name}.${opts.domainSuffix}` : '');
  if (!domain) throw new Error('domain is required');
  const baseSuffix = domain.slice(domain.indexOf('.') + 1);
  return projectConfigSchema.parse({
    domain,
    storageDomain: input.storageDomain || `${input.name}-storage.${baseSuffix}`,
    minioConsoleDomain: input.minioConsoleDomain ?? `${input.name}-minio.${baseSuffix}`,
    corsOrigins: input.corsOrigins ? `${scheme}://${domain},${input.corsOrigins}` : `${scheme}://${domain}`,
    apiImage: input.apiImage ?? opts.apiImage ?? 'motherbase-api:1.0.0',
    certResolver: input.certResolver ?? opts.certResolver ?? 'letsencrypt',
  });
}

export function buildManifest(
  input: CreateProjectInput,
  gen: SecretGen = generateSecret,
  opts: BuildOptions = {},
): ProjectManifest {
  if (!SLUG_RE.test(input.name)) throw new Error(`invalid project name: ${input.name}`);
  const config = resolveProjectConfig(input, opts);
  return {
    name: input.name,
    ...config,
    jwtSecret: gen(32),
    postgresPassword: gen(24),
    configEncryptionKey: input.configEncryptionKey ?? Buffer.from(gen(32), 'hex').toString('base64'),
    platformServiceToken: gen(32),
    edgeRuntimeToken: gen(32),
    minioRootUser: 'admin',
    minioRootPassword: gen(24),
    limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) },
    runtime: { ...DEFAULT_RUNTIME_OPTIONS, edgeRuntime: input.edgeRuntime !== false },
    ...(input.dbPort === undefined ? {} : { dbPort: input.dbPort }),
    ...(input.branch ? { branch: input.branch } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function renderEnvProd(m: ProjectManifest): string {
  return [
    `# Generated by the Console on ${m.createdAt}`,
    `COMPOSE_PROJECT_NAME=${m.name}`,
    `PROJECT_DOMAIN=${m.domain}`,
    `STORAGE_DOMAIN=${m.storageDomain}`,
    `MINIO_CONSOLE_DOMAIN=${m.minioConsoleDomain}`,
    `CORS_ORIGINS=${m.corsOrigins}`,
    `API_IMAGE=${m.apiImage}`,
    `POSTGRES_PASSWORD=${m.postgresPassword}`,
    `JWT_SECRET=${m.jwtSecret}`,
    `CONFIG_ENCRYPTION_KEY=${m.configEncryptionKey}`,
    `PLATFORM_SERVICE_TOKEN=${m.platformServiceToken}`,
    `EDGE_RUNTIME_TOKEN=${m.edgeRuntimeToken}`,
    `MINIO_ROOT_USER=${m.minioRootUser}`,
    `MINIO_ROOT_PASSWORD=${m.minioRootPassword}`,
    `S3_BUCKET=uploads`,
    `S3_REGION=us-east-1`,
    `CERT_RESOLVER=${m.certResolver}`,
    `CONSOLE_SQL_ENABLED=true`,
    // Only emitted when allocated. An absent DB_PORT is a valid state the
    // compose overlay handles; writing an empty one would look like a bug.
    ...(m.dbPort === undefined ? [] : [`DB_PORT=${m.dbPort}`, 'DB_BIND=127.0.0.1']),
    ...Object.entries(limitsToEnv(m.limits)).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(runtimeOptionsToEnv(m.runtime)).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
}
