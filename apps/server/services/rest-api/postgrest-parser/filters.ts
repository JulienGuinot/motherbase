// Filter parsing: the value half of `column=[not.]op[(modifier)].value`, plus
// the `and(...)` / `or(...)` / `not.and(...)` logic trees.

import { parseError, type CmpFilter, type CmpOp, type Filter, type FilterValue, type LogicFilter, type Modifier } from './ast';
import { CMP_OP_SET, FTS_OPS } from './ast';
import { BARE_IDENTIFIER, indexOfTopLevel, peel, splitTopLevel, unquote, type ColumnRef } from './lexer';
import { parseColumnRef } from './lexer';
// ── Filter parsing ───────────────────────────────────────────────────────────

/**
 * Parse the value half of a filter: `[not.]op[(modifier)].value`.
 *
 * Returns a `cmp` node, wrapped in a `not` node when the `not.` prefix (or the
 * legacy `is.not.null` spelling) is present.
 */
export function parsePredicate(ref: ColumnRef, expression: string): Filter {
  let rest = expression;
  let negated = false;

  if (rest.startsWith('not.')) {
    negated = true;
    rest = rest.slice(4);
  }

  // Operator names are bare lowercase words, so the operator token ends at the
  // first character that is not one. That is either `.` (plain operator) or `(`
  // (an `any`/`all` modifier, or a text-search configuration).
  const opMatch = /^[a-z]+/.exec(rest);
  if (!opMatch) throw parseError(`Failed to parse filter (${expression}): expected <operator>.<value>`);

  const op = opMatch[0];
  if (!CMP_OP_SET.has(op)) throw parseError(`Unknown operator "${op}" in filter (${expression})`);
  const cmpOp = op as CmpOp;

  let modifierOrConfig: string | null = null;
  let cursor = rest.slice(op.length);
  if (cursor[0] === '(') {
    const close = cursor.indexOf(')');
    if (close === -1) throw parseError(`Unterminated operator modifier in filter (${expression})`);
    modifierOrConfig = cursor.slice(1, close);
    cursor = cursor.slice(close + 1);
  }
  if (cursor[0] !== '.') throw parseError(`Failed to parse filter (${expression}): expected a value`);
  const rawValue = cursor.slice(1);

  let modifier: Modifier | undefined;
  let config: string | null = null;
  if (modifierOrConfig !== null) {
    if (FTS_OPS.has(cmpOp)) {
      if (!BARE_IDENTIFIER.test(modifierOrConfig)) {
        throw parseError(`Invalid text search configuration "${modifierOrConfig}"`);
      }
      config = modifierOrConfig;
    } else if (modifierOrConfig === 'any' || modifierOrConfig === 'all') {
      modifier = modifierOrConfig;
    } else {
      throw parseError(`Invalid operator modifier "(${modifierOrConfig})" in filter (${expression})`);
    }
  }

  const node: CmpFilter = {
    kind: 'cmp',
    column: ref.column,
    op: cmpOp,
    value: parseValue(cmpOp, rawValue, modifier, config, expression),
  };
  if (ref.jsonPath) {
    node.jsonPath = ref.jsonPath;
    node.jsonAsText = ref.jsonAsText;
  }
  if (modifier) node.modifier = modifier;

  // `is.not.null` is folded into the same `not` node the `not.` prefix produces,
  // so the compiler only ever sees `is` with a concrete value. Written together
  // (`not.is.not.null`) the two negations cancel, as they do in Postgres.
  if (node.op === 'is' && rawValue.startsWith('not.')) negated = !negated;
  return negated ? { kind: 'not', children: [node] } : node;
}

function parseValue(
  op: CmpOp,
  raw: string,
  modifier: Modifier | undefined,
  config: string | null,
  expression: string,
): FilterValue {
  if (modifier) {
    // `like(any).{a,b}` / `eq(all).{1,2}`: always a braced list, even for one item.
    const body = peel(raw, '{', '}');
    if (body === null) throw parseError(`Operator modifier (${modifier}) needs a {..} list in (${expression})`);
    const values = splitList(body);
    // The `*` wildcard is translated inside a modifier list too, so
    // `like(any).{*jo*,*an*}` behaves like two `like.*..*` filters.
    return { type: 'list', values: isPatternOp(op) ? values.map(toSqlPattern) : values };
  }

  if (op === 'is') {
    // `is.not.null` and friends: the `not.` was already recorded by the caller.
    const literal = (raw.startsWith('not.') ? raw.slice(4) : raw).toLowerCase();
    if (literal === 'null' || literal === 'true' || literal === 'false' || literal === 'unknown') {
      return { type: 'is', value: literal };
    }
    throw parseError(`"is" accepts null, true, false or unknown, got "${raw}"`);
  }

  if (op === 'in') {
    const body = peel(raw, '(', ')');
    if (body === null) throw parseError(`"in" needs a (..) list, got "${raw}"`);
    return { type: 'list', values: splitList(body) };
  }

  if (FTS_OPS.has(op)) {
    return { type: 'fts', query: unquote(raw), config };
  }

  if (isPatternOp(op)) return { type: 'scalar', value: toSqlPattern(unquote(raw)) };

  // Everything else (including the `{a,b}` array literals of cs/cd/ov and the
  // `[1,10)` range literals of the range operators) is one opaque literal that
  // Postgres itself parses once the compiler casts the parameter.
  return { type: 'scalar', value: unquote(raw) };
}

function isPatternOp(op: CmpOp): boolean {
  return op === 'like' || op === 'ilike';
}

/**
 * PostgREST accepts `*` as a friendlier `%`, because `%` has to be
 * percent-encoded in a URL. A literal `%` is passed through unchanged.
 */
function toSqlPattern(value: string): string {
  return value.replace(/\*/g, '%');
}

/** Split a `{..}` or `(..)` body into unquoted elements. `{}` is the empty list. */
function splitList(body: string): string[] {
  if (body.trim() === '') return [];
  return splitTopLevel(body, ',').map(part => unquote(part.trim()));
}

/**
 * Parse one branch of a logic group: either a nested `[not.](and|or)(..)` group
 * or a `column.[not.]op.value` filter.
 */
function parseLogicBranch(raw: string): Filter {
  const branch = raw.trim();
  if (!branch) throw parseError('Empty logic branch');

  const group = /^(not\.)?(and|or)\(/.exec(branch);
  if (group) {
    if (!branch.endsWith(')')) throw parseError(`Unterminated logic group "${branch}"`);
    const body = branch.slice(group[0].length, -1);
    const node = parseLogicGroup(group[2] as 'and' | 'or', body);
    return group[1] ? { kind: 'not', children: [node] } : node;
  }

  const dot = indexOfTopLevel(branch, '.');
  if (dot === -1) throw parseError(`Failed to parse filter (${branch}): expected <column>.<operator>.<value>`);
  const ref = parseColumnRef(branch.slice(0, dot), `filter (${branch})`);
  return parsePredicate(ref, branch.slice(dot + 1));
}

export function parseLogicGroup(kind: 'and' | 'or', body: string): LogicFilter {
  const children = splitTopLevel(body, ',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(parseLogicBranch);
  // An empty group would compile to a tautology, which would silently turn a
  // scoped DELETE into a full-table DELETE. Refuse it instead.
  if (!children.length) throw parseError(`Empty ${kind}() group`);
  return { kind, children };
}

/** Combine top-level filters with AND, flattening the single-filter case. */
export function conjoin(parts: Filter[]): Filter | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return { kind: 'and', children: parts };
}

