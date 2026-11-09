// The PostgREST AST: comparison operators and the node shapes the parser emits.
// The SQL each operator maps to lives in `sql-compiler.ts`; adding an operator
// is a row in that table plus a name here, which is the point of the split.

import { HttpException } from '../../../exceptions/http-exception';

/** PostgREST's parse-failure code, surfaced verbatim so SDK error handling matches. */
const PGRST_PARSE_ERROR = 'PGRST100';

export function parseError(message: string): HttpException {
  return new HttpException(message, 400, PGRST_PARSE_ERROR, { expose: true });
}
// ── AST ──────────────────────────────────────────────────────────────────────

/**
 * Comparison operators, exactly PostgREST's set. The SQL each one maps to lives
 * in `sql-compiler.ts`; adding an operator is a row in that table plus a name
 * here, which is the whole point of splitting the two files.
 */
const CMP_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'match',
  'imatch',
  'in',
  'is',
  'isdistinct',
  'fts',
  'plfts',
  'phfts',
  'wfts',
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
] as const;

export type CmpOp = (typeof CMP_OPS)[number];

export const CMP_OP_SET = new Set<string>(CMP_OPS);

/** The full-text-search family takes a text-search configuration, not any/all. */
export const FTS_OPS = new Set<CmpOp>(['fts', 'plfts', 'phfts', 'wfts']);

export type Modifier = 'any' | 'all';

/**
 * One step of a jsonb path. `key` renders as `-> 'k'`, `index` as `-> 3`.
 * A segment made only of digits is an index, which is how PostgREST reads
 * `data->0`. Both are parameterised by the compiler, never interpolated.
 */
export interface JsonPathStep {
  kind: 'key' | 'index';
  value: string;
}

export type FilterValue =
  /** A single literal, kept verbatim. Also carries `{a,b}` / `[1,10)` composites. */
  | { type: 'scalar'; value: string }
  /** `in.(a,b)` and the `any`/`all` modifier's `{a,b}`, already unquoted. */
  | { type: 'list'; values: string[] }
  /** `is.null` / `is.true` / `is.false` / `is.unknown`. Takes no parameter. */
  | { type: 'is'; value: 'null' | 'true' | 'false' | 'unknown' }
  /** `fts(english).word`: the tsquery text plus its optional configuration. */
  | { type: 'fts'; query: string; config: string | null };

export interface CmpFilter {
  kind: 'cmp';
  column: string;
  jsonPath?: JsonPathStep[];
  /** True when the last json separator was `->>`, so the operand is text. */
  jsonAsText?: boolean;
  op: CmpOp;
  value: FilterValue;
  modifier?: Modifier;
}

/** `not` always carries exactly one child; `and`/`or` carry one or more. */
export interface LogicFilter {
  kind: 'and' | 'or' | 'not';
  children: Filter[];
}

export type Filter = CmpFilter | LogicFilter;

export interface SelectColumn {
  kind: 'column';
  column: string;
  alias?: string;
  jsonPath?: JsonPathStep[];
  jsonAsText?: boolean;
  /** `col::text`. A bare lowercase type name, validated by `CAST_TYPE_NAME`. */
  cast?: string;
}

/**
 * An embedded resource: `author(*)`, `writer:author(*)`, `author!inner(*)`,
 * `author!fk_posts_author(*)`. Parsed here so 2.7 only has to teach the compiler
 * how to emit `LEFT JOIN LATERAL`; the grammar does not move again.
 */
export interface SelectRelation {
  kind: 'relation';
  relation: string;
  alias?: string;
  /** `!inner` turns the embed into an inner join (filters the parent rows). */
  inner?: boolean;
  /** `!<constraint>` disambiguates when two FKs reach the same table. */
  hint?: string;
  children: SelectItem[];
  /**
   * Per-embed query parameters, written `?comments.order=id.desc` and friends.
   * They are attached to the node rather than kept in a side map so the compiler
   * has everything it needs about one embedded resource in one place, at any
   * nesting depth.
   */
  filter?: Filter | null;
  order?: OrderTerm[] | null;
  take?: number;
  skip?: number;
}

export type SelectItem = { kind: 'star' } | SelectColumn | SelectRelation;

export interface OrderTerm {
  column: string;
  jsonPath?: JsonPathStep[];
  jsonAsText?: boolean;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

export interface ParsedQuery {
  /** `null` means "no filter at all", which mutation handlers refuse. */
  filter: Filter | null;
  /** `null` means "no ?select", which the compiler renders as `*`. */
  select: SelectItem[] | null;
  order: OrderTerm[] | null;
  take?: number;
  skip?: number;
  /** `?on_conflict=` target, consumed by 2.6 (upsert). Parsed, not yet used. */
  onConflict?: string[];
}
