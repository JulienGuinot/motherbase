import { describe, expect, it } from 'vitest';
import { parseQuery, type Filter } from '../services/rest-api/postgrest-parser';

/**
 * Grammar suite for the PostgREST dialect parser.
 *
 * These cases assert SYNTAX only: no catalog, no SQL. Anything about column
 * existence or generated SQL belongs in `sql-compiler.unit.test.ts`, and anything
 * about real Postgres behaviour belongs in `rest-api-operators.integration.test.ts`.
 *
 * This file replaces `rest-api-parser.unit.test.ts`, which asserted the shape of
 * the Prisma `where` object that the compiler no longer routes through. Every one
 * of its cases is ported below.
 */

/** The filter tree for a single query parameter. */
function filterOf(query: Record<string, unknown>): Filter | null {
  return parseQuery(query).filter;
}

function cmp(column: string, op: string, value: unknown, extra: Record<string, unknown> = {}) {
  return { kind: 'cmp', column, op, value, ...extra };
}

function scalar(value: string) {
  return { type: 'scalar', value };
}

/** Assert that a malformed query fails with PostgREST's own parse-error code. */
function expectParseError(query: Record<string, unknown>): void {
  expect(() => parseQuery(query)).toThrowError(expect.objectContaining({ statusCode: 400, code: 'PGRST100' }));
}

describe('comparison operators', () => {
  it('parses eq', () => {
    expect(filterOf({ status: 'eq.active' })).toEqual(cmp('status', 'eq', scalar('active')));
  });

  it('parses neq', () => {
    expect(filterOf({ role: 'neq.ADMIN' })).toEqual(cmp('role', 'neq', scalar('ADMIN')));
  });

  it('parses gt, gte, lt and lte', () => {
    expect(filterOf({ age: 'gt.18' })).toEqual(cmp('age', 'gt', scalar('18')));
    expect(filterOf({ age: 'gte.18' })).toEqual(cmp('age', 'gte', scalar('18')));
    expect(filterOf({ age: 'lt.99' })).toEqual(cmp('age', 'lt', scalar('99')));
    expect(filterOf({ age: 'lte.99' })).toEqual(cmp('age', 'lte', scalar('99')));
  });

  it('keeps numeric literals as raw strings so Postgres does the coercion', () => {
    // PostgREST sends every literal untyped. Coercing to a JS number here would
    // lose bigint and numeric precision on the way to the database.
    expect(filterOf({ score: 'eq.9007199254740993' })).toEqual(cmp('score', 'eq', scalar('9007199254740993')));
  });

  it('does not turn eq.null into SQL NULL (only is.null reaches NULL)', () => {
    expect(filterOf({ note: 'eq.null' })).toEqual(cmp('note', 'eq', scalar('null')));
  });

  it('parses isdistinct', () => {
    expect(filterOf({ note: 'isdistinct.x' })).toEqual(cmp('note', 'isdistinct', scalar('x')));
  });
});

describe('pattern and regex operators', () => {
  it('parses like with an explicit percent sign', () => {
    expect(filterOf({ name: 'like.john%' })).toEqual(cmp('name', 'like', scalar('john%')));
  });

  it('translates the * wildcard to % for like', () => {
    expect(filterOf({ name: 'like.*john*' })).toEqual(cmp('name', 'like', scalar('%john%')));
  });

  it('translates the * wildcard to % for ilike', () => {
    expect(filterOf({ name: 'ilike.*john*' })).toEqual(cmp('name', 'ilike', scalar('%john%')));
  });

  it('parses match and imatch without touching the pattern', () => {
    expect(filterOf({ name: 'match.^jo.*n$' })).toEqual(cmp('name', 'match', scalar('^jo.*n$')));
    expect(filterOf({ name: 'imatch.^jo.*n$' })).toEqual(cmp('name', 'imatch', scalar('^jo.*n$')));
  });
});

