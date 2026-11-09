// What the REST API is allowed to expose, and the model shape it exposes it as.
//
// Every rule about which relation a request may reach lives here, so the URL
// path, an embedded relation and a write body all pass through the same gate.
// Pure: no `this`, no database, no request state.

import { INTERNAL_TABLE_RE } from '../../constants/regex.constants';
import { HttpException } from '../../exceptions/http-exception';
import { getCatalog, type CatalogSnapshot, type CatalogTable } from './catalog';
import { isRestBlockedModel } from './policy-types';
import { quoteIdent } from '../admin/schema-ddl';
import { assertColumn, createContext, createParams } from './sql-compiler';
import type { Filter } from './postgrest-parser';
import type { RlsUser } from '../../lib/rls-claims';

export interface RestFieldMeta {
  name: string;
  type: string;
  kind: string;
  isList: boolean;
}

export interface RestModelMeta {
  model: string;
  dbName: string;
  /** Always REST_SCHEMA. Kept explicit so generated SQL is schema-qualified. */
  schema: string;
  fields: RestFieldMeta[];
  system: boolean;
  dynamic: boolean;
}

/** A resolved request target: the catalog row plus the legacy model projection. */
export interface RestTarget {
  table: CatalogTable;
  model: RestModelMeta;
}

/**
 * The REST API exposes the `public` schema and nothing else. Every
 * Motherbase-managed table lives in `auth`, `storage` or `platform`, so this one
 * rule keeps system tables unreachable; `isRestBlockedModel` below is the
 * defence-in-depth second gate for names that could be recreated in `public`.
 */
export const REST_SCHEMA = 'public';

/**
 * Schemas whose functions `/rpc/` may call besides `public`, reached the way
 * PostgREST reaches any schema: a `Content-Profile` (POST) or `Accept-Profile`
 * (GET) header, which `client.schema(name).rpc()` sends.
 *
 * Each belongs to a feature that creates the schema when it is switched on
 * (Queues' "expose via the API" creates `pgmq_public`), and each is served only
 * while it has functions in it: dropping the schema is what un-exposes it, with
 * no second switch to forget. Tables stay `public`-only whatever the header.
 */
export const OPTIONAL_RPC_SCHEMAS: readonly string[] = ['pgmq_public'];

/** `public`, plus every optional schema that currently exists in the catalog. */
export function exposedRpcSchemas(catalog: Pick<CatalogSnapshot, 'functions'>): string[] {
  const present = new Set(catalog.functions.map(fn => fn.schema));
  return [REST_SCHEMA, ...OPTIONAL_RPC_SCHEMAS.filter(schema => present.has(schema))];
}

/**
 * The schema an `/rpc/` call targets. No header means `public`, as in PostgREST;
 * a schema that is not exposed is refused with PostgREST's own code and the list
 * of the ones that are, rather than silently falling back to `public`.
 */
export function resolveRpcSchema(catalog: Pick<CatalogSnapshot, 'functions'>, requested?: string): string {
  if (!requested) return REST_SCHEMA;
  const exposed = exposedRpcSchemas(catalog);
  if (exposed.includes(requested)) return requested;
  throw new HttpException(`The schema must be one of the following: ${exposed.join(', ')}`, 406, 'PGRST106', {
    expose: true,
  });
}

/**
 * Table routes serve `public` only. A profile header naming another schema is a
 * client asking for tables this API does not publish, and answering from
 * `public` under that name would return the wrong rows.
 */
export function assertTableProfile(requested?: string): void {
  if (!requested || requested === REST_SCHEMA) return;
  throw new HttpException(
    `The schema must be one of the following: ${REST_SCHEMA}. Tables are served from ${REST_SCHEMA} only; ` +
      `functions in ${requested} can be called through /rpc/.`,
    406,
    'PGRST106',
    { expose: true },
  );
}

/** Column the exact-count window function is projected under, then stripped. */
export const COUNT_COLUMN = '__mb_count';

/**
 * Base tables only. Views and materialized views cannot carry row-level
 * security, so they could never pass the `relrowsecurity` gate in `withRls`;
 * excluding them here turns a misleading 403 into an honest 404 and keeps the
 * exposed surface to relations RLS can actually protect.
 */
