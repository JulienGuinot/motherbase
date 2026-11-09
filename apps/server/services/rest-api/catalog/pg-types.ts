// The one Postgres -> TypeScript mapping. Kept apart from the loader so codegen
// can use it without a database, and so there is a single table to extend.

import type { PgTypeKind } from './types';

/**
 * Scalar mapping table. Every other layer goes through `pgTypeToTsType` so
 * there is one place to extend. Deliberately conservative: anything unknown
 * maps to `unknown`, never `any`, so generated code cannot silently lose type
 * safety. Geometric, network, range, text-search and bit-string types are
 * intentionally absent: PostgREST renders them as strings with a shape no
 * TypeScript alias can honestly describe, so `unknown` forces the caller to
 * narrow instead of trusting a lie.
 */
const SCALAR_TS_TYPES: Readonly<Record<string, string>> = Object.freeze({
  bool: 'boolean',
  int2: 'number',
  int4: 'number',
  // int8 exceeds Number.MAX_SAFE_INTEGER, but supabase-js types it as `number`
  // and the wire format is JSON, so parity wins over strictness here. The wire
  // agrees: lib/pg-int8 sends int8 out as a number within the safe range and
  // as a string beyond it, where a number would lose digits.
  int8: 'number',
  numeric: 'number',
  float4: 'number',
  float8: 'number',
  oid: 'number',
  text: 'string',
  varchar: 'string',
  bpchar: 'string',
  char: 'string',
  name: 'string',
  uuid: 'string',
  citext: 'string',
  // bytea arrives as its hex text rendering (`\x...`) over JSON, not as bytes.
  bytea: 'string',
  money: 'string',
  json: 'Json',
  jsonb: 'Json',
  date: 'string',
  time: 'string',
  timetz: 'string',
  timestamp: 'string',
  timestamptz: 'string',
  interval: 'string',
  xml: 'string',
});

export interface PgTypeRef {
  pgType: string;
  typeKind: PgTypeKind;
  /** Element type of an array type, when `pgType` is an array. */
  elem?: PgTypeRef | null;
  /** Base type of a domain, when `typeKind === 'd'`. */
  base?: PgTypeRef | null;
  /** Enum labels, when `typeKind === 'e'`. */
  enumValues?: readonly string[] | null;
  /**
   * Attributes of a composite type, when `typeKind === 'c'`. Optional because
   * the column loader does not resolve composite attributes: a composite column
   * with no attributes supplied maps to `unknown` rather than to a guess. The
   * type emitter passes them so a composite renders as an object type.
   */
  attributes?: readonly { name: string; tsType: string; nullable?: boolean }[] | null;
}

/** TypeScript string-literal form of a Postgres enum label. */
function tsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The single Postgres -> TypeScript mapping function. Every layer that needs a
 * TypeScript rendering of a Postgres type goes through here, so the REST field
 * types, the Studio column hints and the generated `database.types.ts` can
 * never disagree.
 *
 * Resolution order matters: arrays wrap whatever their element resolves to,
 * domains are transparent (they resolve to their base type, exactly as
 * PostgREST serialises them), enums become a union of their labels, composites
 * become an object type, and anything else falls back to the scalar table and
 * then to `unknown`. Never `any`: an unmapped type must fail at the call site,
 * not silently type-check.
 */
export function pgTypeToTsType(ref: PgTypeRef): string {
  if (ref.elem) {
    const inner = pgTypeToTsType(ref.elem);
    // Parenthesise unions so `('a' | 'b')[]` does not become `'a' | 'b'[]`.
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  if (ref.typeKind === 'e') {
    if (!ref.enumValues?.length) return 'string';
    return ref.enumValues.map(tsStringLiteral).join(' | ');
  }
  // A domain is a constrained alias: it carries no wire representation of its
  // own, so it is exactly its base type on the client.
  if (ref.typeKind === 'd' && ref.base) return pgTypeToTsType(ref.base);
  if (ref.typeKind === 'c') {
    if (!ref.attributes?.length) return 'unknown';
    const fields = ref.attributes.map(
      attr => `${attr.name}: ${attr.tsType}${attr.nullable === false ? '' : ' | null'}`,
    );
    return `{ ${fields.join('; ')} }`;
  }
  return SCALAR_TS_TYPES[ref.pgType] ?? 'unknown';
}
