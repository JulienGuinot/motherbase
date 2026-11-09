import prisma from '../../lib/prisma';
import type { Prisma } from '@prisma/client';
import { HttpException } from '../../exceptions/http-exception';
import { extractCreatedRelations } from './sql.service';
import { buildTableMetadata } from './admin.service';
import {
  assertSchema,
  buildAddColumnSql,
  execDdl,
  qualified,
  quoteIdent,
  type ColumnDef,
  type ColumnInfo,
  type TableInfo,
} from './schema-ddl';
import { getCatalog, loadCatalog } from '../rest-api/catalog';

export { buildAddColumnSql } from './schema-ddl';
export type { ColumnDef, TableInfo } from './schema-ddl';

export interface IndexInfo {
  name: string;
  definition: string;
  unique: boolean;
}

/** One row of Database > Tables: the shape plus what it costs on disk. */
export interface TableStats {
  name: string;
  kind: 'table' | 'partitioned' | 'view' | 'materialized view' | 'foreign';
  columns: number;
  /** Planner estimate (`reltuples`), not COUNT(*): -1 before the first ANALYZE. */
  rowsEstimate: number;
  /** Heap + indexes + TOAST, in bytes. */
  totalBytes: number;
  rlsEnabled: boolean;
  comment: string | null;
}

/** An index anywhere in a schema, for Database > Indexes. */
export interface SchemaIndexInfo extends IndexInfo {
  table: string;
  method: string;
  primary: boolean;
  /** Key columns, or the expression text for an expression index. */
  columns: string[];
  sizeBytes: number;
}

/** Access methods CREATE INDEX may name. Anything else is refused before it reaches SQL. */
export const INDEX_METHODS = ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export interface FunctionInfo {
  name: string;
  /**
   * The identity arguments, `''` for a no-argument function. Postgres allows
   * overloads, so the name alone does not identify a function: two overloads
   * came back as two rows with the same name and read as duplicates, and
   * `DROP FUNCTION name()` then addressed neither of them.
   */
  args: string;
  /** `name(args)`, which is what DROP FUNCTION actually takes. */
  signature: string;
  returnType: string;
  language: string;
  definition: string;
}

export interface TriggerInfo {
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: string[];
  orientation: 'ROW' | 'STATEMENT';
  function: string;
  enabled: boolean;
  definition: string;
}

export interface ExtensionInfo {
  name: string;
  defaultVersion: string;
  installedVersion: string | null;
  installed: boolean;
  comment: string;
}

export interface SchemaGraphNode {
  id: string;
  table: string;
  columns: ColumnInfo[];
  primaryKey: string | null;
}

export interface SchemaGraphEdge {
  constraint: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

type SchemaQueryClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

/**
 * Relation kinds a table list exposes: the same set `information_schema.columns`
 * reports (ordinary and partitioned tables, views, foreign tables).
 */
const LISTED_KINDS = new Set(['table', 'partitioned', 'view', 'foreign']);

export class SchemaService {
  constructor(_di: unknown) {}

