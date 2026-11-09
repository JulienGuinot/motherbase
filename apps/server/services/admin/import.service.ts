import fs from 'fs/promises';
import { absorbConnectionErrors, errorCode, errorMessage } from '../../lib/errors';
import path from 'path';
import { Client } from 'pg';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import { runCommand, toLibpqUrl, type CommandResult } from './pg-command';
import { setCredentialHash } from '../../auth/credentials';
import { invalidateCatalog } from '../rest-api/catalog';
import { quoteIdentCatalog } from '../../lib/sql-identifier';
import {
  neutralizeUnsupportedSettings,
  relaxSchemaCreation,
  castAuthUidToUuid,
  PORTABLE_DUMP_SETTINGS,
} from './dump-compat';
import {
  captureImportManifest,
  verifyImportManifest,
  type ImportVerificationResult,
} from './import-verification';
import { Readable } from 'stream';
import { FileVisibility } from '@prisma/client';
import { bundleImportedGraph } from './edge-bundler';
import {
  SupabaseCloudClient,
  parseSupabaseProjectRef,
  looksLikeSecretDigest,
  storageUrlRewriteSql,
  supabaseStorageUrlRewrites,
  toBucketSlug,
} from './supabase-platform';

// Supabase-managed schemas that must NEVER be imported into a Motherbase
// project: this platform provides its own auth/storage/realtime, and the rest
// belong to extensions the target does not run.
const EXCLUDED_SCHEMAS = [
  'auth',
  'storage',
  'graphql',
  'graphql_public',
  'realtime',
  '_realtime',
  'extensions',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'supabase_functions',
  'supabase_migrations',
  'net',
  'cron',
  'pgbouncer',
  'pgmq',
  'pgtle',
  'tiger',
  'tiger_data',
  'topology',
] as const;

// Everything else the source defines is the user's own. A Supabase project
// routinely keeps SECURITY DEFINER helpers in a second schema (`private` is the
// name Supabase's own RLS guide uses) and calls them from public policies and
// triggers. Dumping `public` alone produces a dump that cannot load:
//
//   ERROR: schema "private" does not exist
//
// which, under --single-transaction, rolls the whole import back.
const SYSTEM_SCHEMA_PATTERN = /^(pg_|information_schema$)/i;

// pg_dump treats --schema as a psql-style pattern, so a name carrying pattern
// metacharacters would select the wrong set. Plain identifiers only; anything
// else is reported rather than dumped.
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

// Roles a Supabase `public` dump references in its GRANT and CREATE POLICY
// statements. The project DB only ships `anon` and `authenticated` (see the
// rls_foundation migration), so a dump that mentions any of the others aborts
// psql with `role "service_role" does not exist`, and because the load runs
// with --single-transaction + ON_ERROR_STOP, the ENTIRE schema and data import
// rolls back while the (independent) auth-user step still succeeds. That is the
// "only my users got imported" failure. Pre-creating them as NOLOGIN roles keeps
// the dump applicable; they hold no privileges beyond what the dump grants.
const SUPABASE_COMPAT_ROLES = [
  'anon',
  'authenticated',
  'service_role',
  'authenticator',
  'dashboard_user',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_read_only_user',
] as const;

// Cap remote read queries so a hostile/huge source DB can't hang the importer.
const STATEMENT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

// The object catalog is read into memory in one query, so it needs a ceiling.
// A source with more objects than this imports the first page and says so,
// which is better than an OOM half way through a migration.
const MAX_IMPORT_OBJECTS = 50_000;

// Supabase's own bookkeeping row for an "empty folder". It is not a file and
// has no bytes behind it; copying it would create a 0-byte object per folder.
const SUPABASE_FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder';

// Secrets Supabase injects into every function. They name the SOURCE project,
// so carrying them over would point imported functions back at Supabase.
const SUPABASE_MANAGED_SECRET = /^SUPABASE_/i;

/**
 * Belt and braces. Nothing below is supposed to receive a connection URL, but
 * driver errors are assembled by libraries we do not control, so scrub before
 * anything reaches a summary, a log line or an HTTP body.
 */
