import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import {
  getCatalog,
  invalidateCatalog,
  loadCatalog,
  catalogVersion,
  pgTypeToTsType,
  __primeCatalogForTests,
  makeCatalogSnapshot,
  type CatalogTable,
} from '../services/rest-api/catalog';

// Runs against the real Postgres the rest of the integration suite uses. The
// fixture lives in its own schema so it cannot collide with the `public` tables
// the REST/RLS suites create.
const FX = 'catalog_fx';

const column = (table: CatalogTable | undefined, name: string) =>
  table?.columns.find(c => c.name === name);

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${FX} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${FX}`);
  await prisma.$executeRawUnsafe(`CREATE TYPE ${FX}.mood AS ENUM ('happy', 'sad')`);
  await prisma.$executeRawUnsafe(`CREATE TYPE ${FX}.addr AS (street text, zip int4)`);
  await prisma.$executeRawUnsafe(`CREATE DOMAIN ${FX}.positive AS int4 CHECK (VALUE > 0)`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.author (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      nickname    varchar(50),
      age         int4,
      score       ${FX}.positive,
      tags        text[],
      moods       ${FX}.mood[],
      mood        ${FX}.mood NOT NULL DEFAULT 'happy',
      meta        jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      loc         point,
      seq         bigint GENERATED ALWAYS AS IDENTITY,
      upper_name  text GENERATED ALWAYS AS (upper(name)) STORED
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${FX}.author ENABLE ROW LEVEL SECURITY`);

  // Many books per author: the FK column is not unique, so the inbound side is
  // an array in PostgREST terms.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.book (
      id        int4 PRIMARY KEY,
      author_id uuid NOT NULL REFERENCES ${FX}.author(id),
      title     text NOT NULL
    )
  `);

  // One profile per author: the FK column IS the primary key, so the inbound
  // side is an object.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.profile (
      author_id uuid PRIMARY KEY REFERENCES ${FX}.author(id),
      bio       text
    )
  `);

  // Composite primary key plus a composite FK, to prove multi-column handling.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.edition (
      book_id int4 NOT NULL,
      year    int4 NOT NULL,
      isbn    text,
      PRIMARY KEY (book_id, year)
    )
  `);

  invalidateCatalog();
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${FX} CASCADE`);
  invalidateCatalog();
});

describe('catalog: columns and types', () => {
  it('describes every column with pg type, ts type, nullability and defaults', async () => {
    const catalog = await getCatalog();
    const author = catalog.table(FX, 'author');
    expect(author).toBeDefined();

    expect(column(author, 'id')).toMatchObject({
      pgType: 'uuid',
      tsType: 'string',
      nullable: false,
      hasDefault: true,
      isPk: true,
      isGenerated: false,
    });
    expect(column(author, 'name')).toMatchObject({
      pgType: 'text',
      tsType: 'string',
      nullable: false,
      hasDefault: false,
      isPk: false,
    });
    expect(column(author, 'nickname')).toMatchObject({ pgType: 'varchar', tsType: 'string', nullable: true });
    expect(column(author, 'nickname')?.formattedType).toBe('character varying(50)');
    expect(column(author, 'age')).toMatchObject({ pgType: 'int4', tsType: 'number', nullable: true, hasDefault: false });
    expect(column(author, 'meta')).toMatchObject({ pgType: 'jsonb', tsType: 'Json' });
    expect(column(author, 'created_at')).toMatchObject({
      pgType: 'timestamptz',
      tsType: 'string',
      nullable: false,
      hasDefault: true,
    });
    expect(column(author, 'created_at')?.defaultExpr).toContain('now()');
  });

  it('maps arrays, enums and domains, and refuses to guess unknown types', async () => {
    const author = (await getCatalog()).table(FX, 'author');

    expect(column(author, 'tags')).toMatchObject({ pgType: '_text', isArray: true, tsType: 'string[]' });
    expect(column(author, 'mood')).toMatchObject({
      pgType: 'mood',
      typeKind: 'e',
      tsType: "'happy' | 'sad'",
      enumType: `${FX}.mood`,
    });
    expect(column(author, 'moods')).toMatchObject({ isArray: true, tsType: "('happy' | 'sad')[]" });
    // Domain over int4 resolves to its base type.
    expect(column(author, 'score')).toMatchObject({ typeKind: 'd', tsType: 'number' });
    // `point` has no mapping: unknown, never `any`.
    expect(column(author, 'loc')?.tsType).toBe('unknown');
  });

  it('flags generated and identity columns so writes can omit them', async () => {
    const author = (await getCatalog()).table(FX, 'author');

    // GENERATED ALWAYS AS IDENTITY: the database supplies the value.
    expect(column(author, 'seq')).toMatchObject({ isGenerated: true, hasDefault: true });
    // STORED generated column.
    expect(column(author, 'upper_name')).toMatchObject({ isGenerated: true });
    expect(column(author, 'name')?.isGenerated).toBe(false);
  });
});

