/**
 * Read-only probe of a real Supabase project, run by hand.
 *
 *   1. put credentials in `.supabase-live.env` (gitignored)
 *   2. npx tsx scripts/supabase-live-check.ts
 *
 * The import has failure modes no unit test reaches, because they are facts
 * about the source project: the eszip version its functions were deployed as,
 * whether the pooler on 5432 accepts a dump, whether pg_dump here is older than
 * the Postgres over there. This walks every one of those with the importer's
 * own code, and writes NOTHING: no import runs, no local database is touched,
 * nothing is sent to Supabase but GETs.
 *
 * Secrets are never printed. Values are shown as lengths, keys as names.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { bundleImportedGraph } from '../apps/server/services/admin/edge-bundler';
import { looksLikeEszip, parseEszip, pickEntryModule } from '../apps/server/services/admin/eszip';
import {
  SupabaseCloudClient,
  parseSupabaseProjectRef,
  portDenoEdgeFunction,
  supabaseProjectUrl,
} from '../apps/server/services/admin/supabase-platform';
import { OutboundHttpClient } from '../apps/server/services/http/outbound-http-client.service';

const ENV_FILE = path.join(__dirname, '..', '.supabase-live.env');

function readEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(`${path.basename(file)} not found. Fill it in first; it is gitignored.`);
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const ok = (message: string) => console.log(`  ✓ ${message}`);
const bad = (message: string) => console.log(`  ✗ ${message}`);
const warn = (message: string) => console.log(`  ! ${message}`);
const info = (message: string) => console.log(`    ${message}`);
const head = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);

/** Whatever went wrong, as one line, with no credential in it. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '<connection string>').split('\n')[0];
}

/** The one thing that must never reach a Postgres `text` column. */
const hasNul = (text: string) => text.includes('\0');

