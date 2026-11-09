import { describe, it, expect, vi } from 'vitest';
import { ImportService } from '../services/admin/import.service';

// ── ImportService: the three sections that live outside Postgres ─────────────
//
// Storage objects, edge functions and secrets are held by Supabase, not by the
// source database, so each needs its own credential. What matters here is that
// a missing credential DEGRADES the section (a note, and the rest of the import
// still lands) instead of failing it, and that when the credential is there the
// section actually writes into this project.

const POOLER = 'postgresql://postgres.abcdefghijklmnop:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres';
const PLAIN_PG = 'postgresql://u:p@db.example.com:5432/app';

interface Scenario {
  buckets?: any[];
  objects?: any[];
  http?: (url: string, options: any) => { status?: number; body: string };
  /** Columns the storage URL rewrite should find in the target's public schema. */
  urlColumns?: { table_name: string; column_name: string; data_type: string }[];
}

function makeService(scenario: Scenario = {}) {
  const uploads: any[] = [];
  const createdBuckets: any[] = [];
  const createdFunctions: any[] = [];
  const deployedFunctions: any[] = [];
  const setSecrets: any[] = [];
  const urlRewrites: { sql: string; from: string; to: string }[] = [];

  const di = {
    prisma: {
      $queryRawUnsafe: vi.fn(async () => scenario.urlColumns ?? []),
      $executeRawUnsafe: vi.fn(async (sql: string, from: string, to: string) => {
        urlRewrites.push({ sql, from, to });
        return 1;
      }),
      user: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'u1' })) },
      bucket: { findUnique: vi.fn(async () => null) },
      edgeFunction: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => { createdFunctions.push(data); return data; }),
      },
    },
    BucketService: { create: vi.fn(async (input: any) => { createdBuckets.push(input); return input; }) },
    StorageService: {
      adminUpload: vi.fn(async (input: any) => { uploads.push(input); return input; }),
      publicObjectUrl: (bucket: string, key: string) => `http://localhost:5001/${bucket}/${key}`,
    },
    EdgeFunctionService: {
      create: vi.fn(async (input: any) => {
        // Stand in for the real deploy check, failing the way the sidecar
        // does when an import cannot be loaded.
        if (input.code.includes('esm.sh')) throw new Error('Module not found "https://esm.sh/@supabase/supabase-js@2"');
        deployedFunctions.push(input);
        return input;
      }),
    },
    SecretsService: { set: vi.fn(async (name: string, value: string) => { setSecrets.push([name, value]); }) },
    StoragePolicyService: { enabled: vi.fn(async () => false) },
    OutboundHttpClient: {
      request: vi.fn(async (url: string, options: any = {}) => {
        const hit = scenario.http?.(url, options) ?? { status: 404, body: '' };
        return new Response(hit.body, { status: hit.status ?? 200 });
      }),
    },
  } as any;

  const svc = new ImportService(di);
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM\n         storage.buckets') || sql.includes('FROM storage.buckets')) {
      return { rows: scenario.buckets ?? [] };
    }
    if (sql.includes('FROM storage.objects')) return { rows: scenario.objects ?? [] };
    return { rows: [] };
  });
  vi.spyOn(svc as any, 'createClient').mockReturnValue({ query, connect: vi.fn(async () => {}), end: vi.fn(async () => {}) });
  vi.spyOn(svc as any, 'run').mockResolvedValue({ stdout: '', stderr: '' });

  return { svc, di, uploads, createdBuckets, createdFunctions, deployedFunctions, setSecrets, query, urlRewrites };
}

/** Only the credential-gated sections; the pg_dump path has its own suite. */
const SECTIONS_ONLY = { schema: false, data: false, auth: false };

