// `motherbase gen types typescript`.
//
// Turns the catalog spine (services/rest-api/catalog) into the exact `Database`
// type shape supabase-js emits, so an application migrating from Supabase keeps
// its `database.types.ts` import path, its `Tables<'x'>` helpers and every
// third-party tool that reads that shape. Anything we invent here is a
// migration tax, so the output format is copied, not improved.
//
// Two stages, deliberately separate:
//   1. `buildTypegenCatalog` (./catalog) produces STRUCTURED data. That is what
//      `GET /admin/schema/types` returns, so the CLI, the Studio and a future
//      MCP server all read one source of truth instead of parsing a string.
//   2. `renderTypescript` (./render) turns that structure into the file.
//      Rendering lives on the server so there is exactly one emitter; a CLI that
//      re-implemented it would drift within a release.

import prisma from '../../../lib/prisma';
import { getCatalog, type CatalogExecutor } from '../../rest-api/catalog';
import {
  assertSchemaName,
  buildTypegenCatalog,
  FUNCTIONS_SQL,
  FUNCTION_ARGS_SQL,
  type FunctionArgRow,
  type FunctionRow,
} from './catalog';
import { renderTypescript } from './render';
import { renderZod } from './render-zod';
import type { TypegenResources, TypegenResult } from './types';

export { assertSchemaName } from './catalog';
export { renderTypescript } from './render';
export { renderZod } from './render-zod';
export type { TypegenCatalog, TypegenResources, TypegenResult } from './types';

/**
 * Edge function routes and bucket slugs, sorted here rather than by Postgres:
 * `--check` diffs the rendered file across machines, and an ORDER BY follows
 * the database's collation.
 */
export async function loadTypegenResources(): Promise<TypegenResources> {
  const [functions, buckets] = await Promise.all([
    prisma.edgeFunction.findMany({ select: { route: true } }),
    prisma.bucket.findMany({ select: { slug: true } }),
  ]);
  return {
    edgeFunctions: functions.map(fn => fn.route).sort(),
    buckets: buckets.map(bucket => bucket.slug).sort(),
  };
}

/**
 * Load the catalog for `schema` and render the TypeScript definitions.
 * Returns both the structured catalog and the rendered file: the admin endpoint
 * hands the structure to Studio and MCP, while the CLI writes `types` to disk.
 */
export async function generateTypescriptTypes(
  schema = 'public',
  exec: CatalogExecutor = prisma,
  loadResources: () => Promise<TypegenResources> = loadTypegenResources,
): Promise<TypegenResult> {
  const target = assertSchemaName(schema);
  const [snapshot, functionRows, argRows, resources] = await Promise.all([
    getCatalog(exec),
    exec.$queryRawUnsafe<FunctionRow[]>(FUNCTIONS_SQL, target),
    exec.$queryRawUnsafe<FunctionArgRow[]>(FUNCTION_ARGS_SQL, target),
    loadResources(),
  ]);

  const catalog = buildTypegenCatalog(snapshot, functionRows, argRows, target);
  // Both renderings come from one catalog read: the zod file is a few hundred
  // bytes next to a round trip to Postgres, and returning them together keeps
  // the two from ever describing different snapshots of the schema.
  return {
    schema: target,
    catalog,
    resources,
    types: renderTypescript(catalog, resources),
    zod: renderZod(catalog),
  };
}
