export type MigrationStatus = 'pending' | 'applied' | 'rolledback';

/** Where the migration was authored: this page, the CLI (`db push`, `migration repair`) or a Git sync. */
export type MigrationOrigin = 'studio' | 'cli' | 'git';

export interface MigrationRow {
  id: string;
  /** The `<version>_<name>.sql` prefix: what `motherbase migration list` shows. */
  version: string;
  name: string;
  origin: MigrationOrigin;
  status: MigrationStatus;
  checksum: string;
  appliedAt: string | null;
  createdAt: string;
}

export interface MigrationDetail extends MigrationRow {
  upSql: string;
  downSql: string | null;
}

export interface DiffResult {
  diff: string;
  suggestedSql: string;
}

export type Draft = { name: string; upSql: string; downSql: string };

export const emptyDraft = (): Draft => ({ name: '', upSql: '', downSql: '' });

export interface PgCronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  database: string;
  username: string;
}

/**
 * Exactly what `GET /admin/cron/pg/jobs` caches, envelope included.
 *
 * The toggle's optimistic updater was typed as `PgCronJob[]` while the cache
 * held this object, so it called `.map` on it and threw `jobs.map is not a
 * function` inside `onMutate`, before the HTTP request was ever sent. One type
 * for the response, shared by the api module, the hook and the updater.
 */
export interface PgCronJobsResponse {
  jobs: PgCronJob[];
  extensionMissing: boolean;
}

/** @see JobState on the server. Explicit, so "unknown" never renders as "fine". */
export type AppJobState = 'disabled' | 'scheduled' | 'running' | 'ok' | 'failed' | 'unknown';

/** What a job is, as opposed to how it last went. Declared by its scheduler. */
export interface JobDefinition {
  /** What this job does when it fires, in one sentence. */
  does: string;
  /** The file (or edge function) that owns it. */
  source: string;
  /** Console route that owns its configuration, or null when it lives in code. */
  settingsHref: string | null;
}

export interface AppJob {
  /** Stable identity, and the ledger key. `edge:<functionId>` for scheduled functions. */
  id: string;
  name: string;
  kind: 'app' | 'edge' | 'platform';
  schedule: string | null;
  enabled: boolean;
  scheduled: boolean;
  running: boolean;
  state: AppJobState;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
  runs: number;
  /** False for a job seen only in the run ledger: no live scheduler claims it. */
  declared: boolean;
  medianIntervalMs: number | null;
  definition: JobDefinition;
  /** Whether the console can force a run. */
  runnable: boolean;
  /** Whether its cadence is data this console can write, rather than a constant. */
  configurable: boolean;
}

/** One recorded run of an app job, from the server's ledger. */
export interface AppJobRun {
  id: string;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  error: string | null;
  /** The run's own report of what it did. Null for runs recorded before this existed. */
  output: string | null;
  /** A run an operator forced must never read as proof the timer fired. */
  trigger: 'schedule' | 'manual';
}

export interface CronRun {
  runid: number;
  jobid: number;
  status: string;
  return_message: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface Hook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface Delivery {
  id: string;
  event: string;
  status: number;
  ok: boolean;
  durationMs: number;
  test: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export type RestoreTarget =
  | { kind: 'local'; name: string; file: string }
  | { kind: 'remote'; name: string; key: string };

export interface RealtimeConfig {
  models: string[];
  availableModels: Array<{ model: string; dbName: string; dynamic: boolean; riskLevel: 'public' | 'restricted' | 'private' | 'none'; respectRls: boolean }>;
  defaultEnabled: boolean;
  configured: boolean;
}

export interface ExtInfo {
  name: string;
  defaultVersion: string;
  installedVersion: string | null;
  installed: boolean;
  comment: string;
}

export interface FnInfo {
  name: string;
  /** Identity arguments, `''` for a no-argument function. */
  args: string;
  /** `schema.name(args)`: Postgres overloads share a name, so this is the id. */
  signature: string;
  returnType: string;
  language: string;
  definition: string;
}

export interface TriggerInfo {
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  orientation: 'ROW' | 'STATEMENT';
  function: string;
  enabled: boolean;
  definition: string;
}

export interface ChannelInfo {
  name: string;
  clientCount: number;
}

export interface RealtimeEvent {
  channel: string;
  event: string;
  payload: unknown;
  at: number;
}

/**
 * What a backup file is, and what can be done with it.
 *
 * Three different things land in the backup directory: a plain `.sql` dump, a
 * `.tar` bundling that dump with every storage object, and a `.json` schema
 * export. Restore shells out to `psql --file`, so it can only read the first.
 * The list used to be name/size/date only and the console drew the same Restore
 * button on every row.
 */
export type BackupKind = 'database' | 'full' | 'export' | 'unknown';

interface BackupContract {
  kind: BackupKind;
  /** True only when the database restore can actually read this file. */
  restorable: boolean;
  /** True when it must be unpacked before any part of it is restorable. */
  extractable: boolean;
}

interface LocalBackup extends BackupContract {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

interface RemoteBackup extends BackupContract {
  key: string;
  size: number;
  lastModified: string;
}

export interface BackupList {
  local: LocalBackup[];
  remote: RemoteBackup[];
}

export interface BackupConfig {
  enabled: boolean;
  cron: string;
  retention: number;
  offsite: boolean;
}
