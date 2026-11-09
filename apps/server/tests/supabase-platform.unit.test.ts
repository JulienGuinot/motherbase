import { describe, it, expect, vi } from 'vitest';
import {
  SupabaseCloudClient,
  describeManagementStatus,
  looksLikeSecretDigest,
  parseSupabaseProjectRef,
  storageUrlRewriteSql,
  supabaseProjectUrl,
  supabaseStorageUrlRewrites,
  toBucketSlug,
} from '../services/admin/supabase-platform';

// ── supabase-platform ────────────────────────────────────────────────────────
// The half of a Supabase project that is NOT in its database. Everything here
// is what the importer would otherwise have to ask the operator to type in.

const POOLER = 'postgresql://postgres.abcdefghijklmnop:pw@aws-1-eu-west-3.pooler.supabase.com:5432/postgres';
const DIRECT = 'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres';

describe('parseSupabaseProjectRef', () => {
  it('reads the ref out of a session pooler username', () => {
    expect(parseSupabaseProjectRef(POOLER)).toBe('abcdefghijklmnop');
  });

  it('reads the ref out of a direct connection host', () => {
    expect(parseSupabaseProjectRef(DIRECT)).toBe('abcdefghijklmnop');
  });

  it('survives a percent-encoded username', () => {
    const encoded = 'postgresql://postgres.abcdefghijklmnop:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
    expect(parseSupabaseProjectRef(encoded)).toBe('abcdefghijklmnop');
  });

  it('returns null for a non-Supabase source rather than guessing', () => {
    expect(parseSupabaseProjectRef('postgresql://u:p@db.example.com:5432/app')).toBeNull();
    expect(parseSupabaseProjectRef('postgres://localhost/postgres')).toBeNull();
    expect(parseSupabaseProjectRef('not-a-url')).toBeNull();
    expect(parseSupabaseProjectRef('')).toBeNull();
  });

  it('builds the project URL from the ref', () => {
    expect(supabaseProjectUrl('abcdefghijklmnop')).toBe('https://abcdefghijklmnop.supabase.co');
  });
});

describe('toBucketSlug', () => {
  it('leaves a already-valid bucket name alone', () => {
    expect(toBucketSlug('post-media')).toBe('post-media');
  });

  it('maps a name this project would refuse', () => {
    // BucketService: ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$
    expect(toBucketSlug('User Uploads')).toBe('user-uploads');
    expect(toBucketSlug('my_bucket')).toBe('my-bucket');
    expect(toBucketSlug('_leading')).toBe('leading');
  });

  it('pads a name below the three-character floor', () => {
    expect(toBucketSlug('cv')).toBe('cv-bucket');
    expect(toBucketSlug('')).toBe('bucket');
  });

  it('never emits a trailing hyphen, which the slug rule refuses', () => {
    expect(toBucketSlug('files!')).toBe('files');
    expect(toBucketSlug('a-'.repeat(60))).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  });
});

