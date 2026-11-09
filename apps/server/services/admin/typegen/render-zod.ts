// Rendering: `TypegenCatalog` -> runtime zod schemas.
//
// The TypeScript emitter next door produces types, which vanish at runtime. A
// form post, a webhook body and a row read back from an untyped source are all
// `any` in practice, and the first place the mistake shows up is a column
// constraint violation in production.
//
// So: the same catalog, rendered as zod objects. One `<Relation>Row` per table
// and view, plus `<Relation>Insert` and `<Relation>Update` with exactly the
// optionality rules the TypeScript `Insert` / `Update` types use, so a value
// that passes the schema is a value the REST layer accepts.
//
// Determinism matters here for the same reason it does for the TypeScript
// emitter: `--check` diffs a committed file against a fresh generation. Stable
// order, no timestamps, LF endings.

import type { TypegenCatalog, TypegenColumn, TypegenRelation } from './types';

const NL = '\n';
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(name: string): string {
  return VALID_IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/**
 * A relation name as an exported binding: `order_items` -> `orderItems`.
 * Collisions are impossible within a schema because Postgres relation names are
 * already unique, and the mapping is injective for the characters a relation
 * name can contain.
 */
function bindingName(relation: string): string {
  const camel = relation.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  );
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

/**
 * The zod expression for one column, before nullability and optionality.
 *
 * An enum column becomes `z.enum([...])` rather than `z.string()`, because the
 * whole point of generating this is to reject a value Postgres would reject.
 * A type we do not model becomes `z.unknown()`: a schema that guesses wrong is
 * worse than one that admits it does not know, since the guess rejects valid
 * data at the boundary and there is no way for the caller to override it.
 */
function columnSchema(column: TypegenColumn, enums: Map<string, string[]>): string {
  let base: string;
  if (column.enumRef && enums.has(column.enumRef)) {
    const values = enums.get(column.enumRef)!;
    base = `z.enum([${values.map(v => JSON.stringify(v)).join(', ')}])`;
  } else {
    base = scalarSchema(column.tsType);
  }
  return column.isArray ? `z.array(${base})` : base;
}

/**
 * Map the TypeScript rendering of a scalar to its zod equivalent.
 *
 * Reading `tsType` rather than `pgType` keeps this emitter from owning a second
 * Postgres type table that would drift from the first one. An array suffix is
 * stripped because `isArray` already carries that, and a union (an inlined enum
 * on a column whose type we did not resolve) falls through to `z.unknown()`.
 */
function scalarSchema(tsType: string): string {
  const bare = tsType.replace(/\[\]$/, '').trim();
  switch (bare) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'Json':
    case 'unknown':
      return 'z.unknown()';
    default:
      return 'z.unknown()';
  }
}

type FieldKind = 'row' | 'insert' | 'update';

/**
 * One object property.
 *
 * `row` is what the database hands back: present, nullable where the column is.
 * `insert` omits generated columns (Postgres refuses a write that supplies one)
 * and makes a column optional when the database can fill it. `update` makes
 * everything optional, because a PATCH is always partial. These are the same
 * three rules the TypeScript emitter applies, deliberately: a value that
 * type-checks against `Insert` and fails this schema would make the pair
 * useless.
 */
function field(column: TypegenColumn, kind: FieldKind, enums: Map<string, string[]>): string | null {
  if (kind !== 'row' && column.isGenerated) return null;

  let expr = columnSchema(column, enums);
  if (column.nullable) expr = `${expr}.nullable()`;
  if (kind === 'update' || (kind === 'insert' && (column.hasDefault || column.nullable))) {
    expr = `${expr}.optional()`;
  }
  return `  ${key(column.name)}: ${expr},`;
}

function renderObject(name: string, relation: TypegenRelation, kind: FieldKind, enums: Map<string, string[]>): string[] {
  const lines = [`export const ${name} = z.object({`];
  for (const column of relation.columns) {
    const rendered = field(column, kind, enums);
    if (rendered) lines.push(rendered);
  }
  lines.push('});');
  return lines;
}

/**
 * Render the whole schema as a zod module.
 *
 * Views get a `Row` only: they are not writable through the REST layer, and
 * emitting an `Insert` for one would offer a write that always fails.
 */
export function renderZod(catalog: TypegenCatalog): string {
  const enums = new Map(catalog.enums.map(e => [e.name, e.values] as const));

  const lines: string[] = [
    '// Generated by `motherbase gen types zod`. Do not edit.',
    `// Schema: ${catalog.schema}`,
    '',
    "import { z } from 'zod';",
    '',
  ];

  for (const enumType of catalog.enums) {
    lines.push(
      `export const ${bindingName(enumType.name)}Enum = z.enum([`
        + `${enumType.values.map(v => JSON.stringify(v)).join(', ')}]);`,
    );
  }
  if (catalog.enums.length) lines.push('');

  for (const table of catalog.tables) {
    const base = bindingName(table.name);
    lines.push(...renderObject(`${base}Row`, table, 'row', enums), '');
    lines.push(...renderObject(`${base}Insert`, table, 'insert', enums), '');
    lines.push(...renderObject(`${base}Update`, table, 'update', enums), '');
  }

  for (const view of catalog.views) {
    lines.push(...renderObject(`${bindingName(view.name)}Row`, view, 'row', enums), '');
  }

  return lines.join(NL).replace(/\n+$/, '') + NL;
}
