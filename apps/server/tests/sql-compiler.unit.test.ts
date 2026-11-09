import { describe, expect, it } from 'vitest';
import { makeCatalogSnapshot, type CatalogColumn, type CatalogTable } from '../services/rest-api/catalog';
import { parseQuery } from '../services/rest-api/postgrest-parser';
import {
  assertColumn,
  createContext,
  createParams,
  filterToSql,
  orderToSql,
  selectToSql,
} from '../services/rest-api/sql-compiler';

/**
 * Compiler suite: AST in, SQL out. The catalog is a hand-built snapshot so these
 * cases stay fast and deterministic; `rest-api-operators.integration.test.ts`
 * proves the same SQL is accepted and behaves correctly on real Postgres.
 */

function col(name: string, pgType: string, formattedType: string, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    name,
    pgType,
    formattedType,
    tsType: 'unknown',
    nullable: true,
    hasDefault: false,
    defaultExpr: null,
    isPk: false,
    isGenerated: false,
    isArray: false,
    enumType: null,
    typeKind: 'b',
    position: 1,
    ...extra,
  };
}

const FIXTURE: CatalogTable = makeCatalogSnapshot({
  tables: [
    {
      schema: 'public',
      name: 'widgets',
      rlsEnabled: true,
      primaryKey: ['id'],
      columns: [
        col('id', 'text', 'text', { isPk: true, nullable: false }),
        col('name', 'text', 'text'),
        col('score', 'int4', 'integer'),
        col('flag', 'bool', 'boolean'),
        col('label', 'varchar', 'character varying(255)'),
        col('tags', '_text', 'text[]', { isArray: true }),
        col('meta', 'jsonb', 'jsonb'),
        col('span', 'int4range', 'int4range', { typeKind: 'r' }),
        col('body', 'text', 'text'),
      ],
    },
  ],
}).table('public', 'widgets')!;

/** Compile the filter of a query string against the fixture table. */
function compile(query: Record<string, unknown>) {
  const ctx = createContext(FIXTURE, createParams());
  const filter = parseQuery(query).filter!;
  return filterToSql(filter, ctx);
}