/** Minimal OutboundHttpClientLike: records calls, replays queued responses. */
function fakeHttp(responses: Record<string, { status?: number; body: string; contentType?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const request = vi.fn(async (url: string, options: any = {}) => {
    calls.push({ url, headers: options.headers ?? {} });
    const match = Object.keys(responses).find(key => url.includes(key));
    const hit = match ? responses[match] : { status: 404, body: '' };
    const status = hit.status ?? 200;
    return new Response(hit.body, {
      status,
      headers: hit.contentType ? { 'content-type': hit.contentType } : undefined,
    });
  });
  return { client: { request }, calls, request };
}

describe('SupabaseCloudClient', () => {
  const options = { ref: 'abcdefghijklmnop', managementToken: 'sbp_token', serviceRoleKey: 'service-key' };

  it('lists functions from the Management API, bearing the token', async () => {
    const { client, calls } = fakeHttp({
      '/functions': { body: JSON.stringify([{ slug: 'stripe-webhook', name: 'Stripe', verify_jwt: true }]) },
    });
    const cloud = new SupabaseCloudClient(client, options);

    expect(await cloud.listFunctions()).toEqual([
      { slug: 'stripe-webhook', name: 'Stripe', status: undefined, verifyJwt: true },
    ]);
    expect(calls[0].url).toBe('https://api.supabase.com/v1/projects/abcdefghijklmnop/functions');
    expect(calls[0].headers.Authorization).toBe('Bearer sbp_token');
  });

  it('downloads an object with the service_role key on both headers', async () => {
    const { client, calls } = fakeHttp({ '/storage/v1/object/': { body: 'bytes', contentType: 'text/plain' } });
    const cloud = new SupabaseCloudClient(client, options);

    const object = await cloud.downloadObject('avatars', 'user 1/pic.png', 1024);

    expect(object.body.toString()).toBe('bytes');
    expect(object.contentType).toBe('text/plain');
    // Each key segment is encoded separately, so the path separators survive.
    expect(calls[0].url).toBe(
      'https://abcdefghijklmnop.supabase.co/storage/v1/object/avatars/user%201/pic.png'
    );
    expect(calls[0].headers.apikey).toBe('service-key');
  });

  it('refuses to reach the Management API without a token', async () => {
    const { client } = fakeHttp({});
    const cloud = new SupabaseCloudClient(client, { ref: 'abcdefghijklmnop' });
    await expect(cloud.listFunctions()).rejects.toThrow(/personal access token/i);
    await expect(cloud.downloadObject('b', 'k', 10)).rejects.toThrow(/service_role/i);
  });

  it('turns a rejected token into the action that fixes it', async () => {
    const { client } = fakeHttp({ '/secrets': { status: 401, body: '' } });
    const cloud = new SupabaseCloudClient(client, options);
    await expect(cloud.listSecrets()).rejects.toThrow(/account\/tokens/);
    expect(describeManagementStatus(403, '/x')).toMatch(/cannot read this project/);
    expect(describeManagementStatus(429, '/x')).toMatch(/rate-limited/);
  });

  it('never leaks a credential in the status message', () => {
    const message = describeManagementStatus(500, '/v1/projects/abcdefghijklmnop/functions');
    expect(message).not.toContain('sbp_');
    expect(message).not.toContain('service-key');
  });
});

// ── storage URLs in table data ───────────────────────────────────────────────
// `profiles.avatar_url` holds a whole Supabase URL, and the dump carries the
// string across untouched: without this the migrated app keeps serving images
// out of the project it just left.

describe('supabaseStorageUrlRewrites', () => {
  const prefix = (slug: string) => `https://cdn.example.com/${slug}/`;

  it('maps both URL shapes of every bucket onto the target prefix', () => {
    const rewrites = supabaseStorageUrlRewrites(
      'https://abcdefghijklmnop.supabase.co',
      [['avatars', 'avatars']],
      prefix
    );

    expect(rewrites).toEqual([
      {
        from: 'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/avatars/',
        to: 'https://cdn.example.com/avatars/',
      },
      { from: '/storage/v1/object/public/avatars/', to: 'https://cdn.example.com/avatars/' },
    ]);
  });

  it('follows a bucket that had to be renamed to fit the slug rule', () => {
    const [absolute] = supabaseStorageUrlRewrites(
      'https://abcdefghijklmnop.supabase.co/',
      [['My_Bucket', 'my-bucket']],
      prefix
    );
    expect(absolute.from).toBe(
      'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/My_Bucket/'
    );
    expect(absolute.to).toBe('https://cdn.example.com/my-bucket/');
  });

  it('orders the absolute form first, since the relative one is a substring of it', () => {
    const rewrites = supabaseStorageUrlRewrites('https://ref.supabase.co', [['a', 'a']], prefix);
    const applied = rewrites.reduce(
      (url, r) => url.split(r.from).join(r.to),
      'https://ref.supabase.co/storage/v1/object/public/a/u1/face.png'
    );
    expect(applied).toBe('https://cdn.example.com/a/u1/face.png');
  });
});

describe('storageUrlRewriteSql', () => {
  it('rewrites a text column by parameter, never by interpolation', () => {
    expect(storageUrlRewriteSql('profiles', 'avatar_url', 'text')).toBe(
      'UPDATE "public"."profiles" SET "avatar_url" = replace("avatar_url", $1, $2) WHERE position($1 in "avatar_url") > 0'
    );
  });

  it('casts a json column through text and back', () => {
    expect(storageUrlRewriteSql('posts', 'media', 'jsonb')).toBe(
      'UPDATE "public"."posts" SET "media" = replace("media"::text, $1, $2)::jsonb WHERE position($1 in "media"::text) > 0'
    );
  });

  it('doubles a quote in an identifier rather than letting it close the quoting', () => {
    expect(storageUrlRewriteSql('we"ird', 'co"l', 'text')).toContain('"public"."we""ird"');
  });
});

// ── secret values ────────────────────────────────────────────────────────────
// The Management API returns sha256(value), never the value. Storing one gives
// a ported function a credential-shaped string that is not its credential.

describe('looksLikeSecretDigest', () => {
  it('recognises the 64-hex digest Supabase answers with', () => {
    expect(looksLikeSecretDigest('a'.repeat(64))).toBe(true);
    expect(looksLikeSecretDigest('9f2c4e1b'.repeat(8))).toBe(true);
  });

  it('leaves a real value alone, so a control plane that discloses one still imports', () => {
    expect(looksLikeSecretDigest('sk-live-abcdef')).toBe(false);
    expect(looksLikeSecretDigest('A'.repeat(64))).toBe(false); // uppercase: not the digest shape
    expect(looksLikeSecretDigest('a'.repeat(63))).toBe(false);
    expect(looksLikeSecretDigest('')).toBe(false);
  });
});