describe('list values', () => {
  it('parses a plain in list', () => {
    expect(filterOf({ status: 'in.(active,deleted)' })).toEqual({
      kind: 'cmp',
      column: 'status',
      op: 'in',
      value: { type: 'list', values: ['active', 'deleted'] },
    });
  });

  it('keeps a quoted comma inside one element', () => {
    expect(filterOf({ tag: 'in.("a,b",c)' })).toEqual({
      kind: 'cmp',
      column: 'tag',
      op: 'in',
      value: { type: 'list', values: ['a,b', 'c'] },
    });
  });

  it('parses an empty in list', () => {
    expect(filterOf({ status: 'in.()' })).toEqual({
      kind: 'cmp',
      column: 'status',
      op: 'in',
      value: { type: 'list', values: [] },
    });
  });

  it('decodes backslash escapes inside a quoted value', () => {
    expect(filterOf({ name: 'eq."say \\"hi\\""' })).toEqual(cmp('name', 'eq', scalar('say "hi"')));
  });

  it('treats a fully quoted literal as text, not as a keyword', () => {
    expect(filterOf({ note: 'eq."null"' })).toEqual(cmp('note', 'eq', scalar('null')));
  });
});

describe('is', () => {
  it('parses is.null', () => {
    expect(filterOf({ deletedAt: 'is.null' })).toEqual({
      kind: 'cmp',
      column: 'deletedAt',
      op: 'is',
      value: { type: 'is', value: 'null' },
    });
  });

  it('parses is.not.null as a not node over is.null', () => {
    expect(filterOf({ deletedAt: 'is.not.null' })).toEqual({
      kind: 'not',
      children: [{ kind: 'cmp', column: 'deletedAt', op: 'is', value: { type: 'is', value: 'null' } }],
    });
  });

  it('parses the PostgREST spelling not.is.null identically', () => {
    expect(filterOf({ deletedAt: 'not.is.null' })).toEqual({
      kind: 'not',
      children: [{ kind: 'cmp', column: 'deletedAt', op: 'is', value: { type: 'is', value: 'null' } }],
    });
  });

  it('parses is.true, is.false and is.unknown', () => {
    for (const literal of ['true', 'false', 'unknown'] as const) {
      expect(filterOf({ flag: `is.${literal}` })).toEqual({
        kind: 'cmp',
        column: 'flag',
        op: 'is',
        value: { type: 'is', value: literal },
      });
    }
  });

  it('rejects an is value that is not a three-valued-logic keyword', () => {
    expectParseError({ flag: 'is.maybe' });
  });
});

describe('the not prefix', () => {
  it('negates eq', () => {
    expect(filterOf({ status: 'not.eq.active' })).toEqual({
      kind: 'not',
      children: [cmp('status', 'eq', scalar('active'))],
    });
  });

  it('negates like, keeping the wildcard translation', () => {
    expect(filterOf({ name: 'not.like.*jo*' })).toEqual({
      kind: 'not',
      children: [cmp('name', 'like', scalar('%jo%'))],
    });
  });

  it('negates in', () => {
    expect(filterOf({ status: 'not.in.(a,b)' })).toEqual({
      kind: 'not',
      children: [{ kind: 'cmp', column: 'status', op: 'in', value: { type: 'list', values: ['a', 'b'] } }],
    });
  });
});

describe('full-text search', () => {
  it('parses fts without a configuration', () => {
    expect(filterOf({ body: 'fts.cat' })).toEqual({
      kind: 'cmp',
      column: 'body',
      op: 'fts',
      value: { type: 'fts', query: 'cat', config: null },
    });
  });

  it('parses fts with a configuration', () => {
    expect(filterOf({ body: 'fts(english).cat' })).toEqual({
      kind: 'cmp',
      column: 'body',
      op: 'fts',
      value: { type: 'fts', query: 'cat', config: 'english' },
    });
  });

  it('parses plfts, phfts and wfts', () => {
    for (const op of ['plfts', 'phfts', 'wfts'] as const) {
      expect(filterOf({ body: `${op}(simple).big cat` })).toEqual({
        kind: 'cmp',
        column: 'body',
        op,
        value: { type: 'fts', query: 'big cat', config: 'simple' },
      });
    }
  });

  it('rejects a text-search configuration that is not an identifier', () => {
    expectParseError({ body: "fts(english');drop).cat" });
  });
});

