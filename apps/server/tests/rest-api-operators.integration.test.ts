import { parsePrefer } from '../services/rest-api/http-semantics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { RlsPool } from '../lib/rls-pool';
import { RestApiService } from '../services/rest-api/rest-api.service';
import { invalidateCatalog } from '../services/rest-api/catalog';

const RETURN_ROWS = { prefer: parsePrefer('return=representation') };

/**
 * Contract suite for the full PostgREST operator set.
 *
 * Every case goes through the real service: parser, compiler, `RlsPool` and a
 * live Postgres. The unit suites prove the SQL text; this one proves Postgres
 * accepts that SQL and returns what PostgREST would return. An operator that
 * compiles but is rejected by the planner (a missing cast on a polymorphic
 * `anyarray`/`anyrange` signature, say) fails here and nowhere else.
 *
 * The fixture keeps a NULL row on purpose: SQL three-valued logic is where a
 * hand-rolled dialect usually diverges from PostgREST.
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

/** Anonymous caller. The fixture policy grants anon full SELECT. */
const ANON = undefined;

async function ids(query: Record<string, unknown>): Promise<string[]> {
  const rows = await svc.handleGet('pgrst_ops', { order: 'id.asc', ...query }, ANON);
  return rows.map((row: any) => row.id);
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS pgrst_ops CASCADE`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE pgrst_ops (
      id     text PRIMARY KEY,
      name   text,
      label  varchar(255),
      score  integer,
      flag   boolean,
      tags   text[],
      meta   jsonb,
      span   int4range,
      body   text,
      "secretCode" text
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE pgrst_ops ENABLE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON pgrst_ops TO anon, authenticated`);
  await prisma.$executeRawUnsafe(`CREATE POLICY open_all ON pgrst_ops FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO pgrst_ops (id, name, label, score, flag, tags, meta, span, body, "secretCode") VALUES
      ('w1', 'john doe', 'first',  10,  true,  '{a,b}', '{"city":"paris","n":1,"list":["x","y"]}'::jsonb, '[1,10)',  'the quick brown fox', 'shh'),
      ('w2', 'jane roe', 'second', 20,  false, '{b,c}', '{"city":"lyon","n":2}'::jsonb,                   '[20,30)', 'lazy dogs sleeping', 'shh'),
      ('w3', NULL,       NULL,     NULL, NULL, '{}',    NULL,                                             NULL,      NULL, NULL)
  `);
  // The table was created outside `execDdl`, so drop the cached snapshot by hand.
  invalidateCatalog();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS pgrst_ops CASCADE`);
  invalidateCatalog();
  await pool.end();
});

describe('comparison operators', () => {
  it('eq', async () => expect(await ids({ name: 'eq.john doe' })).toEqual(['w1']));
  it('neq excludes NULL, as SQL does', async () => expect(await ids({ score: 'neq.10' })).toEqual(['w2']));
  it('gt', async () => expect(await ids({ score: 'gt.10' })).toEqual(['w2']));
  it('gte', async () => expect(await ids({ score: 'gte.10' })).toEqual(['w1', 'w2']));
  it('lt', async () => expect(await ids({ score: 'lt.20' })).toEqual(['w1']));
  it('lte', async () => expect(await ids({ score: 'lte.20' })).toEqual(['w1', 'w2']));
  it('eq against a varchar column', async () => expect(await ids({ label: 'eq.first' })).toEqual(['w1']));
  it('isdistinct treats NULL as a value', async () =>
    expect(await ids({ score: 'isdistinct.10' })).toEqual(['w2', 'w3']));
});

describe('pattern and regex operators', () => {
  it('like with * wildcards', async () => expect(await ids({ name: 'like.*john*' })).toEqual(['w1']));
  it('like with explicit %', async () => expect(await ids({ name: 'like.john%' })).toEqual(['w1']));
  it('ilike is case-insensitive', async () => expect(await ids({ name: 'ilike.*JOHN*' })).toEqual(['w1']));
  it('like is case-sensitive', async () => expect(await ids({ name: 'like.*JOHN*' })).toEqual([]));
  it('match', async () => expect(await ids({ name: 'match.^jane' })).toEqual(['w2']));
  it('imatch', async () => expect(await ids({ name: 'imatch.^JANE' })).toEqual(['w2']));
});

describe('in and is', () => {
  it('in', async () => expect(await ids({ id: 'in.(w1,w3)' })).toEqual(['w1', 'w3']));
  it('in with a quoted comma keeps one element', async () =>
    expect(await ids({ name: 'in.("john doe",nobody)' })).toEqual(['w1']));
  it('in with an empty list matches nothing', async () => expect(await ids({ id: 'in.()' })).toEqual([]));
  it('is.null', async () => expect(await ids({ score: 'is.null' })).toEqual(['w3']));
  it('is.not.null', async () => expect(await ids({ score: 'is.not.null' })).toEqual(['w1', 'w2']));
  it('is.true', async () => expect(await ids({ flag: 'is.true' })).toEqual(['w1']));
  it('is.false', async () => expect(await ids({ flag: 'is.false' })).toEqual(['w2']));
  it('is.unknown matches the NULL boolean', async () => expect(await ids({ flag: 'is.unknown' })).toEqual(['w3']));
});

describe('full-text search', () => {
  it('fts with a configuration', async () => expect(await ids({ body: 'fts(english).quick' })).toEqual(['w1']));
  it('fts without a configuration', async () => expect(await ids({ body: 'fts.quick' })).toEqual(['w1']));
  it('plfts takes a plain phrase', async () =>
    expect(await ids({ body: 'plfts(english).quick brown' })).toEqual(['w1']));
  it('phfts matches an ordered phrase', async () =>
    expect(await ids({ body: 'phfts(english).brown fox' })).toEqual(['w1']));
  it('phfts does not match a reversed phrase', async () =>
    expect(await ids({ body: 'phfts(english).fox brown' })).toEqual([]));
  it('wfts takes web-search syntax', async () =>
    expect(await ids({ body: 'wfts(english).dogs' })).toEqual(['w2']));
});

describe('array operators', () => {
  it('cs contains', async () => expect(await ids({ tags: 'cs.{a}' })).toEqual(['w1']));
  it('cs with several elements', async () => expect(await ids({ tags: 'cs.{a,b}' })).toEqual(['w1']));
  it('cd contained by, including the empty array', async () =>
    expect(await ids({ tags: 'cd.{a,b,c}' })).toEqual(['w1', 'w2', 'w3']));
  it('ov overlaps', async () => expect(await ids({ tags: 'ov.{c}' })).toEqual(['w2']));
  it('cs with an empty array matches every array', async () =>
    expect(await ids({ tags: 'cs.{}' })).toEqual(['w1', 'w2', 'w3']));
});

describe('range operators', () => {
  it('sl strictly left of', async () => expect(await ids({ span: 'sl.[15,18)' })).toEqual(['w1']));
  it('sr strictly right of', async () => expect(await ids({ span: 'sr.[15,18)' })).toEqual(['w2']));
  it('nxr does not extend to the right of', async () => expect(await ids({ span: 'nxr.[1,10)' })).toEqual(['w1']));
  it('nxl does not extend to the left of', async () => expect(await ids({ span: 'nxl.[20,30)' })).toEqual(['w2']));
  it('adj is adjacent to', async () => expect(await ids({ span: 'adj.[10,15)' })).toEqual(['w1']));
  it('cs on a range', async () => expect(await ids({ span: 'cs.[2,3)' })).toEqual(['w1']));
});

describe('the any and all modifiers', () => {
  it('like(any)', async () => expect(await ids({ name: 'like(any).{*john*,*jane*}' })).toEqual(['w1', 'w2']));
  it('like(all)', async () => expect(await ids({ name: 'like(all).{*o*,*j*}' })).toEqual(['w1', 'w2']));
  it('eq(any) on an integer column', async () => expect(await ids({ score: 'eq(any).{10,99}' })).toEqual(['w1']));
  it('gte(all) on an integer column', async () =>
    expect(await ids({ score: 'gte(all).{5,10}' })).toEqual(['w1', 'w2']));
});

describe('not, or and and', () => {
  it('not.like drops NULL rows, as NOT NULL is not TRUE', async () =>
    expect(await ids({ name: 'not.like.*john*' })).toEqual(['w2']));
  it('not.in', async () => expect(await ids({ id: 'not.in.(w1,w2)' })).toEqual(['w3']));
  it('or', async () => expect(await ids({ or: '(score.eq.10,score.eq.20)' })).toEqual(['w1', 'w2']));
  it('and', async () => expect(await ids({ and: '(score.gte.10,score.lte.10)' })).toEqual(['w1']));
  it('not.or', async () => expect(await ids({ 'not.or': '(id.eq.w1,id.eq.w2)' })).toEqual(['w3']));
  it('the nested or/and/is.null tree', async () =>
    expect(await ids({ or: '(id.eq.w1,and(score.gt.15,flag.is.false))' })).toEqual(['w1', 'w2']));
  it('two query parameters are ANDed', async () =>
    expect(await ids({ score: 'gte.10', flag: 'is.true' })).toEqual(['w1']));
});

describe('jsonb path operands', () => {
  it('->> compares as text', async () => expect(await ids({ 'meta->>city': 'eq.paris' })).toEqual(['w1']));
  it('->> supports like', async () => expect(await ids({ 'meta->>city': 'like.*yon' })).toEqual(['w2']));
  it('->> supports in', async () =>
    expect(await ids({ 'meta->>city': 'in.(paris,berlin)' })).toEqual(['w1']));
  it('-> compares as jsonb with cs', async () =>
    expect(await ids({ 'meta->list': 'cs.["x"]' })).toEqual(['w1']));
  it('an array index in the path', async () =>
    expect(await ids({ 'meta->list->>0': 'eq.x' })).toEqual(['w1']));
  it('a numeric jsonb field compared as text', async () =>
    expect(await ids({ 'meta->>n': 'eq.2' })).toEqual(['w2']));
});

describe('projection, ordering and pagination', () => {
  it('projects only the requested columns', async () => {
    const rows = await svc.handleGet('pgrst_ops', { select: 'id,name', id: 'eq.w1' }, ANON);
    expect(rows).toEqual([{ id: 'w1', name: 'john doe' }]);
  });

  it('renames a column through an alias', async () => {
    const rows = await svc.handleGet('pgrst_ops', { select: 'id,who:name', id: 'eq.w1' }, ANON);
    expect(rows).toEqual([{ id: 'w1', who: 'john doe' }]);
  });

  it('projects a json path under its last segment', async () => {
    const rows = await svc.handleGet('pgrst_ops', { select: 'meta->>city', id: 'eq.w2' }, ANON);
    expect(rows).toEqual([{ city: 'lyon' }]);
  });

  it('orders descending with an explicit null placement', async () => {
    expect(await ids({ order: 'score.desc.nullslast' })).toEqual(['w2', 'w1', 'w3']);
    expect(await ids({ order: 'score.desc.nullsfirst' })).toEqual(['w3', 'w2', 'w1']);
  });

  it('orders on a json path', async () => {
    const rows = await svc.handleGet('pgrst_ops', { order: 'meta->>city.asc', 'meta': 'is.not.null' }, ANON);
    expect(rows.map((row: any) => row.id)).toEqual(['w2', 'w1']);
  });

  it('applies limit and offset', async () => {
    expect(await ids({ limit: '2' })).toEqual(['w1', 'w2']);
    expect(await ids({ limit: '2', offset: '1' })).toEqual(['w2', 'w3']);
  });
});

describe('safety', () => {
  it('masks sensitive columns out of every returned row', async () => {
    // `secretCode` is on the SENSITIVE_FIELDS list, so maskRow must strip it even
    // though it is a perfectly ordinary user column in `public`.
    const rows = await svc.handleGet('pgrst_ops', { id: 'eq.w1' }, ANON);
    expect(rows[0]).not.toHaveProperty('secretcode');
    expect(rows[0]).not.toHaveProperty('secretCode');
    expect(rows[0].id).toBe('w1');
  });

  it('rejects a filter on a column that does not exist', async () => {
    await expect(svc.handleGet('pgrst_ops', { nope: 'eq.1' }, ANON)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a malformed filter with PGRST100 rather than guessing', async () => {
    await expect(svc.handleGet('pgrst_ops', { id: 'w1' }, ANON)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PGRST100',
    });
  });

  it('does not let a quoted value break out of an in list', async () => {
    // The value below would end the statement if it were spliced rather than bound.
    await expect(ids({ name: `in.("'); DROP TABLE pgrst_ops; --",w9)` })).resolves.toEqual([]);
    const [{ count }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::int AS count FROM pgrst_ops`
    );
    expect(Number(count)).toBe(3);
  });
});

