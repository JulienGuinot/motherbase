// The single place where a parsed PostgREST query becomes SQL. One compiler, one
// operator table, one rule for parameters.
//
//   query string -> [postgrest-parser.ts] -> Filter AST -> [this module] -> SQL
//
// ── The two invariants ───────────────────────────────────────────────────────
//
//  1. Every identifier that reaches the SQL text is a column name that EXISTS in
//     the catalog snapshot for the target table, rendered through `quoteIdent`.
//     A request naming an unknown column is a 400 before any SQL is built, so an
//     attacker cannot smuggle syntax through a column position.
//
//  2. Every VALUE is a bound parameter. Not just filter literals: json path keys
//     (`data->>'k'`) and text-search configurations (`fts(english)`) are bound
//     too, because they are user input as much as the right-hand side is. The
//     only user-derived text that ever lands in the SQL string is a validated
//     column or alias identifier. `sql-compiler.fuzz` asserts this.
//
// ── Typing of parameters ─────────────────────────────────────────────────────
//
// Values are sent as untyped literals and let Postgres coerce them from the
// operand's type, which is exactly what PostgREST does and is why `eq.42` works
// against an int column and a text column alike. An explicit cast is added only
// where inference cannot succeed: array parameters (`= ANY($1::int4[])`) and the
// polymorphic array/range operators (`@>`, `<<`, `-|-`, ...), whose signatures
// are `anyarray`/`anyrange` and therefore cannot resolve an `unknown` argument.
// The cast text comes from the catalog's `format_type()` output, never from the
// request, and is re-validated against `SAFE_TYPE_NAME` before use.
//
// ── Count and embedding ──────────────────────────────────────────────────────
//
// `Prefer: count=exact` needs `count(*) OVER () AS "..."` appended to the
// projection of the same SELECT. `selectToSql` builds only the projection list
// and takes no part in filter or FROM construction, so count is one extra
// element in that list; nothing about filtering changes.
//
// Relational embedding compiles the embedded table's filters inside a
// `LEFT JOIN LATERAL (SELECT json_agg(...) FROM child WHERE child.fk =
// parent.pk AND <embedded filter>) ON TRUE`. Three things make that work with
// one code path:
//
//   - `CompileContext.alias` prefixes every column reference, so the same
//     `filterToSql` compiles the parent's filter unqualified and the child's
//     filter qualified without a second code path.
//   - `CompileContext.params` is a shared, ordered accumulator passed by
//     reference, so a subquery compiled after the parent keeps appending to one
//     parameter list and the placeholder numbering stays correct across nesting.
//   - `CompileContext.table` is the catalog table being compiled, so column
//     validation for the child resolves against the child's columns. The FK edge
//     itself comes from `CatalogTable.foreignKeys`, which the catalog already
//     records in both directions with a `cardinality` to pick object vs array.
//
// The embedded subquery is compiled into the SAME statement, so it executes in
// the same `RlsPool.withRlsTx` transaction under the same `anon`/`authenticated`
// role and RLS filters embedded rows automatically.

import { HttpException } from '../../exceptions/http-exception';
import { quoteIdent } from '../admin/schema-ddl';
import type { CatalogForeignKey, CatalogColumn, CatalogSnapshot, CatalogTable } from './catalog';
import {
  parseError,
  type CmpFilter,
  type CmpOp,
  type Filter,
  type JsonPathStep,
  type OrderTerm,
  type SelectItem,
  type SelectRelation,
} from './postgrest-parser';

/** Ordered, shared parameter accumulator. One per statement. */
export interface ParamList {
  readonly values: unknown[];
  /** Bind `value` and return its placeholder (`$3`). */
  push(value: unknown): string;
}