describe('ImportService storage section', () => {
  const buckets = [
    { bucket: 'avatars', is_public: true, file_size_limit: null, objects: 2, bytes: 10 },
    { bucket: 'User Uploads', is_public: false, file_size_limit: '1048576', objects: 0, bytes: 0 },
  ];

  it('creates the buckets even without a service_role key, and says why the files did not move', async () => {
    const { svc, createdBuckets, uploads } = makeService({ buckets });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      include: { ...SECTIONS_ONLY, edgeFunctions: false, secrets: false },
    });

    expect(createdBuckets.map(b => b.slug)).toEqual(['avatars', 'user-uploads']);
    expect(createdBuckets[0].visibility).toBe('public');
    expect(createdBuckets[1].quotaBytes).toBe(BigInt(1048576));
    expect(uploads).toHaveLength(0);
    expect(summary.storage.buckets).toBe(2);
    expect(summary.storage.skipped).toBe(2);
    expect(summary.notes.join(' ')).toMatch(/service_role key/);
    // A section that could not run for want of a credential is not a failure.
    expect(summary.status).toBe('success');
    expect(summary.notes.join(' ')).toMatch(/User Uploads → user-uploads/);
  });

  it('never lets two source buckets share one target bucket', async () => {
    // Both names map to "my-bucket"; sharing it would merge two namespaces and
    // let the second bucket's keys overwrite the first bucket's files.
    const { svc, createdBuckets } = makeService({
      buckets: [
        { bucket: 'my_bucket', is_public: false, file_size_limit: null, objects: 0, bytes: 0 },
        { bucket: 'my-bucket', is_public: false, file_size_limit: null, objects: 0, bytes: 0 },
      ],
    });

    await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      include: { ...SECTIONS_ONLY, edgeFunctions: false, secrets: false },
    });

    expect(createdBuckets.map(b => b.slug)).toEqual(['my-bucket', 'my-bucket-2']);
  });

  it('copies object bytes at the same key when the service_role key is given', async () => {
    const { svc, uploads } = makeService({
      buckets: [buckets[0]],
      objects: [
        { bucket: 'avatars', name: 'user-1/pic.png', mime: 'image/png', size: '5' },
        { bucket: 'avatars', name: 'folder/.emptyFolderPlaceholder', mime: null, size: '0' },
      ],
      http: () => ({ body: 'bytes' }),
    });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      serviceRoleKey: 'service-key',
      include: { ...SECTIONS_ONLY, edgeFunctions: false, secrets: false },
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      bucketSlug: 'avatars',
      objectKey: 'user-1/pic.png',
      mime: 'image/png',
      visibility: 'public',
      upsert: true,
    });
    expect(summary.storage.objects).toBe(1);
    // The folder placeholder is bookkeeping, not a file.
    expect(summary.storage.skipped).toBe(1);
  });

  it('records a failed object and keeps going', async () => {
    const { svc, uploads } = makeService({
      buckets: [buckets[0]],
      objects: [
        { bucket: 'avatars', name: 'gone.png', mime: 'image/png', size: '5' },
        { bucket: 'avatars', name: 'here.png', mime: 'image/png', size: '5' },
      ],
      http: (url: string) => (url.includes('gone.png') ? { status: 404, body: '' } : { body: 'bytes' }),
    });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      serviceRoleKey: 'service-key',
      include: { ...SECTIONS_ONLY, edgeFunctions: false, secrets: false },
    });

    expect(uploads).toHaveLength(1);
    expect(summary.storage.errors).toHaveLength(1);
    expect(summary.storage.errors[0]).toContain('avatars/gone.png');
  });

  // A dumped `profiles.avatar_url` still holds the SOURCE project's URL, so
  // without this the migrated app serves its images out of Supabase until that
  // project is paused, and then not at all.
  it('repoints columns holding the source project storage URLs at this project', async () => {
    const { svc, urlRewrites } = makeService({
      buckets: [buckets[0]],
      objects: [{ bucket: 'avatars', name: 'u1/face.png', mime: 'image/png', size: '5' }],
      http: () => ({ body: 'bytes' }),
      urlColumns: [{ table_name: 'profiles', column_name: 'avatar_url', data_type: 'text' }],
    });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      serviceRoleKey: 'service-key',
      include: { ...SECTIONS_ONLY, edgeFunctions: false, secrets: false },
    });

    expect(urlRewrites.map(r => r.from)).toEqual([
      'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/avatars/',
      '/storage/v1/object/public/avatars/',
    ]);
    expect(urlRewrites[0].to).toBe('http://localhost:5001/avatars/');
    expect(urlRewrites[0].sql).toContain('"public"."profiles"');
    expect(summary.notes.join(' ')).toContain('profiles.avatar_url');
  });
});

