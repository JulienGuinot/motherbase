// Catalog assembly: the live Postgres catalog -> the structured `TypegenCatalog`.
// Pure data, no rendering. Function introspection lives here because functions
// are needed only by type generation, so they are not carried in the shared
// per-request catalog snapshot.

import {
  pgTypeToTsType,
  type CatalogSnapshot,
  type CatalogTable,
  type PgTypeKind,
} from '../../rest-api/catalog';
import type {
  TypegenCatalog,
  TypegenColumn,
  TypegenFunction,
  TypegenFunctionArg,
  TypegenRelation,
} from './types';

// ── Function introspection ────────────────────────────────────────────────────

// The catalog snapshot covers relations, enums and composite types; functions
// are only needed by type generation, so they are loaded here instead of being
// carried in every REST request's cached snapshot.
//
// Excluded on purpose:
//   - `prokind <> 'f'`: aggregates, window functions and procedures are not
//     callable through PostgREST's `/rpc/` surface.
//   - trigger functions: they are invoked by the database, never by a client.
//   - extension-owned functions (`pg_depend.deptype = 'e'`): installing pgcrypto
//     would otherwise dump a hundred irrelevant entries into `Functions`.
export const FUNCTIONS_SQL = `
  SELECT p.oid::int         AS oid,
         p.proname          AS name,
         p.proretset        AS returns_set,
         p.pronargdefaults::int AS n_defaults,
         rt.typname         AS return_pg_type,
         rt.typtype::text   AS return_type_kind,
         rtn.nspname        AS return_type_schema,
         ret.typname        AS return_elem_type,
         ret.typtype::text  AS return_elem_type_kind,
         retn.nspname       AS return_elem_type_schema,
         rc.relname         AS return_relation
    FROM pg_proc      p
    JOIN pg_namespace n   ON n.oid = p.pronamespace
    JOIN pg_type      rt  ON rt.oid = p.prorettype
    JOIN pg_namespace rtn ON rtn.oid = rt.typnamespace
    LEFT JOIN pg_type      ret  ON ret.oid = rt.typelem AND rt.typcategory = 'A'
    LEFT JOIN pg_namespace retn ON retn.oid = ret.typnamespace
    LEFT JOIN pg_class     rc   ON rc.oid = rt.typrelid AND rc.relkind <> 'c'
   WHERE p.prokind = 'f'
     AND n.nspname = $1
     AND rt.typname <> 'trigger'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY p.proname, p.oid
`;

// Argument rows for the functions above. `proallargtypes` is only populated when
// the function has OUT/INOUT parameters, hence the COALESCE onto `proargtypes`.
// Subscripting `proargnames`/`proargmodes` by the unnest ordinality keeps the
// three parallel arrays aligned without a three-way unnest, which behaves badly
// when any of them is NULL.
export const FUNCTION_ARGS_SQL = `
  SELECT p.oid::int  AS oid,
         a.ord::int  AS position,
         COALESCE(p.proargnames[a.ord::int], '') AS name,
         COALESCE(p.proargmodes[a.ord::int]::text, 'i') AS mode,
         t.typname        AS pg_type,
         t.typtype::text  AS type_kind,
         tn.nspname       AS type_schema,
         et.typname       AS elem_type,
         et.typtype::text AS elem_type_kind,
         etn.nspname      AS elem_type_schema
    FROM pg_proc      p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
                       WITH ORDINALITY AS a(atttypid, ord)
    JOIN pg_type      t  ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_type      et  ON et.oid = t.typelem AND t.typcategory = 'A'
    LEFT JOIN pg_namespace etn ON etn.oid = et.typnamespace
   WHERE p.prokind = 'f'
     AND n.nspname = $1
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY p.oid, a.ord
`;

export interface FunctionRow {
  oid: number;
  name: string;
  returns_set: boolean;
  n_defaults: number;
  return_pg_type: string;
  return_type_kind: string;
  return_type_schema: string;
  return_elem_type: string | null;
  return_elem_type_kind: string | null;
  return_elem_type_schema: string | null;
  return_relation: string | null;
}

