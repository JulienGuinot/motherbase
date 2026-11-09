// Turning catalog rows into the frozen snapshot every other layer reads.
// Pure: no database access lives here, so the same code path serves a real load
// and a hand-built test fixture.

import { pgTypeToTsType, type PgTypeRef } from './pg-types';
import type {
  CatalogColumn,
  CatalogCompositeType,
  CatalogEnum,
  CatalogFunction,
  CatalogFunctionArg,
  CatalogRelKind,
  CatalogSnapshot,
  CatalogTable,
  PgTypeKind,
} from './types';
import type {
  ColumnRow,
  CompositeRow,
  EnumRow,
  ForeignKeyRow,
  FunctionArgRow,
  FunctionRow,
  IndexRow,
  RelationRow,
} from './queries';

const REL_KINDS: Readonly<Record<string, CatalogRelKind>> = Object.freeze({
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign',
});

/** `{1,2}` (int[] text) or `1 2` (int2vector text) -> [1, 2]. */
function parseAttnums(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw
    .replace(/^[{(]|[})]$/g, '')
    .split(/[\s,]+/)
    .map(part => Number(part))
    .filter(value => Number.isFinite(value));
}

function qualify(schema: string, name: string): string {
  return `${schema}.${name}`;
}

type EnumValuesOf = (schema: string | null, name: string | null) => string[] | null;

/** Column names by attnum, per relation oid: how index and FK attnums are translated. */
type ColumnNamesByOid = Map<number, Map<number, string>>;

export function buildSnapshot(
  version: number,
  relations: RelationRow[],
  columnRows: ColumnRow[],
  indexRows: IndexRow[],
  fkRows: ForeignKeyRow[],
  enumRows: EnumRow[],
  compositeRows: CompositeRow[],
  functionRows: FunctionRow[] = [],
  functionArgRows: FunctionArgRow[] = [],
): CatalogSnapshot {
  // Enums first: column tsType for an enum column is the union of its labels.
  const enums = groupEnums(enumRows);
  const enumValuesOf: EnumValuesOf = (schema, name) =>
    schema && name ? (enums.get(qualify(schema, name))?.values ?? null) : null;

  const { columnsByOid, columnNames } = buildColumns(columnRows, enumValuesOf);
  const keys = readIndexKeys(indexRows, columnNames);
  const tableByOid = new Map(relations.map(row => [row.oid, buildTable(row, columnsByOid, keys.primaryKeyByOid)]));
  linkForeignKeys(fkRows, tableByOid, columnNames, keys.uniqueKeySetsByOid);

  return freezeSnapshot({
    version,
    loadedAt: Date.now(),
    tables: Array.from(tableByOid.values()),
    enums: Array.from(enums.values()),
    compositeTypes: buildCompositeTypes(compositeRows, enumValuesOf),
    functions: buildFunctions(functionRows, functionArgRows),
  });
}

function groupEnums(rows: EnumRow[]): Map<string, CatalogEnum> {
  const enums = new Map<string, CatalogEnum>();
  for (const row of rows) {
    const key = qualify(row.schema, row.name);
    const existing = enums.get(key);
    if (existing) existing.values.push(row.label);
    else enums.set(key, { schema: row.schema, name: row.name, values: [row.label] });
  }
  return enums;
}

function typeRef(
  pgType: string | null,
  kind: string | null,
  schema: string | null,
  enumValuesOf: EnumValuesOf,
): PgTypeRef | null {
  if (!pgType) return null;
  return { pgType, typeKind: (kind ?? 'b') as PgTypeKind, enumValues: enumValuesOf(schema, pgType) };
}

