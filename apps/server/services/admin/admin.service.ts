import os from 'os';
import fs from 'fs';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { INTERNAL_TABLE_RE } from '../../constants/regex.constants';
import { isSensitiveField, maskRow } from '../../constants/admin.constants';
import { HttpException } from '../../exceptions/http-exception';
import { shieldTelemetry } from '../../lib/shield-telemetry';
import { AdminPerformanceService, type PerformanceReport } from './admin-performance.service';
import { buildRowFilterSql, buildRowFilterPrismaWhere, type RowFilter } from './row-filters';

export type { PerformanceReport } from './admin-performance.service';

export interface FieldMeta {
  name: string;
  type: string;
  kind: 'scalar' | 'object' | 'enum';
  isId: boolean;
  isList: boolean;
  isRequired: boolean;
  isReadOnly: boolean;
  relationName?: string;
  sensitive: boolean;
}

export interface TableMeta {
  model: string; // PascalCase Prisma model name, e.g. "User"; for dynamic tables same as dbName
  delegate: string; // lower-camel client key, e.g. "user"; for dynamic tables same as dbName
  dbName: string; // mapped table name, e.g. "users"
  primaryKey: string;
  fields: FieldMeta[];
  dynamic?: boolean; // true for tables created at runtime (not in schema.prisma)
  schema: string; // Postgres schema the table lives in; 'public' for user/dynamic tables
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** `"schema"."table"`, so a raw statement never depends on search_path. */
function qualifiedName(table: { schema: string; dbName: string }): string {
  return `"${table.schema}"."${table.dbName}"`;
}

/**
 * A request may address a table by its Prisma model name, its physical table
 * name, or the qualified `schema.table` id. A bare physical name only matches a
 * table in `public`: outside it the qualified form is the only accepted
 * identity, so two same-named tables in two schemas can never be confused.
 */
function matchesModel(table: TableMeta, model: string): boolean {
  if (table.model === model) return true;
  if (model.includes('.')) {
    const [schema, name] = model.split('.');
    return table.schema === schema && table.dbName === name;
  }
  return table.dbName === model && table.schema === 'public';
}

/**
 * Prisma's DMMF (as of prisma@5.22) does not surface the `@@schema(...)`
 * attribute on `Prisma.dmmf.datamodel.models[]` at runtime, even with
 * `multiSchema` enabled. We parse `prisma/schema.prisma` once at module load
 * to build a model-name -> Postgres schema lookup used by buildTableMetadata.
 */
function resolveSchemaPrismaPath(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'prisma', 'schema.prisma'),
    path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    path.join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function parseModelSchemas(schemaPath: string | undefined): Record<string, string> {
  if (!schemaPath) return {};
  const content = fs.readFileSync(schemaPath, 'utf8');
  const map: Record<string, string> = {};
  // Assumes model bodies have no nested `{ ... }` blocks (true for plain field/attribute lists).
  const modelRegex = /\bmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = modelRegex.exec(content))) {
    const [, name, body] = match;
    const schemaMatch = body.match(/@@schema\("(\w+)"\)/);
    map[name] = schemaMatch ? schemaMatch[1] : 'public';
  }
  return map;
}

function buildModelSchemas(): Record<string, string> {
  const schemaPath = resolveSchemaPrismaPath();
  const map = parseModelSchemas(schemaPath);
  const runtimeModels = Prisma.dmmf.datamodel.models.map(m => m.name);
  const missing = runtimeModels.filter(name => !map[name]);

  if (Object.keys(map).length === 0 || missing.length > 0) {
    const attempted = schemaPath ?? '(no candidate path resolved)';
    throw new Error(
      `admin.service: failed to build the Prisma model -> Postgres schema map from ` +
        `"${attempted}". ` +
        (Object.keys(map).length === 0
          ? 'The parsed map is empty (file missing, unreadable, or contained no `model` blocks). '
          : `Missing schema tags for model(s): ${missing.join(', ')}. `) +
        'Without this map every table silently falls back to the "public" Postgres schema, ' +
        'defeating schema separation. Fix prisma/schema.prisma resolution/content before starting the server.'
    );
  }

  return map;
}

export const MODEL_SCHEMAS = buildModelSchemas();

/** Tables that should never appear as user-editable models. */
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