export interface FunctionArgRow {
  oid: number;
  position: number;
  name: string;
  mode: string;
  pg_type: string;
  type_kind: string;
  type_schema: string;
  elem_type: string | null;
  elem_type_kind: string | null;
  elem_type_schema: string | null;
}

/** Postgres identifiers only. Schemas reach here from a query string. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function assertSchemaName(schema: string): string {
  const value = (schema || 'public').trim();
  if (!IDENTIFIER.test(value) || value.length > 63) {
    throw new Error(`Invalid schema name: ${schema}`);
  }
  return value;
}

// ── Catalog assembly ──────────────────────────────────────────────────────────

/** Codepoint ordering: identical on every machine, unlike localeCompare. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function unqualified(qualifiedName: string | null): string | null {
  if (!qualifiedName) return null;
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
}

function buildColumn(column: CatalogTable['columns'][number], snapshot: CatalogSnapshot, schema: string): TypegenColumn {
  // An array's element type is what carries the enum/composite identity: the
  // array type itself is a plain base type named `_<element>`, which is the
  // convention Postgres has used for every array type since forever.
  const elementName = column.isArray && column.pgType.startsWith('_') ? column.pgType.slice(1) : null;

  const directEnum = unqualified(column.enumType);
  const arrayEnum = elementName && snapshot.enum(schema, elementName) ? elementName : null;
  const compositeName =
    column.typeKind === 'c'
      ? column.pgType
      : elementName && snapshot.compositeTypes.some(t => t.schema === schema && t.name === elementName)
        ? elementName
        : null;

  return {
    name: column.name,
    pgType: column.pgType,
    formattedType: column.formattedType,
    tsType: column.tsType,
    nullable: column.nullable,
    hasDefault: column.hasDefault,
    isGenerated: column.isGenerated,
    isPk: column.isPk,
    isArray: column.isArray,
    enumRef: directEnum ?? arrayEnum,
    compositeRef: snapshot.compositeTypes.some(t => t.schema === schema && t.name === compositeName)
      ? compositeName
      : null,
  };
}

/**
 * PostgREST's `isOneToOne` is a property of the CHILD side of a foreign key: the
 * relationship is one-to-one exactly when the referencing columns are covered by
 * a unique index. The catalog already computed that when it recorded the inbound
 * edge on the parent, so read it back from there rather than recomputing it.
 */
function isOneToOne(snapshot: CatalogSnapshot, child: CatalogTable, fk: CatalogTable['foreignKeys'][number]): boolean {
  const parent = snapshot.table(fk.toSchema, fk.toTable);
  const paired = parent?.foreignKeys.find(
    edge => edge.direction === 'inbound' && edge.constraint === fk.constraint && edge.toTable === child.name,
  );
  return paired ? paired.cardinality === 'one' : false;
}

function buildRelation(table: CatalogTable, snapshot: CatalogSnapshot, schema: string): TypegenRelation {
  const isView = table.kind === 'view' || table.kind === 'matview';
  const relationships = isView
    ? []
    : table.foreignKeys
        .filter(fk => fk.direction === 'outbound')
        .map(fk => ({
          foreignKeyName: fk.constraint,
          columns: fk.fromCols.slice(),
          isOneToOne: isOneToOne(snapshot, table, fk),
          referencedRelation: fk.toTable,
          referencedColumns: fk.toCols.slice(),
        }))
        .sort((a, b) => (a.foreignKeyName < b.foreignKeyName ? -1 : a.foreignKeyName > b.foreignKeyName ? 1 : 0));

  return {
    name: table.name,
    kind: isView ? 'view' : 'table',
    columns: table.columns.map(column => buildColumn(column, snapshot, schema)),
    primaryKey: table.primaryKey.slice(),
    relationships,
    rlsEnabled: table.rlsEnabled,
  };
}