function buildColumns(rows: ColumnRow[], enumValuesOf: EnumValuesOf) {
  const columnsByOid = new Map<number, CatalogColumn[]>();
  const columnNames: ColumnNamesByOid = new Map();

  for (const row of rows) {
    const typeKind = (row.type_kind ?? 'b') as PgTypeKind;
    const identity = row.identity ?? '';
    const generated = row.generated ?? '';

    const column: CatalogColumn = {
      name: row.name,
      pgType: row.pg_type,
      formattedType: row.formatted_type,
      tsType: pgTypeToTsType({
        pgType: row.pg_type,
        typeKind,
        elem: typeRef(row.elem_type, row.elem_type_kind, row.elem_type_schema, enumValuesOf),
        base: typeRef(row.base_type, row.base_type_kind, row.base_type_schema, enumValuesOf),
        enumValues: enumValuesOf(row.type_schema, row.pg_type),
      }),
      nullable: row.nullable,
      // An identity column has no pg_attrdef row but INSERT may still omit it.
      hasDefault: Boolean(row.has_default_expr) || identity !== '',
      defaultExpr: row.default_expr ?? null,
      isPk: false, // set by buildTable from the primary-key index
      isGenerated: generated !== '' || identity === 'a',
      isArray: Boolean(row.elem_type),
      enumType: typeKind === 'e' ? qualify(row.type_schema, row.pg_type) : null,
      typeKind,
      position: row.position,
    };

    const list = columnsByOid.get(row.oid);
    if (list) list.push(column);
    else columnsByOid.set(row.oid, [column]);

    const names = columnNames.get(row.oid) ?? new Map<number, string>();
    names.set(row.position, row.name);
    columnNames.set(row.oid, names);
  }

  return { columnsByOid, columnNames };
}

function columnNamesAt(columnNames: ColumnNamesByOid, oid: number, attnums: number[]): string[] {
  const names = columnNames.get(oid);
  return attnums.map(attnum => names?.get(attnum)).filter((name): name is string => Boolean(name));
}

/** Primary keys, plus the unique-key sets that decide FK cardinality. */
function readIndexKeys(rows: IndexRow[], columnNames: ColumnNamesByOid) {
  const primaryKeyByOid = new Map<number, string[]>();
  const uniqueKeySetsByOid = new Map<number, number[][]>();
  for (const row of rows) {
    const attnums = parseAttnums(row.key_attnums).slice(0, row.key_count);
    // attnum 0 marks an expression column: such an index cannot be matched to a
    // column set, so it never proves uniqueness of a foreign key.
    if (!attnums.length || attnums.includes(0)) continue;

    if (row.is_primary) primaryKeyByOid.set(row.oid, columnNamesAt(columnNames, row.oid, attnums));
    // A partial unique index only constrains a subset of rows, so it does not
    // make the relationship to-one in general.
    if (row.is_unique && !row.is_partial) {
      const sets = uniqueKeySetsByOid.get(row.oid) ?? [];
      sets.push(attnums);
      uniqueKeySetsByOid.set(row.oid, sets);
    }
  }
  return { primaryKeyByOid, uniqueKeySetsByOid };
}

function buildTable(
  row: RelationRow,
  columnsByOid: Map<number, CatalogColumn[]>,
  primaryKeyByOid: Map<number, string[]>,
): CatalogTable {
  const columns = (columnsByOid.get(row.oid) ?? []).slice().sort((a, b) => a.position - b.position);
  const primaryKey = primaryKeyByOid.get(row.oid) ?? [];
  const pkSet = new Set(primaryKey);
  for (const column of columns) column.isPk = pkSet.has(column.name);

  return {
    schema: row.schema,
    name: row.name,
    kind: REL_KINDS[row.kind] ?? 'table',
    columns,
    primaryKey,
    foreignKeys: [],
    rlsEnabled: Boolean(row.rls_enabled),
    rlsForced: Boolean(row.rls_forced),
  };
}

/** Records every foreign key on BOTH ends: outbound on the child, inbound on the parent. */
function linkForeignKeys(
  rows: ForeignKeyRow[],
  tableByOid: Map<number, CatalogTable>,
  columnNames: ColumnNamesByOid,
  uniqueKeySetsByOid: Map<number, number[][]>,
): void {
  for (const row of rows) {
    const child = tableByOid.get(row.child_oid);
    const parent = tableByOid.get(row.parent_oid);
    if (!child || !parent) continue; // one end lives outside the loaded schemas

    const childAttnums = parseAttnums(row.child_attnums);
    const parentAttnums = parseAttnums(row.parent_attnums);
    const childCols = columnNamesAt(columnNames, row.child_oid, childAttnums);
    const parentCols = columnNamesAt(columnNames, row.parent_oid, parentAttnums);
    if (childCols.length !== childAttnums.length || parentCols.length !== parentAttnums.length) continue;

    // The child side is to-one exactly when some unique index on the child is
    // fully contained in the FK column set: uniqueness of a subset implies
    // uniqueness of the whole. This is the object-vs-array rule for embedding.
    const childAttnumSet = new Set(childAttnums);
    const childIsUnique = (uniqueKeySetsByOid.get(row.child_oid) ?? []).some(
      set => set.length > 0 && set.every(attnum => childAttnumSet.has(attnum)),
    );

    child.foreignKeys.push({
      constraint: row.constraint_name,
      direction: 'outbound',
      fromCols: childCols,
      toSchema: parent.schema,
      toTable: parent.name,
      toCols: parentCols,
      // An FK always targets a unique key on the parent, so the parent side of
      // an outbound reference is unconditionally to-one.
      cardinality: 'one',
    });

    parent.foreignKeys.push({
      constraint: row.constraint_name,
      direction: 'inbound',
      fromCols: parentCols,
      toSchema: child.schema,
      toTable: child.name,
      toCols: childCols,
      cardinality: childIsUnique ? 'one' : 'many',
    });
  }
}

