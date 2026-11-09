// The half of a Supabase project that does NOT live in its Postgres database.
//
// `import.service.ts` migrates everything reachable over the source connection
// string (schema, data, policies, auth users, and the `storage.buckets` /
// `storage.objects` catalogs). Three things are not reachable that way, and are
// what this module adds:
//
//   • object BYTES        Storage API, needs the project's service_role key.
//   • edge functions      Management API, needs a personal access token (sbp_…).
//   • project secrets     Management API, same token.
//
// Everything here is either pure (ref parsing) or a thin call
// through `OutboundHttpClientLike`, which is SSRF-guarded and response-capped.
// Nothing in here logs or returns a credential.

import type { OutboundHttpClientLike } from '../http/outbound-http-client.service';
import { type EszipModule, looksLikeEszip, parseEszip, pickEntryModule } from './eszip';

/** Supabase's own control plane. Not operator-configurable: it is one host. */
export const SUPABASE_MANAGEMENT_API = 'https://api.supabase.com';

/** Management API calls are small JSON; function bodies are source files. */
const JSON_RESPONSE_CAP = 2 * 1024 * 1024;
const FUNCTION_BODY_CAP = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const OBJECT_TIMEOUT_MS = 120_000;

/**
 * The project ref (`abcdefghijklmnopqrst`) a Supabase connection string points
 * at, or null when the URI is not a Supabase one (self-hosted, or another
 * Postgres entirely). Two shapes carry it:
 *
 *   session pooler   postgresql://postgres.<ref>:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres
 *   direct           postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
 *
 * Deriving it is what lets the operator paste one URI and still reach the
 * Storage and Management APIs, instead of hunting for the ref by hand.
 */
