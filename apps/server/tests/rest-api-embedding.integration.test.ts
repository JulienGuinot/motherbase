import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { invalidateCatalog } from '../services/rest-api/catalog';

/**
 * Relational embedding, against a live Postgres.
 *
 * The whole point of compiling an embed into a correlated LATERAL subquery of
 * the SAME statement is that it inherits the caller's transaction and role, so
 * the child table's own policies filter the embedded rows with no extra code.
 * `does not leak an embedded row hidden by RLS into a visible parent` is the
 * test that proves it, and it is the one that must never be weakened: if it
 * fails, every embed on the deployment is a data leak.
 *
 * The fixture is deliberately awkward in the two ways real schemas are:
 *   - `emb_post` has TWO foreign keys to `emb_author` (author and editor), so
 *     an unhinted embed is ambiguous and must be refused, not guessed.
 *   - `emb_profile.author_id` is UNIQUE, so the inbound edge from `emb_author`
 *     is to-one and must serialise as an object, while `emb_comment` is to-many
 *     and must serialise as an array.
 */

const pool = new RlsPool();
const svc = new RestApiService({
  prisma,
  RlsPool: pool,
  RealtimeBroadcastService: {
    broadcast: async () => {},
    captureDeleteAudience: async () => ({ mode: 'disabled' as const }),
  },
  RealtimeOutboxService: { enqueue: async () => {} },
} as any);

/** Anonymous caller. The fixture grants anon SELECT on everything but comments. */
const ANON = undefined;
const U1 = { id: 'u1', role: 'USER' };

async function get(model: string, query: Record<string, unknown>, user: any = ANON): Promise<any[]> {
  return svc.handleGet(model, query, user);
}

