// Rendering: `TypegenCatalog` -> the `database.types.ts` file text.
//
// Determinism is a hard requirement: `--check` in CI diffs the file on disk
// against a fresh generation, so the output must be byte-identical across runs
// and machines. Stable sort orders, no timestamps, no host names, LF endings.

import type { TypegenCatalog, TypegenColumn, TypegenFunction, TypegenRelation, TypegenResources } from './types';
// ── Rendering ─────────────────────────────────────────────────────────────────

const NL = '\n';
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quote a key that is not a bare TypeScript identifier (`"user id"`). */
function key(name: string): string {
  return VALID_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function indent(level: number): string {
  return '  '.repeat(level);
}

/** `Database['public']['Enums']['mood']`, the supabase-js reference form. */
function schemaRef(schema: string, bucket: string, name: string): string {
  return `Database[${JSON.stringify(schema)}][${JSON.stringify(bucket)}][${JSON.stringify(name)}]`;
}

/**
 * The type expression for a column. Enums and composites are emitted as
 * references into the same `Database` object rather than inlined, because that
 * is what supabase-js does and what makes `Enums<'mood'>` resolve.
 */
function columnType(column: TypegenColumn, schema: string): string {
  if (column.enumRef) {
    const ref = schemaRef(schema, 'Enums', column.enumRef);
    return column.isArray ? `${ref}[]` : ref;
  }
  if (column.compositeRef) {
    const ref = schemaRef(schema, 'CompositeTypes', column.compositeRef);
    return column.isArray ? `${ref}[]` : ref;
  }
  return column.tsType;
}

/**
 * Union a type with `null` when the column allows it. `unknown | null` collapses
 * to `unknown` in TypeScript and trips redundancy lint rules in user projects,
 * so an unmapped type is left alone.
 */
function orNull(type: string, isNullable: boolean): string {
  if (!isNullable || type === 'unknown') return type;
  return `${type} | null`;
}

function rowField(column: TypegenColumn, schema: string, level: number): string {
  return `${indent(level)}${key(column.name)}: ${orNull(columnType(column, schema), column.nullable)}`;
}

/**
 * Insert/Update field. `Insert` omits database-produced columns entirely (a
 * write that supplies them is rejected by Postgres), and makes a column optional
 * when the database can fill it in: an explicit DEFAULT, an identity, or a
 * nullable column that defaults to NULL. `Update` makes everything optional
 * because PATCH is always partial.
 */
function writeField(column: TypegenColumn, schema: string, level: number, allOptional: boolean): string {
  const optional = allOptional || column.hasDefault || column.nullable;
  return `${indent(level)}${key(column.name)}${optional ? '?' : ''}: ${orNull(columnType(column, schema), column.nullable)}`;
}

function renderRelationships(relation: TypegenRelation, level: number): string[] {
  if (!relation.relationships.length) return [`${indent(level)}Relationships: []`];

  const lines = [`${indent(level)}Relationships: [`];
  for (const rel of relation.relationships) {
    lines.push(`${indent(level + 1)}{`);
    lines.push(`${indent(level + 2)}foreignKeyName: ${JSON.stringify(rel.foreignKeyName)}`);
    lines.push(`${indent(level + 2)}columns: [${rel.columns.map(c => JSON.stringify(c)).join(', ')}]`);
    lines.push(`${indent(level + 2)}isOneToOne: ${rel.isOneToOne}`);
    lines.push(`${indent(level + 2)}referencedRelation: ${JSON.stringify(rel.referencedRelation)}`);
    lines.push(`${indent(level + 2)}referencedColumns: [${rel.referencedColumns.map(c => JSON.stringify(c)).join(', ')}]`);
    // A tuple type needs separators: `[{...} {...}]` is a syntax error that only
    // shows on a table with two or more foreign keys.
    lines.push(`${indent(level + 1)}},`);
  }
  lines.push(`${indent(level)}]`);
  return lines;
}

/** `{ [_ in never]: never }`, supabase's rendering of an empty bucket. */
function emptyBucket(name: string, level: number): string[] {
  return [`${indent(level)}${name}: {`, `${indent(level + 1)}[_ in never]: never`, `${indent(level)}}`];
}

function renderTables(catalog: TypegenCatalog, level: number): string[] {
  if (!catalog.tables.length) return emptyBucket('Tables', level);

  const lines = [`${indent(level)}Tables: {`];
  for (const table of catalog.tables) {
    lines.push(`${indent(level + 1)}${key(table.name)}: {`);

    lines.push(`${indent(level + 2)}Row: {`);
    for (const column of table.columns) lines.push(rowField(column, catalog.schema, level + 3));
    lines.push(`${indent(level + 2)}}`);

    const writable = table.columns.filter(column => !column.isGenerated);
    lines.push(`${indent(level + 2)}Insert: {`);
    for (const column of writable) lines.push(writeField(column, catalog.schema, level + 3, false));
    lines.push(`${indent(level + 2)}}`);

    lines.push(`${indent(level + 2)}Update: {`);
    for (const column of writable) lines.push(writeField(column, catalog.schema, level + 3, true));
    lines.push(`${indent(level + 2)}}`);

    lines.push(...renderRelationships(table, level + 2));
    lines.push(`${indent(level + 1)}}`);
  }
  lines.push(`${indent(level)}}`);
  return lines;
}

function renderViews(catalog: TypegenCatalog, level: number): string[] {
  if (!catalog.views.length) return emptyBucket('Views', level);

  const lines = [`${indent(level)}Views: {`];
  for (const view of catalog.views) {
    lines.push(`${indent(level + 1)}${key(view.name)}: {`);
    lines.push(`${indent(level + 2)}Row: {`);
    for (const column of view.columns) lines.push(rowField(column, catalog.schema, level + 3));
    lines.push(`${indent(level + 2)}}`);
    lines.push(...renderRelationships(view, level + 2));
    lines.push(`${indent(level + 1)}}`);
  }
  lines.push(`${indent(level)}}`);
  return lines;
}

/** The value one call to this function resolves to, including the set wrapper. */
function functionReturnType(fn: TypegenFunction, catalog: TypegenCatalog): string {
  let type: string;
  if (fn.returnRelation) {
    const bucket = catalog.views.some(view => view.name === fn.returnRelation) ? 'Views' : 'Tables';
    type = `${schemaRef(catalog.schema, bucket, fn.returnRelation)}["Row"]`;
  } else if (fn.returnEnumRef) {
    type = schemaRef(catalog.schema, 'Enums', fn.returnEnumRef);
  } else if (fn.returnCompositeRef) {
    type = schemaRef(catalog.schema, 'CompositeTypes', fn.returnCompositeRef);
  } else if (fn.returnPgType === 'void') {
    type = 'undefined';
  } else if (fn.returnPgType === 'record') {
    // A `RETURNS record` function has no declared shape until the call site
    // supplies a column definition list, which PostgREST cannot do.
    type = 'Record<string, unknown>';
  } else {
    type = fn.returnTsType;
  }
  return fn.returnsSet ? `${type}[]` : type;
}

function renderFunctions(catalog: TypegenCatalog, level: number): string[] {
  if (!catalog.functions.length) return emptyBucket('Functions', level);

  // Overloads share a name in Postgres but not in TypeScript, so their argument
  // and return types are unioned. A caller then has to satisfy one of the
  // overloads, which is as close as this shape gets.
  const byFunctionName = new Map<string, TypegenFunction[]>();
  for (const fn of catalog.functions) {
    const list = byFunctionName.get(fn.name);
    if (list) list.push(fn);
    else byFunctionName.set(fn.name, [fn]);
  }

  const lines = [`${indent(level)}Functions: {`];
  for (const [name, overloads] of byFunctionName) {
    lines.push(`${indent(level + 1)}${key(name)}: {`);

    const argShapes = overloads.map(fn =>
      fn.args.length
        ? `{ ${fn.args.map(arg => `${key(arg.name)}${arg.optional ? '?' : ''}: ${arg.tsType}`).join('; ')} }`
        : 'Record<PropertyKey, never>',
    );
    const returns = overloads.map(fn => functionReturnType(fn, catalog));

    lines.push(`${indent(level + 2)}Args: ${unique(argShapes).join(' | ')}`);
    lines.push(`${indent(level + 2)}Returns: ${unique(returns).join(' | ')}`);
    lines.push(`${indent(level + 1)}}`);
  }
  lines.push(`${indent(level)}}`);
  return lines;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function renderEnums(catalog: TypegenCatalog, level: number): string[] {
  if (!catalog.enums.length) return emptyBucket('Enums', level);

  const lines = [`${indent(level)}Enums: {`];
  for (const item of catalog.enums) {
    const union = item.values.map(value => JSON.stringify(value)).join(' | ');
    lines.push(`${indent(level + 1)}${key(item.name)}: ${union || 'never'}`);
  }
  lines.push(`${indent(level)}}`);
  return lines;
}

function renderCompositeTypes(catalog: TypegenCatalog, level: number): string[] {
  if (!catalog.compositeTypes.length) return emptyBucket('CompositeTypes', level);

  const lines = [`${indent(level)}CompositeTypes: {`];
  for (const item of catalog.compositeTypes) {
    lines.push(`${indent(level + 1)}${key(item.name)}: {`);
    for (const attr of item.attributes) {
      lines.push(`${indent(level + 2)}${key(attr.name)}: ${orNull(attr.tsType, attr.nullable)}`);
    }
    lines.push(`${indent(level + 1)}}`);
  }
  lines.push(`${indent(level)}}`);
  return lines;
}

/** Not a schema: the SDK strips this key before it reads `Database` as one. */
const RESOURCES_KEY = '__InternalMotherbase';

const NO_RESOURCES: TypegenResources = { edgeFunctions: [], buckets: [] };

function nameUnion(names: string[]): string {
  return names.map(name => JSON.stringify(name)).join(' | ') || 'never';
}

function renderResources(resources: TypegenResources, level: number): string[] {
  return [
    `${indent(level)}${RESOURCES_KEY}: {`,
    `${indent(level + 1)}EdgeFunctions: ${nameUnion(resources.edgeFunctions)}`,
    `${indent(level + 1)}Buckets: ${nameUnion(resources.buckets)}`,
    `${indent(level)}}`,
  ];
}

const HEADER = [
  '// Generated by `motherbase gen types typescript`. Do not edit by hand.',
  '// Re-run the command after any schema change; CI can gate on `--check`.',
];

const JSON_TYPE = [
  'export type Json =',
  '  | string',
  '  | number',
  '  | boolean',
  '  | null',
  '  | { [key: string]: Json | undefined }',
  '  | Json[]',
];

/**
 * The helper aliases supabase-js users import (`Tables<'products'>` and
 * friends). Emitted verbatim so code copied from a Supabase project keeps
 * compiling. Parameterised on the generated schema: for `public` this is
 * character-for-character what supabase-js produces.
 */
function helperTypes(schema: string): string[] {
  const literal = JSON.stringify(schema);
  return [
    `type DefaultSchema = Database[Extract<keyof Database, ${literal}>]`,
    '',
    'export type Tables<',
    "  TableName extends keyof (DefaultSchema[\"Tables\"] & DefaultSchema[\"Views\"]),",
    '> = (DefaultSchema["Tables"] & DefaultSchema["Views"])[TableName] extends { Row: infer R } ? R : never',
    '',
    'export type TablesInsert<',
    '  TableName extends keyof DefaultSchema["Tables"],',
    '> = DefaultSchema["Tables"][TableName] extends { Insert: infer I } ? I : never',
    '',
    'export type TablesUpdate<',
    '  TableName extends keyof DefaultSchema["Tables"],',
    '> = DefaultSchema["Tables"][TableName] extends { Update: infer U } ? U : never',
    '',
    'export type Enums<',
    '  EnumName extends keyof DefaultSchema["Enums"],',
    '> = DefaultSchema["Enums"][EnumName]',
    '',
    'export type CompositeTypes<',
    '  TypeName extends keyof DefaultSchema["CompositeTypes"],',
    '> = DefaultSchema["CompositeTypes"][TypeName]',
  ];
}

/**
 * The runtime companion to the `Enums` types.
 *
 * supabase-js emits this so an app can iterate a Postgres enum's values without
 * repeating them in TypeScript (a select's options, a validation list). It is a
 * value, not a type, so it survives compilation and stays in sync with the
 * database on every regeneration.
 */
function constants(catalog: TypegenCatalog): string[] {
  const lines = ['export const Constants = {', `${indent(1)}${key(catalog.schema)}: {`, `${indent(2)}Enums: {`];
  for (const item of catalog.enums) {
    lines.push(`${indent(3)}${key(item.name)}: [${item.values.map(value => JSON.stringify(value)).join(', ')}],`);
  }
  lines.push(`${indent(2)}},`, `${indent(1)}},`, '} as const');
  return lines;
}

/** Render the structured catalog as a `database.types.ts` file. */
export function renderTypescript(catalog: TypegenCatalog, resources: TypegenResources = NO_RESOURCES): string {
  const lines: string[] = [
    ...HEADER,
    '',
    ...JSON_TYPE,
    '',
    'export type Database = {',
    ...renderResources(resources, 1),
    `${indent(1)}${key(catalog.schema)}: {`,
    ...renderTables(catalog, 2),
    ...renderViews(catalog, 2),
    ...renderFunctions(catalog, 2),
    ...renderEnums(catalog, 2),
    ...renderCompositeTypes(catalog, 2),
    `${indent(1)}}`,
    '}',
    '',
    ...helperTypes(catalog.schema),
    '',
    ...constants(catalog),
    '',
  ];
  // Join with an explicit LF: on Windows a CRLF would make `--check` report
  // drift against a file generated on Linux, and vice versa.
  return lines.join(NL);
}