export function redactConnectionSecrets(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/[^\s:@/]+):[^\s@]*@/gi, '$1:***@')
    .replace(/\bpassword\s*=\s*[^\s&'";]+/gi, 'password=***');
}

function errorHostname(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const host = (error as { hostname?: unknown; host?: unknown }).hostname ?? (error as { host?: unknown }).host;
  return typeof host === 'string' && host ? host : undefined;
}

export interface ImportFailureDiagnosis {
  /** HTTP status the operator should see. Never 500 for a cause we recognise. */
  status: number;
  message: string;
}

/**
 * Turn a raw pg driver / libpq failure into something an operator can act on.
 *
 * Without this, a Supabase host that does not resolve reaches the Studio as a
 * bare 500 `getaddrinfo ENOTFOUND db.xxx.supabase.co`, which reads as "the
 * importer is broken" rather than "that hostname is wrong". The three classes
 * that matter are unreachable host, rejected credentials, and a source whose
 * schema we cannot read; everything else falls through to a scrubbed message.
 *
 * SECURITY: the returned message never contains the connection string. The
 * hostname alone is echoed back (it is what the operator typed and needs to
 * check); the password is not part of it and is scrubbed regardless.
 */
export function describeImportFailure(error: unknown): ImportFailureDiagnosis {
  const code = errorCode(error);
  const raw = errorMessage(error);
  const text = raw.toLowerCase();
  const host = errorHostname(error);
  const at = host ? ` "${host}"` : '';
  const supabaseDirect = /^db\..+\.supabase\.co$/i.test(host ?? '');
  const poolerHint =
    ' Supabase direct connections (db.<ref>.supabase.co) are IPv6-only, so pick the Session pooler URI on port 5432 from Supabase → Connect instead.';

  // ── Unreachable host ──
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || text.includes('could not translate host name')) {
    return {
      status: 502,
      message:
        `The database host${at} could not be resolved. Check the hostname in the connection URI.` +
        (supabaseDirect || !host ? poolerHint : ''),
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      status: 502,
      message: `The host${at} resolved but refused the connection. Check the port, and that the database accepts connections from this network.`,
    };
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return {
      status: 502,
      message:
        `The host${at} is not reachable from this server. Usually an IPv6-only address on an IPv4-only network.` +
        poolerHint,
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || text.includes('timeout expired') || text.includes('connection terminated')) {
    return {
      status: 504,
      message: `The connection to${at || ' the database'} timed out. Check that the host is reachable and that its firewall or IP allowlist permits this server.`,
    };
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return {
      status: 502,
      message: `The TLS certificate presented by${at || ' the database'} was rejected. Append ?sslmode=require to the URI, or use a URI whose certificate matches the host.`,
    };
  }

  // ── Rejected credentials ──
  if (code === '28P01' || text.includes('password authentication failed')) {
    return {
      status: 400,
      message: 'The database password was rejected. Copy a fresh URI from Supabase → Connect. The password is the database password, not your Supabase account password.',
    };
  }
  if (code === '28000' || text.includes('no pg_hba.conf entry')) {
    return {
      status: 400,
      message: 'The database refused this user or this client address. Check the username in the URI and the source database\'s IP allowlist.',
    };
  }
  if (code === '3D000') {
    return {
      status: 400,
      message: 'That database name does not exist on the source server. For Supabase the database is normally "postgres".',
    };
  }
  if (code === '53300') {
    return {
      status: 503,
      message: 'The source database has no connection slots left. Wait for its current connections to drain, or use the Session pooler URI, then retry.',
    };
  }

  // ── Source we cannot read ──
  if (code === '42501' || text.includes('permission denied')) {
    return {
      status: 403,
      message: 'This user may connect but not read the source objects. Use the postgres (owner) role from Supabase → Connect.',
    };
  }
  if (code === '3F000' || code === '42P01') {
    return {
      status: 400,
      message: `The source is missing an object the importer needs (${redactConnectionSecrets(raw)}). Check that this URI points at the Supabase project database and not at a different server.`,
    };
  }
  if (text.includes('prepared statement') || text.includes('unnamed prepared statement does not exist')) {
    return {
      status: 400,
      message: 'This looks like the Supabase transaction pooler (port 6543), which the importer cannot use. Switch to the Session pooler URI on port 5432.',
    };
  }

  return { status: 502, message: `Could not read the source database: ${redactConnectionSecrets(raw)}` };
}

export interface ImportInclude {
  schema?: boolean;
  data?: boolean;
  auth?: boolean;
  /** Buckets (from the source catalog) + their objects (needs a service_role key). */
  storage?: boolean;
  /** Edge functions, ported from Deno. Needs a Management API token. */
  edgeFunctions?: boolean;
  /** Project secrets, into this project's edge-function secret store. Needs a token. */
  secrets?: boolean;
}

/**
 * Everything the importer may be given. Only `connectionString` is required;
 * each optional credential unlocks one more section, and its absence downgrades
 * that section to a note rather than failing the import.
 *
 * SECURITY: all three credentials are secrets. None is logged, written to disk,
 * or echoed back in a summary, a note or an error.
 */
export interface ImportRequest {
  connectionString: string;
  include?: ImportInclude;
  /** service_role key. Without it, buckets are created but no object bytes move. */
  serviceRoleKey?: string;
  /** Supabase personal access token (sbp_…): edge functions and secrets. */
  managementToken?: string;
  /** Overrides the project ref derived from the connection string. */
  projectRef?: string;
  /** Overrides `https://<ref>.supabase.co` (self-hosted Supabase). */
  projectUrl?: string;
}

export interface ImportPreview {
  tables: { name: string; rows: number }[];
  policies: number;
  authUsers: number;
  buckets: { name: string; objects: number; bytes: number }[];
  edgeFunctions: string[];
  secrets: number;
  notes: string[];
}

export interface ImportSummary {
  status: 'success' | 'partial' | 'failed';
  schema: { applied: boolean; error?: string; warnings?: string };
  data: { applied: boolean; includedInDump: boolean; error?: string };
  auth: { imported: number; skipped: number; errors: string[] };
  storage: { buckets: number; objects: number; skipped: number; errors: string[] };
  edgeFunctions: {
    imported: number;
    enabled: number;
    needsPorting: number;
    errors: string[];
    /** Imported but left disabled, by name: each needs a look before enabling. */
    disabled: string[];
  };
  secrets: {
    imported: number;
    skipped: number;
    errors: string[];
    /**
     * Names Supabase would not disclose the value of. The operator has to set
     * each one here by hand, so the studio needs them as a list, not a
     * sentence.
     */
    undisclosed: string[];
  };
  verification?: ImportVerificationResult;
  notes: string[];
}

/** One row of the source's `storage.objects`, joined to its bucket. */
interface RawSupabaseObject {
  bucket: string;
  name: string;
  mime: string | null;
  size: string | number | null;
}

interface RawSupabaseUser {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | string | null;
  raw_user_meta_data: any;
  created_at: Date | string | null;
}

/**
 * Import an existing Supabase project into this Motherbase project.
 *
 * Six sections, three credentials. The connection string alone carries schema,
 * data, RLS policies, auth users and the bucket catalog; a service_role key adds
 * the storage objects' bytes; a Management API token adds edge functions and
 * project secrets. Each section is independent: a missing credential downgrades
 * its section to a note, and a section that fails never takes another down.
 *
 * SECURITY: all three credentials are secrets. None is logged, written to disk,
 * or included in a thrown error, a note, or the summary (pg CLI errors surface
 * only the command name + stderr, see pg-command.ts).
 */
export class ImportService extends BaseContext {
  private root(): string {
    return path.resolve(process.cwd(), env.BACKUP_DIR);
  }

  /** Spawn wrapper (indirection so tests can stub pg_dump / psql). */
  protected run(command: string, args: string[]): Promise<CommandResult> {
    return runCommand(command, args);
  }

  /** Short-lived read client factory (indirection so tests can inject a fake). */
  protected createClient(connectionString: string): Client {
    return absorbConnectionErrors(
      new Client({
        connectionString,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        query_timeout: STATEMENT_TIMEOUT_MS,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      })
    );
  }

  /**
   * The single place a source connection is opened. Every caller routes through
   * here, so the driver's raw `getaddrinfo ENOTFOUND …` can never reach the
   * Studio from any of them (AGENTS §5: one guard, not one per caller).
   */
  private async openClient(connectionString: string): Promise<Client> {
    const client = this.createClient(connectionString);
    try {
      await client.connect();
      return client;
    } catch (error: unknown) {
      await client.end().catch(() => {});
      throw this.asImportFailure(error);
    }
  }

  private asImportFailure(error: unknown): HttpException {
    if (error instanceof HttpException) return error;
    const { status, message } = describeImportFailure(error);
    // expose: true: the message is written here and argument-free, so it must
    // survive the production 500 mask; that mask is what made this screen mute.
    return new HttpException(message, status, 'IMPORT_SOURCE_UNAVAILABLE', { expose: true });
  }

  private assertConnectionString(connectionString: unknown): asserts connectionString is string {
    if (typeof connectionString !== 'string' || !connectionString.trim()) {
      throw new HttpException('connectionString is required', 400);
    }
    if (!/^postgres(ql)?:\/\//i.test(connectionString.trim())) {
      throw new HttpException('connectionString must be a postgres:// or postgresql:// URL', 400);
    }
  }

  /** Safely double-quote a Postgres identifier read back from the catalog. */
  private quoteIdent(name: string): string {
    return quoteIdentCatalog(name);
  }

  // ── Preview (dry-run, writes nothing) ──────────────────────────────────────

  async preview(request: ImportRequest): Promise<ImportPreview> {
    const { connectionString, include } = request;
    this.assertConnectionString(connectionString);
    const flags = this.resolveInclude(include);
    const notes: string[] = [];
    const buckets: ImportPreview['buckets'] = [];
    let edgeFunctions: string[] = [];
    let secrets = 0;
    const client = await this.openClient(connectionString);
    try {
      const tables: { name: string; rows: number }[] = [];
      if (flags.schema || flags.data) {
        const { rows: tableRows } = await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
        );
        for (const t of tableRows as { tablename: string }[]) {
          const countSql = `SELECT count(*)::int AS count FROM public.${this.quoteIdent(t.tablename)}`;
          const { rows: countRows } = await client.query(countSql);
          tables.push({ name: t.tablename, rows: Number(countRows[0]?.count ?? 0) });
        }
      }

      let policies = 0;
      if (flags.schema) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`
        );
        policies = Number(rows[0]?.count ?? 0);

        // Helper schemas ride along with public; say so before anything is written.
        const { extra } = await this.readUserSchemas(client).catch(() => ({ extra: [] as string[] }));
        if (extra.length > 0) {
          notes.push(`Schemas other than public will be imported as well: ${extra.join(', ')}.`);
        }
      }

      let authUsers = 0;
      if (flags.auth) {
        try {
          const { rows } = await client.query(
            `SELECT count(*)::int AS count FROM auth.users WHERE email IS NOT NULL AND email <> ''`
          );
          authUsers = Number(rows[0]?.count ?? 0);
        } catch {
          notes.push('auth.users could not be read (schema missing or insufficient privileges). Auth import will be skipped.');
        }
      }

      if (flags.storage) {
        try {
          for (const row of await this.readSourceBuckets(client)) {
            buckets.push({ name: row.bucket, objects: row.objects, bytes: row.bytes });
          }
          if (buckets.length > 0 && !request.serviceRoleKey) {
            notes.push(
              'No service_role key given: the buckets will be created but their objects will not be copied. Add the key from Supabase → Project Settings → API to move the files too.'
            );
          }
        } catch {
          notes.push('storage.buckets could not be read (schema missing or insufficient privileges). Storage import will be skipped.');
        }
      }

      if (flags.edgeFunctions || flags.secrets) {
        const cloud = this.resolveCloudClient(request, notes);
        if (cloud?.hasManagementToken) {
          if (flags.edgeFunctions) {
            try {
              edgeFunctions = (await cloud.listFunctions()).map(fn => fn.slug);
            } catch (error: unknown) {
              notes.push(`Edge functions could not be listed: ${redactConnectionSecrets(errorMessage(error))}`);
            }
          }
          if (flags.secrets) {
            try {
              secrets = (await cloud.listSecrets()).filter(s => !SUPABASE_MANAGED_SECRET.test(s.name)).length;
            } catch (error: unknown) {
              notes.push(`Project secrets could not be listed: ${redactConnectionSecrets(errorMessage(error))}`);
            }
          }
        } else if (cloud) {
          notes.push(
            'No Supabase personal access token given: edge functions and project secrets live outside the database and cannot be read without one. Create a token at supabase.com/dashboard/account/tokens.'
          );
        }
      }

      return { tables, policies, authUsers, buckets, edgeFunctions, secrets, notes };
    } catch (error: unknown) {
      // A preview that cannot read the source must say which of "wrong host",
      // "wrong password" and "cannot read this schema" it hit.
      throw this.asImportFailure(error);
    } finally {
      await client.end().catch(() => {});
    }
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  async importAll(request: ImportRequest & { confirm?: string }): Promise<ImportSummary> {
    const { connectionString, include, confirm } = request;
    if (confirm !== 'IMPORT') throw new HttpException('Import requires confirm=IMPORT', 400);
    this.assertConnectionString(connectionString);
    const flags = this.resolveInclude(include);

    const summary: ImportSummary = {
      status: 'success',
      schema: { applied: false },
      data: { applied: false, includedInDump: flags.data },
      auth: { imported: 0, skipped: 0, errors: [] },
      storage: { buckets: 0, objects: 0, skipped: 0, errors: [] },
      edgeFunctions: { imported: 0, enabled: 0, needsPorting: 0, errors: [], disabled: [] },
      secrets: { imported: 0, skipped: 0, errors: [], undisclosed: [] },
      notes: [],
    };

    // Every section is isolated: one failing still reports the others' outcome,
    // and an expired Supabase token must not cost the operator the schema
    // import they just paid for.
    if (flags.schema || flags.data) {
      await this.importSchemaAndData(connectionString, flags, summary);
    }

    const authReadSucceeded = flags.auth
      ? await this.importAuthUsers(connectionString, summary)
      : true;

    const cloud =
      flags.storage || flags.edgeFunctions || flags.secrets
        ? this.resolveCloudClient(request, summary.notes)
        : null;

    if (flags.storage) await this.importStorage(connectionString, cloud, summary);
    if (flags.edgeFunctions) await this.importEdgeFunctions(cloud, summary);
    if (flags.secrets) await this.importSecrets(cloud, summary);

    summary.status = this.resolveStatus(flags, summary, authReadSucceeded);
    return summary;
  }

  /**
   * The client for the two Supabase-hosted APIs, or null when the source is not
   * a Supabase Cloud project (self-hosted, or a plain Postgres). Never throws:
   * a missing ref is a note, because the database half of the import is already
   * done by the time this runs and must not be undone by it.
   */
  private resolveCloudClient(request: ImportRequest, notes: string[]): SupabaseCloudClient | null {
    const ref = (request.projectRef || '').trim() || parseSupabaseProjectRef(request.connectionString);
    if (!ref) {
      notes.push(
        'Could not work out the Supabase project ref from the connection URI, so storage objects, edge functions and secrets were skipped. Pass projectRef explicitly if this is a Supabase project.'
      );
      return null;
    }
    return new SupabaseCloudClient(this.di.OutboundHttpClient, {
      ref,
      projectUrl: (request.projectUrl || '').trim() || undefined,
      managementToken: request.managementToken,
      serviceRoleKey: request.serviceRoleKey,
    });
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  /**
   * Buckets come from the source's own `storage.buckets` catalog over the same
   * connection the dump used; object BYTES come from the Storage API, which is
   * the only place they exist.
   *
   * Buckets are created even without a service_role key: a project whose
   * buckets exist with the right names and visibility is a materially better
   * starting point than one where the operator recreates them by hand, and the
   * objects can be copied by re-running the import with the key.
   */
  private async importStorage(
    connectionString: string,
    cloud: SupabaseCloudClient | null,
    summary: ImportSummary
  ): Promise<void> {
    let client: Client | null = null;
    try {
      client = await this.openClient(connectionString);
      const sourceBuckets = await this.readSourceBuckets(client);
      if (sourceBuckets.length === 0) {
        await client.end().catch(() => {});
        client = null;
        return;
      }

      // slug: the target's rule is narrower than Supabase's, so the name can
      // change. Everything downstream addresses buckets by the mapped slug.
      const slugFor = new Map<string, string>();
      const claimed = new Set<string>();
      const renamed: string[] = [];
      for (const bucket of sourceBuckets) {
        const slug = this.claimBucketSlug(bucket.bucket, claimed);
        slugFor.set(bucket.bucket, slug);
        if (slug !== bucket.bucket) renamed.push(`${bucket.bucket} → ${slug}`);
        try {
          const existing = await this.di.prisma.bucket.findUnique({ where: { slug } });
          if (existing) {
            summary.storage.buckets++;
            continue;
          }
          await this.di.BucketService.create({
            slug,
            name: bucket.bucket,
            visibility: bucket.isPublic ? FileVisibility.public : FileVisibility.private,
            quotaBytes: bucket.fileSizeLimit ? BigInt(bucket.fileSizeLimit) : undefined,
          });
          summary.storage.buckets++;
        } catch (error: unknown) {
          summary.storage.errors.push(`bucket ${bucket.bucket}: ${errorMessage(error)}`);
        }
      }
      if (renamed.length > 0) {
        summary.notes.push(
          `Bucket names that do not fit this project's slug rule were mapped: ${renamed.join(', ')}. Object keys are unchanged; client code addressing the bucket by name has to follow.`
        );
      }

      if (!cloud?.hasServiceRoleKey) {
        const objects = sourceBuckets.reduce((total, bucket) => total + bucket.objects, 0);
        if (objects > 0) {
          summary.storage.skipped += objects;
          summary.notes.push(
            `${summary.storage.buckets} bucket(s) were created but their ${objects} object(s) were not copied: object bytes live behind the Storage API, which needs the project's service_role key. Re-run the import with the key to move them.`
          );
        }
        return;
      }

      const objects = await this.readSourceObjects(client, summary);
      await client.end().catch(() => {});
      client = null;
      await this.copyStorageObjects(objects, slugFor, sourceBuckets, cloud, summary);
      await this.rewriteStorageUrls(cloud.projectUrl, slugFor, summary);
    } catch (error: unknown) {
      summary.storage.errors.push(redactConnectionSecrets(errorMessage(error) || 'storage import failed'));
    } finally {
      await client?.end().catch(() => {});
    }
  }

  /**
   * A target slug for one source bucket, unique within this import.
   *
   * `toBucketSlug` is lossy: `my_bucket` and `my-bucket` are two distinct
   * Supabase buckets that both map to `my-bucket`. Letting them share one
   * target bucket would merge two buckets' objects into one namespace, and the
   * second bucket's key collisions would then overwrite the first's files.
   * Suffix instead. Reusing a slug that exists from an EARLIER import is still
   * intentional: that is what makes a re-run resumable.
   */
  private claimBucketSlug(sourceName: string, claimed: Set<string>): string {
    const base = toBucketSlug(sourceName);
    if (!claimed.has(base)) {
      claimed.add(base);
      return base;
    }
    // 63 is the slug ceiling, so make room for the suffix rather than overflow.
    const stem = base.slice(0, 58).replace(/-+$/, '');
    for (let n = 2; ; n++) {
      const candidate = `${stem}-${n}`;
      if (!claimed.has(candidate)) {
        claimed.add(candidate);
        return candidate;
      }
    }
  }

  /** The source's bucket catalog, with per-bucket object counts and sizes. */
  private async readSourceBuckets(
    client: Pick<Client, 'query'>
  ): Promise<{ bucket: string; isPublic: boolean; fileSizeLimit: number | null; objects: number; bytes: number }[]> {
    const { rows } = await client.query(
      `SELECT b.id                                                            AS bucket,
              coalesce(b.public, false)                                       AS is_public,
              b.file_size_limit                                               AS file_size_limit,
              count(o.id)::int                                                AS objects,
              coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)::bigint AS bytes
         FROM storage.buckets b
         LEFT JOIN storage.objects o ON o.bucket_id = b.id
        GROUP BY b.id, b.public, b.file_size_limit
        ORDER BY b.id`
    );
    return (rows as any[]).map(row => ({
      bucket: String(row.bucket),
      isPublic: row.is_public === true,
      fileSizeLimit: row.file_size_limit == null ? null : Number(row.file_size_limit),
      objects: Number(row.objects ?? 0),
      bytes: Number(row.bytes ?? 0),
    }));
  }

  /** The source's object catalog. Capped: see MAX_IMPORT_OBJECTS. */
  private async readSourceObjects(
    client: Pick<Client, 'query'>,
    summary: ImportSummary
  ): Promise<RawSupabaseObject[]> {
    const { rows } = await client.query(
      `SELECT o.bucket_id                AS bucket,
              o.name                     AS name,
              o.metadata->>'mimetype'    AS mime,
              o.metadata->>'size'        AS size
         FROM storage.objects o
        WHERE o.name IS NOT NULL
          AND o.metadata IS NOT NULL
        ORDER BY o.bucket_id, o.name
        LIMIT ${MAX_IMPORT_OBJECTS + 1}`
    );
    const objects = rows as RawSupabaseObject[];
    if (objects.length > MAX_IMPORT_OBJECTS) {
      summary.notes.push(
        `The source has more than ${MAX_IMPORT_OBJECTS.toLocaleString()} storage objects; only the first ${MAX_IMPORT_OBJECTS.toLocaleString()} were considered. Copy the rest with the Storage API directly.`
      );
      return objects.slice(0, MAX_IMPORT_OBJECTS);
    }
    return objects;
  }

  /**
   * Download each object from the source's Storage API and write it into this
   * project's storage, at the same bucket-relative key. One object's failure is
   * recorded and the loop continues: a migration that stops at the first 404
   * leaves the operator with no way to tell how much did land.
   */
  private async copyStorageObjects(
    objects: RawSupabaseObject[],
    slugFor: Map<string, string>,
    sourceBuckets: { bucket: string; isPublic: boolean }[],
    cloud: SupabaseCloudClient,
    summary: ImportSummary
  ): Promise<void> {
    if (objects.length === 0) return;

    const publicBuckets = new Set(sourceBuckets.filter(b => b.isPublic).map(b => b.bucket));
    const maxBytes = env.MAX_UPLOAD_BYTES;

    // Policy-backed storage authorization decides admin writes too, and a
    // freshly imported policy set can refuse every one of them. Say so once,
    // up front, instead of once per object in the error list.
    if (await this.di.StoragePolicyService?.enabled().catch(() => false)) {
      summary.notes.push(
        'Policy-based storage authorization is on, so the imported policies decide whether these writes are allowed. Turn it off for the duration of the import if objects come back denied.'
      );
    }

    for (const object of objects) {
      const key = String(object.name ?? '');
      const bucketSlug = slugFor.get(object.bucket);
      if (!bucketSlug || !key || key.endsWith(SUPABASE_FOLDER_PLACEHOLDER)) {
        summary.storage.skipped++;
        continue;
      }
      const size = Number(object.size ?? 0);
      if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
        summary.storage.skipped++;
        summary.storage.errors.push(
          `${object.bucket}/${key}: ${size > maxBytes ? `larger than this project's ${maxBytes}-byte upload ceiling` : 'no usable size in the source catalog'}`
        );
        continue;
      }

      try {
        const downloaded = await cloud.downloadObject(object.bucket, key, maxBytes);
        await this.di.StorageService.adminUpload({
          filename: key.split('/').pop() || key,
          body: Readable.from(downloaded.body),
          size: downloaded.body.length,
          mime: object.mime ?? downloaded.contentType ?? undefined,
          visibility: publicBuckets.has(object.bucket) ? FileVisibility.public : FileVisibility.private,
          bucketSlug,
          objectKey: key,
          upsert: true,
        });
        summary.storage.objects++;
      } catch (error: unknown) {
        summary.storage.errors.push(`${object.bucket}/${key}: ${redactConnectionSecrets(errorMessage(error))}`);
      }
    }
  }

  /**
   * Point columns holding the source project's storage URLs at this one.
   *
   * `profiles.avatar_url` and its kind hold a whole URL, not a key, and the
   * dump carried those strings across verbatim: the app keeps serving images
   * out of the Supabase project it was just migrated off, right up until that
   * project is paused. The bytes are already here under the same key, so only
   * the prefix up to and including the bucket has to change.
   *
   * Every text, varchar and json column of every base table in `public` is
   * considered, because there is no way to know which one holds a URL. Each
   * statement is `WHERE position(prefix in col) > 0`, so a column that holds
   * none is one index-less scan and no writes.
   * ponytail: one UPDATE per column per bucket. Tables × buckets stays small in
   * practice; batch the prefixes into a single CASE if a source ever has forty
   * buckets and a hundred tables.
   */
  private async rewriteStorageUrls(
    projectUrl: string,
    slugFor: Map<string, string>,
    summary: ImportSummary
  ): Promise<void> {
    const rewrites = supabaseStorageUrlRewrites(projectUrl, slugFor, slug =>
      this.di.StorageService.publicObjectUrl(slug, '')
    );
    if (rewrites.length === 0) return;

    try {
      const columns = await this.di.prisma.$queryRawUnsafe<
        { table_name: string; column_name: string; data_type: string }[]
      >(
        `SELECT c.table_name, c.column_name, c.data_type
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema
            AND t.table_name = c.table_name
            AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema = 'public'
            AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
            AND c.is_generated = 'NEVER'`
      );

      let rows = 0;
      const touched = new Set<string>();
      for (const column of columns) {
        for (const rewrite of rewrites) {
          const sql = storageUrlRewriteSql(column.table_name, column.column_name, column.data_type);
          const updated = await this.di.prisma.$executeRawUnsafe(sql, rewrite.from, rewrite.to);
          if (updated > 0) {
            rows += updated;
            touched.add(`${column.table_name}.${column.column_name}`);
          }
        }
      }

      if (rows > 0) {
        summary.notes.push(
          `Rewrote ${rows} Supabase storage URL(s) to this project's storage in: ${[...touched].join(', ')}. Transform URLs (/render/image/public/…) were left alone: their resize options have no equivalent here.`
        );
      }
    } catch (error: unknown) {
      summary.storage.errors.push(
        `storage URL rewrite: ${redactConnectionSecrets(errorMessage(error))}. Imported rows may still point at the source project.`
      );
    }
  }

  // ── Edge functions ─────────────────────────────────────────────────────────

  /**
   * Supabase edge functions are Deno, and so is this runtime, so the source is
   * imported as written: `Deno.serve`, `Deno.env.get`, `npm:`/`jsr:`/URL
   * imports all run unchanged. The one reshaping is the local graph: a
   * deployed function is several files, flattened here into the one source a
   * function row holds.
   *
   * Each function goes through the same deploy-time check the Studio deploy
   * button runs. One that loads is imported ENABLED; one that does not is
   * imported DISABLED with its source intact and the reason named.
   */
  private async importEdgeFunctions(cloud: SupabaseCloudClient | null, summary: ImportSummary): Promise<void> {
    if (!cloud) return;
    if (!cloud.hasManagementToken) {
      summary.notes.push(
        'Edge functions were skipped: they live outside the database, so reading them needs a Supabase personal access token (supabase.com/dashboard/account/tokens).'
      );
      return;
    }

    let functions: Awaited<ReturnType<SupabaseCloudClient['listFunctions']>>;
    try {
      functions = await cloud.listFunctions();
    } catch (error: unknown) {
      summary.edgeFunctions.errors.push(redactConnectionSecrets(errorMessage(error)));
      return;
    }

    const multiFile: string[] = [];
    const heldBack: string[] = [];
    const madePublic: string[] = [];
    for (const fn of functions) {
      try {
        // The slug IS the route, verbatim. A Supabase function is called at
        // /functions/v1/<slug> and this project's at /api/edge/<slug>, so
        // keeping the slug is what lets a client change only the base URL.
        // Supabase slugs are already URL-safe; anything else is refused rather
        // than rewritten into a path the caller never asked for.
        const route = fn.slug;
        if (!/^[A-Za-z0-9._~-]+$/.test(route)) {
          summary.edgeFunctions.errors.push(`${fn.slug}: slug is not usable as a route on this project`);
          continue;
        }

        const body = await cloud.getFunctionBody(fn.slug);
        // A function row holds one source, so a multi-file function has its
        // local files inlined. If the flatten fails, fall back to the entry
        // module alone and say so.
        let source = body.source;
        if (body.otherFiles.length > 0) {
          try {
            source = (await bundleImportedGraph(body.modules, body.entry)).code;
          } catch (error: unknown) {
            multiFile.push(`${fn.slug} (${body.otherFiles.join(', ')})`);
            summary.edgeFunctions.errors.push(
              `${fn.slug}: could not inline its other files (${errorMessage(error)}); only the entry module was imported`
            );
          }
        }
        const existing = await this.di.prisma.edgeFunction.findFirst({
          where: { OR: [{ name: fn.slug }, { route }] },
        });
        if (existing) {
          summary.edgeFunctions.errors.push(`${fn.slug}: a function with that name or route already exists`);
          continue;
        }

        // verify_jwt off on Supabase means anyone may call it (a Stripe or
        // GitHub webhook receiver, typically). Importing it private would turn
        // every such delivery into a 401, so it keeps exactly the access it had.
        const isPublic = fn.verifyJwt === false;
        if (isPublic) madePublic.push(fn.slug);
        const failure = await this.di.EdgeFunctionService.create({ name: fn.slug, route, code: source, enabled: true, isPublic })
          .then(() => null)
          .catch((error: unknown) => errorMessage(error));

        if (failure !== null) {
          // Straight to prisma, deliberately: `create()` runs the deploy check
          // this source just failed. Storing it disabled keeps the migration
          // lossless.
          await this.di.prisma.edgeFunction.create({
            data: { name: fn.slug, route, code: source, enabled: false, isPublic },
          });
          summary.edgeFunctions.needsPorting++;
          summary.edgeFunctions.disabled.push(fn.slug);
          heldBack.push(`${fn.slug} (${failure})`);
        } else {
          summary.edgeFunctions.enabled++;
        }
        summary.edgeFunctions.imported++;
      } catch (error: unknown) {
        summary.edgeFunctions.errors.push(`${fn.slug}: ${redactConnectionSecrets(errorMessage(error))}`);
      }
    }

    if (heldBack.length > 0) {
      summary.notes.push(`Imported DISABLED because they failed the deploy check: ${heldBack.join(' | ')}.`);
    }
    if (multiFile.length > 0) {
      // The flatten failed: only the entry module came across. Say which files
      // did not rather than let them go missing.
      summary.notes.push(
        `These functions were split across several files on Supabase and only their entry module was imported: ${multiFile.join(' | ')}. Paste the rest in, or inline them, before enabling.`
      );
    }
    if (madePublic.length > 0) {
      summary.notes.push(
        `Imported as Public because verify_jwt was off on Supabase, so anyone can call them here too: ${madePublic.join(', ')}. Each should check its sender (a webhook signature) itself; turn Public off in Edge Functions for any that should not be open.`
      );
    }
  }

  // ── Project secrets ────────────────────────────────────────────────────────

  /**
   * Supabase's project secrets are the `Deno.env` of its edge functions; this
   * project's equivalent is the edge-function secret store, which is what the
   * ported `Deno.env.get()` shim reads. Carrying them over is what makes an
   * imported function able to run at all.
   */
  private async importSecrets(cloud: SupabaseCloudClient | null, summary: ImportSummary): Promise<void> {
    if (!cloud) return;
    if (!cloud.hasManagementToken) {
      summary.notes.push(
        'Project secrets were skipped: reading them needs a Supabase personal access token (supabase.com/dashboard/account/tokens).'
      );
      return;
    }

    let secrets: Awaited<ReturnType<SupabaseCloudClient['listSecrets']>>;
    try {
      secrets = await cloud.listSecrets();
    } catch (error: unknown) {
      summary.secrets.errors.push(redactConnectionSecrets(errorMessage(error)));
      return;
    }

    // Supabase answers with sha256 digests, not values (see
    // looksLikeSecretDigest). Storing those would give every ported function a
    // credential-shaped string that is not its credential, which fails at the
    // third party rather than here. Carry the NAMES and say so instead.
    for (const secret of secrets) {
      // SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY and friends
      // name the SOURCE project. Importing them would leave every ported
      // function talking to Supabase.
      if (SUPABASE_MANAGED_SECRET.test(secret.name)) {
        summary.secrets.skipped++;
        continue;
      }
      if (looksLikeSecretDigest(secret.value)) {
        summary.secrets.skipped++;
        summary.secrets.undisclosed.push(secret.name);
        continue;
      }
      try {
        await this.di.SecretsService.set(secret.name, secret.value);
        summary.secrets.imported++;
      } catch (error: unknown) {
        // Only the NAME, never the value.
        summary.secrets.errors.push(`${secret.name}: ${errorMessage(error)}`);
      }
    }

    const undisclosed = summary.secrets.undisclosed.length;
    if (undisclosed > 0) {
      // Named in the summary as data too (secrets.undisclosed): the studio
      // turns that into a checklist, and this sentence explains the why.
      summary.notes.push(
        `Supabase never discloses secret values: its API returns a hash of each one, so ${undisclosed} secret(s) were NOT imported and must be set here by hand before the functions that read them are enabled.`
      );
    }
    if (summary.secrets.skipped > undisclosed) {
      summary.notes.push(
        `${summary.secrets.skipped - undisclosed} Supabase-managed secret(s) (SUPABASE_*) were skipped: they point at the source project. Imported functions should use this project's own URL and keys.`
      );
    }
  }

  private async importSchemaAndData(
    connectionString: string,
    flags: Required<ImportInclude>,
    summary: ImportSummary
  ): Promise<void> {
    const dumpFile = this.resolveInsideRoot(`supabase-import-${Date.now()}.sql`);
    await fs.mkdir(path.dirname(dumpFile), { recursive: true });
    try {
      const manifestOptions = { includeRows: flags.data, includeSchemaObjects: flags.schema };
      const expectedManifest = await this.captureManifest(connectionString, manifestOptions);
      const schemas = await this.resolveSourceSchemas(connectionString, summary);
      const dumpArgs = [
        '--dbname',
        toLibpqUrl(connectionString),
        ...schemas.map(s => `--schema=${s}`),
        '--no-owner',
        '--no-privileges',
        ...EXCLUDED_SCHEMAS.map(s => `--exclude-schema=${s}`),
      ];
      // Both true → full dump (structure + data + policies). One-sided → narrow.
      if (flags.schema && !flags.data) dumpArgs.push('--schema-only');
      else if (flags.data && !flags.schema) dumpArgs.push('--data-only');
      dumpArgs.push('--file', dumpFile);

      await this.run('pg_dump', dumpArgs);

      // pg_dump describes the server it dumped FROM, and recreates the schema it
      // dumped. Either can abort the atomic load in its first 30 lines.
      await this.prepareDumpForTarget(dumpFile, summary);

      // Must happen before the load: the dump's GRANT/POLICY statements name
      // Supabase roles this database does not have yet.
      await this.ensureCompatRoles(summary);

      // Keep schema, data and RLS policies atomic. ON_ERROR_STOP makes psql
      // return non-zero on the first SQL error; --single-transaction then rolls
      // the whole dump back instead of leaving a half-applied database.
      const load = await this.run('psql', [
        '--dbname',
        toLibpqUrl(env.DATABASE_URL),
        '--single-transaction',
        '--variable',
        'ON_ERROR_STOP=1',
        '--file',
        dumpFile,
      ]);

      const restoredManifest = await this.captureManifest(env.DATABASE_URL, manifestOptions);
      summary.verification = verifyImportManifest(expectedManifest, restoredManifest);
      if (!summary.verification.valid) {
        const details = summary.verification.errors.slice(0, 10).join('; ');
        throw new Error('post-import verification failed: ' + details);
      }

      summary.schema.applied = flags.schema;
      summary.data.applied = flags.data;
      const warnings = (load.stderr || '').trim();
      if (warnings) {
        summary.schema.warnings = warnings;
        summary.notes.push('psql reported warnings or notices during the atomic load (see schema.warnings).');
      }
    } catch (error: unknown) {
      // HttpException from runCommand never contains the connection string; the
      // scrub is a second line of defence for driver errors we did not author.
      const message = redactConnectionSecrets(errorMessage(error) || 'schema/data import failed');
      if (flags.schema) summary.schema.error = message;
      if (flags.data) summary.data.error = message;
      const hint = this.explainSchemaFailure(message);
      if (hint) summary.notes.push(hint);
    } finally {
      // The only DDL path that cannot go through `execDdl`: psql applies the dump
      // in a separate process, so nothing in this process observes the statements.
      // Invalidate unconditionally, because a load that failed part way (or that
      // rolled back after creating types) still leaves our snapshot untrustworthy.
      invalidateCatalog();
      await fs.unlink(dumpFile).catch(() => {});
    }
  }

  /**
   * The user-defined schemas on a source, excluding `public` itself: the ones
   * that must ride along with a `public` dump for it to load at all.
   *
   * `unsupported` holds names pg_dump's pattern syntax cannot select verbatim.
   */
  private async readUserSchemas(
    client: Pick<Client, 'query'>
  ): Promise<{ extra: string[]; unsupported: string[] }> {
    const { rows } = await client.query(
      `SELECT nspname FROM pg_namespace WHERE nspname <> ALL($1::text[]) ORDER BY nspname`,
      [[...EXCLUDED_SCHEMAS]]
    );

    const extra: string[] = [];
    const unsupported: string[] = [];
    for (const { nspname } of rows as { nspname: string }[]) {
      if (nspname === 'public' || SYSTEM_SCHEMA_PATTERN.test(nspname)) continue;
      if (!PLAIN_IDENTIFIER.test(nspname)) unsupported.push(nspname);
      else extra.push(nspname);
    }
    return { extra, unsupported };
  }

  /**
   * The source schemas worth dumping: `public` plus every other schema the user
   * defined, minus the Supabase-managed ones this platform replaces.
   *
   * `public` is always first and always present, so a source whose catalog
   * cannot be read still produces the previous (public-only) behaviour rather
   * than an empty dump.
   */
  private async resolveSourceSchemas(connectionString: string, summary: ImportSummary): Promise<string[]> {
    let client: Client | null = null;
    try {
      client = await this.openClient(connectionString);
      const { extra, unsupported } = await this.readUserSchemas(client);

      if (extra.length > 0) {
        summary.notes.push(
          `The source defines schemas besides public; they were imported too, because public policies and triggers call into them: ${extra.join(', ')}.`
        );
      }
      if (unsupported.length > 0) {
        summary.notes.push(
          `Skipped schemas whose names pg_dump cannot select safely: ${unsupported.join(', ')}. Objects in public that reference them will not load.`
        );
      }
      return ['public', ...extra];
    } catch (error: unknown) {
      const message = errorMessage(error);
      summary.notes.push(
        `Could not list the source schemas (${message}); only public was dumped. If the load fails with 'schema "…" does not exist', that schema holds helpers your policies call.`
      );
      return ['public'];
    } finally {
      await client?.end().catch(() => {});
    }
  }

  /**
   * Make the dump loadable into THIS project's database, in one read/write pass:
   *
   * 1. Drop preamble `SET`s this Postgres does not know. The project image ships
   *    pg_dump 17 while a project DB runs 16, so a dump of a Supabase 17 source
   *    arrives with `SET transaction_timeout = 0;` at the top.
   * 2. Make `CREATE SCHEMA` idempotent. A `--schema=public` dump of a Supabase
   *    source recreates `public`, which every project database already has.
   *
   * Both abort the atomic load near the top of the file, taking the whole schema
   * and data import down with them.
   */
  private async prepareDumpForTarget(dumpFile: string, summary: ImportSummary): Promise<void> {
    const supported = await this.readTargetSettings();
    // Without a catalog read, fall back to the parameters known to exist on every
    // supported Postgres. Skipping the rewrite instead would hand psql a preamble
    // that can roll the entire import back on its thirteenth line.
    const isSupported = supported
      ? (name: string) => supported.has(name)
      : (name: string) => PORTABLE_DUMP_SETTINGS.has(name);

    const sql = await fs.readFile(dumpFile, 'utf8');
    const { sql: withoutUnknownSettings, stripped } = neutralizeUnsupportedSettings(sql, isSupported);
    const { sql: withIdempotentSchemas, relaxed } = relaxSchemaCreation(withoutUnknownSettings);
    const { sql: rewritten, casts } = castAuthUidToUuid(withIdempotentSchemas);
    if (stripped.length === 0 && relaxed.length === 0 && casts === 0) return;

    await fs.writeFile(dumpFile, rewritten, 'utf8');
    if (stripped.length > 0) {
      summary.notes.push(
        `The source runs a newer Postgres than this project. Dump settings unknown here were ignored: ${stripped.join(', ')}.`
      );
    }
    if (relaxed.length > 0) {
      summary.notes.push(
        `The dump recreates schemas this project already has, so its CREATE SCHEMA statements were made idempotent: ${relaxed.join(', ')}.`
      );
    }
    if (casts > 0) {
      summary.notes.push(
        `Supabase's auth.uid() returns uuid where this project's returns text, so ${casts} call${casts === 1 ? '' : 's'} in the dump ${casts === 1 ? 'was' : 'were'} cast to uuid. Your policies keep the meaning they had on Supabase.`
      );
    }
  }

  /**
   * The parameter names this project's Postgres accepts, or null when the
   * catalog cannot be read. Never throws: a database that refuses `pg_settings`
   * should degrade to the portable list, not fail the whole import.
   */
  private async readTargetSettings(): Promise<Set<string> | null> {
    const client = this.createClient(env.DATABASE_URL);
    try {
      await client.connect();
      const { rows } = await client.query('SELECT name FROM pg_settings');
      const names = new Set((rows as { name: string }[]).map(row => row.name.toLowerCase()));
      return names.size > 0 ? names : null;
    } catch {
      return null;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Turn the raw pg_dump/psql failure into the one action that fixes it. The
   * schema+data step is atomic, so any of these leaves a database where only
   * the auth users landed: the message has to say why.
   */
  private explainSchemaFailure(message: string): string | undefined {
    const text = message.toLowerCase();
    if (text.includes('post-import verification failed')) {
      // psql committed before this ran, so the objects are already there. Saying
      // "failed" without saying that sends people into a retry that cannot work.
      return 'The dump loaded and committed; only the comparison afterwards disagreed, so the objects ARE in this project. Review the differences above. A retry will fail on objects that already exist, so drop them first if you want a clean run.';
    }
    if (text.includes('enotfound') || text.includes('could not translate host name')) {
      return 'The source host could not be resolved. Supabase direct connections (db.<ref>.supabase.co) are IPv6-only; use the Session pooler URI on port 5432.';
    }
    if (text.includes('server version mismatch') || text.includes('aborting because of server version mismatch')) {
      return 'pg_dump is older than the source Supabase Postgres. Install matching Postgres client tools or point PG_BIN_DIR at a newer bin directory.';
    }
    if (text.includes('unrecognized configuration parameter')) {
      // The importer rewrites this preamble before the load, so reaching psql
      // with it intact means the rewrite never ran: almost always a server
      // still running an older build of this project.
      const name = /unrecognized configuration parameter "([^"]+)"/i.exec(message)?.[1];
      const which = name ? `"${name}"` : 'a parameter';
      return `The dump sets ${which}, which this project's Postgres does not have. The importer normally neutralizes those before loading, so this points at a server running an older build. Rebuild and restart the app container, then retry the import.`;
    }
    if (text.includes('prepared statement') || text.includes('unnamed prepared statement does not exist')) {
      return 'This looks like the transaction pooler (port 6543), which pg_dump cannot use. Switch to the Session pooler URI on port 5432.';
    }
    if (text.includes('does not exist') && text.includes('role')) {
      return 'The dump grants to a Postgres role this project does not have. Create the role (NOLOGIN) and retry.';
    }
    if (/operator does not exist: (uuid = text|text = uuid)/i.test(message)) {
      // The importer casts auth.uid() to uuid before the load, so reaching psql
      // with an uncast comparison means the rewrite never ran.
      return "A policy compares a uuid column against text. Supabase's auth.uid() returns uuid while this project's returns text; the importer normally casts those calls, so this points at a server running an older build. Rebuild and restart the app container, then retry the import.";
    }
    const missingAuthHelper = /function auth\.([a-z_]+)\(\) does not exist/i.exec(message)?.[1];
    if (missingAuthHelper) {
      return `The dump calls auth.${missingAuthHelper}(), which Supabase provides and this project does not. Define it in the SQL editor (auth.jwt() gives you the claims to build it from), then retry the import.`;
    }
    const missingSchema = /schema "([^"]+)" does not exist/i.exec(message)?.[1];
    if (missingSchema) {
      const excluded = (EXCLUDED_SCHEMAS as readonly string[]).includes(missingSchema);
      return excluded
        ? `The dump references "${missingSchema}", a Supabase-managed schema this platform replaces and never imports. Rewrite the objects that call into it (usually policies or triggers) to use this project's equivalents, then retry.`
        : `The dump references schema "${missingSchema}", which was not imported. The importer normally dumps every user-defined schema alongside public, so this points at a server running an older build. Rebuild and restart the app container, then retry the import.`;
    }
    if (/schema "[^"]+" already exists/i.test(message)) {
      // The importer rewrites CREATE SCHEMA to IF NOT EXISTS before the load, so
      // reaching psql with a bare one means the rewrite never ran.
      return 'The dump recreates a schema this project already has. The importer normally makes those statements idempotent, so this points at a server running an older build. Rebuild and restart the app container, then retry the import.';
    }
    if (text.includes('already exists')) {
      return 'An object in the dump already exists in this project. Import into an empty project, or drop the conflicting objects first.';
    }
    if (text.includes('permission denied') || text.includes('password authentication failed')) {
      return 'The source credentials were rejected. Copy a fresh URI from Supabase → Connect and check the database password.';
    }
    return undefined;
  }

  private async captureManifest(
    connectionString: string,
    options: { includeRows: boolean; includeSchemaObjects: boolean },
  ) {
    const client = await this.openClient(connectionString);
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const manifest = await captureImportManifest(client, options);
      await client.query('COMMIT');
      return manifest;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * Create the Supabase-side roles a dump references, if this database lacks
   * them. NOLOGIN and privilege-free: they exist purely so `GRANT … TO
   * service_role` and `CREATE POLICY … TO authenticated` parse.
   *
   * Best effort. A DB user without CREATEROLE just gets a note in the summary;
   * the load then fails with the underlying psql error, which is clearer than
   * failing here.
   */
  private async ensureCompatRoles(summary: ImportSummary): Promise<void> {
    const client = this.createClient(env.DATABASE_URL);
    try {
      await client.connect();
      const created: string[] = [];
      for (const role of SUPABASE_COMPAT_ROLES) {
        const { rows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (rows.length > 0) continue;
        // Role names are from the constant above, never from user input.
        await client.query(`CREATE ROLE ${this.quoteIdent(role)} NOLOGIN`);
        created.push(role);
      }
      if (created.length > 0) {
        summary.notes.push(
          `Created Supabase-compatible roles referenced by the dump: ${created.join(', ')}.`
        );
      }
    } catch (error: unknown) {
      const message = errorMessage(error);
      summary.notes.push(
        `Could not pre-create Supabase roles (${message}). If the load fails with 'role "…" does not exist', create the role manually and retry.`
      );
    } finally {
      await client.end().catch(() => {});
    }
  }

  private async importAuthUsers(connectionString: string, summary: ImportSummary): Promise<boolean> {
    let client: Client | null = null;
    try {
      client = await this.openClient(connectionString);
      const { rows } = await client.query(
        `SELECT id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at
           FROM auth.users
          WHERE email IS NOT NULL AND email <> ''`
      );

      const takenUsernames = new Set<string>();
      for (const raw of rows as RawSupabaseUser[]) {
        const email = (raw.email ?? '').trim().toLowerCase();
        if (!email) {
          summary.auth.skipped++;
          continue;
        }
        try {
          const existing = await this.di.prisma.user.findUnique({ where: { email } });
          if (existing) {
            summary.auth.skipped++;
            continue;
          }
          const username = await this.generateUsername(email, takenUsernames);
          const meta = raw.raw_user_meta_data ?? {};
          const created = await this.di.prisma.user.create({
            data: {
              id: raw.id,
              email,
              name: email,
              classicEmail: email,
              username,
              emailVerified: !!raw.email_confirmed_at,
              firstName: this.pickName(meta, ['first_name', 'given_name']) ?? this.firstWord(meta) ?? undefined,
              lastName: this.pickName(meta, ['last_name', 'family_name']) ?? undefined,
            },
          });
          // Carry the Supabase bcrypt hash onto a Better Auth credential account
          // as-is; verification accepts bcrypt (see auth/password) and it stays
          // usable for password login.
          if (raw.encrypted_password) {
            await setCredentialHash(this.di.prisma, created.id, raw.encrypted_password);
          }
          summary.auth.imported++;
        } catch (err) {
          // Never include the connection string; only the offending email.
          summary.auth.errors.push(`${email}: ${errorMessage(err) || 'failed to import user'}`);
        }
      }
      return true;
    } catch (err) {
      summary.auth.errors.push(redactConnectionSecrets(errorMessage(err) || 'failed to read auth.users'));
      return false;
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Everything is in by default, including the three sections that need a
   * credential: a section whose credential is missing costs a note, never an
   * error, so "import my project" means the whole project rather than the part
   * that happens to live in Postgres.
   */
  private resolveInclude(include?: ImportInclude): Required<ImportInclude> {
    return {
      schema: include?.schema !== false,
      data: include?.data !== false,
      auth: include?.auth !== false,
      storage: include?.storage !== false,
      edgeFunctions: include?.edgeFunctions !== false,
      secrets: include?.secrets !== false,
    };
  }

  private resolveStatus(
    flags: Required<ImportInclude>,
    summary: ImportSummary,
    authReadSucceeded: boolean
  ): ImportSummary['status'] {
    let succeeded = 0;
    let failed = 0;

    if (flags.schema) {
      if (summary.schema.applied) succeeded++;
      else failed++;
    }
    if (flags.data) {
      if (summary.data.applied) succeeded++;
      else failed++;
    }
    if (flags.auth) {
      const authFailed = !authReadSucceeded || summary.auth.errors.length > 0;
      if (authReadSucceeded && (!authFailed || summary.auth.imported > 0 || summary.auth.skipped > 0)) succeeded++;
      if (authFailed) failed++;
    }
    // The credential-gated sections: a section that did nothing because its
    // credential was absent is neither a success nor a failure. Only work that
    // was attempted counts, so a schema-only import with no Supabase token
    // still reports "success" rather than "partial".
    for (const section of [
      { on: flags.storage, did: summary.storage.buckets + summary.storage.objects, errors: summary.storage.errors },
      { on: flags.edgeFunctions, did: summary.edgeFunctions.imported, errors: summary.edgeFunctions.errors },
      { on: flags.secrets, did: summary.secrets.imported, errors: summary.secrets.errors },
    ]) {
      if (!section.on) continue;
      if (section.errors.length > 0) failed++;
      else if (section.did > 0) succeeded++;
    }

    if (failed === 0) return 'success';
    return succeeded > 0 ? 'partial' : 'failed';
  }

  private pickName(meta: any, keys: string[]): string | undefined {
    for (const k of keys) {
      const v = meta?.[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  }

  private firstWord(meta: any): string | undefined {
    const full = meta?.full_name ?? meta?.name;
    if (typeof full === 'string' && full.trim()) return full.trim().split(/\s+/)[0];
    return undefined;
  }

  /**
   * Derive a unique username from the email local-part. Deduplicates against
   * both the current DB and usernames already generated within this batch.
   */
  private async generateUsername(email: string, taken: Set<string>): Promise<string> {
    const base =
      email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24) || 'user';

    let candidate = base;
    let suffix = 0;
    // Bound the loop; astronomically unlikely to iterate more than a few times.
    while (true) {
      if (!taken.has(candidate)) {
        const clash = await this.di.prisma.user.findUnique({ where: { username: candidate } });
        if (!clash) {
          taken.add(candidate);
          return candidate;
        }
      }
      suffix++;
      candidate = `${base}${suffix}`;
    }
  }

  /** Confine a generated temp filename to BACKUP_DIR (path-traversal safe). */
  private resolveInsideRoot(name: string): string {
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new HttpException('Import file name is required', 400);
    if (path.isAbsolute(cleanName)) throw new HttpException('Import path must be relative to BACKUP_DIR', 400);
    const root = this.root();
    const resolved = path.resolve(root, cleanName);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new HttpException('Import path escapes BACKUP_DIR', 400);
    }
    return resolved;
  }
}