describe('catalog: primary keys', () => {
  it('records single and composite primary keys in index order', async () => {
    const catalog = await getCatalog();
    expect(catalog.table(FX, 'author')?.primaryKey).toEqual(['id']);
    expect(catalog.table(FX, 'edition')?.primaryKey).toEqual(['book_id', 'year']);
    expect(column(catalog.table(FX, 'edition'), 'isbn')?.isPk).toBe(false);
    expect(column(catalog.table(FX, 'edition'), 'year')?.isPk).toBe(true);
  });
});

describe('catalog: foreign keys in both directions', () => {
  it('records the outbound side on the child as to-one', async () => {
    const book = (await getCatalog()).table(FX, 'book');
    const fk = book?.foreignKeys.find(f => f.direction === 'outbound' && f.toTable === 'author');

    expect(fk).toMatchObject({
      direction: 'outbound',
      fromCols: ['author_id'],
      toSchema: FX,
      toTable: 'author',
      toCols: ['id'],
      cardinality: 'one',
    });
  });

  it('records the inbound side on the parent as to-many when the child key is not unique', async () => {
    const author = (await getCatalog()).table(FX, 'author');
    const fk = author?.foreignKeys.find(f => f.direction === 'inbound' && f.toTable === 'book');

    expect(fk).toMatchObject({
      direction: 'inbound',
      fromCols: ['id'],
      toSchema: FX,
      toTable: 'book',
      toCols: ['author_id'],
      cardinality: 'many',
    });
  });

  it('records the inbound side as to-one when the child key is covered by a unique index', async () => {
    const author = (await getCatalog()).table(FX, 'author');
    const fk = author?.foreignKeys.find(f => f.direction === 'inbound' && f.toTable === 'profile');

    // profile.author_id is the profile primary key, so at most one profile row
    // exists per author: PostgREST embeds this as an object, not an array.
    expect(fk).toMatchObject({ cardinality: 'one', fromCols: ['id'], toCols: ['author_id'] });
  });

  it('flips a to-many relationship to to-one when a unique index is added', async () => {
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX book_author_uniq ON ${FX}.book (author_id)`);
    invalidateCatalog();
    try {
      const author = (await getCatalog()).table(FX, 'author');
      const fk = author?.foreignKeys.find(f => f.direction === 'inbound' && f.toTable === 'book');
      expect(fk?.cardinality).toBe('one');
    } finally {
      await prisma.$executeRawUnsafe(`DROP INDEX ${FX}.book_author_uniq`);
      invalidateCatalog();
    }
  });

  it('ignores a partial unique index, which does not constrain every row', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX book_author_partial ON ${FX}.book (author_id) WHERE title <> ''`
    );
    invalidateCatalog();
    try {
      const author = (await getCatalog()).table(FX, 'author');
      const fk = author?.foreignKeys.find(f => f.direction === 'inbound' && f.toTable === 'book');
      expect(fk?.cardinality).toBe('many');
    } finally {
      await prisma.$executeRawUnsafe(`DROP INDEX ${FX}.book_author_partial`);
      invalidateCatalog();
    }
  });
});

describe('catalog: RLS state, enums and composite types', () => {
  it('reports rlsEnabled true and false', async () => {
    const catalog = await getCatalog();
    expect(catalog.table(FX, 'author')?.rlsEnabled).toBe(true);
    expect(catalog.table(FX, 'book')?.rlsEnabled).toBe(false);
    expect(catalog.table(FX, 'author')?.rlsForced).toBe(false);
  });

  it('lists user enums with their labels in sort order', async () => {
    const catalog = await getCatalog();
    expect(catalog.enum(FX, 'mood')).toEqual({ schema: FX, name: 'mood', values: ['happy', 'sad'] });
  });

  it('lists composite types with their attributes', async () => {
    const catalog = await getCatalog();
    const addr = catalog.compositeTypes.find(t => t.schema === FX && t.name === 'addr');
    expect(addr?.attributes.map(a => [a.name, a.pgType, a.tsType])).toEqual([
      ['street', 'text', 'string'],
      ['zip', 'int4', 'number'],
    ]);
  });
});

