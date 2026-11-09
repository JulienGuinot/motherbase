// The PostgREST query grammar, parsed into a typed AST. This module knows the
// SYNTAX and nothing else: it never touches the catalog, never emits SQL, and
// never decides whether a column exists. That separation is deliberate.
//
//   query string  ->  [this module]  ->  Filter AST  ->  [sql-compiler.ts]  ->  SQL
//
// Why a real parser rather than the previous `split('.')`:
//
//   - PostgREST values may be double-quoted, so `in.("a,b",c)` is a two-element
//     list, not three. A naive split silently changes the meaning of a filter,
//     and a filter that means something other than what the caller wrote is a
//     security bug on a data plane that leans on row-level security.
//   - Logic trees nest: `or=(a.eq.1,and(b.gt.2,c.is.null))`. Nesting cannot be
//     expressed by a flat key/value map at all.
//   - `not.` composes with every operator, so it belongs in the tree as a node
//     rather than as a per-operator special case.
//
// Values are kept as RAW STRINGS on purpose. PostgREST sends every literal to
// Postgres untyped and lets the server coerce it from the operand's type, which
// is why `eq.42` matches a text column containing "42" and `eq.null` matches the
// literal string "null" rather than SQL NULL. Coercing to a JavaScript number or
// boolean here would lose bigint and numeric precision and would quietly change
// those semantics. `is.null` is the only way to reach SQL NULL, exactly as in
// PostgREST.
//
// Anything malformed raises `PGRST100`, PostgREST's own parse-error code.
//
// Layered: ./ast (nodes and operators), ./lexer (splitting and column refs),
// ./filters, ./select. This file is the entry point that drives them.

import { parseError, type Filter, type ParsedQuery, type SelectItem, type SelectRelation } from './ast';
import { MAX_TAKE, peel, RESERVED_PARAMS } from './lexer';
import { conjoin, parseLogicGroup, parsePredicate } from './filters';
import { parseNonNegativeInteger, parseOrder, parseSelect } from './select';
import { parseColumnRef } from './lexer';

export { parseError } from './ast';
export type {
  CmpFilter,
  CmpOp,
  Filter,
  JsonPathStep,
  OrderTerm,
  ParsedQuery,
  SelectItem,
  SelectRelation,
} from './ast';
// ── Entry point ──────────────────────────────────────────────────────────────

/** Every value express may hand us for one query parameter, as a flat list. */
function valuesOf(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.flatMap(valuesOf);
  return [String(raw)];
}

/**
 * Parse an express `req.query` into the AST.
 *
 * Repeated parameters are ANDed together, matching PostgREST: `?a=eq.1&a=gt.0`
 * means both conditions, not "last one wins". The previous implementation kept
 * only the first value, which silently dropped half of such a filter.
 */
export function parseQuery(query: Record<string, unknown>): ParsedQuery {
  const result: ParsedQuery = { filter: null, select: null, order: null };
  const conditions: Filter[] = [];
  /** Everything that is not a reserved parameter, held until ?select is known. */
  const deferred: Array<{ key: string; values: string[] }> = [];

  // Pass one: reserved parameters only. `?select` must be parsed before any
  // other key, because whether `comments.order` is an embedded-resource
  // parameter or a filter on a column literally named `comments.order` depends
  // entirely on what the select list embeds. Object key order is not something
  // an HTTP client controls, so it cannot be relied on.
  for (const [key, raw] of Object.entries(query ?? {})) {
    const values = valuesOf(raw);
    if (!values.length) continue;

    if (!RESERVED_PARAMS.has(key)) {
      deferred.push({ key, values });
      continue;
    }

    const value = values[values.length - 1];
    if (key === 'select') result.select = parseSelect(value);
    else if (key === 'order') result.order = parseOrder(value);
    else if (key === 'limit') {
      const take = parseNonNegativeInteger(value, 'limit');
      result.take = Math.min(MAX_TAKE, take);
    } else if (key === 'offset') result.skip = parseNonNegativeInteger(value, 'offset');
    else if (key === 'on_conflict') result.onConflict = value.split(',').filter(Boolean);
    // `columns` is accepted and ignored: the write path derives its column list
    // from the body itself, which is strictly narrower than what it declares.
  }

  // Pass two: filters, logic groups and embedded-resource parameters.
  for (const { key, values } of deferred) {
    const embedded = matchEmbeddedParam(result.select, key);
    if (embedded) {
      applyEmbeddedParam(embedded.node, embedded.tail, values);
      continue;
    }

    if (key === 'and' || key === 'or' || key === 'not.and' || key === 'not.or') {
      for (const value of values) conditions.push(parseTopLevelLogic(key, value));
      continue;
    }

    const ref = parseColumnRef(key, `filter "${key}"`);
    for (const value of values) conditions.push(parsePredicate(ref, value));
  }

  result.filter = conjoin(conditions);
  return result;
}

