import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { invalidateCatalog } from '../services/rest-api/catalog';
import {
  generateTypescriptTypes,
  renderTypescript,
  assertSchemaName,
  type TypegenCatalog,
  type TypegenResources,
} from '../services/admin/typegen';
import AdminSchemaController from '../controllers/admin/admin-schema.controller';

// Phase 3.2. Runs against the real Postgres the rest of the integration suite
// uses. The fixture lives in its own schema so it cannot collide with the
// `public` tables the REST/RLS suites create.
//
// The golden file is the contract. It is committed, it is type-checked by the
// project build (tests/ is inside apps/server's tsconfig), and this suite also
// compiles it standalone under `--strict`. If a change to the emitter is
// intentional, regenerate the golden and read the diff: that diff is exactly
// what every user's `database.types.ts` will do on their next `--check` run.
const FX = 'typegen_fx';
const GOLDEN = path.resolve(__dirname, 'fixtures/typegen-golden.ts');

let generated = '';

// Edge functions and buckets are project-wide, and other suites create both in
// the same database, so the golden is generated from a fixed set.
const RESOURCES = { edgeFunctions: ['send-email', 'stripe-webhook'], buckets: ['avatars'] };
const fixedResources = async () => RESOURCES;

/**
 * Type-check one file the way a consumer would: strict, standalone, and with
 * `--typeRoots` pointed at nothing. Without that last flag tsc auto-includes
 * every `@types` package in the monorepo and reports their unrelated errors.
 */