function buildCompositeTypes(rows: CompositeRow[], enumValuesOf: EnumValuesOf): CatalogCompositeType[] {
  const composites = new Map<string, CatalogCompositeType>();
  for (const row of rows) {
    const key = qualify(row.schema, row.name);
    const composite = composites.get(key) ?? { schema: row.schema, name: row.name, attributes: [] };
    composite.attributes.push({
      name: row.attr,
      pgType: row.pg_type,
      formattedType: row.formatted_type,
      tsType: pgTypeToTsType({
        pgType: row.pg_type,
        typeKind: (row.type_kind ?? 'b') as PgTypeKind,
        enumValues: enumValuesOf(row.schema, row.pg_type),
      }),
      nullable: row.nullable,
    });
    composites.set(key, composite);
  }
  return Array.from(composites.values());
}

/** Arguments are grouped by oid so overloads stay distinct entries. */
function buildFunctions(rows: FunctionRow[], argRows: FunctionArgRow[]): CatalogFunction[] {
  const argsByOid = new Map<number, CatalogFunctionArg[]>();
  for (const row of argRows) {
    const list = argsByOid.get(row.oid) ?? [];
    list.push({
      name: row.name,
      position: row.position,
      mode: (row.mode || 'i') as CatalogFunctionArg['mode'],
      pgType: row.pg_type,
      formattedType: row.formatted_type,
      hasDefault: false,
    });
    argsByOid.set(row.oid, list);
  }

  return rows.map(row => {
    const args = (argsByOid.get(row.oid) ?? []).slice().sort((a, b) => a.position - b.position);
    // `pronargdefaults` counts the TRAILING input arguments that carry a default,
    // so the last N input arguments (and only those) may be omitted by a caller.
    const inputArgs = args.filter(arg => arg.mode === 'i' || arg.mode === 'b' || arg.mode === 'v');
    const firstDefaulted = inputArgs.length - (row.n_defaults ?? 0);
    inputArgs.forEach((arg, index) => {
      arg.hasDefault = index >= firstDefaulted;
    });
    return {
      schema: row.schema,
      name: row.name,
      args,
      returnsSet: Boolean(row.returns_set),
      returnPgType: row.return_pg_type,
      returnTypeKind: (row.return_type_kind ?? 'b') as PgTypeKind,
      returnRelation: row.return_relation ?? null,
      securityDefiner: Boolean(row.security_definer),
      volatility: (row.volatility ?? 'v') as CatalogFunction['volatility'],
      variadic: Boolean(row.variadic),
    };
  });
}

interface SnapshotInput {
  version: number;
  loadedAt: number;
  tables: CatalogTable[];
  enums: CatalogEnum[];
  compositeTypes: CatalogCompositeType[];
  functions: CatalogFunction[];
}

/**
 * Deep-freeze the snapshot and attach the lookup helpers. Freezing matters: the
 * same object is handed to every caller, so an accidental mutation anywhere
 * would silently corrupt REST field allowlisting for every other request.
 */