/** `and=(..)` / `not.or=(..)` at the top level or scoped to an embedded resource. */
function parseTopLevelLogic(key: string, value: string): Filter {
  const negated = key.startsWith('not.');
  const kind = (negated ? key.slice(4) : key) as 'and' | 'or';
  const body = peel(value.trim(), '(', ')');
  if (body === null) throw parseError(`"${key}" must be written as ${key}=(..)`);
  const group = parseLogicGroup(kind, body);
  return negated ? { kind: 'not', children: [group] } : group;
}

/**
 * Resolve `comments.order`, `comments.author.limit` or `comments.id` against the
 * select list, returning the embedded node the parameter belongs to plus the
 * remaining tail.
 *
 * Only an UNQUOTED key whose leading segment names an embedded resource is
 * treated this way, so a filter on a quoted column containing a dot
 * (`?"a.b"=eq.1`) still reaches the column, exactly as it did before embedding
 * existed.
 */
function matchEmbeddedParam(
  select: SelectItem[] | null,
  key: string,
): { node: SelectRelation; tail: string } | null {
  if (!select?.length || key[0] === '"' || !key.includes('.')) return null;

  const segments = key.split('.');
  let scope: SelectItem[] = select;
  let node: SelectRelation | null = null;
  let index = 0;

  while (index < segments.length - 1) {
    const name = segments[index];
    const match = scope.find(
      (item): item is SelectRelation =>
        item.kind === 'relation' && (item.alias === name || (!item.alias && item.relation === name)),
    );
    if (!match) break;
    node = match;
    scope = match.children;
    index += 1;
  }

  if (!node) return null;
  return { node, tail: segments.slice(index).join('.') };
}

/** Apply one `?<embed>.<param>=` value to its embedded node. */
function applyEmbeddedParam(node: SelectRelation, tail: string, values: string[]): void {
  const last = values[values.length - 1];

  if (tail === 'order') {
    node.order = parseOrder(last);
    return;
  }
  if (tail === 'limit') {
    node.take = Math.min(MAX_TAKE, parseNonNegativeInteger(last, 'limit'));
    return;
  }
  if (tail === 'offset') {
    node.skip = parseNonNegativeInteger(last, 'offset');
    return;
  }
  if (tail === 'select' || tail === 'on_conflict' || tail === 'columns') {
    throw parseError(`"${tail}" cannot be scoped to an embedded resource`);
  }

  const added: Filter[] =
    tail === 'and' || tail === 'or' || tail === 'not.and' || tail === 'not.or'
      ? values.map(value => parseTopLevelLogic(tail, value))
      : (() => {
          const ref = parseColumnRef(tail, `filter "${tail}"`);
          return values.map(value => parsePredicate(ref, value));
        })();

  // Repeated parameters on one embed conjoin, exactly as they do at top level.
  const existing = node.filter ? [node.filter] : [];
  node.filter = conjoin([...existing, ...added]);
}