export function createParams(initial: unknown[] = []): ParamList {
  const values = [...initial];
  return {
    values,
    push(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * Everything relational embedding needs that is not per-scope, shared by one
 * whole statement.
 *
 * `guard` is the security seam. The compiler resolves an embed target through
 * the catalog FK graph, but it is the SERVICE that decides whether that table
 * may be exposed at all (public schema, base relation, not on the block list).
 * Routing every embed target through the caller's own guard is what stops an
 * embed from becoming a hole around the checks the top-level path applies.
 *
 * `reached` records every table an embed touched, so the caller can apply the
 * `relrowsecurity` gate to embedded tables too and not only to the entry point.
 */
export interface EmbedScope {
  catalog: CatalogSnapshot;
  guard(table: CatalogTable): void;
  reached: CatalogTable[];
  /** Monotonic counter behind `nextAlias`. One per statement. */
  seq: { value: number };
}

export function createEmbedScope(
  catalog: CatalogSnapshot,
  guard: (table: CatalogTable) => void,
): EmbedScope {
  return { catalog, guard, reached: [], seq: { value: 0 } };
}

export interface CompileContext {
  /** Catalog table whose columns every reference is validated against. */
  table: CatalogTable;
  /** Shared parameter accumulator; passed by reference across nested scopes. */
  params: ParamList;
  /** Relation alias to qualify column references with. Used by embedding. */
  alias?: string;
  /**
   * LATERAL join fragments produced while compiling THIS scope's projection.
   * Scope-local on purpose: a nested embed's joins belong inside the nested
   * subquery's FROM, not in its parent's.
   */
  joins: string[];
  /** Absent when the caller does not allow embedding (the write paths). */
  embed?: EmbedScope;
}

export function createContext(
  table: CatalogTable,
  params: ParamList,
  alias?: string,
  embed?: EmbedScope,
): CompileContext {
  return { table, params, alias, joins: [], embed };
}

// ── Identifier and type validation ───────────────────────────────────────────

/**
 * Conservative allowlist for a `format_type()` rendering: `text`, `text[]`,
 * `character varying(255)`, `numeric(10,2)`, `timestamp with time zone`,
 * `public.mood`. Anything else (an identifier needing quoting, say) falls back
 * to emitting no cast at all, which is the safe direction: Postgres either
 * infers the type or rejects the query, and nothing unvalidated is inlined.
 */
const SAFE_TYPE_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_ ]*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])*$/;

function safeTypeName(formatted: string | null | undefined): string | null {
  if (!formatted || !SAFE_TYPE_NAME.test(formatted)) return null;
  return formatted;
}

/**
 * Resolve a column against the catalog snapshot. This is the field allowlist for
 * the whole REST surface: filters, ?select, ?order and the write-body key check
 * all funnel through it, so there is exactly one definition of "known column".
 */
export function assertColumn(ctx: CompileContext, name: string): CatalogColumn {
  const column = ctx.table.columns.find(candidate => candidate.name === name);
  if (!column) {
    throw new HttpException(`Unknown field "${name}" on ${ctx.table.name}`, 400, 'PGRST204', { expose: true });
  }
  return column;
}

function relationPrefix(ctx: CompileContext): string {
  return ctx.alias ? `${quoteIdent(ctx.alias)}.` : '';
}

/**
 * Render a column, optionally with its json path. Path keys are bound, not
 * interpolated: `data -> $1::text ->> $2::text`. The explicit casts pick the
 * `jsonb -> text` and `jsonb -> integer` operators, which an untyped parameter
 * would leave ambiguous.
 */
function columnRef(ctx: CompileContext, name: string, jsonPath?: JsonPathStep[], jsonAsText?: boolean): string {
  assertColumn(ctx, name);
  let sql = `${relationPrefix(ctx)}${quoteIdent(name)}`;
  if (!jsonPath?.length) return sql;

  jsonPath.forEach((step, index) => {
    const last = index === jsonPath.length - 1;
    const arrow = last && jsonAsText ? '->>' : '->';
    const cast = step.kind === 'index' ? '::int' : '::text';
    sql += ` ${arrow} ${ctx.params.push(step.value)}${cast}`;
  });
  return `(${sql})`;
}

/**
 * The Postgres type of the left-hand operand, used to cast the parameter for the
 * polymorphic operators. A json path yields `text` or `jsonb` depending on the
 * final arrow, matching what Postgres itself produces.
 */
function operandType(ctx: CompileContext, node: CmpFilter): string | null {
  if (node.jsonPath?.length) return node.jsonAsText ? 'text' : 'jsonb';
  return safeTypeName(assertColumn(ctx, node.column).formattedType);
}

// ── Operator table ───────────────────────────────────────────────────────────

type CastRule =
  /** Send the literal untyped and let Postgres infer from the operand. */
  | 'infer'
  /** Cast to the left-hand operand's type (required by anyarray/anyrange ops). */
  | 'operand'
  /** Pattern and regex operators always compare as text. */
  | 'text';

