// The raw pg_catalog reads, and the row shape each one returns. Nothing here
// interprets the rows; that is `snapshot.ts`.

// User-visible namespaces only. `!~ '^pg_'` covers pg_catalog, pg_toast and every
// pg_temp_N / pg_toast_temp_N without a LIKE-escape dance.
const USER_SCHEMAS = `n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`;

export const RELATIONS_SQL = `
  SELECT c.oid::int      AS oid,
         n.nspname       AS schema,
         c.relname       AS name,
         c.relkind::text AS kind,
         c.relrowsecurity      AS rls_enabled,
         c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND ${USER_SCHEMAS}
   ORDER BY n.nspname, c.relname
`;

export const COLUMNS_SQL = `
  SELECT a.attrelid::int AS oid,
         a.attname       AS name,
         a.attnum::int   AS position,
         t.typname       AS pg_type,
         t.typtype::text AS type_kind,
         tn.nspname      AS type_schema,
         et.typname       AS elem_type,
         et.typtype::text AS elem_type_kind,
         etn.nspname      AS elem_type_schema,
         bt.typname       AS base_type,
         bt.typtype::text AS base_type_kind,
         btn.nspname      AS base_type_schema,
         format_type(a.atttypid, a.atttypmod) AS formatted_type,
         (NOT a.attnotnull)     AS nullable,
         a.atthasdef            AS has_default_expr,
         a.attidentity::text    AS identity,
         a.attgenerated::text   AS generated,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a
    JOIN pg_class     c  ON c.oid = a.attrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_type      t  ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_type      et  ON et.oid = t.typelem AND t.typcategory = 'A'
    LEFT JOIN pg_namespace etn ON etn.oid = et.typnamespace
    LEFT JOIN pg_type      bt  ON bt.oid = t.typbasetype
    LEFT JOIN pg_namespace btn ON btn.oid = bt.typnamespace
    LEFT JOIN pg_attrdef   d   ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0
     AND NOT a.attisdropped
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND ${USER_SCHEMAS}
   ORDER BY a.attrelid, a.attnum
`;

// indkey is an int2vector; its text rendering is space separated attnums, and it
// carries INCLUDE columns past indnkeyatts, so the caller trims to the key part.
export const INDEXES_SQL = `
  SELECT ix.indrelid::int   AS oid,
         ix.indisprimary    AS is_primary,
         ix.indisunique     AS is_unique,
         (ix.indpred IS NOT NULL) AS is_partial,
         ix.indnkeyatts::int      AS key_count,
         ix.indkey::text          AS key_attnums
    FROM pg_index ix
    JOIN pg_class     c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE ix.indisvalid
     AND (ix.indisprimary OR ix.indisunique)
     AND ${USER_SCHEMAS}
`;

// conkey/confkey are smallint[]; rendered as text they are `{1,2}`. Parsing text
// avoids driver-specific array decoding differences between prisma and pg.
export const FOREIGN_KEYS_SQL = `
  SELECT con.conname       AS constraint_name,
         con.conrelid::int  AS child_oid,
         con.confrelid::int AS parent_oid,
         con.conkey::text   AS child_attnums,
         con.confkey::text  AS parent_attnums
    FROM pg_constraint con
    JOIN pg_class     c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE con.contype = 'f'
     AND ${USER_SCHEMAS}
   ORDER BY con.conname
`;

export const ENUMS_SQL = `
  SELECT n.nspname   AS schema,
         t.typname   AS name,
         e.enumlabel AS label
    FROM pg_type      t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum      e ON e.enumtypid = t.oid
   WHERE t.typtype = 'e'
     AND ${USER_SCHEMAS}
   ORDER BY n.nspname, t.typname, e.enumsortorder
`;

export const COMPOSITE_TYPES_SQL = `
  SELECT n.nspname      AS schema,
         t.typname      AS name,
         a.attname      AS attr,
         at.typname     AS pg_type,
         at.typtype::text AS type_kind,
         format_type(a.atttypid, a.atttypmod) AS formatted_type,
         (NOT a.attnotnull) AS nullable,
         a.attnum::int  AS position
    FROM pg_type      t
    JOIN pg_namespace n  ON n.oid = t.typnamespace
    JOIN pg_class     c  ON c.oid = t.typrelid AND c.relkind = 'c'
    JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type      at ON at.oid = a.atttypid
   WHERE t.typtype = 'c'
     AND ${USER_SCHEMAS}
   ORDER BY n.nspname, t.typname, a.attnum
`;