export function buildTableMetadata(): TableMeta[] {
  return Prisma.dmmf.datamodel.models.map(model => {
    const idField = model.fields.find(f => f.isId);
    return {
      model: model.name,
      delegate: lowerFirst(model.name),
      dbName: model.dbName ?? model.name,
      primaryKey: idField?.name ?? 'id',
      schema: MODEL_SCHEMAS[model.name] ?? (model as any).schema ?? 'public',
      fields: model.fields.map(f => ({
        name: f.name,
        type: String(f.type),
        kind: f.kind as FieldMeta['kind'],
        isId: Boolean(f.isId),
        isList: Boolean(f.isList),
        isRequired: Boolean(f.isRequired),
        // Not the DMMF's own isReadOnly: Prisma sets that on every foreign key
        // scalar (`Device.userId`), meaning "also settable through the
        // relation", not "unwritable". Passing it through hid `userId` from the
        // new-row form, so every insert into such a table failed on the missing
        // owner. createRow/updateRow write scalars, which Prisma accepts as-is.
        isReadOnly: false,
        relationName: f.relationName,
        sensitive: isSensitiveField(f.name),
      })),
    };
  });
}

/** Largest page the console can ask for; mirrors the grid's page-size picker. */
const MAX_PAGE_SIZE = 200;

/**
 * Row count above which an unfiltered total is taken from the planner rather
 * than scanned. Below it an exact COUNT(*) is a few milliseconds and precision
 * is free.
 */
const EXACT_COUNT_MAX_ROWS = 50_000;

export interface RowsPage {
  rows: any[];
  total: number;
  /** True when `total` is the planner's estimate rather than an exact count. */
  estimated: boolean;
  page: number;
  pageSize: number;
}

/**
 * Identity of a table as the console addresses it.
 *
 * `public` tables keep their bare name so every existing URL and saved view
 * still resolves. Anything else is qualified, because a bare name is not an
 * identity: `reporting.orders` and `public.orders` are two different tables,
 * and collapsing them is how a row edit lands in the wrong one.
 */
export function tableModelId(schema: string, name: string): string {
  return schema === 'public' ? name : `${schema}.${name}`;
}

export class AdminService extends BaseContext {
  /**
   * TableMeta for every table in the database that is not in schema.prisma,
   * across every schema, each stamped with its own schema. A name is only
   * dropped when it collides with a Prisma model in the SAME schema.
   */
  private async getDynamicTables(): Promise<TableMeta[]> {
    if (!this.di.SchemaService?.listTables) return [];

    // Collisions are per schema: `platform.files` must not hide `public.files`.
    const prismaKeys = new Set(buildTableMetadata().map(m => `${m.schema}.${m.dbName}`.toLowerCase()));
    const schemas = await this.di.SchemaService.listSchemas().catch(() => ['public']);

    const perSchema = await Promise.all(
      schemas.map(async schema => {
        const tables = await this.di.SchemaService.listTables(schema).catch(() => []);
        return tables
          .filter(t => !INTERNAL_TABLE_RE.test(t.name) && !prismaKeys.has(`${schema}.${t.name}`.toLowerCase()))
          .map(t => {
            const pkCol = t.columns.find(c => c.isPrimaryKey) ?? t.columns[0];
            const meta: TableMeta = {
              model: tableModelId(schema, t.name),
              delegate: t.name,
              dbName: t.name,
              primaryKey: pkCol?.name ?? 'id',
              dynamic: true,
              schema,
              fields: t.columns.map(col => ({
                name: col.name,
                type: col.type,
                kind: 'scalar' as const,
                isId: col.isPrimaryKey,
                isList: false,
                isRequired: !col.nullable,
                isReadOnly: false,
                relationName: undefined,
                sensitive: false,
              })),
            };
            return meta;
          });
      })
    );
    return perSchema.flat();
  }

  async listTables(): Promise<TableMeta[]> {
    const [prismaModels, dynamic] = await Promise.all([
      Promise.resolve(buildTableMetadata()),
      this.getDynamicTables(),
    ]);
    return [...prismaModels, ...dynamic];
  }

  private async tableOrThrow(model: string): Promise<TableMeta> {
    // Fast path: Prisma DMMF (sync)
    const prisma = buildTableMetadata().find(t => matchesModel(t, model));
    if (prisma) return prisma;

    // Slow path: dynamic tables
    const dynamic = await this.getDynamicTables();
    const table = dynamic.find(t => matchesModel(t, model));
    if (!table) throw new HttpException(`Unknown model: ${model}`, 404);
    return table;
  }

  private prismaDelegate(model: string): any {
    const table = buildTableMetadata().find(t => t.model === model || t.dbName === model);
    if (!table) throw new HttpException(`No Prisma delegate for: ${model}`, 404);
    const delegate = (this.di.prisma as any)[table.delegate];
    if (!delegate) throw new HttpException(`No Prisma delegate for: ${model}`, 404);
    return delegate;
  }

  // ── Raw SQL helpers for dynamic tables ────────────────────────────────────