async function checkDatabase(conn: string): Promise<void> {
  head('Source database (session pooler)');
  const url = new URL(conn);
  if (url.port === '6543') {
    bad('port 6543 is the transaction pooler; pg_dump cannot use it. Use the session pooler on 5432.');
  }

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch (error) {
    bad(`cannot connect: ${reason(error)}`);
    return;
  }

  try {
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    const serverVersion = version.rows[0].server_version;
    ok(`connected · Postgres ${serverVersion}`);

    const dump = spawnSync(
      process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, 'pg_dump') : 'pg_dump',
      ['--version'],
      { encoding: 'utf8', windowsHide: true }
    );
    if (dump.error || dump.status !== 0) {
      bad(`pg_dump not runnable here: ${dump.error ? reason(dump.error) : dump.stderr.trim()}. Set PG_BIN_DIR.`);
    } else {
      const local = /(\d+)\.\d+/.exec(dump.stdout)?.[1];
      const remote = /^(\d+)/.exec(serverVersion)?.[1];
      const line = `pg_dump ${dump.stdout.trim().replace('pg_dump (PostgreSQL) ', '')} vs source ${serverVersion}`;
      if (local && remote && Number(local) < Number(remote)) {
        bad(`${line} — older than the source; the dump will be refused. Point PG_BIN_DIR at a newer bin dir.`);
      } else {
        ok(line);
      }
    }

    const tables = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const policies = await client.query<{ count: string }>(`SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public'`);
    const users = await client.query<{ count: string }>(`SELECT count(*)::text FROM auth.users`).catch(() => null);
    info(`public: ${tables.rows[0].count} tables, ${policies.rows[0].count} policies · auth.users: ${users?.rows[0].count ?? 'unreadable'}`);

    // Schemas beside public come across too, because public policies call into
    // them. Worth seeing before the import says so.
    const schemas = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('public','pg_catalog','information_schema','auth','storage','graphql','graphql_public','realtime','supabase_functions','extensions','vault','pgbouncer','cron','net','pgsodium','pgsodium_masks','supabase_migrations','_realtime','_analytics')
          AND nspname NOT LIKE 'pg\\_%'
        ORDER BY nspname`
    );
    if (schemas.rowCount) info(`extra schemas that will be imported: ${schemas.rows.map(r => r.nspname).join(', ')}`);

    const buckets = await client
      .query<{ id: string; public: boolean; objects: string; bytes: string }>(
        `SELECT b.id, b.public, count(o.id)::text AS objects, coalesce(sum((o.metadata->>'size')::bigint),0)::text AS bytes
           FROM storage.buckets b LEFT JOIN storage.objects o ON o.bucket_id = b.id
          GROUP BY b.id, b.public ORDER BY b.id`
      )
      .catch(() => null);
    if (!buckets) {
      warn('storage.buckets unreadable (missing schema or privileges); the storage section would be skipped');
    } else {
      ok(`storage: ${buckets.rowCount} bucket(s)`);
      for (const row of buckets.rows) {
        info(`${row.id} · ${row.objects} objects · ${row.bytes} bytes · ${row.public ? 'public' : 'private'}`);
      }
    }

    // The columns the importer will rewrite. Counted, not changed.
    const ref = parseSupabaseProjectRef(conn);
    if (ref && buckets?.rowCount) {
      const prefix = `${supabaseProjectUrl(ref)}/storage/v1/object/public/`;
      const columns = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type IN ('text','character varying','json','jsonb') AND is_generated = 'NEVER'`
      );
      const holding: string[] = [];
      for (const column of columns.rows) {
        const hit = await client
          .query<{ count: string }>(
            `SELECT count(*)::text FROM "public"."${column.table_name.replace(/"/g, '""')}"
              WHERE position($1 in "${column.column_name.replace(/"/g, '""')}"::text) > 0`,
            [prefix]
          )
          .catch(() => null);
        if (hit && Number(hit.rows[0].count) > 0) holding.push(`${column.table_name}.${column.column_name} (${hit.rows[0].count})`);
      }
      if (holding.length > 0) ok(`storage URLs in table data, to be repointed: ${holding.join(', ')}`);
      else info('no column holds this project\'s public storage URLs');
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkFunctions(cloud: SupabaseCloudClient): Promise<void> {
  head('Edge functions (the eszip path)');
  let functions;
  try {
    functions = await cloud.listFunctions();
  } catch (error) {
    bad(`cannot list functions: ${reason(error)}`);
    return;
  }
  if (functions.length === 0) {
    info('this project has no edge functions');
    return;
  }
  ok(`${functions.length} function(s)`);

  let broken = 0;
  for (const fn of functions) {
    try {
      const body = await cloud.getFunctionBody(fn.slug);
      let source = body.source;
      let flattened = '';
      if (body.otherFiles.length > 0) {
        try {
          const flat = await bundleImportedGraph(body.modules, body.entry);
          source = flat.code;
          flattened = `inlined ${body.otherFiles.length} file(s)`;
        } catch (error) {
          flattened = `INLINE FAILED: ${reason(error)}`;
        }
      }
      const port = portDenoEdgeFunction(source);
      const flags = [
        `${source.length} chars`,
        flattened,
        body.otherFiles.length > 0 ? `files: ${body.otherFiles.join(', ')}` : 'single file',
        port.unresolved.length > 0 ? `imports this runtime cannot resolve: ${port.unresolved.join(', ')}` : 'imports resolve',
        fn.verifyJwt ? 'verify_jwt was on' : '',
      ].filter(Boolean);

      if (hasNul(source) || hasNul(port.code)) {
        broken++;
        bad(`${fn.slug}: STILL HOLDS NUL BYTES — this is the 22021 failure`);
      } else if (port.unresolved.length > 0) {
        warn(`${fn.slug}: imports disabled · ${flags.join(' · ')}`);
      } else {
        ok(`${fn.slug}: ${flags.join(' · ')}`);
      }
      if (port.changes.length > 0) info(`rewritten: ${port.changes.join('; ')}`);
    } catch (error) {
      broken++;
      bad(`${fn.slug}: ${reason(error)}`);
    }
  }
  if (broken > 0) bad(`${broken} function(s) would fail to import`);
}