export function isRestExposable(table: CatalogTable): boolean {
  return (table.kind === 'table' || table.kind === 'partitioned') && !INTERNAL_TABLE_RE.test(table.name);
}

/**
 * Project a catalog table onto the model shape the rest of the app consumes
 * (`RealtimeOutboxService.enqueue`, `RealtimeBroadcastService`, `AdvisorService`,
 * `RealtimeAdminService`). Model name and physical name are the same thing now
 * that there is no Prisma name-mapping layer in the REST path.
 */
export function toRestModel(table: CatalogTable): RestModelMeta {
  return {
    model: table.name,
    dbName: table.name,
    schema: table.schema,
    system: isRestBlockedModel(table.name),
    dynamic: true,
    fields: table.columns.map(column => ({
      name: column.name,
      type: column.pgType,
      kind: 'scalar',
      isList: column.isArray,
    })),
  };
}

/** Resolve a URL model name to a target, or fail with the honest status code. */
export async function targetOrThrow(name: string): Promise<RestTarget> {
  // Exact, case-sensitive match, the way Postgres resolves a quoted name.
  const catalog = await getCatalog();
  const table = catalog.table(REST_SCHEMA, name);
  if (!table || !isRestExposable(table)) throw new HttpException(`Unknown model: ${name}`, 404);
  const model = toRestModel(table);
  if (model.system) throw new HttpException(`Model '${model.model}' is not exposed by the REST API`, 403);
  return { table, model };
}

/**
 * The exposure rules, applied to a table reached through an embed exactly as
 * they are applied to the table named in the URL. Without this an embed would
 * be a sideways path to `app_settings` or to a view, around every check the
 * top-level resolver performs.
 */
export function assertEmbeddable(table: CatalogTable): void {
  if (table.schema !== REST_SCHEMA || !isRestExposable(table)) {
    throw new HttpException(`Cannot embed "${table.name}": it is not exposed by the REST API.`, 400, 'PGRST200', {
      expose: true,
    });
  }
  if (isRestBlockedModel(table.name)) {
    throw new HttpException(`Model '${table.name}' is not exposed by the REST API`, 403);
  }
}

/** Schema-qualified, quoted relation. Never depends on the session search_path. */
export function relationSql(model: RestModelMeta): string {
  return `${quoteIdent(model.schema)}.${quoteIdent(model.dbName)}`;
}

/** Write-body keys go through the same catalog allowlist as filter columns. */
export function assertKnownDataFields(target: RestTarget, data: Record<string, unknown>): void {
  const ctx = createContext(target.table, createParams());
  for (const field of Object.keys(data)) assertColumn(ctx, field);
}

export function assertPatchBody(target: RestTarget, data: Record<string, unknown>): void {
  assertKnownDataFields(target, data);
  if (!Object.keys(data).length) throw new HttpException('PATCH body must include at least one field.', 400);
}

/**
 * Refuse an unfiltered PATCH/DELETE (which would hit every row) unless the
 * caller is an admin. Owner/scoped policies inject a filter, so a legitimately
 * scoped request always has a filter tree.
 */
export function assertScopedMutation(filter: Filter | null, user?: RlsUser): void {
  if (filter === null && user?.role !== 'ADMIN') {
    throw new HttpException(
      'A filter is required for bulk update/delete (refusing to affect the entire table).',
      400
    );
  }
}

/**
 * The `ON CONFLICT` column list: `?on_conflict=` when given, the primary key
 * otherwise. Every name is validated against the catalog, so the conflict
 * target goes through the same allowlist as any other column reference.
 */
export function conflictTarget(target: RestTarget, query: Record<string, unknown>): string[] {
  const raw = query?.on_conflict;
  const requested = raw == null ? [] : String(Array.isArray(raw) ? raw[raw.length - 1] : raw).split(',');
  const columns = requested.map(name => name.trim()).filter(Boolean);
  const ctx = createContext(target.table, createParams());

  if (columns.length) {
    for (const column of columns) assertColumn(ctx, column);
    return columns;
  }
  if (!target.table.primaryKey.length) {
    throw new HttpException(
      `Cannot upsert into ${target.model.model}: it has no primary key, so ?on_conflict= is required.`,
      400,
      'PGRST100',
      { expose: true },
    );
  }
  return target.table.primaryKey.slice();
}
