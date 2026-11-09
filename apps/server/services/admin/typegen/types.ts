// The structured JSON contract of `motherbase gen types typescript`.
// `GET /admin/schema/types` returns exactly this shape, so the CLI, Studio and
// any MCP consumer read one source of truth instead of parsing rendered text.

// ── Structured output (the JSON contract) ─────────────────────────────────────

export interface TypegenColumn {
  name: string;
  pgType: string;
  formattedType: string;
  /** Plain TypeScript rendering, with enums inlined as a label union. */
  tsType: string;
  nullable: boolean;
  hasDefault: boolean;
  isGenerated: boolean;
  isPk: boolean;
  isArray: boolean;
  /** Unqualified enum name when this column (or its array element) is an enum. */
  enumRef: string | null;
  /** Unqualified composite-type name when this column is a composite. */
  compositeRef: string | null;
}

/**
 * PostgREST's relationship record, field for field. supabase-js reads these to
 * type embedded selects, so the names are not ours to choose.
 */
export interface TypegenRelationship {
  foreignKeyName: string;
  columns: string[];
  isOneToOne: boolean;
  referencedRelation: string;
  referencedColumns: string[];
}

export interface TypegenRelation {
  name: string;
  kind: 'table' | 'view';
  columns: TypegenColumn[];
  primaryKey: string[];
  relationships: TypegenRelationship[];
  rlsEnabled: boolean;
}

export interface TypegenFunctionArg {
  name: string;
  pgType: string;
  tsType: string;
  /** True when the argument has a DEFAULT and may be omitted by the caller. */
  optional: boolean;
}

export interface TypegenFunction {
  name: string;
  args: TypegenFunctionArg[];
  returnsSet: boolean;
  returnPgType: string;
  /** Plain TypeScript rendering of one returned value (never the set wrapper). */
  returnTsType: string;
  /** Relation whose Row type this function returns, when it returns one. */
  returnRelation: string | null;
  returnEnumRef: string | null;
  returnCompositeRef: string | null;
}

export interface TypegenEnum {
  name: string;
  values: string[];
}

export interface TypegenCompositeType {
  name: string;
  attributes: { name: string; tsType: string; nullable: boolean }[];
}

export interface TypegenCatalog {
  schema: string;
  tables: TypegenRelation[];
  views: TypegenRelation[];
  functions: TypegenFunction[];
  enums: TypegenEnum[];
  compositeTypes: TypegenCompositeType[];
}

/**
 * What the SDK addresses by name outside any Postgres schema, rendered under
 * `Database['__InternalMotherbase']` so `createClient<Database>()` stays the
 * one generic a user passes. Project-wide, so the same whichever schema is
 * generated.
 */
export interface TypegenResources {
  /** Edge function routes: the name `functions.invoke(name)` takes. */
  edgeFunctions: string[];
  /** Bucket slugs: the id `storage.from(bucket)` takes. */
  buckets: string[];
}

export interface TypegenResult {
  schema: string;
  catalog: TypegenCatalog;
  resources: TypegenResources;
  /** The rendered `database.types.ts`, LF terminated. */
  types: string;
  /** The same catalog rendered as zod schemas, LF terminated. */
  zod: string;
}