describe('ImportService edge function + secret sections', () => {
  const portable = 'Deno.serve(async (req) => new Response("hi"))';
  const blocked = [
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2"',
    'Deno.serve(async (req) => new Response("hi"))',
  ].join('\n');

  function cloud(bodies: Record<string, string>, secrets: { name: string; value: string }[] = []) {
    return (url: string) => {
      if (url.endsWith('/functions')) {
        return { body: JSON.stringify(Object.keys(bodies).map(slug => ({ slug, name: slug }))) };
      }
      if (url.endsWith('/secrets')) return { body: JSON.stringify(secrets) };
      const slug = Object.keys(bodies).find(key => url.includes(`/functions/${key}/body`));
      return slug ? { body: bodies[slug] } : { status: 404, body: '' };
    };
  }

  it('keeps the Supabase slug as the route, so only the base URL changes', async () => {
    // A short slug must NOT be reshaped: /functions/v1/ai becomes /api/edge/ai.
    const { svc, deployedFunctions } = makeService({ http: cloud({ ai: portable }) });

    await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      managementToken: 'sbp_token',
      include: { ...SECTIONS_ONLY, storage: false, secrets: false },
    });

    expect(deployedFunctions[0]).toMatchObject({ name: 'ai', route: 'ai' });
  });

  it('enables a function that passes the deploy check and preserves one that does not', async () => {
    const { svc, deployedFunctions, createdFunctions } = makeService({
      http: cloud({ greet: portable, 'stripe-webhook': blocked }),
    });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      managementToken: 'sbp_token',
      include: { ...SECTIONS_ONLY, storage: false, secrets: false },
    });

    expect(summary.edgeFunctions).toMatchObject({ imported: 2, enabled: 1, needsPorting: 1 });
    expect(deployedFunctions[0].name).toBe('greet');
    // Deno runs the Supabase source as written: nothing is rewritten.
    expect(deployedFunctions[0].code).toBe(portable);

    // The blocked one is stored disabled with its source intact, so nothing
    // about the Supabase project is lost, and the note says why.
    expect(createdFunctions).toHaveLength(1);
    expect(createdFunctions[0]).toMatchObject({ name: 'stripe-webhook', enabled: false });
    expect(createdFunctions[0].code).toContain('esm.sh');
    expect(summary.notes.join(' ')).toMatch(/esm\.sh/);
  });

  it('keeps a verify_jwt:false function callable without auth, and only that one', async () => {
    // A Stripe webhook has no session to send. Imported private, every delivery
    // would answer 401 the moment traffic moved here.
    const http = (url: string) => {
      if (url.endsWith('/functions')) {
        return {
          body: JSON.stringify([
            { slug: 'stripe-webhook', name: 'stripe-webhook', verify_jwt: false },
            { slug: 'greet', name: 'greet', verify_jwt: true },
          ]),
        };
      }
      if (url.endsWith('/secrets')) return { body: '[]' };
      return { body: portable };
    };
    const { svc, deployedFunctions } = makeService({ http });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      managementToken: 'sbp_token',
      include: { ...SECTIONS_ONLY, storage: false, secrets: false },
    });

    const bySlug = Object.fromEntries(deployedFunctions.map(fn => [fn.name, fn]));
    expect(bySlug['stripe-webhook'].isPublic).toBe(true);
    expect(bySlug.greet.isPublic).toBe(false);
    expect(summary.notes.join(' ')).toContain('Imported as Public because verify_jwt was off on Supabase');
    expect(summary.notes.join(' ')).toContain('stripe-webhook');
  });

  it('skips edge functions and secrets, with a note, when no token is given', async () => {
    const { svc, deployedFunctions, setSecrets } = makeService({ http: cloud({ greet: portable }) });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      include: { ...SECTIONS_ONLY, storage: false },
    });

    expect(deployedFunctions).toHaveLength(0);
    expect(setSecrets).toHaveLength(0);
    expect(summary.notes.join(' ')).toMatch(/personal access token/);
    expect(summary.status).toBe('success');
  });

  it('imports project secrets but never the SUPABASE_* ones', async () => {
    const { svc, setSecrets } = makeService({
      http: cloud({}, [
        { name: 'STRIPE_SECRET_KEY', value: 'sk_live_x' },
        { name: 'SUPABASE_URL', value: 'https://old.supabase.co' },
        { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'leaky' },
      ]),
    });

    const summary = await svc.importAll({
      connectionString: POOLER,
      confirm: 'IMPORT',
      managementToken: 'sbp_token',
      include: { ...SECTIONS_ONLY, storage: false, edgeFunctions: false },
    });

    expect(setSecrets).toEqual([['STRIPE_SECRET_KEY', 'sk_live_x']]);
    expect(summary.secrets).toMatchObject({ imported: 1, skipped: 2 });
    expect(summary.notes.join(' ')).toMatch(/point at the source project/);
  });

  it('says so, once, when the source is not a Supabase Cloud project', async () => {
    const { svc } = makeService();

    const summary = await svc.importAll({
      connectionString: PLAIN_PG,
      confirm: 'IMPORT',
      include: SECTIONS_ONLY,
    });

    expect(summary.notes.filter(n => n.includes('project ref'))).toHaveLength(1);
    expect(summary.status).toBe('success');
  });
});