describe('writes through the compiled filter', () => {
  it('updates only the rows the filter selects, and reports 404 when none match', async () => {
    const updated = await svc.handlePatch(
      'pgrst_ops',
      { or: '(id.eq.w1,id.eq.w2)', score: 'gt.15' },
      { label: 'patched' },
      { id: 'u1', role: 'USER' }, RETURN_ROWS
    );
    expect(updated.map((row: any) => row.id)).toEqual(['w2']);

    await expect(
      svc.handlePatch('pgrst_ops', { id: 'eq.nobody' }, { label: 'x' }, { id: 'u1', role: 'USER' }, RETURN_ROWS)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an unfiltered delete from a non-admin', async () => {
    await expect(svc.handleDelete('pgrst_ops', {}, { id: 'u1', role: 'USER' }, RETURN_ROWS)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('deletes exactly the filtered rows', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO pgrst_ops (id, score) VALUES ('w9', 5)`);
    const deleted = await svc.handleDelete('pgrst_ops', { id: 'in.(w9)' }, { id: 'u1', role: 'USER' }, RETURN_ROWS);
    expect(deleted.map((row: any) => row.id)).toEqual(['w9']);
    expect(await ids({})).toEqual(['w1', 'w2', 'w3']);
  });
});

describe('operator/type mismatches', () => {
  it('reports an operator that does not apply to the column type as a 400, not a 500', async () => {
    // `cs` needs an array, range or jsonb operand. Applied to a scalar text
    // column Postgres raises 42883; that is the caller's mistake, so the REST
    // layer must not turn it into a server error.
    await expect(svc.handleGet('pgrst_ops', { name: 'cs.{a}' }, ANON)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PGRST100',
    });
  });
});