describe('catalog: caching', () => {
  it('returns the identical frozen snapshot until invalidated', async () => {
    const first = await getCatalog();
    const second = await getCatalog();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.table(FX, 'author'))).toBe(true);

    invalidateCatalog();
    const third = await getCatalog();
    expect(third).not.toBe(first);
    expect(third.version).toBeGreaterThan(first.version);
  });

  it('bumps the version token on every invalidation', () => {
    const before = catalogVersion();
    invalidateCatalog();
    expect(catalogVersion()).toBe(before + 1);
  });

  it('does not cache a failed load, so a later call can still succeed', async () => {
    invalidateCatalog();
    const broken = { $queryRawUnsafe: async () => { throw new Error('database is starting up'); } };
    await expect(getCatalog(broken as any)).rejects.toThrow('database is starting up');

    // A boot-time failure must not poison the cache: the next call reloads.
    const recovered = await getCatalog();
    expect(recovered.table(FX, 'author')).toBeDefined();
  });

  it('loadCatalog bypasses the cache entirely', async () => {
    const cachedSnapshot = await getCatalog();
    const fresh = await loadCatalog();
    expect(fresh).not.toBe(cachedSnapshot);
    expect(fresh.table(FX, 'book')?.name).toBe('book');
  });
});

describe('pgTypeToTsType', () => {
  it.each([
    ['int2', 'number'],
    ['int4', 'number'],
    ['int8', 'number'],
    ['numeric', 'number'],
    ['float4', 'number'],
    ['float8', 'number'],
    ['bool', 'boolean'],
    ['text', 'string'],
    ['varchar', 'string'],
    ['bpchar', 'string'],
    ['uuid', 'string'],
    ['json', 'Json'],
    ['jsonb', 'Json'],
    ['date', 'string'],
    ['time', 'string'],
    ['timestamp', 'string'],
    ['timestamptz', 'string'],
    ['interval', 'string'],
    ['bytea', 'string'],
    ['tsvector', 'unknown'],
    ['inet', 'unknown'],
  ])('maps %s to %s', (pgType, expected) => {
    expect(pgTypeToTsType({ pgType, typeKind: 'b' })).toBe(expected);
  });

  it('maps arrays and enum arrays', () => {
    expect(pgTypeToTsType({ pgType: '_int4', typeKind: 'b', elem: { pgType: 'int4', typeKind: 'b' } })).toBe('number[]');
    expect(
      pgTypeToTsType({
        pgType: '_mood',
        typeKind: 'b',
        elem: { pgType: 'mood', typeKind: 'e', enumValues: ['a', 'b'] },
      })
    ).toBe("('a' | 'b')[]");
  });

  it('falls back to string for an enum with no known labels', () => {
    expect(pgTypeToTsType({ pgType: 'mood', typeKind: 'e' })).toBe('string');
  });
});

describe('makeCatalogSnapshot', () => {
  it('builds a frozen, queryable snapshot without a database', () => {
    const snapshot = makeCatalogSnapshot({
      tables: [{ schema: 'public', name: 'notes', primaryKey: ['id'] }],
    });
    expect(snapshot.table('public', 'notes')?.primaryKey).toEqual(['id']);
    expect(snapshot.tablesIn('public')).toHaveLength(1);
    expect(snapshot.tablesIn('auth')).toEqual([]);
    expect(Object.isFrozen(snapshot.table('public', 'notes'))).toBe(true);
  });

  it('__primeCatalogForTests installs a snapshot and invalidate clears it', async () => {
    __primeCatalogForTests(makeCatalogSnapshot({ tables: [{ schema: 'public', name: 'primed' }] }));
    expect((await getCatalog()).table('public', 'primed')).toBeDefined();

    invalidateCatalog();
    expect((await getCatalog()).table('public', 'primed')).toBeUndefined();
  });
});