beforeAll(async () => {
  for (const table of ['emb_comment', 'emb_profile', 'emb_post', 'emb_author', 'emb_private']) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  await prisma.$executeRawUnsafe(`CREATE TABLE emb_author (id text PRIMARY KEY, name text)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE emb_post (
      id        text PRIMARY KEY,
      title     text,
      author_id text REFERENCES emb_author(id),
      editor_id text REFERENCES emb_author(id)
    )
  `);
  // UNIQUE on the FK column is what makes this inbound edge to-one.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE emb_profile (
      id        text PRIMARY KEY,
      author_id text UNIQUE REFERENCES emb_author(id),
      bio       text
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE emb_comment (
      id      text PRIMARY KEY,
      post_id text REFERENCES emb_post(id),
      body    text,
      owner   text,
      -- A masked column name, so the recursive maskRow can be proven to reach
      -- inside an embedded payload and not only the top-level row.
      "secretCode" text
    )
  `);
  // A table with RLS switched OFF, used to prove the relrowsecurity gate is
  // applied to an embed target and not only to the table named in the URL.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE emb_private (id text PRIMARY KEY, post_id text REFERENCES emb_post(id), secret text)
  `);

  for (const table of ['emb_author', 'emb_post', 'emb_profile', 'emb_comment']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO anon, authenticated`);
  }
  await prisma.$executeRawUnsafe(`GRANT SELECT ON emb_private TO anon, authenticated`);

  for (const table of ['emb_author', 'emb_post', 'emb_profile']) {
    await prisma.$executeRawUnsafe(
      `CREATE POLICY open_all ON ${table} FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)`
    );
  }
  // Comments are owner scoped. This is the policy the leak test leans on.
  await prisma.$executeRawUnsafe(
    `CREATE POLICY owner_only ON emb_comment FOR SELECT TO authenticated USING (auth.uid() = owner)`
  );
  await prisma.$executeRawUnsafe(`CREATE POLICY anon_none ON emb_comment FOR SELECT TO anon USING (false)`);

  await prisma.$executeRawUnsafe(`INSERT INTO emb_author VALUES ('a1','Ada'),('a2','Grace')`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO emb_post VALUES
      ('p1','First','a1','a2'),
      ('p2','Second','a2','a1'),
      ('p3','Orphan',NULL,NULL),
      ('p4','Fourth','a1',NULL)
  `);
  await prisma.$executeRawUnsafe(`INSERT INTO emb_profile VALUES ('pr1','a1','writes things')`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO emb_comment VALUES
      ('c1','p1','mine',   'u1','shh-1'),
      ('c2','p1','not mine','u2','shh-2'),
      ('c3','p2','also mine','u1','shh-3')
  `);
  await prisma.$executeRawUnsafe(`INSERT INTO emb_private VALUES ('s1','p1','classified')`);

  invalidateCatalog();
});

afterAll(async () => {
  for (const table of ['emb_comment', 'emb_profile', 'emb_post', 'emb_author', 'emb_private']) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  invalidateCatalog();
  await pool.end();
});

// ── The security property ────────────────────────────────────────────────────

describe('embedding under row-level security', () => {
  it('does not leak an embedded row hidden by RLS into a visible parent', async () => {
    // p1 has two comments: c1 belongs to u1, c2 belongs to u2. u1 can read the
    // post (open policy) but only its own comment (owner_only policy). If the
    // embed ran outside the caller's transaction or under another role, c2 would
    // appear here, and that is exactly the leak this asserts against.
    const rows = await get('emb_post', { select: 'id,emb_comment(id,body,owner)', id: 'eq.p1' }, U1);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('p1');
    expect(rows[0].emb_comment.map((row: any) => row.id)).toEqual(['c1']);
    expect(JSON.stringify(rows[0])).not.toContain('not mine');
    expect(JSON.stringify(rows[0])).not.toContain('u2');
  });

  it('strips a sensitive column from inside an embedded payload', async () => {
    // maskRow is applied to the parent row, and it recurses, so a secret nested
    // one level down in the json_agg payload is stripped as well.
    const rows = await get('emb_post', { select: 'id,emb_comment(id,secretCode)', id: 'eq.p1' }, U1);
    expect(rows[0].emb_comment).toEqual([{ id: 'c1' }]);
    expect(JSON.stringify(rows)).not.toContain('shh');
  });

  it('returns an empty embed rather than hiding the parent when anon may read none', async () => {
    const rows = await get('emb_post', { select: 'id,emb_comment(id)', id: 'eq.p1' }, ANON);
    expect(rows).toEqual([{ id: 'p1', emb_comment: [] }]);
  });

  it('refuses to embed a table that has row-level security disabled', async () => {
    await expect(get('emb_post', { select: 'id,emb_private(id,secret)' }, U1)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses to embed a table the REST surface blocks by name', async () => {
    // `app_settings` is on the defence-in-depth block list. There is no FK to it
    // here, so the relationship lookup refuses first; either refusal is correct,
    // what matters is that no such embed compiles.
    await expect(get('emb_post', { select: 'id,app_settings(id)' }, U1)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

// ── Shape parity with PostgREST ──────────────────────────────────────────────

describe('embedded resource shape', () => {
  it('embeds a to-one parent as an object', async () => {
    const rows = await get('emb_post', { select: 'id,emb_author!emb_post_author_id_fkey(*)', order: 'id.asc' });
    expect(rows[0].emb_author).toMatchObject({ id: 'a1', name: 'Ada' });
    expect(Array.isArray(rows[0].emb_author)).toBe(false);
  });

  it('embeds a to-many child as an array', async () => {
    const rows = await get('emb_author', { select: 'id,emb_post!author_id(id)', order: 'id.asc' }, U1);
    expect(Array.isArray(rows[0].emb_post)).toBe(true);
    expect(rows[0].emb_post.map((row: any) => row.id).sort()).toEqual(['p1', 'p4']);
  });

  it('embeds a unique-constrained child as an object, not an array', async () => {
    const rows = await get('emb_author', { select: 'id,emb_profile(bio)', order: 'id.asc' });
    expect(rows[0].emb_profile).toEqual({ bio: 'writes things' });
    // Grace has no profile, so a to-one embed is null, never [].
    expect(rows[1].emb_profile).toBeNull();
  });

  it('renders a missing to-many embed as an empty array', async () => {
    const rows = await get('emb_post', { select: 'id,emb_comment(id)', id: 'eq.p3' }, U1);
    expect(rows).toEqual([{ id: 'p3', emb_comment: [] }]);
  });

  it('honours an alias on the embedded resource', async () => {
    const rows = await get('emb_post', { select: 'id,writer:emb_author!editor_id(name)', id: 'eq.p1' });
    expect(rows[0]).toEqual({ id: 'p1', writer: { name: 'Grace' } });
  });

  it('projects a subset of the embedded columns only', async () => {
    const rows = await get('emb_post', { select: 'id,emb_comment(body)', id: 'eq.p1' }, U1);
    expect(rows[0].emb_comment).toEqual([{ body: 'mine' }]);
  });

  it('nests embeds through two levels', async () => {
    const rows = await get(
      'emb_author',
      { select: 'name,emb_post!author_id(title,emb_comment(id))', 'emb_post.order': 'id.asc', id: 'eq.a1' },
      U1,
    );
    expect(rows[0].name).toBe('Ada');
    expect(rows[0].emb_post).toEqual([
      { title: 'First', emb_comment: [{ id: 'c1' }] },
      { title: 'Fourth', emb_comment: [] },
    ]);
  });
});

// ── Modifiers scoped to an embed ─────────────────────────────────────────────

describe('embedded filters, order and limit', () => {
  it('applies a filter scoped to the embedded resource', async () => {
    const rows = await get(
      'emb_author',
      { select: 'id,emb_post!author_id(id,title)', 'emb_post.title': 'eq.Second', order: 'id.asc' },
      U1,
    );
    expect(rows.find(row => row.id === 'a1')!.emb_post).toEqual([]);
    expect(rows.find(row => row.id === 'a2')!.emb_post).toEqual([{ id: 'p2', title: 'Second' }]);
  });

  it('orders and limits the embedded resource', async () => {
    const rows = await get(
      'emb_author',
      { select: 'id,emb_post!author_id(id)', 'emb_post.order': 'id.desc', 'emb_post.limit': '1', id: 'eq.a1' },
      U1,
    );
    expect(rows[0].emb_post).toEqual([{ id: 'p4' }]);
  });

  it('routes an embedded parameter by alias when the embed is aliased', async () => {
    const rows = await get(
      'emb_author',
      { select: 'id,posts:emb_post!author_id(id)', 'posts.order': 'id.asc', 'posts.limit': '1', id: 'eq.a1' },
      U1,
    );
    expect(rows[0].posts).toEqual([{ id: 'p1' }]);
  });

  it('drops parents with no matching child for an !inner embed', async () => {
    const rows = await get('emb_post', { select: 'id,emb_comment!inner(id)', order: 'id.asc' }, U1);
    // p3 has no comments and c2 (on p1) is invisible to u1, so both p1 and p2
    // survive on their own comment and p3 disappears.
    expect(rows.map(row => row.id)).toEqual(['p1', 'p2']);
  });

  it('drops parents whose only children are hidden by RLS for an !inner embed', async () => {
    // anon may read no comment at all, so every parent is filtered out. This is
    // the same property as the leak test, seen through the join type.
    const rows = await get('emb_post', { select: 'id,emb_comment!inner(id)' }, ANON);
    expect(rows).toEqual([]);
  });

  it('counts the embedded rows the caller may actually see', async () => {
    const rows = await get('emb_post', { select: 'id,emb_comment(count)', order: 'id.asc' }, U1);
    expect(rows.map(row => ({ id: row.id, count: row.emb_comment[0].count }))).toEqual([
      { id: 'p1', count: 1 },
      { id: 'p2', count: 1 },
      { id: 'p3', count: 0 },
      { id: 'p4', count: 0 },
    ]);
  });
});

// ── Relationship resolution ──────────────────────────────────────────────────

describe('relationship resolution', () => {
  it('refuses an ambiguous relationship with PGRST201 and lists the candidates', async () => {
    // emb_post -> emb_author exists twice (author_id and editor_id).
    await expect(get('emb_post', { select: 'id,emb_author(*)' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PGRST201',
    });
    await expect(get('emb_post', { select: 'id,emb_author(*)' })).rejects.toThrow(/author_id/);
    await expect(get('emb_post', { select: 'id,emb_author(*)' })).rejects.toThrow(/editor_id/);
  });

  it('accepts a constraint name as the disambiguating hint', async () => {
    const rows = await get('emb_post', { select: 'id,emb_author!emb_post_editor_id_fkey(name)', id: 'eq.p1' });
    expect(rows[0].emb_author).toEqual({ name: 'Grace' });
  });

  it('accepts a column name as the disambiguating hint', async () => {
    const rows = await get('emb_post', { select: 'id,emb_author!author_id(name)', id: 'eq.p1' });
    expect(rows[0].emb_author).toEqual({ name: 'Ada' });
  });

  it('reports PGRST200 when no relationship exists', async () => {
    await expect(get('emb_comment', { select: 'id,emb_profile(bio)' }, U1)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PGRST200',
    });
  });

  it('validates embedded column names against the embedded table', async () => {
    await expect(get('emb_post', { select: 'id,emb_comment(nope)' }, U1)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PGRST204',
    });
  });

  it('keeps parameter numbering contiguous across parent and embedded filters', async () => {
    // Three bound values across two scopes. A numbering bug here would either
    // error or, worse, apply a parent value to the child predicate.
    const rows = await get(
      'emb_author',
      {
        select: 'id,emb_post!author_id(id,title)',
        name: 'eq.Ada',
        'emb_post.title': 'eq.First',
        'emb_post.id': 'eq.p1',
      },
      U1,
    );
    expect(rows).toEqual([{ id: 'a1', emb_post: [{ id: 'p1', title: 'First' }] }]);
  });
});