/** The raw bytes, so a body this reader cannot parse can still be identified. */
async function describeRawBody(cloud: SupabaseCloudClient, slug: string): Promise<void> {
  const anyCloud = cloud as unknown as {
    managementRequest(path: string, cap: number): Promise<Response>;
    options: { ref: string };
  };
  try {
    const response = await anyCloud.managementRequest(
      `/v1/projects/${anyCloud.options.ref}/functions/${encodeURIComponent(slug)}/body`,
      8 * 1024 * 1024
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const magic = bytes.toString('latin1', 0, 8).replace(/[^\x20-\x7e]/g, '.');
    info(`${slug}: ${bytes.length} bytes · magic "${magic}" · eszip=${looksLikeEszip(bytes)}`);
    if (looksLikeEszip(bytes)) {
      const modules = parseEszip(bytes);
      info(`  ${modules.length} module(s): ${modules.map(m => m.specifier).slice(0, 8).join(', ')}`);
      info(`  entry: ${pickEntryModule(modules)?.specifier ?? 'none (all remote)'}`);
    }
  } catch (error) {
    bad(`${slug}: raw read failed: ${reason(error)}`);
  }
}

async function checkSecrets(cloud: SupabaseCloudClient): Promise<void> {
  head('Project secrets');
  try {
    const secrets = await cloud.listSecrets();
    const managed = secrets.filter(s => s.name.startsWith('SUPABASE_'));
    ok(`${secrets.length} secret(s); ${managed.length} SUPABASE_* would be skipped as source-scoped`);
    info(secrets.map(s => `${s.name} (${s.value.length} chars)`).join(', '));
  } catch (error) {
    bad(`cannot list secrets: ${reason(error)}`);
  }
}

async function checkStorageBytes(cloud: SupabaseCloudClient, bucket: string, key: string): Promise<void> {
  head('Storage object download');
  try {
    const { body, contentType } = await cloud.downloadObject(bucket, key, 25 * 1024 * 1024);
    ok(`${bucket}/${key}: ${body.length} bytes · ${contentType ?? 'no content-type'}`);
  } catch (error) {
    bad(`${bucket}/${key}: ${reason(error)}`);
  }
}

async function main(): Promise<void> {
  const values = readEnvFile(ENV_FILE);
  const conn = values.SUPABASE_CONN;
  if (!conn) fail('SUPABASE_CONN is empty in .supabase-live.env');

  const ref = parseSupabaseProjectRef(conn);
  console.log(`\nSupabase live check · project ref ${ref ?? '(not a Supabase URI)'}`);
  if (!ref) fail('the connection string does not name a Supabase project ref, so the APIs cannot be reached');

  await checkDatabase(conn);

  const cloud = new SupabaseCloudClient(new OutboundHttpClient(), {
    ref,
    managementToken: values.SUPABASE_PAT || undefined,
    serviceRoleKey: values.SUPABASE_SERVICE_ROLE_KEY || undefined,
  });

  if (!cloud.hasManagementToken) {
    head('Edge functions + secrets');
    warn('no SUPABASE_PAT: both sections skipped, exactly as the import would skip them');
  } else {
    await checkFunctions(cloud);
    head('Raw function bodies');
    const functions = await cloud.listFunctions().catch(() => []);
    for (const fn of functions.slice(0, 3)) await describeRawBody(cloud, fn.slug);
    await checkSecrets(cloud);
  }

  if (!cloud.hasServiceRoleKey) {
    head('Storage bytes');
    warn('no SUPABASE_SERVICE_ROLE_KEY: buckets would be created empty');
  } else if (values.SUPABASE_TEST_OBJECT) {
    const [bucket, ...rest] = values.SUPABASE_TEST_OBJECT.split('/');
    await checkStorageBytes(cloud, bucket, rest.join('/'));
  }

  console.log('\nDone. Nothing was written, here or there.\n');
}

main().catch(error => fail(reason(error)));
