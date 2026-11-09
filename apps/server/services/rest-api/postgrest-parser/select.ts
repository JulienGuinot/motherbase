// `?select=`, `?order=`, `?limit=`, `?offset=`: the shape and paging half of the
// grammar. Embedded resources (`author(name)`) are parsed here too, since an
// embed is just a select item that carries its own nested select.

import { parseError, type OrderTerm, type SelectColumn, type SelectItem, type SelectRelation } from './ast';
import { BARE_IDENTIFIER, indexOfTopLevel, splitTopLevel, unquote } from './lexer';
import { parseColumnRef } from './lexer';
// ── select / order / pagination ──────────────────────────────────────────────

export function parseSelect(raw: string): SelectItem[] {
  const items = splitTopLevel(raw, ',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(parseSelectItem);
  if (!items.length) throw parseError('Empty ?select');
  return items;
}

function parseSelectItem(raw: string): SelectItem {
  let rest = raw;
  let alias: string | undefined;

  // `alias:target`. The colon is searched at depth zero so `a:b(c:d)` works, and
  // a `::` pair is skipped so `qty::text` is a cast rather than an alias named
  // `qty` on a column named `:text`.
  const colon = indexOfAliasColon(rest);
  if (colon !== -1) {
    alias = unquote(rest.slice(0, colon).trim());
    if (!alias) throw parseError(`Empty alias in ?select item "${raw}"`);
    rest = rest.slice(colon + 1).trim();
  }

  // A quoted column name may legally contain `(`, so only an unquoted item can
  // open an embedded resource.
  const paren = rest[0] === '"' ? -1 : rest.indexOf('(');
  if (paren !== -1) {
    if (!rest.endsWith(')')) throw parseError(`Unterminated embedded resource "${raw}"`);
    const head = rest.slice(0, paren);
    const body = rest.slice(paren + 1, -1);
    const bang = head.indexOf('!');
    const relation = bang === -1 ? head : head.slice(0, bang);
    const modifier = bang === -1 ? '' : head.slice(bang + 1);
    if (!BARE_IDENTIFIER.test(relation)) throw parseError(`Invalid embedded resource "${raw}"`);
    const node: SelectRelation = {
      kind: 'relation',
      relation,
      children: body.trim() ? parseSelect(body) : [],
    };
    if (alias) node.alias = alias;
    if (modifier === 'inner') node.inner = true;
    else if (modifier === 'left') node.inner = false;
    else if (modifier) {
      if (!BARE_IDENTIFIER.test(modifier)) throw parseError(`Invalid relationship hint "${modifier}"`);
      node.hint = modifier;
    }
    return node;
  }

  if (rest === '*') {
    if (alias) throw parseError('"*" cannot be aliased');
    return { kind: 'star' };
  }

  const { body, cast } = splitCast(rest, raw);
  const ref = parseColumnRef(body, `?select item "${raw}"`);
  const item: SelectColumn = { kind: 'column', column: ref.column };
  if (alias) item.alias = alias;
  if (ref.jsonPath) {
    item.jsonPath = ref.jsonPath;
    item.jsonAsText = ref.jsonAsText;
  }
  if (cast) item.cast = cast;
  return item;
}

/**
 * A `?select` cast target: `text`, `int4`, `text[]`.
 *
 * Deliberately narrower than Postgres allows. The cast text is the ONE piece of
 * user input the compiler inlines into the statement (a type name cannot be
 * bound as a parameter and `quoteIdent` cannot express `text[]`), so it is
 * restricted to a bare lowercase identifier with an optional array marker. No
 * quotes, no parentheses, no whitespace, no schema qualification: nothing that
 * could close an identifier or open a new expression.
 */
const CAST_TYPE_NAME = /^[a-z_][a-z0-9_]*(?:\[\])?$/;

/** Index of the alias-separating `:`, ignoring the `::` of a cast. */
function indexOfAliasColon(input: string): number {
  let index = 0;
  while (index < input.length) {
    const next = indexOfTopLevel(input.slice(index), ':');
    if (next === -1) return -1;
    const absolute = index + next;
    if (input[absolute + 1] === ':') {
      index = absolute + 2;
      continue;
    }
    return absolute;
  }
  return -1;
}

/** Split `col::type` at the first top-level `::`, honouring quoted identifiers. */
function splitCast(rest: string, raw: string): { body: string; cast: string | null } {
  let quoted = false;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ':' && rest[index + 1] === ':') {
      const cast = rest.slice(index + 2).trim();
      if (!CAST_TYPE_NAME.test(cast)) throw parseError(`Invalid cast "::${cast}" in ?select item "${raw}"`);
      return { body: rest.slice(0, index), cast };
    }
  }
  return { body: rest, cast: null };
}

export function parseOrder(raw: string): OrderTerm[] {
  const terms = splitTopLevel(raw, ',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(parseOrderTerm);
  if (!terms.length) throw parseError('Empty ?order');
  return terms;
}

function parseOrderTerm(raw: string): OrderTerm {
  // `column[.asc|.desc][.nullsfirst|.nullslast]`, where the column may itself
  // carry a json path (`data->>score.desc`).
  const parts: string[] = [];
  let rest = raw;
  for (let index = 0; index < 2; index += 1) {
    const dot = rest.lastIndexOf('.');
    if (dot === -1) break;
    const tail = rest.slice(dot + 1).toLowerCase();
    if (tail !== 'asc' && tail !== 'desc' && tail !== 'nullsfirst' && tail !== 'nullslast') break;
    parts.unshift(tail);
    rest = rest.slice(0, dot);
  }

  const ref = parseColumnRef(rest, `?order term "${raw}"`);
  const term: OrderTerm = { column: ref.column, direction: 'asc' };
  if (ref.jsonPath) {
    term.jsonPath = ref.jsonPath;
    term.jsonAsText = ref.jsonAsText;
  }
  for (const part of parts) {
    if (part === 'asc' || part === 'desc') term.direction = part;
    else term.nulls = part === 'nullsfirst' ? 'first' : 'last';
  }
  return term;
}

export function parseNonNegativeInteger(raw: string, name: string): number {
  if (!/^\d+$/.test(raw.trim())) throw parseError(`"${name}" must be a non-negative integer, got "${raw}"`);
  return Number(raw.trim());
}