interface OperatorSpec {
  /** Infix SQL operator, for everything except `is` and the fts family. */
  sql?: string;
  cast: CastRule;
  /** Human-readable name used in error messages. */
  label: string;
  /** tsquery constructor, for the full-text-search family. */
  tsquery?: string;
  /** `is` takes a keyword, not a parameter. */
  keyword?: true;
  /** `in` is always a list, with or without an any/all modifier. */
  list?: true;
}

/**
 * The complete PostgREST operator set. Adding an operator is one row here plus
 * one name in `CMP_OPS`; there is no other place to touch, which is the reason
 * the parser and the compiler are separate modules.
 */
const OPERATORS: Readonly<Record<CmpOp, OperatorSpec>> = Object.freeze({
  eq: { sql: '=', cast: 'infer', label: 'equals' },
  neq: { sql: '<>', cast: 'infer', label: 'not equals' },
  gt: { sql: '>', cast: 'infer', label: 'greater than' },
  gte: { sql: '>=', cast: 'infer', label: 'greater than or equal' },
  lt: { sql: '<', cast: 'infer', label: 'less than' },
  lte: { sql: '<=', cast: 'infer', label: 'less than or equal' },
  like: { sql: 'LIKE', cast: 'text', label: 'like' },
  ilike: { sql: 'ILIKE', cast: 'text', label: 'case-insensitive like' },
  match: { sql: '~', cast: 'text', label: 'regex match' },
  imatch: { sql: '~*', cast: 'text', label: 'case-insensitive regex match' },
  in: { sql: '=', cast: 'operand', label: 'in list', list: true },
  is: { cast: 'infer', label: 'is', keyword: true },
  isdistinct: { sql: 'IS DISTINCT FROM', cast: 'operand', label: 'is distinct from' },
  fts: { cast: 'text', label: 'full-text search', tsquery: 'to_tsquery' },
  plfts: { cast: 'text', label: 'plain full-text search', tsquery: 'plainto_tsquery' },
  phfts: { cast: 'text', label: 'phrase full-text search', tsquery: 'phraseto_tsquery' },
  wfts: { cast: 'text', label: 'web full-text search', tsquery: 'websearch_to_tsquery' },
  // Array / range / jsonb containment. All three are polymorphic in Postgres
  // (`anyarray @> anyarray`), so the parameter must carry an explicit cast.
  cs: { sql: '@>', cast: 'operand', label: 'contains' },
  cd: { sql: '<@', cast: 'operand', label: 'contained by' },
  ov: { sql: '&&', cast: 'operand', label: 'overlaps' },
  // Range placement operators, likewise polymorphic (`anyrange << anyrange`).
  sl: { sql: '<<', cast: 'operand', label: 'strictly left of' },
  sr: { sql: '>>', cast: 'operand', label: 'strictly right of' },
  nxr: { sql: '&<', cast: 'operand', label: 'does not extend to the right of' },
  nxl: { sql: '&>', cast: 'operand', label: 'does not extend to the left of' },
  adj: { sql: '-|-', cast: 'operand', label: 'is adjacent to' },
});

const IS_KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  null: 'NULL',
  true: 'TRUE',
  false: 'FALSE',
  unknown: 'UNKNOWN',
});

function castSuffix(ctx: CompileContext, node: CmpFilter, rule: CastRule, array: boolean): string {
  let type: string | null;
  if (rule === 'infer') type = null;
  else if (rule === 'text') type = 'text';
  else type = operandType(ctx, node);

  // No usable cast (an exotic type name that needs quoting): fall back to
  // inference. Never inline a string that did not pass validation.
  if (!type) return '';
  return array ? `::${type}[]` : `::${type}`;
}