describe('column validation', () => {
  it('resolves a known column', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(assertColumn(ctx, 'name').pgType).toBe('text');
  });

  it('rejects an unknown column with a 400 before any SQL is built', () => {
    expect(() => compile({ nope: 'eq.1' })).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it('rejects an unknown column in ?order', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(() => orderToSql(parseQuery({ order: 'nope.desc' }).order, ctx)).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('rejects an unknown column in ?select', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(() => selectToSql(parseQuery({ select: 'nope' }).select, ctx)).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

describe('operator SQL', () => {
  it.each([
    ['eq', { name: 'eq.x' }, '"name" = $1', ['x']],
    ['neq', { name: 'neq.x' }, '"name" <> $1', ['x']],
    ['gt', { score: 'gt.3' }, '"score" > $1', ['3']],
    ['gte', { score: 'gte.3' }, '"score" >= $1', ['3']],
    ['lt', { score: 'lt.3' }, '"score" < $1', ['3']],
    ['lte', { score: 'lte.3' }, '"score" <= $1', ['3']],
    ['like', { name: 'like.*jo*' }, '"name" LIKE $1::text', ['%jo%']],
    ['ilike', { name: 'ilike.*jo*' }, '"name" ILIKE $1::text', ['%jo%']],
    ['match', { name: 'match.^jo' }, '"name" ~ $1::text', ['^jo']],
    ['imatch', { name: 'imatch.^jo' }, '"name" ~* $1::text', ['^jo']],
    ['in', { name: 'in.(a,b)' }, '"name" = ANY($1::text[])', [['a', 'b']]],
    ['isdistinct', { name: 'isdistinct.x' }, '"name" IS DISTINCT FROM $1::text', ['x']],
    ['cs', { tags: 'cs.{a,b}' }, '"tags" @> $1::text[]', ['{a,b}']],
    ['cd', { tags: 'cd.{a,b}' }, '"tags" <@ $1::text[]', ['{a,b}']],
    ['ov', { tags: 'ov.{a,b}' }, '"tags" && $1::text[]', ['{a,b}']],
    ['sl', { span: 'sl.[1,10)' }, '"span" << $1::int4range', ['[1,10)']],
    ['sr', { span: 'sr.[1,10)' }, '"span" >> $1::int4range', ['[1,10)']],
    ['nxr', { span: 'nxr.[1,10)' }, '"span" &< $1::int4range', ['[1,10)']],
    ['nxl', { span: 'nxl.[1,10)' }, '"span" &> $1::int4range', ['[1,10)']],
    ['adj', { span: 'adj.[1,10)' }, '"span" -|- $1::int4range', ['[1,10)']],
    ['fts', { body: 'fts.cat' }, '"body" @@ to_tsquery($1)', ['cat']],
    ['plfts', { body: 'plfts.cat' }, '"body" @@ plainto_tsquery($1)', ['cat']],
    ['phfts', { body: 'phfts.cat' }, '"body" @@ phraseto_tsquery($1)', ['cat']],
    ['wfts', { body: 'wfts.cat' }, '"body" @@ websearch_to_tsquery($1)', ['cat']],
  ] as Array<[string, Record<string, unknown>, string, unknown[]]>)(
    'compiles %s',
    (_name, query, sql, params) => {
      expect(compile(query)).toEqual({ sql, params });
    }
  );

  it('compiles the is keywords without a parameter', () => {
    expect(compile({ flag: 'is.null' })).toEqual({ sql: '"flag" IS NULL', params: [] });
    expect(compile({ flag: 'is.true' })).toEqual({ sql: '"flag" IS TRUE', params: [] });
    expect(compile({ flag: 'is.false' })).toEqual({ sql: '"flag" IS FALSE', params: [] });
    expect(compile({ flag: 'is.unknown' })).toEqual({ sql: '"flag" IS UNKNOWN', params: [] });
  });

  it('binds the text-search configuration rather than splicing it in', () => {
    expect(compile({ body: 'fts(english).cat' })).toEqual({
      sql: '"body" @@ to_tsquery($1::regconfig, $2)',
      params: ['english', 'cat'],
    });
  });

  it('compiles the any and all modifiers to quantified comparisons', () => {
    expect(compile({ name: 'like(any).{*a*,*b*}' })).toEqual({
      sql: '"name" LIKE ANY($1::text[])',
      params: [['%a%', '%b%']],
    });
    expect(compile({ score: 'eq(all).{1,2}' })).toEqual({
      sql: '"score" = ALL($1::integer[])',
      params: [['1', '2']],
    });
  });

  it('casts an array parameter using the column type from the catalog', () => {
    expect(compile({ label: 'in.(a,b)' })).toEqual({
      sql: '"label" = ANY($1::character varying(255)[])',
      params: [['a', 'b']],
    });
  });

  it('compiles not as a wrapping NOT', () => {
    expect(compile({ name: 'not.eq.x' })).toEqual({ sql: 'NOT ("name" = $1)', params: ['x'] });
  });

  it('compiles is.not.null to NOT (... IS NULL)', () => {
    expect(compile({ flag: 'is.not.null' })).toEqual({ sql: 'NOT ("flag" IS NULL)', params: [] });
  });
});

describe('logic trees', () => {
  it('compiles a flat or with contiguous placeholders', () => {
    expect(compile({ or: '(name.eq.a,score.gt.1)' })).toEqual({
      sql: '("name" = $1 OR "score" > $2)',
      params: ['a', '1'],
    });
  });

  it('compiles the nested or/and/is.null example', () => {
    expect(compile({ or: '(name.eq.1,and(score.gt.2,flag.is.null))' })).toEqual({
      sql: '("name" = $1 OR ("score" > $2 AND "flag" IS NULL))',
      params: ['1', '2'],
    });
  });

  it('ands separate query parameters', () => {
    expect(compile({ name: 'eq.a', score: 'lt.9' })).toEqual({
      sql: '("name" = $1 AND "score" < $2)',
      params: ['a', '9'],
    });
  });
});

describe('json paths', () => {
  it('binds every path segment', () => {
    expect(compile({ 'meta->a->>b': 'eq.x' })).toEqual({
      sql: '("meta" -> $1::text ->> $2::text) = $3',
      params: ['a', 'b', 'x'],
    });
  });

  it('binds an array index as an integer', () => {
    expect(compile({ 'meta->0->>b': 'eq.x' })).toEqual({
      sql: '("meta" -> $1::int ->> $2::text) = $3',
      params: ['0', 'b', 'x'],
    });
  });

  it('types a -> path as jsonb and a ->> path as text for the polymorphic operators', () => {
    expect(compile({ 'meta->a': 'cs.{"x":1}' }).sql).toBe('("meta" -> $1::text) @> $2::jsonb');
    expect(compile({ 'meta->>a': 'in.(x,y)' }).sql).toBe('("meta" ->> $1::text) = ANY($2::text[])');
  });
});

describe('projection and ordering', () => {
  it('renders * when there is no ?select', () => {
    expect(selectToSql(null, createContext(FIXTURE, createParams()))).toBe('*');
  });

  it('renders a column list and an alias', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(selectToSql(parseQuery({ select: 'id,label:name' }).select, ctx)).toBe('"id", "name" AS "label"');
  });

  it('names a json-path projection after its last segment', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(selectToSql(parseQuery({ select: 'meta->>city' }).select, ctx)).toBe('("meta" ->> $1::text) AS "city"');
  });

  it('refuses relational embedding until 2.7 rather than dropping it silently', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(() => selectToSql(parseQuery({ select: 'meta,author(*)' }).select, ctx)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: 'PGRST100' })
    );
  });

  it('renders direction and null placement', () => {
    const ctx = createContext(FIXTURE, createParams());
    expect(orderToSql(parseQuery({ order: 'score.desc.nullslast,name' }).order, ctx)).toBe(
      '"score" DESC NULLS LAST, "name" ASC'
    );
  });

  it('qualifies every reference with the relation alias, which 2.7 embedding needs', () => {
    const ctx = createContext(FIXTURE, createParams(), 'w');
    expect(filterToSql(parseQuery({ name: 'eq.x' }).filter!, ctx).sql).toBe('"w"."name" = $1');
    expect(orderToSql(parseQuery({ order: 'score.desc' }).order, ctx)).toBe('"w"."score" DESC');
    expect(selectToSql(parseQuery({ select: '*' }).select, ctx)).toBe('"w".*');
  });

  it('keeps one contiguous parameter list across projection, filter and order', () => {
    // 2.7 compiles embedded subqueries after the parent using this same shared
    // accumulator, so placeholder numbering has to survive being interleaved.
    const ctx = createContext(FIXTURE, createParams());
    const columns = selectToSql(parseQuery({ select: 'meta->>city' }).select, ctx);
    const where = filterToSql(parseQuery({ name: 'eq.bob' }).filter!, ctx).sql;
    const order = orderToSql(parseQuery({ order: 'meta->>rank.desc' }).order, ctx);
    expect(columns).toContain('$1');
    expect(where).toBe('"name" = $2');
    expect(order).toBe('("meta" ->> $3::text) DESC');
    expect(ctx.params.values).toEqual(['city', 'bob', 'rank']);
  });
});