  /** List user-visible schemas (excludes system/catalog schemas). */
  async listSchemas(): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ nspname: string }[]>(`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND nspname NOT LIKE 'pg_temp%'
        AND nspname NOT LIKE 'pg_toast_temp%'
      ORDER BY nspname
    `);
    return rows.map(r => r.nspname);
  }

  /**
   * The one table-shape source. Studio reads this and `RestApiService` reads the
   * same catalog snapshot, so the two cannot drift.
   *
   * `pgType` is `pg_type.typname`, byte-identical to `information_schema`'s
   * `udt_name`.
   *
   * When a transaction client is supplied the catalog is read through it and NOT
   * cached: the caller wants the schema as that transaction sees it (see
   * `SchemaMigrationService.snapshot`, which snapshots after applying DDL but
   * before commit).
   */
  async listTables(schema?: string, client?: SchemaQueryClient): Promise<TableInfo[]> {
    const nsp = assertSchema(schema);
    const catalog = client ? await loadCatalog(client) : await getCatalog();

    return catalog
      .tablesIn(nsp)
      .filter(table => LISTED_KINDS.has(table.kind))
      .map(table => ({
        name: table.name,
        // Fresh mutable objects: the snapshot itself is frozen and shared.
        columns: table.columns.map(column => ({
          name: column.name,
          type: column.pgType,
          nullable: column.nullable,
          default: column.defaultExpr,
          isPrimaryKey: column.isPk,
        })),
      }));
  }

  async listGraph(schema?: string): Promise<{ nodes: SchemaGraphNode[]; edges: SchemaGraphEdge[] }> {
    const nsp = assertSchema(schema);
    const [tables, edges] = await Promise.all([
      this.listTables(nsp),
      prisma.$queryRawUnsafe<any[]>(`
        SELECT
          tc.constraint_name,
          kcu.table_name AS from_table,
          kcu.column_name AS from_column,
          ccu.table_name AS to_table,
          ccu.column_name AS to_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
        ORDER BY kcu.table_name, kcu.column_name
      `, nsp),
    ]);

    return {
      nodes: tables.map(table => ({
        id: table.name,
        table: table.name,
        columns: table.columns,
        primaryKey: table.columns.find(column => column.isPrimaryKey)?.name ?? null,
      })),
      edges: edges.map(row => ({
        constraint: row.constraint_name,
        fromTable: row.from_table,
        fromColumn: row.from_column,
        toTable: row.to_table,
        toColumn: row.to_column,
      })),
    };
  }

  async executeRaw(sql: string, executor: Pick<Prisma.TransactionClient, '$executeRawUnsafe'> = prisma): Promise<void> {
    // Unqualified DDL resolves against `search_path` (public), so an
    // unqualified create must not collide with a Prisma-managed system table
    // now living in auth/storage/platform: that would silently orphan a
    // `public.<name>` table shadowing the real one. A statement that names its
    // own schema is checked against that schema instead.
    this.assertNoReservedTableNames(sql);
    await execDdl(executor, sql);
  }

  /** Reject CREATE TABLE statements whose name collides with a Prisma model's dbName. */
  private assertNoReservedTableNames(sql: string): void {
    const created = extractCreatedRelations(sql);
    if (!created.length) return;
    const reserved = new Set(buildTableMetadata().map(t => t.dbName.toLowerCase()));
    for (const relation of created) {
      // Only `public` can shadow a system table: a table explicitly created in
      // another schema is a different relation and collides with nothing.
      if (relation.schema && relation.schema !== 'public') continue;
      const name = relation.name;
      if (reserved.has(name.toLowerCase())) {
        throw new HttpException(
          `Cannot create table "${name}": that name is reserved by a system table. Choose a different name.`,
          400
        );
      }
    }
  }

  async addColumn(table: string, col: ColumnDef, schema?: string): Promise<void> {
    const { sql, comment } = buildAddColumnSql(table, col, schema);
    await execDdl(prisma, sql);
    if (comment) {
      // Parameter-bound: the comment text is user content, never SQL.
      await execDdl(prisma, comment.sql, comment.param);
    }
  }

  async renameColumn(table: string, from: string, to: string, schema?: string): Promise<void> {
    await execDdl(prisma, `ALTER TABLE ${qualified(table, schema)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`);
  }

  async setColumnNullable(table: string, column: string, nullable: boolean, schema?: string): Promise<void> {
    const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
    await execDdl(prisma, `ALTER TABLE ${qualified(table, schema)} ALTER COLUMN ${quoteIdent(column)} ${action}`);
  }

  async setColumnDefault(table: string, column: string, value: string | null, schema?: string): Promise<void> {
    const action = value == null ? 'DROP DEFAULT' : `SET DEFAULT ${value}`;
    await execDdl(prisma, `ALTER TABLE ${qualified(table, schema)} ALTER COLUMN ${quoteIdent(column)} ${action}`);
  }

  async dropColumn(table: string, column: string, schema?: string): Promise<void> {
    await execDdl(prisma, `ALTER TABLE ${qualified(table, schema)} DROP COLUMN ${quoteIdent(column)}`);
  }

  async dropTable(table: string, schema?: string): Promise<void> {
    await execDdl(prisma, `DROP TABLE IF EXISTS ${qualified(table, schema)} CASCADE`);
  }

  async listIndexes(
    table: string,
    schema?: string,
    client: SchemaQueryClient = prisma,
  ): Promise<IndexInfo[]> {
    const nsp = assertSchema(schema);
    const rows = await client.$queryRawUnsafe<any[]>(`
      SELECT
        i.relname AS indexname,
        pg_get_indexdef(ix.indexrelid) AS indexdef,
        ix.indisunique AS indisunique
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $2
        AND t.relname = $1
      ORDER BY i.relname
    `, table, nsp);

    return rows.map(row => ({
      name: row.indexname,
      definition: row.indexdef,
      unique: Boolean(row.indisunique),
    }));
  }

  /**
   * `method` is interpolated as a keyword, so it is checked against the known
   * access methods here as well as by the route: this is the one choke point
   * every caller of CREATE INDEX goes through.
   */
  async createIndex(
    table: string,
    columns: string[],
    unique: boolean,
    method: IndexMethod,
    schema?: string,
    name = `idx_${table}_${columns.join('_')}`,
  ): Promise<void> {
    if (!INDEX_METHODS.includes(method)) throw new HttpException(`Unknown index method: ${String(method)}`, 400);
    if (!columns.length) throw new HttpException('An index needs at least one column', 400);
    const cols = columns.map(column => quoteIdent(column)).join(', ');
    const uniq = unique ? 'UNIQUE ' : '';
    await execDdl(prisma, `CREATE ${uniq}INDEX ${quoteIdent(name)} ON ${qualified(table, schema)} USING ${method} (${cols})`);
  }

  /** Every index in a schema, with its access method, key columns and size. */
  async listSchemaIndexes(schema?: string): Promise<SchemaIndexInfo[]> {
    const nsp = assertSchema(schema);
    const rows = await prisma.$queryRawUnsafe<Array<{
      name: string; table_name: string; method: string; indisunique: boolean; indisprimary: boolean;
      columns: string[]; size_bytes: bigint; definition: string;
    }>>(`
      SELECT
        i.relname AS name,
        t.relname AS table_name,
        am.amname AS method,
        ix.indisunique,
        ix.indisprimary,
        ARRAY(
          SELECT pg_get_indexdef(ix.indexrelid, k.n, true)
          FROM generate_series(1, ix.indnkeyatts) AS k(n)
          ORDER BY k.n
        ) AS columns,
        pg_relation_size(i.oid) AS size_bytes,
        pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_am am ON am.oid = i.relam
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1
      ORDER BY t.relname, i.relname
    `, nsp);

    return rows.map(row => ({
      name: row.name,
      table: row.table_name,
      method: row.method,
      unique: row.indisunique,
      primary: row.indisprimary,
      columns: row.columns,
      sizeBytes: Number(row.size_bytes),
      definition: row.definition,
    }));
  }

  /**
   * Database > Tables. Sizes and row counts come from the catalog, never from
   * scanning: this page lists every table at once and must stay cheap on a
   * database that is also serving the app.
   */
  async listTableStats(schema?: string): Promise<TableStats[]> {
    const nsp = assertSchema(schema);
    const rows = await prisma.$queryRawUnsafe<Array<{
      name: string; relkind: string; columns: number; reltuples: number; total_bytes: bigint;
      relrowsecurity: boolean; comment: string | null;
    }>>(`
      SELECT
        c.relname AS name,
        c.relkind::text AS relkind,
        (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
        c.reltuples::float8 AS reltuples,
        pg_total_relation_size(c.oid) AS total_bytes,
        c.relrowsecurity,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY c.relname
    `, nsp);

    const kinds: Record<string, TableStats['kind']> = {
      r: 'table', p: 'partitioned', v: 'view', m: 'materialized view', f: 'foreign',
    };
    return rows.map(row => ({
      name: row.name,
      kind: kinds[row.relkind],
      columns: row.columns,
      rowsEstimate: Math.round(row.reltuples),
      totalBytes: Number(row.total_bytes),
      rlsEnabled: row.relrowsecurity,
      comment: row.comment,
    }));
  }

  async dropIndex(name: string, schema?: string): Promise<void> {
    await execDdl(prisma, `DROP INDEX IF EXISTS ${quoteIdent(assertSchema(schema))}.${quoteIdent(name)}`);
  }

  async listFunctions(schema?: string): Promise<FunctionInfo[]> {
    const nsp = assertSchema(schema);
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        p.proname AS name,
        pg_get_function_identity_arguments(p.oid) AS args,
        pg_get_function_result(p.oid) AS return_type,
        l.lanname AS language,
        pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1
        AND p.prokind = 'f'
      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
    `, nsp);

    return rows.map(row => ({
      name: row.name,
      args: row.args ?? '',
      signature: `${nsp}.${row.name}(${row.args ?? ''})`,
      returnType: row.return_type,
      language: row.language,
      definition: row.definition,
    }));
  }

  async createOrReplaceFunction(sql: string): Promise<void> {
    await execDdl(prisma, sql);
  }

  async dropFunction(signature: string): Promise<void> {
    await execDdl(prisma, `DROP FUNCTION IF EXISTS ${signature}`);
  }

  async listTriggers(schema?: string): Promise<TriggerInfo[]> {
    const nsp = assertSchema(schema);
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        t.tgname AS name,
        c.relname AS table_name,
        p.proname AS function_name,
        t.tgtype AS tgtype,
        t.tgenabled AS tgenabled,
        pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = $1
        AND NOT t.tgisinternal
        AND p.pronamespace <> 'platform'::regnamespace
      ORDER BY c.relname, t.tgname
    `, nsp);

    return rows.map(row => {
      const type = Number(row.tgtype);
      const events: string[] = [];
      if (type & (1 << 2)) events.push('INSERT');
      if (type & (1 << 3)) events.push('DELETE');
      if (type & (1 << 4)) events.push('UPDATE');
      if (type & (1 << 5)) events.push('TRUNCATE');
      return {
        name: row.name,
        table: row.table_name,
        timing: type & (1 << 6) ? 'INSTEAD OF' : type & (1 << 1) ? 'BEFORE' : 'AFTER',
        events,
        orientation: type & (1 << 0) ? 'ROW' : 'STATEMENT',
        function: row.function_name,
        enabled: row.tgenabled !== 'D',
        definition: row.definition,
      } as TriggerInfo;
    });
  }

  /**
   * Functions usable as trigger targets (those returning `trigger`).
   *
   * Schema-scoped, like every other list here. Asking `public` unconditionally
   * is what made the trigger form say "create a trigger function first" while
   * looking straight past the ones defined in the schema the operator had
   * selected.
   */
  async listTriggerFunctions(schema?: string): Promise<FunctionInfo[]> {
    const functions = await this.listFunctions(schema);
    return functions.filter(fn => fn.returnType === 'trigger');
  }

  async createTrigger(sql: string): Promise<void> {
    await execDdl(prisma, sql);
  }

  async setTriggerEnabled(table: string, name: string, enabled: boolean, schema?: string): Promise<void> {
    const action = enabled ? 'ENABLE' : 'DISABLE';
    await execDdl(prisma, `ALTER TABLE ${qualified(table, schema)} ${action} TRIGGER ${quoteIdent(name)}`);
  }

  async dropTrigger(table: string, name: string, schema?: string): Promise<void> {
    await execDdl(prisma, `DROP TRIGGER IF EXISTS ${quoteIdent(name)} ON ${qualified(table, schema)}`);
  }

  async listExtensions(): Promise<ExtensionInfo[]> {
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT name, default_version, installed_version, comment
      FROM pg_available_extensions
      ORDER BY name
    `);

    return rows.map(row => ({
      name: row.name,
      defaultVersion: row.default_version ?? '',
      installedVersion: row.installed_version ?? null,
      installed: row.installed_version != null,
      comment: row.comment ?? '',
    }));
  }

  /**
   * Extension names cannot go through `quoteIdent`: legal names contain hyphens
   * (`uuid-ossp`, `pgrouting-*`) and that regex rejects them. They also cannot be
   * interpolated raw: the name arrives from a route parameter, and a double
   * quote inside it would close the quoted identifier and append arbitrary DDL.
   *
   * So validate against the authoritative list Postgres itself reports, bound as
   * a parameter, and quote by doubling. An unknown name is rejected before any
   * DDL is built, which also turns a typo into a clear 400 instead of a raw
   * Postgres error.
   */
  private async assertKnownExtension(name: string): Promise<string> {
    if (typeof name !== 'string' || !name.length || name.length > 63) {
      throw new HttpException(`Invalid extension name: ${String(name)}`, 400);
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM pg_available_extensions WHERE name = $1`,
      name,
    );
    if (!rows.length) throw new HttpException(`Unknown extension: ${name}`, 400);
    return `"${rows[0].name.replace(/"/g, '""')}"`;
  }

  async enableExtension(name: string): Promise<void> {
    const ident = await this.assertKnownExtension(name);
    await execDdl(prisma, `CREATE EXTENSION IF NOT EXISTS ${ident}`);
  }

  async disableExtension(name: string): Promise<void> {
    const ident = await this.assertKnownExtension(name);
    await execDdl(prisma, `DROP EXTENSION IF EXISTS ${ident}`);
  }
}