describe('array, range and containment operators', () => {
  it('parses cs with an array literal', () => {
    expect(filterOf({ tags: 'cs.{a,b}' })).toEqual(cmp('tags', 'cs', scalar('{a,b}')));
  });

  it('parses cs with an empty array literal', () => {
    expect(filterOf({ tags: 'cs.{}' })).toEqual(cmp('tags', 'cs', scalar('{}')));
  });

  it('parses cs with a jsonb object literal', () => {
    expect(filterOf({ meta: 'cs.{"a":1}' })).toEqual(cmp('meta', 'cs', scalar('{"a":1}')));
  });

  it('parses cd and ov', () => {
    expect(filterOf({ tags: 'cd.{a,b}' })).toEqual(cmp('tags', 'cd', scalar('{a,b}')));
    expect(filterOf({ tags: 'ov.{a,b}' })).toEqual(cmp('tags', 'ov', scalar('{a,b}')));
  });

  it('parses the range placement operators', () => {
    expect(filterOf({ span: 'sl.[1,10)' })).toEqual(cmp('span', 'sl', scalar('[1,10)')));
    expect(filterOf({ span: 'sr.[1,10)' })).toEqual(cmp('span', 'sr', scalar('[1,10)')));
    expect(filterOf({ span: 'nxr.[1,10)' })).toEqual(cmp('span', 'nxr', scalar('[1,10)')));
    expect(filterOf({ span: 'nxl.[1,10)' })).toEqual(cmp('span', 'nxl', scalar('[1,10)')));
    expect(filterOf({ span: 'adj.[1,10)' })).toEqual(cmp('span', 'adj', scalar('[1,10)')));
  });
});

describe('the any and all modifiers', () => {
  it('parses like(any) and translates the wildcard in every element', () => {
    expect(filterOf({ name: 'like(any).{*jo*,*an*}' })).toEqual({
      kind: 'cmp',
      column: 'name',
      op: 'like',
      modifier: 'any',
      value: { type: 'list', values: ['%jo%', '%an%'] },
    });
  });

  it('parses eq(all)', () => {
    expect(filterOf({ score: 'eq(all).{1,2}' })).toEqual({
      kind: 'cmp',
      column: 'score',
      op: 'eq',
      modifier: 'all',
      value: { type: 'list', values: ['1', '2'] },
    });
  });

  it('rejects a modifier that is neither any nor all', () => {
    expectParseError({ name: 'like(some).{a}' });
  });

  it('rejects a modifier value that is not a braced list', () => {
    expectParseError({ name: 'like(any).a' });
  });
});