function compileCmp(node: CmpFilter, ctx: CompileContext): string {
  const spec = OPERATORS[node.op];
  if (!spec) throw parseError(`Unknown operator "${node.op}"`);
  const lhs = columnRef(ctx, node.column, node.jsonPath, node.jsonAsText);

  if (spec.keyword) {
    if (node.value.type !== 'is') throw parseError(`"${node.op}" expects null, true, false or unknown`);
    return `${lhs} IS ${IS_KEYWORDS[node.value.value]}`;
  }

  if (spec.tsquery) {
    if (node.value.type !== 'fts') throw parseError(`"${node.op}" expects a search query`);
    // The configuration is bound and cast to regconfig; it is user input and is
    // never spliced into the statement text.
    const args = node.value.config
      ? `${ctx.params.push(node.value.config)}::regconfig, ${ctx.params.push(node.value.query)}`
      : ctx.params.push(node.value.query);
    return `${lhs} @@ ${spec.tsquery}(${args})`;
  }

  // `in.(..)`, and any operator carrying an `any`/`all` modifier, compare against
  // an array parameter. node-pg serialises a JavaScript array into a Postgres
  // array literal with correct quoting, so an element containing a comma or a
  // brace cannot break out of the literal.
  if (spec.list || node.modifier) {
    if (node.value.type !== 'list') throw parseError(`"${node.op}" expects a list value`);
    const quantifier = node.modifier === 'all' ? 'ALL' : 'ANY';
    const placeholder = ctx.params.push(node.value.values);
    // An array parameter always needs an explicit cast: `x = ANY($1)` gives
    // Postgres nothing to infer the array type from, unlike the scalar form.
    // Pattern operators still compare as text; everything else takes the
    // operand's own type.
    const rule: CastRule = spec.cast === 'text' ? 'text' : 'operand';
    return `${lhs} ${spec.sql} ${quantifier}(${placeholder}${castSuffix(ctx, node, rule, true)})`;
  }

  if (node.value.type !== 'scalar') throw parseError(`"${node.op}" expects a single value`);
  const placeholder = ctx.params.push(node.value.value);
  return `${lhs} ${spec.sql} ${placeholder}${castSuffix(ctx, node, spec.cast, false)}`;
}

// ── Public compilation entry points ──────────────────────────────────────────

/**
 * Compile a filter tree to a WHERE fragment plus its parameters.
 *
 * The returned `params` is the shared accumulator's live array, so a caller that
 * seeds `createParams` with UPDATE `SET` values (which must be bound first) gets
 * one correctly ordered list back.
 */
export function filterToSql(node: Filter, ctx: CompileContext): { sql: string; params: unknown[] } {
  return { sql: compileFilter(node, ctx), params: ctx.params.values };
}

function compileFilter(node: Filter, ctx: CompileContext): string {
  if (node.kind === 'cmp') return compileCmp(node, ctx);
  if (node.kind === 'not') {
    const child = node.children[0];
    if (!child) throw parseError('"not" requires exactly one operand');
    return `NOT (${compileFilter(child, ctx)})`;
  }
  if (!node.children.length) throw parseError(`Empty ${node.kind}() group`);
  const joiner = node.kind === 'and' ? ' AND ' : ' OR ';
  return `(${node.children.map(child => compileFilter(child, ctx)).join(joiner)})`;
}

/**
 * Compile `?select` into a projection list.
 *
 * Kept separate from filter compilation so counting can append `count(*) OVER ()`
 * and embedding a `LEFT JOIN LATERAL` payload column without touching either.
 */
export function selectToSql(select: SelectItem[] | null, ctx: CompileContext): string {
  if (!select?.length) return `${relationPrefix(ctx)}*`;

  const parts = select.map(item => {
    if (item.kind === 'star') return `${relationPrefix(ctx)}*`;
    if (item.kind === 'relation') return compileRelation(item, ctx);

    let ref = columnRef(ctx, item.column, item.jsonPath, item.jsonAsText);
    // The cast text passed `CAST_TYPE_NAME` in the parser: a bare lowercase
    // identifier with an optional `[]`. It is inlined because a type name can be
    // neither bound nor quoted, and it is the only such value in the compiler.
    if (item.cast) ref = `(${ref})::${item.cast}`;
    // PostgREST names a json-path column after its last path segment; keeping the
    // alias explicit means the response key never depends on the driver.
    const implicitAlias = item.jsonPath?.length ? item.jsonPath[item.jsonPath.length - 1].value : null;
    const alias = item.alias ?? implicitAlias;
    return alias && alias !== item.column ? `${ref} AS ${quoteIdent(alias)}` : ref;
  });

  return parts.join(', ');
}

// ── Relational embedding ─────────────────────────────────────────────────────
//
// One embedded resource compiles to one correlated LATERAL subquery in the
// parent's FROM clause, plus one column in the parent's projection:
//
//   SELECT "posts".*, "mb_e1"."payload" AS "comments"
//     FROM "public"."posts" "posts"
//     LEFT JOIN LATERAL (
//       SELECT coalesce(json_agg("mb_e1_j"), '[]'::json) AS "payload"
//         FROM (SELECT "mb_e1".* FROM "public"."comments" "mb_e1"
//                WHERE "mb_e1"."post_id" = "posts"."id" AND ...
//                ORDER BY ... LIMIT ...) "mb_e1_j"
//     ) "mb_e1" ON TRUE
//
// Three properties follow from compiling it into the SAME statement rather than
// issuing a second query:
//
//   - It runs in the caller's `withRlsTx` transaction under the caller's role,
//     so the embedded rows are filtered by the child table's own policies. There
//     is no second connection and no second role for a policy to miss.
//   - The parameter numbering stays contiguous, because `ctx.params` is one
//     shared accumulator threaded through every nested scope.
//   - Column validation for the child resolves against the CHILD's catalog
//     entry, since the nested context carries the child table.