// Callable functions, for the `/rpc/` surface.
//
// Excluded on purpose, matching PostgREST:
//   - `prokind <> 'f'`: aggregates, window functions and procedures are not
//     callable through `/rpc/`.
//   - trigger functions: the database invokes them, never a client.
//   - extension-owned functions (`pg_depend.deptype = 'e'`): installing pgcrypto
//     must not publish a hundred internal helpers as REST endpoints.
export const FUNCTIONS_SQL = `
  SELECT p.oid::int           AS oid,
         n.nspname            AS schema,
         p.proname            AS name,
         p.proretset          AS returns_set,
         p.prosecdef          AS security_definer,
         p.provolatile::text  AS volatility,
         (p.provariadic <> 0) AS variadic,
         p.pronargs::int      AS n_args,
         p.pronargdefaults::int AS n_defaults,
         rt.typname           AS return_pg_type,
         rt.typtype::text     AS return_type_kind,
         rc.relname           AS return_relation
    FROM pg_proc      p
    JOIN pg_namespace n  ON n.oid = p.pronamespace
    JOIN pg_type      rt ON rt.oid = p.prorettype
    LEFT JOIN pg_class rc ON rc.oid = rt.typrelid AND rc.relkind <> 'c'
   WHERE p.prokind = 'f'
     AND ${USER_SCHEMAS}
     AND rt.typname <> 'trigger'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY n.nspname, p.proname, p.oid
`;

// `proallargtypes` is only populated when the function has OUT/INOUT parameters,
// hence the COALESCE onto `proargtypes`. Subscripting the parallel name/mode
// arrays by the unnest ordinality keeps them aligned without a three-way unnest,
// which behaves badly when any of the arrays is NULL.
export const FUNCTION_ARGS_SQL = `
  SELECT p.oid::int  AS oid,
         a.ord::int  AS position,
         COALESCE(p.proargnames[a.ord::int], '')   AS name,
         COALESCE(p.proargmodes[a.ord::int]::text, 'i') AS mode,
         t.typname   AS pg_type,
         format_type(a.atttypid, NULL) AS formatted_type
    FROM pg_proc      p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
                       WITH ORDINALITY AS a(atttypid, ord)
    JOIN pg_type      t ON t.oid = a.atttypid
   WHERE p.prokind = 'f'
     AND ${USER_SCHEMAS}
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
   ORDER BY p.oid, a.ord
`;

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface RelationRow {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}

export interface ColumnRow {
  oid: number;
  name: string;
  position: number;
  pg_type: string;
  type_kind: string;
  type_schema: string;
  elem_type: string | null;
  elem_type_kind: string | null;
  elem_type_schema: string | null;
  base_type: string | null;
  base_type_kind: string | null;
  base_type_schema: string | null;
  formatted_type: string;
  nullable: boolean;
  has_default_expr: boolean;
  identity: string | null;
  generated: string | null;
  default_expr: string | null;
}

export interface IndexRow {
  oid: number;
  is_primary: boolean;
  is_unique: boolean;
  is_partial: boolean;
  key_count: number;
  key_attnums: string;
}

export interface ForeignKeyRow {
  constraint_name: string;
  child_oid: number;
  parent_oid: number;
  child_attnums: string;
  parent_attnums: string;
}

export interface EnumRow {
  schema: string;
  name: string;
  label: string;
}

export interface CompositeRow {
  schema: string;
  name: string;
  attr: string;
  pg_type: string;
  type_kind: string;
  formatted_type: string;
  nullable: boolean;
  position: number;
}

export interface FunctionRow {
  oid: number;
  schema: string;
  name: string;
  returns_set: boolean;
  security_definer: boolean;
  volatility: string;
  variadic: boolean;
  n_args: number;
  n_defaults: number;
  return_pg_type: string;
  return_type_kind: string;
  return_relation: string | null;
}

export interface FunctionArgRow {
  oid: number;
  position: number;
  name: string;
  mode: string;
  pg_type: string;
  formatted_type: string;
}