describe('logic trees', () => {
  it('parses a flat or group', () => {
    expect(filterOf({ or: '(a.eq.1,b.eq.2)' })).toEqual({
      kind: 'or',
      children: [cmp('a', 'eq', scalar('1')), cmp('b', 'eq', scalar('2'))],
    });
  });

  it('parses a nested or/and tree with an is.null leaf', () => {
    expect(filterOf({ or: '(a.eq.1,and(b.gt.2,c.is.null))' })).toEqual({
      kind: 'or',
      children: [
        cmp('a', 'eq', scalar('1')),
        {
          kind: 'and',
          children: [
            cmp('b', 'gt', scalar('2')),
            { kind: 'cmp', column: 'c', op: 'is', value: { type: 'is', value: 'null' } },
          ],
        },
      ],
    });
  });

  it('parses a not-prefixed nested group', () => {
    expect(filterOf({ or: '(a.eq.1,not.and(b.gt.2,c.lt.3))' })).toEqual({
      kind: 'or',
      children: [
        cmp('a', 'eq', scalar('1')),
        { kind: 'not', children: [{ kind: 'and', children: [cmp('b', 'gt', scalar('2')), cmp('c', 'lt', scalar('3'))] }] },
      ],
    });
  });

  it('parses a top-level and group', () => {
    expect(filterOf({ and: '(a.eq.1,b.eq.2)' })).toEqual({
      kind: 'and',
      children: [cmp('a', 'eq', scalar('1')), cmp('b', 'eq', scalar('2'))],
    });
  });

  it('parses the not.or key', () => {
    expect(filterOf({ 'not.or': '(a.eq.1,b.eq.2)' })).toEqual({
      kind: 'not',
      children: [{ kind: 'or', children: [cmp('a', 'eq', scalar('1')), cmp('b', 'eq', scalar('2'))] }],
    });
  });

  it('keeps a quoted comma inside a logic branch value', () => {
    expect(filterOf({ or: '(a.eq."x,y",b.eq.2)' })).toEqual({
      kind: 'or',
      children: [cmp('a', 'eq', scalar('x,y')), cmp('b', 'eq', scalar('2'))],
    });
  });

  it('rejects an empty logic group, which would compile to a tautology', () => {
    expectParseError({ or: '()' });
  });

  it('rejects a logic group that is not wrapped in parentheses', () => {
    expectParseError({ or: 'a.eq.1' });
  });

  it('rejects an unbalanced logic group', () => {
    expectParseError({ or: '(a.eq.1,and(b.gt.2)' });
  });
});

describe('json paths', () => {
  it('parses a single ->> segment', () => {
    expect(filterOf({ 'data->>name': 'eq.bob' })).toEqual(
      cmp('data', 'eq', scalar('bob'), { jsonPath: [{ kind: 'key', value: 'name' }], jsonAsText: true })
    );
  });

  it('parses a chained -> ->> path', () => {
    expect(filterOf({ 'data->a->>b': 'eq.1' })).toEqual(
      cmp('data', 'eq', scalar('1'), {
        jsonPath: [
          { kind: 'key', value: 'a' },
          { kind: 'key', value: 'b' },
        ],
        jsonAsText: true,
      })
    );
  });

  it('reads an all-digit segment as an array index', () => {
    expect(filterOf({ 'data->0->>name': 'eq.x' })).toEqual(
      cmp('data', 'eq', scalar('x'), {
        jsonPath: [
          { kind: 'index', value: '0' },
          { kind: 'key', value: 'name' },
        ],
        jsonAsText: true,
      })
    );
  });

  it('keeps a -> only path as jsonb rather than text', () => {
    expect(filterOf({ 'data->a': 'cs.{"x":1}' })).toEqual(
      cmp('data', 'cs', scalar('{"x":1}'), { jsonPath: [{ kind: 'key', value: 'a' }], jsonAsText: false })
    );
  });

  it('rejects a path that continues after ->>', () => {
    expectParseError({ 'data->>a->b': 'eq.1' });
  });

  it('rejects an empty path segment', () => {
    expectParseError({ 'data->': 'eq.1' });
  });
});

describe('combining filters', () => {
  it('ands two different query parameters', () => {
    expect(filterOf({ status: 'eq.active', role: 'eq.USER' })).toEqual({
      kind: 'and',
      children: [cmp('status', 'eq', scalar('active')), cmp('role', 'eq', scalar('USER'))],
    });
  });

  it('ands a repeated query parameter instead of keeping only the first', () => {
    expect(filterOf({ age: ['gt.18', 'lt.65'] })).toEqual({
      kind: 'and',
      children: [cmp('age', 'gt', scalar('18')), cmp('age', 'lt', scalar('65'))],
    });
  });

  it('reports no filter at all when the query carries none', () => {
    expect(filterOf({ select: 'id' })).toBeNull();
  });
});