/** Relationship-not-found and ambiguous-relationship, PostgREST's own codes. */
const PGRST_NO_RELATIONSHIP = 'PGRST200';
const PGRST_AMBIGUOUS_RELATIONSHIP = 'PGRST201';

/**
 * Pick the foreign key that connects `parent` to the embedded resource.
 *
 * A hint (`author!fk_posts_author(*)`) may name the constraint or either side's
 * column, which is what PostgREST accepts. With no hint and more than one
 * candidate the request is ambiguous and must fail loudly: silently picking the
 * first FK would return a different resource than the caller asked for, and on a
 * data plane that is a correctness bug with security consequences.
 */
function resolveRelationship(item: SelectRelation, ctx: CompileContext): CatalogForeignKey {
  const parent = ctx.table;
  const candidates = parent.foreignKeys.filter(fk => fk.toTable === item.relation);

  if (!candidates.length) {
    throw new HttpException(
      `Could not find a relationship between "${parent.name}" and "${item.relation}" in the schema cache.`,
      400,
      PGRST_NO_RELATIONSHIP,
      { expose: true },
    );
  }

  const matching = item.hint
    ? candidates.filter(
        fk =>
          fk.constraint === item.hint ||
          fk.fromCols.includes(item.hint as string) ||
          fk.toCols.includes(item.hint as string),
      )
    : candidates;

  if (!matching.length) {
    throw new HttpException(
      `No relationship between "${parent.name}" and "${item.relation}" matches the hint "${item.hint}".`,
      400,
      PGRST_NO_RELATIONSHIP,
      { expose: true },
    );
  }

  if (matching.length > 1) {
    // Both sides of every candidate edge, because the useful discriminator is
    // the child's column on an inbound edge and the parent's on an outbound one.
    const hints = matching
      .map(
        fk =>
          `${fk.constraint} (${parent.name}.${fk.fromCols.join(',')} -> ${fk.toTable}.${fk.toCols.join(',')})`,
      )
      .join('; ');
    throw new HttpException(
      `Could not embed because more than one relationship was found for "${parent.name}" and ` +
        `"${item.relation}". Disambiguate with ${item.relation}!<hint>, where <hint> is one of: ${hints}.`,
      400,
      PGRST_AMBIGUOUS_RELATIONSHIP,
      { expose: true },
    );
  }

  return matching[0];
}

/** `comments(count)`: a lone bare `count` child, PostgREST's count aggregate. */
function isCountAggregate(children: SelectItem[]): boolean {
  return (
    children.length === 1 &&
    children[0].kind === 'column' &&
    children[0].column === 'count' &&
    !children[0].alias &&
    !children[0].jsonPath &&
    !children[0].cast
  );
}