function compileStandalone(file: string): void {
  const tsc = require.resolve('typescript/bin/tsc');
  try {
    execFileSync(
      process.execPath,
      [tsc, '--noEmit', '--strict', '--target', 'ES2020', '--typeRoots', './no-such-type-roots', file],
      { stdio: 'pipe', encoding: 'utf8' },
    );
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? '';
    throw new Error(`tsc rejected ${file}:\n${output}`);
  }
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${FX} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${FX}`);
  await prisma.$executeRawUnsafe(`CREATE TYPE ${FX}.order_status AS ENUM ('pending', 'shipped', 'cancelled')`);
  await prisma.$executeRawUnsafe(`CREATE TYPE ${FX}.addr AS (street text, zip int4)`);
  await prisma.$executeRawUnsafe(`CREATE DOMAIN ${FX}.positive AS int4 CHECK (VALUE > 0)`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.author (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      nickname    varchar(50),
      score       ${FX}.positive,
      tags        text[],
      statuses    ${FX}.order_status[],
      status      ${FX}.order_status NOT NULL DEFAULT 'pending',
      home        ${FX}.addr,
      meta        jsonb,
      created_at  timestamptz NOT NULL DEFAULT now(),
      loc         point,
      "odd name"  text,
      seq         bigint GENERATED ALWAYS AS IDENTITY,
      upper_name  text GENERATED ALWAYS AS (upper(name)) STORED
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${FX}.author ENABLE ROW LEVEL SECURITY`);

  // Many books per author: the FK column is not unique, so isOneToOne is false.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.book (
      id        int4 PRIMARY KEY,
      author_id uuid NOT NULL REFERENCES ${FX}.author(id),
      title     text NOT NULL
    )
  `);

  // One profile per author: the FK column IS the primary key, so isOneToOne.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${FX}.profile (
      author_id uuid PRIMARY KEY REFERENCES ${FX}.author(id),
      bio       text
    )
  `);

  await prisma.$executeRawUnsafe(`CREATE VIEW ${FX}.author_names AS SELECT id, name FROM ${FX}.author`);

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.greet(who text) RETURNS text LANGUAGE sql AS $$ SELECT 'hi ' || who $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.add_up(a int4, b int4 DEFAULT 1) RETURNS int4 LANGUAGE sql AS $$ SELECT a + b $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.books_of(author uuid) RETURNS SETOF ${FX}.book LANGUAGE sql AS $$ SELECT * FROM ${FX}.book WHERE author_id = author $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.default_status() RETURNS ${FX}.order_status LANGUAGE sql AS $$ SELECT 'pending'::${FX}.order_status $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.touch() RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$`
  );
  // A trigger function must never appear in Functions: no client can call it.
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${FX}.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`
  );

  invalidateCatalog();
  generated = (await generateTypescriptTypes(FX, prisma, fixedResources)).types;
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${FX} CASCADE`);
  invalidateCatalog();
});

describe('typegen: the Database shape', () => {
  it('matches the committed golden file byte for byte', () => {
    // Set MOTHERBASE_UPDATE_GOLDEN=1 to accept an intentional emitter change.
    if (process.env.MOTHERBASE_UPDATE_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN, generated, 'utf8');
    }
    // Byte for byte, line endings aside: a CRLF checkout must not fail the contract.
    const golden = fs.readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
    expect(generated).toBe(golden);
  });

  it('compiles standalone under tsc --noEmit --strict', () => {
    // The golden lives in the project's tsconfig too, but that build is not
    // `--strict`-isolated from the rest of the tree. Compiling the file alone
    // proves a user can drop it into an empty project and have it type-check.
    compileStandalone(GOLDEN);
  }, 60_000);

  it('is deterministic: two generations produce identical bytes', async () => {
    invalidateCatalog();
    const again = (await generateTypescriptTypes(FX, prisma, fixedResources)).types;
    expect(again).toBe(generated);
  });

  it('uses LF line endings and no trailing whitespace', () => {
    expect(generated.includes('\r')).toBe(false);
    expect(generated.split('\n').every(line => line === line.replace(/\s+$/, ''))).toBe(true);
  });
});

describe('typegen: Row, Insert and Update', () => {
  const rowBlock = (table: string, block: 'Row' | 'Insert' | 'Update') => {
    const start = generated.indexOf(`      ${table}: {`);
    expect(start, `${table} not found`).toBeGreaterThan(-1);
    const blockStart = generated.indexOf(`        ${block}: {`, start);
    const blockEnd = generated.indexOf('\n        }', blockStart);
    return generated.slice(blockStart, blockEnd);
  };

  it('Row lists every column, nullable ones unioned with null', () => {
    const row = rowBlock('author', 'Row');
    expect(row).toContain('id: string\n');
    expect(row).toContain('name: string\n');
    expect(row).toContain('nickname: string | null');
    expect(row).toContain('meta: Json | null');
    expect(row).toContain('tags: string[] | null');
    expect(row).toContain('created_at: string\n');
    // Generated columns are readable, so they belong in Row.
    expect(row).toContain('seq: number');
    expect(row).toContain('upper_name: string | null');
  });

  it('Row keeps a domain at its base type and an unmapped type at unknown', () => {
    const row = rowBlock('author', 'Row');
    expect(row).toContain('score: number | null');
    // `unknown | null` collapses to `unknown`, so it is emitted bare.
    expect(row).toContain('loc: unknown\n');
  });

  it('Row references enums and composites through the Database object', () => {
    const row = rowBlock('author', 'Row');
    expect(row).toContain(`status: Database["${FX}"]["Enums"]["order_status"]\n`);
    expect(row).toContain(`statuses: Database["${FX}"]["Enums"]["order_status"][] | null`);
    expect(row).toContain(`home: Database["${FX}"]["CompositeTypes"]["addr"] | null`);
  });

  it('quotes a column name that is not a bare identifier', () => {
    expect(rowBlock('author', 'Row')).toContain('"odd name": string | null');
  });

  it('Insert omits generated columns and makes defaulted or nullable ones optional', () => {
    const insert = rowBlock('author', 'Insert');
    // GENERATED ALWAYS AS IDENTITY and STORED: the database owns these values.
    expect(insert).not.toContain('seq');
    expect(insert).not.toContain('upper_name');
    expect(insert).toContain('id?: string');
    expect(insert).toContain('name: string');
    expect(insert).toContain('nickname?: string | null');
    expect(insert).toContain('created_at?: string');
  });

  it('Update makes every writable column optional', () => {
    const update = rowBlock('author', 'Update');
    expect(update).toContain('name?: string');
    expect(update).toContain('id?: string');
    expect(update).not.toContain('seq');
  });
});

describe('typegen: Relationships', () => {
  it('emits the PostgREST shape with isOneToOne from the catalog cardinality', () => {
    expect(generated).toContain('foreignKeyName: "book_author_id_fkey"');
    expect(generated).toContain('referencedRelation: "author"');
    expect(generated).toContain('referencedColumns: ["id"]');

    // book.author_id is not unique: many books per author.
    const bookRel = generated.slice(generated.indexOf('foreignKeyName: "book_author_id_fkey"'));
    expect(bookRel.slice(0, 200)).toContain('isOneToOne: false');

    // profile.author_id is the primary key: at most one profile per author.
    const profileRel = generated.slice(generated.indexOf('foreignKeyName: "profile_author_id_fkey"'));
    expect(profileRel.slice(0, 200)).toContain('isOneToOne: true');
  });

  it('emits an empty array for a table with no outbound foreign key', () => {
    const author = generated.slice(generated.indexOf('      author: {'));
    expect(author.slice(0, author.indexOf('      author_names'))).toContain('Relationships: []');
  });
});

describe('typegen: Views, Functions, Enums and CompositeTypes', () => {
  it('puts a view under Views with a Row but no Insert', () => {
    const views = generated.slice(generated.indexOf('    Views: {'), generated.indexOf('    Functions: {'));
    expect(views).toContain('author_names: {');
    expect(views).toContain('id: string | null');
    expect(views).not.toContain('Insert');
  });

  it('types function arguments, defaults and return values', () => {
    const functions = generated.slice(generated.indexOf('    Functions: {'), generated.indexOf('    Enums: {'));
    expect(functions).toContain('Args: { who: string }');
    // `b` has a DEFAULT so the caller may omit it.
    expect(functions).toContain('Args: { a: number; b?: number }');
    expect(functions).toContain('Args: Record<PropertyKey, never>');
    expect(functions).toContain('Returns: undefined');
    // SETOF <table> resolves to that table's Row type, as an array.
    expect(functions).toContain(`Returns: Database["${FX}"]["Tables"]["book"]["Row"][]`);
    expect(functions).toContain(`Returns: Database["${FX}"]["Enums"]["order_status"]`);
  });

  it('excludes trigger functions, which no client can call', () => {
    expect(generated).not.toContain('stamp: {');
  });

  it('emits enums as a union and composites as an object', () => {
    expect(generated).toContain('order_status: "pending" | "shipped" | "cancelled"');
    const composites = generated.slice(generated.indexOf('    CompositeTypes: {'));
    expect(composites).toContain('addr: {');
    expect(composites).toContain('street: string | null');
    expect(composites).toContain('zip: number | null');
  });

  it('emits the Json alias and the supabase-js helper types', () => {
    expect(generated).toContain('export type Json =');
    expect(generated).toContain('export type Tables<');
    expect(generated).toContain('export type TablesInsert<');
    expect(generated).toContain('export type TablesUpdate<');
    expect(generated).toContain('export type Enums<');
  });
});

describe('typegen: the admin endpoint (3.3)', () => {
  // The guard is asserted by admin-route-contract.unit.test.ts, which pins the
  // method/path/guard/handler manifest for every admin route. This covers the
  // payload contract the CLI, the Studio and MCP read.
  const invoke = async (query: Record<string, string>) => {
    const controller = new AdminSchemaController({} as never);
    let payload: unknown;
    const res = { status: () => ({ json: (body: unknown) => (payload = body) }) };
    const next = (error: unknown) => {
      throw error;
    };
    await controller.schemaTypes({ query } as never, res as never, next as never);
    return payload as {
      status: number;
      data: { schema: string; catalog: TypegenCatalog; resources: TypegenResources; types: string };
    };
  };

  it('returns the structured catalog alongside the rendered file', async () => {
    const body = await invoke({ schema: FX });
    expect(body.status).toBe(1);
    expect(body.data.schema).toBe(FX);
    // The real project's functions and buckets, whatever other suites left.
    expect(body.data.types).toBe(renderTypescript(body.data.catalog, body.data.resources));
    expect(Array.isArray(body.data.resources.edgeFunctions)).toBe(true);
    expect(Array.isArray(body.data.resources.buckets)).toBe(true);

    const { catalog } = body.data;
    // Structured, not a string blob: consumers can inspect it without parsing.
    expect(catalog.tables.map(t => t.name)).toEqual(['author', 'book', 'profile']);
    expect(catalog.enums).toEqual([{ name: 'order_status', values: ['pending', 'shipped', 'cancelled'] }]);
    expect(catalog.functions.map(f => f.name)).toContain('books_of');
  });

  it('defaults to the public schema', async () => {
    const body = await invoke({});
    expect(body.data.schema).toBe('public');
  });

  it('delegates a bad schema name to the error middleware', async () => {
    await expect(invoke({ schema: 'no; drop' })).rejects.toThrow(/Invalid schema name/);
  });
});

describe('typegen: empty schema and input validation', () => {
  it('renders every bucket as never for a schema with nothing in it', () => {
    const empty = renderTypescript({
      schema: 'public',
      tables: [],
      views: [],
      functions: [],
      enums: [],
      compositeTypes: [],
    });
    expect(empty).toContain('Tables: {\n      [_ in never]: never\n    }');
    expect(empty).toContain('CompositeTypes: {\n      [_ in never]: never\n    }');

    // A file with nothing in it must still compile.
    const scratch = path.join(os.tmpdir(), `motherbase-typegen-empty-${process.pid}.ts`);
    fs.writeFileSync(scratch, empty, 'utf8');
    try {
      compileStandalone(scratch);
    } finally {
      fs.unlinkSync(scratch);
    }
  }, 60_000);

  it('rejects a schema name that is not a plain identifier', () => {
    expect(() => assertSchemaName('public; DROP SCHEMA public')).toThrow(/Invalid schema name/);
    expect(() => assertSchemaName('"quoted"')).toThrow(/Invalid schema name/);
    expect(assertSchemaName('public')).toBe('public');
    expect(assertSchemaName('')).toBe('public');
  });
});