describe('select', () => {
  it('parses a plain column list', () => {
    expect(parseQuery({ select: 'id,title' }).select).toEqual([
      { kind: 'column', column: 'id' },
      { kind: 'column', column: 'title' },
    ]);
  });

  it('parses the star projection', () => {
    expect(parseQuery({ select: '*' }).select).toEqual([{ kind: 'star' }]);
  });

  it('parses an alias', () => {
    expect(parseQuery({ select: 'fullName:full_name' }).select).toEqual([
      { kind: 'column', column: 'full_name', alias: 'fullName' },
    ]);
  });

  it('parses a json path in the projection', () => {
    expect(parseQuery({ select: 'data->>name' }).select).toEqual([
      { kind: 'column', column: 'data', jsonPath: [{ kind: 'key', value: 'name' }], jsonAsText: true },
    ]);
  });

  it('parses an embedded resource, so 2.7 only has to teach the compiler', () => {
    expect(parseQuery({ select: '*,author(*)' }).select).toEqual([
      { kind: 'star' },
      { kind: 'relation', relation: 'author', children: [{ kind: 'star' }] },
    ]);
  });

  it('parses an aliased, hinted embedded resource', () => {
    expect(parseQuery({ select: 'writer:author!fk_posts_author(id,name)' }).select).toEqual([
      {
        kind: 'relation',
        relation: 'author',
        alias: 'writer',
        hint: 'fk_posts_author',
        children: [
          { kind: 'column', column: 'id' },
          { kind: 'column', column: 'name' },
        ],
      },
    ]);
  });

  it('parses the !inner marker', () => {
    expect(parseQuery({ select: 'comments!inner(id)' }).select).toEqual([
      { kind: 'relation', relation: 'comments', inner: true, children: [{ kind: 'column', column: 'id' }] },
    ]);
  });

  it('rejects an unterminated embedded resource', () => {
    expectParseError({ select: 'author(id' });
  });
});

describe('order and pagination', () => {
  it('defaults to ascending and honours an explicit direction', () => {
    expect(parseQuery({ order: 'createdAt.desc,title' }).order).toEqual([
      { column: 'createdAt', direction: 'desc' },
      { column: 'title', direction: 'asc' },
    ]);
  });

  it('parses nullsfirst and nullslast', () => {
    expect(parseQuery({ order: 'score.desc.nullslast,rank.asc.nullsfirst' }).order).toEqual([
      { column: 'score', direction: 'desc', nulls: 'last' },
      { column: 'rank', direction: 'asc', nulls: 'first' },
    ]);
  });

  it('orders on a json path', () => {
    expect(parseQuery({ order: 'data->>score.desc' }).order).toEqual([
      { column: 'data', jsonPath: [{ kind: 'key', value: 'score' }], jsonAsText: true, direction: 'desc' },
    ]);
  });

  it('parses limit and offset and caps limit at the hard ceiling', () => {
    expect(parseQuery({ limit: '10', offset: '20' })).toMatchObject({ take: 10, skip: 20 });
    expect(parseQuery({ limit: '99999' }).take).toBe(1000);
  });

  it('does not treat reserved keys as column filters', () => {
    const parsed = parseQuery({ select: 'id', limit: '5', order: 'id.asc', offset: '0', on_conflict: 'email' });
    expect(parsed.filter).toBeNull();
    expect(parsed.onConflict).toEqual(['email']);
  });

  it('rejects a non-numeric limit instead of silently ignoring it', () => {
    expectParseError({ limit: 'ten' });
    expectParseError({ offset: '-1' });
  });
});

describe('malformed input', () => {
  it('rejects a bare value with no operator', () => {
    expectParseError({ id: 'w1' });
  });

  it('rejects an unknown operator', () => {
    expectParseError({ id: 'sqlinject.1' });
  });

  it('rejects an operator with no value', () => {
    expectParseError({ id: 'eq' });
  });

  it('rejects an unterminated quoted value', () => {
    expectParseError({ status: 'in.("a,b)' });
  });

  it('rejects an in list that is not parenthesised', () => {
    expectParseError({ status: 'in.a,b' });
  });

  it('rejects a column name that is not an identifier', () => {
    expectParseError({ 'bad-field': 'eq.x' });
  });

  it('rejects an empty select', () => {
    expectParseError({ select: '  ' });
  });
});