function compileRelation(item: SelectRelation, ctx: CompileContext): string {
  const embed = ctx.embed;
  if (!embed || !ctx.alias) {
    throw new HttpException(
      `Relational embedding of "${item.relation}" is not supported on this request.`,
      400,
      'PGRST100',
      { expose: true },
    );
  }

  const fk = resolveRelationship(item, ctx);
  const child = embed.catalog.table(fk.toSchema, fk.toTable);
  if (!child) {
    throw new HttpException(
      `Could not find a relationship between "${ctx.table.name}" and "${item.relation}" in the schema cache.`,
      400,
      PGRST_NO_RELATIONSHIP,
      { expose: true },
    );
  }
  // The service's own exposure rules, applied to the embed target exactly as they
  // are applied to the table named in the URL. Blocked and system tables can
  // therefore never be reached sideways through a foreign key.
  embed.guard(child);
  if (!embed.reached.includes(child)) embed.reached.push(child);

  embed.seq.value += 1;
  const childAlias = `mb_e${embed.seq.value}`;
  const rowAlias = `${childAlias}_j`;
  const key = item.alias ?? item.relation;
  const toMany = fk.cardinality === 'many';

  const childCtx = createContext(child, ctx.params, childAlias, embed);

  // The correlation predicate. `fromCols` are always the PARENT's columns and
  // `toCols` the child's, in both FK directions, so one expression covers the
  // outbound (child is the referenced parent table) and inbound cases alike.
  const correlation = fk.fromCols
    .map((parentCol, index) => {
      assertColumn(ctx, parentCol);
      assertColumn(childCtx, fk.toCols[index]);
      return (
        `${quoteIdent(childAlias)}.${quoteIdent(fk.toCols[index])} = ` +
        `${quoteIdent(ctx.alias as string)}.${quoteIdent(parentCol)}`
      );
    })
    .join(' AND ');

  // The embedded resource's own filter, compiled with the CHILD's context so its
  // columns are validated against the child and qualified with the child alias.
  const embeddedWhere = item.filter ? ` AND (${compileFilter(item.filter, childCtx)})` : '';
  const childRelation = `${quoteIdent(child.schema)}.${quoteIdent(child.name)} ${quoteIdent(childAlias)}`;
  const scope = `FROM ${childRelation} WHERE ${correlation}${embeddedWhere}`;

  let payload: string;
  if (isCountAggregate(item.children)) {
    // PostgREST answers `comments(count)` with `[{"count": n}]` for a to-many
    // relationship and `{"count": n}` for a to-one one.
    const object = `json_build_object('count', count(*))`;
    const shaped = toMany ? `json_build_array(${object})` : object;
    // An inner count embed keeps only parents that have at least one child.
    const having = item.inner ? ' HAVING count(*) > 0' : '';
    payload = `SELECT ${shaped} AS "payload" ${scope}${having}`;
  } else {
    const projection = selectToSql(item.children.length ? item.children : null, childCtx);
    const childJoins = childCtx.joins.length ? ` ${childCtx.joins.join(' ')}` : '';
    const order = orderToSql(item.order ?? null, childCtx);
    // A to-one embed can only ever produce one row, so it is capped at 1 whatever
    // the caller asked for. That is also what makes `to_json` correct below.
    const take = toMany ? item.take : 1;
    const rows =
      `SELECT ${projection} FROM ${childRelation}${childJoins} WHERE ${correlation}${embeddedWhere}` +
      `${order ? ` ORDER BY ${order}` : ''}` +
      `${typeof take === 'number' ? ` LIMIT ${Math.trunc(take)}` : ''}` +
      `${typeof item.skip === 'number' && toMany ? ` OFFSET ${Math.trunc(item.skip)}` : ''}`;

    if (!toMany) {
      // Zero child rows means zero subquery rows, so a LEFT JOIN yields NULL and
      // an inner one drops the parent. No coalesce and no HAVING needed.
      payload = `SELECT to_json(${quoteIdent(rowAlias)}) AS "payload" FROM (${rows}) ${quoteIdent(rowAlias)}`;
    } else if (item.inner) {
      // `json_agg` over an empty set is one row holding NULL, so an inner join
      // would not filter anything on its own: HAVING is what does the filtering.
      payload =
        `SELECT json_agg(${quoteIdent(rowAlias)}) AS "payload" ` +
        `FROM (${rows}) ${quoteIdent(rowAlias)} HAVING count(*) > 0`;
    } else {
      // PostgREST renders an empty to-many embed as [], never as null.
      payload =
        `SELECT coalesce(json_agg(${quoteIdent(rowAlias)}), '[]'::json) AS "payload" ` +
        `FROM (${rows}) ${quoteIdent(rowAlias)}`;
    }
  }

  const joinKind = item.inner ? 'JOIN' : 'LEFT JOIN';
  ctx.joins.push(`${joinKind} LATERAL (${payload}) ${quoteIdent(childAlias)} ON TRUE`);
  return `${quoteIdent(childAlias)}."payload" AS ${quoteIdent(key)}`;
}

/** Compile `?order` into an ORDER BY list. Returns `''` when there is no order. */
export function orderToSql(order: OrderTerm[] | null, ctx: CompileContext): string {
  if (!order?.length) return '';
  return order
    .map(term => {
      const ref = columnRef(ctx, term.column, term.jsonPath, term.jsonAsText);
      const direction = term.direction === 'desc' ? 'DESC' : 'ASC';
      const nulls = term.nulls ? ` NULLS ${term.nulls === 'first' ? 'FIRST' : 'LAST'}` : '';
      return `${ref} ${direction}${nulls}`;
    })
    .join(', ');
}