  private async listRowsRaw(
    table: TableMeta,
    opts: { page: number; pageSize: number; sort?: string; order?: 'asc' | 'desc'; filters?: RowFilter[] }
  ): Promise<RowsPage> {
    const { page, pageSize } = opts;
    const validCols = new Set(table.fields.map(f => f.name));
    const sort = opts.sort && validCols.has(opts.sort) ? opts.sort : null;
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const orderSql = sort ? `ORDER BY "${sort}" ${order}` : '';

    const filters = opts.filters ?? [];
    const { clause, params } = buildRowFilterSql(filters, table.fields);

    const relation = qualifiedName(table);
    const [rows, count] = await Promise.all([
      this.di.prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM ${relation} ${clause} ${orderSql} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        ...params
      ),
      this.countRows(table, filters.length > 0, async () => {
        const countRows = await this.di.prisma.$queryRawUnsafe<[{ count: bigint }]>(
          `SELECT COUNT(*) AS count FROM ${relation} ${clause}`,
          ...params
        );
        return Number(countRows[0].count);
      }),
    ]);

    return { rows, total: count.total, estimated: count.estimated, page, pageSize };
  }

  /** Column names are interpolated as quoted identifiers, so only catalog columns may reach the SQL. */
  private assertKnownColumns(table: TableMeta, keys: string[]): void {
    const known = new Set(table.fields.map(f => f.name));
    const unknown = keys.find(k => !known.has(k));
    if (unknown !== undefined) throw new HttpException(`Unknown column: ${unknown}`, 400);
  }

  private async createRowRaw(table: TableMeta, data: Record<string, any>): Promise<any> {
    const keys = Object.keys(data);
    this.assertKnownColumns(table, keys);
    if (!keys.length) {
      const rows = await this.di.prisma.$queryRawUnsafe<any[]>(
        `INSERT INTO ${qualifiedName(table)} DEFAULT VALUES RETURNING *`
      );
      return rows[0];
    }
    const cols = keys.map(k => `"${k}"`).join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this.di.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO ${qualifiedName(table)} (${cols}) VALUES (${params}) RETURNING *`,
      ...Object.values(data)
    );
    return rows[0];
  }

  private async updateRowRaw(table: TableMeta, id: string, data: Record<string, any>): Promise<any> {
    const keys = Object.keys(data);
    this.assertKnownColumns(table, keys);
    if (!keys.length) return null;
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const rows = await this.di.prisma.$queryRawUnsafe<any[]>(
      `UPDATE ${qualifiedName(table)} SET ${sets} WHERE "${table.primaryKey}" = $${keys.length + 1} RETURNING *`,
      ...Object.values(data),
      id
    );
    return rows[0] ?? null;
  }

  private async deleteRowRaw(table: TableMeta, id: string): Promise<void> {
    await this.di.prisma.$executeRawUnsafe(
      `DELETE FROM ${qualifiedName(table)} WHERE "${table.primaryKey}" = $1`,
      id
    );
  }

  // ── Public row CRUD ────────────────────────────────────────────────────────

  async listRows(
    model: string,
    opts: { page?: number; pageSize?: number; sort?: string; order?: 'asc' | 'desc'; filters?: RowFilter[] } = {}
  ): Promise<RowsPage> {
    const table = await this.tableOrThrow(model);
    const page = Math.max(1, opts.page ?? 1);
    // Must match the largest page size the console's picker offers, or the
    // pager computes the wrong number of pages.
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? 25));
    const filters = opts.filters ?? [];

    if (table.dynamic) return this.listRowsRaw(table, { page, pageSize, sort: opts.sort, order: opts.order, filters });

    const delegate = this.prismaDelegate(model);
    const orderBy =
      opts.sort && table.fields.some(f => f.name === opts.sort && f.kind === 'scalar')
        ? { [opts.sort]: opts.order === 'desc' ? 'desc' : 'asc' }
        : undefined;
    const where = buildRowFilterPrismaWhere(filters, table.fields);

    const [rows, count] = await Promise.all([
      delegate.findMany({ skip: (page - 1) * pageSize, take: pageSize, orderBy, where }),
      this.countRows(table, filters.length > 0, () => delegate.count({ where })),
    ]);
    return { rows: rows.map((r: any) => maskRow(r)), total: count.total, estimated: count.estimated, page, pageSize };
  }

  /**
   * Row total for the grid's pager.
   *
   * A filtered view has to be counted exactly: the number must agree with the
   * rows the filter actually returns. An unfiltered one does not, and that is
   * the case that hurts: `SELECT COUNT(*)` with no WHERE is a full scan in
   * Postgres, so simply opening the table editor on a few-million-row events or
   * log table cost a seconds-long scan on every page turn, on the same database
   * serving the application.
   *
   * Above {@link EXACT_COUNT_MAX_ROWS} the planner's own estimate is used
   * instead. It is an index lookup on pg_class, it is what Postgres itself
   * plans with, and it is flagged as approximate so the console can say so
   * rather than print a precise-looking lie.
   */
  private async countRows(
    table: TableMeta,
    filtered: boolean,
    exact: () => Promise<number>
  ): Promise<{ total: number; estimated: boolean }> {
    if (filtered) return { total: await exact(), estimated: false };

    const estimate = await this.estimatedRowCount(table);
    // `null` is a table the planner has no statistics for (never analyzed, or
    // reltuples = -1 on PG14+). Unknown size means count it properly.
    if (estimate === null || estimate < EXACT_COUNT_MAX_ROWS) {
      return { total: await exact(), estimated: false };
    }
    return { total: estimate, estimated: true };
  }

  private async estimatedRowCount(table: TableMeta): Promise<number | null> {
    try {
      // The identifier is passed as a *value* to to_regclass, never interpolated.
      const rows = await this.di.prisma.$queryRawUnsafe<Array<{ estimate: bigint | null }>>(
        'SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = to_regclass($1)',
        `"${table.schema}"."${table.dbName}"`
      );
      const estimate = rows[0]?.estimate;
      if (estimate === null || estimate === undefined) return null;
      const value = Number(estimate);
      return value < 0 ? null : value;
    } catch {
      // Never let a statistics lookup fail a page of rows.
      return null;
    }
  }

  async createRow(model: string, data: Record<string, any>): Promise<any> {
    const table = await this.tableOrThrow(model);
    if (table.dynamic) return this.createRowRaw(table, data);
    return maskRow(await this.prismaDelegate(model).create({ data }));
  }

  async updateRow(model: string, id: string, data: Record<string, any>): Promise<any> {
    const table = await this.tableOrThrow(model);
    if (table.dynamic) return this.updateRowRaw(table, id, data);
    return maskRow(await this.prismaDelegate(model).update({ where: { [table.primaryKey]: id }, data }));
  }

  async deleteRow(model: string, id: string): Promise<void> {
    const table = await this.tableOrThrow(model);
    if (table.dynamic) return this.deleteRowRaw(table, id);
    await this.prismaDelegate(model).delete({ where: { [table.primaryKey]: id } });
  }

  async performance(): Promise<PerformanceReport> {
    return new AdminPerformanceService(this.di.prisma).report();
  }

  private async dbConnectionCount(): Promise<number> {
    const rows = await this.di.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity`
    );
    return Number(rows[0]?.count ?? 0);
  }

  private currentEventLoopLagMs(): number {
    const meanNs = eventLoopDelay.mean;
    const lagMs = Number.isFinite(meanNs) ? meanNs / 1_000_000 : 0;
    eventLoopDelay.reset();
    return Math.round(lagMs * 100) / 100;
  }

  async stats(): Promise<{
    counts: Array<{ model: string; count: number, schema: string }>;
    system: {
      uptimeSec: number;
      memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
      loadAverage: number[];
      cpuCount: number;
      platform: string;
      eventLoopLagMs: number;
      dbConnections: number;
      requestThroughput: { windowMs: number; requests: number; rps: number };
      p95LatencyMs: number;
    };
  }> {
    const tables = await this.listTables();
    const dbConnections = this.dbConnectionCount();
    const counts = await Promise.all(
      tables.map(async t => {
        // One unreadable table (dropped mid-flight, no privilege) must not take
        // the whole overview down with it: report it as 0 and keep the rest.
        try {
          if (t.dynamic) {
            const result = await this.di.prisma.$queryRawUnsafe<[{ count: bigint }]>(
              `SELECT COUNT(*) AS count FROM ${qualifiedName(t)}`
            );
            return { model: t.model, count: Number(result[0].count), schema: t.schema };
          }
          const delegate = (this.di.prisma as any)[t.delegate];
          const count = delegate?.count ? await delegate.count() : 0;
          return { model: t.model, count, schema: t.schema };
        } catch {
          return { model: t.model, count: 0, schema: t.schema };
        }
      })
    );
    const memory = process.memoryUsage();
    const runtime = shieldTelemetry.runtimeSummary();
    return {
      counts,
      system: {
        uptimeSec: Math.floor(process.uptime()),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
        },
        loadAverage: os.loadavg(),
        cpuCount: os.cpus().length,
        platform: `${os.type()} ${os.release()}`,
        eventLoopLagMs: this.currentEventLoopLagMs(),
        dbConnections: await dbConnections,
        requestThroughput: {
          windowMs: runtime.windowMs,
          requests: runtime.requests,
          rps: runtime.throughputRps,
        },
        p95LatencyMs: runtime.p95Ms,
      },
    };
  }
}