function buildFunctions(
  functionRows: FunctionRow[],
  argRows: FunctionArgRow[],
  snapshot: CatalogSnapshot,
  schema: string,
): TypegenFunction[] {
  const argsByOid = new Map<number, FunctionArgRow[]>();
  for (const row of argRows) {
    const list = argsByOid.get(row.oid);
    if (list) list.push(row);
    else argsByOid.set(row.oid, [row]);
  }

  return functionRows
    .map(row => {
      // `pronargdefaults` counts the trailing INPUT arguments that have a
      // DEFAULT. OUT arguments never take one, so they are filtered out first.
      const inputs = (argsByOid.get(row.oid) ?? []).filter(arg => arg.mode === 'i' || arg.mode === 'b' || arg.mode === 'v');
      const firstOptional = inputs.length - Math.max(0, row.n_defaults ?? 0);

      const args: TypegenFunctionArg[] = inputs.map((arg, index) => ({
        // Positional (unnamed) arguments cannot be passed by name over
        // PostgREST, so they are surfaced as `arg1`, `arg2`, ... and the caller
        // gets a compile error instead of a silent 404 at runtime.
        name: arg.name || `arg${index + 1}`,
        pgType: arg.pg_type,
        tsType: pgTypeToTsType({
          pgType: arg.pg_type,
          typeKind: (arg.type_kind ?? 'b') as PgTypeKind,
          elem: arg.elem_type
            ? {
                pgType: arg.elem_type,
                typeKind: (arg.elem_type_kind ?? 'b') as PgTypeKind,
                enumValues: snapshot.enum(arg.elem_type_schema ?? schema, arg.elem_type)?.values ?? null,
              }
            : null,
          enumValues: snapshot.enum(arg.type_schema, arg.pg_type)?.values ?? null,
        }),
        optional: index >= firstOptional,
      }));

      const returnEnum = snapshot.enum(row.return_type_schema, row.return_pg_type) ? row.return_pg_type : null;
      const returnComposite =
        !row.return_relation &&
        snapshot.compositeTypes.some(t => t.schema === schema && t.name === row.return_pg_type)
          ? row.return_pg_type
          : null;

      return {
        name: row.name,
        args,
        returnsSet: Boolean(row.returns_set),
        returnPgType: row.return_pg_type,
        returnTsType: pgTypeToTsType({
          pgType: row.return_pg_type,
          typeKind: (row.return_type_kind ?? 'b') as PgTypeKind,
          elem: row.return_elem_type
            ? {
                pgType: row.return_elem_type,
                typeKind: (row.return_elem_type_kind ?? 'b') as PgTypeKind,
                enumValues: snapshot.enum(row.return_elem_type_schema ?? schema, row.return_elem_type)?.values ?? null,
              }
            : null,
          enumValues: snapshot.enum(row.return_type_schema, row.return_pg_type)?.values ?? null,
        }),
        returnRelation: row.return_relation ?? null,
        returnEnumRef: returnEnum,
        returnCompositeRef: returnComposite,
      };
    })
    .sort(byName);
}

/** Assemble the structured catalog for one schema. No rendering happens here. */
export function buildTypegenCatalog(
  snapshot: CatalogSnapshot,
  functionRows: FunctionRow[],
  argRows: FunctionArgRow[],
  schema: string,
): TypegenCatalog {
  const relations = snapshot.tablesIn(schema).map(table => buildRelation(table, snapshot, schema));

  return {
    schema,
    tables: relations.filter(relation => relation.kind === 'table').sort(byName),
    views: relations.filter(relation => relation.kind === 'view').sort(byName),
    functions: buildFunctions(functionRows, argRows, snapshot, schema),
    enums: snapshot.enums
      .filter(item => item.schema === schema)
      .map(item => ({ name: item.name, values: item.values.slice() }))
      .sort(byName),
    compositeTypes: snapshot.compositeTypes
      .filter(item => item.schema === schema)
      .map(item => ({
        name: item.name,
        attributes: item.attributes.map(attr => ({
          name: attr.name,
          tsType: attr.tsType,
          nullable: attr.nullable,
        })),
      }))
      .sort(byName),
  };
}