export function parseSupabaseProjectRef(connectionString: string): string | null {
  let url: URL;
  try {
    url = new URL(String(connectionString ?? '').trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const direct = /^db\.([a-z0-9]{16,32})\.supabase\.(?:co|red)$/.exec(host);
  if (direct) return direct[1];

  if (host.endsWith('pooler.supabase.com')) {
    // decodeURIComponent: the username arrives percent-encoded when it came out
    // of a URI the operator copied from a browser.
    const user = decodeURIComponent(url.username || '').toLowerCase();
    const pooled = /^postgres\.([a-z0-9]{16,32})$/.exec(user);
    if (pooled) return pooled[1];
  }
  return null;
}

/** The project's public API origin, which is also its Storage API origin. */
export function supabaseProjectUrl(ref: string): string {
  return `https://${ref}.supabase.co`;
}

/**
 * Supabase bucket ids are free-form; this project's bucket slugs must match
 * `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$` (see BucketService). Map rather than
 * refuse, and let the caller report when the name changed: object keys are
 * unaffected, but client code addressing the bucket by name has to follow.
 */
export function toBucketSlug(name: string): string {
  const mapped = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (!mapped) return 'bucket';
  // The slug rule has a three-character floor; a one or two character Supabase
  // bucket name is legal, so pad rather than reject it.
  return mapped.length >= 3 ? mapped : `${mapped}-bucket`;
}

// ── Supabase-hosted APIs ─────────────────────────────────────────────────────

export interface SupabaseFunctionMeta {
  slug: string;
  name: string;
  status?: string;
  verifyJwt?: boolean;
}

export interface SupabaseFunctionSource {
  /** The entry module's own source, before the other files are inlined. */
  source: string;
  /** The whole local graph, entry first, for the bundler to flatten. */
  modules: EszipModule[];
  /** The entry module's specifier inside the bundle. */
  entry: string;
  /** Other local modules found in the bundle, by path. */
  otherFiles: string[];
}

/**
 * Postgres `text` rejects U+0000 outright (SQLSTATE 22021), so one stray NUL in
 * anything read from the source project aborts the whole insert. Nothing a
 * function's source can legitimately need is a NUL.
 */
export function stripNulls(text: string): string {
  return text.replace(/\0/g, '');
}

export interface SupabaseSecret {
  name: string;
  value: string;
}

/**
 * True when the Management API handed back a digest instead of the secret.
 *
 * `GET /v1/projects/<ref>/secrets` does NOT disclose secret values: every
 * `value` comes back as the sha256 of the real one, 64 lowercase hex
 * characters. The OpenAPI spec types it as a plain string and says nothing,
 * which is how the importer came to store 19 hashes as if they were
 * credentials: every ported function would then run with a value that is not
 * its secret, and nothing would say so.
 *
 * Shape-checked rather than assumed, so a project (or a self-hosted control
 * plane) that really does return a value keeps working. A genuine secret that
 * happens to be 64 hex characters is indistinguishable and will be treated as
 * a digest; that is the safe way round.
 */
export function looksLikeSecretDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export interface SupabaseCloudOptions {
  ref: string;
  /** Defaults to `https://<ref>.supabase.co`; overridable for self-hosted. */
  projectUrl?: string;
  /** Personal access token (sbp_…). Unlocks functions + secrets. */
  managementToken?: string;
  /** service_role key. Unlocks storage object bytes. */
  serviceRoleKey?: string;
}

/**
 * Read-only client for the two Supabase APIs the importer needs. Every method
 * throws a plain Error naming the endpoint and status, never the credential.
 */
export class SupabaseCloudClient {
  constructor(
    private readonly http: OutboundHttpClientLike,
    private readonly options: SupabaseCloudOptions
  ) {}

  get projectUrl(): string {
    return this.options.projectUrl || supabaseProjectUrl(this.options.ref);
  }

  get hasManagementToken(): boolean {
    return Boolean(this.options.managementToken);
  }

  get hasServiceRoleKey(): boolean {
    return Boolean(this.options.serviceRoleKey);
  }

  async listFunctions(): Promise<SupabaseFunctionMeta[]> {
    const body = await this.management<unknown>(`/v1/projects/${this.options.ref}/functions`);
    if (!Array.isArray(body)) return [];
    return body
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(row => ({
        slug: String(row.slug ?? row.name ?? ''),
        name: String(row.name ?? row.slug ?? ''),
        status: typeof row.status === 'string' ? row.status : undefined,
        verifyJwt: typeof row.verify_jwt === 'boolean' ? row.verify_jwt : undefined,
      }))
      .filter(fn => fn.slug);
  }

  /**
   * A function's source.
   *
   * The Management API answers with the deployed **eszip** bundle, not the text
   * that was deployed, so this unpacks it (see eszip.ts). Older deployments
   * answer with the source itself, which is why a body that is not an eszip is
   * passed straight through rather than refused.
   */
  async getFunctionBody(slug: string): Promise<SupabaseFunctionSource> {
    const response = await this.managementRequest(
      `/v1/projects/${this.options.ref}/functions/${encodeURIComponent(slug)}/body`,
      FUNCTION_BODY_CAP
    );
    const bytes = Buffer.from(await response.arrayBuffer());

    if (!looksLikeEszip(bytes)) {
      const source = stripNulls(bytes.toString('utf8'));
      return { source, modules: [{ specifier: 'index.ts', source }], entry: 'index.ts', otherFiles: [] };
    }

    const modules = parseEszip(bytes).map(module => ({ ...module, source: stripNulls(module.source) }));
    const entry = pickEntryModule(modules);
    if (!entry) throw new Error('the deployed bundle holds no source file for this function');
    return {
      source: entry.source,
      // Remote modules are dropped: the bundle carries a copy of every
      // dependency it fetched, and inlining those would turn a 3 KB function
      // into the 8 MB archive it was deployed as.
      modules: modules.filter(module => !/^(?:https?|npm|jsr|node|data|blob|deno):/i.test(module.specifier)),
      entry: entry.specifier,
      otherFiles: entry.otherFiles,
    };
  }

  async listSecrets(): Promise<SupabaseSecret[]> {
    const body = await this.management<unknown>(`/v1/projects/${this.options.ref}/secrets`);
    if (!Array.isArray(body)) return [];
    return body
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map(row => ({ name: String(row.name ?? ''), value: String(row.value ?? '') }))
      .filter(secret => secret.name && secret.value);
  }

  /**
   * One object's bytes from the Storage API.
   *
   * Buffered, not streamed: `OutboundHttpClientLike` is the SSRF-guarded client
   * this codebase uses for every operator-supplied URL, and it buffers. The
   * caller bounds this by skipping any object whose catalogued size exceeds the
   * target's own upload ceiling.
   * ponytail: whole object in memory; a streaming guarded client is the upgrade
   * if multi-GB objects become a real case.
   */
  async downloadObject(
    bucket: string,
    key: string,
    maxBytes: number
  ): Promise<{ body: Buffer; contentType?: string }> {
    const serviceRoleKey = this.options.serviceRoleKey;
    if (!serviceRoleKey) throw new Error('a service_role key is required to download storage objects');

    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = `${this.projectUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedKey}`;
    const response = await this.http.request(url, {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
      timeoutMs: OBJECT_TIMEOUT_MS,
      maxResponseBytes: maxBytes,
    });
    if (!response.ok) {
      throw new Error(`storage API returned ${response.status} for ${bucket}/${key}`);
    }
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  private async management<T>(path: string): Promise<T> {
    const response = await this.managementRequest(path, JSON_RESPONSE_CAP);
    return (await response.json()) as T;
  }

  private async managementRequest(path: string, maxResponseBytes: number): Promise<Response> {
    const token = this.options.managementToken;
    if (!token) throw new Error('a Supabase personal access token is required for the Management API');

    const response = await this.http.request(`${SUPABASE_MANAGEMENT_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeoutMs: API_TIMEOUT_MS,
      maxResponseBytes,
    });
    if (!response.ok) throw new Error(describeManagementStatus(response.status, path));
    return response;
  }
}

/** Turn a Management API status into the one action that fixes it. */
export function describeManagementStatus(status: number, path: string): string {
  if (status === 401) {
    return 'Supabase rejected the personal access token. Generate a fresh one at supabase.com/dashboard/account/tokens.';
  }
  if (status === 403) {
    return 'That personal access token cannot read this project. Use a token from an account with access to it.';
  }
  if (status === 404) {
    return `Supabase has nothing at ${path}. Check the project ref, and that the project still exists.`;
  }
  if (status === 429) {
    return 'Supabase rate-limited the Management API. Wait a minute and retry.';
  }
  return `Supabase Management API returned ${status} for ${path}.`;
}

// ── Storage URLs left behind in table data ───────────────────────────────────

/**
 * A row like `profiles.avatar_url` holds a whole URL, not a key:
 *
 *   https://<ref>.supabase.co/storage/v1/object/public/avatars/u1/face.png
 *
 * Copying the object across does not touch that string, so every such column
 * still points at Supabase after the import: the source project keeps serving
 * the app until someone pauses it, and then the images vanish. Only the prefix
 * up to and including the bucket changes, so a plain `replace` over the columns
 * that contain it is the whole fix.
 *
 * Transform URLs (`/render/image/public/...`) carry resize options this project
 * has no equivalent for, so they are reported rather than rewritten into
 * something that silently serves the full-size original.
 */
export interface StorageUrlRewrite {
  from: string;
  to: string;
}

export function supabaseStorageUrlRewrites(
  projectUrl: string,
  buckets: Iterable<[sourceBucket: string, targetSlug: string]>,
  publicUrlPrefix: (slug: string) => string
): StorageUrlRewrite[] {
  const origin = projectUrl.replace(/\/+$/, '');
  const rewrites: StorageUrlRewrite[] = [];
  for (const [sourceBucket, slug] of buckets) {
    const to = publicUrlPrefix(slug);
    rewrites.push({ from: `${origin}/storage/v1/object/public/${sourceBucket}/`, to });
    // Supabase's own SDK builds the same URL without the origin when the client
    // was pointed at a relative base; both shapes turn up in real tables.
    rewrites.push({ from: `/storage/v1/object/public/${sourceBucket}/`, to });
  }
  // Longest first: the absolute form contains the relative one, so rewriting
  // the relative one first would leave `https://<ref>.supabase.co<new prefix>`.
  return rewrites.sort((a, b) => b.from.length - a.from.length);
}

/** `"schema"."name"`, with embedded quotes doubled. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One `UPDATE` that swaps `$1` for `$2` in a column, touching only the rows
 * that hold it. `position(... in ...)` rather than `LIKE`, so a prefix
 * containing `%` or `_` needs no escaping.
 */
export function storageUrlRewriteSql(
  table: string,
  column: string,
  dataType: string,
  schema = 'public'
): string {
  const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const col = quoteIdent(column);
  if (dataType === 'jsonb' || dataType === 'json') {
    return `UPDATE ${target} SET ${col} = replace(${col}::text, $1, $2)::${dataType} WHERE position($1 in ${col}::text) > 0`;
  }
  return `UPDATE ${target} SET ${col} = replace(${col}, $1, $2) WHERE position($1 in ${col}) > 0`;
}