function freezeSnapshot(input: SnapshotInput): CatalogSnapshot {
  const byQualifiedName = new Map<string, CatalogTable>();
  const bySchema = new Map<string, CatalogTable[]>();

  for (const table of input.tables) {
    table.columns.forEach(Object.freeze);
    table.foreignKeys.forEach(fk => {
      Object.freeze(fk.fromCols);
      Object.freeze(fk.toCols);
      Object.freeze(fk);
    });
    Object.freeze(table.columns);
    Object.freeze(table.foreignKeys);
    Object.freeze(table.primaryKey);
    Object.freeze(table);

    byQualifiedName.set(qualify(table.schema, table.name), table);
    const list = bySchema.get(table.schema) ?? [];
    list.push(table);
    bySchema.set(table.schema, list);
  }

  const enumsByQualifiedName = new Map<string, CatalogEnum>();
  for (const item of input.enums) {
    Object.freeze(item.values);
    Object.freeze(item);
    enumsByQualifiedName.set(qualify(item.schema, item.name), item);
  }
  for (const composite of input.compositeTypes) {
    composite.attributes.forEach(Object.freeze);
    Object.freeze(composite.attributes);
    Object.freeze(composite);
  }

  // Overloads share a name, so the index holds a list per name. Freezing matters
  // here as much as it does for tables: `securityDefiner` is a security gate and
  // must not be mutable by any consumer of the shared snapshot.
  const functionsByQualifiedName = new Map<string, CatalogFunction[]>();
  for (const fn of input.functions) {
    fn.args.forEach(Object.freeze);
    Object.freeze(fn.args);
    Object.freeze(fn);
    const key = qualify(fn.schema, fn.name);
    const list = functionsByQualifiedName.get(key) ?? [];
    list.push(fn);
    functionsByQualifiedName.set(key, list);
  }

  return Object.freeze({
    version: input.version,
    loadedAt: input.loadedAt,
    tables: Object.freeze(input.tables.slice()),
    enums: Object.freeze(input.enums.slice()),
    compositeTypes: Object.freeze(input.compositeTypes.slice()),
    functions: Object.freeze(input.functions.slice()),
    table: (schema: string, name: string) => byQualifiedName.get(qualify(schema, name)),
    // Returns a copy so callers may sort or filter without touching the snapshot.
    tablesIn: (schema: string) => (bySchema.get(schema) ?? []).slice(),
    enum: (schema: string, name: string) => enumsByQualifiedName.get(qualify(schema, name)),
    functionsNamed: (schema: string, name: string) =>
      (functionsByQualifiedName.get(qualify(schema, name)) ?? []).slice(),
  });
}

/**
 * Build a snapshot from plain data. Used by tests and by any future consumer
 * that needs a catalog without a database round trip.
 */
export function makeCatalogSnapshot(input: {
  version?: number;
  tables?: Array<Partial<CatalogTable> & { schema: string; name: string }>;
  enums?: CatalogEnum[];
  compositeTypes?: CatalogCompositeType[];
  functions?: Array<Partial<CatalogFunction> & { schema: string; name: string }>;
}): CatalogSnapshot {
  return freezeSnapshot({
    version: input.version ?? 0,
    loadedAt: Date.now(),
    tables: (input.tables ?? []).map(table => ({
      schema: table.schema,
      name: table.name,
      kind: table.kind ?? 'table',
      columns: table.columns ? table.columns.slice() : [],
      primaryKey: table.primaryKey ? table.primaryKey.slice() : [],
      foreignKeys: table.foreignKeys ? table.foreignKeys.slice() : [],
      rlsEnabled: table.rlsEnabled ?? false,
      rlsForced: table.rlsForced ?? false,
    })),
    enums: (input.enums ?? []).map(item => ({ ...item, values: item.values.slice() })),
    compositeTypes: (input.compositeTypes ?? []).map(item => ({
      ...item,
      attributes: item.attributes.slice(),
    })),
    functions: (input.functions ?? []).map(fn => ({
      schema: fn.schema,
      name: fn.name,
      args: fn.args ? fn.args.slice() : [],
      returnsSet: fn.returnsSet ?? false,
      returnPgType: fn.returnPgType ?? 'void',
      returnTypeKind: fn.returnTypeKind ?? 'b',
      returnRelation: fn.returnRelation ?? null,
      // Default to the SAFE value: a test fixture that forgets the field must not
      // accidentally describe a definer function as an invoker one.
      securityDefiner: fn.securityDefiner ?? false,
      // Default to VOLATILE: a fixture that forgets the field must not become
      // callable through GET by omission.
      volatility: fn.volatility ?? 'v',
      variadic: fn.variadic ?? false,
    })),
  });
}
