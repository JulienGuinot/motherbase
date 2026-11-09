// The catalog spine: ONE cached snapshot of the live Postgres schema that every
// other layer reads. REST model resolution, Studio's table list, the schema
// graph, type generation and the MCP schema tools all consume this, so they can
// never disagree about what a table looks like.
//
// The module is split by responsibility: `types.ts` (shapes), `pg-types.ts`
// (Postgres -> TypeScript), `queries.ts` (the pg_catalog reads), `snapshot.ts`
// (rows -> frozen snapshot). This file owns loading and caching only.
//
// Design notes:
//   - Lazy, never eager. Nothing here runs at import time, so a process can boot
//     while the database is unreachable and heal on the first successful load.
//   - Per-process cache. A DDL statement run by another server process is not
//     seen here until the TTL elapses; the TTL exists purely as that safety net,
//     while `invalidateCatalog()` (called from the DDL choke point in
//     `schema-ddl.ts`) gives same-process, same-request freshness.
//   - Foreign keys are recorded in BOTH directions, because PostgREST-style
//     embedding needs to walk parent -> child as well as child -> parent, and
//     retrofitting the inbound direction later is expensive.

import prisma from '../../../lib/prisma';
import { buildSnapshot } from './snapshot';
import {
  COLUMNS_SQL,
  COMPOSITE_TYPES_SQL,
  ENUMS_SQL,
  FOREIGN_KEYS_SQL,
  FUNCTIONS_SQL,
  FUNCTION_ARGS_SQL,
  INDEXES_SQL,
  RELATIONS_SQL,
  type ColumnRow,
  type CompositeRow,
  type EnumRow,
  type ForeignKeyRow,
  type FunctionArgRow,
  type FunctionRow,
  type IndexRow,
  type RelationRow,
} from './queries';
import type { CatalogExecutor, CatalogSnapshot } from './types';

export { pgTypeToTsType, type PgTypeRef } from './pg-types';
export { makeCatalogSnapshot } from './snapshot';
export type {
  CatalogColumn,
  CatalogCompositeType,
  CatalogEnum,
  CatalogExecutor,
  CatalogForeignKey,
  CatalogFunction,
  CatalogRelKind,
  CatalogSnapshot,
  CatalogTable,
  PgTypeKind,
} from './types';

/**
 * Safety net for the multi-process case: another server process running DDL
 * cannot call our `invalidateCatalog()`, so a snapshot older than this is
 * reloaded. Same-process freshness is exact and does not rely on the TTL.
 */
const CATALOG_TTL_MS = 30_000;

let cached: CatalogSnapshot | null = null;
let versionToken = 0;
let inflight: Promise<CatalogSnapshot> | null = null;

/** Current cache-version token. Bumped by every `invalidateCatalog()` call. */
export function catalogVersion(): number {
  return versionToken;
}

/**
 * Drop the cached snapshot. Called from the DDL choke point in `schema-ddl.ts`
 * so the very next request sees the new shape without a restart.
 */
export function invalidateCatalog(): void {
  versionToken += 1;
  cached = null;
  // An in-flight load started before this call describes the pre-DDL schema; it
  // is dropped here and its result will be refused by the version check below.
  inflight = null;
}

/** Query the database and build a fresh snapshot. Never touches the cache. */
export async function loadCatalog(exec: CatalogExecutor = prisma): Promise<CatalogSnapshot> {
  const [relations, columns, indexes, foreignKeys, enums, composites, functions, functionArgs] =
    await Promise.all([
      exec.$queryRawUnsafe<RelationRow[]>(RELATIONS_SQL),
      exec.$queryRawUnsafe<ColumnRow[]>(COLUMNS_SQL),
      exec.$queryRawUnsafe<IndexRow[]>(INDEXES_SQL),
      exec.$queryRawUnsafe<ForeignKeyRow[]>(FOREIGN_KEYS_SQL),
      exec.$queryRawUnsafe<EnumRow[]>(ENUMS_SQL),
      exec.$queryRawUnsafe<CompositeRow[]>(COMPOSITE_TYPES_SQL),
      exec.$queryRawUnsafe<FunctionRow[]>(FUNCTIONS_SQL),
      exec.$queryRawUnsafe<FunctionArgRow[]>(FUNCTION_ARGS_SQL),
    ]);
  return buildSnapshot(
    versionToken,
    relations,
    columns,
    indexes,
    foreignKeys,
    enums,
    composites,
    functions,
    functionArgs,
  );
}

/**
 * The cached snapshot, loading it on first use. Lazy on purpose: a process must
 * be able to boot with the database down and recover on the first request that
 * succeeds. A failed load leaves the cache empty so the next call retries.
 */
export async function getCatalog(exec: CatalogExecutor = prisma): Promise<CatalogSnapshot> {
  if (cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) return cached;
  if (inflight) return inflight;

  const startedAtVersion = versionToken;
  const load = loadCatalog(exec)
    .then(snapshot => {
      // Refuse to install a snapshot that was already invalidated mid-flight,
      // otherwise a slow read could resurrect a pre-DDL view of the schema.
      if (versionToken === startedAtVersion) cached = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (inflight === load) inflight = null;
    });

  inflight = load;
  return load;
}

/**
 * Test seam: install a snapshot without a database. Production code must not
 * call this; it exists so unit tests can drive REST/Studio table resolution.
 */
export function __primeCatalogForTests(snapshot: CatalogSnapshot | null): void {
  cached = snapshot;
  inflight = null;
}