describe('fuzz: no user-supplied value ever reaches the SQL text', () => {
  // No `*`: the parser rewrites it to `%` for the pattern operators, which would
  // make the "value travelled as a parameter" check compare against a value the
  // caller never sent. Every character that matters for SQL splicing is here.
  const NASTY_CHARS = `'";\\()[]{},.-%$&|<>@#!/ \t\nüé漢`;

  function randomValue(random: () => number): string {
    // At least six characters: a shorter run of punctuation can coincide with
    // the compiler's own output (`[])`) and make the containment check flaky
    // without saying anything about leakage.
    const length = 6 + Math.floor(random() * 20);
    let out = '';
    for (let index = 0; index < length; index += 1) {
      out += NASTY_CHARS[Math.floor(random() * NASTY_CHARS.length)];
    }
    return out;
  }

  /** Deterministic PRNG so a failure is reproducible from the seed alone. */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  /** Encode a value the way a PostgREST client must, so the parser accepts it. */
  function quoteForQuery(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  const OPERATOR_TEMPLATES: Array<(encoded: string) => Record<string, string>> = [
    encoded => ({ name: `eq.${encoded}` }),
    encoded => ({ name: `neq.${encoded}` }),
    encoded => ({ name: `match.${encoded}` }),
    encoded => ({ name: `isdistinct.${encoded}` }),
    encoded => ({ score: `gt.${encoded}` }),
    encoded => ({ name: `in.(${encoded},${encoded})` }),
    encoded => ({ name: `like(any).{${encoded}}` }),
    encoded => ({ body: `wfts.${encoded}` }),
    encoded => ({ tags: `cs.${encoded}` }),
    encoded => ({ or: `(name.eq.${encoded},and(score.gt.1,name.neq.${encoded}))` }),
    encoded => ({ [`meta->>a`]: `eq.${encoded}` }),
  ];

  it('never splices a filter value into the statement, over 2000 generated filters', () => {
    const random = makeRandom(20260726);
    let checked = 0;

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const value = randomValue(random);
      const other = randomValue(random);
      if (value === other) continue;
      const template = OPERATOR_TEMPLATES[iteration % OPERATOR_TEMPLATES.length];

      let compiled: { sql: string; params: unknown[] };
      let twin: { sql: string; params: unknown[] };
      try {
        compiled = compile(template(quoteForQuery(value)));
        twin = compile(template(quoteForQuery(other)));
      } catch (error: any) {
        // A rejected filter is an acceptable outcome; a spliced one is not.
        expect(error.statusCode).toBe(400);
        continue;
      }
      checked += 1;

      // 1. The strongest form of the invariant: the statement text does not
      //    depend on the value at all. Any leak, whole or partial, escaped or
      //    re-encoded, would make these two differ.
      expect(compiled.sql).toBe(twin.sql);
      // 2. The literal itself never appears in the statement text.
      expect(compiled.sql).not.toContain(value);
      // 3. The compiled filter contains no string literal at all: the only
      //    things it may hold are quoted identifiers, operators, casts and $n.
      expect(compiled.sql).not.toContain("'");
      // 4. The value did travel, as a bound parameter.
      const flattened = compiled.params.flatMap(param => (Array.isArray(param) ? param : [param]));
      expect(flattened).toContain(value);
    }

    expect(checked).toBeGreaterThan(1500);
  });

  it('never splices a json path segment or a projection alias', () => {
    const random = makeRandom(7);
    for (let iteration = 0; iteration < 300; iteration += 1) {
      // Path segments cannot contain `->`, which is the path separator itself.
      const segment = randomValue(random).replace(/->/g, '');
      if (!segment) continue;
      const ctx = createContext(FIXTURE, createParams());
      let sql: string;
      try {
        sql = selectToSql(parseQuery({ select: `meta->>${segment}` }).select, ctx);
      } catch (error: any) {
        expect(error.statusCode).toBe(400);
        continue;
      }
      expect(sql).not.toContain(segment);
      expect(sql).not.toContain("'");
      expect(ctx.params.values).toContain(segment);
    }
  });
});
